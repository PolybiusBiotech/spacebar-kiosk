import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { loadConfig, validateRuntimeConfig } from "./config.js";
import { expireOrders, fetchStock, placeOrder, TillwebError } from "./tillweb.js";
import { printOrderSlip, checkPrinterStatus } from "./printer.js";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function stockForClient(config, stock) {
  return {
    location: stock.location ?? config.location,
    expired_orders: stock.expired_orders ?? [],
    items: stock.items ?? []
  };
}

function mockStock(config) {
  return {
    location: config.location,
    expired_orders: [],
    items: [
      {
        stockline_id: 101,
        name: "BuzzBallz Strawberry 'Rita",
        description: "200ml 15% ABV",
        category: "BuzzBallz",
        price: "4.50",
        available: true,
        available_quantity: "24",
        available_display: "24"
      },
      {
        stockline_id: 102,
        name: "BuzzBallz Chili Mango",
        description: "200ml 15% ABV",
        category: "BuzzBallz",
        price: "4.50",
        available: true,
        available_quantity: "24",
        available_display: "24"
      },
      {
        stockline_id: 103,
        name: "BuzzBallz Grape Crunch",
        description: "200ml 15% ABV",
        category: "BuzzBallz",
        price: "4.50",
        available: true,
        available_quantity: "24",
        available_display: "24"
      },
      {
        stockline_id: 104,
        name: "BuzzBallz Lemon Drop",
        description: "200ml 15% ABV",
        category: "BuzzBallz",
        price: "4.50",
        available: true,
        available_quantity: "24",
        available_display: "24"
      },
      {
        stockline_id: 105,
        name: "BuzzBallz Watermelon Smash",
        description: "200ml 15% ABV",
        category: "BuzzBallz",
        price: "4.50",
        available: true,
        available_quantity: "24",
        available_display: "24"
      },
      {
        stockline_id: 106,
        name: "BuzzBallz Blue Raspberry",
        description: "200ml 15% ABV",
        category: "BuzzBallz",
        price: "4.50",
        available: true,
        available_quantity: "24",
        available_display: "24"
      },
      {
        stockline_id: 107,
        name: "BuzzBallz Peach Fuzz",
        description: "200ml 15% ABV",
        category: "BuzzBallz",
        price: "4.50",
        available: true,
        available_quantity: "24",
        available_display: "24"
      },
      {
        stockline_id: 108,
        name: "BuzzBallz Cran Bliss",
        description: "200ml 15% ABV",
        category: "BuzzBallz",
        price: "4.50",
        available: true,
        available_quantity: "24",
        available_display: "24"
      },
      {
        stockline_id: 201,
        name: "Rum & Coke",
        description: "Pre-mixed can 330ml",
        category: "Mixed Cans",
        price: "4.00",
        available: true,
        available_quantity: "48",
        available_display: "48"
      },
      {
        stockline_id: 202,
        name: "Vodka & Coke",
        description: "Pre-mixed can 330ml",
        category: "Mixed Cans",
        price: "4.00",
        available: true,
        available_quantity: "48",
        available_display: "48"
      },
      {
        stockline_id: 203,
        name: "Jack & Coke",
        description: "Pre-mixed can 330ml",
        category: "Mixed Cans",
        price: "4.00",
        available: true,
        available_quantity: "48",
        available_display: "48"
      },
      {
        stockline_id: 204,
        name: "Gin & Tonic",
        description: "Pre-mixed can 330ml",
        category: "Mixed Cans",
        price: "4.00",
        available: true,
        available_quantity: "48",
        available_display: "48"
      },
    ]
  };
}

