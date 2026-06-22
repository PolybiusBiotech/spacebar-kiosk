// Parse a raw ESC/POS buffer (exactly the bytes sent to the printer) and
// render it as a self-contained HTML file.
//
// Handles the subset of ESC/POS that slip.js emits:
//   ESC @        reset
//   ESC a n      alignment (0=left 1=center 2=right)
//   ESC r n      color (0=black 1=red)
//   ESC E n      bold / emphasis (n≠0 = on)
//   ESC G n      double-strike (n≠0 = on)
//   ESC - n      underline (n≠0 = on)
//   ESC 4 / 5    italic on / off
//   ESC M n      font select (0=Font A standard, 1=Font B condensed)
//   GS ! n       character size (high nibble = width mult-1, low = height mult-1)
//   GS v 0 ...   raster bit image (logo, QR)
//   GS V A 0     full cut (ignored)
//   text + LF    plain ASCII / Latin-1 text

import { deflateSync } from "node:zlib";

// ── Minimal pure-JS PNG encoder ────────────────────────────────────────────

function buildCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC_TABLE = buildCrcTable();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const t  = Buffer.from(type, "ascii");
  const lo = Buffer.allocUnsafe(4); lo.writeUInt32BE(data.length);
  const cr = Buffer.allocUnsafe(4); cr.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([lo, t, data, cr]);
}

