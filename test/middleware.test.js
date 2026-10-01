import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createStore } from "../src/core.js";
import { createIdempotency } from "../src/middleware.js";

// A tiny charges API on a real socket. `gate` lets a test hold the handler
// open to observe the in-flight state.
async function boot(options = {}) {
  let charges = 0;
  let gate = null;
  const idem = createIdempotency({ store: createStore(), onError: () => {}, ...options });
  const server = createServer((req, res) =>
    idem(req, res, async () => {
      if (gate) await gate;
      const body = JSON.parse(req.body || "{}");
      if (body.explode) throw new Error("boom");
      charges++;
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.write('{"id":"ch_' + charges + '",');
      res.end('"amount":' + body.amount + "}");
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    charges: () => charges,
    hold() {
      let open;
      gate = new Promise((r) => (open = r));
      return () => { gate = null; open(); };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const post = (url, body, key, headers = {}) =>
  fetch(url + "/charges", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...headers },
    body: JSON.stringify(body),
  });

test("a retried POST is replayed, not charged twice", async (t) => {
  const app = await boot();
  t.after(app.close);
  const first = await post(app.url, { amount: 500 }, '"pay-1"');
  const retry = await post(app.url, { amount: 500 }, '"pay-1"');
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(await retry.text(), await first.text());
  assert.equal(retry.headers.get("idempotent-replayed"), "true");
  assert.equal(first.headers.get("idempotent-replayed"), null);
  assert.equal(app.charges(), 1);
});

test("a body with reordered keys is the same request", async (t) => {
  const app = await boot();
  t.after(app.close);
  await post(app.url, { amount: 5, currency: "php" }, "k");
  const res = await post(app.url, { currency: "php", amount: 5 }, "k");
  assert.equal(res.status, 201);
  assert.equal(app.charges(), 1);
});

test("missing key is 400, reuse with another payload is 422", async (t) => {
  const app = await boot();
  t.after(app.close);
  const missing = await post(app.url, { amount: 1 });
  assert.equal(missing.status, 400);
  assert.equal(missing.headers.get("content-type"), "application/problem+json");
  await post(app.url, { amount: 1 }, "k");
  const reused = await post(app.url, { amount: 2 }, "k");
  assert.equal(reused.status, 422);
  assert.equal(app.charges(), 1);
});

test("a concurrent duplicate gets 409 with Retry-After while the first runs", async (t) => {
  const app = await boot();
  t.after(app.close);
  const open = app.hold();
  const first = post(app.url, { amount: 9 }, "dup");
  await new Promise((r) => setTimeout(r, 30));
  const second = await post(app.url, { amount: 9 }, "dup");
  assert.equal(second.status, 409);
  assert.ok(Number(second.headers.get("retry-after")) >= 1);
  open();
  assert.equal((await first).status, 201);
  assert.equal(app.charges(), 1);
});

test("the same key from two credentials does not collide", async (t) => {
  const app = await boot();
  t.after(app.close);
  const a = await post(app.url, { amount: 1 }, "order-1", { authorization: "Bearer alice" });
  const b = await post(app.url, { amount: 2 }, "order-1", { authorization: "Bearer bob" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(app.charges(), 2);
});

test("a handler that throws releases the key so the retry runs", async (t) => {
  const app = await boot();
  t.after(app.close);
  const failed = await post(app.url, { amount: 1, explode: true }, "k");
  assert.equal(failed.status, 500);
  const fixed = await post(app.url, { amount: 1, explode: true }, "k");
  assert.equal(fixed.status, 500);
  assert.equal(fixed.headers.get("idempotent-replayed"), null);
});

test("GET is left alone and bodies over the limit are refused", async (t) => {
  const app = await boot({ maxBody: 16 });
  t.after(app.close);
  const big = await post(app.url, { amount: 1, pad: "x".repeat(64) }, "k");
  assert.equal(big.status, 413);
  const get = await fetch(app.url + "/charges");
  assert.equal(get.status, 201);
});
