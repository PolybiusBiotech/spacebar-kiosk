import { initScene, startScene, stopScene, setExtraSlots, clearExtraSlots, rescanCards } from "/scene.js";

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

// ABV lookup — licensing requirement: price list must show ABV

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
  stopScene();
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
  stopScene();
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
  stopScene();
  resetA11yTimer();
}

function disableA11y() {
  document.body.classList.remove('a11y-mode');
  clearA11yTimer();
  startScene();
  rescanCards();
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
      state.activeCategory = null;
      startIdleTimer();
      scheduleNextOrderGlitch();
      startScene();
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

// ── BuzzBallz A/B position shuffle ─────────────────────────────────────────
// Shuffled once per session so customers always see the same order if they
// browse multiple times, but the order varies across sessions.
// buzzballzOrder maps stockline_id → 0-based display position.
let buzzballzOrder = null;

function isBuzzball(p) {
  return /buzzball/i.test(p.name || "");
}

function initBuzzballzShuffle() {
  if (buzzballzOrder) return; // already set this session
  const buzzballz = state.products.filter(isBuzzball);
  // Fisher-Yates shuffle
  for (let i = buzzballz.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [buzzballz[i], buzzballz[j]] = [buzzballz[j], buzzballz[i]];
  }
  buzzballzOrder = new Map(buzzballz.map((p, i) => [p.stockline_id, i]));
  console.log("[pos-test] BuzzBallz order:", buzzballz.map((p, i) => `${i + 1}: ${p.name}`).join(", "));
}

function logBuzzballzPositions(orderRef) {
  if (!buzzballzOrder) return;
  const sold = basketItems()
    .filter(item => isBuzzball(item.product))
    .map(item => ({
      name: item.product.name,
      stockline_id: item.stocklineId,
      position: (buzzballzOrder.get(item.stocklineId) ?? -1) + 1,
      qty: item.qty,
    }));
  if (!sold.length) return;
  fetch("/api/sale-positions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_ref: orderRef, buzzballz_sold: sold }),
  }).catch(() => {});
}

function visibleProducts() {
  const list = state.activeCategory
    ? state.products.filter(p => productCategory(p) === state.activeCategory)
    : state.products;
  return [...list].sort((a, b) => {
    const avail = (a.available === false) - (b.available === false);
    if (avail !== 0) return avail;
    const aPos = buzzballzOrder?.get(a.stockline_id) ?? null;
    const bPos = buzzballzOrder?.get(b.stockline_id) ?? null;
    if (aPos !== null && bPos !== null) return aPos - bPos;
    return 0;
  });
}

// ── 3D model selection ──────────────────────────────────────────────────────
// Each product card shows a low-poly model (see scene.js). Type and colour are
// inferred from the product, but products.json can override either per product.

