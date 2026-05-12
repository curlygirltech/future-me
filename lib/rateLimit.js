const failed = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX = 10;

export function isRateLimited(ip) {
  if (process.env.NODE_ENV === 'test') return false;
  const e = failed.get(ip);
  if (!e || Date.now() > e.resetAt) { failed.delete(ip); return false; }
  return e.count >= MAX;
}

export function recordFailure(ip) {
  if (process.env.NODE_ENV === 'test') return;
  const now = Date.now();
  let e = failed.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > e.resetAt) e = { count: 0, resetAt: now + WINDOW_MS };
  e.count++;
  failed.set(ip, e);
}

export function clearFailures(ip) {
  failed.delete(ip);
}
