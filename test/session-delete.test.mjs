import assert from "node:assert/strict";
import test from "node:test";
import { patchSessionDeletionState } from "../scripts/lib.mjs";

const nativeDeleteMethod =
  "async deleteSession(e){if(this.sessions.value=this.sessions.value.filter((i)=>i!==e),this.activeSession.value===e){if(this.activeSession.value=this.sessions.value[0],!this.activeSession.value)this.createSession()}let t=e.sessionId.value;if(t)await(await this.getConnection()).deleteSession(t)}";
const nativeSyntheticMerge =
  "let r=e.sessions.value,s=i.value,a=Jn(()=>{let R=new Set(r.map((N)=>N.sessionId.value));return s.filter((N)=>!R.has(N.sessionId)).filter((N)=>N.title||N.state!==\"idle\")";
const updatedNativeSyntheticMerge =
  "let r=e.sessions.value,s=i.value,a=to(()=>{let D=new Set(r.map((W)=>W.sessionId.value));return s.filter((W)=>!D.has(W.sessionId)).filter((W)=>W.title||W.state!==\"idle\")";

const fixture = [
  "class SessionsStore{",
  "listSessionsPromise;lastLocalRenameAt=new Map;",
  nativeDeleteMethod,
  "async doListSessions(){let i={sessions:[]},o=[];for(let a of i.sessions){if(!a.isCurrentWorkspace)continue;let l=o.find(()=>false)}}",
  "}",
  "function sessionList(e,i){",
  nativeSyntheticMerge,
  "}",
].join("");

function extractStore(source) {
  const start = source.indexOf("class SessionsStore{");
  const end = source.indexOf("function sessionList", start);
  assert.notEqual(start, -1, "session store is present");
  assert.notEqual(end, -1, "session store has a following fixture anchor");
  const classSource = source.slice(start, end);
  return Function(`${classSource};return SessionsStore`)();
}

test("a hidden open session disappears immediately without waiting for Reload", async () => {
  const patched = patchSessionDeletionState(fixture);
  const Store = extractStore(patched);
  const hostDeletes = [];
  const session = { sessionId: { value: "open-session" } };
  const store = new Store();
  store.sessions = { value: [session] };
  store.activeSession = { value: null };
  store.createSession = () => {};
  store.getConnection = async () => ({
    deleteSession: async (id) => hostDeletes.push(id),
  });

  await store.deleteSession(session);

  const openEditorStates = [
    { sessionId: "open-session", state: "idle", title: "Deleted session" },
  ];
  const knownIds = new Set([
    ...store.sessions.value.map((item) => item.sessionId.value),
    ...(store.locallyDeletedSessionIds || []),
  ]);
  const visibleIds = [
    ...store.sessions.value.map((item) => item.sessionId.value),
    ...openEditorStates
      .filter((item) => !knownIds.has(item.sessionId))
      .filter((item) => item.title || item.state !== "idle")
      .map((item) => item.sessionId),
  ];

  assert.deepEqual(hostDeletes, ["open-session"]);
  assert.ok(
    !visibleIds.includes("open-session"),
    "the deleted session was reconstructed from the open-editor session state",
  );
  assert.match(
    patched,
    /new Set\(\[\.\.\.r\.map\(\(N\)=>N\.sessionId\.value\),\.\.\.e\.locallyDeletedSessionIds\]\)/,
    "the real session-list merge must exclude locally hidden IDs",
  );
  assert.match(
    patched,
    /if\(!a\.isCurrentWorkspace\|\|this\.locallyDeletedSessionIds\.has\(a\.id\)\)continue/,
    "an in-flight server response must not re-add a locally hidden session",
  );
});

test("a failed host delete rolls the optimistic hide back", async () => {
  const patched = patchSessionDeletionState(fixture);
  const Store = extractStore(patched);
  const session = { sessionId: { value: "failed-session" } };
  const store = new Store();
  store.sessions = { value: [session] };
  store.activeSession = { value: null };
  store.createSession = () => {};
  store.listSessions = async () => {
    store.sessions.value = [session];
  };
  store.getConnection = async () => ({
    deleteSession: async () => {
      throw new Error("host delete failed");
    },
  });

  await assert.rejects(store.deleteSession(session), /host delete failed/);
  assert.equal(store.locallyDeletedSessionIds?.has("failed-session"), false);
  assert.deepEqual(store.sessions.value, [session]);
});

test("session deletion supports the synthetic merge bindings from 2.1.238", () => {
  const updatedFixture = fixture.replace(
    nativeSyntheticMerge,
    updatedNativeSyntheticMerge,
  );
  const patched = patchSessionDeletionState(updatedFixture);

  assert.match(
    patched,
    /new Set\(\[\.\.\.r\.map\(\(W\)=>W\.sessionId\.value\),\.\.\.e\.locallyDeletedSessionIds\]\)/,
  );
});
