export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accessPassword, system, messages } = req.body;

  if (!process.env.ACCESS_PASSWORD || accessPassword !== process.env.ACCESS_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfigured' });

  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' });

  // 1. Split system into two blocks: static (cached) + dynamic time (uncached).
  //    The static coaching prompt never changes so Anthropic can serve it from cache.
  //    The time block changes every minute so it must stay outside the cache.
  const systemBlocks = [
    { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `The current date and time is ${now} (Eastern Time).` },
  ];

  // 2. Cache conversation history by marking the last user message.
  //    Everything before it gets served from cache on the next turn (~90% cheaper).
  const cachedMessages = messages.map((msg, i) => {
    const isLastUser = i === messages.length - 1 && msg.role === 'user';
    if (!isLastUser) return msg;
    const content = Array.isArray(msg.content)
      ? [...msg.content, { type: 'text', text: '', cache_control: { type: 'ephemeral' } }]
      : [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
    return { ...msg, content };
  });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemBlocks,
        messages: cachedMessages,
      }),
    });

    const data = await response.json();

    // 3. Log token usage so we can verify caching is working.
    if (data.usage) {
      const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = data.usage;
      console.log(
        `[tokens] in=${input_tokens} created=${cache_creation_input_tokens ?? 0} read=${cache_read_input_tokens ?? 0} out=${output_tokens}`
      );
    }

    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
