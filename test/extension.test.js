const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const manifest = require("../package.json");

const source = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");

function createHarness(options = {}) {
  const commands = new Map();
  const listeners = {};
  const terminals = [];
  const output = [];
  const updates = [];
  const messages = [];
  const execCalls = [];
  const diagnostics = new Map();
  const globalStateValues = { ...(options.globalStateValues || {}) };
  const openDialogResults = [...(options.openDialogResults || [])];
  const quickPickResults = [...(options.quickPickResults || [])];
  const settings = options.settings || [];
  let settingsMessageHandler;
  let settingsPanel;
  let saveDialogResult;
  let writtenFile;
  let writtenContents;
  let importedContents = "";
  let inputBoxCalls = 0;
  const workspaceUri = { fsPath: "C:\\project", scheme: "file" };

  const vscode = {
    window: {
      activeTextEditor: options.editor === null ? undefined : (options.editor || {
        document: {
          uri: { fsPath: "C:\\project\\active.py", scheme: "file" },
          getText: () => "",
          getWordRangeAtPosition: () => undefined,
        },
        selection: { active: { line: 0 }, isEmpty: true },
      }),
      createOutputChannel() {
        return {
          appendLine: (text) => output.push(text),
          append: (text) => output.push(text),
          show: () => {},
          dispose: () => {},
        };
      },
      createTerminal(options) {
        const terminal = {
          options,
          sent: [],
          show() {},
          sendText(text) { this.sent.push(text); },
        };
        terminals.push(terminal);
        return terminal;
      },
      showOpenDialog: async () => openDialogResults.shift(),
      showSaveDialog: async () => saveDialogResult,
      showQuickPick: async (items) => {
        const picked = quickPickResults.shift();
        return typeof picked === "function" ? picked(items) : picked;
      },
      showInputBox: async () => {
        inputBoxCalls += 1;
        return options.inputResult === undefined ? "" : options.inputResult;
      },
      showInformationMessage: async (message) => { messages.push({ type: "info", message }); },
      showWarningMessage: async (message) => { messages.push({ type: "warning", message }); },
      showErrorMessage: async (message) => { messages.push({ type: "error", message }); },
      createWebviewPanel() {
        const panel = {
          webview: {
            html: "",
            sent: [],
            postMessage: (message) => panel.webview.sent.push(message),
            onDidReceiveMessage: (handler) => { settingsMessageHandler = handler; },
          },
        };
        settingsPanel = panel;
        return panel;
      },
    },
    workspace: {
      workspaceFolders: options.workspace === false ? [] : [{ uri: workspaceUri }],
      textDocuments: options.textDocuments || [],
      getConfiguration: (section) => ({
        get: (key, fallback) => {
          if (section === "terminal.integrated" && key === "defaultProfile.windows") {
            return options.terminalProfileName || fallback;
          }
          if (section === "terminal.integrated" && key === "profiles.windows") {
            return options.terminalProfiles || fallback;
          }
          if (key === "mappings") return options.mappings === undefined ? fallback : options.mappings;
          if (key === "workflows") return options.workflows === undefined ? fallback : options.workflows;
          return fallback;
        },
        inspect: () => ({}),
        update: async (...args) => { updates.push(args); },
      }),
      getWorkspaceFolder: (uri) => uri.fsPath.startsWith(workspaceUri.fsPath)
        ? { uri: workspaceUri }
        : undefined,
      onDidSaveTextDocument: (handler) => {
        listeners.save = handler;
        return { dispose() {} };
      },
      onDidCreateFiles: (handler) => {
        listeners.create = handler;
        return { dispose() {} };
      },
      fs: {
        readFile: async () => Buffer.from(importedContents),
        writeFile: async (uri, contents) => {
          writtenFile = uri;
          writtenContents = Buffer.from(contents).toString("utf8");
        },
        stat: async () => {
          if (options.statError) throw new Error(options.statError);
          return { type: options.statType === undefined ? 1 : options.statType };
        },
      },
    },
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return { dispose() {} };
      },
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, values) => diagnostics.set(uri.fsPath, values),
        delete: (uri) => diagnostics.delete(uri.fsPath),
        clear: () => diagnostics.clear(),
        dispose() {},
      }),
    },
    Position: class Position {
      constructor(line, character) { this.line = line; this.character = character; }
    },
    Range: class Range {
      constructor(start, end) { this.start = start; this.end = end; }
    },
    Diagnostic: class Diagnostic {
      constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    env: { clipboard: { readText: async () => "clipboard value" } },
    Uri: { file: (fsPath) => ({ fsPath, scheme: "file" }) },
    ViewColumn: { Active: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    FileType: { Directory: 2 },
  };
  const moduleObject = { exports: {} };
  const injectedRequire = (id) => {
    if (id === "vscode") return vscode;
    if (id === "child_process") {
      if (options.realSpawn) {
        return {
          spawn: (command, execOptions) => {
            const child = require("node:child_process").spawn(command, execOptions);
            execCalls.push({ command, options: execOptions, child });
            return child;
          },
        };
      }
      return {
        spawn: (command, execOptions) => {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = (signal) => {
            child.killSignal = signal;
            if (options.killError) throw new Error(options.killError);
            return options.killResult === undefined ? true : options.killResult;
          };
          execCalls.push({ command, options: execOptions, child });
          return child;
        },
      };
    }
    return require(id);
  };
  new Function("require", "module", "exports", source)(
    injectedRequire,
    moduleObject,
    moduleObject.exports
  );
  const context = {
    subscriptions: [],
    globalState: {
      get: (key, fallback) => globalStateValues[key] === undefined ? fallback : globalStateValues[key],
      update: async (key, value) => {
        if (value === undefined) delete globalStateValues[key];
        else globalStateValues[key] = value;
      },
    },
  };
  moduleObject.exports.activate(context);

  return {
    commands, listeners, terminals, output, updates, messages, execCalls, diagnostics,
    globalStateValues,
    vscode, context,
    deactivate: moduleObject.exports.deactivate,
    setOpenDialogResult: (result) => openDialogResults.push(result),
    setQuickPickResult: (result) => quickPickResults.push(result),
    setSaveDialogResult: (result) => { saveDialogResult = result; },
    setImportedContents: (contents) => { importedContents = contents; },
    getSettingsMessageHandler: () => settingsMessageHandler,
    getSettingsPanel: () => settingsPanel,
    getWrittenFile: () => writtenFile,
    getWrittenContents: () => writtenContents,
    getInputBoxCalls: () => inputBoxCalls,
  };
}

