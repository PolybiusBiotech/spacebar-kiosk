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

const IDLE_MS    = 2 * 60 * 1000;
const A11Y_IDLE_MS = 5 * 60 * 1000;

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
  stopOrderGlitch();
  stopCompleteGlitch();
  stopCRT();
  render();
  loadStock({ quiet: true });
  scheduleNextGlitch();
  scheduleNextMicro();
  scheduleCRT();
}

function goToSleep() {
  clearResetTimer();
  clearIdleTimer();
  disableA11y();
  state.basket.clear();
  state.message = null;
  state.screen = 'sleep';
  stopOrderGlitch();
  stopCompleteGlitch();
  stopCRT();
  render();
  loadStock({ quiet: true });
  scheduleNextGlitch();
  scheduleNextMicro();
  scheduleCRT();
}

// ── Glitch system ─────────────────────────────────────────────
// Sleep glitches animate .sleep-content so the full-screen
// .sleep click target never moves — hitboxes unaffected.
// Order glitch animates .catalog; CSS transforms don't shift hit-boxes.

// Sleep — big glitch
const GLITCH_MIN_MS  = 2_000;
const GLITCH_MAX_MS  = 6_000;
const GLITCH_DUR_MS  = 700;
let glitchTimer = null;

function scheduleNextGlitch() {
  clearTimeout(glitchTimer);
  const delay = GLITCH_MIN_MS + Math.random() * (GLITCH_MAX_MS - GLITCH_MIN_MS);
  glitchTimer = setTimeout(fireGlitch, delay);
}
function fireGlitch() {
  glitchTimer = null;
  if (state.screen !== 'sleep') return;
  const el = document.querySelector('.sleep');
  if (!el) { scheduleNextGlitch(); return; }
  el.classList.add('glitching');
  setTimeout(() => { document.querySelector('.sleep')?.classList.remove('glitching'); scheduleNextGlitch(); }, GLITCH_DUR_MS);
}
function stopGlitch() {
  clearTimeout(glitchTimer); glitchTimer = null;
  document.querySelector('.sleep')?.classList.remove('glitching');
}

// Sleep — micro-glitch (faster, subtler, different frequency)
const MICRO_MIN_MS  = 800;
const MICRO_MAX_MS  = 3_000;
const MICRO_DUR_MS  = 300;
let microTimer = null;

function scheduleNextMicro() {
  clearTimeout(microTimer);
  const delay = MICRO_MIN_MS + Math.random() * (MICRO_MAX_MS - MICRO_MIN_MS);
  microTimer = setTimeout(fireMicro, delay);
}
function fireMicro() {
  microTimer = null;
  if (state.screen !== 'sleep') return;
  const el = document.querySelector('.sleep');
  if (!el) { scheduleNextMicro(); return; }
  el.classList.add('micro-glitching');
  setTimeout(() => { document.querySelector('.sleep')?.classList.remove('micro-glitching'); scheduleNextMicro(); }, MICRO_DUR_MS);
}
function stopMicro() {
  clearTimeout(microTimer); microTimer = null;
  document.querySelector('.sleep')?.classList.remove('micro-glitching');
}

// Order screen glitches — four independent modes on different frequencies

function makeOrderGlitcher(cls, minMs, maxMs, durMs) {
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(fire, minMs + Math.random() * (maxMs - minMs));
  }
  function fire() {
    timer = null;
    if (state.screen !== 'order') return;
    if (document.body.classList.contains('a11y-mode')) { schedule(); return; }
    const el = document.querySelector('.kiosk');
    if (!el) { schedule(); return; }
    el.classList.add(cls);
    setTimeout(() => { document.querySelector('.kiosk')?.classList.remove(cls); schedule(); }, durMs);
  }
  function stop() {
    clearTimeout(timer); timer = null;
    document.querySelector('.kiosk')?.classList.remove(cls);
  }
  return { schedule, stop };
}

// H tear (catalog) and V jump (catalog-v) on independent timers
const orderGlitchH = makeOrderGlitcher('glitching-h',  2_400, 9_000,  550);
const orderGlitchV = makeOrderGlitcher('glitching-v',  5_000, 16_000, 550);
// Rapid strobe flicker
const orderStrobe  = makeOrderGlitcher('order-strobe', 4_000, 13_000, 380);

function scheduleNextOrderGlitch() {
  orderGlitchH.schedule(); orderGlitchV.schedule(); orderStrobe.schedule();
}
function stopOrderGlitch() {
  orderGlitchH.stop(); orderGlitchV.stop(); orderStrobe.stop();
}

// ── Accessibility mode ───────────────────────────────────────
// Scales #app to the bottom third of the screen for seated / wheelchair users.

let a11yTimer = null;

function enableA11y() {
  document.body.classList.add('a11y-mode');
  resetA11yTimer();
}

function disableA11y() {
  document.body.classList.remove('a11y-mode');
  clearA11yTimer();
}

function resetA11yTimer() {
  clearA11yTimer();
  a11yTimer = setTimeout(disableA11y, A11Y_IDLE_MS);
}

