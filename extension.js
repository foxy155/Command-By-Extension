const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const vscode = require("vscode");

const HISTORY_KEY = "commandByExtension.history";
let outputChannel;
let extensionContext;
let diagnosticCollection;
const suppressedSavePaths = new Set();
const activeCaptures = new Map();
const saveTimers = new Map();
const SAVE_DEBOUNCE_MS = 300;

function normalizeExtension(extension) {
  const value = String(extension || "").trim().toLowerCase();
  if (!value) return "";
  return value.startsWith(".") ? value : `.${value}`;
}

function shellQuote(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function getCommandShell(mode) {
  if (process.platform !== "win32") return "posix";
  if (mode === "capture") return "cmd";

  const terminalConfiguration = vscode.workspace.getConfiguration("terminal.integrated");
  const profileName = terminalConfiguration.get("defaultProfile.windows", "");
  const profiles = terminalConfiguration.get("profiles.windows", {});
  const profile = profiles && profileName ? profiles[profileName] : undefined;
  const shellPath = typeof profile === "string" ? profile : profile && profile.path;
  const profileIdentity = `${profileName} ${shellPath || ""}`.toLowerCase();
  if (profileIdentity.includes("cmd") || profileIdentity.includes("command prompt")) return "cmd";
  if (profileIdentity.includes("bash") || profileIdentity.includes("wsl")) return "posix";
  return "powershell";
}

function quoteForShell(value, shell) {
  if (shell === "powershell") {
    return `'${String(value).replace(/'/g, "''")}'`;
  }
  if (shell === "cmd") return shellQuote(value);
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeMappings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.reduce((mappings, item) => {
    if (!item || typeof item.extension !== "string") return mappings;
    const commands = Array.isArray(item.commands)
      ? item.commands.filter((command) => typeof command === "string" && command.trim())
      : [];
    if (commands.length === 0 && typeof item.command === "string" && item.command.trim()) {
      commands.push(item.command);
    }
    const extension = normalizeExtension(item.extension);
    if (!extension || extension === "." || commands.length === 0) return mappings;
    mappings.push({
      name: typeof item.name === "string" ? item.name : "",
      extension,
      commands,
      command: commands[0],
      mode: item.mode === "capture" ? "capture" : "terminal",
      env: item.env && typeof item.env === "object" ? item.env : {},
      cwd: typeof item.cwd === "string" ? item.cwd : "",
      before: typeof item.before === "string" ? item.before : "",
      after: typeof item.after === "string" ? item.after : "",
      saveBeforeRun: item.saveBeforeRun === true,
      problemMatcher: ["gcc", "typescript", "eslint", "shellcheck", "mypy"].includes(item.problemMatcher)
        ? item.problemMatcher
        : "none",
      runOnSave: item.runOnSave === true,
      runOnCreate: item.runOnCreate === true,
    });
    return mappings;
  }, []);
}

function readMappings(resource) {
  const configuration = vscode.workspace.getConfiguration("commandByExtension", resource);
  return normalizeMappings(configuration.get("mappings", []));
}

function normalizeWorkflows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.reduce((workflows, item) => {
    if (!item || typeof item.name !== "string" || typeof item.command !== "string") return workflows;
    const name = item.name.trim();
    const command = item.command.trim();
    if (!name || !command) return workflows;
    workflows.push({
      name,
      command,
      mode: item.mode === "capture" ? "capture" : "terminal",
      env: item.env && typeof item.env === "object" ? item.env : {},
      cwd: typeof item.cwd === "string" ? item.cwd : "",
      before: typeof item.before === "string" ? item.before : "",
      after: typeof item.after === "string" ? item.after : "",
      problemMatcher: ["gcc", "typescript", "eslint", "shellcheck", "mypy"].includes(item.problemMatcher)
        ? item.problemMatcher
        : "none",
      isWorkflow: true,
    });
    return workflows;
  }, []);
}

function readWorkflows(resource) {
  const configuration = vscode.workspace.getConfiguration("commandByExtension", resource);
  return normalizeWorkflows(configuration.get("workflows", []));
}

async function getPlaceholderValues(filePath) {
  const editor = vscode.window.activeTextEditor;
  const workspace = filePath
    ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))
    : (vscode.workspace.workspaceFolders || [])[0];
  const fileName = filePath ? path.basename(filePath) : "";
  const relativePath = filePath && workspace
    ? path.relative(workspace.uri.fsPath, filePath).replace(/\\/g, "/")
    : fileName;
  let selectedText = "";
  let currentLine = "";
  let currentWord = "";
  if (editor) {
    currentLine = String(editor.selection.active.line + 1);
    if (!editor.selection.isEmpty) selectedText = editor.document.getText(editor.selection);
    const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
    if (wordRange) currentWord = editor.document.getText(wordRange);
  }
  const clipboard = await vscode.env.clipboard.readText();
  return {
    file: filePath || "",
    fileName,
    fileNameWithoutExt: fileName ? path.basename(fileName, path.extname(fileName)) : "",
    fileDirname: filePath ? path.dirname(filePath) : "",
    workspaceFolder: workspace
      ? workspace.uri.fsPath
      : (filePath ? path.dirname(filePath) : ""),
    workspaceName: workspace ? path.basename(workspace.uri.fsPath) : "",
    relativePath,
    selectedText,
    clipboard,
    extension: fileName ? normalizeExtension(path.extname(fileName)) : "",
    timestamp: new Date().toISOString(),
    currentLine,
    currentWord,
  };
}

async function expandCommand(
  template,
  filePath,
  args = "",
  shell = getCommandShell("terminal"),
  filePaths = []
) {
  const values = await getPlaceholderValues(filePath);
  values.args = args;
  const selectedFiles = filePaths.length > 0 ? filePaths : (filePath ? [filePath] : []);
  values.files = selectedFiles.map((selectedFile) => quoteForShell(selectedFile, shell)).join(" ");
  return template.replace(
    /\{(file|fileName|fileNameWithoutExt|fileDirname|workspaceFolder|workspaceName|relativePath|selectedText|clipboard|extension|timestamp|currentLine|currentWord|args|files)\}/g,
    (_match, key) => key === "files" ? values.files : quoteForShell(values[key] || "", shell)
  );
}

async function expandPath(template, filePath) {
  const values = await getPlaceholderValues(filePath);
  return template.replace(
    /\{(file|fileName|fileNameWithoutExt|fileDirname|workspaceFolder|workspaceName|relativePath|selectedText|clipboard|extension|timestamp|currentLine|currentWord)\}/g,
    (_match, key) => values[key] || ""
  );
}

function mappingForFile(filePath, mappings) {
  const fileName = path.basename(filePath).toLowerCase();
  return mappings
    .filter((mapping) => fileName.endsWith(mapping.extension))
    .sort((left, right) => right.extension.length - left.extension.length)[0];
}

function chainCommands(mapping, command, shell) {
  const commands = [];
  if (mapping.before.trim()) commands.push(mapping.before.trim());
  commands.push(command);
  if (mapping.after.trim()) commands.push(mapping.after.trim());
  const separator = shell === "powershell" ? "; " : shell === "cmd" ? " & " : " && ";
  return commands.join(separator);
}

