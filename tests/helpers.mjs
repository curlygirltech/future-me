/**
 * Testy — shared test utilities for Future Me
 *
 * Testy's job: run every *.test.mjs file in this directory before anything ships.
 * She verifies that API handlers behave correctly in isolation (no real network, no real DB).
 * Future agents add their handler, drop a *.test.mjs file here, and import from this file.
 *
 * Convention:
 *   - All test files live in tests/ and are named *.test.mjs
 *   - Run with: npm test  (runs all test files via node --test)
 *   - Each file tests one handler; unit tests only — no real Supabase, no real Anthropic
 */

// ── Mock response builder ────────────────────────────────────────────────────

export function makeRes() {
  const res = { headers: {}, statusCode: null, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status    = (code)  => { res.statusCode = code; return res; };
  res.json      = (data)  => { res.body = data; return res; };
  res.end       = ()      => res;
  return res;
}

// ── Mock request builder ─────────────────────────────────────────────────────

export function makeReq(method, url, body = {}) {
  return { method, url, body: { accessPassword: 'secret', ...body } };
}

// ── Supabase mock chain ──────────────────────────────────────────────────────
//
// Every method call returns a new chainable that resolves to `result` when awaited.
// Supports arbitrary Supabase method sequences: .from().select().eq().order().limit()

export function makeChain(result = { data: null, error: null }) {
  const chain = {
    select: () => makeChain(result),
    insert: () => makeChain(result),
    update: () => makeChain(result),
    delete: () => makeChain(result),
    eq:     () => makeChain(result),
    neq:    () => makeChain(result),
    is:     () => makeChain(result),
    order:  () => makeChain(result),
    limit:  () => makeChain(result),
    single: () => makeChain(result),
    upsert: () => makeChain(result),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch:  (reject)          => Promise.resolve(result).catch(reject),
  };
  return chain;
}

// ── Mock Supabase client ─────────────────────────────────────────────────────
//
// tableResponses: { tableName: { insert, select, update, delete } }
// Each value is a { data, error } object.
// db.insertCalls, db.updateCalls, db.deleteCalls record arguments for assertion.

export function makeMockDb(tableResponses = {}) {
  const insertCalls = [];
  const updateCalls = [];
  const deleteCalls = [];

  const db = {
    insertCalls,
    updateCalls,
    deleteCalls,
    from(table) {
      const t = tableResponses[table] || {};
      return {
        insert(rows) {
          insertCalls.push({ table, rows });
          return makeChain(t.insert ?? { data: null, error: null });
        },
        select()  { return makeChain(t.select  ?? { data: [], error: null }); },
        update(data) {
          updateCalls.push({ table, data });
          return makeChain(t.update  ?? { data: null, error: null });
        },
        delete() {
          deleteCalls.push({ table });
          return makeChain(t.delete  ?? { data: null, error: null });
        },
        upsert(data) {
          insertCalls.push({ table, rows: data });
          return makeChain(t.insert  ?? { data: null, error: null });
        },
      };
    },
  };
  return db;
}
