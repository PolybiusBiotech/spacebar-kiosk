import { open as fsOpen, write as fsWrite, read as fsRead, close as fsClose, constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderSlip, renderSlipHtml } from "./slip.js";
import { escposToHtml } from "./escpos-render.js";

function printArgs(config) {
  if (config.printCommand === "lpr") {
    return config.printerName ? ["-P", config.printerName] : [];
  }

  return [
    ...(config.printerName ? ["-d", config.printerName] : []),
    "-t",
    "Spacebar kiosk order"
  ];
}

// ─── CUPS-level status check (lpstat) ────────────────────────────────────────
//
// Detects USB disconnection and CUPS queue state. lp exits 0 even when the
// printer is offline (job is silently queued), so we must check separately.
// Only checks a named printer — if no printerName is configured, returns ok
// and lets lp use the CUPS default (exit code is the only error signal then).

function checkCupsStatus(printerName) {
  return new Promise((resolve) => {
    const child = spawn("lpstat", ["-p", printerName], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });

    child.on("error", () => {
      resolve({ ok: false, status: "cups-unavailable", message: "lpstat not found — is CUPS installed?" });
    });

    child.on("close", code => {
      if (code !== 0) {
        const msg = stderr.trim() || `lpstat exited with code ${code}`;
        resolve({ ok: false, status: "printer-not-found", message: msg });
        return;
      }
      if (stdout.includes("is idle") || stdout.includes("is printing")) {
        resolve({ ok: true, status: "idle", message: "Printer ready." });
      } else if (stdout.includes("is not available")) {
        resolve({ ok: false, status: "offline", message: "Printer is offline or not connected." });
      } else if (stdout.includes("is disabled")) {
        resolve({ ok: false, status: "paused", message: "Printer is paused — check CUPS queue." });
      } else {
        resolve({ ok: false, status: "unknown", message: stdout.trim() || "Unrecognised lpstat output." });
      }
    });
  });
}

// ─── ESC/POS hardware status check (DLE EOT) ─────────────────────────────────
//
// Sends ESC/POS real-time status queries directly to the USB device while
// the CUPS queue is idle. Detects paper-out, cover-open, and ribbon errors
// that lpstat cannot see.
//
// Requires KIOSK_PRINTER_DEVICE to be set (e.g. /dev/usb/lp0). The kiosk
// user needs read/write access — on Raspberry Pi OS the `lp` group already
// has this; the CUPS install adds the user to lp automatically.
//
// DLE EOT (0x10 0x04 n):
//   n=1  printer status  — bit 3: offline (1 = offline)
//   n=2  offline cause   — bit 6: paper-out, bit 2: cover-open, bit 5: error

function dleEotQuery(fd, n, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    function settle(v) { if (!settled) { settled = true; resolve(v); } }
    const timer = setTimeout(() => settle(null), timeoutMs);

    const cmd = Buffer.from([0x10, 0x04, n]);
    fsWrite(fd, cmd, 0, cmd.length, (err) => {
      if (err) { clearTimeout(timer); settle(null); return; }
      const buf = Buffer.alloc(1);
      fsRead(fd, buf, 0, 1, null, (err, bytesRead) => {
        clearTimeout(timer);
        settle(err || bytesRead !== 1 ? null : buf[0]);
      });
    });
  });
}

async function checkPrinterHardwareStatus(devicePath) {
  const fd = await new Promise((resolve) => {
    fsOpen(devicePath, fsConstants.O_RDWR | fsConstants.O_NOCTTY, (err, f) => resolve(err ? null : f));
  });

  if (fd === null) {
    // Not accessible (ENOENT, EACCES, ENXIO) — skip gracefully.
    return { ok: true, hardwareCheckSkipped: true };
  }

  try {
    // n=1: basic printer status — bit 3 set = offline
    const s1 = await dleEotQuery(fd, 1, 400);
    if (s1 === null) {
      // No response — printer doesn't support DLE EOT or timed out; skip.
      return { ok: true, hardwareCheckSkipped: true };
    }

    if (!(s1 & 0x08)) {
      return { ok: true, status: "idle", message: "Printer online." };
    }

    // n=2: offline cause
    const s2 = await dleEotQuery(fd, 2, 400);
    if (s2 !== null) {
      if (s2 & 0x40) return { ok: false, status: "paper-out",  message: "Paper out — reload paper." };
      if (s2 & 0x04) return { ok: false, status: "cover-open", message: "Cover is open." };
      if (s2 & 0x20) return { ok: false, status: "error",      message: "Printer error — check ribbon and paper path." };
    }

    return { ok: false, status: "offline", message: "Printer offline." };
  } finally {
    fsClose(fd, () => {});
  }
}

