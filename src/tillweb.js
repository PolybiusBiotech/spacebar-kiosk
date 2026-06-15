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

export async function fetchStock(config) {
  const location = encodeURIComponent(config.location);
  return requestJson(config, `/kiosk/api/location/${location}/stock.json`);
}

export async function placeOrder(config, order) {
  return requestJson(config, "/kiosk/api/orders.json", {
    method: "POST",
    body: JSON.stringify({
      location: config.location,
      idempotency_key: order.idempotency_key,
      items: order.items
    })
  });
}

export async function expireOrders(config) {
  return requestJson(config, "/kiosk/api/orders/expire.json", {
    method: "POST",
    body: JSON.stringify({ location: config.location })
  });
}
