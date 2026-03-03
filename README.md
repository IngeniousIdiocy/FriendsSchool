# FriendsSchool — NL Query Agent for School Data

Natural language query agent for Friends School of Baltimore (Blackbaud MySchoolApp). Ask questions about your kids' assignments and schedules via Siri, curl, or any HTTP client.

## Architecture

```
Siri Shortcut → HTTP POST /nl → Claude API (with tools) → Playwright scraper → Blackbaud
                                                         ← structured data ←
                                 ← natural language answer ←
```

Single Node.js server with:
- **Playwright** persistent browser profile — login once via Google SSO, sessions persist across restarts
- **On-demand scraping** with memory + disk caching (15min assignments, 60min schedules)
- **Claude agentic loop** — Claude decides which tools to call based on your query
- **DOM text extraction** via `document.body.innerText` (avoids CSRF-locked APIs)

## Students

| Name | ID | Grade | School |
|------|----|-------|--------|
| Mae | 6429913 | 6th | Middle School |
| Effie | 6429999 | 4th | Lower School |

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
| `HEADLESS` | `false` | Set `true` after initial login |
| `FRIENDSSCHOOL_MODEL` | `claude-haiku-4-5` | Claude model for NL queries |
| `MAX_TOOL_ITERATIONS` | `10` | Max agentic loop iterations |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

These can be set in the `.env` file or as environment variables.

## First-Run Authentication

1. Start the server (non-headless, the default):
   ```bash
   node server.js
   ```
2. Send any query to trigger the browser launch:
   ```bash
   curl -X POST http://localhost:3082/nl \
     -H 'Content-Type: application/json' \
     -d '{"command":"what does mae have due tomorrow?"}'
   ```
3. A Chromium window opens → log in via Google SSO on the Blackbaud page
4. After login, the session is saved to the profile directory
5. Stop the server, set `HEADLESS=true` in `.env`, restart:
   ```bash
   # In .env:
   HEADLESS=true
   ```

## API Endpoints

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
  "dataFreshness": {
    "mae": {
      "assignments": { "lastUpdated": "2026-03-02T15:30:00Z", "age": "2min ago" },
      "schedule": { "lastUpdated": null, "age": "never" }
    },
    "effie": { ... }
  }
}
```

**Example queries:**
- "What does Mae have due tomorrow?"
- "Does Effie have any overdue assignments?"
- "What's the kids' schedule today?"
- "What's Mae's homework situation?"
- "Does anyone have anything due this week?"

### `GET /health` — Health Check

```json
{
  "ok": true,
  "now": "2026-03-02T15:30:00Z",
  "browserReady": true,
  "cached": { ... }
}
```

### `GET /data` — Raw Cached Data

Returns all cached data with freshness timestamps. Useful for debugging.

## Caching Strategy

| Data Type | Cache TTL | Disk Persistence |
|-----------|-----------|------------------|
| Assignments | 15 minutes | `data/mae-assignments.json`, `data/effie-assignments.json` |
| Schedules | 60 minutes | `data/mae-schedule.json`, `data/effie-schedule.json` |

- **On startup:** disk data is loaded into memory cache for instant first responses
- **On cache miss:** live scrape via Playwright → cached to memory + disk
- **On scrape failure:** stale data served with a warning about when it was last updated

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

## Data Sources

| Data | Blackbaud URL Pattern | Notes |
|------|----------------------|-------|
| Assignments | `/lms-assignment/assignment-center/parent/{id}` | Active assignments with status, due dates, points, class |
| Schedule | `/sis-scheduling/user-calendar/{id}` | Monthly calendar. Mae has full Gray/Scarlet day rotation. Effie only shows Homeroom. |

## Troubleshooting

### "Session expired" error
The Blackbaud session has expired. Restart with `HEADLESS=false`, send a query, and re-authenticate in the browser window.

### Browser won't launch
Ensure Playwright Chromium is installed: `npx playwright install chromium`

### Stale data warnings
Data older than the cache TTL triggers a live scrape. If scraping fails, stale data is served with a timestamp warning. Check the `/health` endpoint for freshness info.

### Port conflict
Change the port in `.env` or via `PORT=3083 node server.js`.

## File Structure

```
FriendsSchool/
├── server.js          # Single-file server (browser, scrapers, cache, Claude loop, HTTP)
├── package.json
├── .env               # Configuration
├── data/              # Disk-persisted cache (auto-created)
│   ├── mae-assignments.json
│   ├── mae-schedule.json
│   ├── effie-assignments.json
│   └── effie-schedule.json
└── README.md
```
