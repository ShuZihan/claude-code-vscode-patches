import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const overlay = fs.readFileSync(
  path.join(repositoryRoot, "patches/overlay.css"),
  "utf8",
);

test("copy controls use compact Codex-scale boxes and icons", () => {
  assert.match(
    overlay,
    /\.codexCopyMarkdownButton\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s,
  );
  assert.match(
    overlay,
    /\.codexCopyMarkdownButton\s*>\s*svg\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/s,
  );
  assert.match(
    overlay,
    /\.copyButton_CEmTFw\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*padding:\s*2px;/s,
  );
  assert.match(
    overlay,
    /\.copyIcon_CEmTFw\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s,
  );
});

test("table copy action stays compact and ghost-styled", () => {
  assert.match(
    overlay,
    /\.codexTableCopyButton\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/s,
  );
  assert.match(
    overlay,
    /\.codexTableCopyButton svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s,
  );
});

test("assistant answer actions reveal Copy and Fork as one compact row", () => {
  assert.match(
    overlay,
    /\.codexAnswerActions\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*20px;[^}]*gap:\s*2px;/s,
  );
  assert.match(
    overlay,
    /\[data-testid="assistant-message"\]:is\(:hover, :focus-within\)\s*>\s*\.codexAnswerActions \.codexCopyMarkdownButton/s,
  );
});
