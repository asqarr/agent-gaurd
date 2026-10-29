import assert from "node:assert/strict";
import test from "node:test";
import { mapConcurrent } from "../src/features/sentinel/sentinel-worker.mjs";

test("Sentinel checks never exceed the configured concurrency and retain result order", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});

test("Sentinel worker can process a 10,000-target batch with bounded concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapConcurrent(Array.from({ length: 10_000 }, (_, index) => index), 8, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    return value;
  });

  assert.equal(results.length, 10_000);
  assert.equal(results[0], 0);
  assert.equal(results.at(-1), 9_999);
  assert.equal(maxActive, 8);
});

test("Sentinel batch waits for every in-flight check before reporting a failure", async () => {
  let completed = 0;
  await assert.rejects(
    mapConcurrent([1, 2, 3], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 1 : 5));
      completed += 1;
      if (value === 1) throw new Error("check failed");
      return value;
    }),
    /check failed/,
  );
  assert.equal(completed, 3);
});
