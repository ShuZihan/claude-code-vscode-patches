/* Codex-style user-message navigation rail for Claude Code's VS Code webview. */
(() => {
  const installKey = "__claudeCodexMessageRailV1";
  if (window[installKey]) return;
  window[installKey] = true;

  const minimumTurns = 4;
  const selectors = {
    chat: ".chatContainer_07S1Yg",
    scroller: ".messagesContainer_07S1Yg",
    turn: ".turn_07S1Yg",
    userMessage: ".userMessage_07S1Yg",
    assistantMessage: '[data-testid="assistant-message"]',
    markdown: ".root_-a7MRw",
  };

  const state = {
    chat: null,
    scroller: null,
    nav: null,
    list: null,
    tooltip: null,
    tooltipTitle: null,
    tooltipPreview: null,
    turns: [],
    buttons: [],
    resizeObserver: null,
    ensureTimer: 0,
    activeFrame: 0,
    previewTimer: 0,
    targetIndex: -1,
    pointerInside: false,
    dragging: false,
    dragPointerId: null,
    dragCaptureTarget: null,
    dragStartIndex: -1,
    dragMoved: false,
    suppressClick: false,
  };

  function normalizeText(value) {
    return (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function previewForTurn(turn, index) {
    const user = normalizeText(
      turn.querySelector(selectors.userMessage)?.innerText,
    );
    const responseParts = [];

    for (const message of turn.querySelectorAll(selectors.assistantMessage)) {
      const markdownNodes = message.querySelectorAll(selectors.markdown);
      for (const node of markdownNodes) {
        const text = normalizeText(node.innerText);
        if (text) responseParts.push(text);
      }
    }

    return {
      title: user || `Message ${index + 1}`,
      response: responseParts.join("\n\n"),
    };
  }

  function createRail(chat) {
    const nav = document.createElement("nav");
    nav.className = "codexMessageRail";
    nav.setAttribute("aria-label", "Conversation messages");

    const list = document.createElement("div");
    list.className = "codexMessageRailList";
    list.dataset.messageRailList = "true";
    nav.append(list);
    chat.append(nav);

    const tooltip = document.createElement("div");
    tooltip.className = "codexMessageRailTooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.setAttribute("aria-hidden", "true");

    const tooltipTitle = document.createElement("div");
    tooltipTitle.className = "codexMessageRailTooltipTitle";
    const tooltipPreview = document.createElement("div");
    tooltipPreview.className = "codexMessageRailTooltipPreview";
    tooltip.append(tooltipTitle, tooltipPreview);
    document.body.append(tooltip);

    state.nav = nav;
    state.list = list;
    state.tooltip = tooltip;
    state.tooltipTitle = tooltipTitle;
    state.tooltipPreview = tooltipPreview;

    list.addEventListener("click", onClick);
    list.addEventListener("keydown", onKeyDown);
    list.addEventListener("focusin", onFocusIn);
    list.addEventListener("focusout", onFocusOut);
    list.addEventListener("pointerover", onPointerOver);
    list.addEventListener("pointerenter", onPointerEnter);
    list.addEventListener("pointerleave", onPointerLeave);
    list.addEventListener("pointerdown", onPointerDown);
    list.addEventListener("pointermove", onPointerMove);
    list.addEventListener("pointerup", finishDrag);
    list.addEventListener("pointercancel", finishDrag);
    list.addEventListener("lostpointercapture", finishDrag);
    list.addEventListener("scroll", positionTooltip, { passive: true });
  }

  function destroyRail() {
    clearTimeout(state.previewTimer);
    cancelAnimationFrame(state.activeFrame);

    if (state.scroller) {
      state.scroller.removeEventListener("scroll", scheduleActiveUpdate);
    }
    state.resizeObserver?.disconnect();
    state.nav?.remove();
    state.tooltip?.remove();

    state.chat = null;
    state.scroller = null;
    state.nav = null;
    state.list = null;
    state.tooltip = null;
    state.tooltipTitle = null;
    state.tooltipPreview = null;
    state.turns = [];
    state.buttons = [];
    state.resizeObserver = null;
    state.targetIndex = -1;
    state.dragging = false;
    state.dragPointerId = null;
    state.dragCaptureTarget = null;
  }

  function ensureMounted() {
    state.ensureTimer = 0;
    const chat = document.querySelector(selectors.chat);
    const scroller = chat?.querySelector(selectors.scroller) || null;

    if (chat !== state.chat || scroller !== state.scroller) {
      destroyRail();
      if (!chat || !scroller) return;

      state.chat = chat;
      state.scroller = scroller;
      createRail(chat);
      scroller.addEventListener("scroll", scheduleActiveUpdate, {
        passive: true,
      });

      if (typeof ResizeObserver !== "undefined") {
        state.resizeObserver = new ResizeObserver(() => {
          scheduleActiveUpdate();
          positionTooltip();
          updateOverflowMask();
        });
        state.resizeObserver.observe(scroller);
      }
    }

    refreshTurns();
  }

  function scheduleEnsure() {
    if (state.ensureTimer) return;
    state.ensureTimer = window.setTimeout(ensureMounted, 50);
  }

  function mutationTouchesConversation(mutations) {
    for (const mutation of mutations) {
      const target = mutation.target;
      if (
        target instanceof Element &&
        target.closest(selectors.scroller)
      ) {
        return true;
      }

      for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (!(node instanceof Element)) continue;
        if (
          node.matches(selectors.chat) ||
          node.matches(selectors.scroller) ||
          node.querySelector(selectors.chat) ||
          node.querySelector(selectors.scroller)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function refreshTurns() {
    if (!state.scroller || !state.list || !state.nav) return;

    const turns = Array.from(state.scroller.children).filter(
      (element) =>
        element instanceof HTMLElement &&
        element.matches(selectors.turn) &&
        element.querySelector(selectors.userMessage),
    );
    const unchanged =
      turns.length === state.turns.length &&
      turns.every((turn, index) => turn === state.turns[index]);

    state.nav.hidden = turns.length < minimumTurns;
    if (turns.length < minimumTurns) hideTooltip();
    if (unchanged) {
      scheduleActiveUpdate();
      return;
    }

    state.turns = turns;
    state.targetIndex = -1;
    hideTooltip();

    const fragment = document.createDocumentFragment();
    state.buttons = turns.map((turn, index) => {
      const button = document.createElement("button");
      button.className = "codexMessageRailButton";
      button.type = "button";
      button.dataset.messageRailIndex = String(index);
      button.setAttribute("aria-label", `Jump to message ${index + 1}`);

      const marker = document.createElement("span");
      marker.className = "codexMessageRailMarker";
      button.append(marker);
      fragment.append(button);
      return button;
    });

    state.list.replaceChildren(fragment);
    requestAnimationFrame(() => {
      updateOverflowMask();
      updateActiveMarkers();
    });
  }

  function buttonFromTarget(target) {
    if (!(target instanceof Element) || !state.list) return null;
    const button = target.closest(".codexMessageRailButton");
    if (!(button instanceof HTMLButtonElement) || !state.list.contains(button)) {
      return null;
    }
    return button;
  }

  function indexFromButton(button) {
    const index = Number(button?.dataset.messageRailIndex);
    return Number.isInteger(index) ? index : -1;
  }

  function setTarget(index, immediate = false) {
    if (!state.list || index < 0 || index >= state.buttons.length) return;

    if (state.targetIndex !== index) {
      if (state.targetIndex >= 0) {
        state.buttons[state.targetIndex]?.removeAttribute("data-scrub-target");
      }
      state.targetIndex = index;
      state.buttons[index]?.setAttribute("data-scrub-target", "true");
    }

    const tooltipIsOpen = state.tooltip?.dataset.open === "true";
    clearTimeout(state.previewTimer);
    if (immediate || tooltipIsOpen) {
      showTooltip(index);
    } else {
      state.previewTimer = window.setTimeout(() => showTooltip(index), 150);
    }
  }

  function clearTarget() {
    clearTimeout(state.previewTimer);
    if (state.targetIndex >= 0) {
      state.buttons[state.targetIndex]?.removeAttribute("data-scrub-target");
    }
    state.targetIndex = -1;
    hideTooltip();
  }

  function showTooltip(index) {
    if (
      !state.tooltip ||
      !state.tooltipTitle ||
      !state.tooltipPreview ||
      state.nav?.hidden ||
      index !== state.targetIndex
    ) {
      return;
    }

    const turn = state.turns[index];
    if (!turn) return;
    const preview = previewForTurn(turn, index);
    state.tooltipTitle.textContent = preview.title;
    state.tooltipPreview.textContent = preview.response;
    state.tooltipPreview.hidden = !preview.response;
    state.tooltip.dataset.open = "true";
    state.tooltip.setAttribute("aria-hidden", "false");
    positionTooltip();
  }

  function hideTooltip() {
    if (!state.tooltip) return;
    delete state.tooltip.dataset.open;
    state.tooltip.setAttribute("aria-hidden", "true");
  }

  function positionTooltip() {
    if (!state.tooltip?.dataset.open || state.targetIndex < 0) return;
    const button = state.buttons[state.targetIndex];
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const left = Math.max(8, buttonRect.right + 4);
    const availableWidth = Math.max(120, window.innerWidth - left - 8);
    state.tooltip.style.left = `${left}px`;
    state.tooltip.style.maxWidth = `${availableWidth}px`;

    const tooltipRect = state.tooltip.getBoundingClientRect();
    const desiredTop =
      buttonRect.top + buttonRect.height / 2 - tooltipRect.height / 2;
    const top = Math.max(
      8,
      Math.min(desiredTop, window.innerHeight - tooltipRect.height - 8),
    );
    state.tooltip.style.top = `${top}px`;
  }

  function scrollToTurn(index, behavior) {
    const turn = state.turns[index];
    const scroller = state.scroller;
    if (!turn || !scroller) return;

    const top = Math.max(0, turn.offsetTop - 16);
    scroller.scrollTo({
      top,
      behavior: behavior === "smooth" ? "smooth" : "auto",
    });

    const bubble = turn.querySelector(selectors.userMessage);
    if (bubble instanceof HTMLElement) {
      bubble.classList.remove("codexMessageRailFlash");
      void bubble.offsetWidth;
      bubble.classList.add("codexMessageRailFlash");
      window.setTimeout(
        () => bubble.classList.remove("codexMessageRailFlash"),
        1450,
      );
    }
  }

  function onClick(event) {
    const button = buttonFromTarget(event.target);
    if (!button) return;
    if (state.suppressClick) {
      event.preventDefault();
      return;
    }

    const index = indexFromButton(button);
    setTarget(index, true);
    scrollToTurn(index, "instant");
  }

  function onKeyDown(event) {
    const button = buttonFromTarget(event.target);
    if (!button) return;
    const index = indexFromButton(button);
    let next = index;

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = Math.min(state.buttons.length - 1, index + 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = Math.max(0, index - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = state.buttons.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    state.buttons[next]?.focus();
  }

  function onFocusIn(event) {
    const button = buttonFromTarget(event.target);
    if (button) setTarget(indexFromButton(button), true);
  }

  function onFocusOut(event) {
    if (state.list?.contains(event.relatedTarget)) return;
    if (!state.pointerInside && !state.dragging) clearTarget();
  }

  function onPointerOver(event) {
    if (state.dragging) return;
    const button = buttonFromTarget(event.target);
    if (button) setTarget(indexFromButton(button));
  }

  function onPointerEnter() {
    state.pointerInside = true;
  }

  function onPointerLeave() {
    state.pointerInside = false;
    if (state.dragging) return;

    const focused = buttonFromTarget(document.activeElement);
    if (focused?.matches(":focus-visible")) {
      setTarget(indexFromButton(focused), true);
    } else {
      clearTarget();
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !state.list) return;
    const button = buttonFromTarget(event.target);
    if (!button) return;

    state.dragging = true;
    state.dragPointerId = event.pointerId;
    state.dragCaptureTarget = button;
    state.dragStartIndex = indexFromButton(button);
    state.dragMoved = false;
    state.list.dataset.scrubbing = "true";
    setTarget(state.dragStartIndex, true);
    button.setPointerCapture?.(event.pointerId);
  }

  function buttonAtPointer(event) {
    if (!state.list) return null;
    const rect = state.list.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = Math.max(rect.top, Math.min(event.clientY, rect.bottom - 1));
    return buttonFromTarget(document.elementFromPoint(x, y));
  }

  function onPointerMove(event) {
    if (!state.dragging || event.pointerId !== state.dragPointerId) return;
    if (event.buttons % 2 === 0) {
      finishDrag(event);
      return;
    }

    const button = buttonAtPointer(event);
    if (!button) return;
    const index = indexFromButton(button);
    if (index === state.targetIndex) return;

    state.dragMoved ||= index !== state.dragStartIndex;
    setTarget(index, true);
    scrollToTurn(index, "instant");
  }

  function finishDrag(event) {
    if (!state.dragging || event.pointerId !== state.dragPointerId) return;
    const list = state.list;
    const pointerId = state.dragPointerId;
    const captureTarget = state.dragCaptureTarget;

    state.dragging = false;
    state.dragPointerId = null;
    state.dragCaptureTarget = null;
    delete list?.dataset.scrubbing;
    if (captureTarget?.hasPointerCapture?.(pointerId)) {
      captureTarget.releasePointerCapture(pointerId);
    }

    if (state.dragMoved) {
      state.suppressClick = true;
      window.setTimeout(() => {
        state.suppressClick = false;
      }, 0);
    }

    const focused = buttonFromTarget(document.activeElement);
    if (
      !state.pointerInside &&
      !focused?.matches(":focus-visible")
    ) {
      clearTarget();
    }
  }

  function scheduleActiveUpdate() {
    if (state.activeFrame) return;
    state.activeFrame = requestAnimationFrame(updateActiveMarkers);
  }

  function updateActiveMarkers() {
    state.activeFrame = 0;
    if (!state.scroller || !state.buttons.length) return;

    const scrollerRect = state.scroller.getBoundingClientRect();
    const top = scrollerRect.top + 16;
    const bottom = scrollerRect.bottom;
    const active = [];

    state.turns.forEach((turn, index) => {
      const rect = turn.getBoundingClientRect();
      if (rect.bottom > top && rect.top < bottom) active.push(index);
    });

    if (!active.length && state.turns.length) {
      let closest = 0;
      let distance = Number.POSITIVE_INFINITY;
      state.turns.forEach((turn, index) => {
        const nextDistance = Math.abs(turn.getBoundingClientRect().top - top);
        if (nextDistance < distance) {
          distance = nextDistance;
          closest = index;
        }
      });
      active.push(closest);
    }

    const activeSet = new Set(active);
    state.buttons.forEach((button, index) => {
      if (activeSet.has(index)) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });

    if (!state.dragging && !state.pointerInside && active.length) {
      keepMarkerVisible(state.buttons[active[0]]);
    }
    positionTooltip();
  }

  function keepMarkerVisible(button) {
    const list = state.list;
    if (!list || !button) return;

    if (button.offsetTop < list.scrollTop) {
      list.scrollTop = button.offsetTop;
    } else if (
      button.offsetTop + button.offsetHeight >
      list.scrollTop + list.clientHeight
    ) {
      list.scrollTop =
        button.offsetTop + button.offsetHeight - list.clientHeight;
    }
  }

  function updateOverflowMask() {
    if (!state.list) return;
    state.list.classList.toggle(
      "codexMessageRailListOverflowing",
      state.list.scrollHeight > state.list.clientHeight + 1,
    );
  }

  const rootObserver = new MutationObserver((mutations) => {
    if (mutationTouchesConversation(mutations)) scheduleEnsure();
  });
  rootObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("resize", () => {
    scheduleActiveUpdate();
    positionTooltip();
    updateOverflowMask();
  });

  ensureMounted();
})();
