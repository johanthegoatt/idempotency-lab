// Demo server: the lab page plus a real /api/charges behind the middleware.
//   node server.js            -> http://localhost:8788
//   curl -i -X POST localhost:8788/api/charges \
//     -H 'Idempotency-Key: "order-1"' -H 'content-type: application/json' -d '{"amount":500}'
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./src/core.js";
import { createIdempotency } from "./src/middleware.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 8788;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const publicFiles = new Set(["/index.html", "/src/core.js", "/src/sim.js", "/src/console.js", "/src/style.css"]);

const idempotency = createIdempotency({ store: createStore() });
let charges = 0;

export const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (pathname === "/api/charges") {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST");
      return res.end();
    }
    return idempotency(req, res, async () => {
      let body;
      try {
        body = JSON.parse(req.body);
      } catch {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ error: "body must be JSON" }));
      }
      await new Promise((r) => setTimeout(r, 300));
      charges++;
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `ch_${charges}`, amount: body.amount }));
    });
  }

  const file = pathname === "/" ? "/index.html" : normalize(pathname).replace(/\\/g, "/");
  if (!publicFiles.has(file)) {
    res.statusCode = 404;
    return res.end("not found");
  }
  try {
    const body = await readFile(join(root, file));
    res.setHeader("Content-Type", `${types[extname(file)] ?? "text/plain"}; charset=utf-8`);
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(port, () => console.log(`idempotency-lab on http://localhost:${port}`));
}