// ─── Combined status check (exported) ────────────────────────────────────────

// Check CUPS printer status before attempting a print.
// Returns { ok, status, message } where status is one of:
//   idle | printing | offline | paused | paper-out | cover-open | error |
//   not-configured | disabled | cups-unavailable | printer-not-found | unknown
//
// If KIOSK_PRINTER_DEVICE is set and the CUPS check passes, also runs a
// DLE EOT hardware query to detect paper-out, cover-open, and ribbon errors.
// The hardware check degrades gracefully — if the device is inaccessible or
// the printer doesn't respond, the CUPS result is returned unchanged.
export async function checkPrinterStatus(config) {
  if (!config.printEnabled) {
    return { ok: true, status: "disabled", message: "Printing disabled in config." };
  }
  if (!config.printerName) {
    return { ok: true, status: "not-configured", message: "No printer name set; using CUPS default." };
  }

  const cups = await checkCupsStatus(config.printerName);
  if (!cups.ok) return cups;

  if (config.printerDevice) {
    const hw = await checkPrinterHardwareStatus(config.printerDevice);
    if (!hw.hardwareCheckSkipped) return hw;
  }

  return cups;
}

async function dummyPrintSlip(config, order, slipData) {
  const ref = String(order.transaction_id ?? "unknown");
  const receiptsDir = path.resolve("receipts");
  await mkdir(receiptsDir, { recursive: true });

  const binPath      = path.join(tmpdir(), `kiosk-receipt-${ref}.bin`);
  const htmlPath     = path.join(receiptsDir, `receipt-${ref}.html`);
  const escposPath   = path.join(receiptsDir, `receipt-${ref}-escpos.html`);

  const [html] = await Promise.all([
    renderSlipHtml(order, config),
    writeFile(binPath, slipData),
    writeFile(escposPath, escposToHtml(slipData, `Receipt ${ref} — ESC/POS preview`)),
  ]);
  await writeFile(htmlPath, html);

  console.log(`[dummy-print] ──────────────────────────────────────`);
  console.log(`[dummy-print] ${ref}  total: £${order.total}`);
  for (const line of order.lines ?? []) {
    const price = `£${Number.parseFloat(line.line_total ?? 0).toFixed(2)}`;
    console.log(`[dummy-print]   ${line.quantity} × ${line.description}  ${price}`);
  }
  console.log(`[dummy-print] receipt → ${htmlPath}`);
  console.log(`[dummy-print] ──────────────────────────────────────`);
}

export async function printOrderSlip(config, order) {
  const slipData = await renderSlip(order, config);

  if (config.dummyPrint || (config.mockMode && config.printEnabled)) {
    await dummyPrintSlip(config, order, slipData);
    return { printed: true, skipped: false, dummy: true, bytes: slipData.length };
  }

  if (!config.printEnabled) {
    return { printed: false, skipped: true, bytes: slipData.length };
  }

  // Pre-flight: verify printer is reachable and paper is loaded before
  // submitting the job. lp exits 0 even for offline printers (queues
  // silently), so we must check separately.
  const status = await checkPrinterStatus(config);
  if (!status.ok) {
    throw new Error(status.message);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.printCommand, printArgs(config), {
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      reject(error);
    });

    child.on("close", code => {
      if (code === 0) {
        resolve({ printed: true, skipped: false });
      } else {
        reject(new Error(stderr.trim() || `${config.printCommand} exited with ${code}`));
      }
    });

    child.stdin.end(slipData);
  });
}