function resolveModel(product, meta, category) {
  if (meta.model) return meta.model; // 'can' | 'ball' | 'bottle'
  const hay = `${category || ""} ${product.name || ""}`;
  if (/buzz|ball|'?rita/i.test(hay)) return "ball";
  if (/spirit|whisky|whiskey|vodka|gin|rum|tequila|bottle/i.test(category || "")) return "bottle";
  return "can";
}

// BuzzBallz flavour colours sampled from the product art at buzzballz.com.
// Order matters — first regex to match wins, so more specific names come first
// (e.g. "limeade" before "lime", "pink lemon" before "lemon").
const FLAVOUR_COLORS = [
  [/horchata/i, "#ece9e1"],
  [/colada/i, "#efede8"],                  // Lotta Colada — creamy white
  [/choc/i, "#cf9c6b"],                    // Choc Tease
  [/espresso|coffee/i, "#4f3120"],         // Espresso Martini — coffee brown
  [/hazelnut|latte/i, "#a07c54"],          // Hazelnut Latte
  [/berry\s*cherry|limeade/i, "#1fc1e6"],  // Berry Cherry Limeade — cyan (before "lime")
  [/forbidden|apple/i, "#51c22e"],         // Forbidden Apple
  [/lime/i, "#4fc21b"],                    // Lime 'Rita
  [/grape/i, "#7c54e0"],                   // Grapes Gone Wild
  [/strawberr/i, "#f22740"],               // Strawberry 'Rita
  [/watermelon/i, "#fa1f8c"],              // Watermelon — magenta
  [/pink\s*lemon|lemonsqueez/i, "#f49ab4"], // Pink Lemonsqueezy (before "lemon")
  [/pineapple|jalape/i, "#ffe11f"],        // Pineapple Jalapeño — yellow
  [/chil(i|li)|mango/i, "#d0b902"],        // Chili Mango — gold
  [/tropic|tang/i, "#f7991f"],             // Tropic Tang — orange
  [/passion/i, "#f7a81c"],                 // Passionfruit Martini — golden orange (GUESS, confirm)
  [/peach/i, "#f4541f"],                   // Peachballz — coral
  [/cran/i, "#9c1530"],                    // Cran Blaster — maroon
  [/tequila/i, "#9fd14e"],                 // Tequila 'Rita — margarita green (GUESS, confirm)
  [/'?rita/i, "#f22740"],                  // any other 'Rita → red
  // Generic fallbacks for non-BuzzBallz stock (mixed cans, wine, soft drinks…)
  [/white\s*wine/i, "#e6d98f"],            // canned white wine — pale straw
  [/red\s*wine/i, "#7d1f2f"],              // canned red wine — burgundy
  [/lemon/i, "#ffd400"],
  [/blue\s*rasp|blueberr|blue/i, "#1e90ff"],
  [/orange/i, "#ff8c00"],
  [/cola|coke|rum|jack|whisk|bourbon/i, "#7a4a2b"],
  [/vodka|gin|tonic|soda|lemonade/i, "#bfe9ff"],
  [/cider/i, "#d9a441"],
  [/beer|lager|ale|ipa|stout/i, "#e0a527"]
];

function resolveColor(product, meta) {
  if (meta.color) return meta.color;
  const name = product.name || "";
  for (const [re, col] of FLAVOUR_COLORS) if (re.test(name)) return col;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 55%)`;
}

// "& Coke" mixers: a dark cola brown fills the bottom 2/3 of the can and the
// spirit gets a distinct colour band on the top third, so Rum/Vodka/Jack are
// distinguishable at a glance. First match wins.
const COLA_BROWN = "#3a2414";
const COKE_MIXES = [
  [/jack|daniel/i, "#262626"], // Jack Daniel's — black label
  [/vodka/i, "#cfe2ee"],       // vodka — clear / icy silver
  [/rum/i, "#cf962e"],         // rum — gold
  [/bourbon|whisk/i, "#b3701f"], // whiskey — amber
  [/brandy/i, "#6e3410"],
  [/tequila/i, "#d9c089"]
];

// Returns { color, color2 } — color2 set only for two-tone cans (coke mixes).
function resolveColors(product, meta) {
  if (meta.color) return { color: meta.color, color2: meta.color2 || null };
  const name = product.name || "";
  if (/\bcoke\b|\bcola\b/i.test(name)) { // \b so "Lotta Colada" isn't treated as a cola
    const mix = COKE_MIXES.find(([re]) => re.test(name));
    return mix ? { color: mix[1], color2: COLA_BROWN } : { color: COLA_BROWN, color2: null };
  }
  return { color: resolveColor(product, meta), color2: null };
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
    initBuzzballzShuffle();
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
  if (code === "invalid-token" || code === "misconfigured") return "This kiosk is not configured correctly. Please ask for help.";
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
  const body = { items: basketItems().map(item => ({ stockline_id: item.stocklineId, qty: item.qty })) };
  try {
    const order = await jsonFetch("/api/orders", { method: "POST", body: JSON.stringify(body) });
    logBuzzballzPositions(String(order.transaction_id ?? "unknown"));
    state.basket.clear();
    await loadStock({ quiet: true });
    renderComplete(order);
    stayOnResultScreen = true;
  } catch (error) {
    const code = error.payload?.error;
    if (["insufficient-stock", "price-not-set", "order-error"].includes(code)) {
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
  // With a real image, show it; otherwise show a bobbing low-poly 3D model.
  const { color, color2 } = resolveColors(product, meta);
  const visualHtml = hasImg
    ? `<div class="product-img"><img src="${escapeHtml(meta.image)}" alt="" loading="lazy"></div>`
    : `<div class="product-3d" data-key="${escapeHtml(String(product.stockline_id))}" data-model="${escapeHtml(resolveModel(product, meta, productCategory(product)))}" data-color="${escapeHtml(color)}"${color2 ? ` data-color2="${escapeHtml(color2)}"` : ''}></div>`;
  const key = productKey(product.stockline_id);
  const qty = state.basket.get(key) || 0;
  const limit = itemLimit(product);
  const soldOut = product.available === false || limit <= 0;
  const atMax = qty >= limit;
  const descHtml = product.description ? `<p class="product-desc">${escapeHtml(product.description)}</p>` : '';
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
    <article class="product${hasImg ? ' product--has-img' : ' product--has-3d'}${soldOut ? ' product--sold-out' : ''}">
      ${visualHtml}
      <div class="product-info">
        <h2 class="product-name">${escapeHtml(product.name)}</h2>
        ${descHtml}
      </div>
      <div class="product-footer">
        <div class="product-price-abv">
          <span class="price">${money(product.price)}</span>
          ${product.stocktype?.abv ? `<span class="product-abv">${escapeHtml(product.stocktype.abv)}% ABV</span>` : ''}
        </div>
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
  stopScene();
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
  stopScene();
  app.innerHTML = `
    <div class="status-screen complete">
      <p class="complete-label">Asset Retrieval Terminal // Polybius Biotech Galactic Trade Network</p>
      <h1>Transmission Complete</h1>
      <p>Take your receipt to the payment node.<br>Credit transfer required to collect assets.</p>
      ${order.transaction_id != null ? `<div class="order-number">${escapeHtml(String(order.transaction_id))}</div>` : ''}
      <button class="btn-primary" data-new-order>New Request</button>
    </div>
  `;
  scheduleConfirmationReset();
  scheduleCompleteGlitch();
}

function renderPrinterError(payload) {
  state.screen = 'printer-error';
  clearIdleTimer();
  stopScene();
  app.innerHTML = `
    <div class="status-screen">
      <h1>Transmit Error</h1>
      <p>Order queued but receipt printer failed. Tell bar staff your reference.</p>
      ${payload?.transaction_id != null ? `<div class="order-number">${escapeHtml(String(payload.transaction_id))}</div>` : ''}
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
    state.activeCategory = null;
    startIdleTimer();
    scheduleNextOrderGlitch();
    scheduleCRT();
    startScene();
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
    startScene();
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
  if (state.screen !== 'sleep') { scheduleCRT(); return; }
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
    maskImage:   'linear-gradient(to bottom, transparent 0px, rgba(0,0,0,0.1) 4px, transparent 7px, rgba(0,0,0,0.4) 11px, transparent 15px, rgba(0,0,0,0.7) 20px, transparent 24px, black 32px)',
    webkitMaskImage: 'linear-gradient(to bottom, transparent 0px, rgba(0,0,0,0.1) 4px, transparent 7px, rgba(0,0,0,0.4) 11px, transparent 15px, rgba(0,0,0,0.7) 20px, transparent 24px, black 32px)',
  });
  document.body.appendChild(clone);
  setExtraSlots(clone.querySelectorAll('.product-3d'));

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
      jitterX    = (Math.random() > 0.5 ? 1 : -1) * (10 + Math.random() * 38);
      jitterEnd  = ts + 40 + Math.random() * 110;
      nextJitter = ts + 120 + Math.random() * 380;
    }

    // Bar stutters slightly — sync pulse is unstable
    const barJitter = Math.random() > 0.88 ? (Math.random() - 0.5) * 6 : 0;

    // filter: brightness(1) creates a containing block for position:fixed descendants
    // (translateX(0) alone is not enough in Chrome when the value is zero).
    // translateY scrolls the live frame up so content lifts off rather than fading away.
    app.style.filter      = 'brightness(1)';
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
    clearExtraSlots();
    app.style.filter    = '';
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
  initScene();
  render();
  loadStock({ quiet: true });
  setInterval(() => loadStock({ quiet: true }), 60_000);
  scheduleNextGlitch();
  scheduleNextMicro();
  scheduleCRT();
}

