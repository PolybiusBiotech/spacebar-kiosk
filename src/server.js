import http from "node:http";
import https from "node:https";
import path from "node:path";

import { loadConfig, validateRuntimeConfig } from "./config.js";
import { fetchStock, placeOrder, TillwebError } from "./tillweb.js";
import { printOrderSlip, checkPrinterStatus } from "./printer.js";
import { sendJson, serveStatic } from "@spacebar/shared/http-helpers.js";

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
      // ── Cocktails ──────────────────────────────────────────────
      { stockline_id: 101, name: "BuzzBallz Berry Cherry Limeade",  description: "200ml", category: "Cocktails",     price: "6.50", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "13.5" } },
      { stockline_id: 102, name: "BuzzBallz Chilli Mango",          description: "200ml", category: "Cocktails",     price: "6.50", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "13.5" } },
      { stockline_id: 103, name: "BuzzBallz Choc Tease",            description: "200ml", category: "Cocktails",     price: "6.50", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "13.5" } },
      { stockline_id: 104, name: "BuzzBallz Espresso Martini",      description: "200ml", category: "Cocktails",     price: "6.50", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "13.5" } },
      { stockline_id: 105, name: "BuzzBallz Lotta Colada",          description: "200ml", category: "Cocktails",     price: "6.50", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "13.5" } },
      { stockline_id: 106, name: "BuzzBallz Passionfruit Martini",  description: "200ml", category: "Cocktails",     price: "6.50", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "13.5" } },
      { stockline_id: 107, name: "BuzzBallz Strawberry 'Rita",      description: "200ml", category: "Cocktails",     price: "6.50", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "13.5" } },
      { stockline_id: 108, name: "BuzzBallz Tequila 'Rita",         description: "200ml", category: "Cocktails",     price: "6.50", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "13.5" } },
      // ── Spirit & Mixer ─────────────────────────────────────────
      { stockline_id: 201, name: "Captain Morgan Gold and Pepsi Max", description: "250ml", category: "Spirit & Mixer", price: "5.00", available: true, available_quantity: "48", available_display: "48", stocktype: { abv: "5" } },
      { stockline_id: 202, name: "Jack Daniels and Coca Cola",       description: "330ml", category: "Spirit & Mixer", price: "5.00", available: true, available_quantity: "48", available_display: "48", stocktype: { abv: "5" } },
      { stockline_id: 203, name: "Smirnoff and Cola",                description: "250ml", category: "Spirit & Mixer", price: "5.00", available: true, available_quantity: "48", available_display: "48", stocktype: { abv: "5" } },
      { stockline_id: 204, name: "Tanqueray and Tonic",              description: "250ml", category: "Spirit & Mixer", price: "5.00", available: true, available_quantity: "48", available_display: "48", stocktype: { abv: "6.5" } },
      // ── Wine ───────────────────────────────────────────────────
      { stockline_id: 301, name: "Nice Fizz",              description: "Sparkling 200ml",      category: "Wine",         price: "6.00", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "10" } },
      { stockline_id: 302, name: "Nice Pale Rosé",         description: "187ml",                category: "Wine",         price: "6.00", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "11" } },
      { stockline_id: 303, name: "Nice Sauvignon Blanc",   description: "187ml",                category: "Wine",         price: "6.00", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "11" } },
      // ── Alcohol-free ───────────────────────────────────────────
      { stockline_id: 401, name: "Sea Change Sparkling",   description: "Alcohol-free sparkling", category: "Alcohol-free", price: "6.00", available: true, available_quantity: "24", available_display: "24", stocktype: { abv: "0" } },
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
    barcode: "0957481733",
    transaction_id: 9574,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    soft_only: false,
    total,
    lines,
    paid: false,
    collected: false,
    cancelled: false,
  };
}

