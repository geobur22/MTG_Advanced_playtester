// Full "analyze every card, play real games, check what actually fired"
// audit pipeline:
//   1. Fetch both decks (+ commanders, if any) from Scryfall.
//   2. Call the AI on EVERY unique card (not just ones the regex engine
//      already fails on — needsAI's filter is for efficiency during normal
//      play, not for this audit, which wants ground truth for every card),
//      merging results into ai-cache.json so the real engine's AI fallback
//      also benefits.
//   3. Load that cache the same way play.js does, and play several real
//      bot-vs-bot games.
//   4. For every unique card that actually showed up in a game (drawn and
//      cast/played — not just sitting in the library the whole time),
//      cross-reference its full AI-identified ability list against what the
//      engine actually dispatches/implements (scripts/lib/auditCard.mjs).
//   5. Print a findings report grouped by status, so the "not-dispatched"
//      and "unsupported" abilities are the actual worklist for what to add
//      to effects.js/game.js next.
//
// Usage:
//   XAI_API_KEY=... node scripts/runAudit.mjs <deckA.txt> [commanderA] <deckB.txt> [commanderB] [games]
// Commander name args are optional — omit both to audit a constructed (non-Commander) matchup.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildDeckFromText } from '../src/deck.js';
import { fetchCardsByName } from '../src/scryfall.js';
import { loadAICache } from '../src/aiAdapter.js';
import { interpretCardWithAI } from '../../mtg-oracle-ai/interpretCard.mjs';
import { loadCache, saveCache } from '../../mtg-oracle-ai/cache.mjs';
import { playOneGame } from './simulate.mjs';
import { auditCardAbilities } from './lib/auditCard.mjs';

const AI_CACHE_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'ai-cache.json');
const SERVER_URL = process.env.PROXY_TABLE_URL || 'http://localhost:8000';

function parseArgs(argv) {
  // Positional args where the two commander names are optional: a "commander
  // name" arg is any arg that doesn't end in .txt, taken in order between
  // the two deck paths and after the second.
  const args = argv.slice(2);
  const deckPaths = args.filter(a => a.endsWith('.txt'));
  if (deckPaths.length !== 2) {
    console.error('Usage: node scripts/runAudit.mjs <deckA.txt> [commanderA] <deckB.txt> [commanderB] [games]');
    process.exit(1);
  }
  const [deckAPath, deckBPath] = deckPaths;
  const idxA = args.indexOf(deckAPath);
  const idxB = args.indexOf(deckBPath);
  const commanderA = (idxB - idxA === 2) ? args[idxA + 1] : null;
  const rest = args.slice(idxB + 1);
  const commanderB = rest.length && !/^\d+$/.test(rest[0]) ? rest[0] : null;
  const games = Number(args[args.length - 1]) > 0 && /^\d+$/.test(args[args.length - 1]) ? Number(args[args.length - 1]) : 5;
  return { deckAPath, deckBPath, commanderA, commanderB, games };
}

async function loadDeck(path) {
  const text = await readFile(path, 'utf8');
  const { deck, unresolved } = await buildDeckFromText(text);
  if (unresolved.length) console.warn(`  (unresolved in ${path}: ${unresolved.join(', ')})`);
  return deck;
}

async function loadCommander(name) {
  if (!name) return null;
  const { cards, notFound } = await fetchCardsByName([name]);
  if (notFound.length) throw new Error(`Commander not found on Scryfall: "${name}"`);
  return cards.get(name);
}

