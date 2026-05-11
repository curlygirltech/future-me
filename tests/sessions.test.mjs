import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionsHandler } from '../api/sessions.js';

// ── mock helpers ──────────────────────────────────────────────────────────────

/**
 * Returns a chainable Supabase-shaped object that resolves to `result` when awaited.
 * Every method in the chain returns a new chainable, so arbitrary method sequences work.
 */
function makeChain(result = { data: null, error: null }) {
  const chain = {
    select: () => makeChain(result),
    insert: () => makeChain(result),
    update: () => makeChain(result),
    eq:     () => makeChain(result),
    order:  () => makeChain(result),
    limit:  () => makeChain(result),
    single: () => makeChain(result),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch:  (reject)          => Promise.resolve(result).catch(reject),
  };
  return chain;
}

/**
 * Builds a mock Supabase client.
 * `tableResponses` maps table name → { insert, select, update } result overrides.
 * Each property is a { data, error } object returned when that operation is awaited.
 * Calls to .insert() are recorded in `db.insertCalls` for assertion.
 */
function makeMockDb(tableResponses = {}) {
  const insertCalls = [];
  const db = {
    insertCalls,
    from(table) {
      const t = tableResponses[table] || {};
      return {
        insert(rows) {
          insertCalls.push({ table, rows });
          return makeChain(t.insert ?? { data: null, error: null });
        },
        select() { return makeChain(t.select ?? { data: [], error: null }); },
        update() { return makeChain(t.update ?? { data: null, error: null }); },
      };
    },
  };
  return db;
}

