import { test } from "node:test";
import assert from "node:assert/strict";

// The rules every key store must follow, run against each implementation.
export function storeContract(name, makeStore) {
  test(`${name}: first use executes, completion is replayed, other payloads are refused`, async () => {
    const store = await makeStore();
    const first = store.begin("k", "fp1", 0);
    assert.equal(first.kind, "new");
    assert.equal(store.begin("k", "fp1", 5).kind, "in-flight");
    assert.equal(store.begin("k", "fp2", 5).kind, "mismatch");
    assert.ok(store.complete("k", first.token, { status: 201, headers: {}, body: "ok" }, 10));
    const again = store.begin("k", "fp1", 20);
    assert.equal(again.kind, "replay");
    assert.equal(again.response.status, 201);
  });

  test(`${name}: an expired lease lets a retry take over, and the stale worker cannot complete`, async () => {
    const store = await makeStore({ leaseMs: 100 });
    const dead = store.begin("k", "fp", 0);
    assert.equal(store.begin("k", "fp", 99).kind, "in-flight");
    const fresh = store.begin("k", "fp", 100);
    assert.equal(fresh.kind, "new");
    assert.equal(store.complete("k", dead.token, { status: 200 }, 150), false);
    assert.equal(store.complete("k", fresh.token, { status: 201 }, 150), true);
    assert.equal(store.begin("k", "fp", 160).response.status, 201);
  });

  test(`${name}: keys expire after the TTL and are pruned by sweep`, async () => {
    const store = await makeStore({ ttlMs: 1000 });
    const t = store.begin("k", "fp", 0).token;
    store.complete("k", t, { status: 200 }, 1);
    assert.equal(store.begin("k", "fp", 999).kind, "replay");
    assert.equal(store.sweep(1000), 0);
    assert.equal(store.begin("k", "other", 1000).kind, "new");
  });

  test(`${name}: release frees the key only for the lease holder`, async () => {
    const store = await makeStore();
    const { token } = store.begin("k", "fp", 0);
    assert.equal(store.release("k", token + 1), false);
    assert.equal(store.release("k", token), true);
    assert.equal(store.begin("k", "fp", 1).kind, "new");
  });
}
