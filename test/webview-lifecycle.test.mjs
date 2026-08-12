import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("dispose callbacks never read WebviewView.webview after VS Code disposes it", () => {
  const patcher = fs.readFileSync(
    path.join(repositoryRoot, "scripts/apply-patches.mjs"),
    "utf8",
  );

  assert.doesNotMatch(
    patcher,
    /onDidDispose\(\(\)=>\{this\.providerUsage\.untrackClient\(e\.webview\)/,
    "VS Code invalidates the webview getter before onDidDispose listeners run",
  );
  assert.match(
    patcher,
    /let codexWebview=e\.webview;e\.onDidDispose\(\(\)=>\{this\.providerUsage\.untrackClient\(codexWebview\)/,
    "the live webview must be captured while the view still exists",
  );
});
