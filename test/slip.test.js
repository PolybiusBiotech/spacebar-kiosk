import assert from "node:assert/strict";
import test from "node:test";

import { renderSlip, renderSlipHtml } from "../src/slip.js";

// Matches emftillweb's order response shape (emf/kiosk.py _order_to_dict()):
// barcode is the pre-permuted, pre-HMAC'd 1D barcode string — slip.js is a
// thin pass-through and does no barcode computation of its own.
const ORDER = {
  transaction_id: 9574,
  barcode: "0957481234",
  total: "9.00",
  created_at: "2026-06-15T15:44:10.000Z",
  expires_at: "2026-06-15T16:44:10.000Z",
  lines: [
    { description: "Club Mate 500ml", quantity: 2, unit_price: "2.80", line_total: "5.60" },
    { description: "BuzzBallz Watermelon", quantity: 1, unit_price: "4.50", line_total: "4.50" }
  ]
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
  assert.ok(text.includes("Total"), "total label");
  assert.ok(text.includes("CREDIT TRANSFER PENDING"), "status line");
  assert.ok(text.includes("Present this slip at the payment node"), "status sub");
});

test("renderSlip includes Polybius lore header", async () => {
  const buf = await renderSlip(ORDER);
  const text = buf.toString("latin1");
  assert.ok(text.includes("POLYBIUS BIOTECH GALACTIC TRADE NETWORK"), "vendor line");
});

test("renderSlip prints order.barcode verbatim as an ITF (1D) barcode", async () => {
  const buf = await renderSlip(ORDER);
  const itfCommand = Buffer.concat([
    Buffer.from([0x1D, 0x6B, 70, ORDER.barcode.length]), // GS k 70 n — ITF, new (explicit-length) format
    Buffer.from(ORDER.barcode, "ascii"),
  ]);
  assert.ok(buf.includes(itfCommand), "ITF barcode command encodes order.barcode verbatim");
  assert.ok(buf.toString("latin1").includes(ORDER.barcode), "barcode also printed as human-readable text");
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

test("renderSlipHtml shows order.barcode as plain text, not a QR image", async () => {
  const html = await renderSlipHtml(ORDER);
  assert.ok(html.includes(`<p class="barcode-1d">${ORDER.barcode}</p>`), "barcode digits shown as text");
  assert.ok(!html.includes(`<img src="data:image/png;base64,`), "no QR image embedded");
});

test("renderSlipHtml uses order.barcode verbatim (thin pass-through, no recomputation)", async () => {
  const orderWithDistinctBarcode = { ...ORDER, barcode: "1234567890" };
  const html = await renderSlipHtml(orderWithDistinctBarcode);
  assert.ok(html.includes("1234567890"), "uses order.barcode");
  assert.ok(!html.includes(ORDER.barcode), "not the original fixture barcode");
});

test("renderSlipHtml falls back to an empty barcode when the field is absent", async () => {
  const { barcode: _, ...orderWithoutBarcode } = ORDER;
  const html = await renderSlipHtml(orderWithoutBarcode);
  assert.ok(html.includes('<p class="barcode-1d"></p>'), "empty barcode, no crash");
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
