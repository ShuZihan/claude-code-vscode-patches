import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, replaceExact } from "./lib.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = parseArgs(process.argv.slice(2));
const extensionRoot = path.resolve(String(args.get("extension-root") || ""));
if (!args.get("extension-root") || !fs.existsSync(extensionRoot)) {
  throw new Error("--extension-root must point to an extracted VSIX extension directory");
}

const patchRoot = path.join(repositoryRoot, "patches");
const patchManifest = JSON.parse(
  fs.readFileSync(path.join(patchRoot, "manifest.json"), "utf8"),
);
const read = (relativePath) =>
  fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");
const write = (relativePath, value) =>
  fs.writeFileSync(path.join(extensionRoot, relativePath), value);

function replacePattern(source, pattern, replacement, expected, label) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const matches = [...source.matchAll(globalPattern)];
  if (matches.length !== expected) {
    throw new Error(
      `${label}: expected ${expected} match(es), found ${matches.length}`,
    );
  }
  return source.replace(globalPattern, replacement);
}

function copyTree(source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function patchPackageJson() {
  const packagePath = path.join(extensionRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const commands = packageJson.contributes?.commands;
  const titleMenu = packageJson.contributes?.menus?.["editor/title"];
  if (!Array.isArray(commands) || !Array.isArray(titleMenu)) {
    throw new Error("package.json: expected command and editor/title contributions");
  }
  if (
    packageJson.displayName !== "Claude Code for VS Code" ||
    !String(packageJson.description).startsWith("Claude Code for VS Code:")
  ) {
    throw new Error("package.json: official display name or description changed");
  }
  packageJson.displayName = "Claude Code for VS Code (Custom)";
  packageJson.description =
    `Unofficial custom build custom.${patchManifest.customRevision}, based on Claude Code ${packageJson.version}. ${packageJson.description}`;
  packageJson.claudeCodeCustomBuild = {
    unofficial: true,
    baseVersion: packageJson.version,
    revision: patchManifest.customRevision,
    repository: "ShuZihan/claude-code-vscode-patches",
  };

  const viewContainers = [
    ...(packageJson.contributes?.viewsContainers?.activitybar || []),
    ...(packageJson.contributes?.viewsContainers?.secondarySidebar || []),
  ];
  const titledContainers = viewContainers.filter(
    (item) => item.title === "Claude Code",
  );
  if (titledContainers.length !== 3) {
    throw new Error(
      `package.json: expected 3 Claude Code view containers, found ${titledContainers.length}`,
    );
  }
  for (const container of titledContainers) {
    container.title = "Claude Code (Custom)";
  }
  const chatViews = [
    ...(packageJson.contributes?.views?.["claude-sidebar"] || []),
    ...(packageJson.contributes?.views?.["claude-sidebar-secondary"] || []),
  ];
  const namedChatViews = chatViews.filter((item) => item.name === "Claude Code");
  if (namedChatViews.length !== 2) {
    throw new Error(
      `package.json: expected 2 named Claude Code views, found ${namedChatViews.length}`,
    );
  }
  for (const view of namedChatViews) {
    view.name = "Claude Code (Custom)";
  }

  if (commands.some((item) => item.command === "claude-vscode.toggleRightEditorGroup")) {
    throw new Error("package.json: right editor group command is already present");
  }
  const focusCommandIndex = commands.findIndex(
    (item) => item.command === "claude-vscode.toggleFocusView",
  );
  if (focusCommandIndex < 0) {
    throw new Error("package.json: toggleFocusView command anchor is missing");
  }
  commands.splice(focusCommandIndex + 1, 0, {
    command: "claude-vscode.toggleRightEditorGroup",
    title: "Claude Code: Collapse or Expand Right Editor Group",
    icon: "$(layout-sidebar-right)",
  });
  titleMenu.unshift({
    command: "claude-vscode.toggleRightEditorGroup",
    when: "activeEditor == claudeVSCodePanel && multipleEditorGroups",
    group: "navigation@0",
  });
  const openLast = titleMenu.find(
    (item) => item.command === "claude-vscode.editor.openLast",
  );
  if (!openLast || openLast.when !== "!config.claudeCode.useTerminal") {
    throw new Error("package.json: openLast menu anchor is missing or changed");
  }
  openLast.when =
    "!config.claudeCode.useTerminal && activeEditor != claudeVSCodePanel";
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function patchExtensionBundle() {
  let source = read("extension.js");
  const openFileIndex = source.indexOf("async openFile(");
  if (
    openFileIndex < 0 ||
    source.indexOf("async openFile(", openFileIndex + 1) >= 0
  ) {
    throw new Error("file-open policy requires exactly one openFile method");
  }
  const openFileEnd = source.indexOf("openConfigFile(", openFileIndex);
  const classStart = source.lastIndexOf("class ", openFileIndex);
  const classHeader = source.slice(classStart, source.indexOf("{", classStart));
  const openFileMethod = source.slice(openFileIndex, openFileEnd);
  const hostClass = classHeader.match(/^class ([A-Za-z_$][\w$]*) extends /)?.[1];
  const vscodeBinding = openFileMethod.match(
    /let n=([A-Za-z_$][\w$]*)\.Uri\.file\(r\)/,
  )?.[1];
  const fsBinding = openFileMethod.match(
    /if\(!([A-Za-z_$][\w$]*)\.existsSync\(r\)/,
  )?.[1];
  const findFilesBinding = openFileMethod.match(
    /let i=await ([A-Za-z_$][\w$]*)\(e\)/,
  )?.[1];
  if (!hostClass || !vscodeBinding || !fsBinding || !findFilesBinding) {
    throw new Error("file-open policy could not discover the vendor bindings");
  }

  const providerImportPattern =
    /var ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(require\("fs"\)\),([A-Za-z_$][\w$]*)=\2\(require\("os"\)\),([A-Za-z_$][\w$]*)=\2\(require\("vscode"\)\);var ([A-Za-z_$][\w$]*)=10;class ([A-Za-z_$][\w$]*)\{extensionUri;context;output;settings;leftTempFileProvider/;
  const providerImportMatches = [...source.matchAll(new RegExp(providerImportPattern, "g"))];
  if (providerImportMatches.length !== 1) {
    throw new Error(
      `provider usage requires exactly one provider import block, found ${providerImportMatches.length}`,
    );
  }
  const providerImport = providerImportMatches[0];
  const providerVscodeBinding = providerImport[4];
  const providerImportOriginal = providerImport[0];
  const providerImportPatched = providerImportOriginal.replace(
    `;var ${providerImport[5]}=10;`,
    `;var {createProviderUsageModule:codexCreateProviderUsageModule}=require("./codex-provider-usage.js");var ${providerImport[5]}=10;`,
  );

  const bundleUrl =
    "var __EXT_BUNDLE_URL = require('node:url').pathToFileURL(__filename).href;";
  source = replaceExact(
    source,
    bundleUrl,
    `${bundleUrl}\nvar CodexFileOpenPolicy = require("./codex-file-open-policy.cjs");\nprocess.nextTick(() => CodexFileOpenPolicy.installOpenFile(${hostClass}, { vscode: ${vscodeBinding}, fs: ${fsBinding}, findFiles: ${findFilesBinding} }));`,
    1,
    "file-open policy bootstrap",
  );

  source = replaceExact(
    source,
    providerImportOriginal,
    providerImportPatched,
    1,
    "provider usage import",
  );
  source = replaceExact(
    source,
    "sessionListView;authManager;atMentionStash=",
    "sessionListView;providerUsage;authManager;atMentionStash=",
    1,
    "provider usage field",
  );
  source = replaceExact(
    source,
    "this.documentClosedEvents=l;this.getSelection=u;this.authManager=",
    `this.documentClosedEvents=l;this.getSelection=u;this.providerUsage=codexCreateProviderUsageModule({getRuntimeEnvironment:()=>\$p(),getWorkspaceRoots:()=>${providerVscodeBinding}.workspace.workspaceFolders?.map((d)=>d.uri.fsPath)||[]});this.authManager=`,
    1,
    "provider usage initialization",
  );
  source = replaceExact(
    source,
    "deliverStashedAtMention(e){let t=this.atMentionStash.take();if(t!==void 0)e.sendAtMention(t)}resolveWebviewView(e,t,r){",
    'deliverStashedAtMention(e){let t=this.atMentionStash.take();if(t!==void 0)e.sendAtMention(t)}handleCodexProviderUsageMessage(e,t){if(e?.type!=="codex.providerUsage.query")return!1;let r=typeof e.requestId==="string"?e.requestId:"";return this.providerUsage.query({force:e.force===!0}).then((n)=>t.postMessage({type:"codex.providerUsage.result",requestId:r,report:n})).catch(()=>t.postMessage({type:"codex.providerUsage.result",requestId:r,report:{version:1,providerId:null,providerName:"当前提供商",status:"error",errorCode:"internal_error",resources:[],fetchedAt:new Date().toISOString(),stale:!1}})),!0}resolveWebviewView(e,t,r){',
    1,
    "provider usage handler",
  );
  source = replaceExact(
    source,
    'e.webview.onDidReceiveMessage((a)=>{this.output.info(`Received message from webview: ${JSON.stringify(a)}`),o?.fromClient(a)},null,this.disposables)',
    'e.webview.onDidReceiveMessage((a)=>{this.output.info(`Received message from webview: ${JSON.stringify(a)}`),this.handleCodexProviderUsageMessage(a,e.webview)||o?.fromClient(a)},null,this.disposables)',
    2,
    "sidebar provider bridges",
  );
  source = replaceExact(
    source,
    'e.webview.onDidReceiveMessage((u)=>{this.output.info(`Received message from webview: ${JSON.stringify(u)}`),a?.fromClient(u)},null,this.disposables)',
    'e.webview.onDidReceiveMessage((u)=>{this.output.info(`Received message from webview: ${JSON.stringify(u)}`),this.handleCodexProviderUsageMessage(u,e.webview)||a?.fromClient(u)},null,this.disposables)',
    1,
    "editor provider bridge",
  );

  const progressHandler =
    'handleCodexProgressMessage(e,t){if(e?.type==="codex.progress.openFile"){let r=e.filePath;if(typeof r==="string"&&r.length>0&&r.length<=32768)Promise.resolve(t.openFile(r)).catch((n)=>this.output.error(`Failed to open Codex progress file: ${n}`));return!0}if(e?.type!=="codex.progress.openChanges")return!1;let r=e.fileDiffs;if(!r||typeof r!=="object"||Array.isArray(r))return!0;let n={},i=0;for(let[o,s]of Object.entries(r).slice(0,200)){if(typeof o!=="string"||o.length===0||o.length>32768||!s||typeof s!=="object")continue;let a=s.oldContent,c=s.newContent;if(a!==null&&typeof a!=="string"||c!==null&&typeof c!=="string")continue;if(i+=(a?.length??0)+(c?.length??0),i>2e7)break;n[o]={oldContent:a,newContent:c}}if(Object.keys(n).length>0)Promise.resolve(t.openFileDiffs({diffs:n,title:"Review changes"})).catch((o)=>this.output.error(`Failed to open Codex progress changes: ${o}`));return!0}';
  source = replaceExact(
    source,
    "}resolveWebviewView(e,t,r){",
    `}${progressHandler}resolveWebviewView(e,t,r){`,
    1,
    "progress host handler",
  );
  source = replaceExact(
    source,
    "this.handleCodexProviderUsageMessage(a,e.webview)||o?.fromClient(a)",
    "this.handleCodexProviderUsageMessage(a,e.webview)||this.handleCodexProgressMessage(a,o)||o?.fromClient(a)",
    2,
    "sidebar progress bridges",
  );
  source = replaceExact(
    source,
    "this.handleCodexProviderUsageMessage(u,e.webview)||a?.fromClient(u)",
    "this.handleCodexProviderUsageMessage(u,e.webview)||this.handleCodexProgressMessage(u,a)||a?.fromClient(u)",
    1,
    "editor progress bridge",
  );

  source = replaceExact(
    source,
    '          window.IS_SESSION_LIST_ONLY = ${o?"true":"false"}\n        </script>',
    [
      '          window.IS_SESSION_LIST_ONLY = ${o?"true":"false"}',
      "          const codexNativeAcquireVsCodeApi = window.acquireVsCodeApi",
      "          window.acquireVsCodeApi = () => window.__claudeCodexVsCodeApi || (window.__claudeCodexVsCodeApi = codexNativeAcquireVsCodeApi())",
      "          window.MonacoEnvironment = { ...(window.MonacoEnvironment || {}), globalAPI: true }",
      "          window.__claudeCodexProgressState = { busy: false, todos: [], sessionDiffs: null }",
      "          window.__claudeCodexProgressUpdate = (update) => {",
      '            if (!update || typeof update !== "object") return',
      "            Object.assign(window.__claudeCodexProgressState, update)",
      '            window.dispatchEvent(new CustomEvent("claude-codex-progress-state", { detail: update }))',
      "          }",
      "        </script>",
    ].join("\n"),
    1,
    "shared webview bootstrap",
  );
  source = replaceExact(
    source,
    '        <script nonce="${u}" src="${a}" type="module"></script>\n      </body>',
    [
      '        <script nonce="${u}" src="${a}" type="module"></script>',
      `        <script nonce="\${u}" src="\${e.asWebviewUri(${providerVscodeBinding}.Uri.joinPath(this.extensionUri,"webview","codex-message-rail.js"))}" type="module"></script>`,
      `        <script nonce="\${u}" src="\${e.asWebviewUri(${providerVscodeBinding}.Uri.joinPath(this.extensionUri,"webview","codex-progress-runtime.js"))}" type="module"></script>`,
      `        <script nonce="\${u}" src="\${e.asWebviewUri(${providerVscodeBinding}.Uri.joinPath(this.extensionUri,"webview","codex-markdown-runtime.js"))}" type="module"></script>`,
      "      </body>",
    ].join("\n"),
    1,
    "custom runtime scripts",
  );
  const commandAnchor =
    'e.subscriptions.push(De.commands.registerCommand("claude-vscode.newConversation",async()=>{l.notifyCreateNewConversation()}))';
  source = replaceExact(
    source,
    commandAnchor,
    `${commandAnchor},e.subscriptions.push(De.commands.registerCommand("claude-vscode.toggleRightEditorGroup",async()=>{if(De.window.tabGroups.all.length<2)return;await De.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup")}))`,
    1,
    "right editor group command",
  );
  write("extension.js", source);
}

function patchWebviewBundle() {
  let source = read("webview/index.js");
  const copySnippet = fs
    .readFileSync(path.join(patchRoot, "snippets/copy-markdown.js.txt"), "utf8")
    .trim();
  source = replacePattern(
    source,
    /}return null}(?=var [A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\(function\(\{session:t,message:i,index:n,context:o,isHighlighted:r=!1,areThinkingBlocksExpanded:s,setAreThinkingBlocksExpanded:a,status:l\}\))/,
    `}return null}${copySnippet}`,
    1,
    "copy Markdown component",
  );
  source = replacePattern(
    source,
    /(i\.uuid&&u&&!i\.isSynthetic&&l!=="progress"&&b\([A-Za-z_$][\w$]*,\{session:t,messageUuid:i\.uuid,surface:"assistant_text",openURL:o\.openURL\},i\.uuid\))\]/,
    '$1,i.uuid&&u&&!i.isSynthetic&&l!=="progress"&&b(CodexCopyMarkdownButton,{content:i.content},"copy-"+i.uuid)]',
    1,
    "assistant copy button",
  );
  source = replacePattern(
    source,
    /return ([A-Za-z_$][\w$]*)\("div",\{className:`\$\{([A-Za-z_$][\w$]*)\.message\} \$\{_\} \$\{v\?\2\.stickyHeader:""\} \$\{C\} \$\{r\?\2\.highlightedMessage:""\}`,ref:d,children:\[/,
    (match) => match.replace('{className:', '{"data-testid":"user-message",className:'),
    1,
    "user message marker",
  );
  source = replacePattern(
    source,
    /(\),[A-Za-z_$][\w$]*&&b\("div",\{className:([A-Za-z_$][\w$]*)\.userMessageContainer,children:b\("div",\{className:\2\.userMessage,children:b\("div",\{className:\2\.userMessageAttachments,children:[A-Za-z_$][\w$]*\}\)\}\)\}\))\]\},n\)\}\);function/,
    '$1,p.trim()&&b(CodexCopyMarkdownButton,{markdown:p,label:"question"},"copy-user-"+(i.uuid||n))]},n)});function',
    1,
    "user copy button",
  );
  source = replacePattern(
    source,
    /plainText:!0/,
    "plainText:!1",
    1,
    "native user Markdown",
  );

  source = replaceExact(
    source,
    "this.todos.value=n.todos",
    "this.todos.value=n.todos,window.__claudeCodexProgressUpdate?.({todos:n.todos})",
    1,
    "todo update",
  );
  source = replaceExact(
    source,
    "this.todos.value=[]",
    "this.todos.value=[],window.__claudeCodexProgressUpdate?.({todos:[]})",
    1,
    "todo reset",
  );
  source = replaceExact(
    source,
    "this.lastModifiedTime.value=Date.now(),this.busy.value=!0,this.promptSuggestion.value=null",
    "this.lastModifiedTime.value=Date.now(),this.busy.value=!0,window.__claudeCodexProgressUpdate?.({busy:!0,todos:[]}),this.promptSuggestion.value=null",
    1,
    "turn start",
  );
  source = replaceExact(
    source,
    'if(e.subtype==="init")this.busy.value=!0}else if(e.type==="result")this.busy.value=!1',
    'if(e.subtype==="init")this.busy.value=!0,window.__claudeCodexProgressUpdate?.({busy:!0})}else if(e.type==="result")this.busy.value=!1,window.__claudeCodexProgressUpdate?.({busy:!1})',
    1,
    "stream busy state",
  );
  source = replaceExact(
    source,
    "this.claudeChannelId=void 0,this.busy.value=!1,this.promptSuggestion.value=null",
    "this.claudeChannelId=void 0,this.busy.value=!1,window.__claudeCodexProgressUpdate?.({busy:!1}),this.promptSuggestion.value=null",
    1,
    "restart busy reset",
  );
  source = replaceExact(
    source,
    "message_count:this.messages.value.length}),this.busy.value=!1;if(",
    "message_count:this.messages.value.length}),this.busy.value=!1,window.__claudeCodexProgressUpdate?.({busy:!1});if(",
    1,
    "stream-finally busy reset",
  );
  source = replaceExact(
    source,
    "updateSessionDiffs(e){this.sessionDiffs.value=e}",
    "updateSessionDiffs(e){this.sessionDiffs.value=e,window.__claudeCodexProgressUpdate?.({sessionDiffs:e})}",
    1,
    "session diff update",
  );
  source = replaceExact(
    source,
    "this.sessionDiffs.value={diffs:{...n,[e]:{oldContent:o?.oldContent!==void 0?o?.oldContent:t,newContent:i}}}",
    "this.updateSessionDiffs({diffs:{...n,[e]:{oldContent:o?.oldContent!==void 0?o?.oldContent:t,newContent:i}}})",
    1,
    "live file diff update",
  );
  write("webview/index.js", source);
}

function appendCssOverlay() {
  const marker = "/* Codex-like responsive conversation layout";
  const overlay = fs.readFileSync(path.join(patchRoot, "overlay.css"), "utf8").trim();
  let source = read("webview/index.css");
  if (source.includes(marker)) throw new Error("CSS overlay is already present");
  if (!overlay.startsWith(marker)) throw new Error("CSS overlay marker is missing");
  source = `${source.trimEnd()}\n\n${overlay}\n`;
  write("webview/index.css", source);
}

copyTree(path.join(patchRoot, "files"), extensionRoot);
patchPackageJson();
patchExtensionBundle();
patchWebviewBundle();
appendCssOverlay();
process.stdout.write(`Patched ${extensionRoot}\n`);
