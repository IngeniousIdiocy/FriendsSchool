#!/usr/bin/env node
/**
 * FriendsSchool — NL Query Agent for School Data
 *
 * Scrapes Blackbaud MySchoolApp (assignments + schedules) via Playwright,
 * caches results, and answers natural language queries via Claude.
 *
 * ENV:
 *   ANTHROPIC_API_KEY   (required for /nl)
 *   PORT                (default 3082)
 *   BROWSER_PROFILE_PATH (default ~/.friendsschool-profile)
 *   BROWSER_PROFILE_PATH (default ~/.friendsschool-profile)
 *   LOG_LEVEL           (debug|info|warn|error, default info)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/* -------------------------------- config --------------------------------- */

// Load .env file (simple key=value, no quotes handling needed)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const PORT = Number(process.env.PORT) || 3082;
const PROFILE_PATH = (process.env.BROWSER_PROFILE_PATH || '~/.friendsschool-profile')
  .replace(/^~/, process.env.HOME);
let DATA_DIR = process.env.FRIENDSSCHOOL_DATA_DIR || path.join(__dirname, 'data');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.FRIENDSSCHOOL_MODEL || 'claude-sonnet-4-6';
const MAX_TOOL_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS) || 10;

const BASE_URL = 'https://friendsbalt.myschoolapp.com';

const STUDENTS = {
  mae:   { id: '6429913', name: 'Mae',   grade: '6th', school: 'Middle School' },
  effie: { id: '6429999', name: 'Effie', grade: '4th', school: 'Lower School' },
};

// Cache TTLs in milliseconds
const ASSIGNMENT_TTL = 30 * 60 * 1000;  // 30 minutes
const SCHEDULE_TTL   = 60 * 60 * 1000;  // 60 minutes

// Effie's static weekly schedule (Lower School doesn't use the calendar API)
const EFFIE_SCHEDULE_PATH = path.join(DATA_DIR, 'effie-schedule.csv');
let EFFIE_STATIC_SCHEDULE = null;
try {
  EFFIE_STATIC_SCHEDULE = fs.readFileSync(EFFIE_SCHEDULE_PATH, 'utf8');
} catch {
  // Will be loaded later if DATA_DIR changes (tests)
}

/* -------------------------------- logger --------------------------------- */

function nowIso() { return new Date().toISOString(); }

function createLogger() {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level] ?? order.info;
  function log(lvl, ...args) {
    if ((order[lvl] ?? 20) < threshold) return;
    console.log(`[${nowIso()}] [${lvl.toUpperCase()}]`, ...args);
  }
  return {
    debug: (...a) => log('debug', ...a),
    info:  (...a) => log('info', ...a),
    warn:  (...a) => log('warn', ...a),
    error: (...a) => log('error', ...a),
  };
}

const log = createLogger();

/* ----------------------------- time helpers ------------------------------- */

function timeAgo(isoString) {
  if (!isoString) return 'never';
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}min ago`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / 86400_000)}d ago`;
}

function isFresh(isoString, ttlMs) {
  if (!isoString) return false;
  return (Date.now() - new Date(isoString).getTime()) < ttlMs;
}

/* ----------------------- data persistence + cache ------------------------ */

// In-memory cache: { mae-assignments: { lastUpdated, data }, ... }
const cache = {};

function diskPath(key) {
  return path.join(DATA_DIR, `${key}.json`);
}

