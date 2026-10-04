import { fetchCardsByName } from './scryfall.js';

// Accepts lines like:
//   4 Lightning Bolt
//   2x Counterspell
//   Island
//   8x Island (cmm) 441          (set code + collector number both stripped)
//   1 Smoldering Egg // Ashmouth Dragon (mid)   (double-faced card names keep their "//")
//   Sideboard section headers ("Sideboard", "Deck") are skipped.
export function parseDecklistText(text) {
  const lines = text.split('\n');
  const entries = [];
  for (let raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    if (/^(deck|sideboard|maindeck|commander)\s*:?$/i.test(line)) continue;
    line = line.replace(/^\d+\)\s*/, ''); // strip "1) " style prefixes

    const match = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    let count = 1;
    let name = line;
    if (match) {
      count = parseInt(match[1], 10);
      name = match[2];
    }
    // Strip a trailing "(SET)" and an optional collector number / foil
    // marker after it, e.g. "Island (cmm) 441" -> "Island", or
    // "Magewright's Stone (plst) *F*" -> "Magewright's Stone". Left alone
    // otherwise, so double-faced card names like "Smoldering Egg //
    // Ashmouth Dragon" (which legitimately contain "//") are preserved.
    name = name.replace(/\s*\([A-Za-z0-9]{2,6}\)(?:\s+\S+)?\s*$/, '').trim();
    if (!name) continue;
    entries.push({ name, count });
  }
  return entries;
}

// Resolves a parsed decklist into an array of card objects (one entry per
// physical card, duplicated by count), each with a fresh unique instanceId.
export async function buildDeckFromText(text) {
  const entries = parseDecklistText(text);
  if (entries.length === 0) {
    throw new Error('No cards found in that decklist.');
  }
  const { cards, notFound } = await fetchCardsByName(entries.map(e => e.name));

  const deck = [];
  const unresolved = [...notFound];
  let uid = 0;
  for (const entry of entries) {
    const card = cards.get(entry.name);
    if (!card) {
      if (!unresolved.includes(entry.name)) unresolved.push(entry.name);
      continue;
    }
    for (let i = 0; i < entry.count; i++) {
      deck.push({ ...card, instanceId: `c${uid++}_${card.id}` });
    }
  }

  if (deck.length < 1) {
    throw new Error('None of the cards in that list could be found.');
  }

  return { deck, unresolved, cardCount: deck.length };
}

export function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
