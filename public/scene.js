// Low-poly 3D product models that bob and float inside the product cards.
//
// One WebGL canvas is fixed full-window behind the UI. Each frame we walk the
// `.product-3d` slots currently in the DOM, read their on-screen rectangles and
// render that product's model into that rectangle using the renderer's scissor
// + viewport. A single renderer/context keeps it cheap enough for a Pi.
//
// Models are built procedurally (no asset files): a faceted can, an icosphere
// BuzzBall, and a stubby bottle. Colour and model type come from the slot's
// data- attributes (resolved in app.js, overridable via products.json).
//
// Pi budget: this targets a Raspberry Pi, so everything is deliberately cheap —
// one WebGL context, no antialiasing (jaggy suits the look anyway), flat-shaded
// materials, 2 lights, few meshes per model, 30fps idle (full-rate only while
// scrolling), and only on-screen cards are touched at all — visibility is tracked
// with an IntersectionObserver so off-screen models cost nothing per frame.

import * as THREE from "three";

const FRAME_MS = 1000 / 30;     // idle: a gentle bob doesn't need more, and it halves GPU load
const SCROLL_WAKE_MS = 250;     // while scrolling, render every frame so models track the cards
const CAMERA_Z = 6;

// Rare digital glitch — the models stutter/jump for a fraction of a second every
// so often. Deliberately less frequent than the CRT/order glitch in app.js.
const GLITCH_MIN_GAP_MS = 13_000;
const GLITCH_MAX_GAP_MS = 30_000;
const glitchGap = () => GLITCH_MIN_GAP_MS + Math.random() * (GLITCH_MAX_GAP_MS - GLITCH_MIN_GAP_MS);

let renderer = null;
let camera = null;
let canvas = null;
let running = false;
let rafId = null;
let lastFrame = 0;
let lastScrollAt = 0;
let nextGlitchAt = 0;
let glitchUntil = 0;
let glitchKeys = new Set(); // which models glitch during the current burst
let wasGlitching = false;
let failed = false;
let lastAspect = 0;             // skip redundant camera.updateProjectionMatrix()
const onScreen = new Set();     // .product-3d elements currently in the products viewport
const extraSlots = new Set();   // transient extra slots (e.g. CRT clone) — no clip constraint
let cardObserver = null;        // IntersectionObserver: which cards are on-screen
let domObserver = null;         // re-scans cards when the grid re-renders

// stockline key -> { scene, model, phase, sig }
const entries = new Map();

// ── Model builders ──────────────────────────────────────────────────────────
// Keep mesh counts tiny: each render() call is a draw, and a full grid renders
// every visible card every frame. Cans/balls are 2 meshes ≈ 2 draws per card.

function makeLights() {
  const group = new THREE.Group();
  // Hemisphere does the ambient fill cheaply; a purple-ish ground colour fakes
  // the UI's neon underglow without spending a third light on it.
  group.add(new THREE.HemisphereLight(0x9affa0, 0x2a0033, 0.7));
  // Bright-ish key light gives the glossy specular hotspot that sells "plastic".
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(2.5, 4, 3);
  group.add(key);
  return group;
}

// Glossy plastic — smooth normals + a specular hotspot read as a wet plastic
// surface full of coloured fluid (that's basically what a BuzzBall is).
function plastic(color, shininess = 85) {
  return new THREE.MeshPhongMaterial({ color, shininess, specular: 0x6e6e6e });
}
function metal(color) {
  return new THREE.MeshPhongMaterial({ color, shininess: 110, specular: 0x9aa0a6 });
}

function makeCan(color, color2) {
  const group = new THREE.Group();
  const R = 0.6;
  const H = 1.95;
  const seg = 28; // smooth-walled, round silhouette
  if (color2) {
    // Two-tone "& Coke" can: bottom 2/3 the cola brown (color2), top 1/3 the
    // spirit's indicator colour (color).
    const lowH = H * (2 / 3);
    const topH = H - lowH;
    const low = new THREE.Mesh(new THREE.CylinderGeometry(R, R, lowH, seg, 1), plastic(color2, 55));
    low.position.y = -H / 2 + lowH / 2;
    group.add(low);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R, topH, seg, 1), plastic(color, 55));
    top.position.y = H / 2 - topH / 2;
    group.add(top);
  } else {
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, seg, 1), plastic(color, 55)));
  }
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.92, R, 0.16, seg), metal(0xd2d8de));
  lid.position.y = H / 2 + 0.06;
  group.add(lid);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.92, 0.12, seg), metal(0xb9c0c6));
  base.position.y = -H / 2 - 0.04;
  group.add(base);
  return group;
}

