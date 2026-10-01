// Idempotency-Key for node:http (and anything with the same req/res shape).
//
//   const idem = createIdempotency({ store: createStore() });
//   http.createServer((req, res) => idem(req, res, () => handle(req, res)));
//
// The middleware reads the body itself, because the fingerprint needs it,
// and hands it to the handler as req.body (a string). It then watches what
// the handler writes: whatever response the handler finishes is saved under
// the key and replayed byte for byte on every retry. If the handler throws
// before it responds, nothing ran to completion, so the key is released and
// the client may retry.
import { createHash } from "node:crypto";
import { fingerprintSource, planRequest, problem } from "./core.js";

const MAX_BODY = 1024 * 1024;

// Saved headers are what the handler set, minus the ones that describe a
// single connection rather than the response itself.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "date", "content-length"]);

// Default scope: the credential, hashed, so the store never holds a token in
// the clear. Anonymous callers fall back to their address.
function defaultScope(req) {
  const auth = req.headers.authorization;
  if (auth) return "auth:" + createHash("sha256").update(auth).digest("base64url");
  return "ip:" + (req.socket?.remoteAddress ?? "unknown");
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Stop buffering but keep draining, so the 413 can still be written.
        req.off("data", onData);
        req.resume();
        reject(Object.assign(new Error("body too large"), { code: "TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, { status, headers, body }) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
  res.end(body ?? "");
}

export function createIdempotency({
  store,
  methods = ["POST", "PATCH"],
  required = true,
  scope = defaultScope,
  maxKeyLength = 255,
  maxBody = MAX_BODY,
  now = () => Date.now(),
  onError = (err) => console.error(err),
}) {
  if (!store || typeof store.begin !== "function") {
    throw new TypeError("createIdempotency needs a store from createStore()");
  }
  const guarded = new Set(methods.map((m) => m.toUpperCase()));

  return async function idempotency(req, res, next) {
    if (!guarded.has(req.method)) return next();

    let bodyText;
    try {
      bodyText = await readBody(req, maxBody);
    } catch (err) {
      if (err.code === "TOO_LARGE") {
        res.setHeader("connection", "close");
        return send(res, problem(413, "too-large", "Request body is too large", `Bodies are limited to ${maxBody} bytes.`));
      }
      throw err;
    }
    req.body = bodyText;

    const { pathname } = new URL(req.url, "http://localhost");
    const fingerprint = createHash("sha256")
      .update(fingerprintSource(req.method, pathname, bodyText, req.headers["content-type"]))
      .digest("base64url");

    const plan = planRequest(store, {
      rawKey: req.headers["idempotency-key"],
      fingerprint,
      scope: scope(req),
      now: now(),
      required,
      maxKeyLength,
    });

    if (plan.action === "passthrough") return next();
    if (plan.action === "respond") return send(res, plan.response);

    // Record the response as the handler writes it, then save it on end().
    const chunks = [];
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    let saved = false;
    const save = () => {
      if (saved) return;
      saved = true;
      const headers = {};
      for (const [name, value] of Object.entries(res.getHeaders())) {
        if (!HOP_BY_HOP.has(name)) headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      store.complete(plan.storeKey, plan.token, { status: res.statusCode, headers, body }, now());
    };
    const collect = (chunk, encoding) => {
      if (chunk != null && typeof chunk !== "function") {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8"));
      }
    };
    res.write = (chunk, encoding, cb) => {
      collect(chunk, encoding);
      return write(chunk, encoding, cb);
    };
    res.end = (chunk, encoding, cb) => {
      collect(chunk, encoding);
      save();
      return end(chunk, encoding, cb);
    };

    try {
      await next();
    } catch (err) {
      onError(err);
      if (saved) return;
      store.release(plan.storeKey, plan.token);
      if (res.headersSent) return void res.destroy();
      res.statusCode = 500;
      res.setHeader("content-type", "application/problem+json");
      end(JSON.stringify({ type: "about:blank", title: "Internal Server Error", status: 500 }));
    }
  };
}