function loadFromDisk(key) {
  try {
    const raw = fs.readFileSync(diskPath(key), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveToDisk(key, entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(diskPath(key), JSON.stringify(entry, null, 2));
  } catch (e) {
    log.warn(`Failed to save ${key} to disk:`, e.message);
  }
}

function initCache() {
  for (const child of Object.keys(STUDENTS)) {
    for (const type of ['assignments', 'schedule']) {
      const key = `${child}-${type}`;
      const diskData = loadFromDisk(key);
      if (diskData) {
        cache[key] = diskData;
        log.info(`Loaded ${key} from disk (${timeAgo(diskData.lastUpdated)})`);
      }
    }
  }
}

function getCached(child, type) {
  const key = `${child}-${type}`;
  return cache[key] || null;
}

function setCache(child, type, data) {
  const key = `${child}-${type}`;
  const entry = { lastUpdated: nowIso(), data };
  cache[key] = entry;
  saveToDisk(key, entry);
  return entry;
}

/* ------------------------- playwright browser mgr ------------------------ */

let browserContext = null;
let browserLaunching = false;
let browserHeadless = true; // always headless by default

async function launchBrowser(headless) {
  const { chromium } = require('playwright');
  log.info(`Launching browser (headless=${headless}, profile=${PROFILE_PATH})...`);
  fs.mkdirSync(PROFILE_PATH, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  log.info('Browser launched.');
  return ctx;
}

async function getBrowser() {
  if (browserContext) return browserContext;
  if (browserLaunching) {
    while (browserLaunching) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (browserContext) return browserContext;
  }

  browserLaunching = true;
  try {
    browserContext = await launchBrowser(true);
    browserHeadless = true;
    startKeepAlive();
    return browserContext;
  } catch (e) {
    log.error('Failed to launch browser:', e.message);
    throw e;
  } finally {
    browserLaunching = false;
  }
}

/**
 * Extract cookies from the browser context for use with Node.js fetch().
 * The browser stays alive (for session persistence) but is never navigated.
 */
async function getCookieHeader() {
  const ctx = await getBrowser();
  const cookies = await ctx.cookies(BASE_URL);
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function closeBrowser() {
  stopKeepAlive();
  if (browserContext) {
    try { await browserContext.close(); } catch {}
    browserContext = null;
    log.info('Browser closed.');
  }
}

/* -------------------------- session keep-alive --------------------------- */

let keepAliveTimer = null;
const KEEP_ALIVE_BASE_INTERVAL = 10 * 60 * 1000; // 10 minutes
const KEEP_ALIVE_JITTER = 60 * 1000; // +/- 60 seconds
let keepAliveUseSchedule = false; // alternates between assignments and schedule

function nextKeepAliveDelay() {
  const jitter = Math.round((Math.random() * 2 - 1) * KEEP_ALIVE_JITTER);
  return KEEP_ALIVE_BASE_INTERVAL + jitter;
}

function scheduleNextKeepAlive() {
  const delay = nextKeepAliveDelay();
  keepAliveTimer = setTimeout(runKeepAlive, delay);
  keepAliveTimer.unref();
}

async function runKeepAlive() {
  if (!browserContext) { scheduleNextKeepAlive(); return; }

  const useSchedule = keepAliveUseSchedule;
  keepAliveUseSchedule = !keepAliveUseSchedule;

  let apiUrl, label;
  if (useSchedule) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 7);
    apiUrl = `${BASE_URL}/api/datadirect/ScheduleList?viewerId=${STUDENTS.mae.id}&personaId=null&viewerPersonaId=null&start=${Math.floor(start.getTime() / 1000)}&end=${Math.floor(end.getTime() / 1000)}`;
    label = 'schedule API';
  } else {
    apiUrl = `${BASE_URL}/api/assignment2/ParentStudentAssignmentCenterGet?StudentUserId=${STUDENTS.mae.id}`;
    label = 'assignments API';
  }

  try {
    const cookie = await getCookieHeader();
    const resp = await fetch(apiUrl, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    if (resp.status === 401 || resp.status === 403 || (resp.status >= 300 && resp.status < 400)) {
      log.warn(`[KEEPALIVE] Session expired (HTTP ${resp.status}, ${label}) — attempting auto-relogin...`);
      try {
        await login();
        log.info('[KEEPALIVE] Auto-relogin succeeded');
      } catch (e) {
        log.warn(`[KEEPALIVE] Auto-relogin failed: ${e.message} — hit GET /login manually`);
      }
    } else if (resp.ok) {
      // Cache the response data since we already paid for the API call
      try {
        const data = await resp.json();
        if (useSchedule) {
          if (Array.isArray(data) && data.length > 0) {
            const text = formatScheduleData(data);
            setCache('mae', 'schedule', text);
            log.info(`[KEEPALIVE] Session alive (HTTP ${resp.status}, ${label} verified, mae schedule cached)`);
          } else {
            log.info(`[KEEPALIVE] Session alive (HTTP ${resp.status}, ${label} verified, no schedule data to cache)`);
          }
        } else {
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            const text = formatAssignmentData(data);
            setCache('mae', 'assignments', text);
            log.info(`[KEEPALIVE] Session alive (HTTP ${resp.status}, ${label} verified, mae assignments cached)`);
          } else {
            log.info(`[KEEPALIVE] Session alive (HTTP ${resp.status}, ${label} verified, no assignment data to cache)`);
          }
        }
      } catch (parseErr) {
        log.info(`[KEEPALIVE] Session alive (HTTP ${resp.status}, ${label} verified, cache update skipped: ${parseErr.message})`);
      }
    } else {
      log.warn(`[KEEPALIVE] Unexpected status (HTTP ${resp.status}, ${label}) — session may be degraded`);
    }
  } catch (e) {
    log.warn(`[KEEPALIVE] Ping failed: ${e.message}`);
  }

  scheduleNextKeepAlive();
}

function startKeepAlive() {
  stopKeepAlive();
  keepAliveUseSchedule = false;
  scheduleNextKeepAlive();
  log.info(`[KEEPALIVE] Started (~${KEEP_ALIVE_BASE_INTERVAL / 60000}min ±${KEEP_ALIVE_JITTER / 1000}s, alternating assignments/schedule)`);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/* ------------------------------ login ------------------------------------ */

function isLoginPage(url) {
  return url.includes('/app/login') ||
         url.includes('#login') ||
         url.includes('accounts.google.com') ||
         url.includes('/signin') ||
         url.includes('blackbaud.com/signin');
}

/**
 * Try to click through the Blackbaud SSO login automatically.
 * The browser profile has a saved Google session, so we just need to:
 *   1. Wait for auto-SSO redirects (often completes with zero clicks)
 *   2. If stuck on signin page, click the saved email / "Use Google" button
 * Returns true if login completed, false if manual intervention needed.
 */
async function attemptAutoLogin(page) {
  const buttonSelectors = [
    // Blackbaud "Next" button (submits saved email, triggers SSO)
    '#nextBtn',
    // Google SSO buttons on Blackbaud signin page
    'button:has-text("Google")',
    'a:has-text("Google")',
    'button:has-text("Use Google")',
    'a:has-text("Use Google")',
    'button:has-text("Sign in with Google")',
    'a:has-text("Sign in with Google")',
    // Generic fallbacks
    'button:has-text("Sign in")',
    'button:has-text("Continue")',
  ];

  // Loop: wait for redirects, look for buttons, click, repeat
  // Each iteration waits a bit then checks if done or finds a button to click
  const deadline = Date.now() + 30000; // 30 second timeout for auto-login

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));

    // Check if we're done — verify by extracting cookies and testing with fetch
    try {
      const url = page.url();
      log.info(`[LOGIN] Auto-login check — ${url.slice(0, 100)}`);
      if (url.includes('myschoolapp.com/app') && !isLoginPage(url)) {
        const cookies = await page.context().cookies(BASE_URL);
        const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const testResp = await fetch(`${BASE_URL}/api/assignment2/ParentStudentAssignmentCenterGet?StudentUserId=${STUDENTS.mae.id}`, {
          headers: { Cookie: cookie },
          redirect: 'manual',
        });
        if (testResp.ok) {
          log.info(`[LOGIN] Auto-login succeeded (${cookies.length} cookies, fetch verified)`);
          return true;
        }
        log.info(`[LOGIN] URL looks logged in but fetch got HTTP ${testResp.status}, continuing...`);
      }
    } catch { continue; }

    // Look for a button to click on the current page
    for (const sel of buttonSelectors) {
      try {
        const el = await page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          const text = await el.textContent().catch(() => sel);
          log.info(`[LOGIN] Clicking: "${text.trim().slice(0, 50)}" (${sel})`);
          await el.click();
          // Wait for navigation after click
          await new Promise(r => setTimeout(r, 3000));
          break; // go back to the outer loop to re-check URL and find next button
        }
      } catch { continue; }
    }
  }

  return false;
}