function uri(fsPath) {
  return { fsPath, scheme: "file" };
}

test("manifest exposes mappings and standalone workflows as top-level settings", () => {
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties["commandByExtension.mappings"].type, "array");
  assert.equal(properties["commandByExtension.workflows"].type, "array");
  assert.equal(
    properties["commandByExtension.mappings"].items.properties.saveBeforeRun.default,
    false
  );
  assert.deepEqual(
    properties["commandByExtension.mappings"].items.properties.problemMatcher.enum,
    ["none", "gcc", "typescript", "eslint", "shellcheck", "mypy"]
  );
  assert.deepEqual(
    properties["commandByExtension.workflows"].items.properties.problemMatcher.enum,
    ["none", "gcc", "typescript", "eslint", "shellcheck", "mypy"]
  );
  assert.deepEqual(properties["commandByExtension.workflows"].items.required, ["name", "command"]);
});

test("malformed legacy storage does not prevent extension activation", () => {
  const app = createHarness({ globalStateValues: { "commandByExtension.mappings": null } });
  assert.equal(typeof app.commands.get("commandByExtension.configure"), "function");
});

test("malformed history entries are ignored by history commands", async () => {
  const app = createHarness({
    globalStateValues: { "commandByExtension.history": [null, 1, {}, [], { status: "failed" }] },
  });
  await app.commands.get("commandByExtension.showHistory")();
  await app.commands.get("commandByExtension.runFromHistory")();
  assert.ok(app.messages.some((message) => message.message === "Run history is empty."));
  assert.deepEqual(app.output, []);
});

test("legacy mappings migrate before their stored copy is cleared", async () => {
  const legacy = [{ extension: ".py", command: "python {file}" }];
  const app = createHarness({ globalStateValues: { "commandByExtension.mappings": legacy } });
  assert.deepEqual(app.updates[0][1], legacy);
  assert.equal(app.updates[0][2], app.vscode.ConfigurationTarget.Global);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.globalStateValues["commandByExtension.mappings"], undefined);
});

test("activation registers workflow commands and preserves legacy mappings", async () => {
  const app = createHarness({ mappings: [{ extension: ".py", command: "python {file}" }] });
  for (const { command } of manifest.contributes.commands) {
    assert.equal(typeof app.commands.get(command), "function", `${command} is registered`);
  }
  await app.commands.get("commandByExtension.run")();
  assert.equal(app.terminals.length, 1);
  assert.match(app.terminals[0].sent[0], /^python 'C:\\project\\active\.py'$/);
});