function logMockOrder(order) {
  console.log(`[mock-order] ${order.transaction_id} total GBP ${order.total}`);
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


// In-memory printer state. Updated after every print attempt and healthz check.
const printerState = {
  ok: null,          // null = never checked
  status: "unknown",
  message: "",
  lastCheckedAt: null,
  lastErrorAt: null,
  lastPrintedAt: null
};

export function updatePrinterState(result, printed = false) {
  const wasOk = printerState.ok;
  printerState.ok = result.ok ?? true;
  printerState.status = result.status ?? (printed ? "idle" : "unknown");
  printerState.message = result.message ?? "";
  printerState.lastCheckedAt = new Date().toISOString();
  if (!printerState.ok) printerState.lastErrorAt = printerState.lastCheckedAt;
  if (printed) printerState.lastPrintedAt = printerState.lastCheckedAt;

  // Log on transitions only (not every healthz poll), so a printer going
  // offline between orders — e.g. paper runs out while idle — shows up in
  // the journal without waiting for the next customer's order to fail.
  if (wasOk && !printerState.ok) {
    console.error(`[printer] status changed to FAILED (${printerState.status}): ${printerState.message}`);
  } else if (wasOk === false && printerState.ok) {
    console.log(`[printer] recovered (${printerState.status})`);
  }
}

// ── Maintenance mode ────────────────────────────────────────────────────────
// maintenanceMode = OMS-wide (affects all screens), or local override
// kioskOnlyMode   = kiosk-only, OMS-driven (stops orders at kiosk/badge; OMS displays stay live)
// printerLockoutMode = kiosk-only, locally auto-triggered on a print failure —
// never touched by the OMS, only clearable via the hidden staff control on
// this kiosk (see the maintenance overlay's tap gesture in app.js). Kept
// separate from kioskOnlyMode so an OMS reconnect/resend can't silently
// clear a lockout the OMS doesn't know about.
let maintenanceMode = false;
let maintenanceReopeningAt = "";
let kioskOnlyMode = false;
let kioskOnlyReopeningAt = "";
let printerLockoutMode = false;
const kioskEventClients = new Set();

function maintenancePayload() {
  const active = maintenanceMode || kioskOnlyMode || printerLockoutMode;
  const reopeningAt = active && !printerLockoutMode ? (maintenanceMode ? maintenanceReopeningAt : kioskOnlyReopeningAt) : "";
  return { active, reopeningAt, printerLockout: printerLockoutMode };
}

function broadcastKioskMaintenance() {
  const data = `event: maintenance\ndata: ${JSON.stringify(maintenancePayload())}\n\n`;
  for (const res of kioskEventClients) {
    try { res.write(data); } catch { kioskEventClients.delete(res); }
  }
}

function connectOmsMaintenance(config) {
  if (!config.omsUrl) return;
  let url;
  try {
    url = new URL(`${config.omsUrl}/pay/events`);
  } catch {
    console.error(`[maintenance] KIOSK_OMS_URL "${config.omsUrl}" is not a valid URL — did you forget "http://"? Not retrying until restart.`);
    return;
  }
  const lib = url.protocol === "https:" ? https : http;
  const req = lib.get(url, res => {
    if (res.statusCode !== 200) {
      console.error(`[maintenance] OMS returned ${res.statusCode} for ${url}, retrying in 10s`);
      res.resume();
      return setTimeout(() => connectOmsMaintenance(config), 10_000);
    }
    console.log(`[maintenance] connected to OMS at ${url}`);
    res.setEncoding("utf8");
    let buf = "";
    let pendingEvent = null;
    let pendingData = null;
    res.on("data", chunk => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          pendingEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          pendingData = line.slice(6);
        } else if (line === "") {
          if (pendingEvent === "maintenance" && pendingData) {
            try {
              const { active, reopeningAt } = JSON.parse(pendingData);
              maintenanceMode = Boolean(active);
              maintenanceReopeningAt = String(reopeningAt ?? "");
              broadcastKioskMaintenance();
              console.log(`[maintenance] OMS signalled: ${maintenanceMode ? "ON" : "OFF"}${maintenanceReopeningAt ? ` reopening ${maintenanceReopeningAt}` : ""}`);
            } catch {}
          }
          if (pendingEvent === "kiosk-maintenance" && pendingData) {
            try {
              const { active, reopeningAt } = JSON.parse(pendingData);
              kioskOnlyMode = Boolean(active);
              kioskOnlyReopeningAt = String(reopeningAt ?? "");
              broadcastKioskMaintenance();
              console.log(`[kiosk-maintenance] OMS signalled: ${kioskOnlyMode ? "ON" : "OFF"}${kioskOnlyReopeningAt ? ` reopening ${kioskOnlyReopeningAt}` : ""}`);
            } catch {}
          }
          pendingEvent = null;
          pendingData = null;
        }
      }
    });
    res.on("end", () => {
      console.error(`[maintenance] OMS connection at ${url} ended, reconnecting in 5s`);
      setTimeout(() => connectOmsMaintenance(config), 5_000);
    });
    res.on("error", err => {
      console.error(`[maintenance] OMS connection at ${url} errored (${err.message}), reconnecting in 5s`);
      setTimeout(() => connectOmsMaintenance(config), 5_000);
    });
  });
  req.on("error", err => {
    console.error(`[maintenance] could not reach OMS at ${url} (${err.message}), retrying in 5s`);
    setTimeout(() => connectOmsMaintenance(config), 5_000);
  });
  req.setTimeout(0);
}

