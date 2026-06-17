export class TillwebError extends Error {
  constructor(message, { status = 500, payload = null, cause = null } = {}) {
    super(message);
    this.name = "TillwebError";
    this.status = status;
    this.payload = payload;
    this.cause = cause;
  }
}

function endpoint(config, pathname) {
  const url = new URL(pathname, config.tillwebBaseUrl);
  return url.toString();
}

async function requestJson(config, pathname, options = {}) {
  let response;
  try {
    response = await fetch(endpoint(config, pathname), {
      ...options,
      headers: {
        Authorization: `Bearer ${config.kioskToken}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
  } catch (error) {
    throw new TillwebError("Could not contact tillweb.", {
      status: 502,
      payload: { error: "network-error", message: "Could not contact tillweb." },
      cause: error
    });
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: "invalid-json", message: text };
    }
  }

  if (!response.ok) {
    const message = payload?.message ?? `Tillweb returned HTTP ${response.status}.`;
    throw new TillwebError(message, { status: response.status, payload });
  }

  return payload;
}

function numberOrZero(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatQuantity(quantity, unitName, unitNamePlural) {
  const unit = quantity === 1 ? unitName : unitNamePlural;
  return unit ? `${quantity} ${unit}` : String(quantity);
}

export function stocklineToProduct(stockline) {
  const stocktype = stockline.stocktype;
  if (!stocktype || stockline.linetype !== "continuous") {
    return null;
  }

  const baseUnitsRemaining = numberOrZero(stocktype.base_units_remaining);
  const baseUnitsPerSaleUnit = numberOrZero(stocktype.base_units_per_sale_unit) || 1;
  const availableQuantity = Math.floor(baseUnitsRemaining / baseUnitsPerSaleUnit);
  const price = stocktype.price == null ? null : String(stocktype.price);
  const available = price !== null && availableQuantity > 0;

  return {
    stockline_id: stockline.id,
    name: stockline.name,
    location: stockline.location,
    line_type: stockline.linetype,
    stocktype: {
      id: stocktype.id,
      manufacturer: stocktype.manufacturer,
      name: stocktype.name,
      abv: stocktype.abv == null ? null : String(stocktype.abv),
      unit: stocktype.sale_unit_name
    },
    description: `${stocktype.fullname} ${stocktype.sale_unit_name}`.trim(),
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
  const stock = await requestJson(
    config,
    `/api/stocklines.json?output=full&type=continuous&location=${location}`
  );
  return {
    location: config.location,
    expired_orders: [],
    items: (stock.stocklines ?? [])
      .map(stocklineToProduct)
      .filter(Boolean)
  };
}

export async function placeOrder(config, order) {
  return requestJson(config, "/api/kiosk/orders.json", {
    method: "POST",
    body: JSON.stringify({
      location: config.location,
      idempotency_key: order.idempotency_key,
      items: order.items
    })
  });
}

export async function expireOrders(config) {
  return requestJson(config, "/api/kiosk/orders/expire.json", {
    method: "POST",
    body: JSON.stringify({ location: config.location })
  });
}