// Convert a 1-bit ESC/POS raster block to an RGB PNG data URL.
// 1-bits are ink (black or red); 0-bits are white paper.
function rasterToDataUrl(bytesPerRow, height, raster, inkColor = "black") {
  const width = bytesPerRow * 8;
  const [inkR, inkG, inkB] = inkColor === "red" ? [0xCC, 0x00, 0x00] : [0x00, 0x00, 0x00];

  // Raw image: one filter byte (0 = None) + width*3 RGB bytes per row
  const raw = Buffer.allocUnsafe((1 + width * 3) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const dark = (raster[y * bytesPerRow + (x >> 3)] & (1 << (7 - (x & 7)))) !== 0;
      raw[p++] = dark ? inkR : 0xFF;
      raw[p++] = dark ? inkG : 0xFF;
      raw[p++] = dark ? inkB : 0xFF;
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 2; // RGB truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  return "data:image/png;base64," + png.toString("base64");
}

// ── ESC/POS byte-stream parser ─────────────────────────────────────────────

// Returns an array of line objects:
//   { kind: "text",   align, chunks: [{text, color, bold, dblstrike, underline}] }
//   { kind: "bitmap", align, dataUrl, widthPx, heightPx }
function parseEscPos(buf) {
  let pos       = 0;
  let align     = "left";
  let color     = "black";
  let bold      = false;
  let italic    = false;
  let dblstrike = false;
  let underline = false;
  let fontB       = false; // ESC M 1 — condensed font
  let size        = 1;     // width/height multiplier from GS !
  let tightSpacing = false; // ESC 3 0 — zero inter-line spacing

  const lines  = [];
  let   chunks = []; // accumulate text chunks for the current line

  function flushLine() {
    lines.push({ kind: "text", align, size, tightSpacing, chunks });
    chunks = [];
  }

  while (pos < buf.length) {
    const b = buf[pos];

    if (b === 0x1B) { // ESC sequence
      const cmd = buf[pos + 1];
      if (cmd === 0x40) {
        // ESC @ — reset
        align = "left"; color = "black"; bold = false; italic = false;
        dblstrike = false; underline = false; fontB = false; size = 1; tightSpacing = false; pos += 2;
      } else if (cmd === 0x61) {
        // ESC a n — alignment
        const n = buf[pos + 2];
        align = n === 1 ? "center" : n === 2 ? "right" : "left";
        pos += 3;
      } else if (cmd === 0x45) {
        // ESC E n — emphasis (bold)
        bold = buf[pos + 2] !== 0;
        pos += 3;
      } else if (cmd === 0x4D) {
        // ESC M n — font select (0=A standard, 1=B condensed)
        fontB = buf[pos + 2] !== 0;
        pos += 3;
      } else if (cmd === 0x32) {
        // ESC 2 — restore default line spacing (1/6")
        tightSpacing = false;
        pos += 2;
      } else if (cmd === 0x33) {
        // ESC 3 n — set line spacing; treat n=0 as tight (no inter-line gap)
        tightSpacing = buf[pos + 2] === 0;
        pos += 3;
      } else if (cmd === 0x34) {
        // ESC 4 — italic on
        italic = true;
        pos += 2;
      } else if (cmd === 0x35) {
        // ESC 5 — italic off
        italic = false;
        pos += 2;
      } else if (cmd === 0x47) {
        // ESC G n — double-strike
        dblstrike = buf[pos + 2] !== 0;
        pos += 3;
      } else if (cmd === 0x2D) {
        // ESC - n — underline (0=off, 1=one-dot, 2=two-dot)
        underline = buf[pos + 2] !== 0;
        pos += 3;
      } else if (cmd === 0x72) {
        // ESC r n — color (0=black, 1=red)
        color = buf[pos + 2] === 1 ? "red" : "black";
        pos += 3;
      } else {
        pos++;
      }

    } else if (b === 0x1D) { // GS sequence
      const cmd = buf[pos + 1];
      if (cmd === 0x21) {
        // GS ! n — character size: high nibble = width mult-1, low nibble = height mult-1
        const n = buf[pos + 2];
        size = Math.max((n >> 4) + 1, (n & 0x0F) + 1);
        pos += 3;
      } else if (cmd === 0x76 && buf[pos + 2] === 0x30) {
        // GS v 0 mode xL xH yL yH <data> — raster bit image
        if (chunks.length) flushLine();
        pos += 4; // skip GS, 0x76, 0x30, mode
        const xL = buf[pos++]; const xH = buf[pos++];
        const yL = buf[pos++]; const yH = buf[pos++];
        const bpr    = xL + xH * 256;
        const height = yL + yH * 256;
        const raster = buf.slice(pos, pos + bpr * height);
        pos += bpr * height;
        lines.push({
          kind:    "bitmap",
          align,
          dataUrl: rasterToDataUrl(bpr, height, raster, color),
          widthPx: bpr * 8,
          heightPx: height,
        });
      } else if (cmd === 0x56) {
        // GS V A 0 — full cut; ignore
        pos += 4;
      } else {
        pos++;
      }

    } else if (b === 0x0A) {
      // Line feed — flush current line
      flushLine();
      pos++;

    } else if (b >= 0x20 && b !== 0x1B && b !== 0x1D) {
      // Printable byte (ASCII + Latin-1 extended, e.g. £ = 0xA3)
      // Collect a run while color is unchanged and no ESC/GS interrupts.
      let text = "";
      while (pos < buf.length) {
        const c = buf[pos];
        if (c < 0x20 || c === 0x1B || c === 0x1D) break;
        text += String.fromCharCode(c);
        pos++;
      }
      if (text) chunks.push({ text, color, bold, italic, dblstrike, underline, fontB });

    } else {
      pos++;
    }
  }

  if (chunks.length) flushLine();
  return lines;
}

// ── HTML renderer ──────────────────────────────────────────────────────────

export function escposToHtml(buf, title = "Receipt preview") {
  const lines = parseEscPos(buf);

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const body = lines.map(line => {
    if (line.kind === "bitmap") {
      return `<img src="${line.dataUrl}" width="${line.widthPx}" height="${line.heightPx}" alt="">`;
    }
    const inner = line.chunks.map(c => {
      let t = esc(c.text);
      if (c.fontB)     t = `<span class="fb">${t}</span>`;
      if (c.dblstrike) t = `<span class="ds">${t}</span>`;
      if (c.bold)      t = `<span class="bd">${t}</span>`;
      if (c.italic)    t = `<i>${t}</i>`;
      if (c.underline) t = `<u>${t}</u>`;
      if (c.color === "red") t = `<span class="r">${t}</span>`;
      return t;
    }).join("");
    const lineHeight = line.tightSpacing ? "1" : "1.1";
    const sizeStyle = (line.size > 1 || line.tightSpacing) ? ` style="font-size:${line.size}em;line-height:${lineHeight}"` : "";
    return `<div class="${line.align}"${sizeStyle}>${inner || "&nbsp;"}</div>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body { background: #ccc; display: flex; justify-content: center; padding: 2rem; margin: 0; }
  .slip { background: #fff; font-family: "Courier New", monospace; font-size: 11px;
          width: fit-content; padding: 8px 10px;
          box-shadow: 0 2px 8px rgba(0,0,0,.3); line-height: 1.0; }
  div { white-space: pre; }
  .left   { text-align: left; }
  .center { text-align: center; }
  .right  { text-align: right; }
  .r      { color: #cc0000; }
  .bd     { text-shadow: 0.4px 0 0 currentColor, -0.4px 0 0 currentColor; }
  .ds     { text-shadow: 0.5px 0 0 currentColor; }
  .fb     { font-size: 0.8em; color: #888; letter-spacing: 0.1em; }
  img     { display: block; margin: 2px auto; }
</style>
</head>
<body>
<div class="slip">
${body}
</div>
</body>
</html>`;
}
