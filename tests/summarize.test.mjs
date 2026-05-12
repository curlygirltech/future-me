import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeRes, makeReq, makeMockDb } from './helpers.mjs';
import { createSummarizeHandler } from '../api/summarize.js';

let handler;

beforeEach(() => {
  process.env.ACCESS_PASSWORD = 'secret';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  handler = createSummarizeHandler(makeMockDb());
});

afterEach(() => {
  delete process.env.ACCESS_PASSWORD;
  delete process.env.ANTHROPIC_API_KEY;
  mock.restoreAll();
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('returns 200 for OPTIONS and sets CORS headers', async () => {
    const res = makeRes();
    await handler(makeReq('OPTIONS', '/api/summarize'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  });

  it('returns 405 for GET', async () => {
    const res = makeRes();
    await handler(makeReq('GET', '/api/summarize'), res);
    assert.equal(res.statusCode, 405);
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 with wrong password', async () => {
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize', {}, { 'x-access-password': 'bad' }), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with no ACCESS_PASSWORD env var', async () => {
    delete process.env.ACCESS_PASSWORD;
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize'), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 500 when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize', {
      messages: [{ role: 'user', content: 'Hello' }],
    }), res);
    assert.equal(res.statusCode, 500);
  });
});

// ── Empty / degenerate input ──────────────────────────────────────────────────

describe('Empty transcript', () => {
  it('returns { summary: "" } when messages array is empty', async () => {
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize', { messages: [] }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.summary, '');
  });

  it('returns { summary: "" } when no messages field is provided', async () => {
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize', {}), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.summary, '');
  });

  it('skips non-string message content', async () => {
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.summary, '');
  });
});

// ── Successful summarization ──────────────────────────────────────────────────

describe('POST /api/summarize — generate and store summary', () => {
  it('calls Anthropic and returns the summary', async () => {
    globalThis.fetch = mock.fn(async () => ({
      json: async () => ({ content: [{ text: 'Naya discussed pricing. She committed to raising her rates.' }] }),
    }));
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize', {
      sessionId: 'sess-1',
      messages: [
        { role: 'user', content: 'I struggle with pricing' },
        { role: 'assistant', content: 'Let\'s work through that.' },
      ],
      userName: 'Naya',
    }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.summary.includes('Naya'));
  });

  it('uses Haiku model', async () => {
    let capturedBody;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { json: async () => ({ content: [{ text: 'Summary.' }] }) };
    });
    await handler(makeReq('POST', '/api/summarize', {
      messages: [{ role: 'user', content: 'Hello' }],
    }), makeRes());
    assert.ok(capturedBody.model.includes('haiku'), `expected haiku model, got ${capturedBody.model}`);
  });

  it('includes userName in the transcript sent to Anthropic', async () => {
    let capturedBody;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { json: async () => ({ content: [{ text: 'Summary.' }] }) };
    });
    await handler(makeReq('POST', '/api/summarize', {
      messages: [{ role: 'user', content: 'Hello coach' }],
      userName: 'Jovonne',
    }), makeRes());
    assert.ok(capturedBody.messages[0].content.includes('Jovonne'));
  });

  it('stores the summary on the session row when sessionId is provided', async () => {
    const db = makeMockDb({ sessions: { update: { data: null, error: null } } });
    handler = createSummarizeHandler(db);
    globalThis.fetch = mock.fn(async () => ({
      json: async () => ({ content: [{ text: 'She asked about outreach.' }] }),
    }));
    await handler(makeReq('POST', '/api/summarize', {
      sessionId: 'sess-42',
      messages: [{ role: 'user', content: 'How do I do outreach?' }],
    }), makeRes());
    const call = db.updateCalls.find(c => c.table === 'sessions');
    assert.ok(call, 'should have called update on sessions table');
    assert.ok(call.data.summary.length > 0);
  });

  it('does not crash when Anthropic returns no content', async () => {
    globalThis.fetch = mock.fn(async () => ({
      json: async () => ({ content: [] }),
    }));
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize', {
      messages: [{ role: 'user', content: 'Hello' }],
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.summary, '');
  });

  it('returns 500 when fetch throws', async () => {
    globalThis.fetch = mock.fn(async () => { throw new Error('network error'); });
    const res = makeRes();
    await handler(makeReq('POST', '/api/summarize', {
      messages: [{ role: 'user', content: 'Hello' }],
    }), res);
    assert.equal(res.statusCode, 500);
  });
});