test("multi-file run matches each extension and skips unmatched files", async () => {
  const app = createHarness({
    mappings: [
      { extension: ".py", command: "python {file}" },
      { extension: ".js", command: "node {file}" },
    ],
    openDialogResults: [[uri("C:\\project\\one.py"), uri("C:\\project\\two.js"), uri("C:\\project\\notes.txt")]],
  });
  await app.commands.get("commandByExtension.runSelectedFiles")();
  assert.equal(app.terminals.length, 2);
  assert.match(app.terminals[0].sent[0], /^python /);
  assert.match(app.terminals[1].sent[0], /^node /);
  assert.equal(app.messages.filter((message) => message.type === "warning").length, 1);
});

test("multi-file runs batch selected paths when the mapping uses {files}", async () => {
  const selectedFiles = ["C:\\project\\one.py", "C:\\project\\two.py"];
  const app = createHarness({
    mappings: [{ extension: ".py", command: "pytest {files}" }],
    openDialogResults: [selectedFiles.map(uri)],
  });
  await app.commands.get("commandByExtension.runSelectedFiles")();
  assert.equal(app.terminals.length, 1);
  assert.equal(
    app.terminals[0].sent[0],
    "pytest 'C:\\project\\one.py' 'C:\\project\\two.py'"
  );
  assert.deepEqual(app.globalStateValues["commandByExtension.history"][0].files, selectedFiles);
  await app.commands.get("commandByExtension.reRun")();
  assert.equal(app.terminals[1].sent[0], app.terminals[0].sent[0]);
});

test("re-run preserves the selected alternative command", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", commands: ["python {file}", "pytest {file}"] }],
    quickPickResults: [(items) => items.find((item) => item.commandIndex === 1)],
  });
  await app.commands.get("commandByExtension.quickRun")();
  assert.match(app.terminals[0].sent[0], /^pytest /);
  assert.equal(app.globalStateValues["commandByExtension.history"][0].commandIndex, 1);
  await app.commands.get("commandByExtension.reRun")();
  assert.match(app.terminals[1].sent[0], /^pytest /);
});

test("re-run reuses the arguments entered for the previous command", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", command: "pytest {file} -k {args}" }],
    inputResult: "smoke tests",
  });
  await app.commands.get("commandByExtension.run")();
  const firstCommand = app.terminals[0].sent[0];
  assert.equal(app.globalStateValues["commandByExtension.history"][0].args, "smoke tests");
  await app.commands.get("commandByExtension.reRun")();
  assert.equal(app.terminals[1].sent[0], firstCommand);
  assert.equal(app.getInputBoxCalls(), 1);
});

test("run from history reruns the selected older command and alternative", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", commands: ["python {file}", "pytest {file}"] }],
    globalStateValues: {
      "commandByExtension.history": [
        {
          runId: "newer",
          command: "python newer.py",
          file: "C:\\project\\newer.py",
          commandIndex: 0,
          timestamp: "2026-11-22T18:00:00.000Z",
          status: "started",
        },
        {
          runId: "older",
          command: "pytest older.py",
          file: "C:\\project\\older.py",
          commandIndex: 1,
          timestamp: "2026-11-22T17:00:00.000Z",
          status: "success",
        },
      ],
    },
    quickPickResults: [(items) => items.find((item) => item.entry.runId === "older")],
  });
  await app.commands.get("commandByExtension.runFromHistory")();
  assert.equal(app.terminals.length, 1);
  assert.match(app.terminals[0].sent[0], /^pytest 'C:\\project\\older\.py'$/);
});

test("standalone workflows run without an active file and can be re-run", async () => {
  const workflow = {
    name: "Run tests",
    command: "npm test -- {workspaceName}",
    cwd: "{workspaceFolder}",
  };
  const app = createHarness({
    editor: null,
    workflows: [workflow],
    quickPickResults: [(items) => items.find((item) => item.workflow)],
  });
  await app.commands.get("commandByExtension.quickRun")();
  assert.equal(app.terminals.length, 1);
  assert.equal(app.terminals[0].options.cwd, "C:\\project");
  assert.match(app.terminals[0].sent[0], /^npm test -- 'project'$/);
  assert.equal(app.globalStateValues["commandByExtension.history"][0].workflowName, "Run tests");

  await app.commands.get("commandByExtension.reRun")();
  assert.equal(app.terminals.length, 2);
});

