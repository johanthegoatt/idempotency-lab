import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, createStore, fingerprintSource, parseIdempotencyKey, planRequest } from "../src/core.js";
import { storeContract } from "./storeContract.js";

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

storeContract("in-memory store", (options) => createStore(options));

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
