import supabase from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accessPassword, sessionId, messages, userName } = req.body;

  if (!process.env.ACCESS_PASSWORD || accessPassword !== process.env.ACCESS_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured' });

  const name = userName || 'the user';

  const transcript = (messages || [])
    .filter(m => typeof m.content === 'string')
    .slice(-10)
    .map(m => `${m.role === 'user' ? name : 'Coach'}: ${m.content.slice(0, 400)}`)
    .join('\n');

  if (!transcript) return res.status(200).json({ summary: '' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: `Summarize AI coaching sessions in exactly 2 sentences.
Sentence 1: what ${name} discussed or asked about.
Sentence 2: any specific commitments, action items, or emotional theme.
Be concrete and specific. Past tense. No filler phrases like "In this session".`,
        messages: [{ role: 'user', content: transcript }],
      }),
    });

    const data = await response.json();
    const summary = data.content?.[0]?.text?.trim() || '';

    if (sessionId && summary && supabase) {
      await supabase.from('sessions').update({ summary }).eq('id', sessionId);
    }

    return res.status(200).json({ summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
