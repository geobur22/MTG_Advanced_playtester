// Optional AI-sourced fallback for cards whose oracle text the regex-based
// effects.js interpreter doesn't recognize. The cache this reads is produced
// offline by the sibling mtg-oracle-ai project (see its README) — nothing in
// this file ever calls an AI API or needs a key; it just loads a plain JSON
// file and translates its schema into the same {kind, targeting, resolve}
// step shape effects.js already produces, so game.js can treat AI-sourced
// steps identically to regex-sourced ones.

let cache = {};

// For a Node script (scripts/simulate.mjs, scripts/runAudit.mjs) that already
// has the interpreted-cards object in memory — no server, no fetch, so this
// works headlessly without server.mjs running. Browser play still goes
// through loadAICache below instead, since play.js has no such object of its
// own to hand over.
export function setAICache(obj) {
  cache = obj || {};
}

// Best-effort: if the cache file doesn't exist, the game plays exactly as it
// would without this feature at all.
export async function loadAICache(url = 'ai-cache.json') {
  try {
    // no-store: the server rewrites this file right before play.html loads
    // it (see server.mjs's /api/analyze-deck), so a cached 304 would hand
    // back yesterday's interpretations.
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    cache = await res.json();
    console.log(`[ai] Loaded ${Object.keys(cache).length} AI card interpretation(s) from ${url}.`);
  } catch {
    // No cache file, or not reachable — proceed without it.
  }
}

function aiEffectToStep(effect) {
  if (!effect || effect.kind === 'none') return null;
  const { kind, targeting = 'none', amount, details } = effect;
  const base = { kind, targeting, amount, details };

  switch (kind) {
    case 'damage':
      return { ...base, resolve: (game, ctx) => game.applyDamageEffect(ctx, amount ?? 1) };
    case 'destroy':
      return { ...base, resolve: (game, ctx) => game.applyDestroyEffect(ctx) };
    case 'counterSpell':
      return { ...base, targeting: 'stackSpell', resolve: (game, ctx) => game.applyCounterEffect(ctx) };
    case 'draw':
      return { ...base, resolve: (game, ctx) => game.applyDrawEffect(ctx, amount ?? 1) };
    case 'pump': {
      const power = effect.power ?? 0, toughness = effect.toughness ?? 0;
      return { ...base, resolve: (game, ctx) => game.applyPumpEffect(ctx, power, toughness) };
    }
    case 'lifegain':
      return { ...base, resolve: (game, ctx) => game.applyLifegainEffect(ctx, amount ?? 1) };
    case 'mana': {
      const color = effect.color;
      const n = amount ?? 1;
      return { ...base, resolve: (game, ctx) => { for (let i = 0; i < n; i++) game.applyManaEffect(ctx, color || game.pickAnyColorChoice(ctx)); } };
    }
    case 'addCounters':
      return { ...base, resolve: (game, ctx) => game.applyCounterAdditionEffect(ctx, amount ?? 1) };
    case 'fetchLand': {
      const ontoBattlefield = effect.ontoBattlefield ?? true;
      const tapped = !!effect.tapped;
      return { ...base, resolve: (game, ctx) => game.applyFetchLandEffect(ctx, { ontoBattlefield, tapped }) };
    }
    case 'discard':
      return { ...base, resolve: (game, ctx) => game.applyDiscardEffect(ctx, amount ?? 1) };
    case 'mill':
      return { ...base, resolve: (game, ctx) => game.applyMillEffect(ctx, amount ?? 1) };
    case 'exile':
      return { ...base, resolve: (game, ctx) => game.applyExileEffect(ctx) };
    case 'bounce':
      return { ...base, resolve: (game, ctx) => game.applyBounceEffect(ctx) };
    case 'edict':
      return { ...base, resolve: (game, ctx) => game.applyEdictEffect(ctx) };
    case 'createToken': {
      // Treasure (and other noncreature artifact tokens the AI might name)
      // have no power/toughness at all — creating them as a "0/0 Treasure
      // creature" would be wrong, so route those to the dedicated Treasure
      // helper instead of the P/T creature-token path.
      if (/treasure/i.test(effect.tokenType || '')) {
        return { ...base, resolve: (game, ctx) => game.applyTreasureTokenEffect(ctx, amount ?? 1) };
      }
      const power = effect.tokenPower ?? 1, toughness = effect.tokenToughness ?? 1;
      const typeDesc = effect.tokenType || 'token';
      return { ...base, resolve: (game, ctx) => game.applyTokenEffect(ctx, amount ?? 1, power, toughness, typeDesc) };
    }
    case 'tap':
      return { ...base, resolve: (game, ctx) => game.applyTapEffect(ctx, true) };
    case 'untap':
      return { ...base, resolve: (game, ctx) => game.applyTapEffect(ctx, false) };
    default:
      return {
        kind: 'unsupported',
        targeting: 'none',
        resolve: (game, ctx) => {
          game.log(`${ctx.card.name}'s effect (AI: ${details || kind}) isn't modeled in detail yet — it resolves with no game effect.`);
        },
      };
  }
}

