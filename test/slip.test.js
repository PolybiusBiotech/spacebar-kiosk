import assert from "node:assert/strict";
import test from "node:test";

import { renderSlip, renderSlipHtml } from "../src/slip.js";

const ORDER = {
  order_ref: "9574",
  order_name: "9574",
  barcode: "KIOSK:9574381",
  total: "9.00",
  created_at: "2026-06-15T15:44:10.000Z",
  expires_at: "2026-06-15T16:44:10.000Z",
  slip: {
    total: "9.00",
    lines: [
      { description: "Club Mate 500ml", quantity: 2, unit_price: "2.80", line_total: "5.60" },
      { description: "BuzzBallz Watermelon", quantity: 1, unit_price: "4.50", line_total: "4.50" }
    ]
  }
};

// ── renderSlip (ESC/POS binary) ────────────────────────────────────────────

test("renderSlip returns a Buffer", async () => {
  const buf = await renderSlip(ORDER);
  assert.ok(buf instanceof Buffer);
  assert.ok(buf.length > 0);
});

test("renderSlip starts with ESC @ (printer init)", async () => {
  const buf = await renderSlip(ORDER);
  assert.equal(buf[0], 0x1B, "ESC");
  assert.equal(buf[1], 0x40, "@");
});

test("renderSlip ends with full cut command (GS V A 0)", async () => {
  const buf = await renderSlip(ORDER);
  const tail = buf.slice(-4);
  assert.equal(tail[0], 0x1D, "GS");
  assert.equal(tail[1], 0x56, "V");
  assert.equal(tail[2], 0x41, "A");
  assert.equal(tail[3], 0x00, "0");
});

test("renderSlip includes order name, item description, status, and total label", async () => {
  const buf = await renderSlip(ORDER);
  const text = buf.toString("latin1");
  assert.ok(text.includes("9574"), "order name");
  assert.ok(text.includes("Club Mate 500ml"), "line item description");
  assert.ok(text.includes("BuzzBallz Watermelon"), "second line item");
  assert.ok(text.includes("Grand total"), "total label");
  assert.ok(text.includes("CREDIT TRANSFER PENDING"), "status line");
  assert.ok(text.includes("Present this slip at the payment node"), "status sub");
});

test("renderSlip includes Polybius lore header", async () => {
  const buf = await renderSlip(ORDER);
  const text = buf.toString("latin1");
  assert.ok(text.includes("POLYBIUS BIOTECH GALACTIC TRADE NETWORK"), "vendor line");
});

test("renderSlip uses order.barcode for QR (not bare order_ref)", async () => {
  // The barcode string is the input to qrBytes — it's encoded as a QR bitmap,
  // so we can't grep for it directly. We verify the HTML version (which embeds
  // it as text) to confirm buildReceiptData picks up order.barcode.
  const orderWithDistinctBarcode = { ...ORDER, barcode: "KIOSK:9574999" };
  const html = await renderSlipHtml(orderWithDistinctBarcode);
  assert.ok(html.includes("KIOSK:9574999"), "uses order.barcode");
  assert.ok(!html.includes("KIOSK:9574381"), "not the original fixture barcode");
});

// ── renderSlipHtml ─────────────────────────────────────────────────────────

test("renderSlipHtml returns a complete HTML document", async () => {
  const html = await renderSlipHtml(ORDER);
  assert.ok(html.startsWith("<!doctype html>"), "starts with doctype");
  assert.ok(html.includes("</html>"), "complete document");
});

test("renderSlipHtml includes order number, items, and total", async () => {
  const html = await renderSlipHtml(ORDER);
  assert.ok(html.includes(">9574<"), "order number in heading");
  assert.ok(html.includes("Club Mate 500ml"), "first line item description");
  assert.ok(html.includes("BuzzBallz Watermelon"), "second line item description");
  assert.ok(html.includes("2 &times;"), "quantity with HTML entity");
  assert.ok(html.includes("£9.00"), "total amount");
});

test("renderSlipHtml embeds QR code as base64 data URL", async () => {
  const html = await renderSlipHtml(ORDER);
  assert.ok(html.includes("data:image/png;base64,"), "QR embedded as PNG data URL");
});

test("renderSlipHtml uses order.barcode in QR alt text and barcode display", async () => {
  const html = await renderSlipHtml(ORDER);
  assert.ok(html.includes('alt="KIOSK:9574381"'), "barcode in img alt text");
  assert.ok(html.includes("KIOSK:9574381"), "barcode visible in receipt body");
});

test("renderSlipHtml falls back to KIOSK:<order_ref> when barcode field absent", async () => {
  const { barcode: _, ...orderWithoutBarcode } = ORDER;
  const html = await renderSlipHtml(orderWithoutBarcode);
  assert.ok(html.includes("KIOSK:9574"), "fallback includes order_ref");
});

test("renderSlipHtml includes timestamps when present", async () => {
  const html = await renderSlipHtml(ORDER);
  assert.ok(html.includes("Created:"), "creation time shown");
  assert.ok(html.includes("Expires:"), "expiry time shown");
});

test("renderSlipHtml omits timestamps when absent", async () => {
  const { created_at: _, expires_at: __, ...orderNoTime } = ORDER;
  const html = await renderSlipHtml(orderNoTime);
  assert.ok(!html.includes("Created:"), "no creation time");
});

test("renderSlipHtml includes Polybius lore footer", async () => {
  const html = await renderSlipHtml(ORDER);
  assert.ok(html.includes("Polybius Compliance Division"), "footer lore");
});
