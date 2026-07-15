import assert from "node:assert/strict";
import test from "node:test";

import { renderSlip, renderSlipHtml, barcodeRasterBytes, COLS } from "../src/slip.js";

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

test("renderSlip wraps a long item description without pushing the price onto its own overflow line", async () => {
  // Long enough to wrap across 3+ lines at COLS=33 — previously the greedy
  // fill pass didn't reserve room for the price on non-last lines, so the
  // organically-wrapped last line could run right up to the column width
  // and force " £X.XX" onto an unindented hardware-wrapped overflow line.
  const longDescOrder = {
    ...ORDER,
    lines: [
      { description: "BuzzBallz Passionfruit Martini (13.5% ABV) 200ml can", quantity: 1, line_total: "6.50" }
    ]
  };
  const buf = await renderSlip(longDescOrder);
  const text = buf.toString("latin1");
  // Scope to the item block only — the rest of the buffer contains raw
  // binary bit-image bytes (logo/barcode) that legitimately contain \n
  // bytes and aren't real printable text lines.
  const itemBlock = text.slice(text.indexOf("1 x "), text.indexOf("Total"));
  const lines = itemBlock.split("\n").filter(Boolean);

  assert.ok(lines.length >= 2, "description actually wrapped across multiple lines");
  for (const line of lines) {
    assert.ok(line.length <= COLS, `line exceeds ${COLS} cols: ${JSON.stringify(line)}`);
  }

  const firstItemLine = lines.find(l => l.startsWith("1 x "));
  assert.ok(firstItemLine, "first item line is present");
  assert.ok(firstItemLine.includes("6.50"), "price is on the first line, next to the qty prefix");
});

test("renderSlip includes Polybius lore header", async () => {
  const buf = await renderSlip(ORDER);
  const text = buf.toString("latin1");
  // Word-wrapped at COLS (33 chars) rather than truncated, so "NETWORK" may
  // land on its own line rather than staying contiguous with "TRADE".
  assert.ok(text.includes("POLYBIUS BIOTECH GALACTIC TRADE"), "vendor line, first part");
  assert.ok(text.includes("NETWORK"), "vendor line, wrapped remainder");
});

// The barcode is rasterized as a bitmap and printed via ESC * in
// single-density mode (not GS v 0 or GS k) — this printer, a confirmed
// Epson TM-U220B, doesn't implement GS k barcode firmware or GS v 0 raster
// graphics correctly, and even ESC * only works in single-density mode.
// See slip.js's header comment and github.com/mike42/escpos-php/issues/98.

test("barcodeRasterBytes sets 16-dot line spacing, then ESC * single-density bands, then resets spacing", () => {
  const raster = barcodeRasterBytes(ORDER.barcode);
  assert.deepEqual([...raster.slice(0, 3)], [0x1B, 0x33, 16], "ESC 3 16 — 16-dot line spacing");
  assert.deepEqual([...raster.slice(-2)], [0x1B, 0x32], "ESC 2 — line spacing reset at the end");
  assert.ok(raster.includes(Buffer.from([0x1B, 0x2A, 0x00])), "contains an ESC * 0 single-density band");
});

// Splitting a band into multiple back-to-back ESC * commands was tried and
// made things worse (broken line spacing) rather than tiling horizontally —
// so each band must fit in a single command, under the printer's observed
// ~192px per-line limit. Parses the exact structure (rather than scanning
// for byte values) since arbitrary bit-image data can coincidentally
// contain a 0x0A byte that isn't really a band-separator line feed.
test("barcodeRasterBytes emits exactly one ESC * command per 8px band, within the printer's per-line limit", () => {
  const raster = barcodeRasterBytes(ORDER.barcode);
  let pos = 3; // after ESC 3 16
  let bandCount = 0;
  while (pos < raster.length - 2) { // before the trailing ESC 2
    assert.equal(raster[pos], 0x1B, "ESC");
    assert.equal(raster[pos + 1], 0x2A, "*");
    assert.equal(raster[pos + 2], 0x00, "single-density");
    const width = raster[pos + 3] | (raster[pos + 4] << 8);
    assert.ok(width <= 192, `band width ${width}px must stay under the printer's per-line limit`);
    pos += 5 + width;
    assert.equal(raster[pos], 0x0A, "exactly one line feed per band, no extra chunk headers");
    pos += 1;
    bandCount++;
  }
  assert.ok(bandCount > 1, "barcode height requires multiple 8px bands");
});

test("barcodeRasterBytes produces different bars for different codes", () => {
  const a = barcodeRasterBytes("0957481733");
  const b = barcodeRasterBytes("1234567890");
  assert.ok(!a.equals(b), "different barcodes rasterize differently");
});

test("barcodeRasterBytes rejects malformed input instead of rendering garbage", () => {
  assert.equal(barcodeRasterBytes("").length, 0, "empty string");
  assert.equal(barcodeRasterBytes("123").length, 0, "odd length (ITF needs pairs of digits)");
  assert.equal(barcodeRasterBytes("KIOSK:123").length, 0, "non-numeric");
});

test("renderSlip prints the barcode raster and the human-readable digits", async () => {
  const buf = await renderSlip(ORDER);
  assert.ok(buf.includes(barcodeRasterBytes(ORDER.barcode)), "barcode raster bytes are present");
  assert.ok(buf.toString("latin1").includes(ORDER.barcode), "barcode also printed as human-readable text");
});

test("renderSlip prints the order number after the header and before the first item line", async () => {
  const buf = await renderSlip(ORDER);
  const text = buf.toString("latin1");
  const orderNumIndex = text.indexOf(ORDER.transaction_id.toString());
  assert.ok(orderNumIndex > text.indexOf("POLYBIUS"), "order number comes after the vendor header");
  assert.ok(orderNumIndex < text.indexOf("Club Mate 500ml"), "order number comes before the item list");
});

test("renderSlip prints £ using the printer's PC437 code point (0x9C), not raw Latin-1 (0xA3)", async () => {
  const buf = await renderSlip(ORDER); // ORDER.total is "9.00" -> priceCol pads to PRICE_COL (7) wide
  const cp437Bytes = Buffer.concat([Buffer.from([0x9C]), Buffer.from("  9.00", "ascii")]);
  assert.ok(buf.includes(cp437Bytes), "total amount uses the PC437 £ byte");
});

test("renderSlip prints accented product names using their real PC437 byte (e.g. é in Rosé)", async () => {
  const roseOrder = {
    ...ORDER,
    lines: [{ description: "Nice Pale Rosé 187ml", quantity: 1, line_total: "6.00" }]
  };
  const buf = await renderSlip(roseOrder);
  const cp437Bytes = Buffer.concat([Buffer.from("Nice Pale Ros", "ascii"), Buffer.from([0x82]), Buffer.from(" 187ml", "ascii")]);
  assert.ok(buf.includes(cp437Bytes), "é uses PC437 byte 0x82, not raw Latin-1 0xE9");
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
