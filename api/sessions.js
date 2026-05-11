import supabase from '../lib/supabase.js';

function authorized(password) {
  return process.env.ACCESS_PASSWORD && password === process.env.ACCESS_PASSWORD;
}

export function createSessionsHandler(db) {
  return async function sessionsHandler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.replace(/\/api\/sessions\/?/, '').split('/').filter(Boolean);
    // parts: []               → /api/sessions
    // parts: ['id']           → /api/sessions/:id
    // parts: ['id','messages'] → /api/sessions/:id/messages

    const password = req.body?.accessPassword || url.searchParams.get('accessPassword');
    if (!authorized(password)) return res.status(401).json({ error: 'Unauthorized' });

    const deviceId = req.body?.deviceId || url.searchParams.get('deviceId');

    try {
      // POST /api/sessions — create a session
      if (req.method === 'POST' && parts.length === 0) {
        const { data, error } = await db
          .from('sessions')
          .insert({ device_id: deviceId, title: req.body.title || null })
          .select()
          .single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
      }

      // GET /api/sessions — list sessions for this device
      if (req.method === 'GET' && parts.length === 0) {
        const { data, error } = await db
          .from('sessions')
          .select('id, title, started_at, last_active_at, message_count, summary')
          .eq('device_id', deviceId)
          .order('last_active_at', { ascending: false })
          .limit(50);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      }

      // PATCH /api/sessions/:id — update title / last_active_at
      if (req.method === 'PATCH' && parts.length === 1) {
        const updates = { last_active_at: new Date().toISOString() };
        if (req.body.title !== undefined) updates.title = req.body.title;
        if (req.body.message_count !== undefined) updates.message_count = req.body.message_count;
        const { error } = await db.from('sessions').update(updates).eq('id', parts[0]);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }

      // POST /api/sessions/:id/messages — append messages to a session
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'messages') {
        const { messages, messageCount } = req.body;

        // Guard: nothing to insert
        if (!Array.isArray(messages) || messages.length === 0) {
          return res.status(200).json({ ok: true, skipped: true });
        }

        // Duplicate guard: fetch the most recent message for this session and
        // compare its content to the first message we're about to insert.
        // If they match, this is a repeated sync of the same batch — skip it.
        const { data: recent } = await db
          .from('messages')
          .select('content')
          .eq('session_id', parts[0])
          .order('created_at', { ascending: false })
          .limit(1);

        const firstIncoming = typeof messages[0].content === 'string'
          ? messages[0].content
          : JSON.stringify(messages[0].content);

        if (recent?.length && recent[0].content === firstIncoming) {
          return res.status(200).json({ ok: true, skipped: true });
        }

        const rows = messages.map(m => ({
          session_id: parts[0],
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }));

        const { error: insertErr } = await db.from('messages').insert(rows);
        if (insertErr) return res.status(500).json({ error: insertErr.message });

        await db.from('sessions').update({
          last_active_at: new Date().toISOString(),
          ...(messageCount !== undefined && { message_count: messageCount }),
        }).eq('id', parts[0]);

        return res.status(200).json({ ok: true });
      }

      // GET /api/sessions/:id/messages — fetch all messages for a session
      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'messages') {
        const { data, error } = await db
          .from('messages')
          .select('role, content, created_at')
          .eq('session_id', parts[0])
          .order('created_at', { ascending: true });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      }

      return res.status(404).json({ error: 'Not found' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  };
}

export default createSessionsHandler(supabase);
