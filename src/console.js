// The request console runs the same planRequest() the middleware uses,
// against an in-tab charges endpoint, so the page works on any static host.
// The fingerprint is SHA-256 through Web Crypto, matching the server's hash.
import { createStore, fingerprintSource, planRequest } from "./core.js";

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createConsole({ workMs = 600, now = () => Date.now(), wait } = {}) {
  const store = createStore();
  const sleep = wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let charges = 0;

  return {
    get charges() { return charges; },
    async post({ key, body }) {
      const bodyText = JSON.stringify(body);
      const fingerprint = await sha256(fingerprintSource("POST", "/charges", bodyText, "application/json"));
      const plan = planRequest(store, { rawKey: key, fingerprint, scope: "tab", now: now() });
      if (plan.action === "respond") return plan.response;

      await sleep(workMs); // the card network
      charges++;
      const response = {
        status: 201,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: `ch_${charges}`, amount: body.amount }),
      };
      store.complete(plan.storeKey, plan.token, response, now());
      return response;
    },
  };
}
