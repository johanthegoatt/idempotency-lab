import { test } from "node:test";
import assert from "node:assert/strict";
import { server } from "../server.js";

test("demo server serves the page and an idempotent /api/charges", async (t) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Idempotency Lab/);
  assert.equal((await fetch(base + "/server.js")).status, 404);

  const charge = () => fetch(base + "/api/charges", {
    method: "POST",
    headers: { "idempotency-key": '"order-1"', "content-type": "application/json" },
    body: '{"amount":500}',
  });
  const first = await charge();
  const again = await charge();
  assert.equal(first.status, 201);
  assert.deepEqual(await again.json(), await first.json());
  assert.equal(again.headers.get("idempotent-replayed"), "true");
});
