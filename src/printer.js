import { spawn } from "node:child_process";

import { renderSlip } from "./slip.js";

function printArgs(config) {
  if (config.printCommand === "lpr") {
    return config.printerName ? ["-P", config.printerName] : [];
  }

  return [
    ...(config.printerName ? ["-d", config.printerName] : []),
    "-t",
    "Speakeasy kiosk order"
  ];
}

export async function printOrderSlip(config, order) {
  const slipText = renderSlip(order);
  if (!config.printEnabled) {
    return { printed: false, skipped: true, slipText };
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
