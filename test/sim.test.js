import { test } from "node:test";
import assert from "node:assert/strict";
import { backoff, compare, rng, simulate } from "../src/sim.js";

const strip = (r) => JSON.stringify({ ...r, customerLog: undefined });

test("a seed fully determines a run", () => {
  assert.equal(strip(simulate({ seed: 42 })), strip(simulate({ seed: 42 })));
  assert.notEqual(strip(simulate({ seed: 42 })), strip(simulate({ seed: 43 })));
});

test("with keys nobody is charged twice, across many seeds", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { naive, keyed } = compare({ seed });
    assert.equal(keyed.duplicateCharges, 0, `seed ${seed}`);
    assert.equal(keyed.charges, keyed.customers - keyed.gaveUp + keyed.gaveUpButCharged);
    assert.ok(naive.duplicateCharges > 0, `seed ${seed} should show the bug`);
  }
});

test("a perfect network needs no keys and makes no retries", () => {
  const perfect = { requestLoss: 0, responseLoss: 0, slowRate: 0, outageMs: 0 };
  const { naive, keyed } = compare(perfect);
  assert.equal(naive.requests, naive.customers);
  assert.equal(naive.duplicateCharges, 0);
  assert.equal(keyed.replays + keyed.conflicts, 0);
});

test("a lease shorter than the slow path lets duplicates back in", () => {
  const short = simulate({ leaseMs: 500, slowMs: 1600, slowRate: 0.3 }, true);
  assert.ok(short.duplicateCharges > 0);
  const long = simulate({ leaseMs: 5000, slowMs: 1600, slowRate: 0.3 }, true);
  assert.equal(long.duplicateCharges, 0);
});

test("backoff stays under the cap for every jitter mode", () => {
  const random = rng(1);
  const cfg = { baseMs: 100, capMs: 1000 };
  assert.equal(backoff(1, { ...cfg, jitter: "none" }, random), 100);
  assert.equal(backoff(3, { ...cfg, jitter: "none" }, random), 400);
  assert.equal(backoff(9, { ...cfg, jitter: "none" }, random), 1000);
  for (let n = 1; n < 12; n++) {
    const full = backoff(n, { ...cfg, jitter: "full" }, random);
    const equal = backoff(n, { ...cfg, jitter: "equal" }, random);
    const ceiling = Math.min(1000, 100 * 2 ** (n - 1));
    assert.ok(full >= 0 && full <= ceiling);
    assert.ok(equal >= ceiling / 2 && equal <= ceiling);
  }
});

test("the trace of a double charge shows how it happened", () => {
  const { naive } = compare();
  const log = naive.customerLog(naive.firstDoubleCharged).map(([, m]) => m);
  assert.ok(log.some((m) => m.startsWith("card charged again")));
  assert.ok(log.some((m) => m.includes("timed out") || m.includes("reply was lost")));
});
