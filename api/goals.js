import supabase from '../lib/supabase.js';
import { isRateLimited, recordFailure, clearFailures } from '../lib/rateLimit.js';

function getIp(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

function authorized(req) {
  const pw = req.headers?.['x-access-password'];
  return !!(process.env.ACCESS_PASSWORD && pw === process.env.ACCESS_PASSWORD);
}

export function createGoalsHandler(db) {
  return async function handler(req, res) {
    const origin = process.env.ALLOWED_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-access-password');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = new URL(req.url, 'http://localhost');
    const ip = getIp(req);
    if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
    if (!authorized(req)) { recordFailure(ip); return res.status(401).json({ error: 'Unauthorized' }); }
    clearFailures(ip);

    const deviceId = req.body?.deviceId || url.searchParams.get('deviceId');

    try {
      if (req.method === 'GET') {
        const { data, error } = await db
          .from('goals')
          .select('data, updated_at')
          .eq('device_id', deviceId)
          .single();
        if (error && error.code !== 'PGRST116') return res.status(500).json({ error: 'Database error' });
        return res.status(200).json(data || null);
      }

      if (req.method === 'POST') {
        const { data: goals } = req.body;

        // Snapshot before overwriting — goal evolution tracking. Fire-and-forget.
        db.from('goal_snapshots')
          .insert({ device_id: deviceId, data: goals })
          .then(() => {})
          .catch(() => {});

        const { error } = await db
          .from('goals')
          .upsert(
            { device_id: deviceId, data: goals, updated_at: new Date().toISOString() },
            { onConflict: 'device_id' }
          );
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    } catch {
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export default createGoalsHandler(supabase);
