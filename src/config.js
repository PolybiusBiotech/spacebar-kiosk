import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equals = trimmed.indexOf("=");
    if (equals === -1) {
      continue;
    }

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig() {
  loadDotEnv();

  return {
    tillwebBaseUrl: process.env.TILLWEB_BASE_URL ?? "",
    kioskToken: process.env.TILLWEB_KIOSK_TOKEN ?? "",
    location: process.env.KIOSK_LOCATION ?? "spacebar",
    listenHost: process.env.KIOSK_LISTEN_HOST ?? "127.0.0.1",
    port: intEnv("KIOSK_PORT", 8080),
    mockMode: boolEnv("KIOSK_MOCK_MODE", false),
    printEnabled: boolEnv("KIOSK_PRINT_ENABLED", true),
    printerName: process.env.KIOSK_PRINTER_NAME ?? "",
    printCommand: process.env.KIOSK_PRINT_COMMAND ?? "lp",
    omsUrl: (process.env.KIOSK_OMS_URL ?? "").replace(/\/$/, ""),
    publicDir: path.join(process.cwd(), "public")
  };
}

export function validateRuntimeConfig(config) {
  const missing = [];
  if (!config.tillwebBaseUrl) {
    missing.push("TILLWEB_BASE_URL");
  }
  if (!config.kioskToken) {
    missing.push("TILLWEB_KIOSK_TOKEN");
  }
  return missing;
}
