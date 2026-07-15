import assert from "node:assert/strict";
import test from "node:test";

import { printOrderSlip, clearPrinterQueue, parseLpstatOutput } from "../src/printer.js";

const ORDER = { transaction_id: 1, total: "1.00", lines: [] };

const BASE_CONFIG = {
  dummyPrint: false,
  mockMode: false,
  printEnabled: true,
  printerName: "",
  printerDevice: "",
  printCommand: "lp"
};

test("printOrderSlip dummy-prints when dummyPrint is set, regardless of mockMode", async () => {
  const result = await printOrderSlip({ ...BASE_CONFIG, dummyPrint: true, mockMode: false }, ORDER);
  assert.equal(result.dummy, true);
});

test("printOrderSlip skips entirely when printEnabled is false, regardless of mockMode", async () => {
  const result = await printOrderSlip({ ...BASE_CONFIG, printEnabled: false, mockMode: true }, ORDER);
  assert.equal(result.printed, false);
  assert.equal(result.skipped, true);
  assert.ok(result.bytes > 0);
});

// mockMode must not force dummy printing on its own — mock till data and a
// real physical printer aren't mutually exclusive (e.g. testing slip layout
// on real hardware without a live tillweb connection). A nonexistent printer
// name makes this deterministic and fast either way: whether or not the test
// environment has CUPS/lpstat installed, checkPrinterStatus resolves not-ok
// and printOrderSlip rejects — so this only passes if the real CUPS
// pre-flight path was actually taken instead of silently dummy-printing.
test("printOrderSlip does not dummy-print just because mockMode is true", async () => {
  const config = { ...BASE_CONFIG, mockMode: true, dummyPrint: false, printerName: "definitely-not-a-real-printer-xyz" };
  await assert.rejects(() => printOrderSlip(config, ORDER));
});

// Used on the "staff confirms fixed" path: while a printer was down, lp can
// silently queue jobs rather than fail, so stale jobs need clearing before
// resuming — see checkCupsStatus's comment in src/printer.js.
test("clearPrinterQueue resolves ok:false (not throw) for a nonexistent printer", async () => {
  const result = await clearPrinterQueue({ printerName: "definitely-not-a-real-printer-xyz" });
  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0, "has a diagnostic message");
});

test("clearPrinterQueue never rejects, regardless of cancel's availability or exit code", async () => {
  await assert.doesNotReject(() => clearPrinterQueue({ printerName: "" }));
});

// "now printing" deliberately does NOT count as ok, on purpose, even though
// it's also the wording for a healthy printer mid-job — a real paper-out
// test showed CUPS leaves a stuck job showing "now printing" indefinitely
// while silently retrying, so treating it as healthy made genuine failures
// stop being detected (a prior version of this test asserted the opposite;
// that was reverted after live testing).
test("parseLpstatOutput does not treat an active job (\"now printing\") as ok — it can be a stuck failure", () => {
  const result = parseLpstatOutput("printer SpacebarTill now printing SpacebarTill-28.  enabled since Wed 15 Jul 2026 08:26:25 PM BST\n\tSending data to printer.\n");
  assert.equal(result.ok, false);
});

test("parseLpstatOutput treats a genuinely idle printer as ok", () => {
  const result = parseLpstatOutput("printer SpacebarTill is idle.  enabled since Wed 15 Jul 2026 08:26:25 PM BST\n");
  assert.equal(result.ok, true);
});

test("parseLpstatOutput reports offline printers as not ok", () => {
  const result = parseLpstatOutput("printer SpacebarTill is not available at this time.\n");
  assert.equal(result.ok, false);
  assert.equal(result.status, "offline");
});

test("parseLpstatOutput reports disabled/paused printers as not ok", () => {
  const result = parseLpstatOutput("printer SpacebarTill disabled since Wed 15 Jul 2026 -\n\treason unknown\n");
  assert.equal(result.ok, false);
  assert.equal(result.status, "paused");
});

test("parseLpstatOutput's unrecognised-status message clearly states there's a problem, not just raw output", () => {
  const result = parseLpstatOutput("some future lpstat wording we don't recognise yet\n");
  assert.equal(result.ok, false);
  assert.match(result.message, /problem detected/i);
  assert.match(result.message, /some future lpstat wording we don't recognise yet/);
});
