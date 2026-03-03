#!/usr/bin/env node
/**
 * Network monitor: discover the API endpoint(s) that return assignment data.
 *
 * Launches browser with persistent profile, navigates to the assignments page,
 * captures all XHR/fetch during page load, and dumps JSON responses with field names.
 *
 * ⚠️  Stop the server first! Only one process can use the browser profile.
 *    node probe-assignments.js
 */
'use strict';
const { chromium } = require('playwright');

const PROFILE = (process.env.BROWSER_PROFILE_PATH || '~/.friendsschool-profile').replace(/^~/, process.env.HOME);
const BASE = 'https://friendsbalt.myschoolapp.com';
const MAE = '6429913';

function needsAuth(url) {
  return url.includes('#login') || url.includes('/signin') ||
    url.includes('accounts.google.com') || url.includes('blackbaud.com/signin') ||
    url.includes('blackbaud.com/errors') || !url.includes('myschoolapp.com');
}

(async () => {
  console.log('Launching visible browser...');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();

  // --- Capture ALL network responses ---
  const allResponses = [];
  page.on('response', async resp => {
    const req = resp.request();
    const type = req.resourceType();
    if (type === 'xhr' || type === 'fetch') {
      let body = '';
      try { body = await resp.text(); } catch {}
      allResponses.push({
        url: resp.url(),
        method: req.method(),
        status: resp.status(),
        bodyLen: body.length,
        body,
        timing: Date.now(),
        phase: 'unknown',
      });
    }
  });

  try {
    // --- Auth check ---
    await page.goto(`${BASE}/app`, { waitUntil: 'commit', timeout: 30000 });
    if (needsAuth(page.url())) {
      console.log('Session expired — please log in via the browser window...');
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        if (!needsAuth(page.url())) break;
        console.log(`  waiting... ${page.url().slice(0, 80)}`);
      }
      if (needsAuth(page.url())) { console.error('Login timed out.'); process.exit(1); }
      console.log('Logged in!');
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.log('Session active.');
    }

    // Mark pre-navigation responses
    allResponses.forEach(r => r.phase = 'pre-nav');

    // --- Navigate to assignments page ---
    const url = `${BASE}/lms-assignment/assignment-center/parent/${MAE}`;
    console.log(`\nNavigating to assignments: ${url}`);
    const navStart = Date.now();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    console.log(`Landed: ${page.url()}`);

    // Wait for content to load
    console.log('Waiting 5s for content render...');
    await page.waitForTimeout(5000);

    // Tag page-load responses
    allResponses.forEach(r => {
      if (r.phase === 'unknown' && r.timing >= navStart) r.phase = 'page-load';
    });

    // --- Show all XHR/fetch from page load ---
    const pageLoadXhrs = allResponses.filter(r => r.phase === 'page-load');
    console.log(`\n=== ${pageLoadXhrs.length} XHR/fetch during page load ===`);
    for (const x of pageLoadXhrs) {
      console.log(`  ${x.method} ${x.status} ${x.url.slice(0, 200)} (${x.bodyLen} bytes)`);
    }

    // --- Dump JSON responses with field names ---
    console.log('\n=== JSON responses with structure ===');
    for (const x of pageLoadXhrs) {
      if (!x.body || x.bodyLen === 0) continue;
      try {
        const parsed = JSON.parse(x.body);

        if (Array.isArray(parsed)) {
          console.log(`\n  ${x.method} ${x.url.slice(0, 200)}`);
          console.log(`    → Array of ${parsed.length} items`);
          if (parsed.length > 0 && typeof parsed[0] === 'object') {
            console.log(`    → Keys: ${Object.keys(parsed[0]).join(', ')}`);
            console.log(`    → First item: ${JSON.stringify(parsed[0]).slice(0, 800)}`);
            if (parsed.length > 1) {
              console.log(`    → Second item: ${JSON.stringify(parsed[1]).slice(0, 800)}`);
            }
          }
        } else if (parsed && typeof parsed === 'object') {
          const keys = Object.keys(parsed);
          console.log(`\n  ${x.method} ${x.url.slice(0, 200)}`);
          console.log(`    → Object with keys: ${keys.join(', ')}`);

          // Check for nested arrays that might contain assignment data
          for (const k of keys) {
            if (Array.isArray(parsed[k]) && parsed[k].length > 0) {
              const first = parsed[k][0];
              if (typeof first === 'object') {
                console.log(`    → .${k}: Array of ${parsed[k].length} items`);
                console.log(`      Keys: ${Object.keys(first).join(', ')}`);
                console.log(`      First: ${JSON.stringify(first).slice(0, 800)}`);
              } else {
                console.log(`    → .${k}: Array of ${parsed[k].length} primitives: [${parsed[k].slice(0, 5).join(', ')}...]`);
              }
            }
          }

          // Show full body for small objects (likely config/status)
          if (keys.length < 20 && x.bodyLen < 2000) {
            console.log(`    → Full: ${x.body.slice(0, 1500)}`);
          }
        }
      } catch {} // not JSON
    }

    // --- Look for assignment-specific API URLs ---
    console.log('\n=== URLs containing assignment/lms keywords ===');
    for (const x of pageLoadXhrs) {
      const lower = x.url.toLowerCase();
      if (lower.includes('assignment') || lower.includes('lms') ||
          lower.includes('task') || lower.includes('homework') ||
          lower.includes('graded') || lower.includes('score') ||
          lower.includes('student') || lower.includes('section')) {
        console.log(`  ${x.method} ${x.status} ${x.url}`);
        console.log(`    Body (first 500): ${x.body.slice(0, 500)}`);
      }
    }

    // --- Wait for user to interact, capture more API calls ---
    console.log('\n=== Waiting 30s for user interaction (click filters, etc.) ===');
    console.log('  Interact with the page to trigger more API calls...');
    const interactStart = Date.now();
    await page.waitForTimeout(30000);

    // Tag interaction responses
    allResponses.forEach(r => {
      if (r.phase === 'unknown' && r.timing >= interactStart) r.phase = 'interaction';
    });

    const interactionXhrs = allResponses.filter(r => r.phase === 'interaction');
    if (interactionXhrs.length) {
      console.log(`\n=== ${interactionXhrs.length} XHR/fetch during interaction ===`);
      for (const x of interactionXhrs) {
        console.log(`\n  ${x.method} ${x.status} ${x.url.slice(0, 200)} (${x.bodyLen} bytes)`);
        try {
          const parsed = JSON.parse(x.body);
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
            console.log(`    → Array of ${parsed.length}, keys: ${Object.keys(parsed[0]).join(', ')}`);
            console.log(`    → First: ${JSON.stringify(parsed[0]).slice(0, 800)}`);
          } else if (parsed && typeof parsed === 'object') {
            console.log(`    → Keys: ${Object.keys(parsed).join(', ')}`);
            console.log(`    → Body: ${x.body.slice(0, 800)}`);
          }
        } catch {
          console.log(`    → Body: ${x.body.slice(0, 500)}`);
        }
      }
    } else {
      console.log('\n=== No XHR/fetch during interaction ===');
    }

    // --- Summary ---
    console.log('\n\n=== SUMMARY: All unique API URLs ===');
    const seen = new Set();
    for (const x of allResponses) {
      // Normalize URL (remove query params for grouping)
      const base = x.url.split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base);
      console.log(`  ${x.method} ${x.status} ${base}`);
    }

    console.log('\n=== DONE ===');

  } finally {
    await page.close();
    await ctx.close();
  }
})();
