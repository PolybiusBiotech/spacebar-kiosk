const app = document.querySelector("#app");

const state = {
  config: null,
  products: [],
  basket: new Map(),
  loading: true,
  checkingOut: false,
  message: null,
  resetTimer: null
};

const money = value => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? `GBP ${number.toFixed(2)}` : `GBP ${value}`;
};

const jsonFetch = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
};

function productKey(id) {
  return Number(id);
}

function clearResetTimer() {
  if (state.resetTimer) {
    clearTimeout(state.resetTimer);
    state.resetTimer = null;
  }
}

function scheduleConfirmationReset() {
  clearResetTimer();
  state.resetTimer = setTimeout(() => {
    state.resetTimer = null;
    loadStock();
  }, 15_000);
}

function basketItems() {
  return [...state.basket.entries()]
    .map(([stocklineId, qty]) => ({
      product: state.products.find(item => item.stockline_id === stocklineId),
      stocklineId,
      qty
    }))
    .filter(item => item.product);
}

function basketTotal() {
  return basketItems().reduce((sum, item) => {
    return sum + Number.parseFloat(item.product.price || 0) * item.qty;
  }, 0);
}

function itemLimit(product) {
  const available = Number.parseFloat(product.available_quantity ?? product.remaining ?? "999");
  return Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 999;
}

function addItem(stocklineId) {
  const product = state.products.find(item => item.stockline_id === stocklineId);
  if (!product) {
    return;
  }
  const key = productKey(stocklineId);
  const next = (state.basket.get(key) || 0) + 1;
  if (next <= itemLimit(product)) {
    state.basket.set(key, next);
  }
  render();
}

function setQty(stocklineId, qty) {
  const key = productKey(stocklineId);
  if (qty <= 0) {
    state.basket.delete(key);
  } else {
    state.basket.set(key, qty);
  }
  render();
}

function reconcileBasket() {
  for (const [stocklineId, qty] of state.basket.entries()) {
    const product = state.products.find(item => item.stockline_id === stocklineId);
    if (!product) {
      state.basket.delete(stocklineId);
      continue;
    }
    const limit = itemLimit(product);
    if (qty > limit) {
      if (limit <= 0) {
        state.basket.delete(stocklineId);
      } else {
        state.basket.set(stocklineId, limit);
      }
    }
  }
}

async function loadConfig() {
  state.config = await jsonFetch("/api/config");
}

async function loadStock({ quiet = false } = {}) {
  if (!quiet) {
    state.loading = true;
    render();
  }
  try {
    const stock = await jsonFetch("/api/stock");
    state.products = stock.items || [];
    state.message = null;
    reconcileBasket();
  } catch (error) {
    state.message = {
      type: "error",
      text: serviceMessage(error)
    };
    if ([401, 403, 409, 503].includes(error.status)) {
      renderOutOfService(error);
      return;
    }
  } finally {
    state.loading = false;
    render();
  }
}

function serviceMessage(error) {
  const code = error.payload?.error;
  if (code === "missing-token" || code === "invalid-token" || code === "misconfigured") {
    return "This kiosk is not configured correctly. Please ask for help.";
  }
  if (code === "location-not-allowed") {
    return "This kiosk is not allowed to order for this location. Please ask for help.";
  }
  if (code === "no-active-session") {
    return "Ordering is not open yet. Please ask for help.";
  }
  return error.message || "The kiosk cannot reach the till right now.";
}

async function checkout() {
  if (state.checkingOut || state.basket.size === 0) {
    return;
  }

  state.checkingOut = true;
  let stayOnResultScreen = false;
  state.message = null;
  render();

  const idempotencyKey = crypto.randomUUID();
  const body = {
    idempotency_key: idempotencyKey,
    items: basketItems().map(item => ({
      stockline_id: item.stocklineId,
      qty: item.qty
    }))
  };

  try {
    const order = await jsonFetch("/api/orders", {
      method: "POST",
      body: JSON.stringify(body)
    });
    state.basket.clear();
    await loadStock({ quiet: true });
    renderComplete(order);
    stayOnResultScreen = true;
  } catch (error) {
    const code = error.payload?.error;
    if (["insufficient-stock", "price-not-set", "unknown-stockline", "wrong-location"].includes(code)) {
      await loadStock({ quiet: true });
      state.message = {
        type: "warning",
        text: "Some items changed while you were ordering. Please review your basket and try again."
      };
    } else if (code === "printer-error") {
      state.basket.clear();
      renderPrinterError(error.payload);
      stayOnResultScreen = true;
      return;
    } else {
      state.message = { type: "error", text: serviceMessage(error) };
    }
  } finally {
    state.checkingOut = false;
    if (!stayOnResultScreen) {
      render();
    }
  }
}

function renderBanner() {
  return state.message ? `<div class="banner ${state.message.type}">${state.message.text}</div>` : "";
}

function remainingLabel(product) {
  const display = product.available_display || product.remaining_display;
  return display ? `${display} remaining` : "";
}

