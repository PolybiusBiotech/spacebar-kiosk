import assert from "node:assert/strict";
import test from "node:test";

import { renderSlip } from "../src/slip.js";

test("renderSlip prints the unpaid order essentials", () => {
  const text = renderSlip({
    order_name: "Kiosk 123",
    total: "5.60",
    slip: {
      title: "Kiosk order 123",
      created_at: "2026-06-15T15:44:10",
      expires_at: "2026-06-15T15:59:10",
      total: "5.60",
      lines: [
        {
          description: "Club Mate Regular 500ml bottle",
          quantity: 2,
          unit_price: "2.80",
          line_total: "5.60"
        }
      ]
    }
  });

  assert.match(text, /KIOSK ORDER 123/);
  assert.match(text, /UNPAID - PAY AT THE TILL/);
  assert.match(text, /Club Mate Regular 500ml bottle/);
  assert.match(text, /2 x GBP 2\.80/);
  assert.match(text, /TOTAL\s+GBP 5\.60/);
});
