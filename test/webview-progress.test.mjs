import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

class FakeStyle {
  constructor() {
    this.values = new Map();
  }

  setProperty(name, value) {
    this.values.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.values.get(name) ?? "";
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.parentElement = null;
    this.classList = {
      add: (...names) => {
        this.className = [
          ...new Set(`${this.className} ${names.join(" ")}`.trim().split(/\s+/)),
        ].join(" ");
      },
    };
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  insertBefore(child, before) {
    child.parentElement = this;
    const index = this.children.indexOf(before);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  querySelector(selector) {
    if (selector.includes(".codexProgressStatusHost")) {
      return this.children.find((child) => hasClass(child, "codexProgressStatusHost")) ?? null;
    }
    if (selector.includes(".promptInputContainer_07S1Yg")) {
      return this.children.find((child) => hasClass(child, "promptInputContainer_07S1Yg")) ?? null;
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }
}

function hasClass(element, className) {
  return element.className.split(/\s+/).includes(className);
}

function findByClass(root, className) {
  if (hasClass(root, className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function findAllByClass(root, className, result = []) {
  if (hasClass(root, className)) result.push(root);
  for (const child of root.children) findAllByClass(child, className, result);
  return result;
}

function createProgressHarness(initialState) {
  const windowListeners = new Map();
  const animationFrames = [];
  const messages = [];
  const document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    querySelector(selector) {
      if (selector === ".inputContainer_07S1Yg") return document.inputContainer;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    documentElement: new FakeElement("html"),
  };
  document.inputContainer = new FakeElement("div");
  document.inputContainer.className = "inputContainer_07S1Yg";
  document.prompt = new FakeElement("div");
  document.prompt.className = "promptInputContainer_07S1Yg";
  document.inputContainer.append(document.prompt);

  const window = {
    IS_SESSION_LIST_ONLY: false,
    __claudeCodexProgressState: initialState,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
  };
  const context = {
    console,
    document,
    window,
    Element: FakeElement,
    HTMLElement: FakeElement,
    MutationObserver: class {
      observe() {}
    },
    performance: { now: () => 0 },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    cancelAnimationFrame() {},
    Int32Array,
    Map,
    Set,
  };

  function flush() {
    while (animationFrames.length > 0) animationFrames.shift()(0);
  }

  function update(detail) {
    Object.assign(initialState, detail);
    windowListeners.get("claude-codex-progress-state")?.({ detail });
    flush();
  }

  return { context, document, flush, messages, update };
}

const runtimeSource = readFileSync(
  new URL("../patches/files/webview/codex-progress-runtime.js", import.meta.url),
  "utf8",
);

test("plan icons expose Codex-style completed, spinning, and pending states", () => {
  const harness = createProgressHarness({
    busy: true,
    todos: [
      { content: "done", status: "completed" },
      { content: "working", status: "in_progress" },
      { content: "later", status: "pending" },
    ],
    sessionDiffs: null,
  });
  vm.runInNewContext(runtimeSource, harness.context);
  harness.flush();

  const host = findByClass(harness.document.inputContainer, "codexProgressStatusHost");
  const overall = findByClass(host, "codexProgressOverallIcon");
  assert.equal(overall.dataset.variant, "overall");
  assert.equal(overall.dataset.status, "in_progress");
  assert.ok(Math.abs(parseFloat(overall.style.getPropertyValue("--codex-progress")) - 33.333) < 0.01);

  const items = findAllByClass(host, "codexProgressPlanItem");
  assert.deepEqual(items.map((item) => item.dataset.status), [
    "completed",
    "in_progress",
    "pending",
  ]);
  const icons = items.map((item) => findByClass(item, "codexProgressStatusIcon"));
  assert.deepEqual(icons.map((icon) => icon.dataset.variant), ["step", "step", "step"]);
  assert.equal(icons[0].textContent, "✓");
  assert.equal(icons[1].style.getPropertyValue("--codex-progress"), "");
});

test("live turn diffs render a changed-files trigger and per-file details", () => {
  const harness = createProgressHarness({
    busy: false,
    todos: [],
    sessionDiffs: { diffs: {} },
  });
  vm.runInNewContext(runtimeSource, harness.context);
  harness.flush();
  harness.update({ busy: true, todos: [] });
  harness.update({
    sessionDiffs: {
      diffs: {
        "/repo/changed.js": { oldContent: "a\n", newContent: "a\nb\n" },
        "/repo/new.js": { newContent: "one\ntwo\n" },
      },
    },
  });

  const host = findByClass(harness.document.inputContainer, "codexProgressStatusHost");
  assert.equal(host.hidden, false);
  const trigger = findByClass(host, "codexProgressDiffTrigger");
  assert.ok(trigger);
  assert.equal(findByClass(trigger, "codexProgressTriggerLabel").textContent, "2 个文件已更改");
  const stats = findAllByClass(trigger, "codexProgressDiffStats")[0];
  assert.equal(findByClass(stats, "codexProgressAdditions").textContent, "+3");
  assert.equal(findByClass(stats, "codexProgressDeletions").textContent, "-0");

  const rows = findAllByClass(host, "codexProgressDiffFile");
  assert.deepEqual(
    rows.map((row) => findByClass(row, "codexProgressDiffPath").textContent),
    ["changed.js", "new.js"],
  );

  trigger.listeners.get("click")();
  assert.equal(harness.messages[0].type, "codex.progress.openChanges");
  rows[1].listeners.get("click")({ stopPropagation() {} });
  assert.equal(harness.messages[1].type, "codex.progress.openFile");
  assert.equal(harness.messages[1].filePath, "/repo/new.js");
});

test("progress CSS separates the spinning white step ring from the proportional blue ring", () => {
  const css = readFileSync(new URL("../patches/overlay.css", import.meta.url), "utf8");
  assert.match(css, /@keyframes codexProgressStepSpin/);
  assert.match(css, /\[data-variant="step"\]\[data-status="in_progress"\]/);
  assert.match(css, /\[data-variant="overall"\]\[data-status="in_progress"\]/);
});