// Returns spell-effect steps for an instant/sorcery, or null if there's no
// cached AI interpretation for this card.
export function getAISpellEffect(card) {
  const entry = cache[card.name];
  if (!entry?.spellEffect) return null;
  const step = aiEffectToStep(entry.spellEffect);
  return step ? [step] : null;
}

// Returns "enters the battlefield" trigger steps, or null. Only the ETB
// event is used since that's the only trigger type game.js currently calls.
export function getAIETBSteps(card) {
  const entry = cache[card.name];
  if (!entry?.triggers) return null;
  const steps = entry.triggers
    .filter(t => t.event === 'entersBattlefield')
    .map(t => aiEffectToStep(t.effect))
    .filter(Boolean);
  return steps.length ? steps : null;
}

// Returns tap-activated abilities in the same shape interpretTapAbilities()
// produces, or null. Only abilities whose cost includes {T} are used, since
// that's the only cost shape the engine's activation flow supports.
export function getAITapAbilities(card) {
  const entry = cache[card.name];
  if (!entry?.activatedAbilities) return null;
  const abilities = entry.activatedAbilities
    .filter(a => /\{T\}/i.test(a.cost || ''))
    .map(a => {
      const step = aiEffectToStep(a.effect);
      if (!step) return null;
      const payLifeMatch = (a.cost || '').match(/pay (\d+) life/i);
      const rawManaCost = (a.cost || '').replace(/\{T\}/gi, '').match(/\{[^}]+\}/g)?.join('') || '';
      return {
        effectText: a.effect.details || a.cost,
        steps: [step],
        isManaAbility: step.kind === 'mana',
        sacrificeCost: /sacrifice/i.test(a.cost || ''),
        payLife: payLifeMatch ? parseInt(payLifeMatch[1], 10) : 0,
        manaCost: isPayableManaCostString(rawManaCost) ? rawManaCost : '',
      };
    })
    .filter(Boolean);
  return abilities.length ? abilities : null;
}

// Returns "whenever you cast a spell" trigger steps in the same
// {filter, steps} shape interpretCastTriggers() produces, or null. These
// triggers are almost always self-buffs ("this creature gets ..."/"put a
// counter on this creature"), so for the two step kinds that make sense as a
// self-buff (pump, addCounters) the target is forced onto the permanent that
// has the trigger (ctx.sourcePerm), regardless of what targeting the AI
// reported — there's no player-chosen target for this trigger shape.
export function getAICastTriggers(card) {
  const entry = cache[card.name];
  if (!entry?.triggers) return null;
  const triggers = entry.triggers
    .filter(t => /cast/i.test(t.event || ''))
    .map(t => {
      const step = aiEffectToStep(t.effect);
      if (!step) return null;
      const selfTargeting = step.kind === 'pump' || step.kind === 'addCounters';
      return {
        filter: deriveSpellFilterFromEventText(t.event),
        steps: [{
          ...step,
          targeting: selfTargeting ? 'none' : step.targeting,
          resolve: (game, ctx) => step.resolve(game, selfTargeting
            ? { ...ctx, target: { type: 'permanent', id: ctx.sourcePerm?.id } }
            : ctx),
        }],
      };
    })
    .filter(Boolean);
  return triggers.length ? triggers : null;
}

function deriveSpellFilterFromEventText(eventText) {
  const t = (eventText || '').toLowerCase();
  if (t.includes('noncreature')) return 'noncreature';
  if (t.includes('instant') && t.includes('sorcery')) return 'instantOrSorcery';
  if (t.includes('instant')) return 'instant';
  if (t.includes('sorcery')) return 'sorcery';
  if (t.includes('creature')) return 'creature';
  return null;
}

// Best-effort scope guess for an AI-sourced "dies"/"attacks" trigger, since
// the AI's free-text event name doesn't carry the same structured qualifier
// effects.js's own regex parses (classifyOwnerScope) — 'anyOwn' (dies) and
// 'selfOnly' (attacks) are what the vast majority of real cards mean.
function guessOwnerScope(eventText, details, fallback) {
  const text = `${eventText || ''} ${details || ''}`.toLowerCase();
  if (/opponent/.test(text)) return 'opponent';
  if (/another/.test(text)) return /you control/.test(text) ? 'otherOwn' : 'otherAny';
  return fallback;
}

