import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import forkSessionRuntime from "../patches/files/codex-fork-session.cjs";

const HEAD_LIMIT = 64 * 1024;

function createStoreWithLargeFork() {
  const sourceSessionId = "source-session";
  const forkedSessionId = "forked-session";
  const transcripts = new Map([
    [sourceSessionId, `${JSON.stringify({ type: "user", message: { content: "Original question" } })}\n${JSON.stringify({ type: "custom-title", customTitle: "Original conversation" })}\n`],
  ]);

  function listSessions() {
    const sessions = [];
    for (const [sessionId, transcript] of transcripts) {
      const head = transcript.slice(0, HEAD_LIMIT);
      const tail = transcript.slice(-HEAD_LIMIT);
      const firstEntrypoint = /"entrypoint":"([^"]+)"/.exec(head)?.[1];
      if (["sdk-cli", "sdk-ts", "sdk-py"].includes(firstEntrypoint)) {
        continue;
      }
      const title = /"customTitle":"([^"]+)"/.exec(tail)?.[1];
      const prompt = /"type":"user"[^\n]*"content":"([^"]+)"/.exec(head)?.[1];
      if (title || prompt) sessions.push({ id: sessionId, summary: title || prompt });
    }
    return sessions;
  }

  return {
    sourceSessionId,
    forkedSessionId,
    transcripts,
    async fetchSessions() {
      return listSessions();
    },
    async forkSession() {
      const oversizedSystemEntry = JSON.stringify(
        forkSessionRuntime.normalizeForkedEntry({
          type: "system",
          uuid: "system-entry",
          entrypoint: "sdk-ts",
          message: { content: "x".repeat(70 * 1024) },
        }),
      );
      const userEntry = JSON.stringify(
        forkSessionRuntime.normalizeForkedEntry({
          type: "user",
          uuid: "user-entry",
          entrypoint: "sdk-ts",
          message: { content: "Original question" },
        }),
      );
      transcripts.set(forkedSessionId, `${oversizedSystemEntry}\n${userEntry}\n`);
      return forkedSessionId;
    },
    async renameSession(sessionId, title) {
      transcripts.set(
        sessionId,
        `${transcripts.get(sessionId)}${JSON.stringify({ type: "custom-title", customTitle: title })}\n`,
      );
    },
  };
}

test("a fork whose first prompt is beyond 64 KiB opens with history instead of an empty draft", async () => {
  const store = createStoreWithLargeFork();

  const forkedSessionId = await forkSessionRuntime.forkAndPrepareSession(
    store,
    store.sourceSessionId,
    "resume-message",
  );
  const listed = await store.fetchSessions();
  const activated = listed.find((session) => session.id === forkedSessionId);
  const opened = activated
    ? { history: store.transcripts.get(forkedSessionId), draft: "" }
    : { history: "", draft: "Follow-up question" };

  assert.ok(
    opened.history.includes('"type":"user"'),
    "fork startup fell back to an empty session with only the draft prompt",
  );
  assert.equal(opened.draft, "");
});

test("the native fork request is routed through the discoverability guard", () => {
  const patcherSource = readFileSync(
    new URL("../scripts/apply-patches.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    patcherSource,
    /CodexForkSession\.forkAndPrepareSession\(await \$\{sessionStoreBinding\}\.load/,
  );
  assert.match(patcherSource, /CodexForkSession\.normalizeForkedEntry/);
});

test("forked SDK transcript entries are marked as VS Code sessions", () => {
  assert.deepEqual(
    forkSessionRuntime.normalizeForkedEntry({
      type: "system",
      entrypoint: "sdk-ts",
      uuid: "system-entry",
    }),
    {
      type: "system",
      entrypoint: "claude-vscode",
      uuid: "system-entry",
    },
  );
});
