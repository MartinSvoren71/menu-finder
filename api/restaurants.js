const https = require('https');
const http = require('http');

// ── HTTP helper ───────────────────────────────────────────────────────────────

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
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'cs,en;q=0.9',
          'Content-Type': postData ? 'application/x-www-form-urlencoded' : undefined,
          ...options.headers
        },
        timeout: options.timeout || 15000
      };
      // remove undefined headers
      Object.keys(opts.headers).forEach(k => opts.headers[k] === undefined && delete opts.headers[k]);

      const req = lib.request(opts, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
          return request(loc, options, postData).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('latin1'); // menicka uses latin1
          resolve({ status: res.statusCode, raw });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (postData) req.write(postData);
      req.end();
    } catch(e) { reject(e); }
  });
}

// ── Distance ──────────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ── HTML decode latin1 ────────────────────────────────────────────────────────

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

// ── Reverse geocode lat/lng → Czech city slug ─────────────────────────────────

// Map of known Czech city names to menicka.cz slugs
const CITY_SLUGS = {
  'Praha': ['praha-1','praha-2','praha-3','praha-4','praha-5','praha-6','praha-7','praha-8','praha-9','praha-10'],
  'Brno': ['brno'],
  'Ostrava': ['ostrava'],
  'Plzeň': ['plzen'], 'Plzen': ['plzen'],
  'Liberec': ['liberec'],
  'Olomouc': ['olomouc'],
  'České Budějovice': ['ceske-budejovice'],
  'Hradec Králové': ['hradec-kralove'],
  'Pardubice': ['pardubice'],
  'Zlín': ['zlin'],
  'Havířov': ['havirov'],
  'Kladno': ['kladno'],
  'Most': ['most'],
  'Opava': ['opava'],
  'Frýdek-Místek': ['frydek-mistek'],
};

async function getCitySlug(lat, lng) {
  try {
    const res = await request(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'User-Agent': 'MenuFinder/1.0 (contact@example.com)', 'Accept': 'application/json' }, timeout: 8000 }
    );
    const data = JSON.parse(res.raw);
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.municipality || '';
    const cityNorm = city.replace(/\s+/g, '-').toLowerCase()
      .replace(/á/g,'a').replace(/č/g,'c').replace(/ď/g,'d').replace(/é/g,'e')
      .replace(/ě/g,'e').replace(/í/g,'i').replace(/ň/g,'n').replace(/ó/g,'o')
      .replace(/ř/g,'r').replace(/š/g,'s').replace(/ť/g,'t').replace(/ú/g,'u')
      .replace(/ů/g,'u').replace(/ý/g,'y').replace(/ž/g,'z');

    // Check known city slugs
    for (const [name, slugs] of Object.entries(CITY_SLUGS)) {
      const norm = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (city.toLowerCase().includes(norm.toLowerCase()) || norm.toLowerCase().includes(city.toLowerCase())) {
        return slugs;
      }
    }
    // Try direct slug
    return [cityNorm];
  } catch(e) {
    return ['praha-1']; // fallback
  }
}

// ── Scrape menicka.cz city page → list of restaurants with coords ─────────────

