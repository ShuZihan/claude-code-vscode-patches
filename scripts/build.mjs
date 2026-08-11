import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = parseArgs(process.argv.slice(2));
const expectedVersion = args.get("version");
const sourceVsix = args.get("vsix");
const downloadUrl = args.get("download-url");
if (!sourceVsix && !downloadUrl) {
  throw new Error("provide either --vsix PATH or --download-url URL");
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-patches-"));
const archivePath = sourceVsix
  ? path.resolve(String(sourceVsix))
  : path.join(temporaryRoot, "official.vsix");
const extractedRoot = path.join(temporaryRoot, "expanded");

async function download(url, destination) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "VSCode" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`VSIX download failed: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination, { flags: "wx" }),
  );
}

try {
  if (downloadUrl) await download(String(downloadUrl), archivePath);
  if (!fs.statSync(archivePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`VSIX does not exist: ${archivePath}`);
  }
  fs.mkdirSync(extractedRoot);
  execFileSync("unzip", ["-q", archivePath, "-d", extractedRoot], {
    stdio: "inherit",
  });
  const extensionRoot = path.join(extractedRoot, "extension");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
  );
  if (
    `${packageJson.publisher}.${packageJson.name}`.toLowerCase() !==
    "anthropic.claude-code"
  ) {
    throw new Error("downloaded VSIX is not anthropic.claude-code");
  }
  if (expectedVersion && packageJson.version !== expectedVersion) {
    throw new Error(
      `downloaded VSIX is ${packageJson.version}, expected ${expectedVersion}`,
    );
  }

  execFileSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/apply-patches.mjs"),
      "--extension-root",
      extensionRoot,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/verify-patch.mjs"),
      "--extension-root",
      extensionRoot,
      "--version",
      packageJson.version,
    ],
    { stdio: "inherit" },
  );

  const outputDirectory = path.resolve(
    String(args.get("output-dir") || path.join(repositoryRoot, "dist")),
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `claude-code-vscode-custom-${packageJson.version}.vsix`,
  );
  fs.rmSync(outputPath, { force: true });
  execFileSync("zip", ["-qry", outputPath, "."], {
    cwd: extractedRoot,
    stdio: "inherit",
  });
  execFileSync("unzip", ["-tq", outputPath], { stdio: "inherit" });

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(
      githubOutput,
      `asset_path=${outputPath}\nversion=${packageJson.version}\n`,
    );
  }
  process.stdout.write(`Built ${outputPath}\n`);
} finally {
  if (args.get("keep-temp") === true) {
    process.stdout.write(`Kept temporary build at ${temporaryRoot}\n`);
  } else {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
