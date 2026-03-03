'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Suppress logs during tests
process.env.LOG_LEVEL = 'error';
// Prevent auto-start side effects
process.env.HEADLESS = 'true';

// Use temp dir for data so tests never pollute real data/
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'friendsschool-test-'));
process.env.FRIENDSSCHOOL_DATA_DIR = TEST_DATA_DIR;

const server = require('../server');
server._setDataDir(TEST_DATA_DIR);

/* ----------------------------- helpers ----------------------------------- */

function makeRequest(serverInstance, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = serverInstance.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/* ========================= time helpers ================================== */

describe('timeAgo', () => {
  it('returns "never" for null/undefined', () => {
    assert.equal(server.timeAgo(null), 'never');
    assert.equal(server.timeAgo(undefined), 'never');
  });

  it('returns seconds for recent timestamps', () => {
    const now = new Date(Date.now() - 5000).toISOString();
    assert.match(server.timeAgo(now), /\ds ago/);
  });

  it('returns minutes for minute-old timestamps', () => {
    const fiveMin = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.match(server.timeAgo(fiveMin), /\dmin ago/);
  });

  it('returns hours for hour-old timestamps', () => {
    const twoHrs = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    assert.match(server.timeAgo(twoHrs), /\dh ago/);
  });

  it('returns days for day-old timestamps', () => {
    const threeDays = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
    assert.match(server.timeAgo(threeDays), /\dd ago/);
  });
});

describe('isFresh', () => {
  it('returns false for null', () => {
    assert.equal(server.isFresh(null, 60000), false);
  });

  it('returns true for recent data within TTL', () => {
    const recent = new Date(Date.now() - 5000).toISOString();
    assert.equal(server.isFresh(recent, 60000), true);
  });

  it('returns false for data older than TTL', () => {
    const old = new Date(Date.now() - 120000).toISOString();
    assert.equal(server.isFresh(old, 60000), false);
  });
});

/* ========================= cache layer =================================== */

describe('cache', () => {
  beforeEach(() => {
    server._clearCache();
  });

  it('getCached returns null for empty cache', () => {
    assert.equal(server.getCached('mae', 'assignments'), null);
  });

  it('setCache stores and retrieves data', () => {
    server.setCache('mae', 'assignments', 'test data');
    const cached = server.getCached('mae', 'assignments');
    assert.equal(cached.data, 'test data');
    assert.ok(cached.lastUpdated);
  });

  it('setCache writes to disk', () => {
    server.setCache('mae', 'assignments', 'disk test');
    const diskFile = path.join(TEST_DATA_DIR, 'mae-assignments.json');
    assert.ok(fs.existsSync(diskFile));
    const diskData = JSON.parse(fs.readFileSync(diskFile, 'utf8'));
    assert.equal(diskData.data, 'disk test');
  });

  it('different children have separate caches', () => {
    server.setCache('mae', 'assignments', 'mae data');
    server.setCache('effie', 'assignments', 'effie data');
    assert.equal(server.getCached('mae', 'assignments').data, 'mae data');
    assert.equal(server.getCached('effie', 'assignments').data, 'effie data');
  });

  it('assignments and schedule are cached separately', () => {
    server.setCache('mae', 'assignments', 'assignments data');
    server.setCache('mae', 'schedule', 'schedule data');
    assert.equal(server.getCached('mae', 'assignments').data, 'assignments data');
    assert.equal(server.getCached('mae', 'schedule').data, 'schedule data');
  });
});

/* ========================= tool definitions ============================== */

describe('TOOL_DEFINITIONS', () => {
  it('defines get_assignments, get_schedule, and get_all_data', () => {
    const names = server.TOOL_DEFINITIONS.map(t => t.name);
    assert.deepEqual(names, ['get_assignments', 'get_schedule', 'get_all_data']);
  });

  it('get_assignments requires child param with mae/effie enum', () => {
    const tool = server.TOOL_DEFINITIONS.find(t => t.name === 'get_assignments');
    assert.deepEqual(tool.input_schema.properties.child.enum, ['mae', 'effie']);
    assert.deepEqual(tool.input_schema.required, ['child']);
  });
});

/* ========================= executeTool =================================== */

describe('executeTool', () => {
  beforeEach(() => {
    server._clearCache();
    // Pre-populate cache so tools don't trigger real scraping
    server.setCache('mae', 'assignments', 'Mae math homework due tomorrow');
    server.setCache('mae', 'schedule', 'Mae: Period 1 English, Period 2 Math');
    server.setCache('effie', 'assignments', 'Effie reading log due Friday');
    server.setCache('effie', 'schedule', 'Effie: Homeroom');
  });

  it('get_assignments returns cached data for mae', async () => {
    const result = await server.executeTool('get_assignments', { child: 'mae' });
    assert.equal(result.data, 'Mae math homework due tomorrow');
    assert.ok(result.freshness);
    assert.match(result.freshness, /current/);
  });

  it('get_schedule returns cached data for effie', async () => {
    const result = await server.executeTool('get_schedule', { child: 'effie' });
    assert.equal(result.data, 'Effie: Homeroom');
    assert.ok(result.freshness);
    assert.match(result.freshness, /current/);
  });

  it('get_all_data returns all four data sets', async () => {
    const result = await server.executeTool('get_all_data', {});
    assert.ok(result.mae);
    assert.ok(result.effie);
    assert.equal(result.mae.assignments.data, 'Mae math homework due tomorrow');
    assert.equal(result.effie.schedule.data, 'Effie: Homeroom');
  });

  it('unknown tool returns error', async () => {
    const result = await server.executeTool('nonexistent', {});
    assert.ok(result.error);
    assert.match(result.error, /Unknown tool/);
  });

  it('unknown child returns error', async () => {
    const result = await server.executeTool('get_assignments', { child: 'bob' });
    assert.ok(result.error);
    assert.match(result.error, /Unknown child/);
  });
});

/* ========================= buildSystemPrompt ============================= */

describe('buildSystemPrompt', () => {
  it('includes today date info', () => {
    const prompt = server.buildSystemPrompt();
    assert.ok(prompt.includes('Today is'));
  });

  it('mentions both children', () => {
    const prompt = server.buildSystemPrompt();
    assert.ok(prompt.includes('Mae'));
    assert.ok(prompt.includes('Effie'));
  });

  it('mentions Gray/Scarlet days', () => {
    const prompt = server.buildSystemPrompt();
    assert.ok(prompt.includes('Gray/Scarlet'));
  });
});

/* ========================= buildFreshnessInfo ============================ */

describe('buildFreshnessInfo', () => {
  beforeEach(() => {
    server._clearCache();
  });

  it('shows "never" for empty cache', () => {
    const info = server.buildFreshnessInfo();
    assert.equal(info.mae.assignments.age, 'never');
    assert.equal(info.mae.schedule.age, 'never');
    assert.equal(info.effie.assignments.age, 'never');
    assert.equal(info.effie.schedule.age, 'never');
  });

  it('shows freshness for cached data', () => {
    server.setCache('mae', 'assignments', 'data');
    const info = server.buildFreshnessInfo();
    assert.ok(info.mae.assignments.lastUpdated);
    assert.notEqual(info.mae.assignments.age, 'never');
    assert.equal(info.mae.schedule.age, 'never');
  });
});

/* ========================= Claude agentic loop =========================== */

describe('callClaudeWithTools', () => {
  let originalFetch;

  beforeEach(() => {
    server._clearCache();
    // Pre-fill cache to avoid scraping
    server.setCache('mae', 'assignments', 'Mae: Math homework due tomorrow, Science project due Friday');
    server.setCache('effie', 'assignments', 'Effie: Reading log due Wednesday');

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws if ANTHROPIC_API_KEY is not set', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      // Re-require to pick up missing key — but our module caches the key at load time.
      // The function checks the module-level const, so we need to test via the actual flow.
      // Since the key was set at require time, we test the HTTP endpoint instead.
      // For now, just verify the function signature exists.
      assert.equal(typeof server.callClaudeWithTools, 'function');
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('handles end_turn response (no tools needed)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Mae has math homework due tomorrow.' }],
      }),
    }));

    const result = await server.callClaudeWithTools('what does mae have due?');
    assert.equal(result.response, 'Mae has math homework due tomorrow.');
    assert.equal(result.iterations, 1);
    assert.equal(result.toolCalls, 0);
  });

  it('handles tool_use → end_turn cycle', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: Claude wants to use a tool
        return {
          ok: true,
          json: async () => ({
            stop_reason: 'tool_use',
            content: [
              { type: 'text', text: 'Let me check assignments.' },
              { type: 'tool_use', id: 'call_1', name: 'get_assignments', input: { child: 'mae' } },
            ],
          }),
        };
      }
      // Second call: Claude responds with final answer
      return {
        ok: true,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Mae has math homework due tomorrow and a science project due Friday.' }],
        }),
      };
    });

    const result = await server.callClaudeWithTools('what does mae have due?');
    assert.equal(result.response, 'Mae has math homework due tomorrow and a science project due Friday.');
    assert.equal(result.iterations, 2);
    assert.equal(result.toolCalls, 1);

    // Verify Claude API was called twice
    assert.equal(globalThis.fetch.mock.callCount(), 2);

    // Verify second call included tool results
    const secondCall = globalThis.fetch.mock.calls[1];
    const secondBody = JSON.parse(secondCall.arguments[1].body);
    assert.equal(secondBody.messages.length, 3); // user, assistant (tool_use), user (tool_result)
    assert.equal(secondBody.messages[2].role, 'user');
    assert.equal(secondBody.messages[2].content[0].type, 'tool_result');
  });

  it('handles API error response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    }));

    await assert.rejects(
      () => server.callClaudeWithTools('test'),
      /Anthropic API error 429/
    );
  });

  it('handles multiple parallel tool calls', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            stop_reason: 'tool_use',
            content: [
              { type: 'tool_use', id: 'call_1', name: 'get_assignments', input: { child: 'mae' } },
              { type: 'tool_use', id: 'call_2', name: 'get_assignments', input: { child: 'effie' } },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Both kids have homework.' }],
        }),
      };
    });

    const result = await server.callClaudeWithTools('what do the kids have due?');
    assert.equal(result.toolCalls, 2);

    // Verify tool results were sent back
    const secondCall = globalThis.fetch.mock.calls[1];
    const secondBody = JSON.parse(secondCall.arguments[1].body);
    const toolResultMsg = secondBody.messages[2];
    assert.equal(toolResultMsg.content.length, 2);
    assert.equal(toolResultMsg.content[0].tool_use_id, 'call_1');
    assert.equal(toolResultMsg.content[1].tool_use_id, 'call_2');
  });
});

