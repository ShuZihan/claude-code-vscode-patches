import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  compareNumericVersions,
  parseArgs,
  parseReleaseAssetName,
} from "./lib.mjs";

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
const targetPlatform = String(
  args.get("target-platform") ||
    (process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin" && process.arch === "x64"
        ? "darwin-x64"
        : process.platform === "win32" && process.arch === "x64"
          ? "win32-x64"
          : ""),
);
if (!targetPlatform) {
  throw new Error(`unsupported updater platform: ${process.platform}-${process.arch}`);
}
const stateFile = path.resolve(
  String(
    args.get("state-file") ||
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "ClaudeCodeVSCodePatches",
        "state.json",
      ),
  ),
);
const codeEnvironment = { ...process.env };
delete codeEnvironment.ELECTRON_RUN_AS_NODE;

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
const parsedAssets = (release.assets || [])
  .map((candidate) => ({
    candidate,
    identity: parseReleaseAssetName(candidate.name, targetPlatform),
  }))
  .filter(({ identity }) => identity);
const selectedAsset =
  parsedAssets.find(({ identity }) => !identity.legacy) || parsedAssets[0];
const asset = selectedAsset?.candidate;
if (!asset) throw new Error(`release ${release.tagName} has no custom VSIX asset`);
const latestVersion = selectedAsset.identity.baseVersion;

const installedLine = run(
  codeCli,
  ["--list-extensions", "--show-versions"],
  { env: codeEnvironment },
)
  .split(/\r?\n/)
  .find((line) => line.toLowerCase().startsWith("anthropic.claude-code@"));
const installedVersion = installedLine?.split("@").at(-1) || null;
let installedState = null;
try {
  installedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const stateMatches =
  installedState?.tagName === release.tagName &&
  installedState?.assetName === asset.name &&
  installedState?.assetDigest === (asset.digest || null);
if (installedVersion === latestVersion && stateMatches) {
  process.stdout.write(
    `Claude Code ${latestVersion} from ${release.tagName} is already installed.\n`,
  );
  process.exit(0);
}
if (
  installedVersion &&
  compareNumericVersions(installedVersion, latestVersion) > 0
) {
  process.stdout.write(
    `Skipping ${latestVersion}; installed Claude Code ${installedVersion} is newer.\n`,
  );
  process.exit(0);
}
if (dryRun) {
  process.stdout.write(
    `Would install ${asset.name} from ${release.tagName} over ${installedVersion || "no installed version"}.\n`,
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
  if (asset.digest?.startsWith("sha256:")) {
    const actualDigest = `sha256:${createHash("sha256")
      .update(fs.readFileSync(vsixPath))
      .digest("hex")}`;
    if (actualDigest !== asset.digest) {
      throw new Error(
        `release asset digest mismatch: expected ${asset.digest}, received ${actualDigest}`,
      );
    }
  }
  execFileSync(codeCli, ["--install-extension", vsixPath, "--force"], {
    stdio: "inherit",
    env: codeEnvironment,
  });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporaryState = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryState,
    `${JSON.stringify(
      {
        tagName: release.tagName,
        assetName: asset.name,
        assetDigest: asset.digest || null,
        version: latestVersion,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  fs.renameSync(temporaryState, stateFile);
  process.stdout.write(
    `Installed Claude Code ${latestVersion} from ${repository} Release ${release.tagName}.\n`,
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
