// Automated interpreter-gap worklist: plays every preset deck (the same
// PRESET_DECKS array the setup screen's dropdown uses, so this always stays
// in sync with whatever's selectable in the real game — see presets.js) in
// a round-robin of pairings, and aggregates every distinct "this effect
// isn't modeled"/safety-cap/cascade-cap log line seen across all of them
// into one deduped report — a concrete backlog of what to add to
// effects.js/game.js next, instead of having to notice these one at a time
// while manually playtesting.
//
// If XAI_API_KEY is set, decks are run through the same AI interpretation
// server.mjs/runAudit.mjs use first (see analyzeDeckIfKeyPresent in
// simulate.mjs), so what's left in the report is a genuine gap neither the
// regex interpreter NOR the AI fallback could resolve — not just something
// AI would have caught if it had been asked.
//
// Usage: node scripts/findGaps.mjs [gamesPerMatchup]

import { buildDeckFromText } from '../src/deck.js';
import { fetchCardsByName } from '../src/scryfall.js';
import { PRESET_DECKS } from '../src/presets.js';
import { playOneGame, analyzeDeckIfKeyPresent } from './simulate.mjs';

const GAMES_PER_MATCHUP = Number(process.argv[2]) || 4;

const ERROR_LOG_PATTERNS = [
  /isn't modeled in detail yet/i,
  /needs a color choice/i,
  /finds no matching land/i,
  /finds no basic land/i,
  /hit the action safety cap/i,
  /cascade got \d+ deep/i,
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Scryfall's /cards/collection rate-limits bursty callers (429) — 25 decks
// loaded back-to-back with zero delay hits that even one at a time, so this
// retries with backoff instead of just letting the whole run die on it.
async function withRetry(fn, label) {
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!/429/.test(err.message) || attempt === MAX_ATTEMPTS) throw err;
      const delay = attempt * 5000;
      console.warn(`  (rate-limited loading ${label}, retrying in ${delay}ms...)`);
      await sleep(delay);
    }
  }
}

async function loadPreset(preset) {
  const { deck, unresolved } = await withRetry(() => buildDeckFromText(preset.deckText), preset.name);
  if (unresolved.length) console.warn(`  (unresolved in ${preset.name}: ${unresolved.join(', ')})`);
  let commander = null;
  if (preset.commanderName) {
    await sleep(800);
    const { cards, notFound } = await withRetry(() => fetchCardsByName([preset.commanderName]), preset.commanderName);
    if (notFound.length) console.warn(`  (commander not found: ${preset.commanderName})`);
    else commander = cards.get(preset.commanderName);
  }
  await sleep(800);
  return { name: preset.name, deck, commander };
}

console.log(`Loading ${PRESET_DECKS.length} preset deck(s)...`);
// Sequential, not Promise.all — 25 decks' worth of concurrent Scryfall
// /cards/collection calls (each already batches up to 75 names) trips
// Scryfall's own rate limit (429) when fired all at once.
const loaded = [];
for (const preset of PRESET_DECKS) loaded.push(await loadPreset(preset));
await analyzeDeckIfKeyPresent(loaded.flatMap(l => [...l.deck, ...(l.commander ? [l.commander] : [])]));

// Consecutive pairing (0v1, 2v3, ...) covers every deck exactly once per
// pass rather than everyone always facing the same fixed opponent, which
// would only ever exercise that opponent's own card pool as the "other side
// of the board" for triggers/removal to interact with.
const pairs = [];
for (let i = 0; i + 1 < loaded.length; i += 2) pairs.push([loaded[i], loaded[i + 1]]);
if (loaded.length % 2 === 1) pairs.push([loaded[loaded.length - 1], loaded[0]]); // odd one out plays the first deck

const findings = new Map(); // normalized line -> { count, examples: Set<matchup> }
let crashes = 0, stalls = 0;

for (const [a, b] of pairs) {
  const commanderMode = !!(a.commander || b.commander);
  console.log(`\n${a.name}  vs  ${b.name}${commanderMode ? ' (Commander)' : ''} — ${GAMES_PER_MATCHUP} game(s)`);
  for (let i = 0; i < GAMES_PER_MATCHUP; i++) {
    let result;
    try {
      result = await playOneGame(a.deck, b.deck, {
        nameA: a.name, nameB: b.name,
        commanderMode, commanderA: a.commander, commanderB: b.commander,
        maxTurns: commanderMode ? 200 : 150,
      });
    } catch (err) {
      crashes++;
      console.error(`  CRASHED: ${err.message}`);
      continue;
    }
    if (!result.completed && !result.hitTurnCap) stalls++;
    for (const line of result.logLines) {
      if (!ERROR_LOG_PATTERNS.some(p => p.test(line))) continue;
      // Strip anything after the first colon-ish clause and any specific
      // numbers, so "X's effect isn't modeled..." dedupes across games even
      // when a trailing amount/name differs slightly.
      const key = line.replace(/\d+/g, 'N').trim();
      if (!findings.has(key)) findings.set(key, { count: 0, examples: new Set() });
      const f = findings.get(key);
      f.count++;
      f.examples.add(`${a.name} vs ${b.name}`);
    }
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`Gap report: ${findings.size} distinct issue(s), ${crashes} crash(es), ${stalls} stall(s), across ${pairs.length} matchup(s) x ${GAMES_PER_MATCHUP} game(s).`);
console.log('='.repeat(70));
const sorted = [...findings.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [line, info] of sorted) {
  console.log(`\n[${info.count}x] ${line}`);
  console.log(`    seen in: ${[...info.examples].slice(0, 3).join(', ')}${info.examples.size > 3 ? ', ...' : ''}`);
}
if (!sorted.length && !crashes && !stalls) console.log('\nNo gaps found in this pass — every preset deck ran clean.');