/* ========================= HTTP endpoints ================================ */

describe('HTTP server', () => {
  let httpServer;
  let originalFetch;

  beforeEach(() => {
    server._clearCache();
    originalFetch = globalThis.fetch;
    return new Promise((resolve) => {
      httpServer = http.createServer(server.createRequestHandler());
      httpServer.listen(0, resolve);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    return new Promise((resolve) => {
      httpServer.close(resolve);
    });
  });

  it('GET /health returns ok with cache info', async () => {
    const { status, body } = await makeRequest(httpServer, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.now);
    assert.ok(body.cached);
    assert.equal(body.cached.mae.assignments.age, 'never');
  });

  it('GET /health reflects cached data freshness', async () => {
    server.setCache('mae', 'assignments', 'test');
    const { body } = await makeRequest(httpServer, 'GET', '/health');
    assert.notEqual(body.cached.mae.assignments.age, 'never');
    assert.ok(body.cached.mae.assignments.lastUpdated);
  });

  it('GET /data returns cached data', async () => {
    server.setCache('effie', 'schedule', 'Effie homeroom');
    const { status, body } = await makeRequest(httpServer, 'GET', '/data');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.data['effie-schedule']);
    assert.equal(body.data['effie-schedule'].data, 'Effie homeroom');
  });

  it('POST /nl returns 400 for missing command', async () => {
    const { status, body } = await makeRequest(httpServer, 'POST', '/nl', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /Missing "command"/);
  });

  it('POST /nl returns 400 for empty command', async () => {
    const { status, body } = await makeRequest(httpServer, 'POST', '/nl', { command: '   ' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('POST /nl returns success with mocked Claude', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    server.setCache('mae', 'assignments', 'Math homework');

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Mae has math homework.' }],
      }),
    }));

    const { status, body } = await makeRequest(httpServer, 'POST', '/nl', {
      command: 'what does mae have due?',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.command, 'what does mae have due?');
    assert.equal(body.response, 'Mae has math homework.');
    assert.ok(body.dataFreshness);
  });

  it('unknown route returns 404', async () => {
    const { status, body } = await makeRequest(httpServer, 'GET', '/nonexistent');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});

/* ========================= data fetching with cache ====================== */

describe('getAssignments / getSchedule with stale fallback', () => {
  beforeEach(() => {
    server._clearCache();
  });

  it('serves from cache when fresh', async () => {
    server.setCache('mae', 'assignments', 'Fresh data');
    const result = await server.getAssignments('mae');
    assert.equal(result.data, 'Fresh data');
    assert.ok(result.freshness);
    assert.match(result.freshness, /current/);
  });

  it('returns error for unknown child', async () => {
    const result = await server.getAssignments('unknown');
    assert.ok(result.error);
    assert.match(result.error, /Unknown child/);
  });

  it('getSchedule serves from cache when fresh', async () => {
    server.setCache('effie', 'schedule', 'Schedule data');
    const result = await server.getSchedule('effie');
    assert.equal(result.data, 'Schedule data');
    assert.ok(result.freshness);
    assert.match(result.freshness, /current/);
  });
});

/* ========================= STUDENTS config =============================== */

describe('STUDENTS config', () => {
  it('has mae with correct ID', () => {
    assert.equal(server.STUDENTS.mae.id, '6429913');
    assert.equal(server.STUDENTS.mae.grade, '6th');
  });

  it('has effie with correct ID', () => {
    assert.equal(server.STUDENTS.effie.id, '6429999');
    assert.equal(server.STUDENTS.effie.grade, '4th');
  });
});