async function main() {
  const { deckAPath, deckBPath, commanderA: cmdAName, commanderB: cmdBName, games } = parseArgs(process.argv);
  const commanderMode = !!(cmdAName || cmdBName);

  console.log(`Loading decks: ${deckAPath}${cmdAName ? ` (commander: ${cmdAName})` : ''} vs ${deckBPath}${cmdBName ? ` (commander: ${cmdBName})` : ''}`);
  const [deckA, deckB, commanderA, commanderB] = await Promise.all([
    loadDeck(deckAPath), loadDeck(deckBPath), loadCommander(cmdAName), loadCommander(cmdBName),
  ]);

  // ---------- 1. AI-analyze every unique card, unconditionally ----------
  const allCards = new Map();
  for (const c of [...deckA, ...deckB, commanderA, commanderB]) {
    if (c && !allCards.has(c.name)) allCards.set(c.name, c);
  }
  console.log(`\nAnalyzing all ${allCards.size} unique cards via AI (ground truth for the audit — bypasses the normal needsAI efficiency filter)...`);

  if (!process.env.XAI_API_KEY) {
    console.error('XAI_API_KEY is not set — this audit needs real AI ground truth for every card, not just the regex-gap fallback. Aborting.');
    process.exit(1);
  }

  const cache = await loadCache(AI_CACHE_PATH);
  const cardList = [...allCards.values()];
  const CONCURRENCY = Number(process.env.AI_CONCURRENCY) || 10;
  let done = 0, idx = 0;
  async function worker() {
    while (idx < cardList.length) {
      const card = cardList[idx++];
      if (cache[card.name]) { done++; continue; } // already analyzed in a prior run
      try {
        cache[card.name] = await interpretCardWithAI(card);
      } catch (err) {
        console.warn(`  FAILED to analyze ${card.name}: ${err.message}`);
      }
      done++;
      if (done % 5 === 0) { await saveCache(AI_CACHE_PATH, cache); process.stdout.write(`\r  ${done}/${cardList.length}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cardList.length) }, worker));
  await saveCache(AI_CACHE_PATH, cache);
  console.log(`\r  ${done}/${cardList.length} — done.`);

  // ---------- 2. Load that cache the way play.js does, then play real games ----------
  await loadAICache(`${SERVER_URL}/ai-cache.json`);

  console.log(`\nPlaying ${games} game(s)...`);
  const seenCardNames = new Set();
  let wins = { A: 0, B: 0, none: 0 };
  for (let i = 0; i < games; i++) {
    let result;
    try {
      result = await playOneGame(deckA, deckB, {
        nameA: 'Deck A', nameB: 'Deck B',
        commanderMode, commanderA, commanderB,
        maxTurns: commanderMode ? 200 : 150,
      });
    } catch (err) {
      console.error(`Game ${i + 1}: CRASHED — ${err.stack}`);
      wins.none++;
      continue;
    }
    if (result.winner === 'Deck A') wins.A++;
    else if (result.winner === 'Deck B') wins.B++;
    else wins.none++;
    console.log(`  Game ${i + 1}: ${result.completed ? `${result.winner} wins` : 'no winner'} in ${result.turns} turns.`);

    // "Played" = mentioned in a way that means it was actually cast/entered
    // the battlefield, not just sitting in a hand or library the whole game.
    for (const name of allCards.keys()) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(casts ${escaped}\\b|${escaped} enters the battlefield)`).test(result.logLines.join('\n'))) {
        seenCardNames.add(name);
      }
    }
  }
  console.log(`Overall: A won ${wins.A}, B won ${wins.B}, no winner ${wins.none} (of ${games}).`);
  console.log(`\n${seenCardNames.size} of ${allCards.size} unique cards were actually played across these games.`);

  // ---------- 3. Audit every played card's full ability list ----------
  const findingsByStatus = { 'not-dispatched': [], unsupported: [] };
  for (const name of seenCardNames) {
    const card = allCards.get(name);
    const aiEntry = cache[name];
    if (!aiEntry) continue;
    for (const finding of auditCardAbilities(card, aiEntry)) {
      if (finding.status === 'implemented') continue;
      findingsByStatus[finding.status].push({ card: name, ...finding });
    }
  }

  console.log(`\n=== NOT DISPATCHED (engine has no code path for this ability type at all) — ${findingsByStatus['not-dispatched'].length} finding(s) ===`);
  for (const f of findingsByStatus['not-dispatched']) {
    console.log(`  [${f.type}${f.label ? ` "${f.label}"` : ''}] ${f.card}: ${f.text}`);
    console.log(`    → ${f.reason}`);
  }

  console.log(`\n=== DISPATCHED BUT UNSUPPORTED (engine looks at it, has no real effect) — ${findingsByStatus.unsupported.length} finding(s) ===`);
  for (const f of findingsByStatus.unsupported) {
    console.log(`  [${f.type}${f.label ? ` "${f.label}"` : ''}] ${f.card}: ${f.text}`);
    console.log(`    → ${f.reason}`);
  }
}

main();
