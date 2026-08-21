import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertCustomVersion,
  buildAssetName,
  buildReleaseVersion,
  buildCopyMarkdownSnippet,
  compareNumericVersions,
  parseReleaseAssetName,
  replaceExact,
  selectMarketplaceVersion,
  shouldQuery,
} from "../scripts/lib.mjs";

test("provider usage bridge resolves and tracks the active chat cwd", () => {
  const patcherSource = readFileSync(
    new URL("../scripts/apply-patches.mjs", import.meta.url),
    "utf8",
  );

  assert.equal(patcherSource.includes("getRuntimeEnvironment:()=>\\$p()"), false);
  assert.equal(patcherSource.includes("getWorkspaceRoots:"), false);
  assert.match(patcherSource, /codexCreateProviderUsageModule\(\)/);
  assert.match(patcherSource, /this\.providerUsage\.trackClient\(t,\{cwd:/);
  assert.match(
    patcherSource,
    /let codexWebview=e\.webview;e\.onDidDispose\(\(\)=>\{this\.providerUsage\.untrackClient\(codexWebview\)/,
  );
  assert.match(
    patcherSource,
    /ClaudeCodexProviderUsage\?\.setCwd\(e\.cwd\.value\)/,
  );
});

test("right editor command discovers its own VS Code binding", () => {
  const patcherSource = readFileSync(
    new URL("../scripts/apply-patches.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    patcherSource,
    /const commandPattern =\s*\/e\\\.subscriptions/,
  );
  assert.match(patcherSource, /const commandVscodeBinding = commandMatches\[0\]\[1\]/);
});

test("copy Markdown success state does not depend on a minified vendor icon", () => {
  const copySnippet = buildCopyMarkdownSnippet(
    readFileSync(
      new URL("../patches/snippets/copy-markdown.js.txt", import.meta.url),
      "utf8",
    ),
  );

  assert.match(copySnippet, /function CodexCopySuccessIcon\(/);
  assert.match(
    copySnippet,
    /children:n\?b\(CodexCopySuccessIcon,\{className:"codexCopyMarkdownIcon"\}\)/,
  );
  assert.equal(copySnippet.includes("b(tb,"), false);
});

test("compareNumericVersions orders extension versions without downgrades", () => {
  assert.equal(compareNumericVersions("2.1.226", "2.1.227"), -1);
  assert.equal(compareNumericVersions("2.1.227", "2.1.227"), 0);
  assert.equal(compareNumericVersions("2.2.0", "2.1.999"), 1);
  assert.throws(() => compareNumericVersions("2.1", "2.1.227"), /invalid/);
});

test("custom versions produce stable release and platform asset identities", () => {
  assert.equal(assertCustomVersion("0.1.0"), "0.1.0");
  assert.equal(
    buildReleaseVersion("2.1.238", "0.1.0"),
    "2.1.238-custom.0.1.0",
  );
  assert.equal(
    buildAssetName("2.1.238", "0.1.0", "darwin-arm64"),
    "claude-code-vscode-2.1.238-custom.0.1.0-darwin-arm64.vsix",
  );
  assert.throws(() => assertCustomVersion("01.0.0"), /invalid custom version/);
  assert.throws(
    () => buildAssetName("2.1.238", "0.1.0", "Darwin ARM64"),
    /invalid target platform/,
  );
  assert.deepEqual(
    parseReleaseAssetName(
      "claude-code-vscode-2.1.238-custom.0.1.0-darwin-arm64.vsix",
      "darwin-arm64",
    ),
    {
      baseVersion: "2.1.238",
      customVersion: "0.1.0",
      targetPlatform: "darwin-arm64",
      legacy: false,
    },
  );
  assert.deepEqual(
    parseReleaseAssetName(
      "claude-code-vscode-custom-2.1.231.vsix",
      "darwin-arm64",
    ),
    {
      baseVersion: "2.1.231",
      customVersion: null,
      targetPlatform: "darwin-arm64",
      legacy: true,
    },
  );
  assert.equal(
    parseReleaseAssetName(
      "claude-code-vscode-2.1.238-custom.0.1.0-win32-x64.vsix",
      "darwin-arm64",
    ),
    null,
  );
});

test("replaceExact refuses missing and ambiguous patch anchors", () => {
  assert.equal(replaceExact("a-b", "-", "+", 1, "separator"), "a+b");
  assert.throws(() => replaceExact("abc", "x", "y", 1, "missing"), /found 0/);
  assert.throws(() => replaceExact("x-x", "x", "y", 1, "ambiguous"), /found 2/);
});

test("shouldQuery enforces a real elapsed-time interval", () => {
  const now = Date.parse("2026-08-11T00:00:00.000Z");
  const intervalMs = 48 * 60 * 60 * 1000;
  assert.equal(
    shouldQuery({
      lastCheckedAt: "2026-08-10T00:00:00.000Z",
      now,
      intervalMs,
    }),
    false,
  );
  assert.equal(
    shouldQuery({
      lastCheckedAt: "2026-08-09T00:00:00.000Z",
      now,
      intervalMs,
    }),
    true,
  );
  assert.equal(
    shouldQuery({ lastCheckedAt: "", now, intervalMs, force: true }),
    true,
  );
});

test("selectMarketplaceVersion chooses the requested platform", () => {
  const payload = {
    results: [
      {
        extensions: [
          {
            publisher: { publisherName: "anthropic" },
            extensionName: "claude-code",
            versions: [
              {
                version: "2.1.227",
                targetPlatform: "linux-x64",
                fallbackAssetUri: "https://example.invalid/linux",
              },
              {
                version: "2.1.227",
                targetPlatform: "darwin-arm64",
                fallbackAssetUri: "https://example.invalid/mac",
              },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(selectMarketplaceVersion(payload, "darwin-arm64"), {
    extensionId: "anthropic.claude-code",
    version: "2.1.227",
    targetPlatform: "darwin-arm64",
    lastUpdated: null,
    downloadUrl:
      "https://example.invalid/mac/Microsoft.VisualStudio.Services.VSIXPackage",
  });
});
