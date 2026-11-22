# Command by Extension

A practical Visual Studio Code workflow tool for running reusable commands based on file types.

## Use

1. Open **Configure Commands by File Extension** from the Command Palette or the settings icon in the editor title.
2. Add a mapping such as `.py` with `python {file}`. Put alternative commands on separate lines; choose one when the file runs.
3. Save, open a matching file, and select the play icon to run it.
4. Use **Command by Extension: Quick Run** to choose among all configured presets.

Mappings support user settings and workspace settings. Existing `{ "extension": ".py", "command": "..." }` mappings remain compatible.
Enable **Save before running** on a mapping to save any matching open, modified files before launching its command. If saving is canceled or fails, the command is not started. The option is off by default.

## Workflow features

- Multiple commands per file extension
- Named standalone workflows for builds, tests, and other tasks that do not need an active file
- Quick-pick command presets (standalone workflows run without opening a file)
- Re-run and run-history commands
- Interactive run history for rerunning any previous file command or workflow
- Explorer context menu for files and folders
- Captured output mode with execution duration
- Stop long-running captured commands from the Command Palette
- Compiler and linter diagnostics linked to files and lines in VS Code's Problems panel
- Optional `before` and `after` commands
- Environment variables and custom working directories
- Optional save-before-run for open modified files, preventing tools from reading stale disk contents
- Automatic execution on save or file creation
- Workspace/team configuration through resource-scoped settings
- Run commands on multiple files in one selection
- Import and export mapping files for sharing or backup

### Placeholders

- `{file}` — active file absolute path
- `{files}` — selected file paths, each shell-quoted; use with **Run on Multiple Files**
- `{fileName}` — file name including extension
- `{fileNameWithoutExt}` — file name without its final extension
- `{fileDirname}` — containing directory
- `{workspaceFolder}` — containing workspace folder
- `{workspaceName}` — workspace folder name
- `{relativePath}` — file path relative to the workspace
- `{selectedText}` — selected editor text
- `{clipboard}` — current clipboard text
- `{extension}` — file extension
- `{timestamp}` — ISO timestamp
- `{currentLine}` — active line number
- `{currentWord}` — word under the cursor
- `{args}` — arguments entered when the command runs

Placeholder paths are shell-quoted for the operating system's default shell. Commands are user-defined and run in the integrated terminal or captured output channel.

## Problems panel integration

For mappings or standalone workflows, choose **Capture** output and select a problem matcher: **GCC / Clang**, **TypeScript**, **ESLint**, **ShellCheck**, or **mypy**. Matching errors and warnings become clickable Problems entries while output is captured. GCC/Clang and TypeScript use their standard formats; ESLint expects `file:line:column: error|warning message` output (for example, its Unix formatter); ShellCheck expects GCC-format output (`--format=gcc`); and mypy uses its normal `file:line: error: message [code]` output. Diagnostics use the Problems panel's normal navigation to open the corresponding file and line.

Enable **Run on Save** on a mapping to rerun it after edits; saves to the same file within 300 ms are coalesced. With Capture and a matcher enabled, this gives a lightweight save-to-Problems feedback loop.

Example standalone TypeScript check:

```json
"commandByExtension.workflows": [
  {
    "name": "Type-check",
    "command": "npx tsc --noEmit",
    "cwd": "{workspaceFolder}",
    "mode": "capture",
    "problemMatcher": "typescript"
  }
]
```

Run it from **Command by Extension: Quick Run**, then click a reported problem to jump to its source location.

For shell scripts, configure ShellCheck like this (with ShellCheck installed):

```json
{
  "extension": ".sh",
  "command": "shellcheck --format=gcc {file}",
  "mode": "capture",
  "problemMatcher": "shellcheck"
}
```

## Sharing and batch runs

Use **Import configuration** and **Export configuration** at the top of the configuration panel, or the matching commands in the Command Palette, to move mappings and standalone workflows between machines or share them with a team. Imports are validated before they replace settings and immediately refresh the panel. When a workspace is open, choose whether to save changes or imports to workspace or user settings.

Use **Command by Extension: Run on Multiple Files** to select several files. Each file uses the most-specific matching extension mapping, and files without a mapping are reported after the matching files are started. Mappings that use `{files}` run once per matching mapping with all selected paths; other mappings continue to run once per file. In the Explorer, files use their extension mapping; folders offer standalone workflows and run from the selected folder.

Use **Command by Extension: Run from History** to select and rerun any recent command. Re-runs preserve the chosen command, entered `{args}`, and the file or folder context used for that run.

Use **Command by Extension: Stop Captured Command** to request termination of a running captured command. Its history status updates when the process exits.

Standalone workflows can also be added in the **Standalone workflows** section of the configuration panel. They appear in **Command by Extension: Quick Run** even when no editor is open.

For advanced workflow options, add a `commandByExtension.workflows` array to VS Code settings:

```json
"commandByExtension.workflows": [
  {
    "name": "Run tests",
    "command": "npm test",
    "mode": "capture",
    "cwd": "{workspaceFolder}",
    "env": {
      "CI": "1"
    }
  }
]
```

## Advanced mapping example

```json
"commandByExtension.mappings": [
  {
    "name": "Python workflow",
    "extension": ".py",
    "commands": [
      "python {file}",
      "python -m pytest"
    ],
    "mode": "capture",
    "cwd": "{workspaceFolder}",
    "before": "python -m pip install -r requirements.txt",
    "runOnSave": true,
    "env": {
      "PYTHONUNBUFFERED": "1"
    }
  }
]
```
