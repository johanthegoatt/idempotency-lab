// The transport-free half of idempotency: parse the key, fingerprint the
// payload, and decide what a request is allowed to do. Both the node:http
// middleware and the in-browser console run through planRequest(), so the
// rules only exist once.
//
// Rules follow draft-ietf-httpapi-idempotency-key-header-07:
//   2.1  the key is a Structured Field String
//   2.2  a key MUST NOT be reused with a different payload
//   2.3  keys expire, and the expiry is part of the published contract
//   2.7  400 missing key, 422 key reused with another payload,
//        409 a request with this key is still being processed
// Storage semantics follow Stripe's published behaviour: whatever response
// the handler finished with is saved and replayed, including 5xx.

export const PROBLEM_BASE = "https://github.com/johanthegoatt/idempotency-lab#";

const DAY = 24 * 60 * 60 * 1000;

// A Structured Field String (RFC 8941 3.3.3): DQUOTE, printable ASCII with
// only \" and \\ escaped, DQUOTE. Bare tokens are accepted as well because
// most SDKs in the wild (Stripe's included) send the key unquoted.
export function parseIdempotencyKey(raw, maxLength = 255) {
  if (raw == null || raw === "") return { ok: false, reason: "missing" };
  const text = String(raw).trim();
  let key;
  if (text.startsWith('"')) {
    key = "";
    let i = 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "\\") {
        const n = text[++i];
        if (n !== '"' && n !== "\\") return { ok: false, reason: "invalid" };
        key += n;
      } else if (c === '"') {
        break;
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) return { ok: false, reason: "invalid" };
        key += c;
      }
    }
    if (i !== text.length - 1) return { ok: false, reason: "invalid" };
  } else if (/^[A-Za-z0-9._:~+\/=-]+$/.test(text)) {
    key = text;
  } else {
    return { ok: false, reason: "invalid" };
  }
  if (key === "") return { ok: false, reason: "invalid" };
  if (key.length > maxLength) return { ok: false, reason: "too-long" };
  return { ok: true, key };
}

// JSON with object keys sorted at every depth, so {"a":1,"b":2} and
// {"b":2,"a":1} fingerprint the same. Without this a client that rebuilds
// its body on retry gets a 422 for sending the identical request.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

// What gets hashed: method and path pin the key to one operation, the body
// pins it to one payload. JSON bodies are canonicalised, anything else is
// taken byte for byte.
export function fingerprintSource(method, path, bodyText, contentType = "") {
  let body = bodyText ?? "";
  if (/\bjson\b/i.test(contentType) && body.trim() !== "") {
    try {
      body = canonicalJson(JSON.parse(body));
    } catch {
      // Malformed JSON stays as raw text; the handler can reject it.
    }
  }
  return `${method.toUpperCase()} ${path}\n${body}`;
}

export function problem(status, slug, title, detail, extraHeaders = {}) {
  return {
    status,
    headers: { "content-type": "application/problem+json", ...extraHeaders },
    body: JSON.stringify({ type: PROBLEM_BASE + slug, title, status, detail }),
  };
}

// In-memory key store. Each record is either `processing` (holding a lease)
// or `done` (holding the saved response). The clock is passed in on every
// call so tests and the simulator can drive time directly.
//
// The lease exists for the worker that dies mid-request: without it the key
// would answer 409 forever. With it, once leaseMs passes, the next retry
// takes the key over. The token is a fencing token, so the dead worker's late
// complete() cannot overwrite the result of the one that replaced it.
export function createStore({ ttlMs = DAY, leaseMs = 30_000 } = {}) {
  const records = new Map();
  let nextToken = 1;

  function live(key, now) {
    const r = records.get(key);
    if (!r) return null;
    if (now >= r.createdAt + ttlMs) {
      records.delete(key);
      return null;
    }
    if (r.state === "processing" && now >= r.leaseUntil) {
      records.delete(key);
      return null;
    }
    return r;
  }

  return {
    ttlMs,
    leaseMs,
    begin(key, fingerprint, now) {
      const r = live(key, now);
      if (r && r.fingerprint !== fingerprint) return { kind: "mismatch" };
      if (r && r.state === "done") return { kind: "replay", response: r.response };
      if (r) return { kind: "in-flight", retryAfterMs: r.leaseUntil - now };
      const token = nextToken++;
      records.set(key, { state: "processing", fingerprint, token, createdAt: now, leaseUntil: now + leaseMs });
      return { kind: "new", token };
    },
    complete(key, token, response, now) {
      const r = live(key, now);
      if (!r || r.state !== "processing" || r.token !== token) return false;
      records.set(key, { state: "done", fingerprint: r.fingerprint, createdAt: r.createdAt, response });
      return true;
    },
    release(key, token) {
      const r = records.get(key);
      if (!r || r.state !== "processing" || r.token !== token) return false;
      records.delete(key);
      return true;
    },
    sweep(now) {
      for (const key of [...records.keys()]) live(key, now);
      return records.size;
    },
    get size() {
      return records.size;
    },
  };
}

// The whole decision for one request. Returns either a response to send as
// is, or permission to run the handler under a lease.
//
// `scope` namespaces keys per caller. Two customers who both pick the key
// "order-1" must not see each other's saved responses, which is exactly what
// a global key space would hand them.
export function planRequest(store, { rawKey, fingerprint, scope = "", now, required = true, maxKeyLength = 255 }) {
  const parsed = parseIdempotencyKey(rawKey, maxKeyLength);
  if (!parsed.ok) {
    if (parsed.reason === "missing" && !required) return { action: "passthrough" };
    if (parsed.reason === "missing") {
      return { action: "respond", response: problem(400, "missing-key", "Idempotency-Key is missing",
        "This operation is idempotent and requires a correctly formatted Idempotency-Key header.") };
    }
    return { action: "respond", response: problem(400, "invalid-key", "Idempotency-Key is not valid",
      parsed.reason === "too-long"
        ? `Keys are limited to ${maxKeyLength} characters.`
        : "Send the key as a Structured Field String, for example \"8e03978e-40d5-43e8-bc93-6894a57f9324\".") };
  }

  const storeKey = `${scope}\u0000${parsed.key}`;
  const outcome = store.begin(storeKey, fingerprint, now);
  switch (outcome.kind) {
    case "mismatch":
      return { action: "respond", response: problem(422, "key-reused", "Idempotency-Key is already used",
        "This key was already used with a different request payload. Use a new key for a new request.") };
    case "in-flight": {
      // The lease only bounds the worst case; a healthy request finishes far
      // sooner. One second is the smallest wait Retry-After can express.
      return { action: "respond", response: problem(409, "in-flight", "A request is outstanding for this Idempotency-Key",
        "The first request with this key has not finished. Retry after it completes.",
        { "retry-after": "1" }) };
    }
    case "replay": {
      const saved = outcome.response;
      return { action: "respond", replayed: true,
        response: { ...saved, headers: { ...saved.headers, "idempotent-replayed": "true" } } };
    }
    default:
      return { action: "execute", storeKey, token: outcome.token };
  }
}
