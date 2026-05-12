import supabase from '../lib/supabase.js';

function authorized(password) {
  return process.env.ACCESS_PASSWORD && password === process.env.ACCESS_PASSWORD;
}

export function computeStreak(sessions) {
  const days = [...new Set(
    sessions.map(s => s.started_at.slice(0, 10))
  )].sort().reverse();

  if (days.length === 0) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  if (days[0] !== today && days[0] !== yesterday) return 0;

  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]);
    const curr = new Date(days[i]);
    const diff = (prev - curr) / 86400000;
    if (diff === 1) streak++;
    else break;
  }
  return streak;
}

export function createDashboardHandler(db) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const url = new URL(req.url, 'http://localhost');
    const password = req.body?.accessPassword || url.searchParams.get('accessPassword');
    if (!authorized(password)) return res.status(401).json({ error: 'Unauthorized' });

    const deviceId = req.body?.deviceId || url.searchParams.get('deviceId');

    try {
      const [sessionsResult, patternsResult] = await Promise.all([
        db.from('sessions')
          .select('id, title, summary, started_at')
          .eq('device_id', deviceId)
          .is('deleted_at', null)
          .eq('is_archived', false)
          .order('started_at', { ascending: false })
          .limit(30),
        db.from('patterns')
          .select('themes, struggles, wins, current_focus, updated_at')
          .eq('device_id', deviceId)
          .single(),
      ]);

      if (sessionsResult.error) {
        return res.status(500).json({ error: sessionsResult.error.message });
      }

      const sessions = sessionsResult.data || [];
      const patterns = patternsResult.error ? null : patternsResult.data;

      return res.status(200).json({
        streak: computeStreak(sessions),
        patterns,
        recentSessions: sessions.filter(s => s.summary).slice(0, 5),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  };
}

export default createDashboardHandler(supabase);