async function login() {
  // Close any existing browser — can't share profile between instances
  await closeBrowser();

  // Launch visible browser for login — this becomes the scraping browser too
  const ctx = await launchBrowser(false);
  const page = await ctx.newPage();
  const loginUrl = `${BASE_URL}/app`;
  log.info(`Opening login page: ${loginUrl}`);

  try {
    await page.goto(loginUrl, { waitUntil: 'commit', timeout: 120000 });
  } catch (e) {
    log.warn(`Initial navigation: ${e.message} — continuing anyway`);
  }

  // Wait for JS redirects to settle before checking anything
  await new Promise(r => setTimeout(r, 3000));
  log.info(`Page loaded, current URL: ${page.url()}`);

  // Verify session by extracting cookies and testing with Node.js fetch
  // (this is the same path our actual data fetching uses)
  let success = false;
  try {
    const cookies = await ctx.cookies(BASE_URL);
    const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    log.info(`[LOGIN] Got ${cookies.length} cookies, testing with fetch...`);
    const testResp = await fetch(`${BASE_URL}/api/assignment2/ParentStudentAssignmentCenterGet?StudentUserId=${STUDENTS.mae.id}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    if (testResp.ok) {
      log.info('[LOGIN] Session already valid (verified with fetch)!');
      success = true;
    } else {
      log.info(`[LOGIN] Session not valid (HTTP ${testResp.status}), need to login`);
    }
  } catch (e) {
    log.info(`[LOGIN] Session check failed: ${e.message}`);
  }

  // Try auto-login (SSO redirects + button clicks)
  if (!success) {
    success = await attemptAutoLogin(page);
  }

  // Fall back to manual login
  if (!success) {
    log.info('Auto-login failed — please log in via the browser window (up to 5 minutes)...');
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const cookies = await ctx.cookies(BASE_URL);
        const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const testResp = await fetch(`${BASE_URL}/api/assignment2/ParentStudentAssignmentCenterGet?StudentUserId=${STUDENTS.mae.id}`, {
          headers: { Cookie: cookie },
          redirect: 'manual',
        });
        if (testResp.ok) { success = true; break; }
      } catch { continue; }
    }
  }

  if (!success) {
    try { await page.close(); } catch {}
    try { await ctx.close(); } catch {}
    throw new Error('Login timed out — please try again');
  }

  log.info('Login successful!');
  await new Promise(r => setTimeout(r, 2000));

  // Minimize the browser window — since we no longer navigate any pages
  // after login (all data fetching uses Node.js fetch), it won't pop back up
  try {
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
  } catch (e) {
    log.warn(`Could not minimize browser: ${e.message}`);
  }

  // Close the login tab — browser process stays alive offscreen
  try { await page.close(); } catch {}

  // Keep this browser context for scraping — don't close and relaunch
  browserContext = ctx;
  browserHeadless = false;
  startKeepAlive();
  log.info('Login complete. Browser moved offscreen (session preserved).');
  return { success: true };
}

/* ------------------------------ scrapers --------------------------------- */

async function scrapeAssignments(studentId) {
  log.info(`Scraping assignments for student ${studentId} via API`);
  const cookie = await getCookieHeader();

  const apiUrl = `${BASE_URL}/api/assignment2/ParentStudentAssignmentCenterGet?StudentUserId=${studentId}`;
  log.info(`Calling ParentStudentAssignmentCenterGet API`);
  const resp = await fetch(apiUrl, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });

  if (resp.status === 401 || resp.status === 403 || (resp.status >= 300 && resp.status < 400)) {
    throw new Error('Session expired — hit GET /login to re-authenticate');
  }
  if (!resp.ok) {
    throw new Error(`Assignment API failed: HTTP ${resp.status}`);
  }

  const data = await resp.json();

  if (!data || typeof data !== 'object') {
    throw new Error('Session expired — hit GET /login to re-authenticate');
  }

  return formatAssignmentData(data);
}

function formatAssignmentData(data) {
  // Relevant time buckets in display order
  const buckets = [
    ['Missing', data.Missing],
    ['Overdue', data.Overdue],
    ['Due Today', data.DueToday],
    ['Due Tomorrow', data.DueTomorrow],
    ['Due This Week', data.DueThisWeek],
    ['Due Next Week', data.DueNextWeek],
    ['Due After Next Week', data.DueAfterNextWeek],
    ['Past (Last Week)', data.PastLastWeek],
  ];

  const lines = [];

  for (const [label, items] of buckets) {
    if (!items || items.length === 0) continue;
    lines.push(`\n${label} (${items.length}):`);

    for (const a of items) {
      const name = (a.ShortDescription || 'Untitled')
        .replace(/&#160;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
      const cls = a.GroupName || 'Unknown Class';
      const type = a.AssignmentType || '';
      const pts = a.MaxPoints ? `${a.MaxPoints} pts` : '';
      const graded = a.HasGrade ? 'Graded' : '';

      // Parse due date
      let due = '';
      if (a.DateDue) {
        const d = new Date(a.DateDue);
        due = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      }

      // Status flags
      const flags = [];
      if (a.MissingInd) flags.push('MISSING');
      if (a.LateInd) flags.push('LATE');
      if (a.IncompleteInd) flags.push('INCOMPLETE');
      if (a.ExemptInd) flags.push('EXEMPT');
      if (graded) flags.push('Graded');

      let detail = `  - ${name} | ${cls}`;
      if (type) detail += ` | ${type}`;
      if (pts) detail += ` | ${pts}`;
      if (due) detail += ` | Due: ${due}`;
      if (flags.length) detail += ` | ${flags.join(', ')}`;
      lines.push(detail);
    }
  }

  // Section summary
  if (data.Sections && data.Sections.length > 0) {
    lines.push(`\nClasses (${data.Sections.length}):`);
    for (const s of data.Sections) {
      lines.push(`  - ${s.GroupName}`);
    }
  }

  const totalActive = (data.DueToday?.length || 0) + (data.DueTomorrow?.length || 0) +
    (data.DueThisWeek?.length || 0) + (data.DueNextWeek?.length || 0) +
    (data.DueAfterNextWeek?.length || 0) + (data.Missing?.length || 0) +
    (data.Overdue?.length || 0);
  lines.unshift(`Active assignments: ${totalActive}`);

  return lines.join('\n');
}

async function scrapeSchedule(studentId) {
  log.info(`Scraping schedule for student ${studentId} via API`);
  const cookie = await getCookieHeader();

  // Call the ScheduleList API directly to get structured data with teacher/room info
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 7);
  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000);
  const apiUrl = `${BASE_URL}/api/datadirect/ScheduleList?viewerId=${studentId}&personaId=null&viewerPersonaId=null&start=${startUnix}&end=${endUnix}`;

  log.info(`Calling ScheduleList API`);
  const resp = await fetch(apiUrl, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });

  if (resp.status === 401 || resp.status === 403 || (resp.status >= 300 && resp.status < 400)) {
    throw new Error('Session expired — hit GET /login to re-authenticate');
  }
  if (!resp.ok) {
    throw new Error(`ScheduleList API failed: HTTP ${resp.status}`);
  }

  const data = await resp.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Session expired — hit GET /login to re-authenticate');
  }

  log.info(`ScheduleList returned ${data.length} items`);

  // Format structured data into readable text with teacher/room details
  return formatScheduleData(data);
}

function formatScheduleData(items) {
  // Group events by date
  const byDate = {};
  for (const item of items) {
    // Parse date from "3/2/2026 8:00 AM" format
    const dateKey = item.start.split(' ')[0]; // "3/2/2026"
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(item);
  }

  const lines = [];
  const sortedDates = Object.keys(byDate).sort((a, b) => new Date(a) - new Date(b));

  for (const dateKey of sortedDates) {
    const events = byDate[dateKey];
    const dateObj = new Date(dateKey);
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    lines.push(`\n${dayName}`);

    // Sort by start time
    events.sort((a, b) => a.startTicks - b.startTicks);

    for (const ev of events) {
      if (ev.allDay) {
        lines.push(`  All day: ${ev.title}`);
        continue;
      }

      // Extract times from "3/2/2026 8:00 AM" → "8:00 AM"
      const startTime = ev.start.replace(/^\S+\s+/, '');
      const endTime = ev.end.replace(/^\S+\s+/, '');

      let detail = `  ${startTime} - ${endTime}: ${ev.title}`;
      if (ev.facultyName) detail += ` | Teacher: ${ev.facultyName}`;
      if (ev.buildingName || ev.roomNumber) {
        const room = [ev.buildingName, ev.roomNumber].filter(Boolean).join(' ');
        detail += ` | Room: ${room}`;
      }
      lines.push(detail);
    }
  }

  return lines.join('\n');
}

/* ----------------------- auto-relogin helper ----------------------------- */

let reloginInProgress = null; // prevent concurrent relogin attempts

async function attemptRelogin(reason) {
  if (reloginInProgress) {
    log.info(`[RELOGIN] Already in progress, waiting...`);
    return reloginInProgress;
  }
  log.warn(`[RELOGIN] Session expired during ${reason} — attempting auto-relogin...`);
  reloginInProgress = login()
    .then(() => {
      log.info(`[RELOGIN] Auto-relogin succeeded (triggered by ${reason})`);
      return true;
    })
    .catch((e) => {
      log.warn(`[RELOGIN] Auto-relogin failed: ${e.message} — hit GET /login manually`);
      return false;
    })
    .finally(() => { reloginInProgress = null; });
  return reloginInProgress;
}

/* ---------------------- data fetching with cache ------------------------- */

function freshnessLabel(isoString, source) {
  const age = timeAgo(isoString);
  if (source === 'live') return `This data was just retrieved from the school website moments ago.`;
  if (source === 'cache') return `This data was retrieved from the school website ${age} and is current.`;
  if (source === 'stale') return `WARNING: The school website could not be reached for a live update. This data is from ${age} and may be outdated.`;
  return `Data age: ${age}`;
}

async function getAssignments(child) {
  const student = STUDENTS[child];
  if (!student) return { error: `Unknown child: ${child}` };

  const cached = getCached(child, 'assignments');
  if (cached && isFresh(cached.lastUpdated, ASSIGNMENT_TTL)) {
    log.info(`[DATA] ${student.name} assignments — CACHE HIT (${timeAgo(cached.lastUpdated)})`);
    const source = 'cache';
    return { data: cached.data, freshness: freshnessLabel(cached.lastUpdated, source) };
  }

  log.info(`[DATA] ${student.name} assignments — cache ${cached ? 'STALE' : 'EMPTY'}, scraping live...`);
  try {
    const text = await scrapeAssignments(student.id);
    const chars = text.length;
    const entry = setCache(child, 'assignments', text);
    log.info(`[DATA] ${student.name} assignments — SCRAPED OK (${chars} chars)`);
    return { data: entry.data, freshness: freshnessLabel(entry.lastUpdated, 'live') };
  } catch (e) {
    log.warn(`[DATA] ${student.name} assignments — SCRAPE FAILED: ${e.message}`);

    // If session expired, attempt auto-relogin and retry once
    if (e.message.includes('Session expired')) {
      const reloggedIn = await attemptRelogin(`${student.name} assignments`);
      if (reloggedIn) {
        try {
          const text = await scrapeAssignments(student.id);
          const chars = text.length;
          const entry = setCache(child, 'assignments', text);
          log.info(`[DATA] ${student.name} assignments — SCRAPED OK after relogin (${chars} chars)`);
          return { data: entry.data, freshness: freshnessLabel(entry.lastUpdated, 'live') };
        } catch (e2) {
          log.warn(`[DATA] ${student.name} assignments — SCRAPE FAILED after relogin: ${e2.message}`);
        }
      }
    }

    if (cached) {
      log.info(`[DATA] ${student.name} assignments — falling back to stale data (${timeAgo(cached.lastUpdated)})`);
      return { data: cached.data, freshness: freshnessLabel(cached.lastUpdated, 'stale') };
    }
    return { error: `No data available for ${student.name}'s assignments.` };
  }
}

async function getSchedule(child) {
  const student = STUDENTS[child];
  if (!student) return { error: `Unknown child: ${child}` };

  // Effie's schedule is static — no API call needed
  if (child === 'effie') {
    const csv = EFFIE_STATIC_SCHEDULE || (() => { try { return fs.readFileSync(EFFIE_SCHEDULE_PATH, 'utf8'); } catch { return null; } })();
    if (csv) {
      log.info(`[DATA] Effie schedule — static file`);
      return { data: csv, freshness: 'Static schedule for the 2025-2026 school year.' };
    }
    return { error: "Effie's static schedule file not found." };
  }

  const cached = getCached(child, 'schedule');
  if (cached && isFresh(cached.lastUpdated, SCHEDULE_TTL)) {
    log.info(`[DATA] ${student.name} schedule — CACHE HIT (${timeAgo(cached.lastUpdated)})`);
    return { data: cached.data, freshness: freshnessLabel(cached.lastUpdated, 'cache') };
  }

  log.info(`[DATA] ${student.name} schedule — cache ${cached ? 'STALE' : 'EMPTY'}, scraping live...`);
  try {
    const text = await scrapeSchedule(student.id);
    const chars = text.length;
    const entry = setCache(child, 'schedule', text);
    log.info(`[DATA] ${student.name} schedule — SCRAPED OK (${chars} chars)`);
    return { data: entry.data, freshness: freshnessLabel(entry.lastUpdated, 'live') };
  } catch (e) {
    log.warn(`[DATA] ${student.name} schedule — SCRAPE FAILED: ${e.message}`);

    // If session expired, attempt auto-relogin and retry once
    if (e.message.includes('Session expired')) {
      const reloggedIn = await attemptRelogin(`${student.name} schedule`);
      if (reloggedIn) {
        try {
          const text = await scrapeSchedule(student.id);
          const chars = text.length;
          const entry = setCache(child, 'schedule', text);
          log.info(`[DATA] ${student.name} schedule — SCRAPED OK after relogin (${chars} chars)`);
          return { data: entry.data, freshness: freshnessLabel(entry.lastUpdated, 'live') };
        } catch (e2) {
          log.warn(`[DATA] ${student.name} schedule — SCRAPE FAILED after relogin: ${e2.message}`);
        }
      }
    }

    if (cached) {
      log.info(`[DATA] ${student.name} schedule — falling back to stale data (${timeAgo(cached.lastUpdated)})`);
      return { data: cached.data, freshness: freshnessLabel(cached.lastUpdated, 'stale') };
    }
    return { error: `No data available for ${student.name}'s schedule.` };
  }
}

/* ----------------------------- tool defs --------------------------------- */

const TOOL_DEFINITIONS = [
  {
    name: 'get_assignments',
    description: "Get a child's current assignments from Blackbaud. Returns assignment text including titles, classes, due dates, status, and points.",
    input_schema: {
      type: 'object',
      properties: {
        child: {
          type: 'string',
          enum: ['mae', 'effie'],
          description: 'Which child to get assignments for',
        },
      },
      required: ['child'],
    },
  },
  {
    name: 'get_schedule',
    description: "Get a child's class schedule. Mae (Middle School) has a daily rotation schedule from Blackbaud with Gray/Scarlet days. Effie (Lower School) has a fixed weekly schedule.",
    input_schema: {
      type: 'object',
      properties: {
        child: {
          type: 'string',
          enum: ['mae', 'effie'],
          description: 'Which child to get the schedule for',
        },
      },
      required: ['child'],
    },
  },
  {
    name: 'get_all_data',
    description: "Get all available data for both children (assignments and schedules). Use this for broad queries like 'what do the kids have going on this week?' or when the query mentions both children.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case 'get_assignments': {
      const result = await getAssignments(input.child);
      return result;
    }
    case 'get_schedule': {
      const result = await getSchedule(input.child);
      return result;
    }
    case 'get_all_data': {
      const [maeA, maeS, effieA, effieS] = await Promise.all([
        getAssignments('mae'),
        getSchedule('mae'),
        getAssignments('effie'),
        getSchedule('effie'),
      ]);
      return {
        mae: { assignments: maeA, schedule: maeS },
        effie: { assignments: effieA, schedule: effieS },
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/* ----------------------- claude agentic loop ----------------------------- */

function buildSystemPrompt() {
  const today = new Date();
  const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return `You are a helpful assistant that answers questions about Mark's children's school data from Friends School of Baltimore.

Today is ${dayOfWeek}, ${dateStr}.

Children:
- Mae (6th Grade, Middle School) — has a full rotation schedule with Gray/Scarlet days
- Effie (4th Grade, Lower School) — has a fixed weekly schedule (same every week)

You have tools to fetch their assignments and schedules from Blackbaud. Use the appropriate tool(s) based on the query. For broad queries about "the kids" or "both", use get_all_data. Questions like "where is Mae right now", "what are the kids doing", or "what class does Effie have" are SCHEDULE questions — always fetch the schedule for those.

RESPONSE FORMAT — follow this strictly:
1. FIRST: Answer the specific question directly. Only include what was asked.
2. LAST: Always end with the data freshness in parentheses. Use the exact "freshness" field from the tool result — do NOT calculate or guess data age yourself. Example: "(Data checked 8 minutes ago)" or "(Data from 2 hours ago — could not reach school website for update)"
3. NEVER mention errors, exceptions, scrape failures, or technical details. If the freshness says the website couldn't be reached, just say when the data is from and note a live check wasn't possible.
4. NEVER hallucinate or guess the data age. Use ONLY the "freshness" field provided in the tool result.

SCHEDULE RESPONSES:
- For Mae: Every class you mention MUST include ALL of these: class name, teacher name, start–end times, and room number
- SIMPLIFY class names: strip section numbers, block letters, and codes. Say "Science" not "Science 6 - 04 (D)". Say "Mathematics" not "Mathematics 6 - 01 (A)". Say "French" not "French 6 - 02 (C)". Just use the plain subject name.
- Example: "French with Ms. Hughes, 2:05–2:55 PM, Middle School 225"
- If asked about a specific time, give the one relevant class with all four details
- If asked for "the schedule" or "all classes", list the full day with all four details per class
- Do NOT list the full schedule unless the user asks for it

EFFIE'S SCHEDULE (special rules):
- Effie's schedule is a fixed weekly CSV. It has the same classes every Monday, every Tuesday, etc.
- "GL MFW" means "Meeting for Worship" — this is a Quaker school. Always say "Meeting for Worship", never "GL MFW".
- Fridays have TWO possible schedules: "Assembly" or "Meeting for Worship" Fridays. They differ ONLY in the last two periods (12:55–2:50). We do not know which Friday type any given week will be.
- Only mention the Friday ambiguity if the query specifically covers the affected time slots (12:55–2:50 on a Friday). If so, present both possibilities with a brief caveat. Otherwise just answer normally — most of Friday's schedule is the same either way.
- "Bandestra" is orchestra class. Effie plays Viola. On any day that has Bandestra (Monday and Thursday), proactively include a friendly reminder that Effie needs to bring her Viola to school — even if the question wasn't about Bandestra specifically.

ASSIGNMENT RESPONSES:
- Format due dates relative to today (e.g., "tomorrow", "this Friday")
- Highlight what's overdue or due soon
- Include assignment name, class, points, and status

Keep responses SHORT — this is used via Siri. Answer the question, nothing more.`;
}

async function callClaudeWithTools(command) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const messages = [{ role: 'user', content: command }];
  let iterations = 0;
  let totalToolCalls = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const body = {
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOL_DEFINITIONS,
      messages,
    };

    log.debug(`[NL] Calling Claude (iteration ${iterations})...`);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    const data = await resp.json();

    if (data.stop_reason === 'end_turn') {
      const textBlocks = (data.content || []).filter(b => b.type === 'text');
      return {
        response: textBlocks.map(b => b.text).join('\n').trim(),
        iterations,
        toolCalls: totalToolCalls,
      };
    }

    if (data.stop_reason === 'tool_use') {
      const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');
      const textBlocks = (data.content || []).filter(b => b.type === 'text');

      if (textBlocks.length > 0) {
        const reasoning = textBlocks.map(b => b.text).join(' ').trim();
        if (reasoning) log.debug(`[NL] Claude reasoning: "${reasoning.slice(0, 200)}"`);
      }

      if (toolUseBlocks.length === 0) {
        const responseText = textBlocks.map(b => b.text).join('\n').trim();
        return { response: responseText || 'Done.', iterations, toolCalls: totalToolCalls };
      }

      log.info(`[NL] Iteration ${iterations}: ${toolUseBlocks.length} tool call(s)`);
      messages.push({ role: 'assistant', content: data.content });

      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        totalToolCalls++;
        const { name, input, id } = toolUse;
        log.info(`[NL] Tool #${totalToolCalls}: ${name}(${JSON.stringify(input).slice(0, 200)})`);

        let result;
        try {
          result = await executeTool(name, input || {});
        } catch (e) {
          result = { error: e.message };
          log.warn(`[NL] Tool ${name} error: ${e.message}`);
        }

        log.debug(`[NL] Tool result: ${JSON.stringify(result).slice(0, 300)}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unknown stop reason
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    return {
      response: textBlocks.map(b => b.text).join('\n').trim() || 'Done.',
      iterations,
      toolCalls: totalToolCalls,
    };
  }

  return {
    response: `Hit the limit of ${MAX_TOOL_ITERATIONS} iterations. Data may be incomplete.`,
    iterations,
    toolCalls: totalToolCalls,
  };
}

/* ----------------------------- HTTP server -------------------------------- */

function buildFreshnessInfo() {
  const info = {};
  for (const child of Object.keys(STUDENTS)) {
    info[child] = {};
    for (const type of ['assignments', 'schedule']) {
      const cached = getCached(child, type);
      info[child][type] = cached
        ? { lastUpdated: cached.lastUpdated, age: timeAgo(cached.lastUpdated) }
        : { lastUpdated: null, age: 'never' };
    }
  }
  return info;
}

function createRequestHandler() {
  return async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const urlPath = parsedUrl.pathname || '/';

    const sendJson = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj, null, 2));
    };

    const readBody = () => new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk.toString('utf8');
        if (data.length > 1_000_000) { req.destroy(); reject(new Error('Body too large')); }
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON body')); }
      });
    });

    try {
      // Health check
      if (req.method === 'GET' && urlPath === '/health') {
        return sendJson(200, {
          ok: true,
          now: nowIso(),
          browserReady: !!browserContext,
          cached: buildFreshnessInfo(),
        });
      }

      // Login — opens browser for user to authenticate
      if (req.method === 'GET' && urlPath === '/login') {
        try {
          const result = await login();
          return sendJson(200, { ok: true, ...result });
        } catch (e) {
          return sendJson(500, { ok: false, error: e.message });
        }
      }

      // Raw data dump
      if (req.method === 'GET' && urlPath === '/data') {
        return sendJson(200, {
          ok: true,
          freshness: buildFreshnessInfo(),
          data: cache,
        });
      }

      // Natural language endpoint
      if (req.method === 'POST' && urlPath === '/nl') {
        const body = await readBody();
        const command = String(body.command || '').trim();

        if (!command) {
          return sendJson(400, { ok: false, error: 'Missing "command" in request body' });
        }

        log.info(`[NL] ========== NEW REQUEST ==========`);
        log.info(`[NL] Command: "${command}"`);

        try {
          const result = await callClaudeWithTools(command);
          log.info(`[NL] Complete: ${result.iterations} iterations, ${result.toolCalls} tool calls`);
          log.info(`[NL] Response: "${result.response.replace(/\n+/g, ' ').slice(0, 500)}"`);
          return sendJson(200, {
            ok: true,
            command,
            response: result.response,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            dataFreshness: buildFreshnessInfo(),
          });
        } catch (e) {
          log.error('[NL] Error:', e.message);
          return sendJson(500, { ok: false, error: e.message });
        }
      }

      // 404
      sendJson(404, { ok: false, error: 'Not found. Endpoints: GET /login, POST /nl, GET /health, GET /data' });
    } catch (e) {
      log.error('Request error:', e.message);
      sendJson(500, { ok: false, error: e.message });
    }
  };
}

function startServer(port) {
  const listenPort = port || PORT;
  const server = http.createServer(createRequestHandler());

  server.listen(listenPort, () => {
    log.info(`FriendsSchool server listening on port ${listenPort}`);
    log.info(`Endpoints: GET /login, POST /nl, GET /health, GET /data`);
    if (!ANTHROPIC_API_KEY) {
      log.warn('ANTHROPIC_API_KEY not set — /nl endpoint will not work.');
    }
    log.info(`Browser profile: ${PROFILE_PATH}`);
    log.info('Hit GET /login to authenticate (opens visible browser)');
  });

  return server;
}

/* -------------------------------- exports -------------------------------- */

// Export internals for testing
module.exports = {
  // Config
  STUDENTS, ASSIGNMENT_TTL, SCHEDULE_TTL, TOOL_DEFINITIONS,
  // Cache
  cache, getCached, setCache, initCache,
  // Time helpers
  timeAgo, isFresh, nowIso,
  // Data fetchers (depend on scrapers)
  getAssignments, getSchedule,
  // Tools
  executeTool,
  // Claude
  buildSystemPrompt, callClaudeWithTools,
  // HTTP
  buildFreshnessInfo, createRequestHandler, startServer,
  // Browser
  getBrowser, closeBrowser, login, getCookieHeader,
  // Allow tests to override internals
  _setBrowserContext(ctx) { browserContext = ctx; },
  _getBrowserContext() { return browserContext; },
  _clearCache() { for (const k of Object.keys(cache)) delete cache[k]; },
  _setDataDir(dir) { DATA_DIR = dir; },
};

/* --------------------------------- main ---------------------------------- */

if (require.main === module) {
  initCache();
  const server = startServer();

  async function shutdown(signal) {
    log.info(`${signal} received, shutting down...`);
    server.close();
    await closeBrowser();
    process.exit(0);
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
