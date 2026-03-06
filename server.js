const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 5000;

// Optional: set OPENAI_API_KEY env var for AI menu parsing
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

// Local Ollama (only used when running on your own machine)
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi3:mini';

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

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
          'User-Agent': 'MenuFinder/1.0 (github.com)',
          'Content-Type': postData ? 'application/x-www-form-urlencoded' : 'application/json',
          ...options.headers
        },
        timeout: options.timeout || 25000
      };
      const req = lib.request(opts, res => {
        // Follow redirect
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

// ── Restaurant finder via Overpass API ────────────────────────────────────────

async function findRestaurants(lat, lng, radius = 1000) {
  const query = `[out:json][timeout:25];
(
  node["amenity"="restaurant"](around:${radius},${lat},${lng});
  node["amenity"="cafe"]["cuisine"](around:${radius},${lat},${lng});
  way["amenity"="restaurant"](around:${radius},${lat},${lng});
  way["amenity"="cafe"]["cuisine"](around:${radius},${lat},${lng});
);
out center body;`;

  const res = await request(
    'https://overpass-api.de/api/interpreter',
    { timeout: 30000 },
    'data=' + encodeURIComponent(query)
  );

  const restaurants = [];
  for (const elem of (res.body?.elements || [])) {
    const tags = elem.tags || {};
    const name = tags.name;
    if (!name) continue;

    const rlat = elem.type === 'node' ? elem.lat : (elem.center?.lat || lat);
    const rlng = elem.type === 'node' ? elem.lon : (elem.center?.lon || lng);

    let website = tags.website || tags['contact:website'] || tags.url || '';
    if (website && !website.startsWith('http')) website = 'https://' + website;

    restaurants.push({
      id: String(elem.id),
      name,
      lat: rlat,
      lng: rlng,
      distance: haversine(lat, lng, rlat, rlng),
      website,
      phone: tags.phone || tags['contact:phone'] || '',
      cuisine: (tags.cuisine || '').replace(/;/g, ', '),
      opening_hours: tags.opening_hours || '',
      menu: [],
      menu_source: ''
    });
  }

  return restaurants.sort((a, b) => a.distance - b.distance).slice(0, 30);
}

// ── Menicka.cz – Czech daily menu aggregator ──────────────────────────────────

async function getMenicka(lat, lng) {
  try {
    const res = await request(
      `https://api.menicka.cz/public/get-menus?lat=${lat}&lng=${lng}&range=1500&types=1`,
      { timeout: 12000 }
    );
    if (res.status === 200 && res.body) {
      return Array.isArray(res.body) ? res.body : (res.body.restaurants || res.body.data || null);
    }
  } catch(e) {}
  return null;
}

// ── AI menu parsing ───────────────────────────────────────────────────────────

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
      messages: [{
        role: 'user',
        content: `Extract today's (${today}) daily lunch menu items from this restaurant website text.
Return ONLY a JSON array. Each item: {"name": "...", "price": "... Kč"}.
If no daily menu found, return [].
Restaurant: ${name}
Text: ${text}`
      }],
      temperature: 0.1,
      max_tokens: 500
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

async function parseMenuWithOllama(text, name) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  try {
    const res = await request(OLLAMA_URL + '/api/generate', { timeout: 30000 }, JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: `Extract today's (${today}) daily lunch menu from this restaurant text.
Return ONLY a JSON array: [{"name":"...","price":"..."}]. If none found, return [].
Restaurant: ${name}
Text: ${text}
JSON:`,
      stream: false,
      options: { temperature: 0.1, num_predict: 400 }
    }));
    const response = res.body?.response || '';
    const match = response.match(/\[[\s\S]*?\]/);
    if (match) {
      const items = JSON.parse(match[0]);
      return Array.isArray(items) ? items.filter(i => i.name).slice(0, 12) : [];
    }
  } catch(e) {}
  return [];
}

async function fetchAndParseMenu(website, name) {
  if (!website) return [];
  try {
    const res = await request(website, { timeout: 10000, headers: { 'Accept-Language': 'cs,en;q=0.9' } });
    const text = stripHtml(res.raw || '');
    if (!text) return [];

    // Try OpenAI first (if key set), then local Ollama
    const menu = OPENAI_KEY
      ? await parseMenuWithOpenAI(text, name)
      : await parseMenuWithOllama(text, name);
    return menu;
  } catch(e) { return []; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
}

async function handleRestaurants(req, res, query) {
  const lat = parseFloat(query.lat);
  const lng = parseFloat(query.lng);
  const radius = parseInt(query.radius) || 1000;

  if (isNaN(lat) || isNaN(lng)) {
    cors(res); res.writeHead(400); res.end(JSON.stringify({ error: 'lat/lng required' })); return;
  }

  const [restaurants, menicka] = await Promise.all([
    findRestaurants(lat, lng, radius).catch(() => []),
    getMenicka(lat, lng).catch(() => null)
  ]);

  // Inject menicka menus
  if (menicka && Array.isArray(menicka)) {
    for (const r of restaurants) {
      const m = menicka.find(m =>
        (m.name || '').toLowerCase().includes(r.name.toLowerCase().slice(0, 6)) ||
        r.name.toLowerCase().includes((m.name || '').toLowerCase().slice(0, 6))
      );
      if (m?.food?.length) {
        r.menu = (m.food || []).map((item, i) => ({
          name: item,
          price: (m.price || [])[i] || ''
        }));
        r.menu_source = 'menicka';
      }
    }
  }

  cors(res); res.writeHead(200);
  res.end(JSON.stringify({ restaurants, count: restaurants.length, menicka_available: !!menicka }));
}

async function handleMenu(req, res, query) {
  const website = decodeURIComponent(query.website || '');
  const name = decodeURIComponent(query.name || '');
  const menu = website ? await fetchAndParseMenu(website, name) : [];
  cors(res); res.writeHead(200);
  res.end(JSON.stringify(menu));
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.ico': 'image/x-icon' };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  if (p === '/api/restaurants') return handleRestaurants(req, res, parsed.query).catch(e => { cors(res); res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
  if (p === '/api/menu') return handleMenu(req, res, parsed.query).catch(e => { cors(res); res.writeHead(500); res.end('[]'); });
  if (p === '/' || p === '/index.html') return serveStatic(res, path.join(__dirname, 'public', 'index.html'));

  serveStatic(res, path.join(__dirname, 'public', p));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🍽️  MenuFinder → http://0.0.0.0:${PORT}`);
  console.log(`   AI: ${OPENAI_KEY ? 'OpenAI (gpt-4o-mini)' : OLLAMA_URL ? 'Ollama (local)' : 'disabled'}`);
});
