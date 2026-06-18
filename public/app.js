const app = document.querySelector("#app");

const state = {
  config: null,
  products: [],
  productMeta: {},
  basket: new Map(),
  loading: true,
  checkingOut: false,
  message: null,
  resetTimer: null,
  screen: 'sleep',
  idleTimer: null,
  activeCategory: null
};

const IDLE_MS = 2 * 60 * 1000;

const money = value => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? `£${number.toFixed(2)}` : `£${value}`;
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

function productKey(id) { return Number(id); }

function clearResetTimer() {
  if (state.resetTimer) { clearTimeout(state.resetTimer); state.resetTimer = null; }
}

function scheduleConfirmationReset() {
  clearResetTimer();
  state.resetTimer = setTimeout(() => { state.resetTimer = null; goToSleep(); }, 15_000);
}

function startIdleTimer() {
  clearIdleTimer();
  state.idleTimer = setTimeout(onIdle, IDLE_MS);
}

function clearIdleTimer() {
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
}

function onIdle() {
  state.basket.clear();
  state.message = null;
  state.screen = 'sleep';
  clearIdleTimer();
  render();
  loadStock({ quiet: true });
}

function goToSleep() {
  clearResetTimer();
  clearIdleTimer();
  state.basket.clear();
  state.message = null;
  state.screen = 'sleep';
  render();
  loadStock({ quiet: true });
}

function basketItems() {
  return [...state.basket.entries()]
    .map(([stocklineId, qty]) => ({ product: state.products.find(item => item.stockline_id === stocklineId), stocklineId, qty }))
    .filter(item => item.product);
}

function basketTotal() {
  return basketItems().reduce((sum, item) => sum + Number.parseFloat(item.product.price || 0) * item.qty, 0);
}

function itemLimit(product) {
  const available = Number.parseFloat(product.available_quantity ?? product.remaining ?? "999");
  return Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 999;
}

function addItem(stocklineId) {
  const product = state.products.find(item => item.stockline_id === stocklineId);
  if (!product) return;
  const key = productKey(stocklineId);
  const next = (state.basket.get(key) || 0) + 1;
  if (next <= itemLimit(product)) state.basket.set(key, next);
  render();
}

function setQty(stocklineId, qty) {
  const key = productKey(stocklineId);
  if (qty <= 0) state.basket.delete(key);
  else state.basket.set(key, qty);
  render();
}

function reconcileBasket() {
  for (const [stocklineId, qty] of state.basket.entries()) {
    const product = state.products.find(item => item.stockline_id === stocklineId);
    if (!product) { state.basket.delete(stocklineId); continue; }
    const limit = itemLimit(product);
    if (qty > limit) {
      if (limit <= 0) state.basket.delete(stocklineId);
      else state.basket.set(stocklineId, limit);
    }
  }
}

function productCategory(product) {
  return state.productMeta[productKey(product.stockline_id)]?.category ?? product.category ?? null;
}

function getCategories() {
  const seen = new Set();
  const cats = [];
  for (const p of state.products) {
    const cat = productCategory(p);
    if (cat && !seen.has(cat)) {
      seen.add(cat);
      cats.push(cat);
    }
  }
  return cats;
}

function visibleProducts() {
  if (!state.activeCategory) return state.products;
  return state.products.filter(p => productCategory(p) === state.activeCategory);
}

async function loadConfig() { state.config = await jsonFetch("/api/config"); }

async function loadProductMeta() {
  try {
    const data = await jsonFetch("/products.json");
    state.productMeta = data || {};
  } catch {
    state.productMeta = {};
  }
}

async function loadStock({ quiet = false } = {}) {
  if (!quiet) { state.loading = true; render(); }
  try {
    const stock = await jsonFetch("/api/stock");
    state.products = stock.items || [];
    state.message = null;
    reconcileBasket();
  } catch (error) {
    state.message = { type: "error", text: serviceMessage(error) };
    if ([401, 403, 409, 503].includes(error.status)) { renderOutOfService(error); return; }
  } finally {
    state.loading = false;
    if (state.screen !== 'sleep' || !quiet) render();
  }
}

function serviceMessage(error) {
  const code = error.payload?.error;
  if (code === "missing-token" || code === "invalid-token" || code === "misconfigured") return "This kiosk is not configured correctly. Please ask for help.";
  if (code === "location-not-allowed") return "This kiosk is not allowed to order for this location. Please ask for help.";
  if (code === "no-active-session") return "Ordering is not open yet. Please ask for help.";
  return error.message || "The kiosk cannot reach the till right now.";
}

