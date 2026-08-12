function normalizeForkedEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("Fork transcript entry must be an object");
  }
  return {
    ...entry,
    entrypoint: "claude-vscode",
  };
}

async function forkAndPrepareSession(store, sourceSessionId, resumeAtMessageId) {
  if (
    !store ||
    typeof store.fetchSessions !== "function" ||
    typeof store.forkSession !== "function" ||
    typeof store.renameSession !== "function"
  ) {
    throw new TypeError("Fork session store is missing required methods");
  }

  let sourceTitle = "";
  try {
    const sessions = await store.fetchSessions();
    const source = sessions.find((session) => session?.id === sourceSessionId);
    sourceTitle = String(source?.summary || "").trim();
  } catch {
    // Forking is still safe when the list scan fails. The fallback title below
    // keeps the new transcript discoverable by the same list scanner.
  }

  const forkedSessionId = await store.forkSession(
    sourceSessionId,
    resumeAtMessageId,
  );
  await store.renameSession(
    forkedSessionId,
    sourceTitle || "Forked conversation",
    false,
  );
  return forkedSessionId;
}

module.exports = {
  forkAndPrepareSession,
  normalizeForkedEntry,
};
