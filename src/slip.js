// ESC/POS slip generation for Epson U220A (9-pin dot matrix, 76mm, two-colour ribbon).
//
// QR code is rendered as a raster bitmap (GS v 0) — the U220A does not support
// the GS ( k QR generation commands.
//
// Requires the `qrcode` npm package.

import QRCode from "qrcode";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOGO_BMP = resolve(__dir, "../../design/poly claw.bmp");
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

const COLS = 42; // characters per line at standard density on 76mm paper

const ESC = 0x1B;
const GS  = 0x1D;

const INIT         = Buffer.from([ESC, 0x40]);           // ESC @ — reset printer
const ALIGN_LEFT   = Buffer.from([ESC, 0x61, 0x00]);
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const COLOR_RED    = Buffer.from([ESC, 0x72, 0x01]);
const COLOR_BLACK  = Buffer.from([ESC, 0x72, 0x00]);
const FULL_CUT     = Buffer.from([GS,  0x56, 0x41, 0x00]);

function t(str) {
  return Buffer.from(`${str}\n`, "ascii");
}

function money(value) {
  const n = Number.parseFloat(value);
  return `£${Number.isFinite(n) ? n.toFixed(2) : "?.??"}`;
}

function itemLine(item) {
  const qty    = String(item.quantity ?? 1);
  const price  = money(item.line_total);
  const prefix = `${qty} x `;
  // right-align price, fill description to width
  const descWidth = COLS - prefix.length - price.length - 1;
  const desc = String(item.description ?? "").slice(0, descWidth).padEnd(descWidth);
  return t(`${prefix}${desc} ${price}`);
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

async function qrBytes(content, scale = 4) {
  const qr      = QRCode.create(content, { errorCorrectionLevel: "M" });
  const size    = qr.modules.size;
  const modules = qr.modules.data; // Uint8Array: 1 = dark, 0 = light

  const pixelWidth  = size * scale;
  const bytesPerRow = Math.ceil(pixelWidth / 8);
  const pixelHeight = size * scale;
  const raster      = Buffer.alloc(bytesPerRow * pixelHeight, 0);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!modules[row * size + col]) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px  = col * scale + sx;
          const py  = row * scale + sy;
          const idx = py * bytesPerRow + Math.floor(px / 8);
          raster[idx] |= 1 << (7 - (px % 8));
        }
      }
    }
  }

  return Buffer.concat([
    Buffer.from([GS, 0x76, 0x30, 0x00,
      bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF,
      pixelHeight  & 0xFF, (pixelHeight  >> 8) & 0xFF]),
    raster
  ]);
}

// ── Shared receipt template ────────────────────────────────────────────────
// Single source of truth for all copy and structure. Both renderSlipHtml and
// renderSlip consume this — add lore here, not in the renderers.

function buildReceiptData(order) {
  const slip = order.slip ?? order;
  return {
    // Header
    vendorLine:  "POLYBIUS BIOTECH GALACTIC TRADE NETWORK",
    nameLine:    "space Base Asset Retrieval System",  // "space" is graffiti
    locationLine: "Spaceport PB-4242 // Commercial Division",

    // Order
    orderName: order.order_name ?? String(order.order_ref ?? "?"),
    lines:     slip.lines ?? [],
    total:     money(slip.total ?? order.total),
    barcode:   order.barcode ?? `KIOSK:${order.order_ref}`,

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
  const qrDataUrl = await QRCode.toDataURL(d.barcode, { errorCorrectionLevel: "M", width: 220, margin: 2 });

  const lineRows = d.lines.map(item => {
    const qty   = item.quantity ?? 1;
    const price = money(item.line_total);
    return `<tr><td>${qty} &times; ${item.description}</td><td class="price">${price}</td></tr>`;
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
  .name { font-size: 0.95rem; font-weight: bold; text-align: center; margin: 0 0 2px; letter-spacing: 0.04em; }
  .name .graffiti { font-style: italic; }
  .location { font-size: 0.65rem; text-align: center; color: #888; margin: 0 0 10px; letter-spacing: 0.08em; }
  .order-num { font-size: 2.2rem; font-weight: bold; text-align: center; margin: 8px 0; letter-spacing: 0.1em; }
  .divider { border: none; border-top: 1px dashed #bbb; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  td { padding: 2px 0; vertical-align: top; }
  td.price { text-align: right; white-space: nowrap; }
  .total-row td { font-weight: bold; font-size: 1rem; border-top: 1px solid #000; padding-top: 4px; }
  .status { text-align: center; font-size: 0.8rem; font-weight: bold; margin: 10px 0 2px; letter-spacing: 0.06em; }
  .status-sub { text-align: center; font-size: 0.7rem; color: #666; margin: 0 0 8px; }
  .qr { text-align: center; margin: 8px 0; }
  .meta { font-size: 0.65rem; color: #aaa; text-align: center; margin: 2px 0; }
  .footer { font-size: 0.6rem; color: #bbb; text-align: center; margin: 2px 0; letter-spacing: 0.06em; }
</style>
</head>
<body>
<div class="receipt">
  ${LOGO_DATA_URL ? `<img class="logo" src="${LOGO_DATA_URL}" alt="">` : ""}
  <p class="vendor">${d.vendorLine}</p>
  <p class="name"><span class="graffiti">space</span> Base Asset Retrieval System</p>
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
  <div class="qr"><img src="${qrDataUrl}" alt="${d.barcode}" width="180"></div>
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

  const label  = "Grand total ";
  const spaces = " ".repeat(Math.max(0, COLS - label.length - d.total.length));

  const parts = [
    INIT,
    ALIGN_CENTER,
    LOGO_ESC_POS,
    t(""),
    t(d.vendorLine.slice(0, COLS)),
    t("space Base Asset Retrieval"),
    t(d.locationLine.slice(0, COLS)),
    t(""),
    t(d.orderName),
    ALIGN_LEFT,
    t("-".repeat(COLS)),
    t(""),
  ];

  for (const item of d.lines) {
    parts.push(itemLine(item));
  }

  parts.push(
    t(""),
    Buffer.from(label + spaces, "ascii"),
    COLOR_RED,
    Buffer.from(d.total, "ascii"),
    COLOR_BLACK,
    Buffer.from("\n", "ascii"),
    t(""),
    ALIGN_CENTER,
    t(d.statusLine),
    t(d.statusSub),
    t(""),
    await qrBytes(d.barcode),
    t(""),
    t("-".repeat(COLS)),
    ...d.footer.map(l => t(l)),
    ALIGN_LEFT,
    t(""), t(""), t(""),
    FULL_CUT
  );

  return Buffer.concat(parts);
}