function readHistory() {
  const stored = extensionContext.globalState.get(HISTORY_KEY, []);
  return Array.isArray(stored)
    ? stored.filter((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.command === "string"
    )
    : [];
}

function persistHistory(history) {
  try {
    Promise.resolve(extensionContext.globalState.update(HISTORY_KEY, history)).catch((error) => {
      vscode.window.showErrorMessage(`Could not save command history: ${error.message}`);
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Could not save command history: ${error.message}`);
  }
}

function addHistory(entry) {
  const history = readHistory();
  history.unshift(entry);
  persistHistory(history.slice(0, 50));
}

function updateHistory(entry) {
  const history = readHistory();
  const index = history.findIndex((item) => item.runId === entry.runId);
  if (index >= 0) {
    history[index] = entry;
    persistHistory(history);
  }
}

function filePathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function scheduleRunOnSave(document) {
  const filePath = document.uri.fsPath;
  const key = filePathKey(filePath);
  const previous = saveTimers.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    saveTimers.delete(key);
    const mapping = mappingForFile(filePath, readMappings(document.uri));
    if (mapping && mapping.runOnSave) {
      runMapping(mapping, filePath).catch((error) => {
        vscode.window.showErrorMessage(`Could not run command after save: ${error.message}`);
      });
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(key, timer);
}

function cancelScheduledSaveRun(filePath) {
  const key = filePathKey(filePath);
  const timer = saveTimers.get(key);
  if (timer) clearTimeout(timer);
  saveTimers.delete(key);
}

async function saveDocumentsBeforeRun(mapping, filePaths) {
  if (!mapping.saveBeforeRun) return true;
  const documents = vscode.workspace.textDocuments || [];
  for (const filePath of filePaths) {
    const key = filePathKey(filePath);
    const document = documents.find((item) =>
      item.uri.scheme === "file" && filePathKey(item.uri.fsPath) === key
    );
    if (!document || !document.isDirty) continue;

    suppressedSavePaths.add(key);
    try {
      const saved = await document.save();
      if (!saved) {
        vscode.window.showWarningMessage(
          `Command not run because ${path.basename(filePath)} was not saved.`
        );
        return false;
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not save ${path.basename(filePath)} before running: ${error.message}`
      );
      return false;
    } finally {
      suppressedSavePaths.delete(key);
    }
  }
  return true;
}

function parseProblemLine(line, matcher) {
  let match;
  if (matcher === "gcc") {
    match = line.match(/^(.+):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/i);
    if (match) {
      return {
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: /warning/i.test(match[4]) ? vscode.DiagnosticSeverity.Warning
          : /note/i.test(match[4]) ? vscode.DiagnosticSeverity.Information
            : vscode.DiagnosticSeverity.Error,
        message: match[5],
      };
    }
  } else if (matcher === "typescript") {
    match = line.match(/^(.+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/i);
    if (match) {
      return {
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4].toLowerCase() === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error,
        code: match[5],
        message: match[6],
      };
    }
  } else if (matcher === "eslint") {
    match = line.match(/^(.+):(\d+):(\d+):\s*(error|warning)\s+(.*)$/i);
    if (match) {
      return {
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4].toLowerCase() === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error,
        message: match[5],
      };
    }
  } else if (matcher === "shellcheck") {
    match = line.match(/^(.+):(\d+):(\d+):\s*(error|warning|info|style):\s*(.*?)(?:\s+\[(SC\d+)\])?$/i);
    if (match) {
      return {
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4].toLowerCase() === "error" ? vscode.DiagnosticSeverity.Error
          : match[4].toLowerCase() === "warning" ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information,
        code: match[6],
        message: match[5],
      };
    }
  } else if (matcher === "mypy") {
    match = line.match(/^(.+):(\d+):\s*(error|warning|note):\s*(.*?)(?:\s+\[([^\]]+)\])?$/i);
    if (match) {
      return {
        file: match[1],
        line: Number(match[2]),
        column: 1,
        severity: match[3].toLowerCase() === "error" ? vscode.DiagnosticSeverity.Error
          : match[3].toLowerCase() === "warning" ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information,
        code: match[5],
        message: match[4],
      };
    }
  }
  return undefined;
}

function createProblemCollector(matcher, cwd) {
  if (!matcher || matcher === "none" || !diagnosticCollection) {
    return { write: () => {}, finish: () => {} };
  }
  const buffers = ["", ""];
  const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
  const diagnosticsByPath = new Map();
  const addLine = (line) => {
    const problem = parseProblemLine(line, matcher);
    if (!problem) return;
    const filePath = path.isAbsolute(problem.file)
      ? path.normalize(problem.file)
      : path.resolve(cwd || process.cwd(), problem.file);
    const key = filePathKey(filePath);
    let entry = diagnosticsByPath.get(key);
    if (!entry) {
      entry = { uri: vscode.Uri.file(filePath), diagnostics: [] };
      diagnosticsByPath.set(key, entry);
    }
    const lineNumber = Math.max(0, problem.line - 1);
    const columnNumber = Math.max(0, problem.column - 1);
    const start = new vscode.Position(lineNumber, columnNumber);
    const end = new vscode.Position(lineNumber, columnNumber + 1);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(start, end),
      problem.message,
      problem.severity
    );
    diagnostic.source = "Command by Extension";
    if (problem.code) diagnostic.code = problem.code;
    entry.diagnostics.push(diagnostic);
  };
  const flushLines = (index, text) => {
    buffers[index] += text;
    const lines = buffers[index].split(/\r?\n/);
    buffers[index] = lines.pop();
    for (const line of lines) addLine(line);
    if (buffers[index].length > 65536) buffers[index] = "";
  };
  return {
    write(index, chunk) {
      flushLines(index, decoders[index].write(chunk));
    },
    finish() {
      for (let index = 0; index < buffers.length; index += 1) {
        flushLines(index, decoders[index].end());
        if (buffers[index]) addLine(buffers[index]);
      }
      for (const entry of diagnosticsByPath.values()) {
        diagnosticCollection.set(entry.uri, entry.diagnostics);
      }
    },
  };
}