test("folder Explorer action runs a standalone workflow from that folder", async () => {
  const app = createHarness({
    statType: 2,
    workflows: [{ name: "Build", command: "npm run build" }],
    quickPickResults: [(items) => items.find((item) => item.workflow)],
  });
  await app.commands.get("commandByExtension.runExplorer")(uri("C:\\project\\packages\\app"));
  assert.equal(app.terminals.length, 1);
  assert.equal(app.terminals[0].options.cwd, "C:\\project\\packages\\app");
  await app.commands.get("commandByExtension.reRun")();
  assert.equal(app.terminals[1].options.cwd, "C:\\project\\packages\\app");
});

test("Windows PowerShell placeholders preserve quotes and dollar signs", async () => {
  const file = "C:\\project\\O'Brien $NAME.py";
  const app = createHarness({
    editor: {
      document: {
        uri: uri(file),
        getText: () => "",
        getWordRangeAtPosition: () => undefined,
      },
      selection: { active: { line: 0 }, isEmpty: true },
    },
    mappings: [{ extension: ".py", command: "python {file}" }],
    terminalProfileName: "PowerShell",
  });
  await app.commands.get("commandByExtension.run")();
  if (process.platform === "win32") {
    assert.equal(app.terminals[0].sent[0], "python 'C:\\project\\O''Brien $NAME.py'");
  }
});

test("before and after hooks use the configured shell's command separator", async () => {
  const app = createHarness({
    mappings: [{
      extension: ".py",
      command: "python {file}",
      before: "prepare",
      after: "cleanup",
    }],
    terminalProfileName: "PowerShell",
  });
  await app.commands.get("commandByExtension.run")();
  if (process.platform === "win32") {
    assert.match(app.terminals[0].sent[0], /^prepare; python .*; cleanup$/);
  } else {
    assert.match(app.terminals[0].sent[0], /^prepare && python .* && cleanup$/);
  }
});

test("Windows Command Prompt uses its own hook separator", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", before: "prepare", after: "cleanup" }],
    terminalProfileName: "Command Prompt",
    terminalProfiles: { "Command Prompt": { path: "C:\\Windows\\System32\\cmd.exe" } },
  });
  await app.commands.get("commandByExtension.run")();
  if (process.platform === "win32") {
    assert.match(app.terminals[0].sent[0], /^prepare & python .* & cleanup$/);
  }
});

test("save triggers debounce and automated runs publish diagnostics", async () => {
  const app = createHarness({
    mappings: [
      {
        extension: ".py",
        command: "mypy {file}",
        mode: "capture",
        problemMatcher: "mypy",
        runOnSave: true,
        runOnCreate: true,
      },
      { extension: ".js", command: "node {file}" },
    ],
  });
  await app.listeners.save({ uri: uri("C:\\project\\script.py") });
  await app.listeners.save({ uri: uri("C:\\project\\script.py") });
  await app.listeners.save({ uri: uri("C:\\project\\script.js") });
  await app.listeners.create({ files: [uri("C:\\project\\new.py")] });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(app.execCalls.length, 2);
  app.execCalls[1].child.stdout.emit(
    "data",
    Buffer.from("C:\\project\\script.py:6: error: Bad type [assignment]\n")
  );
  app.execCalls[1].child.emit("close", 1, null);
  assert.equal(app.diagnostics.get("C:\\project\\script.py")[0].message, "Bad type");
});

test("save before run saves dirty files without duplicating run-on-save commands", async () => {
  let app;
  let saveCalls = 0;
  const document = {
    uri: uri("C:\\project\\active.py"),
    isDirty: true,
    getText: () => "",
    getWordRangeAtPosition: () => undefined,
    save: async function () {
      saveCalls += 1;
      this.isDirty = false;
      await app.listeners.save(this);
      return true;
    },
  };
  app = createHarness({
    mappings: [{
      extension: ".py",
      command: "python {file}",
      saveBeforeRun: true,
      runOnSave: true,
    }],
    textDocuments: [document],
    editor: { document, selection: { active: { line: 0 }, isEmpty: true } },
  });
  await app.commands.get("commandByExtension.run")();
  assert.equal(saveCalls, 1);
  assert.equal(app.terminals.length, 1);
});

