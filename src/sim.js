// A discrete-event simulation of customers paying through a flaky network.
//
// Every customer sends one POST /charges. Requests can be lost on the way in,
// responses can be lost on the way out, and some requests are slow enough
// that the client times out while the server is still working. The client
// retries with exponential backoff. The same traffic runs twice: once with
// no key, where the server charges for every request it receives, and once
// through the real store and planRequest() from core.js.
//
// Backoff strategies are the ones compared in AWS's "Exponential Backoff And
// Jitter": none (sleep = cap(base * 2^n)), full (random between 0 and that),
// and equal (half fixed, half random).
import { createStore, planRequest } from "./core.js";

export const DEFAULTS = {
  customers: 200,
  spreadMs: 1000,       // customers start uniformly inside this window
  netMs: 40,            // one-way latency, +/- 50%
  requestLoss: 0.05,    // request never reaches the server
  responseLoss: 0.1,    // server finished, the reply never arrives
  serviceMs: 120,       // normal handling time
  slowRate: 0.08,       // share of requests that hit a slow path
  slowMs: 1600,         // handling time on the slow path
  outageAt: 300,        // the server drops everything arriving in
  outageMs: 500,        //   [outageAt, outageAt + outageMs)
  timeoutMs: 1000,      // client gives up waiting on one attempt
  maxAttempts: 5,
  baseMs: 100,
  capMs: 4000,
  jitter: "full",       // "none" | "full" | "equal"
  leaseMs: 10_000,
  bucketMs: 100,
  seed: 7,
};

// mulberry32: small, fast, and identical on every engine.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function backoff(attempt, { baseMs, capMs, jitter }, random) {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  if (jitter === "full") return random() * ceiling;
  if (jitter === "equal") return ceiling / 2 + random() * (ceiling / 2);
  return ceiling;
}

// Binary heap on (t, seq) so simultaneous events run in scheduling order and
// the whole run is deterministic for a seed.
function queue() {
  const h = [];
  let seq = 0;
  const less = (a, b) => a.t < b.t || (a.t === b.t && a.seq < b.seq);
  return {
    push(e) {
      e.seq = seq++;
      h.push(e);
      for (let i = h.length - 1; i > 0;) {
        const p = (i - 1) >> 1;
        if (!less(h[i], h[p])) break;
        [h[i], h[p]] = [h[p], h[i]];
        i = p;
      }
    },
    pop() {
      const top = h[0];
      const last = h.pop();
      if (h.length) {
        h[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < h.length && less(h[l], h[m])) m = l;
          if (r < h.length && less(h[r], h[m])) m = r;
          if (m === i) break;
          [h[i], h[m]] = [h[m], h[i]];
          i = m;
        }
      }
      return top;
    },
    get size() { return h.length; },
  };
}

