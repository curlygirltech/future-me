import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRes, makeReq, makeMockDb } from './helpers.mjs';
import { createGoalsHandler } from '../api/goals.js';

let handler;

beforeEach(() => {
  process.env.ACCESS_PASSWORD = 'secret';
  handler = createGoalsHandler(makeMockDb());
});

afterEach(() => {
  delete process.env.ACCESS_PASSWORD;
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('returns 200 for OPTIONS and sets CORS headers', async () => {
    const res = makeRes();
    await handler(makeReq('OPTIONS', '/api/goals'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
    assert.ok(res.headers['Access-Control-Allow-Methods'].includes('POST'));
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 with wrong password', async () => {
    const res = makeRes();
    await handler(makeReq('GET', '/api/goals', {}, { 'x-access-password': 'wrong' }), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with no ACCESS_PASSWORD env var', async () => {
    delete process.env.ACCESS_PASSWORD;
    const res = makeRes();
    await handler(makeReq('GET', '/api/goals'), res);
    assert.equal(res.statusCode, 401);
  });

  it('accepts password from x-access-password header', async () => {
    const db = makeMockDb({ goals: { select: { data: null, error: { code: 'PGRST116' } } } });
    handler = createGoalsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/goals?deviceId=dev-1', {}, { 'x-access-password': 'secret' }), res);
    assert.equal(res.statusCode, 200);
  });
});

// ── GET /api/goals ────────────────────────────────────────────────────────────

describe('GET /api/goals — retrieve goals', () => {
  it('returns null when no goals exist yet (PGRST116)', async () => {
    const db = makeMockDb({ goals: { select: { data: null, error: { code: 'PGRST116' } } } });
    handler = createGoalsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/goals', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, null);
  });

  it('returns existing goals object', async () => {
    const goals = { data: { name: 'Naya', goal: 'Earn $100K' }, updated_at: '2026-01-01T00:00:00Z' };
    const db = makeMockDb({ goals: { select: { data: goals, error: null } } });
    handler = createGoalsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/goals', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, goals);
  });

  it('returns 500 on unexpected DB error', async () => {
    const db = makeMockDb({ goals: { select: { data: null, error: { message: 'db error', code: 'OTHER' } } } });
    handler = createGoalsHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/goals', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 500);
  });
});

// ── POST /api/goals ───────────────────────────────────────────────────────────

describe('POST /api/goals — save goals', () => {
  it('returns 200 with { ok: true } on success', async () => {
    const db = makeMockDb({
      goals: { insert: { data: null, error: null } },
      goal_snapshots: { insert: { data: null, error: null } },
    });
    handler = createGoalsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/goals', {
      deviceId: 'dev-1',
      data: { name: 'Naya', goal: 'Earn $100K' },
    }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('upserts goals with device_id', async () => {
    const db = makeMockDb({
      goals: { insert: { data: null, error: null } },
      goal_snapshots: { insert: { data: null, error: null } },
    });
    handler = createGoalsHandler(db);
    await handler(makeReq('POST', '/api/goals', {
      deviceId: 'dev-abc',
      data: { goal: 'Freedom' },
    }), makeRes());
    const call = db.insertCalls.find(c => c.table === 'goals');
    assert.equal(call.rows.device_id, 'dev-abc');
    assert.deepEqual(call.rows.data, { goal: 'Freedom' });
  });

  it('fires a snapshot insert to goal_snapshots', async () => {
    const db = makeMockDb({
      goals: { insert: { data: null, error: null } },
      goal_snapshots: { insert: { data: null, error: null } },
    });
    handler = createGoalsHandler(db);
    await handler(makeReq('POST', '/api/goals', {
      deviceId: 'dev-1',
      data: { goal: 'Travel the world' },
    }), makeRes());
    // Give the fire-and-forget a tick to resolve
    await new Promise(r => setImmediate(r));
    const snap = db.insertCalls.find(c => c.table === 'goal_snapshots');
    assert.ok(snap, 'should have inserted a goal snapshot');
    assert.equal(snap.rows.device_id, 'dev-1');
  });

  it('returns 500 when goals upsert fails', async () => {
    const db = makeMockDb({
      goals: { insert: { data: null, error: { message: 'upsert failed' } } },
      goal_snapshots: { insert: { data: null, error: null } },
    });
    handler = createGoalsHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/goals', { deviceId: 'dev-1', data: {} }), res);
    assert.equal(res.statusCode, 500);
  });

  it('returns 405 for unsupported methods', async () => {
    const res = makeRes();
    await handler(makeReq('DELETE', '/api/goals'), res);
    assert.equal(res.statusCode, 405);
  });
});