// If KIOSK_OMS_URL is configured, POST printer errors there so the OMS
// staff screen can alert. Fire-and-forget — kiosk flow is not blocked.
function notifyOmsOfPrinterError(config, message) {
  if (!config.omsUrl) return;
  fetch(`${config.omsUrl}/api/printer-alert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: config.location, message, at: new Date().toISOString() })
  }).then(res => {
    if (!res.ok) console.error(`[printer-alert] OMS returned ${res.status} for ${config.omsUrl}/api/printer-alert`);
  }).catch(err => {
    console.error(`[printer-alert] could not reach OMS at ${config.omsUrl} (${err.message})`);
  });
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
          use_stock_images: config.useStockImages,
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

        const orderRequest = { items: body.items };
        const order = config.mockMode
          ? mockOrder(config, orderRequest)
          : await placeOrderWithNetworkRetry(config, orderRequest);
        if (config.mockMode) {
          logMockOrder(order);
        }

        try {
          const printResult = await printOrderSlip(config, order);
          updatePrinterState({ ok: true, status: "idle", message: "Print succeeded." }, true);
          console.log(`[print] order ${order.transaction_id} printed OK (${printResult.bytes} bytes${printResult.dummy ? ", dummy" : ""})`);
          sendJson(res, 200, { ...order, print: printResult });
        } catch (error) {
          updatePrinterState({ ok: false, status: "error", message: error.message });
          console.error(`[print] order ${order.transaction_id} FAILED: ${error.message}`);
          notifyOmsOfPrinterError(config, error.message);
          if (!printerLockoutMode) {
            printerLockoutMode = true;
            broadcastKioskMaintenance();
            console.error("[printer-lockout] engaged — kiosk taken offline until staff clears it locally");
          }
          sendJson(res, 502, {
            ...order,
            error: "printer-error",
            message: "Order was created, but the slip could not be printed.",
            printer_message: error.message
          });
        }
        return;
      }

      if (requestUrl.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.write(`event: maintenance\ndata: ${JSON.stringify(maintenancePayload())}\n\n`);
        kioskEventClients.add(res);
        req.on("close", () => kioskEventClients.delete(res));
        return;
      }

      if (requestUrl.pathname === "/api/sale-positions" && req.method === "POST") {
        const body = await readJson(req);
        const { order_ref, buzzballz_sold } = body ?? {};
        if (Array.isArray(buzzballz_sold) && buzzballz_sold.length) {
          const summary = buzzballz_sold.map(b => `pos${b.position} "${b.name}" x${b.qty}`).join(", ");
          console.log(`[pos-test] order=${order_ref} sold: ${summary}`);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/maintenance" && req.method === "POST") {
        const body = await readJson(req);
        maintenanceMode = Boolean(body.active);
        if (body.reopeningAt !== undefined) maintenanceReopeningAt = String(body.reopeningAt ?? "");
        broadcastKioskMaintenance();
        console.log(`[maintenance] local set: ${maintenanceMode ? "ON" : "OFF"}${maintenanceReopeningAt ? ` reopening ${maintenanceReopeningAt}` : ""}`);
        sendJson(res, 200, { ok: true, active: maintenanceMode, reopeningAt: maintenanceReopeningAt });
        return;
      }

      // Clears the local printer-lockout only — triggered by the hidden
      // staff control on this kiosk's offline screen (see app.js). Never
      // touches maintenanceMode/kioskOnlyMode, which are OMS-driven.
      if (requestUrl.pathname === "/api/printer-lockout/clear" && req.method === "POST") {
        printerLockoutMode = false;
        broadcastKioskMaintenance();
        console.log("[printer-lockout] cleared by staff");
        sendJson(res, 200, { ok: true });
        return;
      }


      if (req.method === "GET" || req.method === "HEAD") {
        // In dummy/mock mode, also serve the receipts/ directory for preview
        if (config.mockMode && req.url.startsWith("/receipts/")) {
          await serveStatic(path.join(process.cwd(), "."), req, res);
          return;
        }
        await serveStatic(config.publicDir, req, res);
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
    connectOmsMaintenance(config);
  });
}