// Returns "dies" trigger steps, or null. Only used when the regex on the
// card's own oracle text finds nothing — see interpretDiesTriggers.
export function getAIDiesTriggers(card) {
  const entry = cache[card.name];
  if (!entry?.triggers) return null;
  const triggers = entry.triggers
    .filter(t => /dies/i.test(t.event || ''))
    .map(t => {
      const step = aiEffectToStep(t.effect);
      if (!step) return null;
      return { scope: guessOwnerScope(t.event, t.effect?.details, 'anyOwn'), steps: [step] };
    })
    .filter(Boolean);
  return triggers.length ? triggers : null;
}

// Returns "attacks" trigger steps, or null. Only used when the regex on the
// card's own oracle text finds nothing — see interpretAttackTriggers.
export function getAIAttackTriggers(card) {
  const entry = cache[card.name];
  if (!entry?.triggers) return null;
  const triggers = entry.triggers
    .filter(t => /attack/i.test(t.event || ''))
    .map(t => {
      const step = aiEffectToStep(t.effect);
      if (!step) return null;
      return { scope: guessOwnerScope(t.event, t.effect?.details, 'selfOnly'), steps: [step] };
    })
    .filter(Boolean);
  return triggers.length ? triggers : null;
}

// Returns "deals combat damage to a player" trigger steps, or null. Only
// used when the regex on the card's own oracle text finds nothing — see
// interpretCombatDamageTriggers.
export function getAICombatDamageTriggers(card) {
  const entry = cache[card.name];
  if (!entry?.triggers) return null;
  const triggers = entry.triggers
    .filter(t => /deals? combat damage/i.test(t.event || ''))
    .map(t => {
      const step = aiEffectToStep(t.effect);
      if (!step) return null;
      return { scope: guessOwnerScope(t.event, t.effect?.details, 'selfOnly'), steps: [step] };
    })
    .filter(Boolean);
  return triggers.length ? triggers : null;
}

// Returns "at the beginning of your upkeep" trigger steps, or null.
export function getAIUpkeepTriggers(card) {
  const entry = cache[card.name];
  if (!entry?.triggers) return null;
  const steps = entry.triggers.filter(t => /upkeep/i.test(t.event || '')).map(t => aiEffectToStep(t.effect)).filter(Boolean);
  return steps.length ? steps : null;
}

// Returns "at the beginning of your end step" trigger steps, or null.
export function getAIEndStepTriggers(card) {
  const entry = cache[card.name];
  if (!entry?.triggers) return null;
  const steps = entry.triggers.filter(t => /end ?step/i.test(t.event || '')).map(t => aiEffectToStep(t.effect)).filter(Boolean);
  return steps.length ? steps : null;
}

// Returns non-{T} activated abilities (a flat mana cost, or a "sacrifice"
// cost) in the same shape interpretNonTapAbilities() produces, or null.
// True only if every {...} symbol in the string is something
// parseManaCost actually knows how to charge (generic number, X, C, a
// W/U/B/R/G pip, or a hybrid pair) — NOT true for things like a bare
// "{E}" (energy, from "Pay {E}{E}:" costs) or any other non-mana symbol.
// This matters a lot: parseManaCost silently treats an unrecognized symbol
// as contributing nothing to the cost, so extracting "{E}{E}" as if it were
// a mana cost would produce a completely FREE, infinitely-repeatable
// ability — exactly the kind of bug that hangs a game in an infinite loop
// of the AI activating something with no real cost, forever.
function isPayableManaCostString(cost) {
  const symbols = cost.match(/\{[^}]+\}/g);
  if (!symbols || !symbols.length) return false;
  return symbols.every(sym => {
    const inner = sym.slice(1, -1).toUpperCase();
    return inner === 'X' || inner === 'C' || /^\d+$/.test(inner) || ['W', 'U', 'B', 'R', 'G'].includes(inner) || inner.includes('/');
  });
}

export function getAINonTapAbilities(card) {
  const entry = cache[card.name];
  if (!entry?.activatedAbilities) return null;
  const abilities = entry.activatedAbilities
    .filter(a => !/\{T\}/i.test(a.cost || '') && !/^equip/i.test(a.cost || ''))
    .map(a => {
      const step = aiEffectToStep(a.effect);
      if (!step) return null;
      const cost = a.cost || '';
      const rawManaCost = (cost.match(/\{[^}]+\}/g) || []).join('');
      const manaCost = isPayableManaCostString(rawManaCost) ? rawManaCost : '';
      const sacMatch = cost.match(/sacrifice (another creature|a creature|this creature|~)/i);
      const sacrifice = sacMatch ? (/another/i.test(sacMatch[1]) ? 'other' : (/this|~/i.test(sacMatch[1]) ? 'self' : 'any')) : null;
      if (!manaCost && !sacrifice) return null; // not a cost shape we can actually pay
      return { effectText: a.effect?.details || cost, steps: [step], isManaAbility: step.kind === 'mana', manaCost, sacrifice };
    })
    .filter(Boolean);
  return abilities.length ? abilities : null;
}