// Bakes the flavour colour + the BuzzBallz wordmark (twice, on opposite sides)
// into a texture wrapped around the ball, so the logo shows front and back as
// it spins. Ink flips dark/light to stay legible, like the real labels.
function ballLabelTexture(color) {
  const W = 512;
  const H = 256;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = `#${color.getHexString()}`;
  ctx.fillRect(0, 0, W, H);

  const lum = color.r * 0.299 + color.g * 0.587 + color.b * 0.114; // linear luminance
  ctx.fillStyle = lum > 0.4 ? "#15224f" : "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Canvas top maps to the lid end of the ball (default flipY), so draw the
  // logo in the upper third to sit it on the shoulder, like the real label.
  for (const cx of [W * 0.25, W * 0.75]) { // two opposite sides
    ctx.save();
    ctx.translate(cx, H * 0.32);
    ctx.font = 'italic 900 28px "Arial Black", Arial, sans-serif';
    ctx.fillText("BuzzBallz", 0, 0);
    ctx.font = '700 9px Arial, sans-serif';
    ctx.fillText("Ready-to-Go Cocktails", 0, 19);
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 1; // anisotropic filtering is costly on the Pi GPU; not worth it at card size
  return tex;
}

function makeBall(color) {
  const group = new THREE.Group();
  // BuzzBallz are a faceted ball with the top cut flat and a silver can lid —
  // not a full sphere. thetaStart opens the top; few longitude segments + flat
  // shading give the low-poly vertical-strip look. The opening sits at polar
  // angle 0.52 (ring radius ~0.52 at y ~0.91), which the lid below caps.
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1.05, 13, 16, 0, Math.PI * 2, 0.52, Math.PI - 0.52),
    new THREE.MeshPhongMaterial({ color: 0xffffff, map: ballLabelTexture(color), shininess: 70, specular: 0x4a4a4a, flatShading: true })
  );
  group.add(shell);
  // Flat silver pull-tab can lid; small, sat on the ball's shoulder. Wider at
  // the base for the crimped seam.
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.47, 0.55, 0.13, 20),
    new THREE.MeshPhongMaterial({ color: 0xd8dde2, shininess: 120, specular: 0xaab0b6, flatShading: true })
  );
  lid.position.y = 0.95;
  group.add(lid);
  return group;
}

function makeBottle(color) {
  const group = new THREE.Group();
  const glass = plastic(color, 100);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 1.4, 22), glass);
  body.position.y = -0.35;
  group.add(body);
  const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.46, 0.5, 22), glass);
  shoulder.position.y = 0.6;
  group.add(shoulder);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.17, 0.45, 22), glass);
  neck.position.y = 1.05;
  group.add(neck);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.24, 18), metal(0x222222));
  cap.position.y = 1.4;
  group.add(cap);
  group.scale.setScalar(0.92);
  return group;
}

function toColor(str, fallback = "#7CC142") {
  try {
    return new THREE.Color(str || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

function buildModel(type, colorStr, color2Str) {
  const color = toColor(colorStr);
  if (type === "ball") return makeBall(color);
  if (type === "bottle") return makeBottle(color);
  return makeCan(color, color2Str ? toColor(color2Str) : null);
}

// ── Setup ─────────────────────────────────────────────────────────────────--

export function initScene() {
  if (renderer || failed) return;
  try {
    canvas = document.createElement("canvas");
    canvas.id = "product-3d-canvas";
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "9997",
      display: "none"
    });
    document.body.appendChild(canvas);

    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "low-power" });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); // Pi is 1; cap retina dev machines
    renderer.autoClear = false;

    camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 1.15, CAMERA_Z); // slight downward tilt so caps/lids are visible
    camera.lookAt(0, -0.05, 0);

    resize();
    window.addEventListener("resize", resize);
    // Capture catches scroll from .products even though it's re-rendered often.
    document.addEventListener("scroll", () => { lastScrollAt = performance.now(); }, { capture: true, passive: true });

    // Re-scan visible cards whenever the grid re-renders (innerHTML swap).
    const appEl = document.getElementById("app");
    if (appEl) {
      domObserver = new MutationObserver(rescanCards);
      domObserver.observe(appEl, { childList: true, subtree: true });
    }
    rescanCards();
  } catch (err) {
    // No WebGL — cards just show the empty glowing slot. Not fatal.
    failed = true;
    console.warn("3D scene disabled:", err);
  }
}

