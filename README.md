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

1. Start the server:
   ```bash
   node server.js
   ```
2. Hit the login endpoint:
   ```bash
   curl http://localhost:3082/login
   ```
3. A Chromium window opens — log in via Google SSO on the Blackbaud page
4. After login, the browser moves offscreen and the session persists
5. The server is now ready for queries

Sessions last hours but eventually expire. If you get "Session expired" errors, hit `GET /login` again.

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

### `GET /data` — Raw Cached Data

Returns all cached data with freshness timestamps.

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
