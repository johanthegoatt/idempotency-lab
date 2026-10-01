# idempotency-lab

An `Idempotency-Key` middleware for `node:http`, built to
[draft-ietf-httpapi-idempotency-key-header-07](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/),
and a seeded simulation that shows what client retries do to a payments API with and without it.

Live: https://idempotency-lab.johanthegoat.xyz

```
npm test        # 25 tests, no dependencies
npm start       # http://localhost:8788, with a real /api/charges
```

## The problem

A client sends `POST /charges` and the reply never arrives. It cannot tell whether the request
was lost on the way in or the reply was lost on the way out, so it retries. If the server
already charged the card, it charges again.

With the default settings (200 customers, 5% of requests lost, 10% of replies lost, 8% of
requests slower than the 1s client timeout, a 500ms outage) the simulation on seed 7 gives:

|                            | no key | Idempotency-Key |
|----------------------------|-------:|----------------:|
| duplicate charges          |     46 |               0 |
| customers billed twice     |     36 |               0 |
| responses replayed         |      0 |              47 |
| 409 while first in flight  |      0 |              16 |
| p95 time to paid           |  2.45s |           3.25s |

The test suite runs 25 seeds and checks both directions: the naive server double charges on
every one of them and the keyed server never does. The keyed run is slower at the tail because
a client that hits a 409 waits for the first attempt instead of racing it.

## How a request is decided

`planRequest()` in [`src/core.js`](src/core.js) holds the whole decision and has no transport
in it, so the middleware and the in-browser console run the same code.

| situation | response | source |
|---|---|---|
| key missing on a guarded method | `400` problem+json | draft 2.7 |
| key not a Structured Field String, or over 255 chars | `400` | draft 2.1, Stripe's 255 limit |
| key seen before with a different payload | `422` | draft 2.7 |
| key seen before, first request still running | `409` + `Retry-After: 1` | draft 2.7 |
| key seen before, finished | saved response + `Idempotent-Replayed: true` | Stripe |
| new key | run the handler under a lease | |

Details that are easy to get wrong:

- **Fingerprints are canonical.** The payload is hashed as JSON with keys sorted at every
  depth, together with the method and path. A client that rebuilds `{"b":1,"a":2}` as
  `{"a":2,"b":1}` on retry is sending the same request and gets the replay, not a 422.
- **Keys are scoped per caller.** By default the scope is a SHA-256 of the `Authorization`
  header, falling back to the remote address. Without it, two customers who both pick
  `order-1` would read each other's saved responses.
- **In-flight records hold a lease with a fencing token.** If a worker dies mid-request the
  key would otherwise answer 409 forever. After `leaseMs` the next retry takes the key over,
  and the dead worker's late `complete()` is rejected because its token is stale. The page has
  a slider for the lease: drop it below the slow path and duplicates come back on the keyed
  side, which is the failure the lease length has to be chosen against.
- **What gets saved.** Following Stripe's documented behaviour, whatever response the handler
  finishes with is saved and replayed, including a 5xx, because a handler that returned an
  error may still have done part of its work. A handler that throws before responding never
  produced a result, so its key is released and the retry runs.
- **Keys expire.** Records live for `ttlMs` (24 hours by default, Stripe's window) and the
  draft asks that the expiry be published, which this paragraph does.
- **Bare tokens are accepted.** The draft says the key is a Structured Field String
  (`"abc"`), but most SDKs send it unquoted, so `abc` parses too.

## Using the middleware

```js
import { createServer } from "node:http";
import { createStore } from "./src/core.js";
import { createIdempotency } from "./src/middleware.js";

const idempotency = createIdempotency({ store: createStore({ ttlMs: 86_400_000, leaseMs: 30_000 }) });

createServer((req, res) =>
  idempotency(req, res, async () => {
    const body = JSON.parse(req.body); // read by the middleware for the fingerprint
    res.statusCode = 201;
    res.end(JSON.stringify(await charge(body)));
  }),
).listen(8788);
```

Options: `methods` (default `POST`, `PATCH`), `required`, `scope(req)`, `maxKeyLength`,
`maxBody` (413 above it), `now()` and `onError(err)`.

The store is in memory. For more than one process, the same `begin` / `complete` / `release`
contract maps onto a database row with a unique key and a `locked_at` column, the design
Brandur Leach describes in
[Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys).

## The simulation

[`src/sim.js`](src/sim.js) is a discrete-event simulation on a binary heap ordered by time and
insertion, driven by a seeded mulberry32 generator, so a seed always produces the same run.
Each customer sends one charge. Requests can be lost, replies can be lost, some requests take
the slow path, and the server drops everything during a short outage. Clients time out and
retry with exponential backoff using the none, full or equal jitter strategies from AWS's
[Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).

A 409 waits out `Retry-After` without spending the retry budget. The first version counted it
as a failure, and keyed clients gave up on payments that then went through, which is the
"gave up, still charged" number on the page.

## Sources

- [draft-ietf-httpapi-idempotency-key-header-07](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/), IETF HTTPAPI working group
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests), Stripe API reference
- [RFC 8941](https://www.rfc-editor.org/rfc/rfc8941) Structured Field Values, section 3.3.3 for strings
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details for HTTP APIs
- [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/), AWS Architecture Blog

MIT licensed.
