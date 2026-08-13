import assert from "node:assert/strict";
import test from "node:test";

import {
  bindOwnedReactHooks,
  discoverReactHookBindings,
  verifyOwnedReactRuntimeBindings,
} from "../scripts/lib.mjs";

const vendor231Fixture =
  "se=function(e,t){return zf.current.useEffect(e,t)},ge=function(e){return zf.current.useRef(e)},ne=function(e){return zf.current.useState(e)}";

test("owned components bind to the current vendor React hooks", () => {
  const hooks = discoverReactHookBindings(vendor231Fixture);
  assert.deepEqual(hooks, { useState: "ne", useEffect: "se" });

  const bound = bindOwnedReactHooks(
    "function Owned(){let[e,t]=ie(!1)}",
    hooks,
  );
  assert.equal(bound, "function Owned(){let[e,t]=ne(!1)}");
});

test("hook discovery rejects ambiguous vendor bindings", () => {
  assert.throws(
    () =>
      discoverReactHookBindings(
        `${vendor231Fixture},xy=function(e){return zf.current.useState(e)}`,
      ),
    /React useState binding: expected 1 match, found 2/,
  );
});

const runtimeFixture = ({ state = "ne", effect = "se" } = {}) =>
  `${vendor231Fixture};var b=jsxFactory,I=jsxFactory;function CodexCopyMarkdownButton(){let[e,t]=${state}(!1)}function CodexForkAnswerButton(){let[e,t]=${state}(!1)}function Chat(){${effect}(()=>{window.__claudeCodexProviderUsageCwd=e.cwd.value,window.ClaudeCodexProviderUsage?.setCwd(e.cwd.value)},[e,e.cwd.value])}`;

test("runtime verification catches the exact 2.1.231 class-hook crash", () => {
  assert.throws(
    () => verifyOwnedReactRuntimeBindings(runtimeFixture({ state: "ie" })),
    /owned components call ie, ie, vendor useState is ne/,
  );
  assert.throws(
    () => verifyOwnedReactRuntimeBindings(runtimeFixture({ effect: "ce" })),
    /provider cwd calls ce, vendor useEffect is se/,
  );
  assert.deepEqual(verifyOwnedReactRuntimeBindings(runtimeFixture()), {
    useState: "ne",
    useEffect: "se",
  });
});
