# FriendsSchool — NL Query Agent for School Data

Natural language query agent for Friends School of Baltimore (Blackbaud MySchoolApp). Ask questions about your kids' assignments and schedules via Siri, curl, or any HTTP client.

## Architecture

```
Siri Shortcut → HTTP POST /nl → Claude API (with tools) → Node.js fetch → Blackbaud API
                                                         ← structured JSON ←
                                 ← natural language answer ←
```

Single Node.js server with:
- **Playwright** persistent browser profile — login once via Google SSO, browser stays alive offscreen for session persistence
- **Cookie-based API calls** — after login, all data fetching uses Node.js `fetch()` with cookies extracted from the browser context (no browser windows ever appear after login)
- **On-demand fetching** with memory + disk caching (15min assignments, 60min schedules)
- **Claude agentic loop** — Claude decides which tools to call based on your query
- **File logging** — every log line is mirrored to `data/server.log` (with a single rolled `.1` backup at 10 MB); see [Logging](#logging)

## Setup

```bash
cd ~/src/FriendsSchool
npm install
npx playwright install chromium
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Claude API key for /nl endpoint |
| `PORT` | `3082` | HTTP server port |
| `BROWSER_PROFILE_PATH` | `~/.friendsschool-profile` | Playwright persistent profile directory |
| `FRIENDSSCHOOL_MODEL` | `claude-sonnet-4-6` | Claude model for NL queries |
| `MAX_TOOL_ITERATIONS` | `10` | Max agentic loop iterations |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

These can be set in a `.env` file or as environment variables.

## Authentication

The server attempts an **auto-login on startup** using cookies persisted in the Playwright profile (`~/.friendsschool-profile` by default). On a normal restart you don't need to do anything — `node server.js` will reuse the existing session and be ready to serve immediately.

**First-time setup** (or when the persisted session has fully expired):

1. Start the server:
   ```bash
   node server.js
   ```
2. The server's auto-login will pop a visible Chromium window when no valid session exists. Complete Google SSO on the Blackbaud page.
3. After login, the browser moves offscreen and the session persists. The server is ready for queries.

You can also force a fresh login any time with `curl http://localhost:3082/login`.

Sessions last hours; the keep-alive ping (every ~10 min) refreshes them. If a session does expire and the keep-alive can't auto-relogin, you'll see a "Session expired" error from the affected endpoint — hit `GET /login` to recover.

## API Endpoints

### `GET /login` — Authenticate

Opens a visible browser for Google SSO login. After login, the browser moves offscreen and stays alive to preserve the session. Returns `{"ok": true}` on success.

### `POST /nl` — Natural Language Query

Main interface. Send a question, get a natural language answer.

**Request:**
```json
{ "command": "what does mae have due this week?" }
```

**Response:**
```json
{
  "ok": true,
  "command": "what does mae have due this week?",
  "response": "Mae has 3 assignments due this week: ...",
  "iterations": 2,
  "toolCalls": 1,
  "dataFreshness": { ... }
}
```

**Example queries:**
- "What does Mae have due tomorrow?"
- "Does Effie have any overdue assignments?"
- "What's the kids' schedule today?"
- "Where is Mae right now?"
- "Does anyone have anything due this week?"

### `GET /health` — Health Check

Returns server status, browser readiness, and cache freshness.

### `GET /data` — Cached Data Dump

Returns all cached (already-formatted) data with freshness timestamps.

### `POST /refresh` — Force-Refresh Cache

Bypasses TTL, invalidates the cache for the requested child + type, refetches via Blackbaud, and returns the fresh formatted text.

**Request:**
```json
{ "child": "mae", "type": "schedule" }
```

`child`: `mae`, `effie`, or `all` (default `all`).
`type`: `schedule`, `assignments`, or `all` (default `all`).

Returns `{ ok, refreshed: { <child>: { <type>: { data, freshness } } }, freshness }`.

### `GET /raw` — Raw Blackbaud JSON

Hits the Blackbaud API directly and returns the unformatted JSON response — useful for inspecting field shapes (e.g., what distinguishes a game from a practice on the schedule).

**Query:** `?child=mae&type=schedule` (or `type=assignments`).

Also writes the response to `data/schedule-raw-<studentId>.json` / `data/assignments-raw-<studentId>.json` on disk for offline inspection.

```bash
curl -s 'http://localhost:3082/raw?child=mae&type=schedule' | jq '.data[0]'
```

### `GET /raw-calendar` — Rich Calendar Events

Hits Blackbaud's `/api/mycalendar/events` and returns the full response — includes `EventType` (Practice/Game/Scrimmage), `Opponent`, `HomeAway`, `Location`, `RoomName`, `Cancelled`, `Rescheduled`, `RescheduleNote`, etc. that the regular `ScheduleList` API does not expose.

**Query (optional):** `?start=YYYY-MM-DD&end=YYYY-MM-DD`. Defaults to the current month.

This endpoint requires a populated `data/calendar-filter.txt` (see [Calendar filter](#calendar-filter) below) and routes through the headless browser context (because the underlying Blackbaud POST needs an antiforgery token).

```bash
curl -s 'http://localhost:3082/raw-calendar?start=2026-05-04&end=2026-05-10' | \
  jq '[.data[] | select(.EventType == "Game") | {StartDate, Title, HomeAway, Opponent, RoomName}]'
```

### `POST /api-proxy` — Generic Blackbaud Proxy

Localhost-only escape hatch. Forwards an arbitrary path to Blackbaud using the server's authenticated cookies. Use this when you need to probe a Blackbaud endpoint that isn't wrapped by `/raw` or `/raw-calendar`.

**Request:**
```json
{
  "path": "/api/datadirect/ScheduleList?viewerId=...&start=...&end=...",
  "method": "GET",
  "useBrowser": false
}
```

`path` must start with `/`. Optional fields: `body` (object or string), `headers` (object), `method` (default `GET`), `useBrowser` (default `false`).

Set `useBrowser: true` to route through the headless Playwright page instead of Node fetch — required for Blackbaud endpoints that need the antiforgery `requestverificationtoken` header (most POSTs, including `/api/mycalendar/events`).

Returns `{ ok, path, method, transport, data }`. Returns `403` for non-loopback callers.

```bash
# Node-fetch transport (cookies only):
curl -s -X POST http://localhost:3082/api-proxy \
  -H 'Content-Type: application/json' \
  -d '{"path":"/api/webapp/userstatus"}' | jq .

# Browser-context transport (cookies + antiforgery token automatically):
curl -s -X POST http://localhost:3082/api-proxy \
  -H 'Content-Type: application/json' \
  -d '{"path":"/api/mycalendar/events","method":"POST","useBrowser":true,"body":{"bulkURL":"mycalendar/events","startDate":"05/03/2026","endDate":"05/10/2026","filterString":"...","showPractice":true,"recentSave":false}}' | jq .
```

## Calendar filter

`/api/mycalendar/events` requires a `filterString` listing which calendars to include — Mae's teams, school events, the cycle (Gray/Scarlet) calendars, etc. The string is per-user and changes each season as teams change.

To capture it:

1. Open Blackbaud's parent calendar in your browser and load DevTools → Network → filter `mycalendar/events`.
2. Trigger a calendar refresh (change weeks).
3. Click the `mycalendar/events` POST request → Payload tab → copy the `filterString` value.
4. Paste it into `data/calendar-filter.txt` (single line, no quotes).

Without this file the server falls back to the plain `ScheduleList` schedule (no game/opponent details).

## Caching Strategy

| Data Type | Cache TTL | Disk Persistence |
|-----------|-----------|------------------|
| Assignments | 15 minutes | `data/{child}-assignments.json` |
| Schedules | 60 minutes | `data/{child}-schedule.json` |

- **On startup:** disk data is loaded into memory for instant first responses
- **On cache miss:** live API fetch → cached to memory + disk
- **On fetch failure:** stale data served with a warning about when it was last updated

## Data Sources

| Data | Blackbaud API | Notes |
|------|--------------|-------|
| Assignments | `/api/assignment2/ParentStudentAssignmentCenterGet` | Structured JSON with time buckets (due today/tomorrow/this week, overdue, etc.) |
| Schedule | `/api/datadirect/ScheduleList` | Monthly schedule with teacher names, room numbers, buildings |
| Session keepalive | `/api/webapp/userstatus` | Pinged every 10 minutes to keep the session alive |

## Siri Shortcut Configuration

Create a Shortcut with:
1. **Action:** "Get Contents of URL"
2. **URL:** `http://marks-mac-studio:3082/nl`
3. **Method:** POST
4. **Headers:** `Content-Type: application/json`
5. **Request Body (JSON):**
   - Key: `command`
   - Value: "Ask each time" (or use Dictation input)
6. **Action:** "Get Dictionary Value" → key `response`
7. **Action:** "Speak Text" (or "Show Result")

This lets you say "Hey Siri, school query" → speak your question → hear the answer.

## Troubleshooting

### "Session expired" error
Hit `GET /login` to re-authenticate in the browser window.

### Browser won't launch
Ensure Playwright Chromium is installed: `npx playwright install chromium`

### Port conflict
Change the port via `.env` or `PORT=3083 node server.js`.

## Logging

All log lines are written to **both** stdout (the terminal that started the server) and a log file:

| Path | Notes |
|---|---|
| `data/server.log` | Active log file. Append-only. |
| `data/server.log.1` | Previous log, created when the active file rolls over. |

Every line uses the same format:

```
[2026-05-04T11:00:12.539Z] [INFO] [KEEPALIVE] Session alive (HTTP 200, schedule API verified, mae schedule cached)
```

**Rotation**: at server startup, if `data/server.log` exceeds 10 MB it is renamed to `data/server.log.1` (overwriting any existing `.1`) and a fresh log is started. There is only one rolled-over generation — older history is dropped.

**Verbosity** is controlled by `LOG_LEVEL` (default `info`; values: `debug`, `info`, `warn`, `error`).

To follow the log live:

```bash
tail -f ~/src/FriendsSchool/data/server.log
```

Useful greps:

```bash
grep '\[NL\]'        data/server.log   # natural-language requests and responses
grep '\[DATA\]'      data/server.log   # cache hits, scrapes, freshness
grep '\[KEEPALIVE\]' data/server.log   # session keep-alive pings
grep '\[LOGIN\]'     data/server.log   # auth flow
grep '\[ERROR\]\|\[WARN\]' data/server.log
```