boot();

// ── Tab bar drag-to-scroll ────────────────────────────────────────────────────
// overflow-x:auto handles touch natively; add pointer drag for mouse/tablet.
(function () {
  let dragEl = null, startX = 0, startScroll = 0, moved = false;
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest('.tabs');
    if (!el) return;
    dragEl = el;
    startX = e.clientX;
    startScroll = el.scrollLeft;
    moved = false;
    el.style.cursor = 'grabbing';
  });
  document.addEventListener('pointermove', e => {
    if (!dragEl) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 4) moved = true;
    dragEl.scrollLeft = startScroll - dx;
  });
  document.addEventListener('pointerup', e => {
    if (!dragEl) return;
    dragEl.style.cursor = '';
    // swallow the click so a drag doesn't also activate the tab
    if (moved) e.stopPropagation();
    dragEl = null;
  }, true);
})();

// ── Maintenance mode ──────────────────────────────────────────────────────────
const maintenanceOverlay = document.getElementById("maintenance-overlay");
let maintenanceReconnectDelay = 3000;
let maintenanceGlitchTimer = null;
let maintenanceCountdownInterval = null;

function maintenanceCountdownText(reopeningAt) {
  const [hh, mm] = reopeningAt.split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const totalMins = Math.ceil((target - now) / 60000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs > 0) return `maintenance scheduled in ${hrs} hr${hrs !== 1 ? 's' : ''} ${mins} min${mins !== 1 ? 's' : ''}`;
  return `maintenance scheduled in ${mins} min${mins !== 1 ? 's' : ''}`;
}