async function checkout() {
  if (state.checkingOut || state.basket.size === 0) return;
  state.checkingOut = true;
  let stayOnResultScreen = false;
  state.message = null;
  render();
  const idempotencyKey = crypto.randomUUID();
  const body = { idempotency_key: idempotencyKey, items: basketItems().map(item => ({ stockline_id: item.stocklineId, qty: item.qty })) };
  try {
    const order = await jsonFetch("/api/orders", { method: "POST", body: JSON.stringify(body) });
    state.basket.clear();
    await loadStock({ quiet: true });
    renderComplete(order);
    stayOnResultScreen = true;
  } catch (error) {
    const code = error.payload?.error;
    if (["insufficient-stock", "price-not-set", "unknown-stockline", "wrong-location"].includes(code)) {
      await loadStock({ quiet: true });
      state.message = { type: "warning", text: "Some items changed while you were ordering. Please review your basket and try again." };
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
    if (!stayOnResultScreen) render();
  }
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function renderSleep() {
  return `
    <section class="sleep" data-wake>
      <div class="sleep-content">
        <img class="sleep-logo" src="/images/logo-text.svg" alt="Polybius Space BAR">
        <p class="sleep-prompt">TOUCH TO ORDER</p>
      </div>
    </section>
  `;
}

function renderTabs(categories) {
  if (!categories.length) return '';
  const allActive = !state.activeCategory ? 'tab--active' : '';
  const tabButtons = categories.map(cat => {
    const active = state.activeCategory === cat ? 'tab--active' : '';
    return `<button class="tab ${active}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`;
  }).join('');
  return `
    <nav class="tabs">
      <button class="tab ${allActive}" data-category="">All</button>
      ${tabButtons}
    </nav>
  `;
}

function renderProduct(product) {
  const meta = state.productMeta[product.stockline_id] || {};
  const hasImg = !!meta.image;
  const imgHtml = hasImg
    ? `<div class="product-img"><img src="${escapeHtml(meta.image)}" alt="" loading="lazy"></div>`
    : '';
  const key = productKey(product.stockline_id);
  const qty = state.basket.get(key) || 0;
  const limit = itemLimit(product);
  const soldOut = limit <= 0;
  const atMax = qty >= limit;
  const descHtml = product.description
    ? `<p class="product-desc">${escapeHtml(product.description)}</p>`
    : '';
  const qtyControls = qty > 0
    ? `<div class="quantity">
        <button data-dec="${escapeHtml(String(product.stockline_id))}" aria-label="Remove one">−</button>
        <span>${qty}</span>
        <button data-inc="${escapeHtml(String(product.stockline_id))}" ${atMax ? 'disabled' : ''} aria-label="Add one">+</button>
      </div>`
    : `<button class="add" data-add="${escapeHtml(String(product.stockline_id))}" ${soldOut ? 'disabled' : ''}>
        ${soldOut ? 'Sold out' : 'Add'}
      </button>`;
  return `
    <article class="product${hasImg ? ' product--has-img' : ''}">
      ${imgHtml}
      <div class="product-info">
        <h2 class="product-name">${escapeHtml(product.name)}</h2>
        ${descHtml}
      </div>
      <div class="product-footer">
        <span class="price">${money(product.price)}</span>
        ${qtyControls}
      </div>
    </article>
  `;
}

function renderBasket() {
  const items = basketItems();
  const total = basketTotal();
  const isEmpty = items.length === 0;
  const itemsHtml = isEmpty
    ? `<p class="basket-empty">Your basket is empty</p>`
    : items.map(({ product, stocklineId, qty }) => `
        <div class="basket-item">
          <span class="basket-item-name">${escapeHtml(product.name)}</span>
          <div class="quantity">
            <button data-dec="${escapeHtml(String(stocklineId))}" aria-label="Remove one">−</button>
            <span>${qty}</span>
            <button data-inc="${escapeHtml(String(stocklineId))}" aria-label="Add one">+</button>
          </div>
          <span class="basket-item-price">${money(Number.parseFloat(product.price || 0) * qty)}</span>
        </div>
      `).join('');
  return `
    <section class="basket">
      <div class="basket-header">
        <h2>Basket</h2>
        ${!isEmpty ? `<button class="clear" data-clear>Clear</button>` : ''}
      </div>
      <div class="basket-items">${itemsHtml}</div>
      ${!isEmpty ? `<div class="basket-total"><span>Total</span><span class="total-price">${money(total)}</span></div>` : ''}
      <button class="checkout" data-checkout ${isEmpty || state.checkingOut ? 'disabled' : ''}>
        ${state.checkingOut ? 'Placing order…' : 'Place Order'}
      </button>
    </section>
  `;
}

function renderBanner() {
  if (!state.message) return '';
  return `<div class="banner ${escapeHtml(state.message.type)}" role="alert">${escapeHtml(state.message.text)}</div>`;
}

function render() {
  if (state.screen === 'sleep') {
    app.innerHTML = renderSleep();
    return;
  }
  if (state.screen === 'out-of-service' || state.screen === 'complete' || state.screen === 'printer-error') {
    return;
  }
  const scrollTop = app.querySelector('.products')?.scrollTop ?? 0;
  const categories = getCategories();
  const products = visibleProducts();
  const productsHtml = state.loading
    ? `<p class="loading">Loading menu…</p>`
    : products.map(renderProduct).join('');
  app.innerHTML = `
    <div class="kiosk">
      <div class="catalog">
        <div class="topbar">
          <h1>Polybius Space BAR</h1>
          <p>${escapeHtml(state.config?.location_name || '')}</p>
          <button class="refresh" data-refresh aria-label="Refresh menu">↺</button>
        </div>
        ${renderBanner()}
        ${renderTabs(categories)}
        <div class="products">${productsHtml}</div>
      </div>
      ${renderBasket()}
    </div>
  `;
  if (scrollTop) {
    const el = app.querySelector('.products');
    if (el) el.scrollTop = scrollTop;
  }
}

function renderOutOfService(error) {
  state.screen = 'out-of-service';
  app.innerHTML = `
    <div class="status-screen">
      <h1>Out of Service</h1>
      <p>${escapeHtml(serviceMessage(error))}</p>
    </div>
  `;
}

function renderComplete(order) {
  state.screen = 'complete';
  clearIdleTimer();
  app.innerHTML = `
    <div class="status-screen complete">
      <h1>Order placed!</h1>
      <p>Take your slip to the payment point to pay and collect.</p>
      ${order.order_ref ? `<div class="order-number">${escapeHtml(String(order.order_ref))}</div>` : ''}
      <button class="btn-primary" data-new-order>New Order</button>
    </div>
  `;
  scheduleConfirmationReset();
}

function renderPrinterError(payload) {
  state.screen = 'printer-error';
  clearIdleTimer();
  app.innerHTML = `
    <div class="status-screen">
      <h1>Printer error</h1>
      <p>Your order was placed but the receipt printer failed. Please tell bar staff.</p>
      ${payload?.order_ref ? `<div class="order-number">${escapeHtml(String(payload.order_ref))}</div>` : ''}
      <button class="btn-primary" data-retry>OK</button>
    </div>
  `;
  scheduleConfirmationReset();
}

document.addEventListener("click", event => {
  if (event.target.closest('[data-wake]')) {
    state.screen = 'order';
    startIdleTimer();
    if (state.products.length > 0) {
      render();
    } else {
      loadStock();
    }
    return;
  }

  if (event.target.closest('[data-new-order]') || event.target.closest('[data-retry]')) {
    clearResetTimer();
    goToSleep();
    return;
  }

  if (state.screen === 'order') {
    startIdleTimer();
  }

  const tabBtn = event.target.closest('[data-category]');
  if (tabBtn) {
    state.activeCategory = tabBtn.dataset.category || null;
    render();
    return;
  }

  const addBtn = event.target.closest('[data-add]');
  if (addBtn) { addItem(Number(addBtn.dataset.add)); return; }

  const incBtn = event.target.closest('[data-inc]');
  if (incBtn) {
    const id = Number(incBtn.dataset.inc);
    const key = productKey(id);
    setQty(id, (state.basket.get(key) || 0) + 1);
    return;
  }

  const decBtn = event.target.closest('[data-dec]');
  if (decBtn) {
    const id = Number(decBtn.dataset.dec);
    const key = productKey(id);
    setQty(id, (state.basket.get(key) || 0) - 1);
    return;
  }

  if (event.target.closest('[data-checkout]')) { checkout(); return; }

  if (event.target.closest('[data-clear]')) {
    state.basket.clear();
    render();
    return;
  }

  if (event.target.closest('[data-refresh]')) { loadStock(); return; }
});

async function boot() {
  try {
    await loadConfig();
    await loadProductMeta();
  } catch { /* non-fatal — show sleep screen, retry on first wake */ }
  render();
  loadStock({ quiet: true });
  setInterval(() => loadStock({ quiet: true }), 60_000);
}

boot();
