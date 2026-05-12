import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeRes, makeReq, makeChain, makeMockDb } from './helpers.mjs';
import { createPatternsHandler } from '../api/patterns.js';

let handler;

beforeEach(() => {
  process.env.ACCESS_PASSWORD = 'secret';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  handler = createPatternsHandler(makeMockDb());
});

afterEach(() => {
  delete process.env.ACCESS_PASSWORD;
  delete process.env.ANTHROPIC_API_KEY;
  mock.restoreAll();
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('returns 200 for OPTIONS preflight', async () => {
    const res = makeRes();
    await handler(makeReq('OPTIONS', '/api/patterns'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 with wrong password', async () => {
    const res = makeRes();
    await handler(makeReq('GET', '/api/patterns', {}, { 'x-access-password': 'bad' }), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with no ACCESS_PASSWORD env var', async () => {
    delete process.env.ACCESS_PASSWORD;
    const res = makeRes();
    await handler(makeReq('GET', '/api/patterns'), res);
    assert.equal(res.statusCode, 401);
  });
});

// ── GET /api/patterns ─────────────────────────────────────────────────────────

describe('GET /api/patterns — retrieve patterns', () => {
  it('returns null when no patterns exist yet', async () => {
    const db = makeMockDb({ patterns: { select: { data: null, error: { code: 'PGRST116' } } } });
    handler = createPatternsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/patterns'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, null);
  });

  it('returns existing patterns', async () => {
    const patterns = { themes: ['pricing'], struggles: ['outreach'], wins: ['first client'], current_focus: 'Growing' };
    const db = makeMockDb({ patterns: { select: { data: patterns, error: null } } });
    handler = createPatternsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/patterns'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, patterns);
  });

  it('returns 500 on DB error', async () => {
    const db = makeMockDb({ patterns: { select: { data: null, error: { message: 'db error', code: 'OTHER' } } } });
    handler = createPatternsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/patterns'), res);
    assert.equal(res.statusCode, 500);
  });
});

// ── POST /api/patterns — analyze & generate ───────────────────────────────────

describe('POST /api/patterns — pattern analysis', () => {
  it('skips when fewer than 3 sessions have summaries', async () => {
    const db = makeMockDb({
      sessions: { select: { data: [{ summary: 'One session', started_at: new Date().toISOString() }], error: null } },
      patterns: { select: { data: null, error: { code: 'PGRST116' } } },
    });
    handler = createPatternsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/patterns', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, true);
    assert.ok(res.body.reason.includes('enough'));
  });

  it('skips when patterns were updated within the last 24 hours', async () => {
    const recentUpdate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
    const sessions = Array.from({ length: 4 }, (_, i) => ({
      summary: `Session ${i + 1} summary`,
      started_at: new Date().toISOString(),
    }));
    const db = makeMockDb({
      sessions: { select: { data: sessions, error: null } },
      patterns: { select: { data: { updated_at: recentUpdate }, error: null } },
    });
    handler = createPatternsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/patterns', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, true);
    assert.ok(res.body.reason.includes('recently'));
  });

  it('calls Anthropic and stores patterns when conditions are met', async () => {
    const oldUpdate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      summary: `Session ${i + 1}: worked on pricing and outreach`,
      started_at: new Date(Date.now() - i * 86400000).toISOString(),
    }));
    const apiResponse = {
      themes: ['pricing', 'outreach'],
      struggles: ['putting myself out there'],
      wins: ['landed first client'],
      current_focus: 'Building pipeline',
    };
    const db = makeMockDb({
      sessions: { select: { data: sessions, error: null } },
      patterns: {
        select: { data: { updated_at: oldUpdate }, error: null },
        insert: { data: null, error: null },
      },
    });
    handler = createPatternsHandler(db);
    globalThis.fetch = mock.fn(async () => ({
      json: async () => ({ content: [{ text: JSON.stringify(apiResponse) }] }),
    }));

    const res = makeRes();
    await handler(makeReq('POST', '/api/patterns', { deviceId: 'dev-1' }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.themes, apiResponse.themes);
    assert.deepEqual(res.body.struggles, apiResponse.struggles);
    assert.equal(res.body.session_count, 5);
    assert.ok(res.body.updated_at);
  });

  it('handles malformed JSON from Anthropic gracefully', async () => {
    const oldUpdate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const sessions = Array.from({ length: 3 }, (_, i) => ({
      summary: `Summary ${i + 1}`,
      started_at: new Date().toISOString(),
    }));
    const db = makeMockDb({
      sessions: { select: { data: sessions, error: null } },
      patterns: { select: { data: { updated_at: oldUpdate }, error: null }, insert: { data: null, error: null } },
    });
    handler = createPatternsHandler(db);
    globalThis.fetch = mock.fn(async () => ({
      json: async () => ({ content: [{ text: 'not valid json at all' }] }),
    }));

    const res = makeRes();
    await handler(makeReq('POST', '/api/patterns', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    // Should still store a record with empty arrays
    assert.ok(Array.isArray(res.body.themes));
  });

  it('returns 405 for unsupported methods', async () => {
    const res = makeRes();
    await handler(makeReq('DELETE', '/api/patterns'), res);
    assert.equal(res.statusCode, 405);
  });
});