function renderProduct(product) {
  const qty = state.basket.get(product.stockline_id) || 0;
  const limit = itemLimit(product);
  return `
    <article class="product" data-add="${product.stockline_id}">
      <div>
        <h2>${escapeHtml(product.name)}</h2>
        <p class="muted">${escapeHtml(product.description || product.stocktype?.name || "")}</p>
      </div>
      <p class="muted">${escapeHtml(remainingLabel(product))}</p>
      <div class="product-footer">
        <strong class="price">${money(product.price)}</strong>
        <button class="add" data-add="${product.stockline_id}" ${qty >= limit ? "disabled" : ""}>${qty ? `Added ${qty}` : "Add"}</button>
      </div>
    </article>
  `;
}

function renderBasketItem(item) {
  const limit = itemLimit(item.product);
  return `
    <article class="basket-item">
      <div class="basket-line">
        <strong>${escapeHtml(item.product.name)}</strong>
        <span>${money(Number.parseFloat(item.product.price || 0) * item.qty)}</span>
      </div>
      <div class="quantity">
        <button aria-label="Remove one ${escapeHtml(item.product.name)}" data-decrement="${item.stocklineId}">-</button>
        <span>${item.qty}</span>
        <button aria-label="Add one ${escapeHtml(item.product.name)}" data-increment="${item.stocklineId}" ${item.qty >= limit ? "disabled" : ""}>+</button>
      </div>
    </article>
  `;
}

function render() {
  clearResetTimer();
  if (!state.config) {
    app.innerHTML = `
      <section class="status-screen">
        <h1>Speakeasy Kiosk</h1>
        <p>Starting up...</p>
      </section>
    `;
    return;
  }

  const items = basketItems();
  app.innerHTML = `
    <section class="kiosk">
      <div class="catalog">
        <header class="topbar">
          <div>
            <h1>${escapeHtml(state.config.order_prefix || state.config.location)} drinks</h1>
            <p>Choose your drinks, confirm the order, then take the printed slip to _____.</p>
          </div>
          <button class="refresh" data-refresh>Refresh</button>
        </header>
        ${renderBanner()}
        <div class="products">
          ${
            state.loading
              ? `<p class="muted">Loading drinks...</p>`
              : state.products.length
                ? state.products.map(renderProduct).join("")
                : `<p class="muted">No drinks are currently on sale here.</p>`
          }
        </div>
      </div>
      <aside class="basket">
        <div class="basket-heading">
          <h2>Your order</h2>
          <button class="clear" data-clear ${items.length === 0 || state.checkingOut ? "disabled" : ""}>Clear</button>
        </div>
        ${
          items.length
            ? `<div class="basket-items">${items.map(renderBasketItem).join("")}</div>`
            : `<div class="basket-empty">Add drinks to start an order.</div>`
        }
        <div class="basket-footer">
          <div class="total">
            <span>Total</span>
            <strong>${money(basketTotal())}</strong>
          </div>
          <button class="checkout" data-checkout ${items.length === 0 || state.checkingOut ? "disabled" : ""}>
            ${state.checkingOut ? "Sending order..." : "Confirm order"}
          </button>
        </div>
      </aside>
    </section>
  `;
}

function renderOutOfService(error) {
  app.innerHTML = `
    <section class="status-screen">
      <h1>Out of service</h1>
      <p>${escapeHtml(serviceMessage(error))}</p>
      <button data-retry>Try again</button>
    </section>
  `;
}

function renderComplete(order) {
  app.innerHTML = `
    <section class="complete">
      <p>Your order slip has been printed.</p>
      <h1>Take it to the till</h1>
      <div class="order-number">${escapeHtml(order.order_name || `Order ${order.order_number}`)}</div>
      <p>This order is unpaid until you complete payment.</p>
      <button data-new-order>Start another order</button>
    </section>
  `;
  scheduleConfirmationReset();
}

function renderPrinterError(order) {
  app.innerHTML = `
    <section class="status-screen">
      <h1>Please ask for help</h1>
      <p>Your order was created, but the printer did not print the slip.</p>
      <div class="order-number">${escapeHtml(order.order_name || `Order ${order.order_number}`)}</div>
      <button data-new-order>Back to kiosk</button>
    </section>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.addEventListener("click", event => {
  const button = event.target.closest("button");
  const product = event.target.closest(".product");
  if (!button && product?.dataset.add) {
    addItem(Number(product.dataset.add));
    return;
  }

  if (!button) {
    return;
  }

  if (button.dataset.add) {
    addItem(Number(button.dataset.add));
  } else if (button.dataset.increment) {
    const id = Number(button.dataset.increment);
    addItem(id);
  } else if (button.dataset.decrement) {
    const id = Number(button.dataset.decrement);
    setQty(id, (state.basket.get(id) || 0) - 1);
  } else if (button.dataset.checkout != null) {
    checkout();
  } else if (button.dataset.clear != null) {
    state.basket.clear();
    render();
  } else if (button.dataset.refresh != null || button.dataset.retry != null) {
    loadStock();
  } else if (button.dataset.newOrder != null) {
    clearResetTimer();
    loadStock();
  }
});

async function boot() {
  try {
    await loadConfig();
    await loadStock();
    setInterval(() => loadStock({ quiet: true }), 60_000);
  } catch (error) {
    renderOutOfService(error);
    setTimeout(boot, 15_000);
  }
}

boot();
