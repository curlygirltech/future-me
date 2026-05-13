import supabase from '../lib/supabase.js';
import { isRateLimited, recordFailure, clearFailures } from '../lib/rateLimit.js';
import { getIp, authorized } from '../lib/auth.js';

export function createSessionsHandler(db) {
  return async function sessionsHandler(req, res) {
    const origin = process.env.ALLOWED_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-access-password');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.replace(/\/api\/sessions\/?/, '').split('/').filter(Boolean);
    // parts: []                → /api/sessions
    // parts: ['id']            → /api/sessions/:id
    // parts: ['id','messages'] → /api/sessions/:id/messages

    const ip = getIp(req);
    if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
    if (!authorized(req)) { recordFailure(ip); return res.status(401).json({ error: 'Unauthorized' }); }
    clearFailures(ip);

    const deviceId = req.body?.deviceId || url.searchParams.get('deviceId');

    try {
      // POST /api/sessions — create a session
      if (req.method === 'POST' && parts.length === 0) {
        const { data, error } = await db
          .from('sessions')
          .insert({ device_id: deviceId, title: req.body.title || null, category: req.body.category || null })
          .select()
          .single();
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(201).json(data);
      }

      // GET /api/sessions — list for this device; archived=true returns archived, else active only
      if (req.method === 'GET' && parts.length === 0) {
        const showArchived = url.searchParams.get('archived') === 'true';
        const { data, error } = await db
          .from('sessions')
          .select('id, title, started_at, last_active_at, message_count, summary, archived_at, category')
          .eq('device_id', deviceId)
          .is('deleted_at', null)
          .eq('is_archived', showArchived)
          .order('last_active_at', { ascending: false })
          .limit(50);
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(200).json(data);
      }

      // PATCH /api/sessions/:id — rename, archive/unarchive, or update metadata
      if (req.method === 'PATCH' && parts.length === 1) {
        const updates = { last_active_at: new Date().toISOString() };
        if (req.body.title !== undefined) updates.title = req.body.title;
        if (req.body.message_count !== undefined) updates.message_count = req.body.message_count;
        if (req.body.archived === true) {
          updates.is_archived = true;
          updates.archived_at = new Date().toISOString();
        }
        if (req.body.archived === false) {
          updates.is_archived = false;
          updates.archived_at = null;
        }
        if (req.body.category !== undefined) updates.category = req.body.category;
        const { error } = await db.from('sessions').update(updates).eq('id', parts[0]);
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(200).json({ ok: true });
      }

      // DELETE /api/sessions/:id — soft-delete
      if (req.method === 'DELETE' && parts.length === 1) {
        const { error } = await db
          .from('sessions')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', parts[0]);
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(200).json({ ok: true });
      }

      // POST /api/sessions/:id/messages — append messages to a session
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'messages') {
        const { messages, messageCount } = req.body;

        if (!Array.isArray(messages) || messages.length === 0) {
          return res.status(200).json({ ok: true, skipped: true });
        }

        // Duplicate guard: skip if incoming batch matches the most recent saved message
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
        if (insertErr) return res.status(500).json({ error: 'Database error' });

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
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(200).json(data);
      }

      return res.status(404).json({ error: 'Not found' });
    } catch {
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export default createSessionsHandler(supabase);