function makeRes() {
  const res = { headers: {}, statusCode: null, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status    = (code)  => { res.statusCode = code; return res; };
  res.json      = (data)  => { res.body = data; return res; };
  res.end       = ()      => res;
  return res;
}

function makeReq(method, url, body = {}) {
  return { method, url, body: { accessPassword: 'secret', ...body } };
}

// ── setup ─────────────────────────────────────────────────────────────────────

let handler;

beforeEach(() => {
  process.env.ACCESS_PASSWORD = 'secret';
  handler = createSessionsHandler(makeMockDb());
});

afterEach(() => {
  delete process.env.ACCESS_PASSWORD;
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('sets CORS headers on every response', async () => {
    const res = makeRes();
    await handler(makeReq('OPTIONS', '/api/sessions'), res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET, POST, PATCH, OPTIONS');
    assert.equal(res.headers['Access-Control-Allow-Headers'], 'Content-Type');
  });

  it('returns 200 for OPTIONS preflight', async () => {
    const res = makeRes();
    await handler(makeReq('OPTIONS', '/api/sessions'), res);
    assert.equal(res.statusCode, 200);
  });
});

// ── authentication ────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 when ACCESS_PASSWORD env var is not set', async () => {
    delete process.env.ACCESS_PASSWORD;
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions'), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  it('returns 401 when password does not match', async () => {
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions', { accessPassword: 'wrong' }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  it('returns 401 when password is missing from body', async () => {
    const res = makeRes();
    await handler({ method: 'GET', url: '/api/sessions', body: {} }, res);
    assert.equal(res.statusCode, 401);
  });

  it('accepts password from query string', async () => {
    const db = makeMockDb({ sessions: { select: { data: [], error: null } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler({ method: 'GET', url: '/api/sessions?accessPassword=secret&deviceId=d1', body: {} }, res);
    assert.equal(res.statusCode, 200);
  });
});

// ── POST /api/sessions ────────────────────────────────────────────────────────

describe('POST /api/sessions — create session', () => {
  it('creates a session and returns 201', async () => {
    const sessionData = { id: 'sess-1', title: 'First chat', device_id: 'dev-1' };
    const db = makeMockDb({ sessions: { insert: { data: sessionData, error: null } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/sessions', { deviceId: 'dev-1', title: 'First chat' }), res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, sessionData);
  });

  it('passes device_id and title to Supabase insert', async () => {
    const db = makeMockDb({ sessions: { insert: { data: { id: 'sess-1' }, error: null } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/sessions', { deviceId: 'dev-abc', title: 'My session' }), res);
    const call = db.insertCalls.find(c => c.table === 'sessions');
    assert.ok(call, 'expected an insert call on sessions');
    assert.equal(call.rows.device_id, 'dev-abc');
    assert.equal(call.rows.title, 'My session');
  });

  it('returns 500 when Supabase insert fails', async () => {
    const db = makeMockDb({ sessions: { insert: { data: null, error: { message: 'DB error' } } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/sessions'), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'DB error');
  });
});

// ── GET /api/sessions ─────────────────────────────────────────────────────────

describe('GET /api/sessions — list sessions', () => {
  it('returns 200 with session list', async () => {
    const sessions = [{ id: 's1', title: 'Chat 1' }, { id: 's2', title: 'Chat 2' }];
    const db = makeMockDb({ sessions: { select: { data: sessions, error: null } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, sessions);
  });

  it('returns empty array when no sessions exist', async () => {
    const db = makeMockDb({ sessions: { select: { data: [], error: null } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions', { deviceId: 'new-device' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
  });

  it('returns 500 when Supabase select fails', async () => {
    const db = makeMockDb({ sessions: { select: { data: null, error: { message: 'query failed' } } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions'), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'query failed');
  });
});

// ── PATCH /api/sessions/:id ───────────────────────────────────────────────────

describe('PATCH /api/sessions/:id — update session', () => {
  it('returns 200 ok', async () => {
    const db = makeMockDb({ sessions: { update: { data: null, error: null } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('PATCH', '/api/sessions/sess-1', { title: 'New title' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('returns 500 when Supabase update fails', async () => {
    const db = makeMockDb({ sessions: { update: { data: null, error: { message: 'update failed' } } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('PATCH', '/api/sessions/sess-1', { title: 'x' }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'update failed');
  });
});

// ── POST /api/sessions/:id/messages ──────────────────────────────────────────

describe('POST /api/sessions/:id/messages — append messages', () => {
  it('inserts messages and returns 200', async () => {
    const db = makeMockDb({
      messages: { select: { data: [], error: null }, insert: { data: null, error: null } },
      sessions: { update: { data: null, error: null } },
    });
    handler = createSessionsHandler(db);
    const res = makeRes();
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    await handler(makeReq('POST', '/api/sessions/sess-1/messages', { messages, messageCount: 1 }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('stores messages with correct session_id, role, and content', async () => {
    const db = makeMockDb({
      messages: { select: { data: [], error: null }, insert: { data: null, error: null } },
      sessions: { update: { data: null, error: null } },
    });
    handler = createSessionsHandler(db);
    const messages = [{ role: 'user', content: 'Test message' }];
    await handler(makeReq('POST', '/api/sessions/sess-42/messages', { messages, messageCount: 1 }), makeRes());
    const call = db.insertCalls.find(c => c.table === 'messages');
    assert.ok(call, 'expected an insert call on messages');
    assert.equal(call.rows[0].session_id, 'sess-42');
    assert.equal(call.rows[0].role, 'user');
    assert.equal(call.rows[0].content, 'Test message');
  });

  it('serializes non-string content to JSON', async () => {
    const db = makeMockDb({
      messages: { select: { data: [], error: null }, insert: { data: null, error: null } },
      sessions: { update: { data: null, error: null } },
    });
    handler = createSessionsHandler(db);
    const content = [{ type: 'text', text: 'hello' }];
    const messages = [{ role: 'user', content }];
    await handler(makeReq('POST', '/api/sessions/sess-1/messages', { messages, messageCount: 1 }), makeRes());
    const call = db.insertCalls.find(c => c.table === 'messages');
    assert.equal(call.rows[0].content, JSON.stringify(content));
  });

  it('skips insert when messages array is empty', async () => {
    const db = makeMockDb();
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/sessions/sess-1/messages', { messages: [] }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, skipped: true });
    assert.equal(db.insertCalls.length, 0);
  });

  it('skips insert when messages field is missing', async () => {
    const db = makeMockDb();
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/sessions/sess-1/messages', {}), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, skipped: true });
    assert.equal(db.insertCalls.length, 0);
  });

  it('skips duplicate batch — same content as most recent DB message', async () => {
    // Simulate the last message in DB matching the first incoming message.
    // This catches the case where the same exchange is synced twice.
    const db = makeMockDb({
      messages: {
        select: { data: [{ content: 'Hello' }], error: null },
        insert: { data: null, error: null },
      },
      sessions: { update: { data: null, error: null } },
    });
    handler = createSessionsHandler(db);
    const res = makeRes();
    const messages = [
      { role: 'user', content: 'Hello' },      // matches last DB message
      { role: 'assistant', content: 'Hi there' },
    ];
    await handler(makeReq('POST', '/api/sessions/sess-1/messages', { messages, messageCount: 1 }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, skipped: true });
    assert.equal(db.insertCalls.filter(c => c.table === 'messages').length, 0);
  });

  it('inserts when incoming content differs from last DB message', async () => {
    const db = makeMockDb({
      messages: {
        select: { data: [{ content: 'Previous message' }], error: null },
        insert: { data: null, error: null },
      },
      sessions: { update: { data: null, error: null } },
    });
    handler = createSessionsHandler(db);
    const res = makeRes();
    const messages = [{ role: 'user', content: 'New message' }];
    await handler(makeReq('POST', '/api/sessions/sess-1/messages', { messages, messageCount: 1 }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(db.insertCalls.filter(c => c.table === 'messages').length, 1);
  });

  it('inserts normally when session has no prior messages', async () => {
    const db = makeMockDb({
      messages: {
        select: { data: [], error: null },
        insert: { data: null, error: null },
      },
      sessions: { update: { data: null, error: null } },
    });
    handler = createSessionsHandler(db);
    const res = makeRes();
    const messages = [{ role: 'user', content: 'First ever message' }];
    await handler(makeReq('POST', '/api/sessions/sess-1/messages', { messages, messageCount: 1 }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(db.insertCalls.filter(c => c.table === 'messages').length, 1);
  });

  it('returns 500 when Supabase insert fails', async () => {
    const db = makeMockDb({
      messages: {
        select: { data: [], error: null },
        insert: { data: null, error: { message: 'insert failed' } },
      },
      sessions: { update: { data: null, error: null } },
    });
    handler = createSessionsHandler(db);
    const res = makeRes();
    const messages = [{ role: 'user', content: 'Hello' }];
    await handler(makeReq('POST', '/api/sessions/sess-1/messages', { messages }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'insert failed');
  });
});

// ── GET /api/sessions/:id/messages ───────────────────────────────────────────

describe('GET /api/sessions/:id/messages — fetch messages', () => {
  it('returns messages in order', async () => {
    const msgs = [
      { role: 'user', content: 'Hello', created_at: '2024-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Hi!', created_at: '2024-01-01T00:00:01Z' },
    ];
    const db = makeMockDb({ messages: { select: { data: msgs, error: null } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions/sess-1/messages', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, msgs);
  });

  it('returns empty array when session has no messages', async () => {
    const db = makeMockDb({ messages: { select: { data: [], error: null } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions/sess-1/messages'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
  });

  it('returns 500 when Supabase select fails', async () => {
    const db = makeMockDb({ messages: { select: { data: null, error: { message: 'read error' } } } });
    handler = createSessionsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions/sess-1/messages'), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'read error');
  });
});

// ── unknown routes ────────────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for unsupported method/path combination', async () => {
    const res = makeRes();
    await handler(makeReq('DELETE', '/api/sessions/sess-1'), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'Not found');
  });

  it('returns 404 for deeply nested unknown path', async () => {
    const res = makeRes();
    await handler(makeReq('GET', '/api/sessions/sess-1/unknown'), res);
    assert.equal(res.statusCode, 404);
  });
});