async function runMapping(mapping, filePath, commandIndex = 0, previousArgs, filePaths) {
  if (!mapping) return;
  const template = mapping.commands[commandIndex] || mapping.command;
  const runFiles = Array.isArray(filePaths) && filePaths.length > 0
    ? filePaths
    : (filePath ? [filePath] : []);
  let args = "";
  if (template.includes("{args}")) {
    if (previousArgs !== undefined) {
      args = previousArgs;
    } else {
      args = await vscode.window.showInputBox({
        prompt: "Command arguments",
        placeHolder: "Optional arguments",
      });
      if (args === undefined) return;
    }
  }
  if (!await saveDocumentsBeforeRun(mapping, runFiles)) return;
  for (const runFile of runFiles) cancelScheduledSaveRun(runFile);
  const shell = getCommandShell(mapping.mode);
  const command = await expandCommand(template, filePath, args, shell, runFiles);
  const fullCommand = chainCommands(mapping, command, shell);
  const values = await getPlaceholderValues(filePath);
  const problemMatcher = mapping.problemMatcher || "none";
  if (problemMatcher !== "none" && mapping.mode !== "capture") {
    vscode.window.showWarningMessage("Problem matchers require Capture output mode.");
  }
  const cwdTemplate = mapping.cwd || values.workspaceFolder;
  let cwd = cwdTemplate;
  if (mapping.cwd) {
    cwd = await expandPath(mapping.cwd, filePath);
  }
  const start = Date.now();
  const historyEntry = {
    runId: crypto.randomBytes(8).toString("hex"),
    command: fullCommand,
    file: filePath,
    commandIndex,
    args: template.includes("{args}") ? args : undefined,
    files: runFiles.length > 1 ? runFiles : undefined,
    workflowName: mapping.isWorkflow ? mapping.name : undefined,
    workflowCwd: mapping.isWorkflow ? cwd : undefined,
    timestamp: new Date().toISOString(),
    status: mapping.mode === "capture" ? "running" : "started",
  };
  addHistory(historyEntry);

  if (mapping.mode === "capture") {
    const env = { ...process.env, ...mapping.env };
    const problemCollector = createProblemCollector(problemMatcher, cwd);
    if (problemMatcher !== "none" && diagnosticCollection) {
      if (runFiles.length > 0) {
        for (const runFile of runFiles) {
          diagnosticCollection.delete(vscode.Uri.file(path.resolve(runFile)));
        }
      } else {
        diagnosticCollection.clear();
      }
    }
    outputChannel.appendLine(`\n> ${fullCommand}`);
    outputChannel.show(true);
    let child;
    let activeRun;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      problemCollector.finish();
      const duration = Date.now() - start;
      const stopped = activeRun && activeRun.stopRequested;
      activeCaptures.delete(historyEntry.runId);
      historyEntry.status = stopped ? "cancelled" : error ? "failed" : "success";
      historyEntry.duration = duration;
      updateHistory(historyEntry);
      if (stopped) vscode.window.showInformationMessage(`Command stopped after ${duration} ms`);
      else if (error) vscode.window.showErrorMessage(`Command failed (${duration} ms): ${error.message}`);
      else vscode.window.showInformationMessage(`Command completed in ${duration} ms`);
    };
    try {
      child = spawn(fullCommand, {
        cwd: cwd || undefined,
        env,
        shell: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : true,
      });
    } catch (error) {
      finish(error);
      return;
    }
    activeRun = { child, historyEntry, stopRequested: false };
    activeCaptures.set(historyEntry.runId, activeRun);
    child.stdout.on("data", (chunk) => {
      outputChannel.append(chunk.toString());
      problemCollector.write(0, chunk);
    });
    child.stderr.on("data", (chunk) => {
      outputChannel.append(chunk.toString());
      problemCollector.write(1, chunk);
    });
    child.on("error", finish);
    child.on("close", (code, signal) => {
      if (code === 0) finish(undefined);
      else finish(new Error(signal ? `Process terminated by ${signal}.` : `Process exited with code ${code}.`));
    });
  } else {
    const terminal = vscode.window.createTerminal({
      name: mapping.name || `Run ${path.basename(filePath || "workspace")}`,
      cwd: cwd || undefined,
      env: mapping.env,
    });
    terminal.show();
    terminal.sendText(fullCommand);
  }
}

async function stopCapturedRun() {
  const runs = [...activeCaptures.values()];
  if (runs.length === 0) {
    vscode.window.showInformationMessage("No captured commands are running.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    runs.map((run) => ({
      label: run.historyEntry.workflowName ||
        (run.historyEntry.file ? path.basename(run.historyEntry.file) : run.historyEntry.command),
      description: run.historyEntry.command,
      run,
    })),
    { placeHolder: "Choose a captured command to stop" }
  );
  if (!picked) return;
  const run = picked.run;
  if (!activeCaptures.has(run.historyEntry.runId)) {
    vscode.window.showInformationMessage("That command has already finished.");
    return;
  }
  try {
    if (!run.child.kill("SIGTERM")) {
      vscode.window.showWarningMessage("Could not stop the captured command; it may have already finished.");
      return;
    }
    run.stopRequested = true;
    vscode.window.showInformationMessage("Stop requested for the captured command.");
  } catch (error) {
    vscode.window.showErrorMessage(`Could not stop the captured command: ${error.message}`);
  }
}

async function runWorkflow(workflow, workingDirectory) {
  const mapping = {
    ...workflow,
    extension: "",
    commands: [workflow.command],
    cwd: workflow.cwd || workingDirectory || "",
    isWorkflow: true,
  };
  await runMapping(mapping, undefined);
}

async function chooseCommandForFile(filePath) {
  const mappings = readMappings(vscode.Uri.file(filePath));
  const mapping = mappingForFile(filePath, mappings);
  if (!mapping) {
    vscode.window.showWarningMessage(`No command is configured for ${path.extname(filePath) || "this file"}.`);
    return;
  }
  if (mapping.commands.length === 1) {
    await runMapping(mapping, filePath);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    mapping.commands.map((command, commandIndex) => ({
      label: mapping.name ? `${mapping.name} - ${command}` : command,
      description: mapping.extension,
      commandIndex,
    })),
    { placeHolder: "Choose a command" }
  );
  if (picked) await runMapping(mapping, filePath, picked.commandIndex);
}

async function quickRun() {
  const candidates = [];
  for (const mapping of readMappings()) {
    mapping.commands.forEach((command, commandIndex) => {
      candidates.push({
        label: mapping.name || command,
        description: `${mapping.extension}${mapping.commands.length > 1 ? ` - command ${commandIndex + 1}` : ""}`,
        mapping,
        commandIndex,
      });
    });
  }
  for (const workflow of readWorkflows()) {
    candidates.push({
      label: workflow.name,
      description: workflow.command,
      detail: "Standalone workflow",
      workflow,
    });
  }
  if (candidates.length === 0) {
    const action = await vscode.window.showInformationMessage("No commands configured yet.", "Configure");
    if (action) openSettings();
    return;
  }
  const picked = await vscode.window.showQuickPick(candidates, { placeHolder: "Choose a command preset" });
  if (!picked) return;
  if (picked.workflow) {
    await runWorkflow(picked.workflow);
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Open a file before running a file-based command.");
    return;
  }
  await runMapping(picked.mapping, editor.document.uri.fsPath, picked.commandIndex);
}

async function reRunLast() {
  const history = readHistory();
  if (history.length === 0) {
    vscode.window.showInformationMessage("No commands have been run yet.");
    return;
  }
  await runHistoryEntry(history[0]);
}

async function runHistoryEntry(entry) {
  if (entry.workflowName) {
    const resource = entry.workflowCwd ? vscode.Uri.file(entry.workflowCwd) : undefined;
    const workflow = readWorkflows(resource).find((item) => item.name === entry.workflowName);
    if (workflow) {
      await runWorkflow(workflow, entry.workflowCwd);
      return;
    }
  }
  if (entry.file) {
    const mapping = mappingForFile(entry.file, readMappings(vscode.Uri.file(entry.file)));
    if (mapping) {
      await runMapping(
        mapping,
        entry.file,
        entry.commandIndex || 0,
        entry.args,
        Array.isArray(entry.files) ? entry.files : undefined
      );
      return;
    }
  }
  vscode.window.showWarningMessage("The original command mapping is no longer available.");
}

