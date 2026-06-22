#!/usr/bin/env node
// Takes screenshots of the kiosk for the README.
// Usage: node scripts/screenshot.mjs
// Requires: npm install puppeteer (one-time)
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8080';
const OUT = join(import.meta.dirname, '..', 'docs', 'screenshots');
const VIEWPORT = { width: 768, height: 1024 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });

// WebGL args so the 3D product models render under headless Chromium.
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader']
});
const page = await browser.newPage();
await page.setViewport(VIEWPORT);

await page.goto(BASE, { waitUntil: 'networkidle0' });

// Sleep screen
await sleep(400);
await page.screenshot({ path: join(OUT, 'sleep.png') });
console.log('sleep.png');

// Wake → product grid (let the 3D models render/settle before capturing)
await page.click('[data-wake]');
await page.waitForSelector('.product-3d');
await sleep(1500);
await page.screenshot({ path: join(OUT, 'products.png') });
console.log('products.png');

// Add items
await page.click('button[data-add="101"]');
await page.click('button[data-add="102"]');
await sleep(300);
await page.screenshot({ path: join(OUT, 'basket.png') });
console.log('basket.png');

// Place order
await page.click('.checkout');
await page.waitForSelector('.order-number');
await page.screenshot({ path: join(OUT, 'complete.png') });
console.log('complete.png');

await browser.close();
console.log('Done — screenshots saved to docs/screenshots/');
