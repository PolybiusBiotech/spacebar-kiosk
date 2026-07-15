export { TillwebError } from "@spacebar/shared/tillweb-client.js";
import { tillwebRequest } from "@spacebar/shared/tillweb-client.js";

function request(config, pathname, options = {}) {
  return tillwebRequest(config.tillwebBaseUrl, config.kioskToken, pathname, options);
}

function numberOrZero(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatQuantity(quantity, unitName, unitNamePlural) {
  const unit = quantity === 1 ? unitName : unitNamePlural;
  return unit ? `${quantity} ${unit}` : String(quantity);
}

function stripHtml(html) {
  return html ? html.replace(/<[^>]*>/g, "").trim() : "";
}

export function stocklineToProduct(stockline, tillwebBaseUrl = "") {
  const stocktype = stockline.stocktype;
  if (!stocktype || stockline.linetype !== "continuous") {
    return null;
  }

  const baseUnitsRemaining = numberOrZero(stocktype.base_units_remaining);
  const baseUnitsPerSaleUnit = numberOrZero(stocktype.base_units_per_sale_unit) || 1;
  const availableQuantity = Math.floor(baseUnitsRemaining / baseUnitsPerSaleUnit);
  const price = stocktype.price == null ? null : String(stocktype.price);
  const available = price !== null && availableQuantity > 0;

  const dept = stocktype.department;
  const category = dept
    ? (typeof dept === "string" ? dept : (dept.description ?? dept.name ?? null))
    : null;

  const name = [stocktype.manufacturer, stocktype.name].filter(Boolean).join(" ").trim() || stockline.name;
  const image = stocktype.logo ? `${tillwebBaseUrl}${stocktype.logo}` : null;

  return {
    stockline_id: stockline.id,
    name,
    location: stockline.location,
    line_type: stockline.linetype,
    category,
    image,
    stocktype: {
      id: stocktype.id,
      manufacturer: stocktype.manufacturer,
      name: stocktype.name,
      abv: stocktype.abv == null ? null : String(stocktype.abv),
      unit: stocktype.sale_unit_name
    },
    description: stripHtml(stocktype.tasting_notes) || `${stocktype.fullname} ${stocktype.sale_unit_name}`.trim(),
    price,
    available,
    available_quantity: String(availableQuantity),
    available_display: formatQuantity(
      availableQuantity,
      stocktype.sale_unit_name,
      stocktype.sale_unit_name_plural
    ),
    remaining: String(baseUnitsRemaining),
    remaining_display: formatQuantity(
      availableQuantity,
      stocktype.sale_unit_name,
      stocktype.sale_unit_name_plural
    )
  };
}

export async function fetchStock(config) {
  const location = encodeURIComponent(config.location);
  const stock = await request(
    config,
    `/api/stocklines.json?output=full&type=continuous&location=${location}`
  );
  return {
    location: config.location,
    expired_orders: [],
    items: (stock.stocklines ?? [])
      .map(stockline => stocklineToProduct(stockline, config.tillwebBaseUrl))
      .filter(Boolean)
  };
}

export async function placeOrder(config, order) {
  return request(config, "/api/kiosk/orders/", {
    method: "POST",
    body: JSON.stringify({ items: order.items })
  });
}