function startMaintenanceCountdown(reopeningAt) {
  clearInterval(maintenanceCountdownInterval);
  const reopenEl = document.getElementById("maintenance-reopen");
  if (!reopenEl || !reopeningAt) return;
  const update = () => { reopenEl.textContent = maintenanceCountdownText(reopeningAt); };
  update();
  maintenanceCountdownInterval = setInterval(update, 30_000);
}

function stopMaintenanceCountdown() {
  clearInterval(maintenanceCountdownInterval);
  maintenanceCountdownInterval = null;
}

function scheduleMaintenanceGlitch() {
  maintenanceGlitchTimer = setTimeout(() => {
    const titleEl = document.querySelector('.maintenance-title');
    if (titleEl) {
      titleEl.classList.add('glitching');
      titleEl.addEventListener('animationend', () => {
        titleEl.classList.remove('glitching');
        scheduleMaintenanceGlitch();
      }, { once: true });
    }
  }, 3_000 + Math.random() * 9_000);
}

function stopMaintenanceGlitch() {
  clearTimeout(maintenanceGlitchTimer);
  maintenanceGlitchTimer = null;
  document.querySelector('.maintenance-title')?.classList.remove('glitching');
}

function connectKioskEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("maintenance", e => {
    try {
      const { active, reopeningAt } = JSON.parse(e.data);
      maintenanceOverlay.hidden = !active;
      const reopenEl = document.getElementById("maintenance-reopen");
      if (reopenEl) reopenEl.hidden = !active || !reopeningAt;
      if (active && reopeningAt) startMaintenanceCountdown(reopeningAt);
      else stopMaintenanceCountdown();
      if (active) scheduleMaintenanceGlitch(); else stopMaintenanceGlitch();
      maintenanceReconnectDelay = 3000;
    } catch {}
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectKioskEvents, maintenanceReconnectDelay);
    maintenanceReconnectDelay = Math.min(maintenanceReconnectDelay * 2, 30_000);
  };
}
connectKioskEvents();
