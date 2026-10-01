import { test } from "node:test";
import assert from "node:assert/strict";
import { createConsole } from "../src/console.js";

test("the in-tab console follows the same rules as the middleware", async () => {
  const api = createConsole({ workMs: 20 });
  const [a, b] = await Promise.all([
    api.post({ key: '"k1"', body: { amount: 500 } }),
    api.post({ key: '"k1"', body: { amount: 500 } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);

  const replay = await api.post({ key: '"k1"', body: { amount: 500 } });
  assert.equal(replay.headers["idempotent-replayed"], "true");
  assert.equal((await api.post({ key: '"k1"', body: { amount: 700 } })).status, 422);
  assert.equal((await api.post({ key: "", body: { amount: 1 } })).status, 400);
  assert.equal(api.charges, 1);
});