test("save before run blocks execution when saving fails", async () => {
  const document = {
    uri: uri("C:\\project\\active.py"),
    isDirty: true,
    save: async () => false,
    getText: () => "",
    getWordRangeAtPosition: () => undefined,
  };
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", saveBeforeRun: true }],
    textDocuments: [document],
    editor: { document, selection: { active: { line: 0 }, isEmpty: true } },
  });
  await app.commands.get("commandByExtension.run")();
  assert.equal(app.terminals.length, 0);
  assert.ok(app.messages.some((message) =>
    message.type === "warning" && message.message.includes("was not saved")
  ));
});

test("save before run reports save errors and prevents execution", async () => {
  const document = {
    uri: uri("C:\\project\\active.py"),
    isDirty: true,
    save: async () => { throw new Error("read-only document"); },
    getText: () => "",
    getWordRangeAtPosition: () => undefined,
  };
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", saveBeforeRun: true }],
    textDocuments: [document],
    editor: { document, selection: { active: { line: 0 }, isEmpty: true } },
  });
  await app.commands.get("commandByExtension.run")();
  assert.equal(app.terminals.length, 0);
  assert.ok(app.messages.some((message) =>
    message.type === "error" && message.message.includes("read-only document")
  ));
});

test("manual runs cancel a pending debounced save run", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", runOnSave: true }],
  });
  await app.listeners.save({ uri: uri("C:\\project\\active.py") });
  await app.commands.get("commandByExtension.run")();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(app.terminals.length, 1);
});

test("deactivation clears pending save timers", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", runOnSave: true }],
  });
  await app.listeners.save({ uri: uri("C:\\project\\active.py") });
  app.deactivate();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(app.terminals.length, 0);
});

test("captured mode passes environment, records output and reports completion", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", mode: "capture", env: { APP_MODE: "test" } }],
  });
  await app.commands.get("commandByExtension.run")();
  assert.equal(app.execCalls.length, 1);
  assert.equal(app.execCalls[0].options.env.APP_MODE, "test");
  app.execCalls[0].child.stdout.emit("data", Buffer.from("stdout"));
  app.execCalls[0].child.emit("close", 0, null);
  assert.ok(app.output.includes("stdout"));
  assert.ok(app.messages.some((message) => message.message.includes("Command completed")));
  assert.equal(app.globalStateValues["commandByExtension.history"].length, 1);
  assert.equal(app.globalStateValues["commandByExtension.history"][0].status, "success");
});

test("captured GCC diagnostics populate clickable Problems entries across split output chunks", async () => {
  const app = createHarness({
    mappings: [{
      extension: ".py",
      command: "compiler {file}",
      mode: "capture",
      problemMatcher: "gcc",
    }],
  });
  await app.commands.get("commandByExtension.run")();
  app.execCalls[0].child.stderr.emit("data", Buffer.from("src/main.c:7:"));
  app.execCalls[0].child.stderr.emit("data", Buffer.from("3: error: missing return\n"));
  app.execCalls[0].child.emit("close", 1, null);
  const diagnosticPath = path.resolve("C:\\project", "src\\main.c");
  const [diagnostic] = app.diagnostics.get(diagnosticPath);
  assert.equal(diagnostic.message, "missing return");
  assert.equal(diagnostic.severity, app.vscode.DiagnosticSeverity.Error);
  assert.equal(diagnostic.source, "Command by Extension");
  assert.deepEqual(diagnostic.range.start, new app.vscode.Position(6, 2));
  assert.deepEqual(diagnostic.range.end, new app.vscode.Position(6, 3));
});

test("TypeScript and ESLint matchers report their severity and diagnostic code", async () => {
  const cases = [
    {
      matcher: "typescript",
      line: "src/app.ts(4,2): error TS2345: Invalid value\n",
      expectedCode: "TS2345",
      expectedSeverity: 0,
    },
    {
      matcher: "eslint",
      line: "src/app.js:4:2: warning Unexpected variable\n",
      expectedSeverity: 1,
    },
    {
      matcher: "shellcheck",
      line: "test.sh:3:7: warning: Quote this to prevent word splitting. [SC2086]\n",
      expectedCode: "SC2086",
      expectedSeverity: 1,
    },
    {
      matcher: "mypy",
      line: "src/app.py:12: error: Incompatible return value [return-value]\n",
      expectedCode: "return-value",
      expectedSeverity: 0,
    },
  ];
  for (const item of cases) {
    const app = createHarness({
      mappings: [{
        extension: ".py",
        command: "check {file}",
        mode: "capture",
        problemMatcher: item.matcher,
      }],
    });
    await app.commands.get("commandByExtension.run")();
    app.execCalls[0].child.stdout.emit("data", Buffer.from(item.line));
    app.execCalls[0].child.emit("close", 0, null);
    const diagnostics = [...app.diagnostics.values()];
    assert.equal(diagnostics.length, 1, item.matcher);
    assert.equal(diagnostics[0][0].severity, item.expectedSeverity);
    assert.equal(diagnostics[0][0].code, item.expectedCode);
  }
});