async function runFromHistory() {
  const history = readHistory();
  if (history.length === 0) {
    vscode.window.showInformationMessage("Run history is empty.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    history.map((entry) => ({
      label: entry.workflowName || (entry.file ? path.basename(entry.file) : entry.command),
      description: `${entry.status || "unknown"}${entry.timestamp ? ` - ${entry.timestamp}` : ""}`,
      detail: entry.command,
      entry,
    })),
    { placeHolder: "Choose a previous command to run again" }
  );
  if (picked) await runHistoryEntry(picked.entry);
}

async function showHistory() {
  const history = readHistory();
  if (history.length === 0) {
    vscode.window.showInformationMessage("Run history is empty.");
    return;
  }
  outputChannel.show(true);
  outputChannel.appendLine("\nRecent commands:");
  history.forEach((entry) => {
    const duration = typeof entry.duration === "number" ? ` - ${entry.duration} ms` : "";
    outputChannel.appendLine(`[${entry.timestamp}] ${entry.status}${duration}: ${entry.command}`);
  });
}

async function runExplorer(resources) {
  const uris = Array.isArray(resources) ? resources : (resources ? [resources] : []);
  if (uris.length === 0) {
    const editor = vscode.window.activeTextEditor;
    if (editor) uris.push(editor.document.uri);
  }
  for (const uri of uris) {
    let stat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not inspect ${uri.fsPath}: ${error.message}`);
      continue;
    }
    if (stat.type & vscode.FileType.Directory) {
      const workflows = readWorkflows(uri);
      if (workflows.length === 0) {
        vscode.window.showWarningMessage("Add a standalone workflow to run a folder.");
        continue;
      }
      const picked = await vscode.window.showQuickPick(
        workflows.map((workflow) => ({
          label: workflow.name,
          description: workflow.command,
          detail: "Standalone workflow",
          workflow,
        })),
        { placeHolder: "Choose a workflow for the folder" }
      );
      if (picked) await runWorkflow(picked.workflow, uri.fsPath);
    } else {
      await chooseCommandForFile(uri.fsPath);
    }
  }
}

async function runSelectedFiles() {
  const files = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: "Run Commands",
    filters: { "All Files": ["*"] },
  });
  if (!files || files.length === 0) return;

  const unmatched = [];
  const runs = [];
  const fileListRuns = new Map();
  for (const uri of files) {
    const mapping = mappingForFile(uri.fsPath, readMappings(uri));
    if (!mapping) {
      unmatched.push(path.basename(uri.fsPath));
      continue;
    }
    if (mapping.commands[0].includes("{files}")) {
      const workspace = vscode.workspace.getWorkspaceFolder(uri);
      const scopePath = workspace ? workspace.uri.fsPath : path.dirname(uri.fsPath);
      const key = JSON.stringify([scopePath, mapping]);
      let run = fileListRuns.get(key);
      if (!run) {
        run = { mapping, files: [] };
        fileListRuns.set(key, run);
        runs.push(run);
      }
      run.files.push(uri.fsPath);
    } else {
      runs.push({ mapping, file: uri.fsPath });
    }
  }
  for (const run of runs) {
    if (run.files) {
      await runMapping(run.mapping, run.files[0], 0, undefined, run.files);
    } else {
      await runMapping(run.mapping, run.file);
    }
  }
  if (unmatched.length > 0) {
    vscode.window.showWarningMessage(`No command configured for: ${unmatched.join(", ")}`);
  }
}

function createSettingsHtml(mappings, workflows, hasWorkspace) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const initialMappings = JSON.stringify(mappings).replace(/</g, "\\u003c");
  const initialWorkflows = JSON.stringify(workflows).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;padding:36px 24px;background:var(--vscode-editor-background,#171923);color:var(--vscode-foreground,#f3f4fa);font:14px/1.55 var(--vscode-font-family,sans-serif)}
main{width:min(980px,100%);margin:auto}.eyebrow{color:var(--vscode-textLink-foreground,#b7adff);font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
h1{margin:6px 0;font-size:29px}.intro{color:var(--vscode-descriptionForeground,#9da4ba);margin:0 0 22px}.card{border:1px solid var(--vscode-panel-border,#303448);border-radius:14px;padding:24px;background:var(--vscode-sideBar-background,#1d2030)}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:22px}
.scope-picker{display:grid;gap:6px}.scope-label{font-size:12px;font-weight:600;color:var(--vscode-descriptionForeground,#9da4ba)}
.segmented{display:inline-flex;gap:4px;padding:4px;border:1px solid var(--vscode-panel-border,#303448);border-radius:10px;background:var(--vscode-editor-background,#171923)}
.scope-option{min-width:132px;padding:7px 12px;text-align:left;color:var(--vscode-foreground,#f3f4fa);background:transparent;border:1px solid transparent;border-radius:7px;font:inherit;cursor:pointer}
.scope-option span,.scope-option small{display:block}.scope-option small{font-size:11px;color:var(--vscode-descriptionForeground,#9da4ba)}
.scope-option[aria-pressed="true"]{background:var(--vscode-button-background,#806cf5);color:var(--vscode-button-foreground,#fff)}
.scope-option[aria-pressed="true"] small{color:inherit;opacity:.82}
.share-actions{display:flex;gap:8px;flex-wrap:wrap}
.workflow-section{margin-top:20px}.workflow-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.workflow-heading h2{margin:0;font-size:18px}
.workflow-row{display:grid;grid-template-columns:minmax(180px,.7fr) minmax(260px,1.3fr) 38px;gap:12px;margin:12px 0}
.workflow-row input,.workflow-row textarea{width:100%;min-width:0;min-height:44px;padding:10px 12px;color:var(--vscode-input-foreground,var(--vscode-foreground,#f3f4fa));background:var(--vscode-input-background,#171923);border:1px solid var(--vscode-input-border,var(--vscode-panel-border,#303448));border-radius:8px;font:inherit}
.workflow-row textarea{min-height:84px;line-height:1.55;resize:vertical}.workflow-row input:focus,.workflow-row textarea:focus{outline:1px solid var(--vscode-focusBorder,#9b8cff);outline-offset:1px}
.row{display:grid;grid-template-columns:130px 150px minmax(260px,1fr) 38px;gap:12px;align-items:start;margin-bottom:14px}
.row input,.row textarea{width:100%;min-width:0;min-height:44px;padding:10px 12px;color:var(--vscode-input-foreground,var(--vscode-foreground,#f3f4fa));background:var(--vscode-input-background,#171923);border:1px solid var(--vscode-input-border,var(--vscode-panel-border,#303448));border-radius:8px;font:inherit}
.row textarea{min-height:112px;line-height:1.55;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere}.row input:focus,.row textarea:focus{outline:1px solid var(--vscode-focusBorder,#9b8cff);outline-offset:1px}
.command-cell{min-width:0}.save-before-run{display:flex;align-items:center;gap:7px;margin-top:8px;color:var(--vscode-descriptionForeground,#9da4ba);font-size:12px}.row .save-before-run input{width:16px;min-height:16px;margin:0;padding:0;accent-color:var(--vscode-focusBorder,#9b8cff)}
.run-options{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px}.run-option{display:flex;align-items:center;gap:6px;color:var(--vscode-descriptionForeground,#9da4ba);font-size:12px}.run-option select{max-width:180px;padding:4px 6px;color:var(--vscode-dropdown-foreground,var(--vscode-foreground,#f3f4fa));background:var(--vscode-dropdown-background,var(--vscode-input-background,#171923));border:1px solid var(--vscode-dropdown-border,var(--vscode-input-border,#303448));border-radius:5px;font:inherit}
.workflow-cell{min-width:0}.workflow-row .run-options{margin-top:7px}
.labels{display:grid;grid-template-columns:130px 150px 1fr 38px;gap:12px;margin-bottom:8px;color:var(--vscode-descriptionForeground,#9da4ba);font-size:11px;font-weight:600;text-transform:uppercase}
.remove{height:40px;border:0;border-radius:8px;background:transparent;color:var(--vscode-descriptionForeground,#9da4ba);font-size:19px;cursor:pointer}.remove:hover{color:var(--vscode-errorForeground,#ff8290);background:var(--vscode-inputValidation-errorBackground,#ff829014)}
.empty{padding:28px 20px;text-align:center;color:var(--vscode-descriptionForeground,#9da4ba);border:1px dashed var(--vscode-panel-border,#303448);border-radius:10px}
.hint{color:var(--vscode-descriptionForeground,#9da4ba);font-size:12px;margin:12px 0}code{color:var(--vscode-textPreformat-foreground,#cec7ff);background:var(--vscode-textCodeBlock-background,#9b8cff18);padding:2px 5px;border-radius:4px}
.footer{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:22px}.actions{display:flex;gap:8px;flex-wrap:wrap}
.button{padding:9px 14px;border-radius:7px;font:inherit;font-weight:600;cursor:pointer}.secondary{color:var(--vscode-button-secondaryForeground,var(--vscode-foreground,#f3f4fa));background:var(--vscode-button-secondaryBackground,var(--vscode-editor-background,#171923));border:1px solid var(--vscode-panel-border,#303448)}.primary{color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#806cf5);border:0}
.button:hover,.scope-option:hover{filter:brightness(1.08)}#status{color:var(--vscode-descriptionForeground,#9da4ba);font-size:12px}
@media(max-width:700px){body{padding:24px 14px}.card{padding:18px}.row,.labels{grid-template-columns:110px 130px minmax(180px,1fr) 36px;gap:8px}}
@media(max-width:520px){.labels{display:none}.row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 36px;gap:8px}.row textarea{grid-column:1/3;min-height:124px}.row .remove{grid-column:3;grid-row:2}.workflow-row{grid-template-columns:minmax(0,1fr) 36px;gap:8px}.workflow-row textarea:nth-child(2){grid-column:1}.workflow-row .remove{grid-column:2;grid-row:1/3}.scope-option{min-width:112px}.footer{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body><main>
<div class="eyebrow">Run your workflow</div><h1>Commands by extension</h1>
<p class="intro">Configure reusable commands for file types.</p>
<section class="card">
<div class="topbar">
<div class="scope-picker"><span class="scope-label">Save mappings to</span><div class="segmented" role="group" aria-label="Settings scope">
${hasWorkspace ? '<button class="scope-option" type="button" data-scope="workspace" aria-pressed="true"><span>Workspace</span><small>Share with this project</small></button>' : ''}
<button class="scope-option" type="button" data-scope="user" aria-pressed="${hasWorkspace ? "false" : "true"}"><span>User</span><small>Use across projects</small></button>
</div></div>
<div class="share-actions"><button class="button secondary" id="import" type="button">Import configuration</button><button class="button secondary" id="export" type="button">Export configuration</button></div>
</div>
<div class="labels"><span>Name</span><span>File ending</span><span>Command(s)</span><span></span></div>
<div id="rows"></div>
<p class="hint">Enter one command per line. They are alternatives; choose which one to run each time.</p>
<p class="hint">Use <code>{file}</code>, <code>{files}</code> (multi-file runs), <code>{relativePath}</code>, <code>{selectedText}</code>, <code>{workspaceFolder}</code>, <code>{timestamp}</code>, or <code>{args}</code>.</p>
<p class="hint">Capture output mode can send GCC, TypeScript, or ESLint diagnostics to the Problems panel.</p>
<div class="footer"><span id="status" role="status"></span><div class="actions">
<button class="button secondary" id="add">+ Add</button><button class="button primary" id="save">Save</button></div></div>
</section>
<section class="card workflow-section">
<div class="workflow-heading"><div><h2>Standalone workflows</h2><p class="hint">Quick-run tasks that do not need an active file.</p></div><button class="button secondary" id="addWorkflow" type="button">+ Add workflow</button></div>
<div class="labels workflow-labels"><span>Name</span><span>Command</span><span></span></div>
<div id="workflowRows"></div>
<div class="footer"><span class="hint">Available from Command by Extension: Quick Run.</span><button class="button primary" id="saveWorkflows" type="button">Save workflows</button></div>
</section></main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const rows=document.getElementById("rows");const workflowRows=document.getElementById("workflowRows");const status=document.getElementById("status");let mappings=${initialMappings};let workflows=${initialWorkflows};let settingsScope="${hasWorkspace ? "workspace" : "user"}";
function render(){rows.replaceChildren();if(!mappings.length){const e=document.createElement("div");e.className="empty";e.textContent="No mappings yet.";rows.appendChild(e);return;}
mappings.forEach((m,i)=>{const r=document.createElement("div");r.className="row";
const name=document.createElement("input");name.placeholder="Optional";name.value=m.name||"";name.addEventListener("input",()=>mappings[i].name=name.value);
const ext=document.createElement("input");ext.placeholder=".py";ext.value=m.extension||"";ext.addEventListener("input",()=>mappings[i].extension=ext.value);
const cmd=document.createElement("textarea");cmd.placeholder="python {file}";cmd.value=(m.commands||[m.command||""]).join("\\n");cmd.addEventListener("input",()=>mappings[i].commands=cmd.value.split("\\n").map(v=>v.trim()).filter(Boolean));
const commandCell=document.createElement("div");commandCell.className="command-cell";
const saveLabel=document.createElement("label");saveLabel.className="save-before-run";const saveBeforeRun=document.createElement("input");saveBeforeRun.type="checkbox";saveBeforeRun.checked=m.saveBeforeRun===true;saveBeforeRun.addEventListener("change",()=>mappings[i].saveBeforeRun=saveBeforeRun.checked);saveLabel.append(saveBeforeRun,document.createTextNode("Save before running"));
const runOnSaveLabel=document.createElement("label");runOnSaveLabel.className="save-before-run";const runOnSave=document.createElement("input");runOnSave.type="checkbox";runOnSave.checked=m.runOnSave===true;runOnSave.addEventListener("change",()=>mappings[i].runOnSave=runOnSave.checked);runOnSaveLabel.append(runOnSave,document.createTextNode("Run on Save (300 ms debounce)"));
const runOptions=document.createElement("div");runOptions.className="run-options";
const modeLabel=document.createElement("label");modeLabel.className="run-option";modeLabel.append(document.createTextNode("Output "));
const modeSelect=document.createElement("select");for(const [value,label] of [["terminal","Terminal"],["capture","Capture"]]){const option=document.createElement("option");option.value=value;option.textContent=label;modeSelect.appendChild(option);}modeSelect.value=m.mode==="capture"?"capture":"terminal";modeSelect.addEventListener("change",()=>{mappings[i].mode=modeSelect.value;if(modeSelect.value!=="capture"){mappings[i].problemMatcher="none";matcherSelect.value="none";matcherSelect.disabled=true;}else{matcherSelect.disabled=false;}});modeLabel.appendChild(modeSelect);
const matcherLabel=document.createElement("label");matcherLabel.className="run-option";matcherLabel.append(document.createTextNode("Problems "));
const matcherSelect=document.createElement("select");for(const [value,label] of [["none","None"],["gcc","GCC / Clang"],["typescript","TypeScript"],["eslint","ESLint"],["shellcheck","ShellCheck"],["mypy","mypy"]]){const option=document.createElement("option");option.value=value;option.textContent=label;matcherSelect.appendChild(option);}matcherSelect.value=m.problemMatcher||"none";matcherSelect.disabled=modeSelect.value!=="capture";matcherSelect.addEventListener("change",()=>mappings[i].problemMatcher=matcherSelect.value);matcherLabel.appendChild(matcherSelect);
runOptions.append(modeLabel,matcherLabel);commandCell.append(cmd,saveLabel,runOnSaveLabel,runOptions);
const remove=document.createElement("button");remove.className="remove";remove.textContent="×";remove.title="Remove";remove.onclick=()=>{mappings.splice(i,1);render();};
r.append(name,ext,commandCell,remove);rows.appendChild(r);});}
function renderWorkflows(){workflowRows.replaceChildren();if(!workflows.length){const e=document.createElement("div");e.className="empty";e.textContent="No standalone workflows yet.";workflowRows.appendChild(e);return;}
workflows.forEach((workflow,i)=>{const r=document.createElement("div");r.className="workflow-row";
const name=document.createElement("input");name.placeholder="e.g. Run tests";name.setAttribute("aria-label","Workflow name");name.value=workflow.name||"";name.addEventListener("input",()=>workflows[i].name=name.value);
const commandCell=document.createElement("div");commandCell.className="workflow-cell";
const command=document.createElement("textarea");command.placeholder="e.g. npm test";command.setAttribute("aria-label","Workflow command");command.value=workflow.command||"";command.addEventListener("input",()=>workflows[i].command=command.value);
const runOptions=document.createElement("div");runOptions.className="run-options";const modeLabel=document.createElement("label");modeLabel.className="run-option";modeLabel.append(document.createTextNode("Output "));
const modeSelect=document.createElement("select");for(const [value,label] of [["terminal","Terminal"],["capture","Capture"]]){const option=document.createElement("option");option.value=value;option.textContent=label;modeSelect.appendChild(option);}modeSelect.value=workflow.mode==="capture"?"capture":"terminal";
const matcherLabel=document.createElement("label");matcherLabel.className="run-option";matcherLabel.append(document.createTextNode("Problems "));
const matcherSelect=document.createElement("select");for(const [value,label] of [["none","None"],["gcc","GCC / Clang"],["typescript","TypeScript"],["eslint","ESLint"],["shellcheck","ShellCheck"],["mypy","mypy"]]){const option=document.createElement("option");option.value=value;option.textContent=label;matcherSelect.appendChild(option);}matcherSelect.value=workflow.problemMatcher||"none";matcherSelect.disabled=modeSelect.value!=="capture";
modeSelect.addEventListener("change",()=>{workflows[i].mode=modeSelect.value;if(modeSelect.value!=="capture"){workflows[i].problemMatcher="none";matcherSelect.value="none";matcherSelect.disabled=true;}else{matcherSelect.disabled=false;}});
matcherSelect.addEventListener("change",()=>workflows[i].problemMatcher=matcherSelect.value);
modeLabel.appendChild(modeSelect);matcherLabel.appendChild(matcherSelect);runOptions.append(modeLabel,matcherLabel);commandCell.append(command,runOptions);
const remove=document.createElement("button");remove.className="remove";remove.type="button";remove.textContent="×";remove.title="Remove workflow";remove.onclick=()=>{workflows.splice(i,1);renderWorkflows();};
r.append(name,commandCell,remove);workflowRows.appendChild(r);});}
document.getElementById("add").onclick=()=>{mappings.push({name:"",extension:"",commands:[""],mode:"terminal",problemMatcher:"none",saveBeforeRun:false});render();};
document.getElementById("addWorkflow").onclick=()=>{workflows.push({name:"",command:"",mode:"terminal",problemMatcher:"none"});renderWorkflows();};
document.querySelectorAll(".scope-option").forEach(button=>button.onclick=()=>{settingsScope=button.dataset.scope;document.querySelectorAll(".scope-option").forEach(option=>option.setAttribute("aria-pressed",String(option===button)));});
document.getElementById("import").onclick=()=>vscode.postMessage({type:"import",scope:settingsScope});
document.getElementById("export").onclick=()=>vscode.postMessage({type:"export",scope:settingsScope});
document.getElementById("save").onclick=()=>{status.textContent="Saving…";vscode.postMessage({type:"save",scope:settingsScope,mappings});};
document.getElementById("saveWorkflows").onclick=()=>{status.textContent="Saving workflows…";vscode.postMessage({type:"saveWorkflows",scope:settingsScope,workflows});};
window.addEventListener("message",e=>{if(e.data.type==="saved")status.textContent="Saved.";if(e.data.type==="workflowsSaved")status.textContent="Workflows saved.";if(e.data.type==="imported"){mappings=e.data.mappings;render();if(Array.isArray(e.data.workflows)){workflows=e.data.workflows;renderWorkflows();}status.textContent="Configuration imported.";}if(e.data.type==="error")status.textContent=e.data.message;});render();renderWorkflows();
</script></body></html>`;
}

function validateWorkflows(raw) {
  const seen = new Set();
  return raw.map((workflow, index) => {
    if (!workflow || typeof workflow.name !== "string" || typeof workflow.command !== "string") {
      throw new Error(`Workflow ${index + 1} needs a name and command.`);
    }
    const name = workflow.name.trim();
    const command = workflow.command.trim();
    if (!name || !command) {
      throw new Error(`Workflow ${index + 1} needs a name and command.`);
    }
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) {
      throw new Error(`Workflow names must be unique: ${name}.`);
    }
    seen.add(normalizedName);
    if (["cwd", "before", "after"].some((field) =>
      workflow[field] !== undefined && typeof workflow[field] !== "string"
    )) {
      throw new Error(`Workflow ${name} has an invalid working directory or hook.`);
    }
    if (workflow.mode !== undefined && workflow.mode !== "terminal" && workflow.mode !== "capture") {
      throw new Error(`Workflow ${name} has an invalid execution mode.`);
    }
    if (workflow.problemMatcher !== undefined &&
      !["none", "gcc", "typescript", "eslint", "shellcheck", "mypy"].includes(workflow.problemMatcher)
    ) {
      throw new Error(`Workflow ${name} has an invalid problem matcher.`);
    }
    if (workflow.problemMatcher && workflow.problemMatcher !== "none" && workflow.mode !== "capture") {
      throw new Error(`Workflow ${name} must use capture mode to report Problems.`);
    }
    if (workflow.env !== undefined && (
      !workflow.env ||
      typeof workflow.env !== "object" ||
      Array.isArray(workflow.env) ||
      Object.values(workflow.env).some((value) => typeof value !== "string")
    )) {
      throw new Error(`Workflow ${name} environment values must be strings.`);
    }
    return {
      name,
      command,
      mode: workflow.mode === "capture" ? "capture" : "terminal",
      problemMatcher: workflow.problemMatcher || "none",
      env: workflow.env || {},
      cwd: workflow.cwd || "",
      before: workflow.before || "",
      after: workflow.after || "",
    };
  });
}

