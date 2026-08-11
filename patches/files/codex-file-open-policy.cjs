const path = require("node:path");

const markdownExtensions = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".mkdn",
]);

function resolveRightColumn(tabGroups, ViewColumn, panelColumn) {
  const claudeGroup = (tabGroups?.all || []).find((group) =>
    (group?.tabs || []).some((tab) =>
      ["claudeVSCodePanel", "claude-vscode.editor"].includes(
        tab?.input?.viewType,
      ),
    ),
  );
  const sourceColumn = Number.isInteger(panelColumn)
    ? panelColumn
    : claudeGroup?.viewColumn ?? tabGroups?.activeTabGroup?.viewColumn;
  if (!Number.isInteger(sourceColumn)) return ViewColumn.Beside;

  const nearestRightGroup = (tabGroups?.all || [])
    .map((group) => group?.viewColumn)
    .filter((column) => Number.isInteger(column) && column > sourceColumn)
    .sort((left, right) => left - right)[0];

  return nearestRightGroup ?? sourceColumn + 1;
}

function isMarkdownPath(filePath) {
  return markdownExtensions.has(path.extname(filePath).toLowerCase());
}

function installOpenFile(HostClass, dependencies) {
  const { vscode, fs, findFiles } = dependencies;

  HostClass.prototype.openFile = async function openFileToRight(filePath, location) {
    let resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.cwd, filePath);

    if (!fs.existsSync(resolvedPath) && path.isAbsolute(filePath)) {
      const workspaceRelative = filePath.match(/^\/[^/]+\/[^/]+\/(.+)$/);
      if (workspaceRelative) {
        const candidate = path.join(this.cwd, workspaceRelative[1]);
        if (fs.existsSync(candidate)) resolvedPath = candidate;
      }
    }

    if (!fs.existsSync(resolvedPath) && !path.isAbsolute(filePath)) {
      const matches = await findFiles(filePath);
      if (matches.length > 0) resolvedPath = path.join(this.cwd, matches[0].path);
    }

    const resource = vscode.Uri.file(resolvedPath);
    try {
      if (fs.statSync(resolvedPath).isDirectory()) {
        await vscode.commands.executeCommand("revealInExplorer", resource);
        return;
      }
    } catch {
      // Preserve the extension's original behavior and let VS Code report open errors.
    }

    const targetColumn = resolveRightColumn(
      vscode.window.tabGroups,
      vscode.ViewColumn,
      this.panelTab?.viewColumn,
    );
    if (isMarkdownPath(resolvedPath)) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        resource,
        "vscode.markdown.preview.editor",
        targetColumn,
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument(resource);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: targetColumn,
      preserveFocus: false,
      preview: true,
    });

    if (location?.searchText) {
      const offset = editor.document.getText().indexOf(location.searchText);
      if (offset === -1) return;
      const start = editor.document.positionAt(offset);
      const end = editor.document.positionAt(offset + location.searchText.length);
      const range = new vscode.Range(start, end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(start, end);
      return;
    }

    if (location) {
      const range = new vscode.Range(
        new vscode.Position((location.startLine || 1) - 1, 0),
        new vscode.Position((location.endLine || location.startLine || 1) - 1, 0),
      );
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.end);
    }
  };
}

module.exports = {
  installOpenFile,
  isMarkdownPath,
  resolveRightColumn,
};