test("standalone captured workflows can publish project diagnostics", async () => {
  const app = createHarness({
    editor: null,
    workflows: [{
      name: "Type-check",
      command: "npx tsc --noEmit",
      mode: "capture",
      problemMatcher: "typescript",
    }],
    quickPickResults: [(items) => items.find((item) => item.workflow)],
  });
  await app.commands.get("commandByExtension.quickRun")();
  app.execCalls[0].child.stderr.emit(
    "data",
    Buffer.from("src/app.ts(4,2): error TS2345: Invalid value\n")
  );
  app.execCalls[0].child.emit("close", 1, null);
  assert.equal(app.diagnostics.size, 1);
  assert.equal([...app.diagnostics.values()][0][0].code, "TS2345");
});

test("terminal mode warns when a problem matcher cannot collect output", async () => {
  const app = createHarness({
    mappings: [{
      extension: ".py",
      command: "compiler {file}",
      mode: "terminal",
      problemMatcher: "gcc",
    }],
  });
  await app.commands.get("commandByExtension.run")();
  assert.equal(app.terminals.length, 1);
  assert.ok(app.messages.some((message) =>
    message.type === "warning" && message.message.includes("require Capture output mode")
  ));
  assert.equal(app.diagnostics.size, 0);
});

test("captured command can be stopped and recorded as cancelled", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", mode: "capture" }],
    quickPickResults: [(items) => items[0]],
  });
  await app.commands.get("commandByExtension.run")();
  await app.commands.get("commandByExtension.stopCapturedRun")();
  assert.equal(app.execCalls[0].child.killSignal, "SIGTERM");
  assert.equal(app.globalStateValues["commandByExtension.history"][0].status, "running");

  app.execCalls[0].child.emit("close", null, "SIGTERM");
  assert.equal(app.globalStateValues["commandByExtension.history"][0].status, "cancelled");
  assert.ok(app.messages.some((message) => message.message.includes("Command stopped")));
});

test("stopping one of several captured commands leaves the others running", async () => {
  const app = createHarness({
    mappings: [
      { extension: ".py", command: "python {file}", mode: "capture" },
      { extension: ".js", command: "node {file}", mode: "capture" },
    ],
    quickPickResults: [(items) =>
      items.find((item) => item.run.historyEntry.file.endsWith(".js"))
    ],
  });
  await app.commands.get("commandByExtension.run")();
  await app.commands.get("commandByExtension.runExplorer")(uri("C:\\project\\worker.js"));
  await app.commands.get("commandByExtension.stopCapturedRun")();

  app.execCalls[0].child.emit("close", 0, null);
  app.execCalls[1].child.emit("close", null, "SIGTERM");
  const history = app.globalStateValues["commandByExtension.history"];
  assert.equal(history.find((entry) => entry.file.endsWith(".py")).status, "success");
  assert.equal(history.find((entry) => entry.file.endsWith(".js")).status, "cancelled");
});

test("stop command reports when no captured runs are active", async () => {
  const app = createHarness();
  await app.commands.get("commandByExtension.stopCapturedRun")();
  assert.ok(app.messages.some((message) => message.message.includes("No captured commands are running")));
});

test("stop command reports a failed process termination request", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", mode: "capture" }],
    quickPickResults: [(items) => items[0]],
    killResult: false,
  });
  await app.commands.get("commandByExtension.run")();
  await app.commands.get("commandByExtension.stopCapturedRun")();
  assert.ok(app.messages.some((message) =>
    message.type === "warning" && message.message.includes("Could not stop")
  ));
  app.execCalls[0].child.emit("close", 0, null);
});