async function scrapeMenuickaCity(slug) {
  try {
    const res = await request(`https://www.menicka.cz/${slug}.html`, {}, null);
    const html = res.raw;
    const restaurants = [];

    // JS array format: ['ID', 'Name', 'slug.html', lat, lng, 'icon']
    const re = /\['(\d+)',\s*'([^']+)',\s*'([^']+\.html)',\s*([\d.]+),\s*([\d.]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const [, id, name, slug, lat, lng] = m;
      restaurants.push({
        id,
        name: decodeHtmlEntities(name),
        menickaSlug: slug,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
      });
    }
    return restaurants;
  } catch(e) {
    return [];
  }
}

// ── Scrape a single menicka.cz restaurant page → today's menu ────────────────

async function scrapeMenuickaRestaurant(slug) {
  try {
    const res = await request(`https://www.menicka.cz/${slug}`, {}, null);
    const html = res.raw;

    // Find today's section (first popup-gallery block = today)
    const todayMatch = html.match(/class='popup-gallery'>([\s\S]*?)<\/span>\s*<\/ul>/);
    if (!todayMatch) return [];

    const section = todayMatch[1];
    if (section.includes('nebylo zad') || section.includes('zavřeno') || section.includes('zavreno')) {
      return [];
    }

    const items = [];
    // Extract each li (polevka / jidlo)
    const liRe = /<li class='(jidlo|polevka)'>([\s\S]*?)<\/li>/g;
    let li;
    while ((li = liRe.exec(section)) !== null) {
      const [, type, content] = li;
      const nameMatch = content.match(/<div class='polozka'>([\s\S]*?)<\/div>/);
      const priceMatch = content.match(/<div class='cena'>([\s\S]*?)<\/div>/);
      if (!nameMatch) continue;
      const name = stripTags(nameMatch[1]).replace(/^\d+\.\s*/, ''); // remove "1. " prefix
      const price = priceMatch ? stripTags(priceMatch[1]) : '';
      if (name && !name.includes('zad') && !name.includes('zavr')) {
        items.push({ name, price, type });
      }
    }
    return items;
  } catch(e) {
    return [];
  }
}

// ── OSM fallback for restaurants not on menicka ───────────────────────────────

async function findOsmRestaurants(lat, lng, radius) {
  const query = `[out:json][timeout:20];
(
  node["amenity"="restaurant"](around:${radius},${lat},${lng});
  node["amenity"="cafe"]["cuisine"](around:${radius},${lat},${lng});
  way["amenity"="restaurant"](around:${radius},${lat},${lng});
);
out center body;`;

  try {
    const res = await request(
      'https://overpass-api.de/api/interpreter',
      { timeout: 25000 },
      'data=' + encodeURIComponent(query)
    );
    const data = JSON.parse(res.raw);
    return (data.elements || []).map(elem => {
      const tags = elem.tags || {};
      const name = tags.name;
      if (!name) return null;
      const rlat = elem.type === 'node' ? elem.lat : (elem.center?.lat || lat);
      const rlng = elem.type === 'node' ? elem.lon : (elem.center?.lon || lng);
      let website = tags.website || tags['contact:website'] || tags.url || '';
      if (website && !website.startsWith('http')) website = 'https://' + website;
      return {
        id: 'osm_' + String(elem.id),
        name,
        lat: rlat,
        lng: rlng,
        distance: haversine(lat, lng, rlat, rlng),
        website,
        phone: tags.phone || tags['contact:phone'] || '',
        cuisine: (tags.cuisine || '').replace(/;/g, ', '),
        opening_hours: tags.opening_hours || '',
        menu: [],
        menu_source: '',
        source: 'osm'
      };
    }).filter(Boolean);
  } catch(e) {
    return [];
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseInt(req.query.radius) || 1000;

  if (isNaN(lat) || isNaN(lng)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'lat/lng required' }));
    return;
  }

  try {
    // 1. Get city slugs from reverse geocoding
    const slugs = await getCitySlug(lat, lng);

    // 2. Scrape all menicka city pages in parallel
    const allMenuicka = (await Promise.all(slugs.map(s => scrapeMenuickaCity(s)))).flat();

    // 3. Filter by distance
    const nearby = allMenuicka
      .map(r => ({ ...r, distance: haversine(lat, lng, r.lat, r.lng) }))
      .filter(r => r.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 25);

    // 4. Fetch menus for nearby restaurants in parallel (max 15 concurrent)
    const batch = nearby.slice(0, 15);
    const menus = await Promise.all(
      batch.map(r => scrapeMenuickaRestaurant(r.menickaSlug).catch(() => []))
    );

    const restaurants = batch.map((r, i) => ({
      id: r.id,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      distance: r.distance,
      website: `https://www.menicka.cz/${r.menickaSlug}`,
      phone: '',
      cuisine: '',
      opening_hours: '',
      menu: menus[i],
      menu_source: menus[i].length > 0 ? 'menicka' : '',
      source: 'menicka'
    }));

    // 5. If we got very few menicka results, supplement with OSM
    let allRestaurants = restaurants;
    if (restaurants.length < 5) {
      const osmRestaurants = await findOsmRestaurants(lat, lng, radius);
      const menickaNames = new Set(restaurants.map(r => r.name.toLowerCase()));
      const osmNew = osmRestaurants.filter(r => !menickaNames.has(r.name.toLowerCase()));
      allRestaurants = [...restaurants, ...osmNew.slice(0, 10)];
    }

    res.statusCode = 200;
    res.end(JSON.stringify({
      restaurants: allRestaurants.sort((a, b) => a.distance - b.distance),
      count: allRestaurants.length,
      menicka_available: restaurants.length > 0
    }));
  } catch(e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
};
