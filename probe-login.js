#!/usr/bin/env node
/**
 * Probe the login page to find the Google SSO button.
 * Screenshots each step and dumps clickable elements.
 *
 * ⚠️  Stop the server first!
 *    node probe-login.js
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

const PROFILE = (process.env.BROWSER_PROFILE_PATH || '~/.friendsschool-profile').replace(/^~/, process.env.HOME);
const BASE = 'https://friendsbalt.myschoolapp.com';

(async () => {
  console.log('Launching headed browser...');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();

  try {
    console.log('Navigating to app...');
    await page.goto(`${BASE}/app`, { waitUntil: 'commit', timeout: 30000 });

    // Wait for redirects to settle
    await page.waitForTimeout(5000);
    console.log(`Landed: ${page.url()}`);

    await page.screenshot({ path: path.join(__dirname, 'data', 'login-step1.png'), fullPage: true });
    console.log('Screenshot: data/login-step1.png');

    // Dump all clickable elements (buttons, links, inputs)
    const clickables = await page.evaluate(() => {
      const results = [];
      const sels = 'a, button, input[type="button"], input[type="submit"], [role="button"], [onclick]';
      for (const el of document.querySelectorAll(sels)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        results.push({
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 100),
          href: el.href || '',
          id: el.id,
          className: (el.className || '').toString().slice(0, 150),
          type: el.type || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
        });
      }
      return results;
    });

    console.log(`\n=== ${clickables.length} clickable elements ===`);
    for (const c of clickables) {
      const label = c.text || c.ariaLabel || c.id || '(no text)';
      console.log(`  <${c.tag}> "${label.slice(0, 60)}" ${c.w}x${c.h} @ ${c.x},${c.y}`);
      if (c.href) console.log(`    href: ${c.href.slice(0, 150)}`);
      if (c.className) console.log(`    class: ${c.className.slice(0, 100)}`);
      if (c.id) console.log(`    id: ${c.id}`);
    }

    // Look specifically for Google-related elements
    console.log('\n=== Google-related elements ===');
    const googleEls = await page.evaluate(() => {
      const results = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const text = (el.textContent || '').toLowerCase();
        const cls = (el.className || '').toString().toLowerCase();
        const id = (el.id || '').toLowerCase();
        const href = (el.href || '').toLowerCase();
        const src = (el.src || '').toLowerCase();

        if (text.includes('google') || cls.includes('google') || id.includes('google') ||
            href.includes('google') || src.includes('google') ||
            cls.includes('social') || id.includes('social')) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          results.push({
            tag: el.tagName,
            text: (el.textContent || '').trim().slice(0, 200),
            className: (el.className || '').toString().slice(0, 200),
            id: el.id,
            href: el.href || '',
            src: el.src || '',
            outerHTML: el.outerHTML.slice(0, 500),
            w: Math.round(rect.width), h: Math.round(rect.height),
          });
        }
      }
      return results;
    });

    if (googleEls.length) {
      for (const g of googleEls) {
        console.log(`\n  <${g.tag}> "${g.text.slice(0, 80)}"`);
        console.log(`    class: ${g.className.slice(0, 100)}`);
        if (g.href) console.log(`    href: ${g.href.slice(0, 150)}`);
        if (g.src) console.log(`    src: ${g.src.slice(0, 150)}`);
        console.log(`    HTML: ${g.outerHTML.slice(0, 300)}`);
      }
    } else {
      console.log('  None found on this page.');
    }

    // Check iframes (SSO often uses iframes)
    const iframes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map(f => ({
        src: f.src, id: f.id, w: f.offsetWidth, h: f.offsetHeight,
      }));
    });
    if (iframes.length) {
      console.log('\n=== Iframes ===');
      for (const f of iframes) console.log(`  <iframe src="${f.src}" id="${f.id}" ${f.w}x${f.h}>`);
    }

    console.log('\n=== Waiting 60s — interact with login page, watch console ===');
    console.log('  (This lets you see what happens when you click Google)');

    // Monitor navigation
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        console.log(`  [NAV] ${frame.url().slice(0, 150)}`);
      }
    });

    await page.waitForTimeout(60000);

    console.log(`\nFinal URL: ${page.url()}`);
    await page.screenshot({ path: path.join(__dirname, 'data', 'login-step2.png'), fullPage: true });
    console.log('Screenshot: data/login-step2.png');

    console.log('\n=== DONE ===');
  } finally {
    await page.close();
    await ctx.close();
  }
})();
