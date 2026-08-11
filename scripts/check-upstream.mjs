import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  selectMarketplaceVersion,
  shouldQuery,
} from "./lib.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "patches/manifest.json"), "utf8"),
);
const args = parseArgs(process.argv.slice(2));
const stateDirectory = path.resolve(
  String(args.get("state-dir") || path.join(repositoryRoot, ".upstream-check-state")),
);
const statePath = path.join(stateDirectory, "state.json");
const outputPath = process.env.GITHUB_OUTPUT || args.get("output");
const force = args.get("force") === true;
const intervalMs = manifest.checkIntervalHours * 60 * 60 * 1000;

let state = {};
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function emit(name, value) {
  const line = `${name}=${String(value)}\n`;
  if (outputPath) fs.appendFileSync(outputPath, line);
  process.stdout.write(line);
}

if (
  !shouldQuery({
    lastCheckedAt: state.lastCheckedAt,
    intervalMs,
    force,
  })
) {
  emit("due", "false");
  emit("last_checked_at", state.lastCheckedAt);
  process.exit(0);
}

const response = await fetch(
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
  {
    method: "POST",
    headers: {
      Accept: "application/json;api-version=3.0-preview.1",
      "Content-Type": "application/json",
      "User-Agent": "VSCode",
      "X-Market-Client-Id": "VSCode",
    },
    body: JSON.stringify({
      filters: [
        {
          criteria: [{ filterType: 7, value: manifest.extensionId }],
          pageNumber: 1,
          pageSize: 1,
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      assetTypes: [],
      flags: 914,
    }),
  },
);
if (!response.ok) {
  throw new Error(`Marketplace query failed: HTTP ${response.status}`);
}
const marketplacePayload = await response.json();
const selectedPlatforms = manifest.targetPlatforms.map((targetPlatform) =>
  selectMarketplaceVersion(marketplacePayload, targetPlatform),
);
for (const selected of selectedPlatforms) {
  if (selected.extensionId.toLowerCase() !== manifest.extensionId.toLowerCase()) {
    throw new Error(
      `Marketplace returned unexpected extension ${selected.extensionId}`,
    );
  }
}
const selectedVersions = new Set(
  selectedPlatforms.map((selected) => selected.version),
);
if (selectedVersions.size !== 1) {
  throw new Error(
    `Marketplace platform versions differ: ${selectedPlatforms
      .map((selected) => `${selected.targetPlatform}=${selected.version}`)
      .join(", ")}`,
  );
}
const selectedVersion = selectedPlatforms[0].version;

const checkedAt = new Date().toISOString();
fs.mkdirSync(stateDirectory, { recursive: true });
fs.writeFileSync(
  statePath,
  `${JSON.stringify(
    {
      lastCheckedAt: checkedAt,
      latestVersion: selectedVersion,
      targetPlatforms: selectedPlatforms.map(
        (selected) => selected.targetPlatform,
      ),
    },
    null,
    2,
  )}\n`,
);

emit("due", "true");
emit("version", selectedVersion);
emit("custom_revision", manifest.customRevision);
for (const selected of selectedPlatforms) {
  emit(
    `download_url_${selected.targetPlatform.replaceAll("-", "_")}`,
    selected.downloadUrl,
  );
}
emit("last_checked_at", checkedAt);
