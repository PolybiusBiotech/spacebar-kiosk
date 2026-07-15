// ESC/POS slip generation for Epson TM-U220B (9-pin dot matrix, 76mm, two-colour ribbon).
//
// Barcodes are printed as 1D (ITF) only — QR was dropped because the dot
// matrix printer's ink bleed makes QR codes unreliable to scan, and the
// till's barcode scanners can't read QR at all.
//
// The ITF bars are rasterized here and printed as an ESC * single-density
// bit image (see escStarBitImage() below) rather than via the printer's own
// GS k barcode firmware or GS v 0 raster graphics — neither is implemented
// on this printer; both just print the raw command/data bytes as garbled
// text. This is a known TM-U220/U220B quirk: see
// github.com/mike42/escpos-php/issues/98.
//
// Requires ImageMagick (`magick`) on PATH to rasterize the logo — see
// README's Raspberry Pi Install prerequisites.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
// Self-contained within this repo — a prior version pointed outside the repo
// at a monorepo-only path (../../design/poly claw.bmp) that doesn't exist in
// a standalone deploy. Pre-thresholded 1-bit BMP (not the grayscale PNG used
// for the HTML preview) — no on-the-fly dithering needed for print.
const LOGO_SOURCE_IMAGE = resolve(__dir, "../public/images/poly claw.bmp");
// Doubled from 80: escStarBitImage() now prints at double density (twice
// the horizontal dot resolution), so the same dot-column count is half
// the physical width — this restores the logo's original proportions.
const LOGO_WIDTH_PX = 160;

function buildLogoDataUrl() {
  try {
    const buf = readFileSync(resolve(__dir, "../public/images/poly-claw.png"));
    return "data:image/png;base64," + buf.toString("base64");
  } catch {
    return "";
  }
}

const LOGO_DATA_URL = buildLogoDataUrl();

export const COLS = 33; // characters per line at standard density on 76mm paper
const PRICE_COL =  7; // fixed price column width — right-aligned, fits up to £999.99

const ESC = 0x1B;
const GS  = 0x1D;

const INIT         = Buffer.from([ESC, 0x40]);           // ESC @ — reset printer
const ALIGN_LEFT   = Buffer.from([ESC, 0x61, 0x00]);
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const COLOUR_RED    = Buffer.from([ESC, 0x72, 0x01]);
const COLOUR_BLACK  = Buffer.from([ESC, 0x72, 0x00]);
const BOLD_ON       = Buffer.from([ESC, 0x45, 0x01]);
const BOLD_OFF      = Buffer.from([ESC, 0x45, 0x00]);
const DBLSTRIKE_ON  = Buffer.from([ESC, 0x47, 0x01]);
const DBLSTRIKE_OFF = Buffer.from([ESC, 0x47, 0x00]);
const UNDERLINE_ON  = Buffer.from([ESC, 0x2D, 0x01]);
const UNDERLINE_OFF = Buffer.from([ESC, 0x2D, 0x00]);
const SIZE_2X       = Buffer.from([GS,  0x21, 0x11]); // double width + double height
const SIZE_RESET    = Buffer.from([GS,  0x21, 0x00]);
const ITALIC_ON     = Buffer.from([ESC, 0x34]);        // ESC 4 — italic (may be silently ignored on U220A)
const ITALIC_OFF    = Buffer.from([ESC, 0x35]);        // ESC 5
const FONT_B        = Buffer.from([ESC, 0x4D, 0x01]); // ESC M 1 — condensed font (smaller on supported printers)
const FONT_A        = Buffer.from([ESC, 0x4D, 0x00]); // ESC M 0 — standard font (reset)
const SELECT_CP437  = Buffer.from([ESC, 0x74, 0x00]); // ESC t 0 — character code table: PC437
// ESC U 1 — unidirectional print mode. Sticky until ESC @/reset/power-off,
// so setting it once after INIT covers the whole receipt. Per Epson's
// spec this exists specifically to keep multi-band bit images aligned top
// to bottom — the default bidirectional printing (alternating scan
// direction each line for speed) is a plausible explanation for the
// misaligned/garbled results seen when this wasn't set.
const UNIDIRECTIONAL_ON = Buffer.from([ESC, 0x55, 0x01]);
const FULL_CUT      = Buffer.from([GS,  0x56, 0x41, 0x00]);

