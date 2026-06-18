import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createServer } from "../src/server.js";

const PUBLIC_DIR = new URL("../public", import.meta.url).pathname;

const BASE_CONFIG = {
  tillwebBaseUrl: "",
  kioskToken: "",
  location: "spacebar",
  mockMode: false,
  printEnabled: false,
  dummyPrint: false,
  omsUrl: "",
  publicDir: PUBLIC_DIR
};

const MOCK_CONFIG = {
  ...BASE_CONFIG,
  mockMode: true
};

function request(server, { method = "GET", url = "/", body = null } = {}) {
  return new Promise(resolve => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = url;
    req.headers = { host: "127.0.0.1" };

    const res = {
      statusCode: 200,
      headers: {},
      body: "",
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = { ...this.headers, ...headers };
      },
      write(chunk) {
        this.body += chunk;
      },
      end(chunk = "") {
        this.body += chunk;
        resolve(this);
      }
    };

    server.emit("request", req, res);
  });
}

// ── /api/config ────────────────────────────────────────────────────────────

test("config endpoint reports missing required tillweb settings", async () => {
  const server = createServer(BASE_CONFIG);
  const res = await request(server, { url: "/api/config" });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 503);
  assert.equal(body.ready, false);
  assert.deepEqual(body.missing, ["TILLWEB_BASE_URL", "TILLWEB_KIOSK_TOKEN"]);
});

test("config endpoint reports ready in mock mode regardless of missing tillweb settings", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, { url: "/api/config" });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ready, true);
  assert.equal(body.mock_mode, true);
});

test("config endpoint includes location", async () => {
  const server = createServer({ ...MOCK_CONFIG, location: "testloc" });
  const res = await request(server, { url: "/api/config" });
  const body = JSON.parse(res.body);
  assert.equal(body.location, "testloc");
});

// ── /healthz ───────────────────────────────────────────────────────────────

test("healthz returns ok in mock mode", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, { url: "/healthz" });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.ok("printer" in body, "includes printer state");
});

// ── /api/stock ─────────────────────────────────────────────────────────────

test("stock endpoint returns available items in mock mode", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, { url: "/api/stock" });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(body.items), "items is array");
  assert.ok(body.items.length > 0, "has items");
  assert.ok(body.items.every(item => item.available === true), "only available items");
  assert.ok(body.items.every(item => item.stockline_id), "each item has stockline_id");
});

test("stock endpoint returns 503 when not configured and not in mock mode", async () => {
  const server = createServer(BASE_CONFIG);
  const res = await request(server, { url: "/api/stock" });
  assert.equal(res.statusCode, 503);
});

// ── /api/orders (POST) ─────────────────────────────────────────────────────

test("orders endpoint creates a mock order with lines and barcode", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, {
    method: "POST",
    url: "/api/orders",
    body: JSON.stringify({ items: [{ stockline_id: 101, qty: 2 }] })
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.ok(body.order_ref, "has order_ref");
  assert.ok(body.barcode, "has barcode");
  assert.ok(body.barcode.startsWith("KIOSK:"), "barcode has KIOSK: prefix");
  assert.ok(Array.isArray(body.lines) && body.lines.length > 0, "has lines");
  assert.equal(body.lines[0].quantity, 2, "quantity matches");
  assert.ok(body.total, "has total");
});

test("orders endpoint rejects empty items array", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, {
    method: "POST",
    url: "/api/orders",
    body: JSON.stringify({ items: [] })
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "bad-order");
});

test("orders endpoint rejects missing items field", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, {
    method: "POST",
    url: "/api/orders",
    body: JSON.stringify({ idempotency_key: "abc" })
  });
  assert.equal(res.statusCode, 400);
});

test("orders endpoint rejects non-integer qty", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, {
    method: "POST",
    url: "/api/orders",
    body: JSON.stringify({ items: [{ stockline_id: 101, qty: 1.5 }] })
  });
  assert.equal(res.statusCode, 400);
});

test("orders endpoint rejects zero qty", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, {
    method: "POST",
    url: "/api/orders",
    body: JSON.stringify({ items: [{ stockline_id: 101, qty: 0 }] })
  });
  assert.equal(res.statusCode, 400);
});

test("orders endpoint rejects non-integer stockline_id", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, {
    method: "POST",
    url: "/api/orders",
    body: JSON.stringify({ items: [{ stockline_id: "abc", qty: 1 }] })
  });
  assert.equal(res.statusCode, 400);
});

test("orders endpoint returns 503 when not configured and not in mock mode", async () => {
  const server = createServer(BASE_CONFIG);
  const res = await request(server, {
    method: "POST",
    url: "/api/orders",
    body: JSON.stringify({ items: [{ stockline_id: 101, qty: 1 }] })
  });
  assert.equal(res.statusCode, 503);
});

// ── /api/orders/expire ─────────────────────────────────────────────────────

test("expire endpoint returns empty list in mock mode", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, { method: "POST", url: "/api/orders/expire" });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.expired_orders, []);
});

// ── Static files ───────────────────────────────────────────────────────────

test("static file server returns 200 for index.html", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, { url: "/" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers["Content-Type"]?.includes("text/html"), "HTML content-type");
});

test("static file server returns 404 for unknown paths", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, { url: "/does-not-exist.txt" });
  assert.equal(res.statusCode, 404);
});

// ── Method handling ────────────────────────────────────────────────────────

test("returns 405 for POST to an unrecognised path", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, { method: "POST", url: "/not-an-api-route" });
  assert.equal(res.statusCode, 405);
});