test("captured mode streams output larger than exec's default buffer and reports failure", async () => {
  const app = createHarness({
    mappings: [{ extension: ".py", command: "python {file}", mode: "capture" }],
  });
  await app.commands.get("commandByExtension.run")();
  app.execCalls[0].child.stdout.emit("data", Buffer.alloc(2 * 1024 * 1024, 97));
  app.execCalls[0].child.stderr.emit("data", Buffer.from("test failure"));
  app.execCalls[0].child.emit("close", 1, null);
  assert.ok(app.output.join("").length > 2 * 1024 * 1024);
  assert.equal(app.globalStateValues["commandByExtension.history"][0].status, "failed");
  assert.ok(app.messages.some((message) => message.type === "error" && message.message.includes("exited with code 1")));
});

test("captured mode runs a real local process and streams its output", async () => {
  const app = createHarness({
    realSpawn: true,
    workflows: [{
      name: "Smoke test",
      command: `node -e "process.stdout.write('SMOKE_OK')"` ,
      mode: "capture",
      cwd: process.cwd(),
    }],
    editor: null,
    quickPickResults: [(items) => items.find((item) => item.workflow)],
  });
  await app.commands.get("commandByExtension.quickRun")();
  const child = app.execCalls[0].child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Smoke process timed out")), 10000);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Smoke process exited with ${code}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.ok(app.output.join("").includes("SMOKE_OK"));
  assert.equal(app.globalStateValues["commandByExtension.history"][0].status, "success");
});

test("Explorer reports a deleted or inaccessible target instead of rejecting", async () => {
  const app = createHarness({ statError: "file no longer exists" });
  await app.commands.get("commandByExtension.runExplorer")(uri("C:\\project\\gone.py"));
  assert.ok(app.messages.some((message) =>
    message.type === "error" && message.message.includes("file no longer exists")
  ));
});

test("settings panel saves mappings to workspace scope when selected", async () => {
  const app = createHarness({
    mappings: [{
      name: "Run tests",
      extension: ".py",
      commands: ["pytest"],
      mode: "capture",
      problemMatcher: "gcc",
      env: { PYTHONUNBUFFERED: "1" },
      cwd: "{workspaceFolder}",
      before: "prepare",
      after: "cleanup",
      saveBeforeRun: true,
      runOnSave: true,
      runOnCreate: false,
    }],
  });
  await app.commands.get("commandByExtension.configure")();
  const handler = app.getSettingsMessageHandler();
  await handler({
    type: "save",
    scope: "workspace",
    mappings: [{
      name: "Run tests",
      extension: "py",
      commands: ["pytest"],
      mode: "capture",
      problemMatcher: "gcc",
      env: { PYTHONUNBUFFERED: "1" },
      cwd: "{workspaceFolder}",
      before: "prepare",
      after: "cleanup",
      saveBeforeRun: true,
      runOnSave: true,
      runOnCreate: false,
    }],
  });
  assert.equal(app.updates.length, 1);
  assert.equal(app.updates[0][2], app.vscode.ConfigurationTarget.Workspace);
  assert.equal(app.updates[0][1][0].mode, "capture");
  assert.equal(app.updates[0][1][0].problemMatcher, "gcc");
  assert.deepEqual(app.updates[0][1][0].env, { PYTHONUNBUFFERED: "1" });
  assert.equal(app.updates[0][1][0].saveBeforeRun, true);
  assert.equal(app.updates[0][1][0].runOnSave, true);
});

test("settings panel exposes import/export and imports into the selected scope", async () => {
  const app = createHarness({ mappings: [] });
  await app.commands.get("commandByExtension.configure")();
  const html = app.getSettingsPanel().webview.html;
  assert.match(html, /id="import" type="button">Import configuration/);
  assert.match(html, /id="export" type="button">Export configuration/);
  assert.match(html, /Share with this project/);
  assert.match(html, /Use across projects/);
  assert.match(html, /Standalone workflows/);
  assert.match(html, /id="addWorkflow"/);
  assert.match(html, /Save before running/);
  assert.match(html, /Run on Save \(300 ms debounce\)/);
  assert.match(html, /GCC \/ Clang/);
  assert.match(html, /Capture/);
  assert.match(html, /Problems/);
  assert.match(html, /min-height:112px/);
  assert.match(html, /min-height:84px/);
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));

  app.setOpenDialogResult([uri("C:\\tmp\\team.json")]);
  app.setImportedContents(JSON.stringify({ mappings: [{ extension: ".py", command: "pytest" }] }));
  await app.getSettingsMessageHandler()({ type: "import", scope: "workspace" });
  assert.equal(app.updates.length, 1);
  assert.equal(app.updates[0][2], app.vscode.ConfigurationTarget.Workspace);
  assert.ok(app.getSettingsPanel().webview.sent.some((message) =>
    message.type === "imported" && message.mappings[0].extension === ".py"
  ));

  const file = uri("C:\\tmp\\export.json");
  app.setSaveDialogResult(file);
  await app.getSettingsMessageHandler()({ type: "export" });
  assert.equal(app.getWrittenFile(), file);
  assert.deepEqual(JSON.parse(app.getWrittenContents()), { version: 1, mappings: [], workflows: [] });
});

