import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRes, makeReq, makeMockDb } from './helpers.mjs';
import { createResourcesHandler } from '../api/resources.js';

let handler;

beforeEach(() => {
  process.env.ACCESS_PASSWORD = 'secret';
  handler = createResourcesHandler(makeMockDb());
});

afterEach(() => {
  delete process.env.ACCESS_PASSWORD;
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('returns 200 for OPTIONS and sets CORS headers', async () => {
    const res = makeRes();
    await handler(makeReq('OPTIONS', '/api/resources'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
    assert.ok(res.headers['Access-Control-Allow-Methods'].includes('DELETE'));
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 with wrong password', async () => {
    const res = makeRes();
    await handler(makeReq('GET', '/api/resources', {}, { 'x-access-password': 'bad' }), res);
    assert.equal(res.statusCode, 401);
  });
});

// ── GET /api/resources ────────────────────────────────────────────────────────

describe('GET /api/resources — list resources', () => {
  it('returns resource list', async () => {
    const resources = [
      { id: 'r1', type: 'link', title: 'Great article', content: 'https://example.com', tags: ['mindset'], is_pinned: true },
      { id: 'r2', type: 'note', title: 'My note', content: 'Remember to rest', tags: [], is_pinned: false },
    ];
    const db = makeMockDb({ resources: { select: { data: resources, error: null } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/resources', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, resources);
  });

  it('returns empty array when no resources exist', async () => {
    const db = makeMockDb({ resources: { select: { data: [], error: null } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/resources', { deviceId: 'dev-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
  });

  it('returns 500 on DB error', async () => {
    const db = makeMockDb({ resources: { select: { data: null, error: { message: 'db error' } } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('GET', '/api/resources'), res);
    assert.equal(res.statusCode, 500);
  });
});

// ── POST /api/resources ───────────────────────────────────────────────────────

describe('POST /api/resources — create resource', () => {
  it('creates a link resource and returns 201', async () => {
    const created = { id: 'r-new', type: 'link', title: 'Article', content: 'https://x.com', tags: ['mindset'], is_pinned: false };
    const db = makeMockDb({ resources: { insert: { data: created, error: null } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/resources', {
      deviceId: 'dev-1', type: 'link', title: 'Article', content: 'https://x.com', tags: ['mindset'],
    }), res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, created);
  });

  it('creates a note resource', async () => {
    const created = { id: 'r-note', type: 'note', title: 'My insight', content: 'Price with confidence', tags: [], is_pinned: false };
    const db = makeMockDb({ resources: { insert: { data: created, error: null } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/resources', {
      deviceId: 'dev-1', type: 'note', title: 'My insight', content: 'Price with confidence',
    }), res);
    assert.equal(res.statusCode, 201);
  });

  it('returns 400 when title is missing', async () => {
    const res = makeRes();
    await handler(makeReq('POST', '/api/resources', { type: 'note', content: 'some content' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'title is required');
  });

  it('returns 400 when type is invalid', async () => {
    const res = makeRes();
    await handler(makeReq('POST', '/api/resources', { type: 'video', title: 'Something' }), res);
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error.includes('type must be'));
  });

  it('inserts with correct device_id', async () => {
    const db = makeMockDb({ resources: { insert: { data: { id: 'r1' }, error: null } } });
    handler = createResourcesHandler(db);
    await handler(makeReq('POST', '/api/resources', { deviceId: 'dev-abc', type: 'note', title: 'Test' }), makeRes());
    const call = db.insertCalls.find(c => c.table === 'resources');
    assert.equal(call.rows.device_id, 'dev-abc');
  });

  it('defaults is_pinned to false when not provided', async () => {
    const db = makeMockDb({ resources: { insert: { data: { id: 'r1' }, error: null } } });
    handler = createResourcesHandler(db);
    await handler(makeReq('POST', '/api/resources', { type: 'note', title: 'Test' }), makeRes());
    const call = db.insertCalls.find(c => c.table === 'resources');
    assert.equal(call.rows.is_pinned, false);
  });

  it('returns 500 on DB error', async () => {
    const db = makeMockDb({ resources: { insert: { data: null, error: { message: 'insert failed' } } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('POST', '/api/resources', { type: 'note', title: 'Test' }), res);
    assert.equal(res.statusCode, 500);
  });
});

// ── PATCH /api/resources/:id ──────────────────────────────────────────────────

describe('PATCH /api/resources/:id — update resource', () => {
  it('returns 200 on successful update', async () => {
    const db = makeMockDb({ resources: { update: { data: null, error: null } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('PATCH', '/api/resources/r-1', { title: 'New title' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('can toggle is_pinned', async () => {
    const db = makeMockDb({ resources: { update: { data: null, error: null } } });
    handler = createResourcesHandler(db);
    await handler(makeReq('PATCH', '/api/resources/r-1', { is_pinned: true }), makeRes());
    const call = db.updateCalls.find(c => c.table === 'resources');
    assert.equal(call.data.is_pinned, true);
  });

  it('can update tags array', async () => {
    const db = makeMockDb({ resources: { update: { data: null, error: null } } });
    handler = createResourcesHandler(db);
    await handler(makeReq('PATCH', '/api/resources/r-1', { tags: ['mindset', 'pricing'] }), makeRes());
    const call = db.updateCalls.find(c => c.table === 'resources');
    assert.deepEqual(call.data.tags, ['mindset', 'pricing']);
  });

  it('returns 500 on DB error', async () => {
    const db = makeMockDb({ resources: { update: { data: null, error: { message: 'update failed' } } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('PATCH', '/api/resources/r-1', { title: 'x' }), res);
    assert.equal(res.statusCode, 500);
  });
});

// ── DELETE /api/resources/:id ─────────────────────────────────────────────────

describe('DELETE /api/resources/:id', () => {
  it('returns 200 on successful delete', async () => {
    const db = makeMockDb({ resources: { delete: { data: null, error: null } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('DELETE', '/api/resources/r-1'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('hard-deletes — uses delete() not update()', async () => {
    const db = makeMockDb({ resources: { delete: { data: null, error: null } } });
    handler = createResourcesHandler(db);
    await handler(makeReq('DELETE', '/api/resources/r-1'), makeRes());
    assert.equal(db.deleteCalls.filter(c => c.table === 'resources').length, 1);
    assert.equal(db.updateCalls.filter(c => c.table === 'resources').length, 0);
  });

  it('returns 500 on DB error', async () => {
    const db = makeMockDb({ resources: { delete: { data: null, error: { message: 'delete failed' } } } });
    handler = createResourcesHandler(db);
    const res = makeRes();
    await handler(makeReq('DELETE', '/api/resources/r-1'), res);
    assert.equal(res.statusCode, 500);
  });
});

// ── Unknown routes ────────────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for unsupported path', async () => {
    const res = makeRes();
    await handler(makeReq('GET', '/api/resources/r-1/something'), res);
    assert.equal(res.statusCode, 404);
  });
});
