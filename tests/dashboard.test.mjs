import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRes, makeReq, makeMockDb } from './helpers.mjs';
import { createDashboardHandler, computeStreak } from '../api/dashboard.js';

let handler;

beforeEach(() => {
  process.env.ACCESS_PASSWORD = 'secret';
  handler = createDashboardHandler(makeMockDb());
});

afterEach(() => {
  delete process.env.ACCESS_PASSWORD;
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('returns 200 for OPTIONS and sets CORS headers', async () => {
    const res = makeRes();
    await handler(makeReq('OPTIONS', '/api/dashboard'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  });

  it('returns 405 for POST', async () => {
    const res = makeRes();
    await handler(makeReq('POST', '/api/dashboard'), res);
    assert.equal(res.statusCode, 405);
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 with wrong password', async () => {
    const res = makeRes();
    await handler(makeReq('GET', '/api/dashboard', { accessPassword: 'bad' }), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with no ACCESS_PASSWORD env var', async () => {
    delete process.env.ACCESS_PASSWORD;
    const res = makeRes();
    await handler(makeReq('GET', '/api/dashboard'), res);
    assert.equal(res.statusCode, 401);
  });
});

// ── computeStreak (unit) ──────────────────────────────────────────────────────

describe('computeStreak', () => {
  it('returns 0 for empty sessions', () => {
    assert.equal(computeStreak([]), 0);
  });

  it('returns 1 for a single session today', () => {
    const today = new Date().toISOString();
    assert.equal(computeStreak([{ started_at: today }]), 1);
  });

  it('returns 1 for a single session yesterday', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    assert.equal(computeStreak([{ started_at: yesterday }]), 1);
  });

  it('returns 0 if most recent session was 2+ days ago', () => {
    const old = new Date(Date.now() - 2 * 86400000).toISOString();
    assert.equal(computeStreak([{ started_at: old }]), 0);
  });

  it('counts consecutive days correctly', () => {
    const sessions = [0, 1, 2].map(d => ({
      started_at: new Date(Date.now() - d * 86400000).toISOString(),
    }));
    assert.equal(computeStreak(sessions), 3);
  });

  it('stops counting at a gap', () => {
    const sessions = [0, 1, 3].map(d => ({
      started_at: new Date(Date.now() - d * 86400000).toISOString(),
    }));
    assert.equal(computeStreak(sessions), 2);
  });

  it('deduplicates multiple sessions on the same day', () => {
    const today = new Date().toISOString();
    const todayEarlier = new Date(Date.now() - 3600000).toISOString();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    assert.equal(computeStreak([
      { started_at: today },
      { started_at: todayEarlier },
      { started_at: yesterday },
    ]), 2);
  });
});

// ── GET /api/dashboard ────────────────────────────────────────────────────────

describe('GET /api/dashboard', () => {
  it('returns streak, patterns, and recentSessions', async () => {
    const today = new Date().toISOString();
    const sessions = [
      { id: 's1', title: 'First session', summary: 'Discussed pricing.', started_at: today },
    ];
    const patterns = {
      themes: ['pricing', 'outreach'],
      struggles: ['putting myself out there'],
      wins: ['landed first client'],
      current_focus: 'Building pipeline',
    };
    const db = makeMockDb({
      sessions: { select: { data: sessions, error: null } },
      patterns: { select: { data: patterns, error: null } },
    });
    handler = createDashboardHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/dashboard', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.streak, 1);
    assert.deepEqual(res.body.patterns, patterns);
    assert.equal(res.body.recentSessions.length, 1);
    assert.equal(res.body.recentSessions[0].summary, 'Discussed pricing.');
  });

  it('returns null patterns when none exist yet', async () => {
    const db = makeMockDb({
      sessions: { select: { data: [], error: null } },
      patterns: { select: { data: null, error: { code: 'PGRST116', message: 'not found' } } },
    });
    handler = createDashboardHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/dashboard', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.patterns, null);
    assert.equal(res.body.streak, 0);
  });

  it('excludes sessions without a summary from recentSessions', async () => {
    const today = new Date().toISOString();
    const sessions = [
      { id: 's1', title: 'Chat 1', summary: null, started_at: today },
      { id: 's2', title: 'Chat 2', summary: 'Worked on outreach.', started_at: today },
    ];
    const db = makeMockDb({
      sessions: { select: { data: sessions, error: null } },
      patterns: { select: { data: null, error: { code: 'PGRST116', message: 'not found' } } },
    });
    handler = createDashboardHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/dashboard', { deviceId: 'dev-1' }), res);
    assert.equal(res.body.recentSessions.length, 1);
    assert.equal(res.body.recentSessions[0].id, 's2');
  });

  it('caps recentSessions at 5', async () => {
    const today = new Date().toISOString();
    const sessions = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`, title: `Session ${i}`, summary: `Summary ${i}.`, started_at: today,
    }));
    const db = makeMockDb({
      sessions: { select: { data: sessions, error: null } },
      patterns: { select: { data: null, error: { code: 'PGRST116', message: 'not found' } } },
    });
    handler = createDashboardHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/dashboard', { deviceId: 'dev-1' }), res);
    assert.equal(res.body.recentSessions.length, 5);
  });

  it('returns 500 on sessions DB error', async () => {
    const db = makeMockDb({
      sessions: { select: { data: null, error: { message: 'db failure' } } },
      patterns: { select: { data: null, error: { code: 'PGRST116', message: 'not found' } } },
    });
    handler = createDashboardHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/dashboard', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 500);
  });
});