function resize() {
  if (renderer) renderer.setSize(window.innerWidth, window.innerHeight, false);
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function getEntry(el) {
  const key = el.dataset.key || el.dataset.model;
  const sig = `${el.dataset.model}|${el.dataset.color}|${el.dataset.color2 || ""}`;
  let entry = entries.get(key);
  if (entry && entry.sig !== sig) entry = null; // model/colour changed → rebuild
  if (!entry) {
    const scene = new THREE.Scene();
    scene.add(makeLights());
    const model = buildModel(el.dataset.model, el.dataset.color, el.dataset.color2);
    scene.add(model);
    const h0 = hashString(key);
    const h1 = hashString(key + 'b');
    const h2 = hashString(key + 'c');
    const h3 = hashString(key + 'd');
    entry = {
      scene, model, sig,
      phase:    (h0 % 1000) / 1000 * Math.PI * 2,
      freqY:    1.0 + (h1 % 1000) / 1000 * 0.85,  // 1.0 – 1.85 hz
      ampY:     0.09 + (h2 % 1000) / 1000 * 0.13,  // 0.09 – 0.22 units
      rotSpeed: 0.40 + (h3 % 1000) / 1000 * 0.45,  // 0.40 – 0.85 rad/s
    };
    entries.set(key, entry);
  }
  return entry;
}

// ── Render loop ─────────────────────────────────────────────────────────────

// Rebuild the on-screen set after a re-render. Cards are observed against the
// scrollable .products viewport so models scrolled out of view cost nothing.
// Newly-observed cards start "on" and the observer prunes them a frame later.
export function rescanCards() {
  if (cardObserver) cardObserver.disconnect();
  onScreen.clear();
  const root = document.querySelector(".products");
  const cards = document.querySelectorAll(".product-3d");
  if (!root || !cards.length) { cardObserver = null; return; }
  cardObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) onScreen.add(e.target);
      else onScreen.delete(e.target);
    }
  }, { root, rootMargin: "100px" });
  for (const el of cards) { onScreen.add(el); cardObserver.observe(el); }
}

// Pick 1–3 of the on-screen models to glitch for one burst.
function pickGlitchSubset() {
  const keys = [...onScreen].map(el => el.dataset.key || el.dataset.model);
  const set = new Set();
  if (!keys.length) return set;
  const n = Math.min(keys.length, 1 + Math.floor(Math.random() * 3));
  while (set.size < n) set.add(keys[Math.floor(Math.random() * keys.length)]);
  return set;
}

// Corrupt a model's look mid-glitch: flicker to wireframe and flash random
// emissive colours across its meshes. Cheap — runs on 1–3 models for ~300ms.
function corruptModel(model) {
  model.traverse(o => {
    if (!o.isMesh || !o.material) return;
    o.material.wireframe = Math.random() < 0.4;
    if (o.material.emissive) {
      if (Math.random() < 0.3) o.material.emissive.setRGB(Math.random(), Math.random(), Math.random());
      else o.material.emissive.setRGB(0, 0, 0);
    }
  });
}

// Restore the burst's models to normal materials once the glitch ends.
function clearCorruption() {
  for (const key of glitchKeys) {
    const entry = entries.get(key);
    if (!entry) continue;
    entry.model.traverse(o => {
      if (!o.isMesh || !o.material) return;
      o.material.wireframe = false;
      if (o.material.emissive) o.material.emissive.setRGB(0, 0, 0);
    });
  }
}