function mockOrder(config, body) {
  const stock = mockStock(config).items;
  const lines = body.items.map(item => {
    const product = stock.find(candidate => candidate.stockline_id === item.stockline_id);
    const unitPrice = product?.price ?? "0.00";
    const lineTotal = (Number.parseFloat(unitPrice) * item.qty).toFixed(2);
    return {
      description: product?.name ?? `Stockline ${item.stockline_id}`,
      quantity: item.qty,
      unit_price: unitPrice,
      line_total: lineTotal
    };
  });
  const total = lines.reduce((sum, line) => sum + Number.parseFloat(line.line_total), 0).toFixed(2);
  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 60 * 1000);

  return {
    order_ref: "9574",
    order_name: "9574",
    barcode: "KIOSK:9574381",
    location: config.location,
    transaction_id: 9574,
    created: true,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    idempotency_key: body.idempotency_key,
    status: "accepted",
    total,
    lines,
    slip: {
      title: "9574",
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      unpaid: true,
      total,
      lines
    },
    expired_orders: []
  };
}

function logMockOrder(order) {
  console.log(`[mock-order] ${order.order_name} total GBP ${order.total}`);
  for (const line of order.lines ?? []) {
    console.log(
      `[mock-order] ${line.quantity} x ${line.description} @ GBP ${line.unit_price} = GBP ${line.line_total}`
    );
  }
}

function validateOrderBody(body) {
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return "Order must contain at least one item.";
  }

  for (const item of body.items) {
    if (!Number.isInteger(item.stockline_id) || !Number.isInteger(item.qty) || item.qty <= 0) {
      return "Each order item must include an integer stockline_id and positive integer qty.";
    }
  }

  return null;
}

function tillwebFailure(res, error) {
  if (error instanceof TillwebError) {
    sendJson(res, error.status, error.payload ?? { error: "tillweb-error", message: error.message });
    return;
  }
  sendJson(res, 500, { error: "kiosk-error", message: error.message });
}

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function placeOrderWithNetworkRetry(config, order) {
  try {
    return await placeOrder(config, order);
  } catch (error) {
    const isNetworkFailure =
      error instanceof TillwebError && error.status === 502 && error.payload?.error === "network-error";
    if (!isNetworkFailure) {
      throw error;
    }
    await delay(1500);
    return placeOrder(config, order);
  }
}

