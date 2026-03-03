#!/usr/bin/env node
/**
 * Probe the Blackbaud calendar page to find room/teacher data.
 *
 * ⚠️  Stop the server first! Only one process can use the browser profile.
 *    node probe-dom.js
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

function calendarDidNotLoad(url) {
  // sis-scheduling redirects to /sis-scheduling/ when its session expires
  return url.endsWith('/sis-scheduling/') || url.endsWith('/sis-scheduling');
}

(async () => {
  console.log('Launching visible browser...');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();

  // --- Capture ALL network responses from the start ---
  const allResponses = [];
  page.on('response', async resp => {
    const req = resp.request();
    const type = req.resourceType();
    if (type === 'xhr' || type === 'fetch') {
      let body = '';
      try { body = await resp.text(); } catch {}
      allResponses.push({
        url: resp.url(),
        status: resp.status(),
        bodyLen: body.length,
        body,
        timing: Date.now(),
        phase: 'unknown', // will be tagged later
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

    // --- Navigate to schedule ---
    const url = `${BASE}/sis-scheduling/user-calendar/${MAE}`;
    console.log(`\nNavigating to schedule: ${url}`);
    const navStart = Date.now();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`Landed: ${page.url()}`);

    if (needsAuth(page.url()) || calendarDidNotLoad(page.url())) {
      console.log('Schedule page needs auth — please log in via the browser window...');
      console.log('Navigate to: ' + url);
      console.log('(The browser window should be visible. Log in, then navigate to the calendar URL above.)');
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const cur = page.url();
        console.log(`  waiting... ${cur.slice(0, 80)}`);
        // Success: landed on the calendar page with the student ID in the URL
        if (cur.includes('user-calendar') || (cur.includes('sis-scheduling') && !calendarDidNotLoad(cur))) break;
      }
      const finalUrl = page.url();
      if (!finalUrl.includes('user-calendar') && calendarDidNotLoad(finalUrl)) {
        console.error('Could not load calendar. Trying direct navigation after auth...');
      }
      console.log('Re-navigating to calendar...');
      await new Promise(r => setTimeout(r, 2000));
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      console.log(`After re-nav: ${page.url()}`);
      if (calendarDidNotLoad(page.url())) {
        console.error('Calendar still not loading. The sis-scheduling session may need manual re-auth.');
        console.log('Try navigating to ' + url + ' in the browser window manually...');
        const deadline2 = Date.now() + 120000;
        while (Date.now() < deadline2) {
          await new Promise(r => setTimeout(r, 3000));
          const cur = page.url();
          console.log(`  waiting... ${cur.slice(0, 80)}`);
          if (cur.includes('user-calendar')) break;
        }
      }
      console.log('Waiting 5s for calendar render...');
      await page.waitForTimeout(5000);
    }

    console.log('Waiting 5s for calendar render...');
    await page.waitForTimeout(5000);

    // Tag page-load responses
    allResponses.forEach(r => {
      if (r.phase === 'unknown' && r.timing >= navStart) r.phase = 'page-load';
    });

    // --- 1. Show all XHR/fetch from page load ---
    const pageLoadXhrs = allResponses.filter(r => r.phase === 'page-load');
    console.log(`\n=== ${pageLoadXhrs.length} XHR/fetch during page load ===`);
    for (const x of pageLoadXhrs) {
      console.log(`  ${x.status} ${x.url.slice(0, 150)} (${x.bodyLen} bytes)`);
      // Show first part of responses that might contain schedule data
      if (x.body.length > 0 && x.body.length < 50000 &&
          (x.url.includes('calendar') || x.url.includes('schedule') || x.url.includes('event') ||
           x.url.includes('section') || x.url.includes('class'))) {
        console.log(`    BODY PREVIEW: ${x.body.slice(0, 500)}`);
      }
    }

    // --- 2. Check for iframes ---
    console.log('\n=== Iframe check ===');
    const iframes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map(f => ({
        src: f.src, id: f.id, name: f.name,
        w: f.offsetWidth, h: f.offsetHeight,
        visible: f.offsetParent !== null,
      }));
    });
    if (iframes.length) {
      for (const f of iframes) console.log(`  <iframe src="${f.src}" id="${f.id}" ${f.w}x${f.h} visible=${f.visible}>`);
    } else {
      console.log('  No iframes found.');
    }

    // --- 3. Find calendar event elements (more thorough) ---
    console.log('\n=== Calendar event elements ===');
    const events = await page.evaluate(() => {
      const out = [];
      // Look for elements that contain time patterns like "2:05 PM"
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        // Only leaf-ish elements (not huge containers)
        if (el.children.length > 10) continue;
        const text = el.textContent?.trim();
        if (!text || text.length > 500) continue;
        if (!/\d{1,2}:\d{2}\s*[AP]M/i.test(text)) continue;

        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;

        // Gather ALL attributes
        const attrs = {};
        for (const a of el.attributes || []) {
          attrs[a.name] = a.value.slice(0, 200);
        }

        // Check parent attributes too
        const parentAttrs = {};
        if (el.parentElement) {
          for (const a of el.parentElement.attributes || []) {
            parentAttrs[a.name] = a.value.slice(0, 200);
          }
        }

        out.push({
          tag: el.tagName,
          text: text.slice(0, 200),
          attrs,
          parentTag: el.parentElement?.tagName,
          parentAttrs,
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          outerHTML: el.outerHTML.slice(0, 500),
        });
      }
      return out;
    });
    console.log(`Found ${events.length} event elements`);
    for (const e of events.slice(0, 8)) {
      console.log(`\n  ${e.tag} "${e.text.slice(0, 80)}" [${e.w}x${e.h} @ ${e.x},${e.y}]`);
      console.log(`    attrs: ${JSON.stringify(e.attrs)}`);
      console.log(`    parent <${e.parentTag}> attrs: ${JSON.stringify(e.parentAttrs)}`);
      console.log(`    outerHTML: ${e.outerHTML.slice(0, 300)}`);
    }

    // --- 4. Search for data attributes on ALL elements that might store event IDs ---
    console.log('\n=== Data attributes with IDs/references ===');
    const dataAttrs = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[data-event-id], [data-id], [data-section-id], [data-class-id], [data-meeting-id], [data-schedule-id]')) {
        const attrs = {};
        for (const a of el.attributes) {
          if (a.name.startsWith('data-')) attrs[a.name] = a.value;
        }
        out.push({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 100), attrs });
      }
      return out;
    });
    if (dataAttrs.length) {
      for (const d of dataAttrs.slice(0, 10)) console.log(`  <${d.tag}> "${d.text.slice(0, 60)}" ${JSON.stringify(d.attrs)}`);
    } else {
      console.log('  No data-event-id/data-id/data-section-id elements found.');
    }

    // --- 5. Search the full DOM for known keywords before click ---
    console.log('\n=== Full DOM keyword search (BEFORE click) ===');
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const keywords = ['teacher', 'instructor', 'room', 'location', 'RoomName', 'TeacherName',
                       'SectionInfo', 'MeetingDetail', 'EventDetail', 'LeadSection',
                       'SectionId', 'BlockName', 'courseName', 'sectionName',
                       'Middle School', 'flyout', 'popover', 'overlay', 'modal',
                       'cdk-overlay', 'sky-overlay', 'sky-flyout'];
    for (const kw of keywords) {
      const re = new RegExp(kw, 'gi');
      const matches = html.match(re) || [];
      if (matches.length > 0) console.log(`  "${kw}": ${matches.length} occurrences`);
    }

    // --- 6. Look for Angular/framework data stores ---
    console.log('\n=== Framework data stores ===');
    const frameworkData = await page.evaluate(() => {
      const out = {};
      // AngularJS
      if (window.angular) {
        out.angularJS = true;
        try {
          const scope = angular.element(document.querySelector('[ng-app]')).scope();
          out.rootScopeKeys = Object.keys(scope || {}).filter(k => !k.startsWith('$')).slice(0, 20);
        } catch (e) { out.angularJSError = e.message; }
      }
      // Angular 2+ (check for ng.probe or ng.getComponent)
      if (window.ng) {
        out.angular2 = true;
        out.ngKeys = Object.keys(window.ng);
      }
      // React
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) out.react = true;
      // Check for any global state stores
      for (const k of ['__store__', '__STORE__', 'store', '__NEXT_DATA__', '__INITIAL_STATE__']) {
        if (window[k]) out[k] = typeof window[k];
      }
      return out;
    });
    console.log(`  ${JSON.stringify(frameworkData, null, 2)}`);

    // --- 7. Pick an event and click it ---
    const pick = events.find(e => e.text.includes('French')) ||
                 events.find(e => e.text.includes('Science')) ||
                 events.find(e => e.text.includes('Math')) ||
                 events[0];
    if (!pick) {
      console.log('\nNo events to click. Done.');
      return;
    }

    // Mark all current responses as pre-click
    const clickStart = Date.now();

    console.log(`\n=== Clicking: "${pick.text.slice(0, 80)}" at (${pick.x + pick.w/2}, ${pick.y + pick.h/2}) ===`);
    await page.mouse.click(pick.x + pick.w / 2, pick.y + pick.h / 2);
    await page.waitForTimeout(4000);

    // Tag post-click responses
    allResponses.forEach(r => {
      if (r.phase === 'unknown' && r.timing >= clickStart) r.phase = 'post-click';
    });

    // --- 8. Network requests from click ---
    const clickXhrs = allResponses.filter(r => r.phase === 'post-click');
    if (clickXhrs.length) {
      console.log(`\n=== ${clickXhrs.length} XHR/fetch from click ===`);
      for (const x of clickXhrs) {
        console.log(`  ${x.status} ${x.url.slice(0, 150)} (${x.bodyLen} bytes)`);
        console.log(`    BODY: ${x.body.slice(0, 1000)}`);
      }
    } else {
      console.log('\n=== No XHR/fetch from click ===');
    }

    // --- 9. Search for overlay/popover/flyout containers after click ---
    console.log('\n=== Overlay/popover/flyout after click ===');
    const overlays = await page.evaluate(() => {
      const selectors = [
        '.popover', '.popup', '.flyout', '.tooltip', '.modal',
        '[role="dialog"]', '[role="tooltip"]',
        '.sky-popover', '.bb-popover', '.event-detail',
        '.sky-flyout', '.sky-modal', '.sky-overlay',
        '.cdk-overlay-container', '.cdk-overlay-pane',
        '.sky-overlay-content', '.sky-flyout-content',
        '.mat-dialog-container', '.mat-menu-panel',
        // Blackbaud-specific
        '.bb-dialog', '.bb-modal', '.bb-flyout',
        '.calendarEvent-flyout', '.event-flyout',
        '.schedule-detail', '.meeting-detail',
        // Generic overlay patterns
        '[class*="overlay"]', '[class*="flyout"]', '[class*="popover"]',
        '[class*="popup"]', '[class*="detail"]', '[class*="modal"]',
      ];
      const results = [];
      const seen = new Set();
      for (const sel of selectors) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (seen.has(el)) continue;
            seen.add(el);
            const text = el.textContent?.trim();
            if (text && text.length > 5) {
              results.push({
                sel,
                tag: el.tagName,
                className: (el.className || '').toString().slice(0, 200),
                text: text.slice(0, 600),
                innerHTML: el.innerHTML.slice(0, 800),
                visible: el.offsetParent !== null || getComputedStyle(el).display !== 'none',
                rect: el.getBoundingClientRect(),
              });
            }
          }
        } catch {}
      }
      return results;
    });
    if (overlays.length) {
      for (const o of overlays) {
        console.log(`\n  ${o.sel} <${o.tag}> class="${o.className.slice(0, 100)}" visible=${o.visible}`);
        console.log(`    text: ${o.text.slice(0, 300)}`);
        console.log(`    innerHTML: ${o.innerHTML.slice(0, 500)}`);
      }
    } else {
      console.log('  None found.');
    }

    // --- 10. Full DOM keyword search AFTER click ---
    console.log('\n=== Full DOM keyword search (AFTER click) ===');
    const html2 = await page.evaluate(() => document.documentElement.outerHTML);
    for (const kw of keywords) {
      const re = new RegExp(kw, 'gi');
      const before = (html.match(re) || []).length;
      const after = (html2.match(re) || []).length;
      if (after !== before) {
        console.log(`  "${kw}": ${before} → ${after} (+${after - before})`);
      }
    }

    // --- 11. New text content after click (diff) ---
    const text2 = await page.evaluate(() => document.body.innerText);
    const textBefore = await page.evaluate(() => ''); // we need to compare
    console.log(`\n=== innerText after click (${text2.length} chars) ===`);
    // Just show the text that appeared
    console.log(text2.slice(0, 2000));

    // --- 12. Search for any element with room/teacher-like content ---
    console.log('\n=== Elements with room/teacher patterns after click ===');
    const roomTeacher = await page.evaluate(() => {
      const results = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const t = node.textContent.trim();
        if (!t || t.length < 3 || t.length > 500) continue;
        // Look for patterns like "Room", "Middle School", teacher-like names, etc.
        if (/\b(room|teacher|instructor|location|building)\b/i.test(t) ||
            /\b(Middle School|Lower School|Upper School)\b/i.test(t) ||
            /^\d{3}[A-Z]?$/.test(t) || // room numbers like "225" or "225A"
            /^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(t)) { // "First Last" names
          const el = node.parentElement;
          results.push({
            text: t.slice(0, 200),
            tag: el.tagName,
            className: (el.className || '').toString().slice(0, 100),
            visible: el.offsetParent !== null,
            id: el.id,
          });
        }
      }
      return results;
    });
    if (roomTeacher.length) {
      for (const r of roomTeacher.slice(0, 30)) {
        console.log(`  <${r.tag}> id="${r.id}" class="${r.className.slice(0, 60)}" visible=${r.visible}: "${r.text}"`);
      }
    } else {
      console.log('  None found.');
    }

    // --- 13. Dump ALL page-load API responses that contain JSON arrays (likely schedule data) ---
    console.log('\n=== API responses with JSON arrays (likely schedule data) ===');
    for (const x of pageLoadXhrs) {
      try {
        const parsed = JSON.parse(x.body);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log(`\n  ${x.url.slice(0, 150)} — array of ${parsed.length} items`);
          console.log(`    First item keys: ${Object.keys(parsed[0]).join(', ')}`);
          console.log(`    First item: ${JSON.stringify(parsed[0]).slice(0, 500)}`);
          if (parsed.length > 1) console.log(`    Second item: ${JSON.stringify(parsed[1]).slice(0, 500)}`);
        } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const keys = Object.keys(parsed);
          if (keys.length > 0 && keys.length < 50) {
            // Check if any value is an array
            for (const k of keys) {
              if (Array.isArray(parsed[k]) && parsed[k].length > 0 && typeof parsed[k][0] === 'object') {
                console.log(`\n  ${x.url.slice(0, 150)} — .${k} array of ${parsed[k].length}`);
                console.log(`    First item keys: ${Object.keys(parsed[k][0]).join(', ')}`);
                console.log(`    First item: ${JSON.stringify(parsed[k][0]).slice(0, 500)}`);
              }
            }
          }
        }
      } catch {} // not JSON, skip
    }

    console.log('\n\n=== DONE ===');

  } finally {
    await page.close();
    await ctx.close();
  }
})();