function openSettings() {
  const panel = vscode.window.createWebviewPanel(
    "commandByExtension.settings",
    "Commands by Extension",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const hasWorkspace = (vscode.workspace.workspaceFolders || []).length > 0;
  panel.webview.html = createSettingsHtml(readMappings(), readWorkflows(), hasWorkspace);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message) return;
    if (message.type === "import") {
      const imported = await importMappings(message.scope);
      if (imported) {
        panel.webview.postMessage({
          type: "imported",
          mappings: imported.mappings,
          workflows: imported.workflows,
        });
      }
      return;
    }
    if (message.type === "export") {
      await exportMappings();
      return;
    }
    if (message.type === "saveWorkflows" && Array.isArray(message.workflows)) {
      let workflows;
      try {
        workflows = validateWorkflows(message.workflows);
      } catch (error) {
        panel.webview.postMessage({ type: "error", message: error.message });
        return;
      }
      const target = message.scope === "workspace" && hasWorkspace
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      try {
        await vscode.workspace.getConfiguration("commandByExtension").update(
          "workflows",
          workflows,
          target
        );
      } catch (error) {
        panel.webview.postMessage({ type: "error", message: `Could not save workflows: ${error.message}` });
        return;
      }
      panel.webview.postMessage({ type: "workflowsSaved" });
      return;
    }
    if (message.type !== "save" || !Array.isArray(message.mappings)) return;
    const seen = new Set();
    const mappings = [];
    for (const item of message.mappings) {
      if (!item || typeof item.extension !== "string") continue;
      const extension = normalizeExtension(item.extension);
      const commands = Array.isArray(item.commands)
        ? item.commands.map((command) => String(command).trim()).filter(Boolean)
        : [];
      if (!extension || extension === "." || commands.length === 0) continue;
      if (seen.has(extension)) {
        panel.webview.postMessage({ type: "error", message: `Only one preset can use ${extension}.` });
        return;
      }
      const stringFields = ["cwd", "before", "after"];
      for (const field of stringFields) {
        if (item[field] !== undefined && typeof item[field] !== "string") {
          panel.webview.postMessage({ type: "error", message: `${field} must be a string.` });
          return;
        }
      }
      if (item.mode !== undefined && item.mode !== "terminal" && item.mode !== "capture") {
        panel.webview.postMessage({ type: "error", message: "Execution mode must be terminal or capture." });
        return;
      }
      const problemMatcher = item.problemMatcher || "none";
      if (!["none", "gcc", "typescript", "eslint", "shellcheck", "mypy"].includes(problemMatcher)) {
        panel.webview.postMessage({ type: "error", message: "Choose a supported problem matcher." });
        return;
      }
      if (problemMatcher !== "none" && item.mode !== "capture") {
        panel.webview.postMessage({ type: "error", message: "Problem matchers require Capture output mode." });
        return;
      }
      if (item.env !== undefined && (
        !item.env ||
        typeof item.env !== "object" ||
        Array.isArray(item.env) ||
        Object.values(item.env).some((value) => typeof value !== "string")
      )) {
        panel.webview.postMessage({ type: "error", message: "Environment values must be strings." });
        return;
      }
      if (["saveBeforeRun", "runOnSave", "runOnCreate"].some((field) =>
        item[field] !== undefined && typeof item[field] !== "boolean"
      )) {
        panel.webview.postMessage({ type: "error", message: "Run options must be true or false." });
        return;
      }
      seen.add(extension);
      mappings.push({
        name: typeof item.name === "string" ? item.name.trim() : "",
        extension,
        command: commands[0],
        commands,
        mode: item.mode === "capture" ? "capture" : "terminal",
        problemMatcher,
        env: item.env || {},
        cwd: item.cwd || "",
        before: item.before || "",
        after: item.after || "",
        saveBeforeRun: item.saveBeforeRun === true,
        runOnSave: item.runOnSave === true,
        runOnCreate: item.runOnCreate === true,
      });
    }
    const target = message.scope === "workspace" && hasWorkspace
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    try {
      await vscode.workspace.getConfiguration("commandByExtension").update(
        "mappings",
        mappings,
        target
      );
    } catch (error) {
      panel.webview.postMessage({ type: "error", message: `Could not save mappings: ${error.message}` });
      return;
    }
    panel.webview.postMessage({ type: "saved" });
  });
}

