// Bot-vs-bot Commander-format game runner — same idea as simulate.mjs, but
// each side also gets a named commander (fetched separately from Scryfall,
// kept out of the 99-card library) cast from the command zone.
//
// Usage: node scripts/simulate-commander.mjs <deckA.txt> "Commander A" <deckB.txt> "Commander B" [gamesEach]

import { readFile } from 'node:fs/promises';
import { buildDeckFromText } from '../src/deck.js';
import { fetchCardsByName } from '../src/scryfall.js';
import { playOneGame, analyzeDeckIfKeyPresent } from './simulate.mjs';

async function loadDeck(path) {
  const text = await readFile(path, 'utf8');
  const { deck, unresolved } = await buildDeckFromText(text);
  if (unresolved.length) console.warn(`  (unresolved in ${path}: ${unresolved.join(', ')})`);
  return deck;
}

async function loadCommander(name) {
  const { cards, notFound } = await fetchCardsByName([name]);
  if (notFound.length) throw new Error(`Commander not found on Scryfall: ${name}`);
  return cards.get(name);
}

const [, , pathA, commanderNameA, pathB, commanderNameB, gamesArg] = process.argv;
if (!pathA || !commanderNameA || !pathB || !commanderNameB) {
  console.error('Usage: node scripts/simulate-commander.mjs <deckA.txt> "Commander A" <deckB.txt> "Commander B" [gamesEach]');
  process.exit(1);
}
const games = Number(gamesArg) || 1;

const [deckA, deckB, commanderA, commanderB] = await Promise.all([
  loadDeck(pathA), loadDeck(pathB), loadCommander(commanderNameA), loadCommander(commanderNameB),
]);
console.log(`Loaded ${deckA.length}-card deck A (commander: ${commanderA.name}) and ${deckB.length}-card deck B (commander: ${commanderB.name}). Playing ${games} Commander game(s)...\n`);
await analyzeDeckIfKeyPresent([...deckA, ...deckB, commanderA, commanderB]);

let wins = { A: 0, B: 0, none: 0 };
for (let i = 0; i < games; i++) {
  let result;
  try {
    result = await playOneGame(deckA, deckB, {
      nameA: 'Deck A', nameB: 'Deck B',
      commanderMode: true, commanderA, commanderB,
      maxTurns: 200, // Commander's 40 life tends to run longer than constructed's 20
    });
  } catch (err) {
    console.error(`Game ${i + 1}: CRASHED — ${err.stack}`);
    wins.none++;
    continue;
  }
  if (result.winner === 'Deck A') wins.A++;
  else if (result.winner === 'Deck B') wins.B++;
  else wins.none++;

  const commanderDamageLines = result.logLines.filter(l => /command zone|commander damage|21\+ commander/i.test(l));
  console.log(`Game ${i + 1}: ${result.completed ? `${result.winner} wins` : (result.hitTurnCap ? 'hit turn cap' : 'STALLED')} in ${result.turns} turns. Final life: ${JSON.stringify(result.finalLife)}`);
  if (commanderDamageLines.length) {
    console.log(`  ${commanderDamageLines.length} command-zone/commander-damage log line(s):`);
    for (const line of commanderDamageLines) console.log(`    - ${line}`);
  }
  if (result.unmodeledEvents.length) {
    console.log(`  ${result.unmodeledEvents.length} unmodeled-effect log line(s):`);
    for (const line of [...new Set(result.unmodeledEvents)]) console.log(`    - ${line}`);
  }
}

console.log(`\nOverall: Deck A won ${wins.A}, Deck B won ${wins.B}, no winner ${wins.none} (of ${games}).`);
