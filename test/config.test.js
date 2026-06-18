import assert from "node:assert/strict";
import test from "node:test";

import { validateRuntimeConfig } from "../src/config.js";

test("validateRuntimeConfig returns empty array when fully configured", () => {
  const missing = validateRuntimeConfig({
    tillwebBaseUrl: "http://till.local",
    kioskToken: "secret"
  });
  assert.deepEqual(missing, []);
});

test("validateRuntimeConfig lists both fields when both are absent", () => {
  const missing = validateRuntimeConfig({ tillwebBaseUrl: "", kioskToken: "" });
  assert.deepEqual(missing, ["TILLWEB_BASE_URL", "TILLWEB_KIOSK_TOKEN"]);
});

test("validateRuntimeConfig lists only the missing field", () => {
  const missingToken = validateRuntimeConfig({ tillwebBaseUrl: "http://till.local", kioskToken: "" });
  assert.deepEqual(missingToken, ["TILLWEB_KIOSK_TOKEN"]);

  const missingUrl = validateRuntimeConfig({ tillwebBaseUrl: "", kioskToken: "secret" });
  assert.deepEqual(missingUrl, ["TILLWEB_BASE_URL"]);
});