function validateImportedMappings(parsed) {
  const mappings = Array.isArray(parsed) ? parsed : parsed && parsed.mappings;
  if (!Array.isArray(mappings)) {
    throw new Error("The file must contain a mappings array.");
  }
  const seen = new Set();
  return mappings.map((mapping, index) => {
    if (!mapping || typeof mapping !== "object" || typeof mapping.extension !== "string") {
      throw new Error(`Mapping ${index + 1} needs a string extension.`);
    }
    const extension = normalizeExtension(mapping.extension);
    if (!extension || extension === ".") {
      throw new Error(`Mapping ${index + 1} has an empty extension.`);
    }
    if (mapping.commands !== undefined && (
      !Array.isArray(mapping.commands) ||
      mapping.commands.some((command) => typeof command !== "string")
    )) {
      throw new Error(`Mapping ${index + 1} commands must be an array of strings.`);
    }
    const hasCommands = Array.isArray(mapping.commands) &&
      mapping.commands.length > 0 &&
      mapping.commands.every((command) => typeof command === "string" && command.trim());
    const hasLegacyCommand = typeof mapping.command === "string" && mapping.command.trim();
    if (!hasCommands && !hasLegacyCommand) {
      throw new Error(`Mapping ${index + 1} needs a command or non-empty commands array.`);
    }
    if (mapping.name !== undefined && typeof mapping.name !== "string") {
      throw new Error(`Mapping ${index + 1} has an invalid name.`);
    }
    if (["cwd", "before", "after"].some((field) =>
      mapping[field] !== undefined && typeof mapping[field] !== "string"
    )) {
      throw new Error(`Mapping ${index + 1} has an invalid working directory or hook.`);
    }
    if (mapping.mode !== undefined && mapping.mode !== "terminal" && mapping.mode !== "capture") {
      throw new Error(`Mapping ${index + 1} has an invalid execution mode.`);
    }
    if (mapping.problemMatcher !== undefined &&
      !["none", "gcc", "typescript", "eslint", "shellcheck", "mypy"].includes(mapping.problemMatcher)
    ) {
      throw new Error(`Mapping ${index + 1} has an invalid problem matcher.`);
    }
    if (mapping.problemMatcher && mapping.problemMatcher !== "none" && mapping.mode !== "capture") {
      throw new Error(`Mapping ${index + 1} must use capture mode to report Problems.`);
    }
    if (mapping.env !== undefined && (
      !mapping.env ||
      typeof mapping.env !== "object" ||
      Array.isArray(mapping.env) ||
      Object.values(mapping.env).some((value) => typeof value !== "string")
    )) {
      throw new Error(`Mapping ${index + 1} environment values must be strings.`);
    }
    if (["saveBeforeRun", "runOnSave", "runOnCreate"].some((field) =>
      mapping[field] !== undefined && typeof mapping[field] !== "boolean"
    )) {
      throw new Error(`Mapping ${index + 1} has invalid automatic run options.`);
    }
    if (seen.has(extension)) {
      throw new Error(`The file contains more than one mapping for ${extension}.`);
    }
    seen.add(extension);
    const commands = hasCommands
      ? mapping.commands.filter((command) => command.trim())
      : [mapping.command.trim()];
    return { ...mapping, extension, commands, command: commands[0] };
  });
}

