// ESC/POS slip generation for Epson U220A (9-pin dot matrix, 76mm, two-colour ribbon).
//
// Barcodes are printed as 1D (ITF) only — QR was dropped because the dot
// matrix printer's ink bleed makes QR codes unreliable to scan, and the
// till's barcode scanners can't read QR at all.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOGO_BMP = resolve(__dir, "../../design/poly claw.bmp");
const LOGO_WIDTH_PX = 80;

function buildLogoDataUrl() {
  try {
    const buf = readFileSync(resolve(__dir, "../public/images/poly-claw.png"));
    return "data:image/png;base64," + buf.toString("base64");
  } catch {
    return "";
  }
}

const LOGO_DATA_URL = buildLogoDataUrl();

const COLS      = 42; // characters per line at standard density on 76mm paper
const PRICE_COL =  7; // fixed price column width — right-aligned, fits up to £999.99

const ESC = 0x1B;
const GS  = 0x1D;

const INIT         = Buffer.from([ESC, 0x40]);           // ESC @ — reset printer
const ALIGN_LEFT   = Buffer.from([ESC, 0x61, 0x00]);
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const COLOR_RED    = Buffer.from([ESC, 0x72, 0x01]);
const COLOR_BLACK  = Buffer.from([ESC, 0x72, 0x00]);
const BOLD_ON       = Buffer.from([ESC, 0x45, 0x01]);
const BOLD_OFF      = Buffer.from([ESC, 0x45, 0x00]);
const DBLSTRIKE_ON  = Buffer.from([ESC, 0x47, 0x01]);
const DBLSTRIKE_OFF = Buffer.from([ESC, 0x47, 0x00]);
const UNDERLINE_ON  = Buffer.from([ESC, 0x2D, 0x01]);
const UNDERLINE_OFF = Buffer.from([ESC, 0x2D, 0x00]);
const SIZE_2X       = Buffer.from([GS,  0x21, 0x11]); // double width + double height
const SIZE_3X       = Buffer.from([GS,  0x21, 0x22]); // triple width + triple height
const SIZE_RESET    = Buffer.from([GS,  0x21, 0x00]);
const LINE_SP_TIGHT = Buffer.from([ESC, 0x33, 0x00]); // ESC 3 0 — zero inter-line spacing
const LINE_SP_RESET = Buffer.from([ESC, 0x32]);       // ESC 2 — restore default 1/6" spacing
const ITALIC_ON     = Buffer.from([ESC, 0x34]);        // ESC 4 — italic (may be silently ignored on U220A)
const ITALIC_OFF    = Buffer.from([ESC, 0x35]);        // ESC 5
const FONT_B        = Buffer.from([ESC, 0x4D, 0x01]); // ESC M 1 — condensed font (smaller on supported printers)
const FONT_A        = Buffer.from([ESC, 0x4D, 0x00]); // ESC M 0 — standard font (reset)
const FULL_CUT      = Buffer.from([GS,  0x56, 0x41, 0x00]);

function t(str) {
  return Buffer.from(`${str}\n`, "ascii");
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

function itemLine(item) {
  const qty    = String(item.quantity ?? 1);
  const price  = priceCol(item.line_total);
  const prefix = `${qty} x `;
  const desc   = String(item.description ?? "");
  // Width available for the description on the first line (price on same line)
  const firstLineDescWidth = COLS - prefix.length - PRICE_COL - 1;

  if (desc.length <= firstLineDescWidth) {
    // Short description fits on one line: pad and right-align price
    return t(`${prefix}${desc.padEnd(firstLineDescWidth)} ${price}`);
  }

  // Long description: wrap across multiple lines; price right-aligned on last line
  // Continuation lines are indented by prefix.length spaces to align under description
  const indent      = " ".repeat(prefix.length);
  const contWidth   = COLS - prefix.length - PRICE_COL - 1;
  const wrapWidth   = COLS - prefix.length; // full wrap width without price

  // Split desc into words and fill lines
  const words  = desc.split(" ");
  const linesArr = [];
  let   current  = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= wrapWidth) {
      current = candidate;
    } else {
      if (current) linesArr.push(current);
      current = word;
    }
  }
  if (current) linesArr.push(current);

  // Build output: first line has prefix, subsequent lines are indented
  const out = [];
  for (let i = 0; i < linesArr.length; i++) {
    const lineText = linesArr[i];
    const isLast   = i === linesArr.length - 1;
    if (i === 0) {
      if (isLast) {
        out.push(t(`${prefix}${lineText.padEnd(firstLineDescWidth)} ${price}`));
      } else {
        out.push(t(`${prefix}${lineText}`));
      }
    } else if (isLast) {
      out.push(t(`${indent}${lineText.padEnd(contWidth)} ${price}`));
    } else {
      out.push(t(`${indent}${lineText}`));
    }
  }
  return Buffer.concat(out);
}

