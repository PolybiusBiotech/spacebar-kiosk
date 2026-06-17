import { spawn } from "node:child_process";

import { renderSlip } from "./slip.js";

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

export async function printOrderSlip(config, order) {
  const slipText = renderSlip(order);
  if (!config.printEnabled) {
    return { printed: false, skipped: true, slipText };
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

    child.stdin.end(slipText);
  });
}
