#!/usr/bin/env node
/**
 * Targeted probe: test assignment API endpoints using cookies + Node.js fetch.
 *
 * ⚠️  Stop the server first!
 *    node probe-assignments-fetch.js
 */
'use strict';
const { chromium } = require('playwright');

const PROFILE = (process.env.BROWSER_PROFILE_PATH || '~/.friendsschool-profile').replace(/^~/, process.env.HOME);
const BASE = 'https://friendsbalt.myschoolapp.com';
const MAE = '6429913';

async function tryFetch(cookie, label, url) {
  console.log(`\n--- ${label} ---`);
  console.log(`  URL: ${url}`);
  try {
    const resp = await fetch(url, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    console.log(`  Status: ${resp.status}`);
    const text = await resp.text();
    if (resp.status >= 300) {
      console.log(`  Body: ${text.slice(0, 300)}`);
      return null;
    }
    console.log(`  Body length: ${text.length}`);
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        console.log(`  → Array of ${data.length} items`);
        if (data.length > 0 && typeof data[0] === 'object') {
          console.log(`  → Keys: ${Object.keys(data[0]).join(', ')}`);
          console.log(`  → First item: ${JSON.stringify(data[0]).slice(0, 1200)}`);
          if (data.length > 1) console.log(`  → Second item: ${JSON.stringify(data[1]).slice(0, 1200)}`);
          if (data.length > 2) console.log(`  → (${data.length - 2} more items...)`);
        }
      } else if (data && typeof data === 'object') {
        const keys = Object.keys(data);
        console.log(`  → Object with ${keys.length} keys: ${keys.join(', ')}`);
        for (const k of keys) {
          const v = data[k];
          if (Array.isArray(v)) {
            console.log(`    .${k}: Array of ${v.length}`);
            if (v.length > 0 && typeof v[0] === 'object') {
              console.log(`      Keys: ${Object.keys(v[0]).join(', ')}`);
              console.log(`      First: ${JSON.stringify(v[0]).slice(0, 1200)}`);
            }
          } else {
            console.log(`    .${k}: ${JSON.stringify(v).slice(0, 300)}`);
          }
        }
      }
      return data;
    } catch {
      console.log(`  → Not JSON. First 500 chars: ${text.slice(0, 500)}`);
      return null;
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    return null;
  }
}

(async () => {
  console.log('Launching HEADED browser with persistent profile...');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();

  try {
    console.log('Navigating to app...');
    await page.goto(`${BASE}/app`, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check auth via API call from browser context
    const authed = await page.evaluate(async (base) => {
      try {
        const resp = await fetch(`${base}/api/webapp/userstatus`);
        return resp.ok;
      } catch { return false; }
    }, BASE);

    if (!authed) {
      console.log('Session not active. Please log in via the browser window (up to 5 min)...');
      const deadline = Date.now() + 300000;
      let loggedIn = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const check = await page.evaluate(async (base) => {
            try { return (await fetch(`${base}/api/webapp/userstatus`)).ok; }
            catch { return false; }
          }, BASE);
          if (check) { loggedIn = true; break; }
        } catch {
          // Page navigated during login — context destroyed, keep waiting
        }
        console.log('  still waiting for login...');
      }
      if (!loggedIn) { console.error('Login timed out.'); process.exit(1); }
      console.log('Logged in!');
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.log('Session active.');
    }

    await page.close();

    // Extract cookies
    const cookies = await ctx.cookies(BASE);
    const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`Got ${cookies.length} cookies`);

    // Sanity check with known-working schedule API
    const now = new Date();
    const s = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const e = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000);
    const schedResult = await tryFetch(cookie, 'SANITY: ScheduleList (cookies only)',
      `${BASE}/api/datadirect/ScheduleList?viewerId=${MAE}&personaId=null&viewerPersonaId=null&start=${s}&end=${e}`);
    if (schedResult) console.log('\n✅ Cookies work!\n');
    else console.log('\n⚠️ Schedule API failed but continuing anyway...\n');

    // Test assignment endpoints
    await tryFetch(cookie, 'ParentStudentAssignmentCenterGet (no params)',
      `${BASE}/api/assignment2/ParentStudentAssignmentCenterGet`);

    await tryFetch(cookie, 'ParentStudentAssignmentCenterGet (studentId=MAE)',
      `${BASE}/api/assignment2/ParentStudentAssignmentCenterGet?studentId=${MAE}`);

    await tryFetch(cookie, 'ParentStudentAssignmentCenterGet (StudentUserId=MAE)',
      `${BASE}/api/assignment2/ParentStudentAssignmentCenterGet?StudentUserId=${MAE}`);

    await tryFetch(cookie, 'UserAssignmentDetailsGetAllStudentData (no params)',
      `${BASE}/api/assignment2/UserAssignmentDetailsGetAllStudentData`);

    await tryFetch(cookie, 'UserAssignmentDetailsGetAllStudentData (studentId=MAE)',
      `${BASE}/api/assignment2/UserAssignmentDetailsGetAllStudentData?studentId=${MAE}`);

    await tryFetch(cookie, 'StudentAssignmentCenterSettingsGet',
      `${BASE}/api/AssignmentCenter/StudentAssignmentCenterSettingsGet/`);

    await tryFetch(cookie, 'AssignmentCenterOptionsGetSpa',
      `${BASE}/api/AssignmentCenter/AssignmentCenterOptionsGetSpa/`);

    console.log('\n=== DONE ===');
  } finally {
    try { await page.close(); } catch {}
    await ctx.close();
  }
})();
