import assert from "node:assert/strict";
import test from "node:test";

import { stocklineToProduct } from "../src/tillweb.js";

const BASE_STOCKTYPE = {
  id: 1,
  manufacturer: "Club Mate",
  name: "Regular",
  fullname: "Club Mate Regular",
  abv: null,
  price: "2.80",
  sale_unit_name: "500ml bottle",
  sale_unit_name_plural: "500ml bottles",
  base_units_remaining: "24",
  base_units_per_sale_unit: "1",
  department: { description: "Soft Drinks" }
};

const BASE_STOCKLINE = {
  id: 42,
  name: "Club Mate Regular 500ml",
  location: "Spacebar",
  linetype: "continuous",
  stocktype: BASE_STOCKTYPE
};

test("stocklineToProduct converts a well-formed continuous stockline", () => {
  const product = stocklineToProduct(BASE_STOCKLINE);
  assert.ok(product !== null);
  assert.equal(product.stockline_id, 42);
  assert.equal(product.name, "Club Mate Regular");
  assert.equal(product.price, "2.80");
  assert.equal(product.available, true);
  assert.equal(product.available_quantity, "24");
  assert.equal(product.category, "Soft Drinks");
});

test("stocklineToProduct prefers manufacturer + stocktype name over the stockline label", () => {
  // Bar staff often type inconsistent casing/shorthand into the stockline
  // label (e.g. "Buzzballz Chilli Mango"); stocktype.manufacturer/name carry
  // the correct brand casing ("BuzzBallz") and should win.
  const mismatched = {
    ...BASE_STOCKLINE,
    name: "club mate regular 500ml"
  };
  const product = stocklineToProduct(mismatched);
  assert.equal(product.name, "Club Mate Regular");
});

test("stocklineToProduct falls back to the stockline label when manufacturer and name are absent", () => {
  const noBrand = {
    ...BASE_STOCKLINE,
    stocktype: { ...BASE_STOCKTYPE, manufacturer: "", name: "" }
  };
  const product = stocklineToProduct(noBrand);
  assert.equal(product.name, "Club Mate Regular 500ml");
});

test("stocklineToProduct returns null for non-continuous linetype", () => {
  const kegged = { ...BASE_STOCKLINE, linetype: "kegged" };
  assert.equal(stocklineToProduct(kegged), null);
});

test("stocklineToProduct returns null when stocktype is missing", () => {
  const noType = { ...BASE_STOCKLINE, stocktype: null };
  assert.equal(stocklineToProduct(noType), null);
});

test("stocklineToProduct marks available=false when price is null", () => {
  const free = { ...BASE_STOCKLINE, stocktype: { ...BASE_STOCKTYPE, price: null } };
  const product = stocklineToProduct(free);
  assert.equal(product.available, false);
  assert.equal(product.price, null);
});

test("stocklineToProduct marks available=false when out of stock", () => {
  const empty = {
    ...BASE_STOCKLINE,
    stocktype: { ...BASE_STOCKTYPE, base_units_remaining: "0" }
  };
  const product = stocklineToProduct(empty);
  assert.equal(product.available, false);
  assert.equal(product.available_quantity, "0");
});

test("stocklineToProduct extracts category from department string", () => {
  const stringDept = {
    ...BASE_STOCKLINE,
    stocktype: { ...BASE_STOCKTYPE, department: "Beer & Cider" }
  };
  const product = stocklineToProduct(stringDept);
  assert.equal(product.category, "Beer & Cider");
});

test("stocklineToProduct extracts category from department.name when description absent", () => {
  const nameDept = {
    ...BASE_STOCKLINE,
    stocktype: { ...BASE_STOCKTYPE, department: { name: "Spirits" } }
  };
  const product = stocklineToProduct(nameDept);
  assert.equal(product.category, "Spirits");
});

test("stocklineToProduct sets category to null when department absent", () => {
  const noDept = {
    ...BASE_STOCKLINE,
    stocktype: { ...BASE_STOCKTYPE, department: null }
  };
  const product = stocklineToProduct(noDept);
  assert.equal(product.category, null);
});

test("stocklineToProduct handles fractional base_units_per_sale_unit", () => {
  const fractional = {
    ...BASE_STOCKLINE,
    stocktype: {
      ...BASE_STOCKTYPE,
      base_units_remaining: "10",
      base_units_per_sale_unit: "3"
    }
  };
  const product = stocklineToProduct(fractional);
  assert.equal(product.available_quantity, "3"); // floor(10/3) = 3
});

test("stocklineToProduct builds description from fullname and sale unit name", () => {
  const product = stocklineToProduct(BASE_STOCKLINE);
  assert.equal(product.description, "Club Mate Regular 500ml bottle");
});