async function importMappings(scopeOverride) {
  const files = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Import Configuration",
    filters: { "JSON Files": ["json"] },
  });
  if (!files || files.length === 0) return;

  let mappings;
  let workflows;
  try {
    const contents = Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString("utf8");
    const parsed = JSON.parse(contents);
    mappings = validateImportedMappings(parsed);
    if (!Array.isArray(parsed) && parsed.workflows !== undefined) {
      workflows = validateWorkflows(parsed.workflows);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Could not import configuration: ${error.message}`);
    return;
  }

  const hasWorkspace = (vscode.workspace.workspaceFolders || []).length > 0;
  let target = vscode.ConfigurationTarget.Global;
  if (scopeOverride === "workspace" && hasWorkspace) {
    target = vscode.ConfigurationTarget.Workspace;
  } else if (scopeOverride !== "user" && hasWorkspace) {
    const choice = await vscode.window.showQuickPick([
      { label: "This workspace", target: vscode.ConfigurationTarget.Workspace },
      { label: "User settings", target: vscode.ConfigurationTarget.Global },
    ], { placeHolder: "Where should this configuration be saved?" });
    if (!choice) return;
    target = choice.target;
  }

  try {
    const configuration = vscode.workspace.getConfiguration("commandByExtension");
    await configuration.update("mappings", mappings, target);
    if (workflows) await configuration.update("workflows", workflows, target);
    const count = mappings.length + (workflows ? workflows.length : 0);
    vscode.window.showInformationMessage(`Imported ${count} command${count === 1 ? "" : "s"}.`);
    return { mappings, workflows };
  } catch (error) {
    vscode.window.showErrorMessage(`Could not save imported configuration: ${error.message}`);
  }
}

async function exportMappings() {
  const folders = vscode.workspace.workspaceFolders || [];
  const options = {
    saveLabel: "Export Configuration",
    filters: { "JSON Files": ["json"] },
  };
  if (folders.length > 0) {
    options.defaultUri = vscode.Uri.file(path.join(
      folders[0].uri.fsPath,
      "command-by-extension.json"
    ));
  }
  const file = await vscode.window.showSaveDialog({
    ...options,
  });
  if (!file) return;

  const configuration = vscode.workspace.getConfiguration("commandByExtension");
  const mappings = configuration.get("mappings", []);
  const workflows = configuration.get("workflows", []);
  const contents = JSON.stringify({ version: 1, mappings, workflows }, null, 2);
  try {
    await vscode.workspace.fs.writeFile(file, Buffer.from(contents, "utf8"));
    const count = mappings.length + workflows.length;
    vscode.window.showInformationMessage(`Exported ${count} command${count === 1 ? "" : "s"}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not export configuration: ${error.message}`);
  }
}

function activate(context) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Command by Extension");
  context.subscriptions.push(outputChannel);
  diagnosticCollection = vscode.languages.createDiagnosticCollection("Command by Extension");
  context.subscriptions.push(diagnosticCollection);

  const configuration = vscode.workspace.getConfiguration("commandByExtension");
  const inspected = configuration.inspect("mappings");
  const legacyKey = "commandByExtension.mappings";
  const legacyMappings = context.globalState.get(legacyKey, []);
  const clearLegacy = () => context.globalState.update(legacyKey, undefined);
  if (inspected && inspected.globalValue === undefined && Array.isArray(legacyMappings) && legacyMappings.length > 0) {
    Promise.resolve(configuration.update(
      "mappings",
      legacyMappings,
      vscode.ConfigurationTarget.Global
    )).then(clearLegacy).catch((error) => {
      vscode.window.showErrorMessage(`Could not migrate saved commands: ${error.message}`);
    });
  } else {
    Promise.resolve(clearLegacy()).catch((error) => {
      vscode.window.showErrorMessage(`Could not clear migrated command data: ${error.message}`);
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("commandByExtension.configure", openSettings),
    vscode.commands.registerCommand("commandByExtension.quickRun", quickRun),
    vscode.commands.registerCommand("commandByExtension.reRun", reRunLast),
    vscode.commands.registerCommand("commandByExtension.runFromHistory", runFromHistory),
    vscode.commands.registerCommand("commandByExtension.showHistory", showHistory),
    vscode.commands.registerCommand("commandByExtension.stopCapturedRun", stopCapturedRun),
    vscode.commands.registerCommand("commandByExtension.runExplorer", runExplorer),
    vscode.commands.registerCommand("commandByExtension.runSelectedFiles", runSelectedFiles),
    vscode.commands.registerCommand("commandByExtension.importMappings", importMappings),
    vscode.commands.registerCommand("commandByExtension.exportMappings", exportMappings),
    vscode.commands.registerCommand("commandByExtension.run", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Open a file before running its mapped command.");
        return;
      }
      await chooseCommandForFile(editor.document.uri.fsPath);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      if (suppressedSavePaths.has(filePathKey(document.uri.fsPath))) return;
      const mapping = mappingForFile(document.uri.fsPath, readMappings(document.uri));
      if (!mapping || !mapping.runOnSave) return;
      scheduleRunOnSave(document);
    }),
    vscode.workspace.onDidCreateFiles(async (event) => {
      for (const uri of event.files) {
        if (uri.scheme !== "file") continue;
        const mapping = mappingForFile(uri.fsPath, readMappings(uri));
        if (mapping && mapping.runOnCreate) await runMapping(mapping, uri.fsPath);
      }
    })
  );
}

function deactivate() {
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
}

module.exports = { activate, deactivate };
