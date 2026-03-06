const https = require('https');
const http = require('http');

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

function request(reqUrl, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(reqUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: postData ? 'POST' : 'GET',
        headers: {
          'User-Agent': 'MenuFinder/1.0',
          'Content-Type': postData ? 'application/json' : 'application/json',
          ...options.headers
        },
        timeout: options.timeout || 20000
      };
      const req = lib.request(opts, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return request(res.headers.location, options, postData).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
          catch { resolve({ status: res.statusCode, body: null, raw: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (postData) req.write(postData);
      req.end();
    } catch(e) { reject(e); }
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

async function parseMenuWithOpenAI(text, name) {
  if (!OPENAI_KEY) return [];
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  try {
    const res = await request('https://api.openai.com/v1/chat/completions', {
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000
    }, JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `Najdi dnešní (${today}) polední/denní menu z tohoto textu české restaurace.
Hledej sekce nazvané: "polední menu", "denní menu", "menu dne", "obědové menu", "dnešní nabídka" nebo podobně.
Vrať POUZE JSON pole. Každá položka: {"name": "název jídla", "price": "cena Kč", "type": "polevka nebo jidlo"}.
Polévky mají type "polevka", ostatní jídla "jidlo".
Pokud žádné denní menu nenajdeš, vrať [].
Restaurace: ${name}
Text: ${text}` }],
      temperature: 0.1,
      max_tokens: 600
    }));
    const content = res.body?.choices?.[0]?.message?.content || '[]';
    const match = content.match(/\[[\s\S]*?\]/);
    if (match) {
      const items = JSON.parse(match[0]);
      return Array.isArray(items) ? items.filter(i => i.name).slice(0, 12) : [];
    }
  } catch(e) {}
  return [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const website = req.query.website ? decodeURIComponent(req.query.website) : '';
  const name = req.query.name ? decodeURIComponent(req.query.name) : '';

  if (!website) { res.status(200).json([]); return; }

  try {
    const pageRes = await request(website, { timeout: 10000, headers: { 'Accept-Language': 'cs,en;q=0.9' } });
    const text = stripHtml(pageRes.raw || '');
    const menu = text ? await parseMenuWithOpenAI(text, name) : [];
    res.status(200).json(menu);
  } catch(e) {
    res.status(200).json([]);
  }
};
