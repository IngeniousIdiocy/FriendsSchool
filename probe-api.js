#!/usr/bin/env node
/**
 * Quick probe: call the ScheduleList API directly and show items with teacher/room data.
 * Stop the server first! node probe-api.js
 */
'use strict';
const { chromium } = require('playwright');

const PROFILE = (process.env.BROWSER_PROFILE_PATH || '~/.friendsschool-profile').replace(/^~/, process.env.HOME);
const BASE = 'https://friendsbalt.myschoolapp.com';
const MAE = '6429913';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();

  try {
    // Navigate to schedule page to establish session
    const calUrl = `${BASE}/sis-scheduling/user-calendar/${MAE}`;
    console.log(`Navigating to ${calUrl}...`);
    await page.goto(calUrl, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`Landed: ${page.url()}`);

    if (page.url().endsWith('/sis-scheduling/') || page.url().endsWith('/sis-scheduling')) {
      console.error('Calendar did not load — session expired. Re-auth needed.');
      process.exit(1);
    }

    // Calculate date range for current month (generous: 1st of month to end + 7 days)
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 7);
    const startUnix = Math.floor(start.getTime() / 1000);
    const endUnix = Math.floor(end.getTime() / 1000);

    const apiUrl = `/api/datadirect/ScheduleList?viewerId=${MAE}&personaId=null&viewerPersonaId=null&start=${startUnix}&end=${endUnix}`;
    console.log(`\nCalling API: ${apiUrl}`);

    const data = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      return resp.json();
    }, apiUrl);

    if (data.error) {
      console.error('API error:', data.error);
      process.exit(1);
    }

    console.log(`\nGot ${data.length} schedule items total.`);

    // Show items that have teacher/room data
    const withDetails = data.filter(item => item.facultyName || item.roomName);
    console.log(`${withDetails.length} items have teacher/room data.\n`);

    // Show first 15 unique classes
    const seen = new Set();
    let count = 0;
    for (const item of withDetails) {
      const key = item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      count++;
      if (count > 15) break;
      console.log(`  ${item.title}`);
      console.log(`    Time: ${item.start} → ${item.end}`);
      console.log(`    Teacher: ${item.facultyName}`);
      console.log(`    Building: ${item.buildingName}`);
      console.log(`    Room: ${item.roomName} (#${item.roomNumber})`);
      console.log(`    SectionId: ${item.SectionId}`);
      console.log();
    }

    // Show all-day items too
    const allDay = data.filter(item => item.allDay);
    console.log(`\n${allDay.length} all-day items (first 5):`);
    const seenAllDay = new Set();
    for (const item of allDay) {
      if (seenAllDay.has(item.title)) continue;
      seenAllDay.add(item.title);
      if (seenAllDay.size > 5) break;
      console.log(`  ${item.title}`);
    }

    // Show raw JSON for one item
    console.log('\n=== Sample raw JSON (first class with details) ===');
    console.log(JSON.stringify(withDetails[0], null, 2));

  } finally {
    await page.close();
    await ctx.close();
  }
})();
