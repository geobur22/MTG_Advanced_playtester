// Decides which cards in a decklist are worth sending to the AI interpreter,
// and runs those interpretations concurrently. Kept separate from server.mjs
// so it can be unit-tested with a stub interpretFn instead of real network
// calls, and separate from mtg-oracle-ai so it can reuse mtg-game's own
// regex interpreter directly (see needsAI below) without a circular import.

import { interpretSpell, interpretPermanentTriggers, interpretTapAbilities, isFullyUnsupported } from '../src/effects.js';

// True if this card has oracle text that looks like it needs one of the
// three effect shapes mtg-game's AI adapter actually consults (spell effect,
// ETB trigger, {T} ability) but the regex interpreter didn't recognize it.
// Cards the regex engine already handles, and vanilla cards with no rules
// text at all, are skipped so a Commander deck's ~40 basics/vanillas/simple
// spells never cost an API call.
export function needsAI(card) {
  const text = (card.oracleText || '').trim();
  if (!text) return false;

  if (/\b(instant|sorcery)\b/i.test(card.typeLine || '')) {
    if (isFullyUnsupported(interpretSpell(card))) return true;
  }
  if (/enters the battlefield/i.test(text)) {
    if (isFullyUnsupported(interpretPermanentTriggers(card))) return true;
  }
  if (/\{T\}/.test(text)) {
    const abilities = interpretTapAbilities(card);
    if (abilities.length === 0 || abilities.every(a => isFullyUnsupported(a.steps))) return true;
  }
  return false;
}

// Interprets whichever of `cards` need it, writing results into `cache`
// (keyed by card name) as they complete. Runs up to `concurrency` calls to
// `interpretFn` at once so a full deck doesn't take one-call's-latency ×
// card-count. `onProgress` is called with {type, ...} messages as work
// happens; `checkpoint` (if given) is called periodically with the
// in-progress cache so a crash mid-run doesn't lose completed work.
export async function analyzeCards(cards, { cache, interpretFn, concurrency = 10, onProgress, checkpoint } = {}) {
  const toAnalyze = cards.filter(c => c && c.name && !cache[c.name] && needsAI(c));
  onProgress?.({ type: 'start', total: toAnalyze.length });

  let done = 0;
  let idx = 0;
  async function worker() {
    while (idx < toAnalyze.length) {
      const card = toAnalyze[idx++];
      try {
        cache[card.name] = await interpretFn(card);
      } catch (err) {
        onProgress?.({ type: 'error', name: card.name, message: err.message });
      }
      done++;
      onProgress?.({ type: 'progress', done, total: toAnalyze.length, name: card.name });
      if (checkpoint && done % 5 === 0) await checkpoint(cache);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toAnalyze.length) }, worker));

  return { analyzed: toAnalyze.length, cache };
}
