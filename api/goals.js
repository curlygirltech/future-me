import supabase from '../lib/supabase.js';

function authorized(password) {
  return process.env.ACCESS_PASSWORD && password === process.env.ACCESS_PASSWORD;
}

export function createGoalsHandler(db) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = new URL(req.url, 'http://localhost');
    const password = req.body?.accessPassword || url.searchParams.get('accessPassword');
    if (!authorized(password)) return res.status(401).json({ error: 'Unauthorized' });

    const deviceId = req.body?.deviceId || url.searchParams.get('deviceId');

    try {
      if (req.method === 'GET') {
        const { data, error } = await db
          .from('goals')
          .select('data, updated_at')
          .eq('device_id', deviceId)
          .single();
        if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
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
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  };
}

export default createGoalsHandler(supabase);
