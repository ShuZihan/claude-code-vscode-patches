/* Markdown rendering and code highlighting for Claude Code's Webview. */
(() => {
  const installKey = "__claudeCodexMarkdownRuntimeV6";
  if (window[installKey]) return;
  window[installKey] = true;

  const selectors = {
    messageInput: '.messageInput_cKsPxg[contenteditable][role="textbox"]',
    messageInputContainer: ".messageInputContainer_cKsPxg",
  };

  let refreshFrame = 0;
  let highlightRetryTimer = 0;
  let highlightRetryCount = 0;
  let providerUsageReport = null;
  let providerUsageLoading = false;
  let providerUsagePendingRequest = "";
  let providerUsageSequence = 0;
  let providerUsageHasQueried = false;
  let providerUsageCwd =
    typeof window.__claudeCodexProviderUsageCwd === "string"
      ? window.__claudeCodexProviderUsageCwd.trim()
      : "";

  const languageAliases = new Map([
    ["c++", "cpp"],
    ["cs", "csharp"],
    ["htm", "html"],
    ["js", "javascript"],
    ["jsx", "javascript"],
    ["md", "markdown"],
    ["py", "python"],
    ["rb", "ruby"],
    ["sh", "shell"],
    ["bash", "shell"],
    ["zsh", "shell"],
    ["ts", "typescript"],
    ["tsx", "typescript"],
    ["yml", "yaml"],
  ]);

  function hasMarkdown(source) {
    return /(^|\n)\s*(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s|```|~~~)|(?:\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)]+\))/m.test(
      source,
    );
  }

  function appendText(parent, value) {
    if (!value) return;
    const last = parent.lastChild;
    if (last?.nodeType === Node.TEXT_NODE) {
      last.nodeValue += value;
    } else {
      parent.append(document.createTextNode(value));
    }
  }

  function appendInline(parent, source, depth = 0) {
    if (!source || depth > 8) {
      appendText(parent, source);
      return;
    }

    let offset = 0;
    while (offset < source.length) {
      const rest = source.slice(offset);
      let match;

      if (rest[0] === "\\" && rest.length > 1) {
        appendText(parent, rest[1]);
        offset += 2;
        continue;
      }

      match = rest.match(/^`([^`\n]+)`/);
      if (match) {
        const code = document.createElement("code");
        code.textContent = match[1];
        parent.append(code);
        offset += match[0].length;
        continue;
      }

      match = rest.match(/^\*\*([^*\n]+)\*\*/);
      if (!match) match = rest.match(/^__([^_\n]+)__/);
      if (match) {
        const strong = document.createElement("strong");
        appendInline(strong, match[1], depth + 1);
        parent.append(strong);
        offset += match[0].length;
        continue;
      }

      match = rest.match(/^~~([^~\n]+)~~/);
      if (match) {
        const strike = document.createElement("del");
        appendInline(strike, match[1], depth + 1);
        parent.append(strike);
        offset += match[0].length;
        continue;
      }

      match = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
      if (match) {
        const link = document.createElement("a");
        appendInline(link, match[1], depth + 1);
        try {
          const url = new URL(match[2], window.location.href);
          if (
            ["http:", "https:", "mailto:", "vscode:", "vscode-webview:"].includes(
              url.protocol,
            )
          ) {
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
          }
        } catch {
          // Invalid links stay styled text without becoming navigable.
        }
        parent.append(link);
        offset += match[0].length;
        continue;
      }

      match = rest.match(/^\*([^*\n]+)\*/);
      if (!match) match = rest.match(/^_([^_\n]+)_/);
      if (match) {
        const emphasis = document.createElement("em");
        appendInline(emphasis, match[1], depth + 1);
        parent.append(emphasis);
        offset += match[0].length;
        continue;
      }

      appendText(parent, rest[0]);
      offset += 1;
    }
  }

  function appendComposerPreviewLine(parent, line, activeFence) {
    const fence = line.match(/^\s*(```|~~~)/)?.[1] || "";
    if (fence) return;

    if (activeFence) {
      parent.classList.add("codexComposerCodeLine");
      appendText(parent, line);
      return;
    }

    const heading = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
    const unordered = line.match(/^(\s*)([-+*])(\s+)(.*)$/);
    const ordered = line.match(/^(\s*)(\d+[.)])(\s+)(.*)$/);
    if (heading) {
      appendText(parent, heading[1]);
      const content = document.createElement("span");
      content.className = "codexComposerVisualHeading";
      appendInline(content, heading[4]);
      parent.append(content);
    } else if (unordered) {
      appendText(parent, unordered[1]);
      appendText(parent, "• ");
      appendInline(parent, unordered[4]);
    } else if (ordered) {
      appendText(parent, ordered[1]);
      appendText(parent, `${ordered[2]} `);
      appendInline(parent, ordered[4]);
    } else {
      appendInline(parent, line);
    }
  }

  function renderComposerMarkdown(source, activeLineIndex = -1) {
    const root = document.createElement("div");
    root.className = "codexComposerSourceRoot";
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    let activeFence = "";

    lines.forEach((line, index) => {
      const lineNode = document.createElement("div");
      lineNode.className = "codexComposerLine";
      lineNode.dataset.lineIndex = String(index);

      const measure = document.createElement("span");
      measure.className = "codexComposerLineMeasure";
      measure.textContent = line || "\u200b";

      const preview = document.createElement("span");
      preview.className = "codexComposerLinePreview";
      if (index === activeLineIndex) {
        lineNode.dataset.active = "true";
        preview.textContent = line || "\u200b";
      } else {
        appendComposerPreviewLine(preview, line, activeFence);
        if (!preview.hasChildNodes()) preview.textContent = "\u200b";
      }

      lineNode.append(measure, preview);
      root.append(lineNode);

      const fence = line.match(/^\s*(```|~~~)/)?.[1] || "";
      if (fence) activeFence = activeFence ? "" : fence;
    });

    return root;
  }

  function composerCaretOffset(input) {
    if (document.activeElement !== input) return -1;
    const selection = document.getSelection();
    if (!selection?.rangeCount || !input.contains(selection.anchorNode)) return -1;

    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node === selection.anchorNode) {
        return offset + Math.min(selection.anchorOffset, node.nodeValue?.length || 0);
      }
      offset += node.nodeValue?.length || 0;
    }
    return offset;
  }

  function composerActiveLine(input, source) {
    const offset = composerCaretOffset(input);
    if (offset < 0) return -1;
    return source.slice(0, Math.min(offset, source.length)).split("\n").length - 1;
  }

  function monacoTheme() {
    if (document.documentElement.classList.contains("vscode-light")) return "vs";
    if (document.documentElement.classList.contains("vscode-high-contrast-light")) {
      return "hc-light";
    }
    if (document.documentElement.classList.contains("vscode-high-contrast")) {
      return "hc-black";
    }
    return "vs-dark";
  }

  function codeLanguage(code) {
    const languageClass = [...code.classList].find((name) =>
      name.startsWith("language-"),
    );
    const raw = (languageClass?.slice("language-".length) || "plaintext").toLowerCase();
    return languageAliases.get(raw) || raw;
  }

  const nonSemanticFunctionLanguages = new Set([
    "plaintext",
    "markdown",
    "json",
    "jsonc",
    "html",
    "xml",
    "yaml",
    "css",
    "scss",
    "less",
  ]);

  const nonFunctionIdentifiers = new Set([
    "catch",
    "class",
    "def",
    "do",
    "else",
    "finally",
    "fn",
    "for",
    "func",
    "function",
    "if",
    "interface",
    "match",
    "new",
    "return",
    "super",
    "switch",
    "synchronized",
    "this",
    "typeof",
    "unless",
    "when",
    "while",
    "with",
  ]);

  function functionIdentifierRanges(source, language) {
    if (nonSemanticFunctionLanguages.has(language)) return [];
    const ranges = [];
    const pattern = /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*(?=\()/gm;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      const identifier = match[1];
      if (nonFunctionIdentifiers.has(identifier)) continue;
      const relativeStart = match[0].indexOf(identifier);
      const start = match.index + relativeStart;
      ranges.push({ start, end: start + identifier.length });
    }
    return ranges;
  }

  function decorateSemanticFunctions(code, source, language) {
    const ranges = functionIdentifierRanges(source, language);
    if (!ranges.length) return;

    const tokens = [];
    let offset = 0;
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += node.nodeValue?.length || 0;
        return;
      }
      if (!(node instanceof Element)) return;
      if (node.tagName === "BR") {
        offset += 1;
        return;
      }
      const start = offset;
      for (const child of node.childNodes) visit(child);
      if (node.matches('span[class^="mtk"], span[class*=" mtk"]')) {
        tokens.push({ node, start, end: offset });
      }
    };
    for (const child of code.childNodes) visit(child);

    for (const token of tokens) {
      if (!token.node.classList.contains("mtk1")) continue;
      if (
        ranges.some(
          (range) => range.start >= token.start && range.end <= token.end,
        )
      ) {
        token.node.classList.add("codexSemanticFunction");
      }
    }
  }

  function retryCodeHighlighting() {
    if (highlightRetryTimer || highlightRetryCount >= 60) return;
    highlightRetryCount += 1;
    highlightRetryTimer = window.setTimeout(() => {
      highlightRetryTimer = 0;
      scheduleRefresh();
    }, 50);
  }

  function restoreHighlightedCodeNewlines(code, source) {
    let remainingNewlines = (source.match(/\n/g) || []).length;
    for (const lineBreak of code.querySelectorAll("br")) {
      if (remainingNewlines > 0) {
        lineBreak.replaceWith(document.createTextNode("\n"));
        remainingNewlines -= 1;
      } else {
        lineBreak.remove();
      }
    }
  }

  async function enhanceCodeBlock(code) {
    if (!(code instanceof HTMLElement) || code.parentElement?.tagName !== "PRE") return;
    const tokenSelector = 'span[class^="mtk"], span[class*=" mtk"]';
    if (
      code.dataset.codexHighlightedSource &&
      code.querySelector(tokenSelector)
    ) {
      decorateSemanticFunctions(
        code,
        code.dataset.codexHighlightedSource,
        code.dataset.lang || codeLanguage(code),
      );
      return;
    }
    const source = code.textContent || "";
    if (!source) return;
    if (code.dataset.codexHighlightPending === source) return;

    const colorize = window.monaco?.editor?.colorizeElement;
    if (typeof colorize !== "function") {
      retryCodeHighlighting();
      return;
    }
    highlightRetryCount = 0;

    code.dataset.codexHighlightPending = source;
    code.dataset.lang = codeLanguage(code);
    code.classList.remove("vs", "vs-dark", "hc-black", "hc-light");
    code.textContent = source;
    try {
      await colorize(code, {
        theme: monacoTheme(),
        mimeType: code.dataset.lang,
        tabSize: 4,
      });
      restoreHighlightedCodeNewlines(code, source);
      decorateSemanticFunctions(code, source, code.dataset.lang);
      code.dataset.codexHighlightedSource = source;
      code.classList.add("codexMonacoHighlighted");
    } catch (error) {
      console.warn("Codex-style code highlighting failed", error);
      retryCodeHighlighting();
    } finally {
      delete code.dataset.codexHighlightPending;
    }
  }

  function tableCellMarkdown(cell) {
    return (cell?.innerText || cell?.textContent || "")
      .trim()
      .replace(/\|/g, "\\|")
      .replace(/\s*\n\s*/g, "<br>");
  }

  function tableToMarkdown(table) {
    const rows = [...table.rows];
    if (!rows.length) return "";
    const header = table.tHead?.rows?.[0] || rows[0];
    const bodyRows = rows.filter((row) => row !== header);
    const columnCount = Math.max(
      ...rows.map((row) => row.cells.length),
      1,
    );
    const values = (row) =>
      Array.from({ length: columnCount }, (_, index) =>
        tableCellMarkdown(row.cells[index]),
      );
    const line = (cells) => `| ${cells.join(" | ")} |`;
    return [
      line(values(header)),
      line(Array.from({ length: columnCount }, () => "---")),
      ...bodyRows.map((row) => line(values(row))),
    ].join("\n");
  }

  function createTableCopyIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const back = document.createElementNS(namespace, "rect");
    back.setAttribute("x", "5");
    back.setAttribute("y", "3");
    back.setAttribute("width", "8");
    back.setAttribute("height", "9");
    back.setAttribute("rx", "1.5");
    const front = document.createElementNS(namespace, "rect");
    front.setAttribute("x", "2.5");
    front.setAttribute("y", "5.5");
    front.setAttribute("width", "8");
    front.setAttribute("height", "8");
    front.setAttribute("rx", "1.5");
    svg.append(back, front);
    return svg;
  }

  function createTableCheckIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", "M3 8.5 6.5 12 13 4.5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function enhanceTable(table) {
    if (!(table instanceof HTMLTableElement)) return;
    if (table.querySelector(":scope .codexTableCopyButton")) return;
    const row = table.tHead?.rows?.[0] || table.rows[0];
    const hostCell = row?.cells?.[row.cells.length - 1];
    if (!(hostCell instanceof HTMLTableCellElement)) return;

    table.classList.add("codexTableCopyHost");
    hostCell.classList.add("codexTableCopyCellHost");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codexCopyMarkdownButton codexTableCopyButton";
    button.setAttribute("aria-label", "Copy table as Markdown");
    button.title = "Copy table as Markdown";
    button.append(createTableCopyIcon());
    let resetTimer = 0;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const markdown = tableToMarkdown(table);
      if (!markdown) return;
      try {
        await navigator.clipboard.writeText(markdown);
        window.clearTimeout(resetTimer);
        button.dataset.copied = "true";
        button.title = "Copied";
        button.setAttribute("aria-label", "Copied");
        button.replaceChildren(createTableCheckIcon());
        resetTimer = window.setTimeout(() => {
          delete button.dataset.copied;
          button.title = "Copy table as Markdown";
          button.setAttribute("aria-label", "Copy table as Markdown");
          button.replaceChildren(createTableCopyIcon());
        }, 2000);
      } catch (error) {
        console.warn("Copy table as Markdown failed", error);
      }
    });
    hostCell.append(button);
  }

  function updateComposer(input) {
    if (!(input instanceof HTMLElement)) return;
    const inputContainer = input.closest(selectors.messageInputContainer);
    if (!(inputContainer instanceof HTMLElement)) return;

    const source = input.textContent || "";
    const activeLine = composerActiveLine(input, source);
    let overlay = inputContainer.querySelector(
      ":scope > .codexComposerMarkdownOverlay",
    );

    if (!source.trim() || !hasMarkdown(source)) {
      overlay?.remove();
      inputContainer.classList.remove("codexComposerMarkdownActive");
      return;
    }
    if (
      overlay?.dataset.markdownSource === source &&
      overlay.dataset.activeLine === String(activeLine)
    ) {
      return;
    }

    if (!(overlay instanceof HTMLElement)) {
      overlay = document.createElement("div");
      overlay.className = "codexComposerMarkdownOverlay";
      overlay.setAttribute("aria-hidden", "true");
      inputContainer.append(overlay);
    }
    overlay.dataset.markdownSource = source;
    overlay.dataset.activeLine = String(activeLine);
    overlay.replaceChildren(renderComposerMarkdown(source, activeLine));
    overlay.scrollTop = input.scrollTop;
    overlay.scrollLeft = input.scrollLeft;
    inputContainer.classList.add("codexComposerMarkdownActive");

    if (!input.dataset.codexMarkdownScrollSync) {
      input.dataset.codexMarkdownScrollSync = "true";
      input.addEventListener(
        "scroll",
        () => {
          const currentOverlay = inputContainer.querySelector(
            ":scope > .codexComposerMarkdownOverlay",
          );
          if (currentOverlay instanceof HTMLElement) {
            currentOverlay.scrollTop = input.scrollTop;
            currentOverlay.scrollLeft = input.scrollLeft;
          }
        },
        { passive: true },
      );
    }
  }

  function getVsCodeApi() {
    if (window.__claudeCodexVsCodeApi) return window.__claudeCodexVsCodeApi;
    if (typeof window.acquireVsCodeApi !== "function") return null;
    try {
      return window.acquireVsCodeApi();
    } catch (error) {
      console.warn("Provider usage bridge is unavailable", error);
      return null;
    }
  }

  function providerUsageIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.classList.add("codexProviderUsageIcon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");

    const arc = document.createElementNS(namespace, "path");
    arc.setAttribute("d", "M3 10.5a5.25 5.25 0 1 1 10 0");
    arc.setAttribute("fill", "none");
    arc.setAttribute("stroke", "currentColor");
    arc.setAttribute("stroke-width", "1.35");
    arc.setAttribute("stroke-linecap", "round");

    const needle = document.createElementNS(namespace, "path");
    needle.setAttribute("d", "m8 9.25 2.6-2.1");
    needle.setAttribute("fill", "none");
    needle.setAttribute("stroke", "currentColor");
    needle.setAttribute("stroke-width", "1.35");
    needle.setAttribute("stroke-linecap", "round");

    const center = document.createElementNS(namespace, "circle");
    center.setAttribute("cx", "8");
    center.setAttribute("cy", "9.25");
    center.setAttribute("r", "1");
    center.setAttribute("fill", "currentColor");
    svg.append(arc, needle, center);
    return svg;
  }

  function refreshIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.classList.add("codexProviderUsageRefreshIcon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute(
      "d",
      "M13 5.5V2.75l-1.05 1.08A5.25 5.25 0 1 0 13.1 9M13 2.75h-2.75",
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.25");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function isDecimal(value) {
    return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value);
  }

  function isProviderUsageReport(report) {
    if (
      !report ||
      report.version !== 1 ||
      typeof report.providerName !== "string" ||
      report.providerName.length > 100 ||
      !["ready", "unsupported", "unconfigured", "error"].includes(
        report.status,
      ) ||
      !Array.isArray(report.resources)
    ) {
      return false;
    }
    return report.resources.every((resource) => {
      if (resource?.kind === "money") {
        return (
          ["CNY", "USD"].includes(resource.currency) &&
          isDecimal(resource.totalBalance) &&
          isDecimal(resource.toppedUpBalance) &&
          isDecimal(resource.grantedBalance)
        );
      }
      if (resource?.kind !== "quota") return false;
      const validDisplay =
        (resource.displayType === "currency" &&
          ["CNY", "USD"].includes(resource.currency)) ||
        (resource.displayType === "custom" &&
          typeof resource.symbol === "string" &&
          resource.symbol.length > 0 &&
          resource.symbol.length <= 12) ||
        resource.displayType === "tokens";
      return (
        validDisplay &&
        isDecimal(resource.totalAvailable) &&
        isDecimal(resource.totalGranted) &&
        isDecimal(resource.totalUsed) &&
        typeof resource.unlimited === "boolean" &&
        typeof resource.tokenName === "string" &&
        resource.tokenName.length <= 100 &&
        Number.isSafeInteger(resource.expiresAt) &&
        resource.expiresAt >= 0
      );
    });
  }

  function formatCurrency(value, currency) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return `${currency} ${value}`;
    try {
      return new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
        .format(amount)
        .replace(/\s/g, "");
    } catch {
      return `${currency} ${value}`;
    }
  }

  function formatQuotaValue(resource, value) {
    if (resource.unlimited) return "无限额度";
    if (resource.displayType === "currency") {
      return formatCurrency(value, resource.currency);
    }
    if (resource.displayType === "custom") {
      return `${resource.symbol}${value}`;
    }
    const amount = Number(value);
    return `${Number.isFinite(amount) ? amount.toLocaleString("zh-CN") : value} quota`;
  }

  function providerUsageErrorText(report) {
    if (report?.status === "unsupported") {
      return "当前提供商暂不支持余额或用量查询。";
    }
    if (report?.status === "unconfigured") {
      return report.providerId === "deepseek"
        ? "未检测到 DeepSeek API Key。"
        : "未检测到可查询的 API 提供商配置。";
    }
    const messages = {
      unauthorized: "API Key 无效，无法查询余额。",
      forbidden: "当前 API Key 没有查询余额的权限。",
      rate_limited: "查询过于频繁，请稍后再试。",
      timeout: "查询超时，请稍后再试。",
      invalid_json: "提供商返回了无法解析的数据。",
      invalid_response: "提供商返回的余额结构与预期不一致。",
      provider_unavailable: "提供商的余额服务暂时不可用。",
      network_error: "网络请求失败，请检查连接后重试。",
      internal_error: "扩展暂时无法完成余额查询。",
    };
    return messages[report?.errorCode] || "余额查询失败，请稍后重试。";
  }

  function providerUsageTimestamp(value) {
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return "";
    return time.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function appendUsageRow(parent, label, value, emphasized = false) {
    const row = document.createElement("div");
    row.className = "codexProviderUsageRow";
    if (emphasized) row.classList.add("codexProviderUsageRowTotal");
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement(emphasized ? "strong" : "span");
    valueNode.className = "codexProviderUsageValue";
    valueNode.textContent = value;
    row.append(labelNode, valueNode);
    parent.append(row);
  }

  function positionProviderUsagePopover(host) {
    const button = host.querySelector(":scope > .codexProviderUsageButton");
    const popover = host.querySelector(":scope > .codexProviderUsagePopover");
    if (
      !(button instanceof HTMLElement) ||
      !(popover instanceof HTMLElement) ||
      popover.hidden
    ) {
      return;
    }
    const anchor = button.getBoundingClientRect();
    const input = host.closest(".inputContainer_cKsPxg");
    const inputRect = input?.getBoundingClientRect();
    const width = Math.min(292, Math.max(0, window.innerWidth - 20));
    const rightEdge = Math.min(
      window.innerWidth - 10,
      inputRect ? inputRect.right - 6 : anchor.right,
    );
    const left = Math.max(10, rightEdge - width);
    const availableHeight = Math.max(100, anchor.top - 20);
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    popover.style.bottom = `${window.innerHeight - anchor.top + 8}px`;
    popover.style.maxHeight = `${Math.min(420, window.innerHeight * 0.55, availableHeight)}px`;
  }

  function renderProviderUsagePopover(host) {
    const popover = host.querySelector(":scope > .codexProviderUsagePopover");
    if (!(popover instanceof HTMLElement)) return;
    popover.replaceChildren();

    const header = document.createElement("div");
    header.className = "codexProviderUsageHeader";
    const heading = document.createElement("div");
    heading.className = "codexProviderUsageHeading";
    heading.textContent =
      providerUsageReport?.providerName &&
      providerUsageReport.providerName !== "当前提供商"
        ? `${providerUsageReport.providerName} 用量`
        : "API 用量";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "codexProviderUsageRefresh";
    refresh.title = "刷新";
    refresh.setAttribute("aria-label", "刷新余额或用量");
    refresh.disabled = providerUsageLoading;
    refresh.append(refreshIcon());
    refresh.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      queryProviderUsage(true);
    });
    header.append(heading, refresh);
    popover.append(header);

    if (providerUsageLoading && !providerUsageReport) {
      const loading = document.createElement("div");
      loading.className = "codexProviderUsageEmpty";
      loading.textContent = "正在查询…";
      popover.append(loading);
      positionProviderUsagePopover(host);
      return;
    }

    if (providerUsageReport?.status === "ready") {
      if (providerUsageReport.stale) {
        const warning = document.createElement("div");
        warning.className = "codexProviderUsageNotice";
        warning.textContent = `更新失败，数据可能已过期。${providerUsageErrorText(providerUsageReport)}`;
        popover.append(warning);
      }

      if (providerUsageReport.isAvailable === false) {
        const warning = document.createElement("div");
        warning.className = "codexProviderUsageNotice";
        warning.textContent = "当前账户余额不可用于 API 调用";
        popover.append(warning);
      }

      providerUsageReport.resources.forEach((resource) => {
        const section = document.createElement("section");
        section.className = "codexProviderUsageResource";
        if (providerUsageReport.resources.length > 1) {
          const currency = document.createElement("div");
          currency.className = "codexProviderUsageCurrency";
          currency.textContent = resource.currency;
          section.append(currency);
        }
        if (resource.kind === "money") {
          appendUsageRow(
            section,
            "总可用余额",
            formatCurrency(resource.totalBalance, resource.currency),
            true,
          );
          appendUsageRow(
            section,
            "充值余额",
            formatCurrency(resource.toppedUpBalance, resource.currency),
          );
          appendUsageRow(
            section,
            "赠金余额",
            formatCurrency(resource.grantedBalance, resource.currency),
          );
        } else {
          appendUsageRow(
            section,
            "可用额度",
            formatQuotaValue(resource, resource.totalAvailable),
            true,
          );
          if (!resource.unlimited) {
            appendUsageRow(
              section,
              "总额度",
              formatQuotaValue(resource, resource.totalGranted),
            );
            appendUsageRow(
              section,
              "已使用",
              formatQuotaValue(resource, resource.totalUsed),
            );
          }
          appendUsageRow(section, "Key", resource.tokenName || "未命名");
          appendUsageRow(
            section,
            "到期",
            resource.expiresAt === 0
              ? "永不过期"
              : new Date(resource.expiresAt * 1000).toLocaleDateString(),
          );
        }
        popover.append(section);
      });
    } else if (providerUsageReport) {
      const empty = document.createElement("div");
      empty.className = "codexProviderUsageEmpty";
      empty.textContent = providerUsageErrorText(providerUsageReport);
      popover.append(empty);
    } else {
      const empty = document.createElement("div");
      empty.className = "codexProviderUsageEmpty";
      empty.textContent = "尚未查询 API 用量。";
      popover.append(empty);
    }

    const timestamp = providerUsageTimestamp(providerUsageReport?.fetchedAt);
    if (timestamp) {
      const footer = document.createElement("div");
      footer.className = "codexProviderUsageMeta";
      footer.textContent = `更新于 ${timestamp}`;
      popover.append(footer);
    }
    positionProviderUsagePopover(host);
  }

  function renderProviderUsageControl(host) {
    const button = host.querySelector(":scope > .codexProviderUsageButton");
    if (!(button instanceof HTMLButtonElement)) return;
    button.replaceChildren(providerUsageIcon());
    button.dataset.loading = providerUsageLoading ? "true" : "false";

    const label = document.createElement("span");
    label.className = "codexProviderUsageButtonLabel";
    if (
      providerUsageReport?.status === "ready" &&
      providerUsageReport.resources.length
    ) {
      const resource = providerUsageReport.resources[0];
      const provider = document.createElement("span");
      provider.className = "codexProviderUsageProvider";
      provider.textContent = providerUsageReport.providerName;
      const separator = document.createElement("span");
      separator.className = "codexProviderUsageSeparator";
      separator.textContent = "·";
      const amount = document.createElement("span");
      amount.className = "codexProviderUsageAmount";
      amount.textContent =
        resource.kind === "money"
          ? formatCurrency(resource.totalBalance, resource.currency)
          : formatQuotaValue(resource, resource.totalAvailable);
      label.append(provider, separator, amount);
      button.setAttribute(
        "aria-label",
        `${providerUsageReport.providerName}，${resource.kind === "money" ? "总可用余额" : "可用额度"} ${amount.textContent}`,
      );
      button.title = button.getAttribute("aria-label");
    } else {
      label.textContent = providerUsageLoading ? "查询中" : "API 用量";
      button.setAttribute("aria-label", "查看 API 余额或用量");
      button.title =
        providerUsageReport && providerUsageReport.status !== "ready"
          ? providerUsageErrorText(providerUsageReport)
          : "查看 API 余额或用量";
    }
    button.append(label);
    renderProviderUsagePopover(host);
  }

  function renderProviderUsageControls() {
    for (const host of document.querySelectorAll(
      ".codexProviderUsageControl",
    )) {
      renderProviderUsageControl(host);
    }
  }

  function closeProviderUsagePopovers(except = null) {
    for (const host of document.querySelectorAll(
      ".codexProviderUsageControl",
    )) {
      if (host === except) continue;
      host.dataset.open = "false";
      const button = host.querySelector(":scope > .codexProviderUsageButton");
      const popover = host.querySelector(
        ":scope > .codexProviderUsagePopover",
      );
      button?.setAttribute("aria-expanded", "false");
      if (popover instanceof HTMLElement) popover.hidden = true;
    }
  }

  function queryProviderUsage(force = false) {
    const api = getVsCodeApi();
    if (!api) return false;
    providerUsageHasQueried = true;
    providerUsageLoading = true;
    providerUsageSequence += 1;
    providerUsagePendingRequest = `provider-usage-${Date.now()}-${providerUsageSequence}`;
    renderProviderUsageControls();
    api.postMessage({
      type: "codex.providerUsage.query",
      requestId: providerUsagePendingRequest,
      force,
      cwd: providerUsageCwd,
    });
    return true;
  }

  function setProviderUsageCwd(cwd) {
    const nextCwd =
      typeof cwd === "string" && cwd.length <= 32_768 ? cwd.trim() : "";
    if (!nextCwd || nextCwd === providerUsageCwd) return;
    providerUsageCwd = nextCwd;
    window.__claudeCodexProviderUsageCwd = nextCwd;
    providerUsageReport = null;
    queryProviderUsage(false);
  }

  window.ClaudeCodexProviderUsage = Object.freeze({
    setCwd: setProviderUsageCwd,
  });

  function ensureProviderUsageControl() {
    if (window.IS_SESSION_LIST_ONLY) return;
    for (const footer of document.querySelectorAll(".inputFooter_gGYT1w")) {
      if (!(footer instanceof HTMLElement)) continue;
      if (footer.querySelector(":scope > .codexProviderUsageControl")) continue;
      const spacer = footer.querySelector(":scope > .spacer_gGYT1w");
      if (!(spacer instanceof HTMLElement)) continue;

      const host = document.createElement("div");
      host.className = "codexProviderUsageControl";
      host.dataset.open = "false";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "codexProviderUsageButton";
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      const popover = document.createElement("div");
      popover.className = "codexProviderUsagePopover";
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-label", "API 余额或用量");
      popover.hidden = true;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = host.dataset.open !== "true";
        closeProviderUsagePopovers(host);
        host.dataset.open = shouldOpen ? "true" : "false";
        button.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
        popover.hidden = !shouldOpen;
        if (shouldOpen) {
          queryProviderUsage(false);
          renderProviderUsagePopover(host);
          positionProviderUsagePopover(host);
        }
      });
      host.append(button, popover);
      spacer.insertAdjacentElement("afterend", host);
      renderProviderUsageControl(host);
    }
    if (!providerUsageHasQueried) queryProviderUsage(false);
  }

  function refresh() {
    refreshFrame = 0;
    ensureProviderUsageControl();
    for (const input of document.querySelectorAll(selectors.messageInput)) {
      updateComposer(input);
    }
    for (const code of document.querySelectorAll(".root_-a7MRw pre > code")) {
      enhanceCodeBlock(code);
    }
    for (const table of document.querySelectorAll(".root_-a7MRw table")) {
      enhanceTable(table);
    }
  }

  function scheduleRefresh() {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(refresh);
  }

  document.addEventListener(
    "input",
    (event) => {
      if (event.target instanceof Element && event.target.matches(selectors.messageInput)) {
        updateComposer(event.target);
      }
    },
    true,
  );

  document.addEventListener("selectionchange", () => {
    const input = document.activeElement;
    if (input instanceof Element && input.matches(selectors.messageInput)) {
      updateComposer(input);
    }
  });

  document.addEventListener(
    "focusin",
    (event) => {
      if (event.target instanceof Element && event.target.matches(selectors.messageInput)) {
        updateComposer(event.target);
      }
    },
    true,
  );

  document.addEventListener(
    "focusout",
    (event) => {
      if (!(event.target instanceof Element) || !event.target.matches(selectors.messageInput)) {
        return;
      }
      window.setTimeout(() => updateComposer(event.target), 0);
    },
    true,
  );

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "codex.providerUsage.update") {
      if (!isProviderUsageReport(message.report)) return;
      providerUsageReport = message.report;
      renderProviderUsageControls();
      return;
    }
    if (
      message?.type !== "codex.providerUsage.result" ||
      message.requestId !== providerUsagePendingRequest ||
      !isProviderUsageReport(message.report)
    ) return;
    providerUsageReport = message.report;
    providerUsageLoading = false;
    providerUsagePendingRequest = "";
    renderProviderUsageControls();
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".codexProviderUsageControl")
      ) {
        return;
      }
      closeProviderUsagePopovers();
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeProviderUsagePopovers();
  });

  window.addEventListener("resize", () => {
    for (const host of document.querySelectorAll(
      '.codexProviderUsageControl[data-open="true"]',
    )) {
      positionProviderUsagePopover(host);
    }
  });

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  scheduleRefresh();
})();
