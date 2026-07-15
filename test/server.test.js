import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test, { mock } from "node:test";

import { createServer, updatePrinterState } from "../src/server.js";

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

// For streaming endpoints (/api/events) that never call res.end() — the
// route handler writes its initial payload synchronously before returning,
// so this reads whatever's been written without waiting for a close.
function requestStream(server, { method = "GET", url = "/" } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1" };
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = { ...this.headers, ...headers }; },
    write(chunk) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; }
  };
  server.emit("request", req, res);
  return res;
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

test("stock endpoint returns items in mock mode", async () => {
  const server = createServer(MOCK_CONFIG);
  const res = await request(server, { url: "/api/stock" });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(body.items), "items is array");
  assert.ok(body.items.length > 0, "has items");
  assert.ok(body.items.every(item => item.stockline_id), "each item has stockline_id");
});

test("stock endpoint passes through unavailable items with available=false", async () => {
  const getStock = () => ({
    location: "spacebar",
    expired_orders: [],
    items: [
      { stockline_id: 1, name: "Club Mate", available: true,  price: "2.80" },
      { stockline_id: 2, name: "Sold Out",  available: false, price: "4.50" }
    ]
  });
  const server = createServer(MOCK_CONFIG, { getStock });
  const res = await request(server, { url: "/api/stock" });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.items.length, 2, "both items returned");
  assert.equal(body.items.find(i => i.stockline_id === 1)?.available, true);
  assert.equal(body.items.find(i => i.stockline_id === 2)?.available, false);
});

test("stock endpoint reflects a product going out of stock between polls", async () => {
  let available = true;
  const getStock = () => ({
    location: "spacebar",
    expired_orders: [],
    items: [{ stockline_id: 99, name: "Last Ones", available, price: "3.00" }]
  });

  const server = createServer(MOCK_CONFIG, { getStock });

  const firstBody = JSON.parse((await request(server, { url: "/api/stock" })).body);
  assert.equal(firstBody.items[0].available, true, "available before selling out");

  available = false;

  const secondBody = JSON.parse((await request(server, { url: "/api/stock" })).body);
  assert.equal(secondBody.items[0].available, false, "marked unavailable after selling out");
  assert.equal(secondBody.items.length, 1, "item still present in response");
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

// ── Maintenance mode ─────────────────────────────────────────────────────────

test("mock mode still reflects maintenance state via /api/events (not gated on mockMode)", async () => {
  const server = createServer(MOCK_CONFIG);
  try {
    // /api/maintenance sets the same maintenanceMode variable connectOmsMaintenance()
    // would on a real OMS signal — this proves mock mode doesn't block/ignore it.
    await request(server, { method: "POST", url: "/api/maintenance", body: JSON.stringify({ active: true }) });
    const res = requestStream(server, { url: "/api/events" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"active":true/);
  } finally {
    await request(server, { method: "POST", url: "/api/maintenance", body: JSON.stringify({ active: false }) });
  }
});

// ── Printer lockout ──────────────────────────────────────────────────────────
// Auto-triggered on a print failure, cleared only via the hidden staff
// control (POST /api/printer-lockout/clear) — see app.js's tap gesture.
// A nonexistent printerName makes the print attempt fail deterministically
// (checkPrinterStatus rejects before ever touching a real printer), same
// technique as test/printer.test.js.

const PRINT_FAILURE_CONFIG = {
  ...MOCK_CONFIG,
  printEnabled: true,
  dummyPrint: false,
  printerName: "definitely-not-a-real-printer-xyz",
  printCommand: "lp"
};
const ORDER_BODY = JSON.stringify({ items: [{ stockline_id: 101, qty: 1 }] });

test("print failure engages the lockout once, and does not re-log on repeated failures", async () => {
  const server = createServer(PRINT_FAILURE_CONFIG);
  const errorMock = mock.method(console, "error", () => {});
  try {
    const res1 = await request(server, { method: "POST", url: "/api/orders", body: ORDER_BODY });
    assert.equal(res1.statusCode, 502);
    const engaged = () => errorMock.mock.calls.filter(c => c.arguments[0]?.includes("[printer-lockout] engaging")).length;
    assert.equal(engaged(), 1, "lockout engages on first failure");

    const res2 = await request(server, { method: "POST", url: "/api/orders", body: ORDER_BODY });
    assert.equal(res2.statusCode, 502);
    assert.equal(engaged(), 1, "does not re-engage/re-log while already locked out");
  } finally {
    errorMock.mock.restore();
    await request(server, { method: "POST", url: "/api/printer-lockout/clear" }); // don't leak state into other tests
  }
});

test("POST /api/printer-lockout/clear resets the lockout so a later failure re-engages it", async () => {
  const server = createServer(PRINT_FAILURE_CONFIG);
  await request(server, { method: "POST", url: "/api/orders", body: ORDER_BODY }); // engage lockout

  const clearRes = await request(server, { method: "POST", url: "/api/printer-lockout/clear" });
  assert.equal(clearRes.statusCode, 200);
  assert.deepEqual(JSON.parse(clearRes.body), { ok: true });

  const errorMock = mock.method(console, "error", () => {});
  try {
    await request(server, { method: "POST", url: "/api/orders", body: ORDER_BODY });
    const engaged = errorMock.mock.calls.filter(c => c.arguments[0]?.includes("[printer-lockout] engaging")).length;
    assert.equal(engaged, 1, "lockout re-engages after being cleared");
  } finally {
    errorMock.mock.restore();
    await request(server, { method: "POST", url: "/api/printer-lockout/clear" }); // don't leak state into other tests
  }
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

// ── Printer state logging ───────────────────────────────────────────────────
// Previously a printer failure only updated in-memory state — nothing
// showed up in the journal, so there was no way to tell a failure had
// happened without a client actively polling for it. updatePrinterState
// mutates module-level singleton state shared across this whole test file,
// so establish a known baseline before each assertion rather than assuming
// a pristine starting state.

test("updatePrinterState logs once when the printer transitions to failed", () => {
  updatePrinterState({ ok: true, status: "idle", message: "baseline" });
  const errorMock = mock.method(console, "error", () => {});
  try {
    updatePrinterState({ ok: false, status: "offline", message: "Printer is offline." });
    assert.equal(errorMock.mock.callCount(), 1);
    assert.match(errorMock.mock.calls[0].arguments[0], /FAILED.*offline.*Printer is offline\./s);
  } finally {
    errorMock.mock.restore();
  }
});

test("updatePrinterState does not re-log on repeated failures (no polling spam)", () => {
  updatePrinterState({ ok: false, status: "offline", message: "still offline" });
  const errorMock = mock.method(console, "error", () => {});
  try {
    updatePrinterState({ ok: false, status: "offline", message: "still offline" });
    assert.equal(errorMock.mock.callCount(), 0);
  } finally {
    errorMock.mock.restore();
  }
});

test("updatePrinterState logs recovery when the printer comes back", () => {
  updatePrinterState({ ok: false, status: "offline", message: "baseline" });
  const logMock = mock.method(console, "log", () => {});
  try {
    updatePrinterState({ ok: true, status: "idle", message: "Print succeeded." }, true);
    assert.equal(logMock.mock.callCount(), 1);
    assert.match(logMock.mock.calls[0].arguments[0], /recovered/);
  } finally {
    logMock.mock.restore();
  }
});
