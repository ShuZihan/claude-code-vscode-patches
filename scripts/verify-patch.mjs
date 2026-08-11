import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const patchManifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "patches/manifest.json"), "utf8"),
);
const args = parseArgs(process.argv.slice(2));
const extensionRoot = path.resolve(String(args.get("extension-root") || ""));
const expectedVersion = args.get("version");
if (!args.get("extension-root") || !fs.existsSync(extensionRoot)) {
  throw new Error("--extension-root must point to a patched extension directory");
}

const requiredFiles = [
  "extension.js",
  "package.json",
  "codex-file-open-policy.cjs",
  "codex-provider-usage.js",
  "webview/index.js",
  "webview/index.css",
  "webview/codex-markdown-runtime.js",
  "webview/codex-message-rail.js",
  "webview/codex-progress-runtime.js",
];
for (const relativePath of requiredFiles) {
  if (!fs.statSync(path.join(extensionRoot, relativePath), {
    throwIfNoEntry: false,
  })?.isFile()) {
    throw new Error(`required patched file is missing: ${relativePath}`);
  }
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
);
if (
  `${packageJson.publisher}.${packageJson.name}`.toLowerCase() !==
  "anthropic.claude-code"
) {
  throw new Error("patched package has an unexpected extension identifier");
}
if (expectedVersion && packageJson.version !== expectedVersion) {
  throw new Error(
    `expected extension ${expectedVersion}, found ${packageJson.version}`,
  );
}
if (
  packageJson.displayName !== "Claude Code for VS Code (Custom)" ||
  packageJson.claudeCodeCustomBuild?.unofficial !== true ||
  packageJson.claudeCodeCustomBuild?.baseVersion !== packageJson.version ||
  packageJson.claudeCodeCustomBuild?.revision !== patchManifest.customRevision
) {
  throw new Error("custom build identity is missing or inconsistent");
}
const command = packageJson.contributes?.commands?.filter(
  (item) => item.command === "claude-vscode.toggleRightEditorGroup",
);
if (command?.length !== 1) {
  throw new Error("right editor group command contribution is missing or duplicated");
}

const markerChecks = [
  ["extension.js", "CodexFileOpenPolicy.installOpenFile"],
  ["extension.js", "codexCreateProviderUsageModule"],
  ["extension.js", "handleCodexProgressMessage"],
  ["extension.js", "codex-message-rail.js"],
  ["webview/index.js", "CodexCopyMarkdownButton"],
  ["webview/index.js", '"data-testid":"user-message"'],
  ["webview/index.js", "__claudeCodexProgressUpdate"],
  ["webview/index.css", "--claude-codex-content-width"],
  ["webview/index.css", ".codexProviderUsageControl"],
  ["webview/index.css", ".codexProgressStatusShell"],
];
for (const [relativePath, marker] of markerChecks) {
  const source = fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");
  if (!source.includes(marker)) {
    throw new Error(`${relativePath}: required marker missing: ${marker}`);
  }
}

for (const relativePath of [
  "extension.js",
  "codex-file-open-policy.cjs",
  "codex-provider-usage.js",
  "webview/index.js",
  "webview/codex-markdown-runtime.js",
  "webview/codex-message-rail.js",
  "webview/codex-progress-runtime.js",
]) {
  execFileSync(process.execPath, ["--check", path.join(extensionRoot, relativePath)], {
    stdio: "pipe",
  });
}

const patchSources = requiredFiles
  .filter((relativePath) => /codex|index\.(?:js|css)$/.test(relativePath))
  .map((relativePath) => fs.readFileSync(path.join(extensionRoot, relativePath), "utf8"))
  .join("\n");
if (/\b(?:sk-ant-|sk-[a-zA-Z0-9]{20,})/.test(patchSources)) {
  throw new Error("a value resembling an API key was found in patched sources");
}

process.stdout.write(
  `${JSON.stringify(
    {
      extensionId: `${packageJson.publisher}.${packageJson.name}`.toLowerCase(),
      version: packageJson.version,
      verifiedFiles: requiredFiles.length,
    },
    null,
    2,
  )}\n`,
);
