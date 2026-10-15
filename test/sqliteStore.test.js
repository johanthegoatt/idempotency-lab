import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeContract } from "./storeContract.js";

// node:sqlite arrived in Node 22.5; on older Node these tests are skipped.
let createSqliteStore = null;
try {
  await import("node:sqlite");
  ({ createSqliteStore } = await import("../src/sqliteStore.js"));
} catch {
  createSqliteStore = null;
}

if (createSqliteStore) {
  storeContract("sqlite store", (options) => createSqliteStore(options));

  test("sqlite store: a saved response survives reopening the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    try {
      const path = join(dir, "keys.db");
      const first = await createSqliteStore({ path });
      const { token } = first.begin("k", "fp", 0);
      first.complete("k", token, { status: 201, headers: { "content-type": "application/json" }, body: "e30=", encoding: "base64" }, 5);
      first.close();
      const reopened = await createSqliteStore({ path });
      const again = reopened.begin("k", "fp", 10);
      assert.equal(again.kind, "replay");
      assert.equal(again.response.encoding, "base64");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sqlite store: two connections to one file cannot both claim a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    try {
      const path = join(dir, "keys.db");
      const a = await createSqliteStore({ path });
      const b = await createSqliteStore({ path });
      assert.equal(a.begin("k", "fp", 0).kind, "new");
      assert.equal(b.begin("k", "fp", 1).kind, "in-flight");
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
} else {
  test("sqlite store", { skip: "node:sqlite needs Node 22.5 or later" }, () => {});
}