function clearA11yTimer() {
  if (a11yTimer) { clearTimeout(a11yTimer); a11yTimer = null; }
}

document.getElementById('a11y-btn').addEventListener('click', () => {
  if (document.body.classList.contains('a11y-mode')) {
    disableA11y();
  } else {
    enableA11y();
    // Skip sleep screen — go directly to the order page
    if (state.screen === 'sleep') {
      stopGlitch(); stopMicro();
      state.screen = 'order';
      startIdleTimer();
      scheduleNextOrderGlitch();
      if (state.products.length > 0) render();
      else loadStock();
    }
  }
});

// Any touch inside the scaled app resets the auto-exit timer
document.addEventListener('touchstart', () => {
  if (document.body.classList.contains('a11y-mode')) resetA11yTimer();
}, { passive: true });

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
  const list = state.activeCategory
    ? state.products.filter(p => productCategory(p) === state.activeCategory)
    : state.products;
  return [...list].sort((a, b) => (a.available === false) - (b.available === false));
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
        <img class="sleep-claw" src="/images/poly-claw.png" alt="">
        <div class="sleep-brand">
          <div class="sleep-brand-polybius">POLYBIUS</div>
          <div class="bar-lockup">
            <span class="sleep-title-unofficial">space</span>
            <span class="bar-lockup-text"><span class="bar-initial">B</span>ase <span class="bar-initial">A</span>sset <span class="bar-initial">R</span>etrieval</span>
          </div>
        </div>
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
  const soldOut = product.available === false || limit <= 0;
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
    <article class="product${hasImg ? ' product--has-img' : ''}${soldOut ? ' product--sold-out' : ''}">
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
    ? `<p class="basket-empty">No items selected</p>`
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
        ${state.checkingOut ? 'Transmitting order…' : 'Confirm Order'}
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
  const scrollTop  = app.querySelector('.products')?.scrollTop  ?? 0;
  const scrollLeft = app.querySelector('.tabs')?.scrollLeft ?? 0;
  const categories = getCategories();
  const products = visibleProducts();
  const productsHtml = state.loading
    ? `<p class="loading">Loading menu…</p>`
    : products.map(renderProduct).join('');
  app.innerHTML = `
    <div class="kiosk">
      <div class="catalog">
        <div class="catalog-v">
          <div class="topbar">
            <h1 class="topbar-brand">
              <span class="space-graffiti topbar-space">space</span>
              <span class="bar-lockup-text"><span class="bar-initial">B</span>ase <span class="bar-initial">A</span>sset <span class="bar-initial">R</span>etrieval</span>
            </h1>
            <p>${escapeHtml(state.config?.location_name || '')}</p>
            <button class="refresh" data-refresh aria-label="Refresh menu">↺</button>
          </div>
          ${renderBanner()}
          ${renderTabs(categories)}
          <div class="products">${productsHtml}</div>
        </div>
      </div>
      ${renderBasket()}
    </div>
  `;
  if (scrollTop) {
    const el = app.querySelector('.products');
    if (el) el.scrollTop = scrollTop;
  }
  if (scrollLeft) {
    const el = app.querySelector('.tabs');
    if (el) el.scrollLeft = scrollLeft;
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
      <p class="complete-label">Asset Retrieval Terminal // Polybius Biotech Galactic Trade Network</p>
      <h1>Transmission Complete</h1>
      <p>Take your receipt to the payment node.<br>Credit transfer required to collect assets.</p>
      ${order.order_ref ? `<div class="order-number">${escapeHtml(String(order.order_ref))}</div>` : ''}
      <button class="btn-primary" data-new-order>New Request</button>
    </div>
  `;
  scheduleConfirmationReset();
  scheduleCompleteGlitch();
}

function renderPrinterError(payload) {
  state.screen = 'printer-error';
  clearIdleTimer();
  app.innerHTML = `
    <div class="status-screen">
      <h1>Transmit Error</h1>
      <p>Order queued but receipt printer failed. Tell bar staff your reference.</p>
      ${payload?.order_ref ? `<div class="order-number">${escapeHtml(String(payload.order_ref))}</div>` : ''}
      <button class="btn-primary" data-retry>Acknowledged</button>
    </div>
  `;
  scheduleConfirmationReset();
}

// ── Complete-screen glitch ──
let completeGlitchTimer = null;
function scheduleCompleteGlitch() {
  clearTimeout(completeGlitchTimer);
  completeGlitchTimer = setTimeout(fireCompleteGlitch, 1_500 + Math.random() * 4_000);
}
function fireCompleteGlitch() {
  completeGlitchTimer = null;
  if (state.screen !== 'complete') return;
  if (document.body.classList.contains('a11y-mode')) { scheduleCompleteGlitch(); return; }
  const el = document.querySelector('.status-screen.complete');
  if (!el) return;
  const cls = Math.random() > 0.5 ? 'complete-glitch-h' : 'complete-glitch-v';
  el.classList.add(cls);
  setTimeout(() => {
    document.querySelector('.status-screen.complete')?.classList.remove(cls);
    scheduleCompleteGlitch();
  }, 550);
}
function stopCompleteGlitch() {
  clearTimeout(completeGlitchTimer);
  completeGlitchTimer = null;
  document.querySelector('.status-screen.complete')
    ?.classList.remove('complete-glitch-h', 'complete-glitch-v');
}

document.addEventListener("click", event => {
  if (event.target.closest('[data-wake]')) {
    stopGlitch(); stopMicro(); stopCRT(); stopCompleteGlitch();
    state.screen = 'order';
    startIdleTimer();
    scheduleNextOrderGlitch();
    scheduleCRT();
    if (state.products.length > 0) render();
    else loadStock();
    return;
  }

  if (event.target.closest('[data-new-order]') || event.target.closest('[data-retry]')) {
    clearResetTimer();
    stopCRT(); stopCompleteGlitch();
    state.basket.clear();
    state.message = null;
    state.screen = 'order';
    startIdleTimer();
    scheduleNextOrderGlitch();
    scheduleCRT();
    render();
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

// ── CRT roll ──
// Clones the app DOM, scrolls both app (up) and clone (rising from below) together
// with a sync bar between them — mimics a real CRT losing vertical sync.
let crtTimer = null;
let crtRaf   = null;
let crtAbort = null;

function scheduleCRT() {
  clearTimeout(crtTimer);
  crtTimer = setTimeout(fireCRT, 30_000 + Math.random() * 60_000);
}

function stopCRT() {
  clearTimeout(crtTimer);
  crtTimer = null;
  if (crtRaf)   { cancelAnimationFrame(crtRaf); crtRaf = null; }
  if (crtAbort) { crtAbort(); crtAbort = null; }
}

function fireCRT() {
  crtTimer = null;
  if (document.body.classList.contains('a11y-mode')) { scheduleCRT(); return; }
  const app = document.getElementById('app');
  if (!app) { scheduleCRT(); return; }

  const h = window.innerHeight;
  const DURATION = 3_800;

  // Snapshot the current DOM — this becomes the "previous frame" wrapping up from below
  const clone = app.cloneNode(true);
  clone.removeAttribute('id');
  Object.assign(clone.style, {
    position:    'fixed',
    top:         '0',
    left:        '0',
    right:       '0',
    height:      h + 'px',
    display:     'flex',  // mirrors #app — without this .kiosk{flex:1} won't fill height
    pointerEvents: 'none',
    zIndex:      '9996',
    overflow:    'hidden',
    filter:      'contrast(1.06) saturate(0.88) brightness(0.9)',
    // Choppy multi-band mask — gives a torn/banded edge rather than a smooth fade
    maskImage:   'linear-gradient(to bottom, transparent 0px, rgba(0,0,0,0.15) 5px, transparent 8px, rgba(0,0,0,0.5) 12px, transparent 15px, black 22px)',
    webkitMaskImage: 'linear-gradient(to bottom, transparent 0px, rgba(0,0,0,0.15) 5px, transparent 8px, rgba(0,0,0,0.5) 12px, transparent 15px, black 22px)',
  });
  document.body.appendChild(clone);

  const bar = document.createElement('div');
  bar.className = 'crt-sync-bar';
  document.body.appendChild(bar);

  let start     = null;
  let jitterX   = 0;
  let jitterEnd = 0;
  let nextJitter = 0;

  function frame(ts) {
    if (!start) {
      start      = ts;
      nextJitter = ts + 180 + Math.random() * 400;
    }
    const p    = Math.min((ts - start) / DURATION, 1);
    const barY = (1 - p) * h;

    // H-sync tears: sharp random X snaps that decay after a few frames
    if (ts >= jitterEnd) jitterX = 0;
    if (ts >= nextJitter) {
      jitterX    = (Math.random() > 0.5 ? 1 : -1) * (6 + Math.random() * 22);
      jitterEnd  = ts + 35 + Math.random() * 90;
      nextJitter = ts + 160 + Math.random() * 500;
    }

    // Bar stutters slightly — sync pulse is unstable
    const barJitter = Math.random() > 0.88 ? (Math.random() - 0.5) * 6 : 0;

    app.style.transform   = `translateY(${-p * h}px) translateX(${jitterX}px)`;
    clone.style.transform = `translateY(${barY}px) translateX(${-jitterX * 0.65}px)`;
    bar.style.top         = `${barY - 10 + barJitter}px`;

    if (p < 1) {
      crtRaf = requestAnimationFrame(frame);
    } else {
      cleanup();
    }
  }

  function cleanup() {
    app.style.transform = '';
    clone.remove();
    bar.remove();
    crtRaf   = null;
    crtAbort = null;
    scheduleCRT();
  }

  crtAbort = cleanup;
  crtRaf   = requestAnimationFrame(frame);
}

async function boot() {
  try {
    await loadConfig();
    await loadProductMeta();
  } catch { /* non-fatal — show sleep screen, retry on first wake */ }
  render();
  loadStock({ quiet: true });
  setInterval(() => loadStock({ quiet: true }), 60_000);
  scheduleNextGlitch();
  scheduleNextMicro();
  scheduleCRT();
}

boot();
