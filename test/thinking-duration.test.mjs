import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { patchThinkingDurationState } from "../scripts/lib.mjs";

const vendorFixture =
  "class ThinkingBlock{partial;endTime=null;startTime=null;lastModifiedTime=Date.now();constructor(e=!1){this.partial=e;if(this.partial)this.startTime=Date.now()}complete(){this.partial=!1,this.lastModifiedTime=Date.now(),this.endTime=Date.now()}adoptTimingFrom(e){this.startTime=e.startTime,this.endTime=e.endTime}get durationMillis(){if(!this.startTime)return null;if(this.endTime)return this.endTime-this.startTime;return Date.now()-this.startTime}}";

function createHarness() {
  let now = 1_000;
  class ControlledDate extends Date {
    static now() {
      return now;
    }
  }
  const context = { Date: ControlledDate, Math, ThinkingBlock: undefined };
  vm.runInNewContext(
    patchThinkingDurationState(vendorFixture).replace(
      /^class ThinkingBlock/,
      "ThinkingBlock=class ThinkingBlock",
    ),
    context,
  );
  return {
    ThinkingBlock: context.ThinkingBlock,
    setNow(value) {
      now = value;
    },
  };
}

test("a streaming thinking block keeps a live duration", () => {
  const harness = createHarness();
  const block = new harness.ThinkingBlock(true);
  harness.setNow(5_000);
  assert.equal(block.durationMillis, 4_000);
  harness.setNow(8_000);
  assert.equal(block.durationMillis, 7_000);
});

test("a final replacement freezes even when no stop event set endTime", () => {
  const harness = createHarness();
  const streaming = new harness.ThinkingBlock(true);
  harness.setNow(5_000);
  const finalBlock = new harness.ThinkingBlock(false);
  finalBlock.adoptTimingFrom(streaming);

  assert.equal(finalBlock.durationMillis, 4_000);
  harness.setNow(20_000);
  assert.equal(
    finalBlock.durationMillis,
    4_000,
    "expand/collapse rerenders must not advance a completed label",
  );
});

test("an explicit stop event remains authoritative", () => {
  const harness = createHarness();
  const block = new harness.ThinkingBlock(true);
  harness.setNow(4_000);
  block.complete();
  harness.setNow(20_000);
  assert.equal(block.durationMillis, 3_000);
});

test("reloaded history without runtime timing stays durationless", () => {
  const harness = createHarness();
  const block = new harness.ThinkingBlock(false);
  harness.setNow(20_000);
  assert.equal(block.durationMillis, null);
});