test("settings panel saves standalone workflows to the selected scope", async () => {
  const app = createHarness({ mappings: [], workflows: [] });
  await app.commands.get("commandByExtension.configure")();
  await app.getSettingsMessageHandler()({
    type: "saveWorkflows",
    scope: "workspace",
    workflows: [{
      name: "Build",
      command: "npm run build",
      mode: "capture",
      problemMatcher: "typescript",
    }],
  });
  assert.equal(app.updates.length, 1);
  assert.equal(app.updates[0][0], "workflows");
  assert.equal(app.updates[0][2], app.vscode.ConfigurationTarget.Workspace);
  assert.equal(app.updates[0][1][0].problemMatcher, "typescript");
  assert.deepEqual(app.getSettingsPanel().webview.sent, [{ type: "workflowsSaved" }]);
});

test("import accepts legacy and current mappings and validates before saving", async () => {
  const app = createHarness({
    workspace: false,
    openDialogResults: [[uri("C:\\tmp\\mappings.json")]],
  });
  app.setImportedContents(JSON.stringify([
    { extension: "py", command: "python {file}" },
    {
      extension: ".js",
      commands: ["node {file}"],
      mode: "capture",
      problemMatcher: "typescript",
      saveBeforeRun: true,
    },
    { extension: ".rb", command: "ruby {file}", commands: [] },
  ]));
  await app.commands.get("commandByExtension.importMappings")();
  assert.equal(app.updates.length, 1);
  assert.deepEqual(app.updates[0][1].map((mapping) => mapping.extension), [".py", ".js", ".rb"]);
  assert.deepEqual(app.updates[0][1][2].commands, ["ruby {file}"]);
  assert.equal(app.updates[0][1][1].saveBeforeRun, true);
  assert.equal(app.updates[0][1][1].problemMatcher, "typescript");
  assert.equal(app.updates[0][2], app.vscode.ConfigurationTarget.Global);

  app.setOpenDialogResult([uri("C:\\tmp\\invalid.json")]);
  app.setImportedContents("{invalid json");
  await app.commands.get("commandByExtension.importMappings")();
  assert.equal(app.updates.length, 1);
  assert.ok(app.messages.some((message) => message.type === "error" && message.message.includes("Could not import")));

  app.setOpenDialogResult([uri("C:\\tmp\\invalid-workflow.json")]);
  app.setImportedContents(JSON.stringify({
    mappings: [{ extension: ".py", command: "pytest" }],
    workflows: [{ name: "TypeScript", command: "tsc", problemMatcher: "typescript" }],
  }));
  await app.commands.get("commandByExtension.importMappings")();
  assert.equal(app.updates.length, 1);
});

test("import lets a workspace choose workspace or user scope", async () => {
  const app = createHarness({
    mappings: [],
    openDialogResults: [[uri("C:\\tmp\\team.json")]],
    quickPickResults: [{ label: "This workspace", target: 2 }],
  });
  app.setImportedContents(JSON.stringify({
    mappings: [{ extension: ".ts", command: "npm test" }],
    workflows: [{ name: "Build", command: "npm run build" }],
  }));
  await app.commands.get("commandByExtension.importMappings")();
  assert.equal(app.updates.length, 2);
  assert.equal(app.updates[0][2], app.vscode.ConfigurationTarget.Workspace);
  assert.equal(app.updates[1][0], "workflows");
  assert.equal(app.updates[1][2], app.vscode.ConfigurationTarget.Workspace);
});

test("export writes current mappings as a versioned JSON configuration", async () => {
  const mappings = [{ extension: ".py", command: "python {file}" }];
  const workflows = [{ name: "Test", command: "npm test" }];
  const app = createHarness({ mappings, workflows });
  const file = uri("C:\\tmp\\command-by-extension.json");
  app.setSaveDialogResult(file);
  await app.commands.get("commandByExtension.exportMappings")();
  assert.equal(app.getWrittenFile(), file);
  assert.deepEqual(JSON.parse(app.getWrittenContents()), { version: 1, mappings, workflows });
});