// Node's ascii/latin1 Buffer encoding writes each character as its raw
// Latin-1 code point byte, but this printer's active code page is PC437
// (selected above), which diverges from Latin-1 for £ and every accented
// Western-European letter product names actually use (e.g. é in "Rosé").
// Verified against unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP437.TXT.
// Plain ASCII (0x00-0x7F) is identical in both and needs no remapping —
// every text-emitting helper below must route through this, not raw
// Buffer.from, so any of these characters get their real PC437 byte.
const CP437_OVERRIDES = {
  "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ä": 0x84,
  "à": 0x85, "å": 0x86, "ç": 0x87, "ê": 0x88, "ë": 0x89,
  "è": 0x8A, "ï": 0x8B, "î": 0x8C, "ì": 0x8D, "Ä": 0x8E,
  "Å": 0x8F, "É": 0x90, "æ": 0x91, "Æ": 0x92, "ô": 0x93,
  "ö": 0x94, "ò": 0x95, "û": 0x96, "ù": 0x97, "ÿ": 0x98,
  "Ö": 0x99, "Ü": 0x9A, "¢": 0x9B, "£": 0x9C, "¥": 0x9D,
  "ƒ": 0x9F, "á": 0xA0, "í": 0xA1, "ó": 0xA2, "ú": 0xA3,
  "ñ": 0xA4, "Ñ": 0xA5,
};

function encodeText(str) {
  const parts = [];
  let plain = "";
  for (const ch of String(str)) {
    const overrideByte = CP437_OVERRIDES[ch];
    if (overrideByte === undefined) {
      plain += ch;
      continue;
    }
    if (plain) { parts.push(Buffer.from(plain, "ascii")); plain = ""; }
    parts.push(Buffer.from([overrideByte]));
  }
  if (plain) parts.push(Buffer.from(plain, "ascii"));
  return Buffer.concat(parts);
}

function t(str) {
  return Buffer.concat([encodeText(str), Buffer.from("\n", "ascii")]);
}

function money(value) {
  const n = Number.parseFloat(value);
  return `£${Number.isFinite(n) ? n.toFixed(2) : "?.??"}`;
}

// Fixed-width price for the ESC/POS price column: £ pinned at position 0,
// number right-aligned within the remaining (PRICE_COL - 1) chars.
function priceCol(value) {
  const n = Number.parseFloat(value);
  return "£" + (Number.isFinite(n) ? n.toFixed(2) : "?.??").padStart(PRICE_COL - 1);
}

