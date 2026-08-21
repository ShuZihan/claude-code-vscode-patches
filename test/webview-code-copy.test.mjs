import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

class FakeClassList {
  constructor(names = []) {
    this.names = new Set(names);
  }

  [Symbol.iterator]() {
    return this.names[Symbol.iterator]();
  }

  add(...names) {
    for (const name of names) this.names.add(name);
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
  }

  contains(name) {
    return this.names.has(name);
  }
}

class FakeElement {}

class FakeCodeElement extends FakeElement {
  constructor(source) {
    super();
    this.parentElement = { tagName: "PRE" };
    this.dataset = {};
    this.classList = new FakeClassList(["language-javascript"]);
    this.childNodes = [];
    this.source = source;
    this.renderedParts = null;
  }

  get textContent() {
    if (!this.renderedParts) return this.source;
    return this.renderedParts
      .map((part) => (part.kind === "text" ? part.value : ""))
      .join("");
  }

  set textContent(value) {
    this.source = value;
    this.renderedParts = null;
  }

  querySelector() {
    return this.renderedParts ? {} : null;
  }

  querySelectorAll(selector) {
    if (selector !== "br" || !this.renderedParts) return [];
    return this.renderedParts.filter((part) => part.kind === "br");
  }
}

function loadCodeEnhancer() {
  let source = readFileSync(
    new URL(
      "../patches/files/webview/codex-markdown-runtime.js",
      import.meta.url,
    ),
    "utf8",
  );
  const bootstrapStart = source.indexOf(
    '  document.addEventListener(\n    "input"',
  );
  assert.notEqual(bootstrapStart, -1, "runtime bootstrap anchor changed");
  source = `${source.slice(0, bootstrapStart)}  window.__codeCopyTest = { enhanceCodeBlock };\n})();\n`;

  const document = {
    documentElement: { classList: new FakeClassList(["vscode-dark"]) },
    createTextNode: (nodeValue) => ({ nodeValue }),
  };
  const window = {
    __claudeCodexProviderUsageCwd: "",
    location: { href: "vscode-webview://test/" },
    monaco: {
      editor: {
        async colorizeElement(code) {
          code.renderedParts = [];
          for (const line of code.source.split("\n")) {
            code.renderedParts.push({ kind: "text", value: line });
            code.renderedParts.push({
              kind: "br",
              remove() {
                this.kind = "removed";
              },
              replaceWith(node) {
                this.kind = "text";
                this.value = node.nodeValue;
              },
            });
          }
        },
      },
    },
  };
  vm.runInNewContext(source, {
    console,
    document,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLTableElement: FakeElement,
    HTMLTableCellElement: FakeElement,
    Intl,
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4 },
    Object,
    URL,
    window,
  });
  return window.__codeCopyTest.enhanceCodeBlock;
}

test("Monaco-enhanced code blocks retain source newlines for copy", async () => {
  const enhanceCodeBlock = loadCodeEnhancer();
  for (const source of ["a\nb", "a\nb\n", "a\n\nb"]) {
    const code = new FakeCodeElement(source);
    const pre = {
      get textContent() {
        return code.textContent;
      },
    };

    await enhanceCodeBlock(code);

    assert.equal(pre.textContent, source);
    assert.equal(code.dataset.codexHighlightedSource, source);
  }
});
