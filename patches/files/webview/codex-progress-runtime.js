/* Codex-style active-turn plan and code-change status for Claude Code. */
(() => {
  const installKey = "__claudeCodexProgressRuntimeV1";
  if (window[installKey] || window.IS_SESSION_LIST_ONLY) return;
  window[installKey] = true;

  const inputContainerSelector = ".inputContainer_07S1Yg";
  const promptContainerSelector = ".promptInputContainer_07S1Yg";
  const state =
    window.__claudeCodexProgressState ||
    (window.__claudeCodexProgressState = {
      busy: false,
      todos: [],
      sessionDiffs: null,
    });

  let refreshFrame = 0;
  let wasBusy = Boolean(state.busy);
  let turnBaseline = null;
  let activeTodos = sanitizeTodos(state.todos);
  let currentSessionDiffs = normalizeSessionDiffs(state.sessionDiffs);

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function sanitizeTodos(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item) =>
          item &&
          typeof item.content === "string" &&
          ["pending", "in_progress", "completed"].includes(item.status),
      )
      .map((item) => ({ content: item.content, status: item.status }));
  }

  function normalizeSessionDiffs(value) {
    if (!value || typeof value !== "object" || !value.diffs) return {};
    const normalized = {};
    for (const [filePath, diff] of Object.entries(value.diffs)) {
      if (
        typeof filePath !== "string" ||
        !diff ||
        typeof diff !== "object" ||
        (diff.oldContent !== null && typeof diff.oldContent !== "string") ||
        (diff.newContent !== null && typeof diff.newContent !== "string")
      ) {
        continue;
      }
      normalized[filePath] = {
        oldContent: diff.oldContent,
        newContent: diff.newContent,
      };
    }
    return normalized;
  }

  function snapshotCurrentContents(diffs) {
    const snapshot = new Map();
    for (const [filePath, diff] of Object.entries(diffs)) {
      snapshot.set(filePath, diff.newContent);
    }
    return snapshot;
  }

  function activeTurnDiffs() {
    const result = {};
    for (const [filePath, diff] of Object.entries(currentSessionDiffs)) {
      const oldContent = turnBaseline?.has(filePath)
        ? turnBaseline.get(filePath)
        : diff.oldContent;
      if (oldContent === diff.newContent) continue;
      result[filePath] = { oldContent, newContent: diff.newContent };
    }
    return result;
  }

  function splitLines(value) {
    if (value === null || value === "") return [];
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  function multisetFallback(oldLines, newLines) {
    const counts = new Map();
    for (const line of oldLines) counts.set(line, (counts.get(line) || 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const count = counts.get(line) || 0;
      if (count === 0) continue;
      common += 1;
      if (count === 1) counts.delete(line);
      else counts.set(line, count - 1);
    }
    return {
      linesAdded: newLines.length - common,
      linesDeleted: oldLines.length - common,
    };
  }

  function lineDiffCounts(oldContent, newContent) {
    const oldLines = splitLines(oldContent);
    const newLines = splitLines(newContent);
    let start = 0;
    while (
      start < oldLines.length &&
      start < newLines.length &&
      oldLines[start] === newLines[start]
    ) {
      start += 1;
    }

    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (
      oldEnd > start &&
      newEnd > start &&
      oldLines[oldEnd - 1] === newLines[newEnd - 1]
    ) {
      oldEnd -= 1;
      newEnd -= 1;
    }

    const before = oldLines.slice(start, oldEnd);
    const after = newLines.slice(start, newEnd);
    const oldLength = before.length;
    const newLength = after.length;
    if (oldLength === 0) return { linesAdded: newLength, linesDeleted: 0 };
    if (newLength === 0) return { linesAdded: 0, linesDeleted: oldLength };

    const maxDistance = oldLength + newLength;
    const offset = maxDistance + 1;
    const frontier = new Int32Array(maxDistance * 2 + 3);
    frontier.fill(-1);
    frontier[offset + 1] = 0;
    const startedAt = performance.now();
    let operations = 0;

    for (let distance = 0; distance <= maxDistance; distance += 1) {
      for (
        let diagonal = -distance;
        diagonal <= distance;
        diagonal += 2
      ) {
        operations += 1;
        if (operations > 2_000_000 || performance.now() - startedAt > 40) {
          return multisetFallback(before, after);
        }

        const index = offset + diagonal;
        let oldIndex;
        if (
          diagonal === -distance ||
          (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
        ) {
          oldIndex = frontier[index + 1];
        } else {
          oldIndex = frontier[index - 1] + 1;
        }
        let newIndex = oldIndex - diagonal;
        while (
          oldIndex < oldLength &&
          newIndex < newLength &&
          before[oldIndex] === after[newIndex]
        ) {
          oldIndex += 1;
          newIndex += 1;
        }
        frontier[index] = oldIndex;

        if (oldIndex >= oldLength && newIndex >= newLength) {
          return {
            linesAdded: (distance - oldLength + newLength) / 2,
            linesDeleted: (distance + oldLength - newLength) / 2,
          };
        }
      }
    }

    return multisetFallback(before, after);
  }

  function summarizeDiffs(diffs) {
    const files = [];
    let linesAdded = 0;
    let linesDeleted = 0;
    for (const [filePath, diff] of Object.entries(diffs)) {
      const counts = lineDiffCounts(diff.oldContent, diff.newContent);
      linesAdded += counts.linesAdded;
      linesDeleted += counts.linesDeleted;
      files.push({ filePath, ...counts });
    }
    return {
      fileCount: files.length,
      files,
      linesAdded,
      linesDeleted,
    };
  }

  function basename(filePath) {
    const pieces = filePath.replace(/\\/g, "/").split("/");
    return pieces.at(-1) || filePath;
  }

  function getVsCodeApi() {
    try {
      return window.__claudeCodexVsCodeApi || window.acquireVsCodeApi?.();
    } catch {
      return null;
    }
  }

  function postToHost(message) {
    const api = getVsCodeApi();
    if (!api) return false;
    api.postMessage(message);
    return true;
  }

  function createStatusIcon(status, progress = 0) {
    const icon = document.createElement("span");
    icon.className = "codexProgressStatusIcon";
    icon.dataset.status = status;
    icon.setAttribute("aria-hidden", "true");
    if (status === "completed") icon.textContent = "✓";
    if (status === "in_progress") {
      icon.style.setProperty("--codex-progress", `${Math.max(8, progress)}%`);
    }
    return icon;
  }

  function currentStepIndex(todos) {
    const inProgress = todos.findIndex((todo) => todo.status === "in_progress");
    if (inProgress !== -1) return inProgress;
    const pending = todos.findIndex((todo) => todo.status !== "completed");
    if (pending !== -1) return pending;
    return Math.max(0, todos.length - 1);
  }

  function createPlanTrigger(todos) {
    const currentIndex = currentStepIndex(todos);
    const completedCount = todos.filter(
      (todo) => todo.status === "completed",
    ).length;
    const progress = todos.length
      ? Math.round((completedCount / todos.length) * 100)
      : 0;

    const group = document.createElement("div");
    group.className = "codexProgressTriggerGroup codexProgressPlanGroup";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codexProgressTrigger";
    button.setAttribute(
      "aria-label",
      `第 ${currentIndex + 1} / ${todos.length} 步，悬浮查看步骤`,
    );
    button.append(createStatusIcon("in_progress", progress));
    const label = document.createElement("span");
    label.className = "codexProgressTriggerLabel";
    label.textContent = `第 ${currentIndex + 1} / ${todos.length} 步`;
    button.append(label);

    const popover = document.createElement("div");
    popover.className = "codexProgressPopover codexProgressPlanPopover";
    popover.setAttribute("role", "tooltip");
    const list = document.createElement("ul");
    list.className = "codexProgressPlanList";
    todos.forEach((todo, index) => {
      const item = document.createElement("li");
      item.className = "codexProgressPlanItem";
      item.dataset.status = todo.status;
      item.append(createStatusIcon(todo.status, index === currentIndex ? progress : 0));
      const text = document.createElement("span");
      text.className = "codexProgressPlanText";
      text.textContent = todo.content;
      item.append(text);
      list.append(item);
    });
    popover.append(list);
    group.append(button, popover);
    return group;
  }

  function createDiffStats(linesAdded, linesDeleted) {
    const stats = document.createElement("span");
    stats.className = "codexProgressDiffStats";
    const additions = document.createElement("span");
    additions.className = "codexProgressAdditions";
    additions.textContent = `+${linesAdded}`;
    const deletions = document.createElement("span");
    deletions.className = "codexProgressDeletions";
    deletions.textContent = `-${linesDeleted}`;
    stats.append(additions, deletions);
    return stats;
  }

  function createDiffTrigger(summary, diffs, showSeparator) {
    const group = document.createElement("div");
    group.className = "codexProgressTriggerGroup codexProgressDiffGroup";
    if (showSeparator) {
      const separator = document.createElement("span");
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "·";
      group.append(separator);
    }

    const triggerHost = document.createElement("div");
    triggerHost.className = "codexProgressDiffTriggerHost";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codexProgressTrigger codexProgressDiffTrigger";
    button.setAttribute(
      "aria-label",
      `${summary.fileCount} 个文件已更改，新增 ${summary.linesAdded} 行，删除 ${summary.linesDeleted} 行`,
    );
    const label = document.createElement("span");
    label.className = "codexProgressTriggerLabel";
    label.textContent = `${summary.fileCount} 个文件已更改`;
    button.append(
      label,
      createDiffStats(summary.linesAdded, summary.linesDeleted),
    );
    button.addEventListener("click", () => {
      postToHost({ type: "codex.progress.openChanges", fileDiffs: diffs });
    });

    const popover = document.createElement("div");
    popover.className = "codexProgressPopover codexProgressDiffPopover";
    popover.setAttribute("role", "tooltip");
    const list = document.createElement("ul");
    list.className = "codexProgressDiffList";
    for (const file of summary.files) {
      const item = document.createElement("li");
      item.className = "codexProgressDiffItem";
      const fileButton = document.createElement("button");
      fileButton.type = "button";
      fileButton.className = "codexProgressDiffFile";
      fileButton.setAttribute("aria-label", `打开 ${file.filePath}`);
      const path = document.createElement("span");
      path.className = "codexProgressDiffPath";
      path.textContent = basename(file.filePath);
      path.title = file.filePath;
      fileButton.append(
        path,
        createDiffStats(file.linesAdded, file.linesDeleted),
      );
      fileButton.addEventListener("click", (event) => {
        event.stopPropagation();
        postToHost({
          type: "codex.progress.openFile",
          filePath: file.filePath,
        });
      });
      item.append(fileButton);
      list.append(item);
    }
    popover.append(list);
    triggerHost.append(button, popover);
    group.append(triggerHost);
    return group;
  }

  function markTodoSources() {
    for (const item of document.querySelectorAll(
      '[data-testid="focus-todo-item"]',
    )) {
      item.classList.add("codexProgressTodoSource");
    }
    for (const list of document.querySelectorAll(".todoListContainer_xheXVQ")) {
      const wrapper =
        list.closest('[data-testid="focus-todo-item"]') ||
        list.closest(".toolUse_uq5aLg") ||
        list.closest(".root_ZUQaOA") ||
        list.parentElement;
      wrapper?.classList.add("codexProgressTodoSource");
    }
  }

  function ensureHost() {
    const inputContainer = document.querySelector(inputContainerSelector);
    if (!(inputContainer instanceof HTMLElement)) return null;
    let host = inputContainer.querySelector(":scope > .codexProgressStatusHost");
    if (!(host instanceof HTMLElement)) {
      host = document.createElement("div");
      host.className = "codexProgressStatusHost";
      host.hidden = true;
      const prompt = inputContainer.querySelector(promptContainerSelector);
      inputContainer.insertBefore(host, prompt || inputContainer.lastElementChild);
    }
    return host;
  }

  function render() {
    refreshFrame = 0;
    markTodoSources();
    const host = ensureHost();
    if (!host) return;

    const diffs = activeTurnDiffs();
    const diffSummary = summarizeDiffs(diffs);
    const showPlan = state.busy && activeTodos.length > 0;
    const showDiff = state.busy && diffSummary.fileCount > 0;
    host.replaceChildren();
    host.hidden = !(showPlan || showDiff);
    if (host.hidden) return;

    const shell = document.createElement("div");
    shell.className = "codexProgressStatusShell";
    shell.setAttribute("role", "status");
    if (showPlan) shell.append(createPlanTrigger(activeTodos));
    if (showDiff) {
      shell.append(createDiffTrigger(diffSummary, diffs, showPlan));
    }
    host.append(shell);
  }

  function scheduleRender() {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(render);
  }

  function applyUpdate(update) {
    if (!update || typeof update !== "object") return;
    if (hasOwn(update, "busy")) {
      const nextBusy = Boolean(update.busy);
      if (nextBusy && !wasBusy) {
        turnBaseline = snapshotCurrentContents(currentSessionDiffs);
        if (!hasOwn(update, "todos")) activeTodos = [];
      }
      wasBusy = nextBusy;
      state.busy = nextBusy;
    }
    if (hasOwn(update, "todos")) {
      activeTodos = sanitizeTodos(update.todos);
      state.todos = activeTodos;
    }
    if (hasOwn(update, "sessionDiffs")) {
      currentSessionDiffs = normalizeSessionDiffs(update.sessionDiffs);
      state.sessionDiffs = update.sessionDiffs;
    }
    scheduleRender();
  }

  window.addEventListener("claude-codex-progress-state", (event) => {
    applyUpdate(event.detail);
  });

  const observer = new MutationObserver((mutations) => {
    const onlyProgressUiChanged = mutations.every(
      (mutation) =>
        mutation.target instanceof Element &&
        mutation.target.closest(".codexProgressStatusHost"),
    );
    if (!onlyProgressUiChanged) scheduleRender();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", scheduleRender, { passive: true });
  scheduleRender();
})();
