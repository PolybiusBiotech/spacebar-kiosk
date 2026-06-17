import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createServer } from "../src/server.js";

function request(server, { method = "GET", url = "/" } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host: "127.0.0.1" };

    const res = {
      statusCode: 200,
      headers: {},
      body: "",
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(chunk = "") {
        this.body += chunk;
        resolve(this);
      }
    };

    server.emit("request", req, res);
  });
}

test("config endpoint reports missing required tillweb settings", async () => {
  const server = createServer({
    tillwebBaseUrl: "",
    kioskToken: "",
    location: "Kiosk",
    printEnabled: false,
    publicDir: new URL("../public", import.meta.url).pathname
  });
  const response = await request(server, { url: "/api/config" });
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 503);
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.missing, ["TILLWEB_BASE_URL", "TILLWEB_KIOSK_TOKEN"]);
});