async function serveStatic(config, req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path
    .normalize(decodeURIComponent(requestUrl.pathname))
    .replace(/^(\.\.[/\\])+/, "");
  const relativePath = safePath === "/" ? "index.html" : safePath.replace(/^[/\\]/, "");
  const filePath = path.join(config.publicDir, relativePath);

  if (!filePath.startsWith(config.publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// In-memory printer state. Updated after every print attempt and healthz check.
const printerState = {
  ok: null,          // null = never checked
  status: "unknown",
  message: "",
  lastCheckedAt: null,
  lastErrorAt: null,
  lastPrintedAt: null
};

function updatePrinterState(result, printed = false) {
  printerState.ok = result.ok ?? true;
  printerState.status = result.status ?? (printed ? "idle" : "unknown");
  printerState.message = result.message ?? "";
  printerState.lastCheckedAt = new Date().toISOString();
  if (!printerState.ok) printerState.lastErrorAt = printerState.lastCheckedAt;
  if (printed) printerState.lastPrintedAt = printerState.lastCheckedAt;
}

// If KIOSK_OMS_URL is configured, POST printer errors there so the OMS
// staff screen can alert. Fire-and-forget — kiosk flow is not blocked.
function notifyOmsOfPrinterError(config, message) {
  if (!config.omsUrl) return;
  fetch(`${config.omsUrl}/api/printer-alert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: config.location, message, at: new Date().toISOString() })
  }).catch(() => {});
}

export function createServer(config, { getStock: getStockOverride = null } = {}) {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    try {
      if (requestUrl.pathname === "/healthz") {
        const ps = config.mockMode
          ? { ok: true, status: "idle", message: "Mock mode." }
          : await checkPrinterStatus(config);
        updatePrinterState(ps);
        const ok = ps.ok !== false;
        sendJson(res, ok ? 200 : 503, {
          ok,
          location: config.location,
          printer: {
            ok: printerState.ok,
            status: printerState.status,
            message: printerState.message,
            last_checked_at: printerState.lastCheckedAt,
            last_error_at: printerState.lastErrorAt,
            last_printed_at: printerState.lastPrintedAt
          }
        });
        return;
      }

      if (requestUrl.pathname === "/api/config") {
        const missing = config.mockMode ? [] : validateRuntimeConfig(config);
        sendJson(res, missing.length ? 503 : 200, {
          location: config.location,
          print_enabled: config.printEnabled,
          mock_mode: config.mockMode,
          ready: missing.length === 0,
          missing
        });
        return;
      }

      if (requestUrl.pathname === "/api/stock" && req.method === "GET") {
        const missing = config.mockMode ? [] : validateRuntimeConfig(config);
        if (missing.length) {
          sendJson(res, 503, { error: "misconfigured", message: "Kiosk is missing configuration.", missing });
          return;
        }
        const stock = getStockOverride
          ? await getStockOverride(config)
          : (config.mockMode ? mockStock(config) : await fetchStock(config));
        sendJson(res, 200, stockForClient(config, stock));
        return;
      }

      if (requestUrl.pathname === "/api/orders" && req.method === "POST") {
        const missing = config.mockMode ? [] : validateRuntimeConfig(config);
        if (missing.length) {
          sendJson(res, 503, { error: "misconfigured", message: "Kiosk is missing configuration.", missing });
          return;
        }

        const body = await readJson(req);
        const validation = validateOrderBody(body);
        if (validation) {
          sendJson(res, 400, { error: "bad-order", message: validation });
          return;
        }

        const orderRequest = {
          idempotency_key: body.idempotency_key || randomUUID(),
          items: body.items
        };
        const order = config.mockMode
          ? mockOrder(config, orderRequest)
          : await placeOrderWithNetworkRetry(config, orderRequest);
        if (config.mockMode) {
          logMockOrder(order);
        }

        try {
          const printResult = await printOrderSlip(config, order);
          updatePrinterState({ ok: true, status: "idle", message: "Print succeeded." }, true);
          sendJson(res, 200, { ...order, print: printResult });
        } catch (error) {
          updatePrinterState({ ok: false, status: "error", message: error.message });
          notifyOmsOfPrinterError(config, error.message);
          sendJson(res, 502, {
            ...order,
            error: "printer-error",
            message: "Order was created, but the slip could not be printed.",
            printer_message: error.message
          });
        }
        return;
      }

      if (requestUrl.pathname === "/api/orders/expire" && req.method === "POST") {
        const missing = config.mockMode ? [] : validateRuntimeConfig(config);
        if (missing.length) {
          sendJson(res, 503, { error: "misconfigured", message: "Kiosk is missing configuration.", missing });
          return;
        }
        sendJson(res, 200, config.mockMode ? { location: config.location, expired_orders: [] } : await expireOrders(config));
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        // In dummy/mock mode, also serve the receipts/ directory for preview
        if (config.mockMode && req.url.startsWith("/receipts/")) {
          await serveStatic({ ...config, publicDir: path.join(process.cwd(), ".") }, req, res);
          return;
        }
        await serveStatic(config, req, res);
        return;
      }

      sendJson(res, 405, { error: "method-not-allowed", message: "Method not allowed." });
    } catch (error) {
      tillwebFailure(res, error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const server = createServer(config);

  server.on("error", error => {
    if (error.code === "EADDRINUSE") {
      console.error(`Could not start kiosk: ${config.listenHost}:${config.port} is already in use.`);
    } else if (error.code === "EACCES" || error.code === "EPERM") {
      console.error(`Could not start kiosk: permission denied binding ${config.listenHost}:${config.port}.`);
    } else {
      console.error(`Could not start kiosk: ${error.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(config.port, config.listenHost, () => {
    const missing = config.mockMode ? [] : validateRuntimeConfig(config);
    console.log(`Spacebar kiosk listening on http://${config.listenHost}:${config.port}`);
    if (config.mockMode) {
      console.log("Mock mode is enabled; tillweb will not be contacted.");
    } else if (missing.length) {
      console.warn(`Kiosk is not ready; missing configuration: ${missing.join(", ")}`);
    }
    if (config.printEnabled && !config.omsUrl) {
      console.warn("WARNING: KIOSK_OMS_URL is not set. Printer errors will not be reported to the OMS staff screen. In a remote/unattended deployment this means staff will not know when the printer needs attention.");
    }
  });
}
