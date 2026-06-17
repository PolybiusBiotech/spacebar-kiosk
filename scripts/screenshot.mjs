#!/usr/bin/env node
// Takes screenshots of the kiosk for the README.
// Usage: node scripts/screenshot.mjs
// Requires: npm install puppeteer (one-time)
import puppeteer from 'puppeteer';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8080';
const OUT = join(import.meta.dirname, '..', 'docs', 'screenshots');
const VIEWPORT = { width: 768, height: 1024 };

await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setViewport(VIEWPORT);

await page.goto(BASE, { waitUntil: 'networkidle0' });

// Sleep screen
await page.screenshot({ path: join(OUT, 'sleep.png') });
console.log('sleep.png');

// Wake → product grid
await page.click('[data-wake]');
await page.waitForSelector('.product');
await page.screenshot({ path: join(OUT, 'products.png') });
console.log('products.png');

// Add items
await page.click('button[data-add="101"]');
await page.click('button[data-add="102"]');
await page.screenshot({ path: join(OUT, 'basket.png') });
console.log('basket.png');

// Place order
await page.click('.checkout');
await page.waitForSelector('.order-number');
await page.screenshot({ path: join(OUT, 'complete.png') });
console.log('complete.png');

await browser.close();
console.log('Done — screenshots saved to docs/screenshots/');
