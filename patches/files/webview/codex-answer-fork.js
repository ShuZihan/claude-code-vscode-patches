export function extractUserPromptText(message) {
  if (!Array.isArray(message?.content)) return "";
  const text = [];
  for (const block of message.content) {
    const content = block?.content ?? block;
    if (content?.type === "text" && typeof content.text === "string") {
      text.push(content.text);
    }
  }
  return text.join("").trim();
}

export function resolveAnswerForkTarget({
  messages,
  answerMessage,
  answerIndex,
  getPromptText,
}) {
  if (
    !Array.isArray(messages) ||
    !answerMessage?.uuid
  ) {
    return null;
  }
  const promptExtractor =
    typeof getPromptText === "function" ? getPromptText : extractUserPromptText;

  let currentIndex = messages.indexOf(answerMessage);
  if (currentIndex < 0) {
    currentIndex = messages.findIndex(
      (message) => message?.uuid === answerMessage.uuid,
    );
  }
  if (currentIndex < 0 && Number.isInteger(answerIndex)) {
    currentIndex = answerIndex;
  }
  if (currentIndex < 0 || currentIndex >= messages.length) return null;

  for (let index = currentIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (
      candidate?.type !== "user" ||
      candidate.isSynthetic ||
      !candidate.uuid ||
      candidate.parentToolUseId
    ) {
      continue;
    }

    const promptText = String(promptExtractor(candidate) || "").trim();
    if (!promptText) continue;

    let resumeAtMessageId = null;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const message = messages[previous];
      if (
        message?.uuid &&
        (message.type === "assistant" || message.type === "user")
      ) {
        resumeAtMessageId = message.uuid;
        break;
      }
    }

    return {
      mode: "next-user",
      promptText,
      resumeAtMessageId: resumeAtMessageId || answerMessage.uuid,
    };
  }

  return {
    mode: "copy-session",
    promptText: "",
    resumeAtMessageId: answerMessage.uuid,
  };
}

if (typeof window !== "undefined") {
  window.ClaudeCodexAnswerFork = Object.freeze({
    extractUserPromptText,
    resolveAnswerForkTarget,
  });
}
