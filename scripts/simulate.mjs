// Headless bot-vs-bot game runner, used to playtest the engine without a
// browser: builds two real decks via Scryfall, plays a full game with both
// seats AI-controlled, and reports the outcome plus anything that looks like
// a bug (a thrown exception, a stalled game, or "isn't modeled" log lines —
// each one is a real card the regex/AI pipeline didn't actually implement).
//
// Usage: node scripts/simulate.mjs <deckA.txt> <deckB.txt> [gamesEach]
//
// If XAI_API_KEY is set, cards the regex interpreter can't handle are also
// run through the same AI interpretation server.mjs/runAudit.mjs use before
// any games are played, so a headless run exercises the exact same
// AI-assisted fallback a real browser game would — not just the regex-only
// path. Without the key, behavior is unchanged (regex-only, as always).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildDeckFromText } from '../src/deck.js';
import { Game } from '../src/game.js';
import { setAICache } from '../src/aiAdapter.js';
import { needsAI, analyzeCards } from '../server/analyzeDeck.mjs';

const AI_CACHE_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'ai-cache.json');

// Analyzes whichever of the given cards actually need it (see needsAI),
// caching results on disk at the same ai-cache.json path server.mjs and
// runAudit.mjs already share, so repeat runs across all three tools only
// ever pay for a genuinely new card once. No-ops entirely if XAI_API_KEY
// isn't set, or if the sibling mtg-oracle-ai project isn't present.
export async function analyzeDeckIfKeyPresent(cards) {
  if (!process.env.XAI_API_KEY) return;
  let interpretCardWithAI, loadCache, saveCache;
  try {
    ({ interpretCardWithAI } = await import('../../mtg-oracle-ai/interpretCard.mjs'));
    ({ loadCache, saveCache } = await import('../../mtg-oracle-ai/cache.mjs'));
  } catch {
    console.warn('  (XAI_API_KEY is set, but ../mtg-oracle-ai isn\'t available — skipping AI interpretation.)');
    return;
  }
  const cache = await loadCache(AI_CACHE_PATH);
  const toAnalyze = cards.filter(c => c && c.name && !cache[c.name] && needsAI(c));
  if (toAnalyze.length) {
    process.stdout.write(`  Analyzing ${toAnalyze.length} card(s) with AI...`);
    await analyzeCards(cards, { cache, interpretFn: interpretCardWithAI, checkpoint: (c) => saveCache(AI_CACHE_PATH, c) });
    await saveCache(AI_CACHE_PATH, cache);
    console.log(' done.');
  }
  setAICache(cache);
}

const MAX_TURNS = 150; // a real stuck/looping game would blow way past this

// The whole bot-vs-bot chain runs on dynamic-import-driven microtasks (see
// game.js's maybeLetAIAct); draining the microtask queue after each nudge is
// enough to let an entire turn (or the whole game) play out.
function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function playOneGame(deckA, deckB, {
  nameA = 'Deck A', nameB = 'Deck B', logToConsole = false,
  commanderMode = false, commanderA = null, commanderB = null, maxTurns = MAX_TURNS,
} = {}) {
  const game = new Game({ deckA, deckB, nameA, nameB, aiControlsA: true, aiControlsB: true, commanderMode, commanderA, commanderB });
  let lastLogLength = 0;
  let stalledTicks = 0;

  for (let i = 0; i < 4000 && !game.gameOver && game.turnNumber <= maxTurns; i++) {
    await drain();
    if (game.logLines.length === lastLogLength) {
      stalledTicks++;
      if (stalledTicks > 5) break; // nothing happening — likely a bug, not just a slow tick
    } else {
      stalledTicks = 0;
      lastLogLength = game.logLines.length;
    }
  }

  if (logToConsole) for (const line of game.logLines) console.log('  ' + line);

  const unmodeled = game.logLines.filter(l => /isn't modeled|needs a color choice|finds no matching land|finds no basic land/i.test(l));
  return {
    completed: game.gameOver,
    hitTurnCap: !game.gameOver && game.turnNumber > maxTurns,
    stalled: !game.gameOver && game.turnNumber <= maxTurns,
    winner: game.gameOver ? game.getPlayer(game.winner)?.name : null,
    turns: game.turnNumber,
    unmodeledEvents: unmodeled,
    finalLife: Object.fromEntries(game.players.map(p => [p.name, p.life])),
    logLines: game.logLines,
  };
}

async function loadDeck(path) {
  const text = await readFile(path, 'utf8');
  const { deck, unresolved } = await buildDeckFromText(text);
  if (unresolved.length) console.warn(`  (unresolved in ${path}: ${unresolved.join(', ')})`);
  return deck;
}

// CLI entry point — only runs when this file is executed directly, so
// playOneGame/loadDeck can also be imported by a batch-runner script.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , pathA, pathB, gamesArg] = process.argv;
  if (!pathA || !pathB) {
    console.error('Usage: node scripts/simulate.mjs <deckA.txt> <deckB.txt> [gamesEach]');
    process.exit(1);
  }
  const games = Number(gamesArg) || 1;

  const [deckA, deckB] = await Promise.all([loadDeck(pathA), loadDeck(pathB)]);
  console.log(`Loaded ${deckA.length}-card deck A (${pathA}) and ${deckB.length}-card deck B (${pathB}). Playing ${games} game(s)...\n`);
  await analyzeDeckIfKeyPresent([...deckA, ...deckB]);

  let wins = { A: 0, B: 0, none: 0 };
  for (let i = 0; i < games; i++) {
    let result;
    try {
      result = await playOneGame(deckA, deckB, { nameA: 'Deck A', nameB: 'Deck B' });
    } catch (err) {
      console.error(`Game ${i + 1}: CRASHED — ${err.stack}`);
      wins.none++;
      continue;
    }
    if (result.winner === 'Deck A') wins.A++;
    else if (result.winner === 'Deck B') wins.B++;
    else wins.none++;

    console.log(`Game ${i + 1}: ${result.completed ? `${result.winner} wins` : (result.hitTurnCap ? 'hit turn cap' : 'STALLED')} in ${result.turns} turns. Final life: ${JSON.stringify(result.finalLife)}`);
    if (result.unmodeledEvents.length) {
      console.log(`  ${result.unmodeledEvents.length} unmodeled-effect log line(s):`);
      for (const line of [...new Set(result.unmodeledEvents)]) console.log(`    - ${line}`);
    }
  }

  console.log(`\nOverall: Deck A won ${wins.A}, Deck B won ${wins.B}, no winner ${wins.none} (of ${games}).`);
}