function loop(now) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  // Trigger the occasional glitch burst — only a random few models each time.
  if (nextGlitchAt === 0) nextGlitchAt = now + glitchGap();
  if (now >= glitchUntil && now >= nextGlitchAt) {
    glitchUntil = now + 160 + Math.random() * 300; // 160–460ms burst
    nextGlitchAt = now + glitchGap();
    glitchKeys = pickGlitchSubset();
  }
  const glitching = now < glitchUntil;
  if (wasGlitching && !glitching) clearCorruption(); // burst just ended → restore materials
  wasGlitching = glitching;

  // Render every frame while scrolling so models track the cards; otherwise cap
  // at 30fps — including during glitches (the jitter re-randomises each rendered
  // frame, so 30fps still reads as chaotic but costs half of full-rate).
  const scrolling = now - lastScrollAt < SCROLL_WAKE_MS;
  if (!scrolling && now - lastFrame < FRAME_MS) return;
  lastFrame = now;

  const time = now / 1000;
  const viewH = window.innerHeight;
  const clip = document.querySelector(".products")?.getBoundingClientRect();

  // Clear the whole buffer once (transparent), then draw each card into its rect
  // with autoClear off so nothing ghosts when the grid scrolls.
  renderer.setScissorTest(false);
  renderer.clear(true, true, true);
  renderer.setScissorTest(true);

  // Only iterate cards the IntersectionObserver says are on-screen.
  for (const el of onScreen) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;

    // Clip the drawn area to the scrollable products region so models never
    // spill over the tabs above or the basket below.
    const top = clip ? Math.max(r.top, clip.top) : r.top;
    const bottom = clip ? Math.min(r.bottom, clip.bottom) : r.bottom;
    const left = clip ? Math.max(r.left, clip.left) : r.left;
    const right = clip ? Math.min(r.right, clip.right) : r.right;
    if (bottom <= top || right <= left) continue; // fully off-screen / clipped

    const entry = getEntry(el);
    const key = el.dataset.key || el.dataset.model;

    // Viewport = full card rect (keeps the model un-squished); scissor = clipped.
    renderer.setViewport(r.left, viewH - r.bottom, r.width, r.height);
    renderer.setScissor(left, viewH - bottom, right - left, bottom - top);
    const aspect = r.width / r.height;
    if (aspect !== lastAspect) { // all cards share a size, so this recomputes ~once/frame
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      lastAspect = aspect;
    }

    // Glitch burst: jitter rotation/position/scale per frame, with the odd
    // dropped frame so the model flickers out. Otherwise reset to a clean bob.
    let jrot = 0;
    let jx = 0;
    let jy = 0;
    let sx = 1;
    let sy = 1;
    let sz = 1;
    if (glitching && glitchKeys.has(key)) {
      if (Math.random() < 0.22) continue; // dropout flicker — skip this card's draw
      jrot = (Math.random() - 0.5) * 0.9;
      jx = (Math.random() - 0.5) * 0.5;
      jy = (Math.random() - 0.5) * 0.5;
      sx = 1 + (Math.random() - 0.5) * 0.8; // non-uniform warp — stretches/squashes the model
      sy = 1 + (Math.random() - 0.5) * 0.8;
      sz = 1 + (Math.random() - 0.5) * 0.8;
      corruptModel(entry.model);            // wireframe flicker + emissive RGB flashes
    }

    const m = entry.model;
    m.rotation.y = time * entry.rotSpeed + entry.phase + jrot;
    m.rotation.x = Math.sin(time * entry.freqY * 0.55 + entry.phase) * 0.12 + jrot * 0.5;
    m.position.x = jx;
    m.position.y = Math.sin(time * entry.freqY + entry.phase) * entry.ampY + jy;
    m.scale.set(sx, sy, sz);

    renderer.render(entry.scene, camera);
  }

  // Render extra transient slots (e.g. the CRT clone) — same as above but no
  // clip constraint, since these elements are outside .products.
  for (const el of extraSlots) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > viewH) continue;
    const entry = getEntry(el);
    renderer.setViewport(r.left, viewH - r.bottom, r.width, r.height);
    renderer.setScissor(r.left, viewH - r.bottom, r.width, r.height);
    const aspect = r.width / r.height;
    if (aspect !== lastAspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      lastAspect = aspect;
    }
    const m = entry.model;
    m.rotation.y = time * 0.6 + entry.phase;
    m.rotation.x = Math.sin(time * 0.8 + entry.phase) * 0.12;
    m.position.x = 0;
    m.position.y = Math.sin(time * 1.4 + entry.phase) * 0.14;
    m.scale.set(1, 1, 1);
    renderer.render(entry.scene, camera);
  }
}

export function setExtraSlots(elements) {
  extraSlots.clear();
  for (const el of elements) extraSlots.add(el);
}

export function clearExtraSlots() {
  extraSlots.clear();
}

export function startScene() {
  if (!renderer && !failed) initScene();
  if (failed || running) return;
  running = true;
  canvas.style.display = "block";
  lastFrame = 0;
  nextGlitchAt = 0; // reschedule the glitch fresh each time we wake
  glitchUntil = 0;
  rafId = requestAnimationFrame(loop);
}

export function stopScene() {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (canvas) canvas.style.display = "none";
}
