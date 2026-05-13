import { describe, it, before, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeRes } from './helpers.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { 'x-access-password': 'secret' },
    body: { system: 'You are a coach.', messages: [] },
    ...overrides,
  };
}

function mockFetchSuccess(status = 200, data = { id: 'msg_123', content: [] }) {
  return mock.fn(async () => ({ status, json: async () => data }));
}

// ── setup ─────────────────────────────────────────────────────────────────────

let handler;

before(async () => {
  ({ default: handler } = await import('../api/chat.js'));
});

afterEach(() => {
  delete process.env.ACCESS_PASSWORD;
  delete process.env.ANTHROPIC_API_KEY;
  mock.restoreAll();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('sets CORS headers on every response', async () => {
    const req = makeReq({ method: 'OPTIONS' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(res.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
    assert.ok(res.headers['Access-Control-Allow-Headers'].includes('x-access-password'));
  });
});

describe('HTTP method handling', () => {
  it('returns 200 for OPTIONS preflight', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS' }), res);
    assert.equal(res.statusCode, 200);
  });

  it('returns 405 for GET', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.body.error, 'Method not allowed');
  });
});

describe('Authentication', () => {
  it('returns 401 when no ACCESS_PASSWORD env var is set', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  it('returns 401 when password does not match', async () => {
    process.env.ACCESS_PASSWORD = 'correct';
    const res = makeRes();
    await handler(makeReq({ headers: { 'x-access-password': 'wrong' }, body: { system: '', messages: [] } }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  it('returns 500 when API key is missing but password is correct', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Server misconfigured');
  });
});

describe('Prompt caching', () => {
  it('sends anthropic-beta prompt-caching header', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    await handler(makeReq(), makeRes());

    const [, options] = fetchMock.mock.calls[0].arguments;
    assert.equal(options.headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  });

  it('sends system as two blocks: cached static prompt and uncached time', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    const systemText = 'You are a future coach.';
    await handler(makeReq({ body: { system: systemText, messages: [] } }), makeRes());

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);

    assert.equal(body.system.length, 2);

    // First block: static coaching prompt, cached
    assert.equal(body.system[0].text, systemText);
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });

    // Second block: dynamic time, no cache_control
    assert.ok(body.system[1].text.includes('Eastern Time'));
    assert.equal(body.system[1].cache_control, undefined);
  });

  it('adds cache_control to the last user message', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    const messages = [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'Reply' },
      { role: 'user', content: 'Second message' },
    ];
    await handler(makeReq({ body: { system: 'prompt', messages } }), makeRes());

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);

    // Last user message should have cache_control; earlier messages should not
    const last = body.messages[2];
    assert.ok(Array.isArray(last.content));
    assert.ok(last.content.some(b => b.cache_control?.type === 'ephemeral'));

    const first = body.messages[0];
    assert.equal(typeof first.content, 'string');
  });

  it('does not add cache_control when last message is from assistant', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    await handler(makeReq({ body: { system: 'prompt', messages } }), makeRes());

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);

    const last = body.messages[1];
    assert.equal(typeof last.content, 'string');
  });
});

describe('Anthropic API forwarding', () => {
  it('sends correct model and max_tokens', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const fetchMock = mockFetchSuccess();
    globalThis.fetch = fetchMock;

    await handler(makeReq(), makeRes());

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'claude-sonnet-4-6');
    assert.equal(body.max_tokens, 1024);
  });

  it('forwards the Anthropic API response status and body', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const responseData = { id: 'msg_abc', content: [{ type: 'text', text: 'Hi!' }] };
    globalThis.fetch = mockFetchSuccess(200, responseData);

    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, responseData);
  });

  it('returns 500 when fetch throws', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    globalThis.fetch = mock.fn(async () => { throw new Error('network failure'); });

    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'network failure');
  });

  it('logs token usage when present in response', async () => {
    process.env.ACCESS_PASSWORD = 'secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const usage = { input_tokens: 100, cache_creation_input_tokens: 80, cache_read_input_tokens: 0, output_tokens: 50 };
    globalThis.fetch = mockFetchSuccess(200, { id: 'msg_123', content: [], usage });

    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    await handler(makeReq(), makeRes());
    console.log = orig;

    assert.ok(logs.some(l => l.includes('in=100') && l.includes('created=80') && l.includes('out=50')));
  });
});
