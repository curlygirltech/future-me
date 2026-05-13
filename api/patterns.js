import supabase from '../lib/supabase.js';
import { isRateLimited, recordFailure, clearFailures } from '../lib/rateLimit.js';
import { getIp, authorized } from '../lib/auth.js';

export function createPatternsHandler(db) {
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
      // GET /api/patterns — return current patterns for this device
      if (req.method === 'GET') {
        const { data, error } = await db
          .from('patterns')
          .select('themes, struggles, wins, current_focus, session_count, updated_at')
          .eq('device_id', deviceId)
          .single();
        if (error && error.code !== 'PGRST116') return res.status(500).json({ error: 'Database error' });
        return res.status(200).json(data || null);
      }

      // POST /api/patterns — analyze summaries and generate/refresh patterns
      if (req.method === 'POST') {
        // Need enough sessions with summaries before patterns are meaningful
        const { data: sessions } = await db
          .from('sessions')
          .select('summary, started_at')
          .eq('device_id', deviceId)
          .is('deleted_at', null)
          .order('started_at', { ascending: false })
          .limit(20);

        const withSummary = (sessions || []).filter(s => s.summary);
        if (withSummary.length < 3) {
          return res.status(200).json({ skipped: true, reason: 'Not enough sessions yet' });
        }

        // Throttle: only regenerate once every 24 hours
        const { data: existing } = await db
          .from('patterns')
          .select('updated_at')
          .eq('device_id', deviceId)
          .single();

        if (existing?.updated_at) {
          const hoursOld = (Date.now() - new Date(existing.updated_at).getTime()) / 36e5;
          if (hoursOld < 24) {
            return res.status(200).json({ skipped: true, reason: 'Patterns recently updated' });
          }
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'Server misconfigured' });

        const transcript = withSummary
          .map(s => `[${new Date(s.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}] ${s.summary}`)
          .join('\n');

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            system: `Analyze these AI coaching session summaries and return ONLY valid JSON with exactly this shape — no explanation, no markdown, just the JSON object:
{
  "themes": ["2-4 short phrases for recurring topics"],
  "struggles": ["1-3 specific recurring sticking points"],
  "wins": ["1-3 specific things with positive momentum"],
  "current_focus": "one sentence describing what they seem to be building toward right now"
}`,
            messages: [{
              role: 'user',
              content: `Session summaries:\n\n${transcript}\n\nIdentify the patterns.`,
            }],
          }),
        });

        const apiData = await response.json();
        const text = apiData.content?.[0]?.text || '{}';

        let parsed = {};
        try {
          const match = text.match(/\{[\s\S]*\}/);
          parsed = match ? JSON.parse(match[0]) : {};
        } catch { /* keep empty */ }

        const record = {
          device_id: deviceId,
          themes: parsed.themes || [],
          struggles: parsed.struggles || [],
          wins: parsed.wins || [],
          current_focus: parsed.current_focus || '',
          session_count: withSummary.length,
          updated_at: new Date().toISOString(),
        };

        await db.from('patterns').upsert(record, { onConflict: 'device_id' });
        return res.status(200).json(record);
      }

      return res.status(405).json({ error: 'Method not allowed' });
    } catch {
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export default createPatternsHandler(supabase);