function buildLogoBytes() {
  try {
    const result = spawnSync("magick", [
      LOGO_BMP,
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

    return Buffer.concat([
      Buffer.from([GS, 0x76, 0x30, 0x00,
        bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF,
        h & 0xFF, (h >> 8) & 0xFF]),
      raster,
    ]);
  } catch {
    return Buffer.alloc(0);
  }
}

// Built once at module load — falls back to empty if ImageMagick unavailable.
const LOGO_ESC_POS = buildLogoBytes();

// ── 1D barcode rendering ───────────────────────────────────────────────────
// The barcode string itself (permutation + HMAC check digits) is generated
// by emftillweb and returned verbatim as order.barcode — this module just
// prints it.

function barcode1dBytes(code) {
  return Buffer.concat([
    Buffer.from([GS, 0x68, 80]),  // GS h 80 — barcode height 80 dots
    Buffer.from([GS, 0x77, 3]),   // GS w 3 — module width 3
    Buffer.from([GS, 0x48, 0]),   // GS H 0 — no HRI (printed as text below)
    Buffer.from([GS, 0x6B, 5]),   // GS k 5 — ITF barcode
    Buffer.from(code, "ascii"),
    Buffer.from([0x00]),          // NUL terminator
  ]);
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
  const barcodeEscPos = barcode1dBytes(d.barcode);

  const label  = "Total ";
  const spaces = " ".repeat(Math.max(0, COLS - label.length - PRICE_COL));

  const parts = [
    INIT,
    ALIGN_CENTER,
    COLOR_RED, LOGO_ESC_POS, COLOR_BLACK,
    // vendor: Font B (condensed) to de-emphasise it — matches target's 0.6rem grey styling
    FONT_B, t(d.vendorLine.slice(0, COLS)), FONT_A,
    // "space" is graffiti — normal size (SIZE_RESET), red, bold+italic, offset-left.
    // Both "space" and the official name use SIZE_RESET so the size difference is subtle —
    // matching the target's 0.9rem vs 0.95rem ratio. Bold differentiates the official name.
    ALIGN_LEFT, SIZE_RESET,
    BOLD_ON, ITALIC_ON, COLOR_RED, t("  space"), COLOR_BLACK, ITALIC_OFF, BOLD_OFF,
    // official name centred on its own line — SIZE_RESET + bold only (not double-height)
    // Keeps the name only marginally larger than the graffiti, matching the subtle scale
    // difference in the target. The order number below uses SIZE_2X for the big emphasis.
    ALIGN_CENTER, BOLD_ON, SIZE_RESET, t("Base Asset Retrieval System"), BOLD_OFF,
    t(d.locationLine.slice(0, COLS)),
    // separator BEFORE order number (target has dividers both before and after)
    ALIGN_LEFT, t("-".repeat(COLS)),
    LINE_SP_TIGHT,
    ALIGN_CENTER, BOLD_ON, SIZE_3X, t(d.orderName), SIZE_RESET, BOLD_OFF,
    LINE_SP_RESET,
    ALIGN_LEFT,
    t("-".repeat(COLS)),
  ];

  for (const item of d.lines) {
    parts.push(itemLine(item));
  }

  parts.push(
    // No separator before total — the target has no divider between items and total.
    // Bold + double-strike + red on the total row provides sufficient visual separation,
    // matching the target's border-top approach on the total-row.
    BOLD_ON, DBLSTRIKE_ON, COLOR_RED,
    Buffer.from(label + spaces + priceCol(d.total.slice(1)), "ascii"),
    COLOR_BLACK, DBLSTRIKE_OFF, BOLD_OFF, SIZE_RESET,
    Buffer.from("\n", "ascii"),
    ALIGN_CENTER,
    // status: bold only — no underline in target
    BOLD_ON, t(d.statusLine), BOLD_OFF,
    t(d.statusSub),
    barcodeEscPos,
    t(d.barcode),
    ...(d.createdAt ? [t(`Created: ${d.createdAt}`)] : []),
    ...(d.expiresAt ? [t(`Expires: ${d.expiresAt}`)] : []),
    ALIGN_LEFT, t("-".repeat(COLS)),
    ALIGN_CENTER, ...d.footer.map(l => t(l)),
    FULL_CUT
  );

  return Buffer.concat(parts);
}
