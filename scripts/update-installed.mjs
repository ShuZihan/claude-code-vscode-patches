import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const repository = String(
  args.get("repo") || "ShuZihan/claude-code-vscode-patches",
);
const codeCli = String(
  args.get("code-cli") ||
    (process.platform === "darwin"
      ? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
      : "code"),
);
const dryRun = args.get("dry-run") === true;

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

const release = JSON.parse(
  run("gh", ["release", "view", "--repo", repository, "--json", "tagName,assets"]),
);
const asset = release.assets?.find((candidate) =>
  /^claude-code-vscode-custom-[0-9]+\.[0-9]+\.[0-9]+\.vsix$/.test(
    candidate.name,
  ),
);
if (!asset) throw new Error(`release ${release.tagName} has no custom VSIX asset`);
const latestVersion = asset.name.match(
  /^claude-code-vscode-custom-([0-9]+\.[0-9]+\.[0-9]+)\.vsix$/,
)?.[1];
if (!latestVersion) throw new Error(`cannot parse version from ${asset.name}`);

const installedLine = run(codeCli, ["--list-extensions", "--show-versions"])
  .split(/\r?\n/)
  .find((line) => line.toLowerCase().startsWith("anthropic.claude-code@"));
const installedVersion = installedLine?.split("@").at(-1) || null;
if (installedVersion === latestVersion) {
  process.stdout.write(`Claude Code ${latestVersion} is already installed.\n`);
  process.exit(0);
}
if (dryRun) {
  process.stdout.write(
    `Would install ${asset.name} over ${installedVersion || "no installed version"}.\n`,
  );
  process.exit(0);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-update-"));
try {
  run("gh", [
    "release",
    "download",
    release.tagName,
    "--repo",
    repository,
    "--pattern",
    asset.name,
    "--dir",
    temporaryRoot,
  ]);
  const vsixPath = path.join(temporaryRoot, asset.name);
  execFileSync(codeCli, ["--install-extension", vsixPath, "--force"], {
    stdio: "inherit",
  });
  process.stdout.write(
    `Installed Claude Code ${latestVersion} from ${repository} Release ${release.tagName}.\n`,
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
