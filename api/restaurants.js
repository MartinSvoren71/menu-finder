const https = require('https');
const http = require('http');

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
          'User-Agent': 'MenuFinder/1.0',
          'Content-Type': postData ? 'application/x-www-form-urlencoded' : 'application/json',
          ...options.headers
        },
        timeout: options.timeout || 25000
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const { lat: latStr, lng: lngStr, radius: radiusStr } = req.query;
  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);
  const radius = parseInt(radiusStr) || 1000;

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: 'lat/lng required' });
    return;
  }

  try {
    const [restaurants, menicka] = await Promise.all([
      findRestaurants(lat, lng, radius).catch(() => []),
      getMenicka(lat, lng).catch(() => null)
    ]);

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

    res.status(200).json({ restaurants, count: restaurants.length, menicka_available: !!menicka });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
