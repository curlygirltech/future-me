import supabase from '../lib/supabase.js';
import { isRateLimited, recordFailure, clearFailures } from '../lib/rateLimit.js';

function getIp(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

function authorized(req) {
  const pw = req.headers?.['x-access-password'];
  return !!(process.env.ACCESS_PASSWORD && pw === process.env.ACCESS_PASSWORD);
}

export function createResourcesHandler(db) {
  return async function handler(req, res) {
    const origin = process.env.ALLOWED_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-access-password');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.replace(/\/api\/resources\/?/, '').split('/').filter(Boolean);
    // parts: []    → /api/resources
    // parts: ['id'] → /api/resources/:id

    const ip = getIp(req);
    if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
    if (!authorized(req)) { recordFailure(ip); return res.status(401).json({ error: 'Unauthorized' }); }
    clearFailures(ip);

    const deviceId = req.body?.deviceId || url.searchParams.get('deviceId');

    try {
      // GET /api/resources — list all resources for this device
      if (req.method === 'GET' && parts.length === 0) {
        const { data, error } = await db
          .from('resources')
          .select('id, type, title, content, tags, is_pinned, created_at, updated_at')
          .eq('device_id', deviceId)
          .order('is_pinned', { ascending: false })
          .order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(200).json(data);
      }

      // POST /api/resources — create a resource
      if (req.method === 'POST' && parts.length === 0) {
        const { type, title, content, tags, is_pinned } = req.body;
        if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
        if (!['link', 'note'].includes(type)) return res.status(400).json({ error: 'type must be link or note' });

        const { data, error } = await db
          .from('resources')
          .insert({
            device_id: deviceId,
            type,
            title: title.trim(),
            content: content?.trim() || '',
            tags: Array.isArray(tags) ? tags : [],
            is_pinned: Boolean(is_pinned),
          })
          .select()
          .single();
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(201).json(data);
      }

      // PATCH /api/resources/:id — update a resource
      if (req.method === 'PATCH' && parts.length === 1) {
        const updates = { updated_at: new Date().toISOString() };
        if (req.body.title !== undefined) updates.title = req.body.title.trim();
        if (req.body.content !== undefined) updates.content = req.body.content.trim();
        if (req.body.tags !== undefined) updates.tags = req.body.tags;
        if (req.body.is_pinned !== undefined) updates.is_pinned = Boolean(req.body.is_pinned);

        const { error } = await db
          .from('resources')
          .update(updates)
          .eq('id', parts[0])
          .eq('device_id', deviceId);
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(200).json({ ok: true });
      }

      // DELETE /api/resources/:id
      if (req.method === 'DELETE' && parts.length === 1) {
        const { error } = await db
          .from('resources')
          .delete()
          .eq('id', parts[0])
          .eq('device_id', deviceId);
        if (error) return res.status(500).json({ error: 'Database error' });
        return res.status(200).json({ ok: true });
      }

      return res.status(404).json({ error: 'Not found' });
    } catch {
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export default createResourcesHandler(supabase);
