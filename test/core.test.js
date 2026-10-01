import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, createStore, fingerprintSource, parseIdempotencyKey, planRequest } from "../src/core.js";

test("parses Structured Field strings and bare tokens", () => {
  assert.deepEqual(parseIdempotencyKey('"8e03978e-40d5"'), { ok: true, key: "8e03978e-40d5" });
  assert.deepEqual(parseIdempotencyKey('"a \\"quoted\\" key"'), { ok: true, key: 'a "quoted" key' });
  assert.deepEqual(parseIdempotencyKey("KG5LxwFBepaKHyUD"), { ok: true, key: "KG5LxwFBepaKHyUD" });
});

test("rejects missing, malformed and oversized keys", () => {
  assert.equal(parseIdempotencyKey(undefined).reason, "missing");
  assert.equal(parseIdempotencyKey("").reason, "missing");
  assert.equal(parseIdempotencyKey('"unterminated').reason, "invalid");
  assert.equal(parseIdempotencyKey('"a"trailing').reason, "invalid");
  assert.equal(parseIdempotencyKey('"bad \\n escape"').reason, "invalid");
  assert.equal(parseIdempotencyKey('""').reason, "invalid");
  assert.equal(parseIdempotencyKey("has space").reason, "invalid");
  assert.equal(parseIdempotencyKey(`"${"x".repeat(256)}"`).reason, "too-long");
});

test("canonical JSON ignores key order at every depth", () => {
  const a = canonicalJson({ b: 2, a: { y: [1, { d: 1, c: 2 }], x: null } });
  const b = canonicalJson({ a: { x: null, y: [1, { c: 2, d: 1 }] }, b: 2 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"x":null,"y":[1,{"c":2,"d":1}]},"b":2}');
});

test("fingerprints pin method, path and payload", () => {
  const json = "application/json";
  assert.equal(fingerprintSource("post", "/charges", '{"b":1,"a":2}', json),
    fingerprintSource("POST", "/charges", '{"a":2,"b":1}', json));
  assert.notEqual(fingerprintSource("POST", "/charges", "{}", json), fingerprintSource("POST", "/refunds", "{}", json));
  assert.equal(fingerprintSource("POST", "/x", "{not json", json), "POST /x\n{not json");
});

test("first use executes, completion is replayed, other payloads are refused", () => {
  const store = createStore();
  const first = store.begin("k", "fp1", 0);
  assert.equal(first.kind, "new");
  assert.equal(store.begin("k", "fp1", 5).kind, "in-flight");
  assert.equal(store.begin("k", "fp2", 5).kind, "mismatch");
  assert.ok(store.complete("k", first.token, { status: 201, headers: {}, body: "ok" }, 10));
  const again = store.begin("k", "fp1", 20);
  assert.equal(again.kind, "replay");
  assert.equal(again.response.status, 201);
});

test("an expired lease lets a retry take over, and the stale worker cannot complete", () => {
  const store = createStore({ leaseMs: 100 });
  const dead = store.begin("k", "fp", 0);
  assert.equal(store.begin("k", "fp", 99).kind, "in-flight");
  const fresh = store.begin("k", "fp", 100);
  assert.equal(fresh.kind, "new");
  assert.equal(store.complete("k", dead.token, { status: 200 }, 150), false);
  assert.equal(store.complete("k", fresh.token, { status: 201 }, 150), true);
  assert.equal(store.begin("k", "fp", 160).response.status, 201);
});

test("keys expire after the TTL and are pruned by sweep", () => {
  const store = createStore({ ttlMs: 1000 });
  const t = store.begin("k", "fp", 0).token;
  store.complete("k", t, { status: 200 }, 1);
  assert.equal(store.begin("k", "fp", 999).kind, "replay");
  assert.equal(store.sweep(1000), 0);
  assert.equal(store.begin("k", "other", 1000).kind, "new");
});

test("release frees the key only for the lease holder", () => {
  const store = createStore();
  const { token } = store.begin("k", "fp", 0);
  assert.equal(store.release("k", token + 1), false);
  assert.equal(store.release("k", token), true);
  assert.equal(store.begin("k", "fp", 1).kind, "new");
});

test("planRequest maps outcomes to the draft's status codes", () => {
  const store = createStore();
  const base = { fingerprint: "fp", now: 0 };
  assert.equal(planRequest(store, { ...base, rawKey: undefined }).response.status, 400);
  assert.equal(planRequest(store, { ...base, rawKey: undefined, required: false }).action, "passthrough");

  const run = planRequest(store, { ...base, rawKey: '"k1"' });
  assert.equal(run.action, "execute");

  const busy = planRequest(store, { ...base, rawKey: '"k1"', now: 1 });
  assert.equal(busy.response.status, 409);
  assert.equal(busy.response.headers["retry-after"], "1");

  const reused = planRequest(store, { ...base, rawKey: '"k1"', fingerprint: "other" });
  assert.equal(reused.response.status, 422);
  assert.equal(JSON.parse(reused.response.body).title, "Idempotency-Key is already used");

  store.complete(run.storeKey, run.token, { status: 201, headers: { "content-type": "application/json" }, body: "{}" }, 2);
  const replay = planRequest(store, { ...base, rawKey: '"k1"', now: 3 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.response.headers["idempotent-replayed"], "true");
});

test("keys are scoped per caller", () => {
  const store = createStore();
  const alice = planRequest(store, { rawKey: "order-1", fingerprint: "a", scope: "alice", now: 0 });
  const bob = planRequest(store, { rawKey: "order-1", fingerprint: "b", scope: "bob", now: 0 });
  assert.equal(alice.action, "execute");
  assert.equal(bob.action, "execute");
});
