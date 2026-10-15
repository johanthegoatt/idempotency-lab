// A durable key store with the same contract as createStore(), on Node's
// built-in SQLite (node:sqlite, Node 22.5+). In-memory keys vanish on a
// restart and are not shared between processes, which is exactly when a
// client's retry lands somewhere new and charges twice. Several processes
// can open one file: begin() runs in an IMMEDIATE transaction, so only one
// of them can claim a key.
import { randomInt } from "node:crypto";

const DAY = 24 * 60 * 60 * 1000;

export async function createSqliteStore({ path = ":memory:", ttlMs = DAY, leaseMs = 30_000 } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      token INTEGER,
      created_at INTEGER NOT NULL,
      lease_until INTEGER,
      response TEXT
    );
  `);

  const get = db.prepare("SELECT * FROM idempotency_keys WHERE key = ?");
  const remove = db.prepare("DELETE FROM idempotency_keys WHERE key = ?");
  const insert = db.prepare(
    "INSERT INTO idempotency_keys (key, state, fingerprint, token, created_at, lease_until) VALUES (?, 'processing', ?, ?, ?, ?)",
  );
  const finish = db.prepare(
    `UPDATE idempotency_keys SET state = 'done', response = ?, token = NULL, lease_until = NULL
     WHERE key = ? AND state = 'processing' AND token = ? AND lease_until > ? AND created_at + ? > ?`,
  );
  const drop = db.prepare("DELETE FROM idempotency_keys WHERE key = ? AND state = 'processing' AND token = ?");
  const prune = db.prepare(
    "DELETE FROM idempotency_keys WHERE created_at + ? <= ? OR (state = 'processing' AND lease_until <= ?)",
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys");

  function live(key, now) {
    const r = get.get(key);
    if (!r) return null;
    if (now >= r.created_at + ttlMs || (r.state === "processing" && now >= r.lease_until)) {
      remove.run(key);
      return null;
    }
    return r;
  }

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    ttlMs,
    leaseMs,
    begin(key, fingerprint, now) {
      return transaction(() => {
        const r = live(key, now);
        if (r && r.fingerprint !== fingerprint) return { kind: "mismatch" };
        if (r && r.state === "done") return { kind: "replay", response: JSON.parse(r.response) };
        if (r) return { kind: "in-flight", retryAfterMs: r.lease_until - now };
        // Random rather than a counter: several processes hand out tokens.
        const token = randomInt(1, 2 ** 47);
        insert.run(key, fingerprint, token, now, now + leaseMs);
        return { kind: "new", token };
      });
    },
    complete(key, token, response, now) {
      return finish.run(JSON.stringify(response), key, token, now, ttlMs, now).changes === 1;
    },
    release(key, token) {
      return drop.run(key, token).changes === 1;
    },
    sweep(now) {
      prune.run(ttlMs, now, now);
      return count.get().n;
    },
    get size() {
      return count.get().n;
    },
    close() {
      db.close();
    },
  };
}