export function simulate(options = {}, keyed = true) {
  const cfg = { ...DEFAULTS, ...options };
  const random = rng(cfg.seed);
  const store = createStore({ leaseMs: cfg.leaseMs });
  const q = queue();
  const lat = () => cfg.netMs * (0.5 + random());

  const customers = Array.from({ length: cfg.customers }, (_, id) => ({
    id, key: `"pay-${cfg.seed}-${id}"`, attempt: 0, failures: 0, current: -1,
    charges: 0, outcome: null, doneAt: null, startAt: random() * cfg.spreadMs, log: [],
  }));
  const stats = { requests: 0, arrivals: 0, charges: 0, replays: 0, conflicts: 0, lostRequests: 0, lostResponses: 0, timeouts: 0, dropped: 0 };
  const buckets = [];
  let nextAttempt = 0;

  for (const c of customers) q.push({ t: c.startAt, type: "send", c });

  // A 409 means the first attempt is alive and will settle, so it waits out
  // Retry-After without spending the failure budget. Spending it there was
  // the first version, and it made keyed clients give up on payments that
  // then went through.
  const retry = (c, t, why, retryAfterMs = null) => {
    if (retryAfterMs != null) {
      c.log.push([t, `${why}, waiting Retry-After ${retryAfterMs}ms`]);
      q.push({ t: t + retryAfterMs, type: "send", c });
      return;
    }
    c.failures++;
    if (c.failures >= cfg.maxAttempts) {
      c.outcome = "gave-up";
      c.log.push([t, `gave up after ${c.attempt} attempts`]);
      return;
    }
    const wait = backoff(c.failures, cfg, random);
    c.log.push([t, `${why}, retrying in ${Math.round(wait)}ms`]);
    q.push({ t: t + wait, type: "send", c });
  };

  const reply = (e, t, status, retryAfter = null) => {
    if (random() < cfg.responseLoss) {
      stats.lostResponses++;
      e.c.log.push([t, `server answered ${status}, the reply was lost`]);
      return;
    }
    q.push({ t: t + lat(), type: "reply", c: e.c, attempt: e.attempt, status, retryAfter });
  };

  while (q.size) {
    const e = q.pop();
    const { c, t } = e;
    switch (e.type) {
      case "send": {
        if (c.outcome) break;
        c.attempt++;
        c.current = nextAttempt++;
        stats.requests++;
        c.log.push([t, `attempt ${c.attempt} sent`]);
        q.push({ t: t + cfg.timeoutMs, type: "timeout", c, attempt: c.current });
        if (random() < cfg.requestLoss) {
          stats.lostRequests++;
          c.log.push([t, "request lost before the server"]);
        } else {
          q.push({ t: t + lat(), type: "arrive", c, attempt: c.current });
        }
        break;
      }
      case "arrive": {
        stats.arrivals++;
        const b = Math.floor(t / cfg.bucketMs);
        buckets[b] = (buckets[b] ?? 0) + 1;
        if (t >= cfg.outageAt && t < cfg.outageAt + cfg.outageMs) {
          stats.dropped++;
          c.log.push([t, "server down, request dropped"]);
          break;
        }
        const work = random() < cfg.slowRate ? cfg.slowMs : cfg.serviceMs * (0.5 + random());
        if (!keyed) {
          q.push({ t: t + work, type: "finish", c, attempt: e.attempt });
          break;
        }
        const plan = planRequest(store, { rawKey: c.key, fingerprint: `amount=${c.id}`, scope: "", now: t });
        if (plan.action === "execute") {
          q.push({ t: t + work, type: "finish", c, attempt: e.attempt, plan });
        } else if (plan.replayed) {
          stats.replays++;
          c.log.push([t, "server replayed the saved 201"]);
          reply(e, t, 201);
        } else {
          stats.conflicts++;
          c.log.push([t, "server answered 409, first attempt still running"]);
          reply(e, t, plan.response.status, plan.response.headers["retry-after"]);
        }
        break;
      }
      case "finish": {
        c.charges++;
        stats.charges++;
        c.log.push([t, c.charges > 1 ? `card charged again (${c.charges} total)` : "card charged"]);
        if (e.plan) store.complete(e.plan.storeKey, e.plan.token, { status: 201, headers: {}, body: "" }, t);
        reply(e, t, 201);
        break;
      }
      case "reply": {
        if (c.outcome || e.attempt !== c.current) break; // client already moved on
        if (e.status === 201) {
          c.outcome = "paid";
          c.doneAt = t;
          c.log.push([t, "client saw 201, done"]);
        } else if (e.status === 409) {
          retry(c, t, "client saw 409", Number(e.retryAfter) * 1000);
        } else {
          retry(c, t, `client saw ${e.status}`);
        }
        break;
      }
      case "timeout": {
        if (c.outcome || e.attempt !== c.current) break;
        stats.timeouts++;
        retry(c, t, "client timed out");
        break;
      }
    }
  }

  const charged = customers.filter((c) => c.charges > 0);
  const latencies = customers.filter((c) => c.doneAt != null).map((c) => c.doneAt - c.startAt).sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : 0);
  return {
    keyed,
    config: cfg,
    ...stats,
    customers: cfg.customers,
    paid: customers.filter((c) => c.outcome === "paid").length,
    gaveUp: customers.filter((c) => c.outcome === "gave-up").length,
    // The worst outcome: the client reports failure but the card was charged.
    gaveUpButCharged: customers.filter((c) => c.outcome === "gave-up" && c.charges > 0).length,
    duplicateCharges: stats.charges - charged.length,
    doubleCharged: customers.filter((c) => c.charges > 1).length,
    p50: pct(0.5),
    p95: pct(0.95),
    buckets: Array.from(buckets, (n) => n ?? 0),
    customerLog: (id) => customers[id]?.log ?? [],
    firstDoubleCharged: customers.find((c) => c.charges > 1)?.id ?? null,
  };
}

export function compare(options = {}) {
  return { naive: simulate(options, false), keyed: simulate(options, true) };
}
