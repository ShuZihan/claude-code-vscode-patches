import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.classList = {
      add: (...names) => {
        this.className = [...new Set(`${this.className} ${names.join(" ")}`.trim().split(/\s+/))].join(" ");
      },
      toggle: () => {},
    };
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  querySelector(selector) {
    if (selector.includes(".spacer_gGYT1w")) return this.spacer ?? null;
    if (selector.includes(".codexProviderUsageControl")) return this.usageHost ?? null;
    if (selector.includes(".codexProviderUsageButton")) {
      return this.children.find((child) => child.className === "codexProviderUsageButton") ?? null;
    }
    if (selector.includes(".codexProviderUsagePopover")) {
      return this.children.find((child) => child.className === "codexProviderUsagePopover") ?? null;
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }

  insertAdjacentElement(_position, element) {
    this.footer.usageHost = element;
    this.document.usageHost = element;
  }

  closest(selector) {
    return selector.includes(".inputContainer_cKsPxg") ? this.document.inputContainer : null;
  }

  getBoundingClientRect() {
    return { top: 600, right: 780, left: 700, bottom: 630, width: 80, height: 30 };
  }

  matches() {
    return false;
  }
}

class FakeButton extends FakeElement {}

function createWebviewHarness() {
  const messages = [];
  const windowListeners = new Map();
  const document = {
    usageHost: null,
    createElement(tagName) {
      const element = tagName === "button" ? new FakeButton(tagName) : new FakeElement(tagName);
      element.document = document;
      return element;
    },
    createElementNS(_namespace, tagName) {
      const element = new FakeElement(tagName);
      element.document = document;
      return element;
    },
    querySelectorAll(selector) {
      if (selector === ".inputFooter_gGYT1w") return [document.footer];
      if (selector === ".codexProviderUsageControl") {
        return document.usageHost ? [document.usageHost] : [];
      }
      return [];
    },
    addEventListener() {},
    documentElement: {},
    activeElement: null,
  };
  document.footer = new FakeElement("footer");
  document.footer.document = document;
  document.footer.spacer = new FakeElement("span");
  document.footer.spacer.document = document;
  document.footer.spacer.footer = document.footer;
  document.inputContainer = new FakeElement("div");
  document.inputContainer.document = document;

  const window = {
    IS_SESSION_LIST_ONLY: false,
    innerWidth: 1000,
    innerHeight: 800,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    getSelection: () => null,
    setTimeout,
    clearTimeout,
  };
  const context = {
    console,
    document,
    window,
    navigator: { clipboard: { writeText: async () => {} } },
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButton,
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    Intl,
    URL,
  };
  return { context, document, messages, windowListeners };
}

function elementText(element) {
  return [
    typeof element?.textContent === "string" ? element.textContent : "",
    ...(element?.children || []).map(elementText),
  ].join("");
}

test("opening API usage requests the current provider configuration", () => {
  const harness = createWebviewHarness();
  const source = readFileSync(
    new URL("../patches/files/webview/codex-markdown-runtime.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, harness.context);
  harness.messages.length = 0;

  const button = harness.document.usageHost.querySelector(
    ":scope > .codexProviderUsageButton",
  );
  button.listeners.get("click")({
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].type, "codex.providerUsage.query");
  assert.equal(harness.messages[0].force, false);
});

test("changing the active chat sends its cwd with the usage query", () => {
  const harness = createWebviewHarness();
  const source = readFileSync(
    new URL("../patches/files/webview/codex-markdown-runtime.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, harness.context);
  harness.messages.length = 0;

  harness.context.window.ClaudeCodexProviderUsage.setCwd("/project-a");

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].type, "codex.providerUsage.query");
  assert.equal(harness.messages[0].cwd, "/project-a");
  assert.equal(harness.messages[0].force, false);
});

test("New API quota appears in the API usage control", () => {
  const harness = createWebviewHarness();
  const source = readFileSync(
    new URL("../patches/files/webview/codex-markdown-runtime.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, harness.context);
  const request = harness.messages[0];

  harness.windowListeners.get("message")({
    data: {
      type: "codex.providerUsage.result",
      requestId: request.requestId,
      report: {
        version: 1,
        providerId: "new-api-compatible",
        providerName: "星河 API",
        status: "ready",
        isAvailable: true,
        resources: [
          {
            kind: "quota",
            displayType: "currency",
            currency: "CNY",
            totalAvailable: "54.00",
            totalGranted: "72.00",
            totalUsed: "18.00",
            unlimited: false,
            tokenName: "Claude Code",
            expiresAt: 0,
          },
        ],
        fetchedAt: "2026-08-11T08:00:00.000Z",
        stale: false,
      },
    },
  });

  const button = harness.document.usageHost.querySelector(
    ":scope > .codexProviderUsageButton",
  );
  const label = button.children.find(
    (child) => child.className === "codexProviderUsageButtonLabel",
  );
  assert.equal(
    label.children.map((child) => child.textContent).join(""),
    "星河 API·¥54.00",
  );
});

test("a host-scheduled usage update refreshes the visible balance", () => {
  const harness = createWebviewHarness();
  const source = readFileSync(
    new URL("../patches/files/webview/codex-markdown-runtime.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, harness.context);

  harness.windowListeners.get("message")({
    data: {
      type: "codex.providerUsage.update",
      report: {
        version: 1,
        providerId: "deepseek",
        providerName: "DeepSeek",
        status: "ready",
        isAvailable: true,
        resources: [
          {
            kind: "money",
            currency: "CNY",
            totalBalance: "9.50",
            grantedBalance: "0.00",
            toppedUpBalance: "9.50",
          },
        ],
        fetchedAt: "2026-08-11T08:01:00.000Z",
        stale: false,
      },
    },
  });

  const button = harness.document.usageHost.querySelector(
    ":scope > .codexProviderUsageButton",
  );
  const label = button.children.find(
    (child) => child.className === "codexProviderUsageButtonLabel",
  );
  assert.equal(
    label.children.map((child) => child.textContent).join(""),
    "DeepSeek·¥9.50",
  );
});

test("a failed refresh keeps the old balance and marks it stale", () => {
  const harness = createWebviewHarness();
  const source = readFileSync(
    new URL("../patches/files/webview/codex-markdown-runtime.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, harness.context);

  harness.windowListeners.get("message")({
    data: {
      type: "codex.providerUsage.update",
      report: {
        version: 1,
        providerId: "deepseek",
        providerName: "DeepSeek",
        status: "ready",
        isAvailable: true,
        resources: [
          {
            kind: "money",
            currency: "CNY",
            totalBalance: "9.50",
            grantedBalance: "0.00",
            toppedUpBalance: "9.50",
          },
        ],
        fetchedAt: "2026-08-11T08:00:00.000Z",
        stale: true,
        errorCode: "network_error",
        failedAt: "2026-08-11T08:01:00.000Z",
      },
    },
  });

  const host = harness.document.usageHost;
  const button = host.querySelector(":scope > .codexProviderUsageButton");
  button.listeners.get("click")({
    preventDefault() {},
    stopPropagation() {},
  });
  const popover = host.querySelector(":scope > .codexProviderUsagePopover");

  assert.match(elementText(popover), /总可用余额¥9\.50/);
  assert.match(elementText(popover), /更新失败，数据可能已过期/);
});
