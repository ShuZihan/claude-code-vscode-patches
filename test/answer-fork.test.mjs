import assert from "node:assert/strict";
import test from "node:test";
import {
  extractUserPromptText,
  resolveAnswerForkTarget,
} from "../patches/files/webview/codex-answer-fork.js";

const promptText = (message) => message.text || "";

test("answer Fork extracts text without a minified vendor helper", () => {
  assert.equal(
    extractUserPromptText({
      content: [
        { content: { type: "image", source: {} } },
        { content: { type: "text", text: "First " } },
        { content: { type: "text", text: "question" } },
      ],
    }),
    "First question",
  );
});

test("answer Fork mirrors the next real user message's native fork point", () => {
  const answer = { type: "assistant", uuid: "answer-1" };
  const messages = [
    { type: "user", uuid: "question-1", text: "First question" },
    answer,
    { type: "progress", uuid: "progress-1" },
    { type: "user", uuid: "synthetic", isSynthetic: true, text: "ignore" },
    { type: "user", uuid: "question-2", text: "  Follow up  " },
  ];

  assert.deepEqual(
    resolveAnswerForkTarget({
      messages,
      answerMessage: answer,
      answerIndex: 1,
      getPromptText: promptText,
    }),
    {
      mode: "next-user",
      promptText: "Follow up",
      resumeAtMessageId: "synthetic",
    },
  );
});

test("answer Fork copies the complete session when no later question exists", () => {
  const answer = { type: "assistant", uuid: "answer-last" };
  const messages = [
    { type: "user", uuid: "question-1", text: "Question" },
    answer,
    { type: "progress", uuid: "progress-after-answer" },
  ];

  assert.deepEqual(
    resolveAnswerForkTarget({
      messages,
      answerMessage: answer,
      answerIndex: 1,
      getPromptText: promptText,
    }),
    {
      mode: "copy-session",
      promptText: "",
      resumeAtMessageId: "answer-last",
    },
  );
});

test("answer Fork resolves a cloned answer by UUID before using its index fallback", () => {
  const messages = [
    { type: "user", uuid: "question-1", text: "Question" },
    { type: "assistant", uuid: "answer-1" },
    { type: "assistant", uuid: "answer-2" },
    { type: "user", uuid: "question-2", text: "Next" },
  ];

  assert.deepEqual(
    resolveAnswerForkTarget({
      messages,
      answerMessage: { type: "assistant", uuid: "answer-1" },
      answerIndex: 99,
      getPromptText: promptText,
    }),
    {
      mode: "next-user",
      promptText: "Next",
      resumeAtMessageId: "answer-2",
    },
  );
});
