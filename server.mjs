// Serves Proxy Table's static files (replacing `python3 -m http.server`)
// and adds one API route, POST /api/analyze-deck, that the setup page calls
// right after you paste a decklist. This is the only place an xAI API key
// is ever used — it stays in this Node process's environment and is never
// sent to the browser (see mtg-oracle-ai/README.md for why that split
// exists at all).
//
// Usage:
//   export XAI_API_KEY=your-key-here   # optional — see below
//   node server.mjs
//
// Without XAI_API_KEY set, the server still runs fine: /api/analyze-deck
// immediately reports itself unavailable and the game plays with regex-only
// card support, exactly as it did before this feature existed.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCache, saveCache } from '../mtg-oracle-ai/cache.mjs';
import { interpretCardWithAI } from '../mtg-oracle-ai/interpretCard.mjs';
import { analyzeCards } from './server/analyzeDeck.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const AI_CACHE_PATH = join(ROOT, 'ai-cache.json');
const PORT = Number(process.env.PORT) || 8000;
const CONCURRENCY = Number(process.env.AI_CONCURRENCY) || 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) { // ROOT (from a `new URL('.', ...)`) already ends in a separator
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// Streams newline-delimited JSON progress messages as cards are interpreted,
// so the setup page can show a live "N / total" count instead of a frozen
// screen during what can otherwise be a real wait on a big deck.
async function handleAnalyzeDeck(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const seen = new Set();
  const cards = [];
  for (const c of body.cards || []) {
    if (c && c.name && !seen.has(c.name)) {
      seen.add(c.name);
      cards.push(c);
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  const send = (msg) => res.write(JSON.stringify(msg) + '\n');

  if (!process.env.XAI_API_KEY) {
    send({ type: 'unavailable', reason: 'XAI_API_KEY is not set on the server — playing with regex-only card support.' });
    res.end();
    return;
  }

  try {
    const cache = await loadCache(AI_CACHE_PATH);
    await analyzeCards(cards, {
      cache,
      interpretFn: interpretCardWithAI,
      concurrency: CONCURRENCY,
      onProgress: send,
      checkpoint: (c) => saveCache(AI_CACHE_PATH, c),
    });
    await saveCache(AI_CACHE_PATH, cache);
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
}

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/analyze-deck') {
    await handleAnalyzeDeck(req, res);
    return;
  }
  await serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Proxy Table running at http://localhost:${PORT}`);
  console.log(process.env.XAI_API_KEY
    ? 'AI card interpretation is ON (XAI_API_KEY set).'
    : 'AI card interpretation is OFF (set XAI_API_KEY to enable — see mtg-oracle-ai/README.md).');
});
