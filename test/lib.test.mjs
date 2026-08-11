import test from "node:test";
import assert from "node:assert/strict";
import {
  compareNumericVersions,
  replaceExact,
  selectMarketplaceVersion,
  shouldQuery,
} from "../scripts/lib.mjs";

test("compareNumericVersions orders extension versions without downgrades", () => {
  assert.equal(compareNumericVersions("2.1.226", "2.1.227"), -1);
  assert.equal(compareNumericVersions("2.1.227", "2.1.227"), 0);
  assert.equal(compareNumericVersions("2.2.0", "2.1.999"), 1);
  assert.throws(() => compareNumericVersions("2.1", "2.1.227"), /invalid/);
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
