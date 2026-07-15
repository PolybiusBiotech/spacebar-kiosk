import assert from "node:assert/strict";
import test from "node:test";

import { printOrderSlip } from "../src/printer.js";

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