// Word-wrap into lines <= width chars — avoids cutting a word mid-letter.
function wrapWords(text, width) {
  const words = String(text).split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function itemLine(item) {
  const qty    = String(item.quantity ?? 1);
  const price  = priceCol(item.line_total);
  const prefix = `${qty} x `;
  const desc   = String(item.description ?? "");
  // Width available for description text on any line — the price column is
  // reserved on every line (not just the one printing it) so a long word-
  // wrapped line can never grow too long to fit " £X.XX" after it and push
  // the price onto the printer's own unindented overflow-wrap line.
  const descWidth = COLS - prefix.length - PRICE_COL - 1;

  if (desc.length <= descWidth) {
    // Short description fits on one line: pad and right-align price
    return t(`${prefix}${desc.padEnd(descWidth)} ${price}`);
  }

  // Long description: wrap across multiple lines, all at the same reserved
  // width. Price prints on the first line (with the qty prefix) rather than
  // the last, so it stays next to the quantity regardless of how many lines
  // the description wraps to. Continuation lines are indented by
  // prefix.length spaces to align under the description.
  const indent = " ".repeat(prefix.length);
  const linesArr = wrapWords(desc, descWidth);

  const out = [];
  for (let i = 0; i < linesArr.length; i++) {
    const lineText = linesArr[i];
    if (i === 0) {
      out.push(t(`${prefix}${lineText.padEnd(descWidth)} ${price}`));
    } else {
      out.push(t(`${indent}${lineText}`));
    }
  }
  return Buffer.concat(out);
}

// ESC * m=0 (8-dot single-density) column-format bit image — confirmed
// working on the TM-U220/TM-U220B by mike42/escpos-php (github.com/mike42/
// escpos-php/issues/98): GS v 0 (raster graphics) isn't implemented on this
// printer family at all, and even ESC * only works in single-density mode —
// higher-density modes (the library's default) print garbage on the U220B,
// which matches exactly what we saw with GS v 0.
//
// Line spacing is explicitly set to 16 dots between 8-pixel bands — per
// the same reference, this is "the correct value on both TM-T20 and
// TM-U220" for stacking single-density bands without gaps or overlap.
const LINE_SPACING_16    = Buffer.from([ESC, 0x33, 16]); // ESC 3 16
const LINE_SPACING_RESET = Buffer.from([ESC, 0x32]);     // ESC 2 — revert to default

// This printer garbled a single ESC * command past ~192 dots at single
// density (m=0), and chunking into multiple commands per band made it
// worse (broken line spacing) rather than better. Per Stephen Early (who
// has hands-on ESC/POS dot-matrix experience): this printer defaults to
// bidirectional printing (alternating scan direction each line for speed)
// and single-density mode moves the print head faster than its
// controller can keep up with for bit-image data — both better
// explanations than a hard fixed-width buffer limit, and confirmed by a
// real print: UNIDIRECTIONAL_ON + double-density mode (m=1, half the head
// speed) printed the barcode cleanly with no garbling, at a full width
// that would previously have corrupted. Module widths (ITF_NARROW_PX/
// ITF_WIDE_PX, LOGO_WIDTH_PX) are doubled from that test to compensate
// for double density's 2x horizontal resolution.
const ESC_STAR_MAX_WIDTH_PX = 400; // loose sanity bound, not a tuned hardware limit

// `raster` is row-major, 1 bit per pixel, MSB-first, `bytesPerRow` bytes
// per row, `height` rows — the same format buildLogoBytes()'s PBM parsing
// and barcodeRasterBytes()'s bit-packing both already produce. Throws if
// `width` is unreasonably large — a sanity check, not a tuned limit (see
// ESC_STAR_MAX_WIDTH_PX).
function escStarBitImage(bytesPerRow, height, raster) {
  const width = bytesPerRow * 8;
  if (width > ESC_STAR_MAX_WIDTH_PX) {
    throw new Error(`escStarBitImage: width ${width}px exceeds the sanity bound of ${ESC_STAR_MAX_WIDTH_PX}px`);
  }
  const bandCount = Math.ceil(height / 8);
  const parts = [LINE_SPACING_16];

  for (let band = 0; band < bandCount; band++) {
    const yStart = band * 8;
    const colData = Buffer.alloc(width);
    for (let x = 0; x < width; x++) {
      let byteVal = 0;
      for (let bit = 0; bit < 8; bit++) {
        const y = yStart + bit;
        if (y >= height) continue;
        const srcByteIndex = y * bytesPerRow + (x >> 3);
        const srcBitMask = 0x80 >> (x & 7);
        if (raster[srcByteIndex] & srcBitMask) byteVal |= (0x80 >> bit);
      }
      colData[x] = byteVal;
    }
    // ESC * 1 — 8-dot DOUBLE density (m=1), not single (m=0): half the
    // print head speed, per Stephen Early's advice above.
    parts.push(Buffer.from([ESC, 0x2A, 0x01, width & 0xFF, (width >> 8) & 0xFF]), colData, Buffer.from([0x0A]));
  }

  parts.push(LINE_SPACING_RESET);
  return Buffer.concat(parts);
}

function buildLogoBytes() {
  try {
    const result = spawnSync("magick", [
      LOGO_SOURCE_IMAGE,
      "-resize", `${LOGO_WIDTH_PX}x`,
      "-depth", "1",
      "pbm:-",
    ], { maxBuffer: 4 * 1024 * 1024 });

    if (result.status !== 0 || !result.stdout?.length) return Buffer.alloc(0);

    const pbm = result.stdout;
    let pos = 0;
    const headerLines = [];
    while (headerLines.length < 2 && pos < pbm.length) {
      const nl = pbm.indexOf(0x0A, pos);
      if (nl === -1) break;
      const line = pbm.slice(pos, nl).toString("ascii").trim();
      pos = nl + 1;
      if (!line.startsWith("#")) headerLines.push(line);
    }
    if (headerLines[0] !== "P4") return Buffer.alloc(0);
    const [w, h] = headerLines[1].split(/\s+/).map(Number);
    const bytesPerRow = Math.ceil(w / 8);
    const raster = pbm.slice(pos, pos + bytesPerRow * h);

    return escStarBitImage(bytesPerRow, h, raster);
  } catch {
    return Buffer.alloc(0);
  }
}

// Built once at module load — falls back to empty if ImageMagick unavailable.
const LOGO_ESC_POS = buildLogoBytes();

// ── 1D barcode rendering ───────────────────────────────────────────────────
// The barcode string itself (permutation + HMAC check digits) is generated
// by emftillweb and returned verbatim as order.barcode — this module rasters
// it as an Interleaved 2 of 5 (ITF) bitmap and prints it via the same
// ESC * single-density bit image mechanism as the logo (see file header),
// rather than the printer's own GS k barcode firmware, which this printer
// doesn't implement correctly.

// Element widths per digit (0=narrow, 1=wide), standard ITF encoding.
const ITF_DIGIT_WIDTHS = [
  [0, 0, 1, 1, 0], // 0
  [1, 0, 0, 0, 1], // 1
  [0, 1, 0, 0, 1], // 2
  [1, 1, 0, 0, 0], // 3
  [0, 0, 1, 0, 1], // 4
  [1, 0, 1, 0, 0], // 5
  [0, 1, 1, 0, 0], // 6
  [0, 0, 0, 1, 1], // 7
  [1, 0, 0, 1, 0], // 8
  [0, 1, 0, 1, 0], // 9
];

// escStarBitImage() prints at double density (twice the horizontal dot
// resolution), so these dot counts are half the physical bar width —
// narrow=3/wide=8 here is the original bleed-resistant design intent,
// same physical size as narrow=1.5/wide=4 would be at single density.
const ITF_NARROW_PX = 3;
const ITF_WIDE_PX   = 8; // ratio 2.67, within the ITF-spec 2.25-3.0 range
const ITF_QUIET_PX  = ITF_NARROW_PX * 10; // ITF spec: quiet zone >= 10x the narrow bar width
const ITF_HEIGHT_PX = 70;

// Returns [{ bar: bool, width: px }, ...] left-to-right for a barcode
// encoding `code` (must be an even-length decimal string).
function itfElements(code) {
  const elements = [];
  const push = (bar, wide) => elements.push({ bar, width: wide ? ITF_WIDE_PX : ITF_NARROW_PX });

  push(true, false); push(false, false); push(true, false); push(false, false); // start: N N N N
  for (let i = 0; i < code.length; i += 2) {
    const barDigit = ITF_DIGIT_WIDTHS[Number(code[i])];
    const spaceDigit = ITF_DIGIT_WIDTHS[Number(code[i + 1])];
    for (let j = 0; j < 5; j++) {
      push(true, !!barDigit[j]);
      push(false, !!spaceDigit[j]);
    }
  }
  push(true, true); push(false, false); push(true, false); // stop: W N N

  return elements;
}

export function barcodeRasterBytes(code) {
  if (!code || code.length % 2 !== 0 || !/^\d+$/.test(code)) return Buffer.alloc(0);

  const elements = itfElements(code);
  const barsWidth = elements.reduce((sum, el) => sum + el.width, 0);
  const totalWidth = barsWidth + ITF_QUIET_PX * 2;
  const bytesPerRow = Math.ceil(totalWidth / 8);
  const raster = Buffer.alloc(bytesPerRow * ITF_HEIGHT_PX, 0);

  let x = ITF_QUIET_PX;
  for (const el of elements) {
    if (el.bar) {
      for (let dx = 0; dx < el.width; dx++) {
        const col = x + dx;
        const byteIndex = col >> 3;
        const bitMask = 0x80 >> (col & 7);
        for (let row = 0; row < ITF_HEIGHT_PX; row++) {
          raster[row * bytesPerRow + byteIndex] |= bitMask;
        }
      }
    }
    x += el.width;
  }

  return escStarBitImage(bytesPerRow, ITF_HEIGHT_PX, raster);
}

// ── Shared receipt template ────────────────────────────────────────────────
// Single source of truth for all copy and structure. Both renderSlipHtml and
// renderSlip consume this — add lore here, not in the renderers.

function buildReceiptData(order) {
  const barcode = order.barcode ?? "";
  return {
    // Header
    vendorLine:  "POLYBIUS BIOTECH GALACTIC TRADE NETWORK",
    nameLine:    "space Base Asset Retrieval System",  // "space" is graffiti
    locationLine: "Spaceport PB-4242 // Commercial Division",

    // Order
    orderName: String(order.transaction_id ?? "?"),
    lines:     order.lines ?? [],
    total:     money(order.total),
    barcode,

    // Status
    statusLine:    "CREDIT TRANSFER PENDING",
    statusSub:     "Present this slip at the payment node",

    // Footer lore
    footer: [
      "All transactions monitored by",
      "Polybius Compliance Division",
    ],

    // Timestamps
    createdAt: order.created_at ? new Date(order.created_at).toLocaleTimeString("en-GB") : "",
    expiresAt: order.expires_at ? new Date(order.expires_at).toLocaleTimeString("en-GB") : "",
  };
}

// ── HTML receipt ───────────────────────────────────────────────────────────

export async function renderSlipHtml(order) {
  const d = buildReceiptData(order);
  const barcodeSection = `<div class="barcode"><p class="barcode-1d">${d.barcode}</p></div>`;

  const lineRows = d.lines.map(item => {
    const qty   = item.quantity ?? 1;
    const price = money(item.line_total);
    return `<tr><td class="desc">${qty} &times; ${item.description}</td><td class="price">${price}</td></tr>`;
  }).join("\n");

  const footerLines = d.footer.map(l => `<p class="footer">${l}</p>`).join("\n");
  const timeMeta = d.createdAt
    ? `<p class="meta">Created: ${d.createdAt}${d.expiresAt ? ` &middot; Expires: ${d.expiresAt}` : ""}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Receipt ${d.orderName}</title>
<style>
  body { font-family: "Courier New", monospace; background: #f0f0f0; display: flex; justify-content: center; padding: 2rem; margin: 0; }
  .receipt { background: #fff; width: 288px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  .logo { display: block; margin: 0 auto 8px; width: 64px; opacity: 0.7; filter: invert(1); }
  .vendor { font-size: 0.6rem; text-align: center; letter-spacing: 0.12em; color: #999; margin: 0 0 2px; text-transform: uppercase; }
  .name-wrap { position: relative; text-align: center; margin: 0 0 2px; }
  .name { font-size: 0.95rem; font-weight: bold; display: inline-block; letter-spacing: 0.04em; }
  .graffiti { font-size: 0.9rem; font-style: italic; font-weight: bold; color: #cc0000;
              display: block; text-align: left; margin-left: 8px; margin-bottom: -2px; letter-spacing: 0.02em; }
  .location { font-size: 0.65rem; text-align: center; color: #888; margin: 0 0 10px; letter-spacing: 0.08em; }
  .order-num { font-size: 2.2rem; font-weight: bold; text-align: center; margin: 8px 0; letter-spacing: 0.1em; }
  .divider { border: none; border-top: 1px dashed #bbb; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: fixed; }
  td { padding: 2px 0; vertical-align: top; }
  td.desc { word-break: break-word; padding-left: 4ch; text-indent: -4ch; }
  td.price { width: 4.5em; text-align: right; white-space: nowrap; }
  .total-row td { font-weight: bold; font-size: 1rem; border-top: 1px solid #000; padding-top: 4px; color: #cc0000; }
  .status { text-align: center; font-size: 0.8rem; font-weight: bold; margin: 10px 0 2px; letter-spacing: 0.06em; }
  .status-sub { text-align: center; font-size: 0.7rem; color: #666; margin: 0 0 8px; }
  .barcode { text-align: center; margin: 8px 0; }
  .barcode-1d { font-size: 1.8rem; font-weight: bold; letter-spacing: 0.25em; margin: 4px 0; }
  .meta { font-size: 0.65rem; color: #aaa; text-align: center; margin: 2px 0; }
  .footer { font-size: 0.6rem; color: #bbb; text-align: center; margin: 2px 0; letter-spacing: 0.06em; }
</style>
</head>
<body>
<div class="receipt">
  ${LOGO_DATA_URL ? `<img class="logo" src="${LOGO_DATA_URL}" alt="">` : ""}
  <p class="vendor">${d.vendorLine}</p>
  <div class="name-wrap">
    <span class="graffiti">space</span>
    <span class="name">Base Asset Retrieval System</span>
  </div>
  <p class="location">${d.locationLine}</p>
  <hr class="divider">
  <div class="order-num">${d.orderName}</div>
  <hr class="divider">
  <table>
    ${lineRows}
    <tr class="total-row"><td>Total</td><td class="price">${d.total}</td></tr>
  </table>
  <p class="status">${d.statusLine}</p>
  <p class="status-sub">${d.statusSub}</p>
  ${barcodeSection}
  <p class="meta">${d.barcode}</p>
  ${timeMeta}
  <hr class="divider">
  ${footerLines}
</div>
</body>
</html>`;
}

// ── ESC/POS receipt ────────────────────────────────────────────────────────

export async function renderSlip(order) {
  const d = buildReceiptData(order);
  const barcodeRaster = barcodeRasterBytes(d.barcode);

  const label  = "Total ";
  const spaces = " ".repeat(Math.max(0, COLS - label.length - PRICE_COL));

  const parts = [
    INIT,
    SELECT_CP437,
    UNIDIRECTIONAL_ON,
    ALIGN_CENTER,
    COLOUR_RED, LOGO_ESC_POS, COLOUR_BLACK,
    t(""),
    // vendor: Font B (condensed) to de-emphasise it — matches target's 0.6rem grey styling
    FONT_B, ...wrapWords(d.vendorLine, COLS).map(l => t(l)), FONT_A,
    // "space" is graffiti — normal size (SIZE_RESET), red, bold+italic, offset-left.
    // Both "space" and the official name use SIZE_RESET so the size difference is subtle —
    // matching the target's 0.9rem vs 0.95rem ratio. Bold differentiates the official name.
    ALIGN_LEFT, SIZE_RESET,
    BOLD_ON, ITALIC_ON, COLOUR_RED, t("  space"), COLOUR_BLACK, ITALIC_OFF, BOLD_OFF,
    // official name centred on its own line — SIZE_RESET + bold only (not double-height)
    // Keeps the name only marginally larger than the graffiti, matching the subtle scale
    // difference in the target.
    ALIGN_CENTER, BOLD_ON, SIZE_RESET, t("Base Asset Retrieval System"), BOLD_OFF,
    ...wrapWords(d.locationLine, COLS).map(l => t(l)),
    // Order number sits between the header and the item list — SIZE_2X
    // (not 3X) with normal line spacing: SIZE_3X combined with zero-line-
    // spacing rendered as an illegible smudge on this printer.
    ALIGN_LEFT, t("-".repeat(COLS)),
    ALIGN_CENTER, BOLD_ON, SIZE_2X, t(d.orderName), SIZE_RESET, BOLD_OFF,
    ALIGN_LEFT, t("-".repeat(COLS)),
  ];

  for (const item of d.lines) {
    parts.push(itemLine(item));
  }

  parts.push(
    // No separator before total — the target has no divider between items and total.
    // Bold + double-strike + red on the total row provides sufficient visual separation,
    // matching the target's border-top approach on the total-row.
    BOLD_ON, DBLSTRIKE_ON, COLOUR_RED,
    encodeText(label + spaces + priceCol(d.total.slice(1))),
    COLOUR_BLACK, DBLSTRIKE_OFF, BOLD_OFF, SIZE_RESET,
    Buffer.from("\n", "ascii"),
    ALIGN_CENTER,
    // status: bold only — no underline in target
    BOLD_ON, t(d.statusLine), BOLD_OFF,
    t(d.statusSub),
    // Force black explicitly right before the bit image — on this printer,
    // ESC * bit-image printing didn't pick up the COLOUR_BLACK set earlier
    // and printed in red regardless.
    COLOUR_BLACK,
    barcodeRaster,
    t(d.barcode),
    COLOUR_RED,
    ...(d.createdAt ? [t(`Created: ${d.createdAt}`)] : []),
    ...(d.expiresAt ? [t(`Expires: ${d.expiresAt}`)] : []),
    ALIGN_LEFT, t("-".repeat(COLS)),
    ALIGN_CENTER, COLOUR_RED, ...d.footer.map(l => t(l)),
    FULL_CUT
  );

  return Buffer.concat(parts);
}
