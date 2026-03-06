# 🍽️ Daily Menu Finder

Find restaurants near you and browse their **daily lunch menus** — powered by OpenStreetMap, menicka.cz (Czech daily menus), and optional AI parsing.

## Features

- 📍 **Auto-location** via browser geolocation
- 🗺️ **Restaurant discovery** via OpenStreetMap (Overpass API) — no API key needed
- 🇨🇿 **Czech daily menus** via menicka.cz integration
- 🤖 **AI menu parsing** — scrapes restaurant websites and extracts food+price with AI
- 🎨 Beautiful dark dashboard with cards, distance badges, and live loading

## Live Demo

[https://menu-finder.vercel.app](https://menu-finder.vercel.app) *(or your deployed URL)*

## Run Locally

```bash
node server.js
```

Open http://localhost:5000

### With AI menu parsing (optional)

```bash
OPENAI_API_KEY=sk-... node server.js      # Use OpenAI gpt-4o-mini
OLLAMA_URL=http://localhost:11434 node server.js  # Use local Ollama
```

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/yourusername/menu-finder)

## Stack

- **Backend**: Node.js (zero dependencies)
- **Frontend**: Vanilla HTML/CSS/JS
- **Data**: OpenStreetMap Overpass API + menicka.cz
- **AI**: OpenAI gpt-4o-mini or local Ollama (optional)
