import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderSlip, renderSlipHtml } from "./slip.js";

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

// Check CUPS printer status before attempting a print.
// Returns { ok, status, message } where status is one of:
//   idle | printing | offline | paused | not-configured | unknown
//
// Important: lp exits 0 even when the printer is offline (job is silently
// queued). Always call this before printing so we catch offline/paused state
// before misleadingly resolving { printed: true }.
//
// Only checks a named printer — if no printerName is configured, returns ok
// and lets lp use the CUPS default (exit code is the only error signal then).
export async function checkPrinterStatus(config) {
  if (!config.printEnabled) {
    return { ok: true, status: "disabled", message: "Printing disabled in config." };
  }
  if (!config.printerName) {
    return { ok: true, status: "not-configured", message: "No printer name set; using CUPS default." };
  }

  return new Promise((resolve) => {
    const child = spawn("lpstat", ["-p", config.printerName], {
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

async function dummyPrintSlip(order, slipData) {
  const ref = order.order_ref ?? "unknown";
  const receiptsDir = path.resolve("receipts");
  await mkdir(receiptsDir, { recursive: true });

  const binPath  = path.join(tmpdir(), `kiosk-receipt-${ref}.bin`);
  const htmlPath = path.join(receiptsDir, `receipt-${ref}.html`);

  const [html] = await Promise.all([
    renderSlipHtml(order),
    writeFile(binPath, slipData),
  ]);
  await writeFile(htmlPath, html);

  console.log(`[dummy-print] ──────────────────────────────────────`);
  console.log(`[dummy-print] ${order.order_name ?? ref}  total: £${order.total}`);
  for (const line of order.slip?.lines ?? order.lines ?? []) {
    const price = `£${Number.parseFloat(line.line_total ?? 0).toFixed(2)}`;
    console.log(`[dummy-print]   ${line.quantity} × ${line.description}  ${price}`);
  }
  console.log(`[dummy-print] receipt → ${htmlPath}`);
  console.log(`[dummy-print] ──────────────────────────────────────`);
}

export async function printOrderSlip(config, order) {
  const slipData = await renderSlip(order);

  if (config.dummyPrint || (config.mockMode && config.printEnabled)) {
    await dummyPrintSlip(order, slipData);
    return { printed: true, skipped: false, dummy: true, bytes: slipData.length };
  }

  if (!config.printEnabled) {
    return { printed: false, skipped: true, bytes: slipData.length };
  }

  // Pre-flight: verify printer is reachable before submitting the job.
  // lp exits 0 even for offline printers (queues the job silently), so we
  // must check separately.
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
