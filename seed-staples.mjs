// Pre-seeds ai-cache.json with AI interpretations for the most popular
// Commander cards, so a typical EDH game rarely hits a card that needs
// analysis mid-setup — without going anywhere near "analyze all of
// Scryfall" (see the README section this script is documented under for why
// that's a bad idea: ~25-30k unique card texts, most of which nobody will
// ever play, at real API cost, needing periodic re-validation as cards get
// errata'd).
//
// "Staples" here means Scryfall's own edhrec_rank field — the live,
// continuously-updated EDHREC inclusion ranking — not a hardcoded list, so
// running this again in six months picks up however the meta has shifted.
// Just like a real deck, most of what comes back (Sol Ring, basic-effect
// removal, ramp spells) is already understood by the regex patterns for
// free; only genuinely unusual wording ever reaches the AI, via the same
// needsAI() filter server.mjs uses for a pasted decklist.
//
// Usage:
//   export XAI_API_KEY=your-key-here
//   node seed-staples.mjs [count]      # default 750

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { normalize } from './src/scryfall.js';
import { analyzeCards } from './server/analyzeDeck.mjs';
import { loadCache, saveCache } from '../mtg-oracle-ai/cache.mjs';
import { interpretCardWithAI } from '../mtg-oracle-ai/interpretCard.mjs';

const AI_CACHE_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'ai-cache.json');
const COUNT = Number(process.argv[2]) || 750;
const CONCURRENCY = Number(process.env.AI_CONCURRENCY) || 10;

async function fetchTopEDHRECCards(count) {
  const cards = [];
  let url = 'https://api.scryfall.com/cards/search?'
    + new URLSearchParams({ q: 'legal:commander -is:basic game:paper', order: 'edhrec', dir: 'asc' });

  while (url && cards.length < count) {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'mtg-game' } });
    if (!res.ok) throw new Error(`Scryfall search failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    for (const raw of data.data) {
      cards.push(normalize(raw));
      if (cards.length >= count) break;
    }
    url = data.has_more ? data.next_page : null;
  }
  return cards;
}

if (!process.env.XAI_API_KEY) {
  console.error('XAI_API_KEY is not set. Get one at https://console.x.ai, then:\n  export XAI_API_KEY=your-key-here\n  node seed-staples.mjs');
  process.exit(1);
}

console.log(`Fetching the top ${COUNT} Commander cards by EDHREC rank from Scryfall...`);
const cards = await fetchTopEDHRECCards(COUNT);
console.log(`Fetched ${cards.length} card(s).`);

const cache = await loadCache(AI_CACHE_PATH);
let lastPrinted = -1;
await analyzeCards(cards, {
  cache,
  interpretFn: interpretCardWithAI,
  concurrency: CONCURRENCY,
  onProgress: (msg) => {
    if (msg.type === 'start') {
      console.log(msg.total > 0
        ? `${msg.total} card(s) need AI interpretation (the rest are already regex-covered or already cached).`
        : 'Nothing new to analyze — every card here is already regex-covered or cached.');
    } else if (msg.type === 'progress' && msg.done !== lastPrinted) {
      lastPrinted = msg.done;
      process.stdout.write(`\r${msg.done}/${msg.total} — ${msg.name}`.padEnd(80));
    } else if (msg.type === 'error') {
      console.log(`\nFAILED: ${msg.name}: ${msg.message}`);
    }
  },
  checkpoint: (c) => saveCache(AI_CACHE_PATH, c),
});
await saveCache(AI_CACHE_PATH, cache);
console.log(`\nDone. ai-cache.json now has ${Object.keys(cache).length} card interpretation(s) total.`);
