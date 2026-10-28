import { shuffle } from './deck.js';
import { interpretSpell, interpretPermanentTriggers, interpretTapAbilities, interpretCastTriggers, interpretEquipCost, getSpellModes as getSpellModesFromText, interpretDiesTriggers, interpretAttackTriggers, interpretCombatDamageTriggers, interpretUpkeepTriggers, interpretEndStepTriggers, interpretBeginCombatTriggers, interpretNonTapAbilities, interpretLoyaltyAbilities, interpretSagaChapters, interpretDrawTriggers, interpretCounterAddedTriggers, interpretBecomesTargetTriggers, getWardCost, interpretGraveyardAbilities, interpretSacrificeTriggers, interpretLeavesTriggers, interpretLandfallTriggers, interpretTribalEtbTriggers, interpretAnyEtbTriggers, interpretDrawStepTriggers, hasLifePaymentXCost, getKickerCost, getFlashbackCost, getEscapeCost, parseClassLevels, interpretWhenYouAttackTriggers, interpretEnchantedPlayerUpkeepTriggers, interpretEnchantedPlayerAttackedTriggers, getEntersWithCounterCount, getNinjutsuCost, interpretMonstrousTriggers, getBloodthirstAmount, getFabricateAmount, getBuybackCost, getCyclingAbility, interpretCycleTriggers, getSuspendInfo, getMiracleCost, getTransmuteCost, getEntwineCost, getCounterSpellFilter, getExploitPayoffSteps, getAlternativeCosts, getModeExtraCost, getReplicateCost, getSquadCost, getOffspringCost, getCasualtyAmount, hasConspire, hasBargain, getGiftKind, getBackupAmount, getGraveyardCastCosts, getMadnessCost, getForetellCost, getPlotCost, getRecoverCost, getDredgeAmount, hasRebound, getCascadeCount, hasStorm, hasGravestorm, hasSplitSecond, hasCipher, hasEpic, hasDemonstrate, getRippleAmount, getCumulativeUpkeep, getReinforce, getForecast, getChampionType, hasReadAhead, hasForMirrodin, hasAscend, hasSoulbond, hasUmbraArmor, getFortifyCost, getFaceDownCost, interpretTurnFaceUpTriggers, interpretMutateTriggers, hasJobSelect, hasIncrement, hasParadigm, hasStartYourEngines, hasStoried, getTeamworkAmount, getMobilize, getFirebending, getReconfigureCost, hasLivingWeapon, hasLivingMetal, hasStation, getStationInfo, getDevotionRequirement, getConvertCost, getCraft, getLevelUp, interpretHauntTriggers, hasHaunt, getSpliceCost, parseCondition, parseCount, stripAbilityWords, replaceSelfNameExport, parseForEach, interpretDealtDamageTriggers, interpretUntapTriggers, interpretSecondMainTriggers, interpretBattalionTriggers, interpretNthSpellTriggers, interpretValiantTriggers, getHandAbilities, getRenew, getStriveCost, isFullyUnsupported as isFullyUnsupportedSteps, getEcho, getCaseSolve } from './effects.js';
import { parseManaCost, planManaPayment, totalCmc } from './mana.js';
import { pickTargetsForKinds } from './ai.js';

export const STEP_ORDER = [
  'untap', 'upkeep', 'draw', 'main1',
  'beginCombat', 'declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat',
  'main2', 'end', 'cleanup',
];

export const STEP_LABEL = {
  untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main Phase 1',
  beginCombat: 'Begin Combat', declareAttackers: 'Declare Attackers',
  declareBlockers: 'Declare Blockers', combatDamage: 'Combat Damage', endCombat: 'End of Combat',
  main2: 'Main Phase 2', end: 'End Step', cleanup: 'Cleanup',
};

const NO_PRIORITY_STEPS = new Set(['untap', 'cleanup']);

function typeOf(card, kind) {
  return (card.typeLine || '').toLowerCase().includes(kind);
}

function isLand(card) { return typeOf(card, 'land'); }
function isCreature(card) { return typeOf(card, 'creature'); }
// Tokens are recognized by their type line ("Token Creature — Goblin", set
// by every token-creating helper) or an explicit isToken flag (token copies
// of real cards, whose type line is copied from the original).
function isTokenCard(card) { return !!card && (card.isToken || /\btoken\b/i.test(card.typeLine || '')); }
// Changeling: "this card is every creature type". hasTypeWord is the
// subtype-aware "does this card have type/subtype X" check used for tribal
// counts, lords, and triggers — a changeling creature matches any creature
// type, but not card types like "artifact".
const NON_CREATURE_TYPE_WORDS = new Set(['artifact', 'creature', 'enchantment', 'land', 'planeswalker', 'instant', 'sorcery', 'battle', 'kindred', 'tribal', 'legendary', 'token', 'snow', 'basic', 'permanent', 'equipment', 'aura', 'vehicle', 'saga', 'treasure', 'food', 'clue', 'fortification', 'class', 'shrine', 'curse', 'cartouche']);
function isChangeling(card) { return (card.keywords || []).includes('changeling') || /^changeling\b/im.test(card.oracleText || ''); }
function hasTypeWord(card, word) {
  const typeLine = (card.typeLine || '').toLowerCase();
  if (typeLine.includes(word)) return true;
  return isChangeling(card) && !NON_CREATURE_TYPE_WORDS.has(word) && /creature|kindred|tribal/.test(typeLine);
}

// A type line with "Creature" added or removed ("Artifact — Vehicle" →
// "Artifact Creature — Vehicle"), optionally adding a subtype.
const CARD_STATE_MEMO = new WeakMap();

// Per-card memo for trigger interpreters hit on hot paths (every damage
// event, every untap) — the parse only depends on the card's text.
const STEP_MEMO = new Map();
function memoSteps(fn, card) {
  let byCard = STEP_MEMO.get(fn);
  if (!byCard) { byCard = new WeakMap(); STEP_MEMO.set(fn, byCard); }
  let v = byCard.get(card);
  if (!v) { v = fn(card); byCard.set(card, v); }
  return v;
}

// Conditional static abilities: "As long as COND, this creature gets +2/+2
// and has flying" / "This creature has haste as long as COND" / "As long as
// COND, creatures you control get +1/+1" / "During your turn, ...". Parsed
// once per card: [{ test, self: { power, toughness, grant }, anthem }].
const CONDITIONAL_STATIC_MEMO = new WeakMap();
function conditionalStatics(card) {
  let out = CONDITIONAL_STATIC_MEMO.get(card);
  if (out) return out;
  out = [];
  const text = stripAbilityWords(replaceSelfNameExport(card, (card.oracleText || '').replace(/\([^()]*\)/g, ''), 'this creature').toLowerCase());
  for (let line of text.split('\n').map(l => l.trim().replace(/\.$/, ''))) {
    line = line.replace(/\bgets an additional\b/, 'gets');
    // "This creature can't attack or block unless COND" (Descend 8's The Ancient One).
    const unless = line.match(/^this creature can'?t attack or block unless (.+)$/);
    if (unless && parseCondition(unless[1])) { const t = parseCondition(unless[1]); out.push({ test: (g, c) => !t(g, c), self: { power: 0, toughness: 0, grant: 'cantattack cantblock' } }); continue; }
    let m = line.match(/^as long as (.+?), (.+)$/) || line.match(/^during your turn, (.+)$/) && [null, "it's your turn", line.replace(/^during your turn, /, '')];
    if (!m) { const t = line.match(/^(this creature (?:gets|has) .+?) as long as (.+)$/); if (t) m = [null, t[2], t[1]]; }
    if (!m) continue;
    const test = parseCondition(m[1]);
    if (!test) continue;
    const body = m[2].replace(/^artifacts and creatures you control /, 'creatures you control ');
    const self = body.match(/^(?:this creature|it) (?:gets ([+-]\d+)\/([+-]\d+)(?: and (?:has|gains) (.+))?|(?:has|gains) (.+))$/);
    if (self) { out.push({ test, self: { power: self[1] ? parseInt(self[1], 10) : 0, toughness: self[2] ? parseInt(self[2], 10) : 0, grant: self[3] || self[4] || '' } }); continue; }
    if (/^(?:this creature|it) can'?t be blocked$/.test(body)) { out.push({ test, self: { power: 0, toughness: 0, grant: 'unblockable' } }); continue; }
    const anthem = parseCreatureAnthemLine(body);
    if (anthem) out.push({ test, anthem });
  }
  CONDITIONAL_STATIC_MEMO.set(card, out);
  return out;
}

// One face of a multi-face card as a card of its own (same instanceId), with
// the printed card kept on _dfcOriginal so it can go back to its zone whole.
function faceCard(card, idx) {
  const f = card.faces?.[idx];
  if (!f) return null;
  return {
    ...card, name: f.name, manaCost: f.manaCost, cmc: totalCmc(parseManaCost(f.manaCost || '')),
    typeLine: f.typeLine, oracleText: f.oracleText, power: f.power, toughness: f.toughness, loyalty: f.loyalty,
    colors: f.colors, image: f.image || card.image, keywords: extractKnownKeywords((f.oracleText || '').toLowerCase()),
    faceIndex: idx, _dfcOriginal: card,
  };
}

// Both halves of a Fuse split card cast together.
function fusedCard(card) {
  const [a, b] = card.faces;
  return {
    ...card, name: card.name, manaCost: `${a.manaCost}${b.manaCost}`, cmc: totalCmc(parseManaCost(`${a.manaCost}${b.manaCost}`)),
    typeLine: a.typeLine, oracleText: `${a.oracleText}\n${b.oracleText}`, keywords: [], faceIndex: 'fuse', _dfcOriginal: card,
  };
}
function withCreatureType(typeLine, creature, subtype = null) {
  let [types, subs = ''] = (typeLine || '').split('—').map(x => x.trim());
  if (creature && !/\bcreature\b/i.test(types)) types = `${types} Creature`;
  if (!creature) types = types.replace(/\s*\bCreature\b/i, '').trim();
  if (subtype && !new RegExp(`\\b${subtype}\\b`, 'i').test(subs)) subs = `${subtype} ${subs}`.trim();
  return subs ? `${types} — ${subs}` : types;
}

// cost minus another cost (Power-up's reduction, Harmonize's tap), as a
// mana string: colored symbols cancel their own color first, anything
// left over comes off the generic part.
function subtractManaCost(cost, minus) {
  const a = parseManaCost(cost || ''), b = parseManaCost(minus || '');
  let generic = a.generic;
  const colors = { ...a.colors };
  let spare = b.generic;
  for (const c of Object.keys(b.colors)) {
    const take = Math.min(colors[c] || 0, b.colors[c]);
    colors[c] = (colors[c] || 0) - take;
    spare += b.colors[c] - take;
  }
  generic = Math.max(0, generic - spare);
  let out = generic ? `{${generic}}` : '';
  for (const c of ['W', 'U', 'B', 'R', 'G', 'C']) out += `{${c}}`.repeat(Math.max(0, colors[c] || 0));
  for (const h of a.hybrid) out += `{${h.join('/')}}`;
  return out;
}

// The nameless 2/2 a face-down card shows as (Morph, Megamorph, Manifest;
// Disguise and Cloak also give it ward {2}). The real card rides along on
// the permanent's faceDown field and is revealed when it turns face up or
// leaves the battlefield.
function makeFaceDownCard(real, kind) {
  const ward = kind === 'disguise' || kind === 'cloak';
  return {
    id: uid('facedown'), instanceId: real.instanceId, name: 'Face-down creature', manaCost: '', cmc: 0,
    typeLine: 'Creature', oracleText: ward ? 'Ward {2}' : '', power: '2', toughness: '2',
    colors: [], colorIdentity: [], keywords: ward ? ['ward'] : [], producedMana: null, image: null, isFaceDown: true,
  };
}

// A token that's a copy of `card` (Squad, Offspring's 1/1 copy, a copied
// permanent spell). stats overrides power/toughness.
function makeTokenCopyCard(card, stats = null) {
  return {
    ...card,
    id: uid('tokencard'), instanceId: uid('tokeninst'), isToken: true,
    typeLine: /\btoken\b/i.test(card.typeLine || '') ? card.typeLine : `Token ${card.typeLine || ''}`.trim(),
    ...(stats ? { power: String(stats.power), toughness: String(stats.toughness) } : {}),
  };
}
function isInstant(card) { return typeOf(card, 'instant'); }
function isSorcery(card) { return typeOf(card, 'sorcery'); }
function isAura(card) { return typeOf(card, 'aura'); }
function isArtifact(card) { return typeOf(card, 'artifact'); }
function isEnchantment(card) { return typeOf(card, 'enchantment'); }
function isSaga(card) { return typeOf(card, 'saga'); }
function isClassEnchantment(card) { return typeOf(card, 'class'); }
// "Enchant player" (the whole Curse cycle: Curse of the Pierced Heart,
// Curse of Opulence, ...) — as opposed to the far more common "Enchant
// creature"/"Enchant permanent", this targets a PLAYER, not a permanent.
function isEnchantPlayerAura(card) { return /^enchant player$/im.test(card.oracleText || ''); }
function isPlaneswalker(card) { return typeOf(card, 'planeswalker'); }
function isPermanentType(card) {
  return isLand(card) || isCreature(card) || typeOf(card, 'artifact') ||
    typeOf(card, 'enchantment') || typeOf(card, 'planeswalker');
}

// Sums a permanent's power/toughness-modifying counters (perm.counters is a
// plain object keyed by counter-type string, e.g. { '+1/+1': 2, '+1/+0': 1 }
// — any counter type shows up as a key the moment applyCounterAdditionEffect
// first adds one, since interpretEffectText's counter clauses now support
// arbitrary "+P/+T"/"-P/-T" wording, not just +1/+1).
function counterStatTotal(counters, stat) {
  let total = 0;
  for (const [type, count] of Object.entries(counters)) {
    const m = type.match(/^([+-]\d+)\/([+-]\d+)$/);
    if (!m) continue;
    total += (stat === 'power' ? parseInt(m[1], 10) : parseInt(m[2], 10)) * count;
  }
  return total;
}

// Whether a just-cast card satisfies a "whenever you cast a [filter] spell"
// trigger's restriction (null/no filter means "any spell").
function spellMatchesFilter(card, filter) {
  switch (filter) {
    case null:
    case undefined: return true;
    case 'noncreature': return !isCreature(card);
    case 'creature': return isCreature(card);
    case 'instant': return isInstant(card);
    case 'sorcery': return isSorcery(card);
    case 'instantOrSorcery': return isInstant(card) || isSorcery(card);
    case 'artifact': return isArtifact(card);
    case 'enchantment': return isEnchantment(card);
    default:
      if (typeof filter === 'string' && filter.startsWith('color:')) return (card.colors || []).includes(filter.slice(6));
      if (typeof filter === 'string' && filter.startsWith('typeAny:')) {
        const typeLine = (card.typeLine || '').toLowerCase();
        return filter.slice(8).split('|').some(t => typeLine.includes(t));
      }
      if (typeof filter === 'string' && filter.startsWith('subtype:')) return (card.typeLine || '').toLowerCase().includes(filter.slice(8));
      return false;
  }
}

// Whether a "dies"/"attacks" trigger (scope from effects.js's
// classifyOwnerScope) applies to the event that just happened, from the
// watching permanent's point of view.
function ownerScopeMatches(scope, isSelf, sameController) {
  switch (scope) {
    case 'selfOnly': return isSelf;
    case 'anyAny': return true;
    case 'anyOwn': return sameController;
    case 'otherOwn': return sameController && !isSelf;
    case 'opponent': return !sameController;
    case 'attachedCreature': return false; // needs the watcher's attachedTo, which this function doesn't have — handled specially by the caller (see triggerAttacks)
    default: return false;
  }
}

// Whether a dies-trigger's type restriction (see effects.js's
// classifyDyingType) actually matches the permanent that just died —
// e.g. a "whenever a creature dies" trigger shouldn't also fire when an
// unrelated land or enchantment dies, now that triggerDies runs for every
// permanent type, not just creatures.
function dyingTypeMatches(expectedType, card) {
  if (expectedType === 'any' || !expectedType) return true;
  if (expectedType.startsWith('subtype:')) return typeOf(card, expectedType.slice(8));
  return typeOf(card, expectedType);
}

// Expands a steps array into a flat list of target KINDS, repeating a
// step's kind `step.targetCount` times when it needs more than one target
// ("up to two target creatures" — Ghostly Flicker, and similar). This flat
// shape is what every target-collection path already expects (AI's
// pickTargetsForKinds, play.js's ui.targeting.kinds/collected, and
// resolveEffectSteps below), so a multi-target step just looks like several
// consecutive same-kind single-target slots to all of them — no other
// plumbing needs to know the difference.
function expandTargetKinds(steps) {
  const kinds = [];
  for (const step of steps) {
    if (step.targeting === 'none') continue;
    const count = step.targetCount || 1;
    for (let i = 0; i < count; i++) kinds.push(step.targeting);
  }
  return kinds;
}

// Companion to expandTargetKinds: the MINIMUM number of a card/ability's
// target slots that must actually resolve to a real legal target for it to
// be worth casting/activating at all. An ordinary mandatory single target
// needs all of its (1) slot(s), same as before this multi-target plumbing
// existed — but an "up to N" step (minTargets explicitly 0, set by the
// effects.js clauses that parse "up to") is fine with fewer, even zero,
// real targets (Ghostly Flicker is still a perfectly legal cast against an
// empty board, it just does nothing). Used by ai.js's "is this worth
// attempting" gates instead of the flat expanded kinds.length, which would
// otherwise wrongly refuse to cast/activate an "up to N" effect whenever
// fewer than N legal targets happen to be available.
function minRequiredTargetCount(steps) {
  let total = 0;
  for (const step of steps) {
    if (step.targeting === 'none') continue;
    const count = step.targetCount || 1;
    total += (step.minTargets ?? count);
  }
  return total;
}

const KNOWN_KEYWORDS = [
  'first strike', 'double strike', 'flying', 'reach', 'haste', 'vigilance',
  'trample', 'deathtouch', 'lifelink', 'menace', 'indestructible', 'hexproof',
  'shroud', 'ward', 'defender', 'undying', 'persist',
  'fear', 'intimidate', 'plainswalk', 'islandwalk', 'swampwalk', 'mountainwalk', 'forestwalk',
  'exalted', 'decayed', 'mentor', 'training',
  'infect', 'wither', 'shadow', 'horsemanship', 'flanking', 'battle cry',
];

// Finds any recognized keyword abilities named in a chunk of (already
// lowercased) text, e.g. "flying, first strike, and vigilance" or
// "haste and reach". Matching against a whitelist rather than splitting on
// commas/"and" means it isn't thrown off by punctuation variations.
function extractKnownKeywords(text) {
  return KNOWN_KEYWORDS.filter(kw => text.includes(kw));
}

// One lowercase oracle line parsed as a creature anthem / tribal lord, or
// null. Covers "Creatures you control get +1/+1", "Creature tokens you
// control get +1/+1 and have vigilance", "Other Elf creatures you control
// get +1/+1", "Other non-Human creatures you control have undying", and
// bare tribal lords with no "you control" at all — "Other Merfolk get
// +1/+1 and have islandwalk" pumps EVERY player's Merfolk. The type
// restriction is enforced (anthemAppliesTo), not just tolerated.
const NON_CREATURE_SUBJECTS = new Set(['artifacts', 'lands', 'enchantments', 'planeswalkers', 'spells', 'permanents', 'tokens', 'players', 'opponents', 'you', 'they', 'it']);
function parseCreatureAnthemLine(line) {
  const m = line.match(/^(other )?(.+?)( you control)?( of the chosen type)? (get ([+-]\d+)\/([+-]\d+)(?: and (?:have|has) ([^.]+))?|(?:have|has) ([^.]+))/);
  if (!m) return null;
  const core = m[2].trim();
  let subtype = null, tokenOnly = false;
  if (core === 'creature tokens') tokenOnly = true;
  else if (core === 'creatures') { /* every creature */ }
  else if (/^[a-z-]+ creatures$/.test(core)) subtype = core.replace(/ creatures$/, '');
  else if (/^[a-z-]+$/.test(core) && !NON_CREATURE_SUBJECTS.has(core)) subtype = core;
  else return null;
  const youControl = !!m[3];
  // "Creatures get +1/+1" with no subtype and no "you control" would be a
  // global effect worded differently from every anthem this targets.
  if (!youControl && !subtype) return null;
  return {
    other: !!m[1], tokenOnly, subtype, youControl, chosenType: !!m[4],
    power: m[6] ? parseInt(m[6], 10) : 0,
    toughness: m[7] ? parseInt(m[7], 10) : 0,
    grantText: m[8] || m[9] || '',
  };
}

// Whether a parsed anthem line from `source` applies to `perm`.
function anthemAppliesTo(a, source, perm) {
  if (a.other && source.id === perm.id) return false;
  if (a.youControl && source.controllerId !== perm.controllerId) return false;
  const typeLine = (perm.card.typeLine || '').toLowerCase();
  if (a.tokenOnly && !/\btoken\b/.test(typeLine)) return false;
  if (a.chosenType && (!source.chosenType || !typeLine.includes(source.chosenType.toLowerCase()))) return false;
  if (a.subtype) {
    const negated = a.subtype.startsWith('non-');
    const word = negated ? a.subtype.slice(4) : a.subtype;
    const forms = new Set([word, word.replace(/ves$/, 'f'), word.replace(/ies$/, 'y'), word.replace(/s$/, '')]);
    const subtypes = (typeLine.split('—')[1] || '').split(/\s+/).filter(Boolean);
    const has = subtypes.some(s => forms.has(s)) || (isChangeling(perm.card) && ![...forms].some(f => NON_CREATURE_TYPE_WORDS.has(f)));
    if (negated ? has : !has) return false;
  }
  return true;
}

let nextId = 1;
function uid(prefix) { return `${prefix}_${nextId++}`; }

function makePermanent(card, controllerId) {
  const counters = {};
  // A planeswalker's loyalty is tracked as just another counter type
  // (counterStatTotal's power/toughness math only reads "+P/+T"-shaped
  // keys, so this is invisible to it) — reusing the existing counters
  // object rather than a separate field means +1/+1-style effects that
  // target "loyalty counters" generically (rare, but real) need no new
  // plumbing.
  if (isPlaneswalker(card)) counters.loyalty = parseInt(card.loyalty, 10) || 0;
  return {
    id: uid('perm'),
    card,
    controllerId,
    ownerId: controllerId,
    tapped: false,
    // Every nonland permanent is "new" the turn it arrives — only matters
    // for creatures, but a Vehicle crewed the turn it entered can't attack.
    summoningSick: !isLand(card),
    damage: 0,
    counters,
    attachedTo: null, // for Auras/Equipment: instanceId of permanent this is on
    attacking: false,
    attackTarget: null,    // { type: 'player' | 'planeswalker', id } set when declared as an attacker — see declareAttackers
    blocking: null,       // id of permanent this is blocking
    blockedBy: [],         // ids of permanents blocking this one
    tempBuffs: [],          // { power, toughness } cleared at cleanup
    tempKeywords: [],       // keyword strings granted "until end of turn", cleared at cleanup
    dealtDamageThisCombat: false,
    monstrous: false,      // set by Monstrosity (see applyMonstrosityEffect) — a one-way flag, never clears
    exiledCard: null,       // Oblivion Ring-style "return the exiled card" — the card THIS permanent exiled, if any
    exiledCardOwnerId: null,
    activatedLoyaltyAbilityThisTurn: false, // one loyalty ability per planeswalker per turn — reset at untap
    chosenType: null, // "as this enters, choose a creature type" (Herald's Horn, Cavern of Souls, ...) — see applyChooseCreatureTypeEffect
    skipNextUntap: false, // one-shot "doesn't untap during its controller's next untap step" (Frost Breath) — consumed the next time the untap step checks it
    wasKicked: false, // set by resolveTop when the caster paid this spell's optional Kicker cost — see castSpell's `kicked` parameter
    escaped: false, // set by resolveTop when this permanent was cast via its own Escape cost — see castFromGraveyard
    unearthed: false, // returned via Unearth — exiled at the next end step or if it would leave the battlefield; see exileIfUnearthed
    // Class enchantments (Alchemist's Talent, Ranger Class, ...) — classLevel
    // starts at 1 the moment a Class enters (set by triggerETB) and climbs
    // via levelUpClass; classOriginalOracleText is the untouched printed
    // text (levels re-parsed from it every time), since perm.card.oracleText
    // itself gets REWRITTEN to just the currently-active levels' text (see
    // recomputeClassEffectiveOracleText) so every other trigger/static
    // dispatch point in this engine — which all just read card.oracleText —
    // automatically sees the right cumulative text with no changes of their own.
    classLevel: 0,
    classOriginalOracleText: null,
    attachedToPlayerId: null, // for "Enchant player" Auras (the Curse cycle) — see resolveTop's isAura branch; distinct from attachedTo (a permanent's id) since every existing attachedTo call site assumes a permanent
    grantsControlOf: null, // for a "you control enchanted creature" Aura (Mind Control, Control Magic) — the id of the creature it's currently controlling; see applyAuraControlEffect/detachFromLeavingBattlefield
  };
}

function makePlayer(id, name, deck, isAI, startingLife = 20) {
  return {
    id, name, isAI,
    life: startingLife,
    library: shuffle(deck),
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    // Cards exiled with a temporary "you may play this" permission
    // (Ragavan, Nimble Pilferer; Nightveil Specter) — distinct from the
    // plain `exile` zone above, which has no play permission attached.
    // Each entry: { id, card, remainingOwnTurns }, pruned in doCleanup.
    exiledPlayable: [],
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    landPlayedThisTurn: false,
    lost: false,
    // Commander-format-only fields (unused/inert otherwise): the commander
    // card itself, whether it's currently sitting in the command zone
    // (false once it's cast onto the battlefield), how many times it's been
    // cast from the zone so far (each cast adds {2} to its cost — the
    // "commander tax"), and how much combat damage this player has taken
    // from an opponent's commander specifically (21+ from a single
    // commander is its own loss condition, separate from life total).
    commander: null,
    // Commander format: one entry per commander (two with Partner / a
    // Background): { card, inZone, castCount }. `commander` stays the first
    // one's card for display code.
    commanders: [],
    commanderZone: false,
    commanderCastCount: 0,
    commanderDamageFrom: {},
    // Companion: a card outside the game that can be put into hand for {3}
    // once per game (sorcery speed).
    companion: null,
    companionUsed: false,
    commanderDamageTaken: 0,
    // Player-level counters (experience, energy, poison, ...) — a plain
    // object keyed by counter-type string, same shape as a permanent's
    // .counters. Populated by applyPlayerCounterEffect (e.g. "you get an
    // experience counter") and grown by applyProliferateEffect.
    counters: {},
    // Running total of damage taken THIS TURN (any source — combat, spells,
    // abilities), reset at the start of each of the player's own turns
    // (Simulacrum-style "equal to the damage dealt to you this turn" cards).
    damageTakenThisTurn: 0,
    // Cards exiled with time counters via Suspend: [{ card, timeCounters }].
    // One counter comes off each of this player's upkeeps; the last one
    // casts the card for free (see tickSuspended).
    suspended: [],
    // Cards drawn so far this turn — Miracle cares whether a card is the
    // FIRST one drawn this turn. Reset at the start of every turn.
    cardsDrawnThisTurn: 0,
    // Per-turn facts some alternative costs check: Surge (cast another
    // spell this turn), Spectacle (an opponent lost life this turn —
    // compared against life at the turn's start), Prowl/Freerunning (a
    // creature of a given type, or a commander, dealt combat damage to a
    // player this turn). All reset at the start of every turn.
    spellsCastThisTurn: 0,
    lifeAtTurnStart: 20,
    combatDamagerTypesThisTurn: [],
    // Emblems (a planeswalker ultimate's "You get an emblem with '...'") —
    // no physical card, so just the raw granted-ability text strings,
    // checked by anthemBonus/effectiveKeywords the same way a permanent's
    // own printed anthem/keyword-grant text already is. Never removed —
    // real rules: emblems last for the rest of the game.
    emblems: [],
  };
}

export class Game {
  // aiControlsA lets both seats be bots (used by the headless simulation
  // harness and the browser's "watch" mode — real interactive play always
  // has a human in seat A, so this defaults off). aiThinkDelayMs paces
  // AI decisions with a real delay instead of firing them back-to-back on
  // the microtask queue; 0 (the default, used by the headless harness) lets
  // a bot-vs-bot game finish as fast as possible, while the browser's watch
  // mode sets this so each action is actually visible before the next fires.
  // commanderMode switches on the Commander-format rules below (40 starting
  // life, a command zone each player can cast their commander from, the tax
  // that grows each time, commander damage as a second loss condition, and
  // commanders returning to the zone instead of the graveyard/exile). The
  // rest of the engine — turns, stack, combat, effects — is unchanged and
  // shared with regular constructed games.
  constructor({
    deckA, deckB, nameA = 'You', nameB = 'Opponent', aiControlsA = false, aiControlsB = true, aiThinkDelayMs = 0,
    commanderMode = false, commanderA = null, commanderB = null, companionA = null, companionB = null,
  }) {
    const startingLife = commanderMode ? 40 : 20;
    this.players = [
      makePlayer('p0', nameA, deckA, aiControlsA, startingLife),
      makePlayer('p1', nameB, deckB, aiControlsB, startingLife),
    ];
    this.commanderMode = commanderMode;
    if (commanderMode) {
      // commanderA/B: a card, or an array of two for partners.
      [commanderA, commanderB].forEach((cmd, i) => {
        const list = (Array.isArray(cmd) ? cmd : [cmd]).filter(Boolean);
        const pl = this.players[i];
        pl.commanders = list.map(card => ({ card, inZone: true, castCount: 0 }));
        this.syncCommanderFields(pl);
      });
    }
    this.aiThinkDelayMs = aiThinkDelayMs;
    this.activePlayerIndex = 0;
    this.priorityPlayerIndex = 0;
    this.consecutivePasses = 0;
    // Circuit breaker against a class of bug this engine has actually hit:
    // a misclassified "free" ability (e.g. an unrecognized cost symbol
    // treated as payable) that the AI can activate forever without ever
    // needing to pass, hanging the game in an infinite microtask loop. Real
    // turns with many genuine actions stay well under this; see pass()
    // (resets it) and maybeLetAIAct() (enforces it).
    this._actionsSinceLastPass = 0;
    this.stepIndex = 0;
    this.turnNumber = 1;
    if (companionA) this.players[0].companion = companionA;
    if (companionB) this.players[1].companion = companionB;
    // "There is an additional combat phase" (Aurelia's own attack trigger,
    // Relentless Assault, Waves of Aggression) — a count of extra
    // combat-then-main blocks still owed, consumed one at a time by
    // advanceStep() at the next real phase boundary (leaving endCombat or
    // main2) rather than inserted immediately, matching how the effect
    // actually reads ("AFTER this phase").
    this.pendingExtraCombats = 0;
    // Permanents that went from the battlefield to a graveyard THIS TURN —
    // { card, ownerId } entries, cleared at the next untap step. Needed for
    // "return to the battlefield all permanent cards in your graveyard that
    // were put there from the battlefield this turn" (Faith's Reward, and
    // similar mass-reanimation-but-only-freshly-dead effects), which real
    // rules distinguish from older graveyard contents.
    this.leftBattlefieldThisTurn = [];
    // Temporary control changes ("Threaten" effects — Zealous Conscripts,
    // Gilded Drake-style exchanges, etc.) still owed a revert — entries are
    // { permId, originalControllerId }, applied back at cleanup (see
    // revertControlChanges). Once a permanent's control reverts, if it's no
    // longer on any battlefield (died, was exiled, etc. while under
    // temporary control) the entry is just dropped — nothing to revert.
    this.controlChanges = [];
    this.stack = [];
    this.logLines = [];
    this.gameOver = false;
    this.winner = null;
    this.pendingRequest = null; // describes UI input currently required
    this.listeners = [];
    this._firstTurn = true;
    this.mulligans = { p0: 0, p1: 0 };

    for (const p of this.players) this.dealOpeningHand(p);
    this.log(`${this.players[0].name} and ${this.players[1].name} draw their opening hands.`);
    this.resolveAIMulligan();
    this.beginHumanMulligan();
  }

  // ---------- mulligans (London mulligan: redraw 7, then bottom N) ----------

  dealOpeningHand(p) {
    for (let i = 0; i < 7; i++) this.drawCard(p, true);
  }

  // Runs the same one-time heuristic mulligan for every AI-controlled
  // player (not just "the" AI — a bot-vs-bot simulation has two).
  resolveAIMulligan() {
    for (const ai of this.players.filter(p => p.isAI)) this.resolveAIMulliganFor(ai);
  }

  resolveAIMulliganFor(ai) {
    // Simple one-time heuristic mulligan: redraw on a very land-light or
    // land-heavy hand, keep otherwise.
    const lands = ai.hand.filter(c => isLand(c)).length;
    if (lands <= 1 || lands >= 6) {
      this.mulligans[ai.id] += 1;
      ai.library.push(...ai.hand);
      ai.hand = [];
      this.dealOpeningHand(ai);
      const worst = ai.hand.slice().sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
      const idx = ai.hand.findIndex(c => c.instanceId === worst.instanceId);
      if (idx !== -1) ai.library.push(ai.hand.splice(idx, 1)[0]);
      this.log(`${ai.name} mulligans to ${7 - this.mulligans[ai.id]}.`);
    } else {
      this.log(`${ai.name} keeps their opening hand.`);
    }
  }

  // Only human-controlled players need a UI mulligan prompt; if there are
  // none (e.g. a bot-vs-bot simulation), skip straight into the game.
  beginHumanMulligan() {
    const human = this.players.find(p => !p.isAI);
    if (!human) { this.enterStep('untap'); return; }
    this.pendingRequest = { type: 'mulligan', playerId: human.id, mulligansTaken: this.mulligans[human.id] };
    this.emit();
  }

  mulligan(playerId) {
    if (this.pendingRequest?.type !== 'mulligan' || this.pendingRequest.playerId !== playerId) return false;
    const p = this.getPlayer(playerId);
    this.mulligans[playerId] += 1;
    p.library.push(...p.hand);
    p.hand = [];
    this.dealOpeningHand(p);
    this.log(`${p.name} mulligans to ${7 - this.mulligans[playerId]}.`);
    this.pendingRequest = { type: 'mulligan', playerId, mulligansTaken: this.mulligans[playerId] };
    this.emit();
    return true;
  }

  keepHand(playerId) {
    if (this.pendingRequest?.type !== 'mulligan' || this.pendingRequest.playerId !== playerId) return false;
    const p = this.getPlayer(playerId);
    const n = this.mulligans[playerId];
    if (n > 0) {
      this.pendingRequest = { type: 'mulliganBottom', playerId, count: n };
      this.emit();
      return true;
    }
    this.pendingRequest = null;
    this.log(`${p.name} keeps their opening hand.`);
    this.enterStep('untap');
    return true;
  }

  putOnBottom(playerId, instanceIds) {
    if (this.pendingRequest?.type !== 'mulliganBottom' || this.pendingRequest.playerId !== playerId) return false;
    if (instanceIds.length !== this.pendingRequest.count) return false;
    const p = this.getPlayer(playerId);
    for (const id of instanceIds) {
      const idx = p.hand.findIndex(c => c.instanceId === id);
      if (idx === -1) continue;
      p.library.push(p.hand.splice(idx, 1)[0]);
    }
    this.pendingRequest = null;
    this.log(`${p.name} keeps a hand of ${p.hand.length} after putting ${instanceIds.length} card(s) on the bottom.`);
    this.enterStep('untap');
    return true;
  }

  // ---------- plumbing ----------

  onChange(fn) { this.listeners.push(fn); }
  emit() {
    this.showNextChoice();
    for (const fn of this.listeners) fn(this);
  }

  // ---------- undo ----------
  // Only these fields are real game STATE — deliberately excludes
  // `listeners` (app wiring, not state, and holds live callback functions
  // structuredClone can't touch) and `_pendingETB` (an in-flight ETB
  // target-choice closure that also holds functions — mid-ETB-prompt undo
  // just isn't supported, a rare enough moment to click Undo in).
  static SNAPSHOT_FIELDS = [
    'players', 'stack', 'activePlayerIndex', 'priorityPlayerIndex', 'consecutivePasses',
    'stepIndex', 'turnNumber', 'logLines', 'gameOver', 'winner', 'pendingRequest',
    '_firstTurn', 'mulligans', '_actionsSinceLastPass', 'pendingExtraCombats', 'leftBattlefieldThisTurn', 'monarch', 'monarchExiles', 'isDraw', 'permanentsLeftThisTurn', 'spellWarpedThisTurn', 'dayNight', 'spellsCastLastTurn', 'maxSpellsByOnePlayerLastTurn',
    'controlChanges',
  ];

  // A deep-cloned snapshot of everything undo needs to restore — safe to
  // hold onto indefinitely since it shares no references with live state.
  snapshot() {
    const data = {};
    for (const key of Game.SNAPSHOT_FIELDS) data[key] = this[key];
    return structuredClone(data);
  }

  // Restores state from a snapshot taken earlier via snapshot() — deep
  // clones it again on the way in, so the snapshot itself stays reusable
  // (not strictly needed for a single-level undo, but cheap insurance).
  restore(snapshot) {
    const cloned = structuredClone(snapshot);
    for (const key of Game.SNAPSHOT_FIELDS) this[key] = cloned[key];
  }

  // Once the game is over, only the game-over line itself is logged (a chain
  // of effects still unwinding would otherwise bury it).
  log(line, force = false) {
    if (this.gameOver && !force) return;
    this.logLines.push(line);
    if (this.logLines.length > 300) this.logLines.shift();
  }

  get active() { return this.players[this.activePlayerIndex]; }
  get defender() { return this.players[1 - this.activePlayerIndex]; }
  get priorityPlayer() { return this.players[this.priorityPlayerIndex]; }
  get step() { return STEP_ORDER[this.stepIndex]; }

  getPlayer(id) { return this.players.find(p => p.id === id); }
  opponentOf(id) { return this.players.find(p => p.id !== id); }

  findPermanent(instanceId) {
    for (const p of this.players) {
      const perm = p.battlefield.find(x => x.id === instanceId);
      if (perm) return perm;
    }
    return null;
  }

  allCreatures() {
    return this.players.flatMap(p => p.battlefield.filter(perm => isCreature(perm.card)));
  }

  // ---------- zones / drawing ----------

  drawCard(player, silent = false, { noDredge = false } = {}) {
    // Dredge replaces a draw (AI only here — a human is offered it for the
    // draw step's draw; see the draw step in advanceStep).
    if (!silent && !noDredge && player.isAI) {
      const dredgeCard = this.aiDredgeChoice(player);
      if (dredgeCard && this.dredge(player, dredgeCard)) return;
    }
    if (player.library.length === 0) {
      this.loseGame(player.id, 'tried to draw from an empty library');
      return;
    }
    const card = player.library.shift();
    player.hand.push(card);
    if (!silent) {
      // Silent draws are the opening hand and mulligans — those never count
      // as "drawn this turn" for Miracle.
      player.cardsDrawnThisTurn = (player.cardsDrawnThisTurn || 0) + 1;
      this.log(`${player.name} draws a card.`);
      this.triggerDrawCard(player);
      if (player.cardsDrawnThisTurn === 1) this.offerMiracle(player, card);
    }
  }

  // Fires "whenever you draw a card" triggers (Fathom Mage, ...) — always
  // self-referential to the drawing player's own permanents.
  triggerDrawCard(player) {
    for (const perm of [...player.battlefield]) {
      if (!this.findPermanent(perm.id)) continue;
      const steps = interpretDrawTriggers(perm.card);
      if (steps.length === 0) continue;
      this.resolveEffectSteps(steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
    }
    this.checkStateBasedActions();
  }

  // Fires "whenever a [Type] you control enters, EFFECT" triggers
  // (Forerunner of the Empire's Dinosaur payoff, and the same common
  // "tribal ETB" shape on lots of other tribal-deck creatures) — checked on
  // every permanent the ENTERING permanent's controller controls
  // (including the entering permanent itself — real rules don't exclude
  // "itself" unless the text says "another"), whenever ANY permanent enters
  // the battlefield. Piggybacked onto triggerETB, so it fires from every
  // real entry path with no separate call sites needed.
  triggerTribalEtb(enteredPerm) {
    const controller = this.getPlayer(enteredPerm.controllerId);
    const enteredTypeLine = (enteredPerm.card.typeLine || '').toLowerCase();
    for (const watcher of [...controller.battlefield]) {
      if (!this.findPermanent(watcher.id)) continue;
      const entries = interpretTribalEtbTriggers(watcher.card);
      for (const entry of entries) {
        if (!hasTypeWord(enteredPerm.card, entry.typeWord)) continue;
        // "A creature you control WITH FLYING enters" (Dragon Tempest) — a
        // keyword filter on top of the type-line one above, checked against
        // the entering permanent's REAL effective keywords (anthem-granted
        // included), not just its own printed keyword list.
        if (entry.keywordFilter && !this.effectiveKeywords(enteredPerm).has(entry.keywordFilter)) continue;
        // "Another [Type] you control enters" (Marwyn, the Nurturer) is
        // exclusive of the watcher's own arrival — she shouldn't trigger off
        // herself entering — unlike every other tribal-ETB wording, which
        // includes self-entering.
        if (entry.excludesSelf && watcher.id === enteredPerm.id) continue;
        // enteredPerm is threaded through separately from sourcePerm (the
        // WATCHER) so effects that care about the specific creature that
        // triggered this — "you gain life equal to THAT creature's
        // toughness" (Verdant Sun's Avatar) — can tell the two apart, since
        // they're often different permanents (this fires for every OTHER
        // creature entering too, not just the watcher's own arrival).
        // A tribal-ETB trigger fires automatically as a side effect of
        // something else entering — there's no direct player action to
        // hang a real target-choice UI off of, so any step that needs a
        // target (Terror of the Peaks' "deals damage ... to any target")
        // gets one auto-picked instead, same simplification used for
        // landfall's own player-target default just above.
        const targets = entry.steps.filter(s => s.targeting !== 'none').map(s => this.autoPickTarget(s.targeting, watcher.controllerId));
        this.resolveEffectSteps(entry.steps, targets, { controllerId: watcher.controllerId, card: watcher.card, sourcePerm: watcher, enteredPerm });
      }
    }
    this.checkStateBasedActions();
  }

  // "Whenever an artifact enters, you may untap this artifact." (Grinding
  // Station) — unlike triggerTribalEtb just above (scoped to the entering
  // permanent's OWN controller's watchers), this scans EVERY player's
  // battlefield for a matching watcher, since the real wording has no "you
  // control" qualifier at all.
  triggerAnyEtb(enteredPerm) {
    const enteredTypeLine = (enteredPerm.card.typeLine || '').toLowerCase();
    for (const pl of this.players) {
      for (const watcher of [...pl.battlefield]) {
        if (!this.findPermanent(watcher.id)) continue;
        const entries = interpretAnyEtbTriggers(watcher.card);
        for (const entry of entries) {
          if (!enteredTypeLine.includes(entry.typeWord)) continue;
          const targets = entry.steps.filter(s => s.targeting !== 'none').map(s => this.autoPickTarget(s.targeting, watcher.controllerId));
          this.resolveEffectSteps(entry.steps, targets, { controllerId: watcher.controllerId, card: watcher.card, sourcePerm: watcher, enteredPerm });
        }
      }
    }
    this.checkStateBasedActions();
  }

  // Fires "landfall" triggers (Hedron Crab, and the whole landfall
  // mechanic) — checked on every permanent the LAND's OWN controller
  // controls, whenever a land actually enters (playing one, or any land
  // fetch effect putting one into play).
  triggerLandfall(landPerm) {
    const controller = this.getPlayer(landPerm.controllerId);
    // Almost every real landfall watcher cares about ITS OWN controller's
    // lands (scope 'own'); Sire of Stagnation's own "a land AN OPPONENT
    // CONTROLS enters" is the one common exception (scope 'opponent') — so
    // a watcher on landPerm's controller's OWN battlefield fires on 'own'
    // entries, while a watcher on the OPPONENT's battlefield fires on
    // 'opponent' entries. Both loops key off the same landPerm event.
    for (const pl of this.players) {
      const wantedScope = pl.id === controller.id ? 'own' : 'opponent';
      for (const watcher of [...pl.battlefield]) {
        if (!this.findPermanent(watcher.id)) continue;
        const entries = interpretLandfallTriggers(watcher.card);
        for (const entry of entries) {
          if (entry.scope !== wantedScope) continue;
          if (entry.steps.length === 0) continue;
          // No real target-choice UI for a landfall trigger's own player
          // target (Hedron Crab's "target player mills three cards") —
          // defaults to the WATCHER's controller themselves, matching the
          // overwhelmingly common real use (self-mill combo pieces), same
          // "reasonable default over a whole new UI" philosophy used
          // throughout this engine (edict/tutor auto-picks).
          const targets = entry.steps.filter(s => s.targeting !== 'none').map(() => ({ type: 'player', id: watcher.controllerId }));
          this.resolveEffectSteps(entry.steps, targets, { controllerId: watcher.controllerId, card: watcher.card, sourcePerm: watcher });
        }
      }
    }
    // Self-recursion landfall triggers printed on a card currently sitting
    // in the GRAVEYARD (Bloodghast's "Landfall — Whenever a land you
    // control enters, you may return this card from your graveyard to the
    // battlefield.") — a fundamentally different watcher shape from the
    // battlefield loop above (no permanent object exists for a graveyard
    // card), so this is dispatched separately with ctx.card pointing
    // directly at the graveyard card the resolve function needs to move.
    // Always 'own' scope in practice (a card recurring itself only ever
    // cares about ITS OWNER's own lands), so the graveyard owner IS the
    // land's controller here — no cross-player scan needed.
    for (const card of [...controller.graveyard]) {
      if (!controller.graveyard.includes(card)) continue; // already moved by an earlier iteration this same landfall event
      const entries = interpretLandfallTriggers(card).filter(e => e.scope === 'own');
      for (const entry of entries) {
        if (entry.steps.length === 0) continue;
        this.resolveEffectSteps(entry.steps, [], { controllerId: controller.id, card });
      }
    }
    this.checkStateBasedActions();
  }

  // Fires "when this [enchantment/permanent] leaves the battlefield"
  // triggers (Oblivion Ring, Journey to Nowhere, Banishing Light's own
  // "until this leaves the battlefield" clause, ...) — self-only, called
  // from every path that actually removes a permanent from a battlefield
  // (graveyard, exile, bounce), alongside detachFromLeavingBattlefield.
  triggerLeavesBattlefield(perm) {
    for (const id of perm.phasedOutByThis || []) {
      for (const pl of this.players) {
        const entry = (pl.phasedOut || []).find(e => e.perm.id === id);
        if (entry) this.phaseIn(entry, { tap: true });
      }
    }
    perm.phasedOutByThis = null;
    // Champion: the championed card returns when this leaves.
    if (perm.championed) {
      const { card: returning, ownerId } = perm.championed;
      perm.championed = null;
      const owner = this.getPlayer(ownerId);
      const i = owner.exile.indexOf(returning);
      if (i !== -1) {
        owner.exile.splice(i, 1);
        const back = makePermanent(returning, ownerId);
        owner.battlefield.push(back);
        this.log(`${returning.name} returns to the battlefield (${perm.card.name} left).`);
        this.triggerETB(back);
      }
    }
    const steps = interpretLeavesTriggers(perm.card);
    if (steps.length === 0) return;
    this.resolveEffectSteps(steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
    this.checkStateBasedActions();
  }

  // "Reveal that many cards from the top of your library. Put any number
  // of [Type] cards from among them onto the battlefield and the rest on
  // the bottom of your library in a random order." (Gishath, Sun's
  // Avatar's own combat-damage trigger, and similar) — "that many" is
  // ctx.combatDamageAmount. Puts every matching card into play (see the
  // "no real choice UI" note where this is parsed) and the rest go to the
  // bottom, in whatever order they happened to be revealed (a real random
  // shuffle of just those cards isn't worth modeling against a bot that
  // never gets to look ahead anyway).
  applyRevealDamageDigEffect(ctx, typeWord) {
    const p = this.getPlayer(ctx.controllerId);
    const amount = ctx.combatDamageAmount || 0;
    if (amount <= 0 || p.library.length === 0) return;
    const revealed = p.library.splice(0, Math.min(amount, p.library.length));
    const typeFilter = typeWord.split(/\s+/)[0].toLowerCase();
    const matches = revealed.filter(c => (c.typeLine || '').toLowerCase().includes(typeFilter));
    const rest = revealed.filter(c => !matches.includes(c));
    for (const card of matches) {
      const perm = makePermanent(card, ctx.controllerId);
      p.battlefield.push(perm);
      this.triggerETB(perm);
    }
    p.library.push(...rest);
    this.log(`${ctx.card.name} reveals ${revealed.length} card${revealed.length === 1 ? '' : 's'}, putting ${matches.length} onto the battlefield.`);
    this.checkStateBasedActions();
  }

  // "Reveal the top X cards of your library. Put any number of permanent
  // cards with mana value X or less from among them onto the battlefield.
  // Then put the rest into your graveyard." (Genesis Wave) — a CMC-filtered
  // sibling of applyRevealDamageDigEffect's type filter above; the "not put
  // onto the battlefield" leftovers go to the GRAVEYARD here (not the
  // bottom of the library, unlike Gishath's version) — that's the actual
  // real-card difference between the two templates.
  applyGenesisWaveEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const x = ctx.xValue || 0;
    if (x <= 0 || p.library.length === 0) return;
    const revealed = p.library.splice(0, Math.min(x, p.library.length));
    const matches = revealed.filter(c => isPermanentType(c) && (c.cmc || 0) <= x);
    const rest = revealed.filter(c => !matches.includes(c));
    for (const card of matches) {
      const perm = makePermanent(card, ctx.controllerId);
      p.battlefield.push(perm);
      this.triggerETB(perm);
    }
    p.graveyard.push(...rest);
    this.log(`${ctx.card.name} reveals ${revealed.length} card${revealed.length === 1 ? '' : 's'}, putting ${matches.length} onto the battlefield and the rest into the graveyard.`);
    this.checkStateBasedActions();
  }

  // "Return the exiled card to the battlefield under its owner's control"
  // (the second half of Oblivion Ring's exile-and-return combo) — reads
  // back whatever this specific permanent exiled (see applyExileEffect).
  // Checks the card is still actually sitting in that owner's exile zone
  // first, so it can't ever duplicate a card that already left exile some
  // other way.
  applyReturnExiledCardEffect(ctx) {
    const sourcePerm = ctx.sourcePerm;
    const exiledCard = sourcePerm?.exiledCard;
    if (!exiledCard) return;
    const owner = this.getPlayer(sourcePerm.exiledCardOwnerId || sourcePerm.controllerId);
    const idx = owner.exile.indexOf(exiledCard);
    if (idx === -1) return;
    owner.exile.splice(idx, 1);
    const newPerm = makePermanent(exiledCard, owner.id);
    owner.battlefield.push(newPerm);
    this.log(`${exiledCard.name} returns to the battlefield under ${owner.name}'s control.`);
    this.checkStateBasedActions();
    this.triggerETB(newPerm);
  }

  // "Exile target nonland permanent not named Detention Sphere and all
  // other permanents with the same name as that permanent" (Detention
  // Sphere) — a multi-card sibling of applyExileEffect above, since the
  // singular exiledCard/exiledCardOwnerId fields can't hold more than one
  // card. Tracks the whole batch in ctx.sourcePerm.exiledCards instead,
  // paired with applyReturnExiledCardsEffect below.
  applyExileWithSameNameEffect(ctx) {
    if (ctx.target?.type !== 'permanent') return;
    const target = this.findPermanent(ctx.target.id);
    if (!target) return;
    const matches = [];
    for (const pl of this.players) {
      for (const perm of pl.battlefield) {
        if (perm.card.name === target.card.name) matches.push(perm);
      }
    }
    const exiled = [];
    for (const perm of matches) {
      const p = this.getPlayer(perm.controllerId);
      p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
      this.detachFromLeavingBattlefield(perm);
      this.triggerLeavesBattlefield(perm);
      if (this.redirectCommanderToZone(perm)) continue;
      // Exile is a zone change like any other — goes to the OWNER, not
      // necessarily the controller (see movePermanentToGraveyard's own
      // owner-vs-controller fix).
      this.getPlayer(perm.ownerId).exile.push(perm.card);
      exiled.push({ card: perm.card, ownerId: perm.ownerId });
    }
    if (ctx.sourcePerm) ctx.sourcePerm.exiledCards = exiled;
    this.log(`${ctx.card.name} exiles ${exiled.length > 0 ? exiled.map(e => e.card.name).join(', ') : 'nothing'}.`);
  }

  // "Return the exiled cards to the battlefield under their owner's
  // control" (Detention Sphere's own leaves-the-battlefield trigger) —
  // plural sibling of applyReturnExiledCardEffect, reading back everything
  // tracked by applyExileWithSameNameEffect.
  // Same bookkeeping, but the cards go to their owners' hands.
  applyReturnExiledCardsToHandEffect(ctx) {
    const src = ctx.sourcePerm;
    if (!src) return;
    const list = src.exiledCards?.length ? src.exiledCards : (src.exiledCard ? [{ card: src.exiledCard, ownerId: src.exiledCardOwnerId }] : []);
    for (const { card, ownerId } of list) {
      const owner = this.getPlayer(ownerId);
      const idx = owner.exile.indexOf(card);
      if (idx === -1) continue;
      owner.exile.splice(idx, 1);
      owner.hand.push(card);
      this.log(`${card.name} returns to ${owner.name}'s hand.`);
    }
    src.exiledCards = [];
    src.exiledCard = null;
  }

  applyReturnExiledCardsEffect(ctx) {
    const exiledCards = ctx.sourcePerm?.exiledCards;
    if (!exiledCards || exiledCards.length === 0) return;
    for (const { card, ownerId } of exiledCards) {
      const owner = this.getPlayer(ownerId);
      const idx = owner.exile.indexOf(card);
      if (idx === -1) continue;
      owner.exile.splice(idx, 1);
      const newPerm = makePermanent(card, owner.id);
      owner.battlefield.push(newPerm);
      this.log(`${card.name} returns to the battlefield under ${owner.name}'s control.`);
      this.checkStateBasedActions();
      this.triggerETB(newPerm);
    }
    ctx.sourcePerm.exiledCards = [];
  }

  // "The owner of target permanent shuffles it into their library, then
  // reveals the top card of their library. If it's a permanent card, they
  // put it onto the battlefield." (Chaos Warp) — genuine removal with a
  // random chance of giving the owner something back; unlike every other
  // "shuffle into library" effect here, the replacement is left to chance,
  // not an auto-pick.
  applyChaosWarpEffect(ctx) {
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    const owner = this.getPlayer(perm.ownerId);
    const p = this.getPlayer(perm.controllerId);
    p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
    this.detachFromLeavingBattlefield(perm);
    this.triggerLeavesBattlefield(perm);
    owner.library.push(perm.card);
    owner.library = shuffle(owner.library);
    this.log(`${ctx.card.name} shuffles ${perm.card.name} into ${owner.name}'s library.`);
    this.checkStateBasedActions();
    if (owner.library.length === 0) return;
    const revealed = owner.library[0];
    if (isPermanentType(revealed)) {
      owner.library.shift();
      const newPerm = makePermanent(revealed, owner.id);
      owner.battlefield.push(newPerm);
      this.log(`${owner.name} reveals ${revealed.name} and puts it onto the battlefield.`);
      this.checkStateBasedActions();
      this.triggerETB(newPerm);
    } else {
      this.log(`${owner.name} reveals ${revealed.name}, which isn't a permanent card.`);
    }
  }

  // "Defending player reveals the top card of their library. If it's a land
  // card, that player puts it into their hand." (Goblin Guide) — "defending
  // player" is simply the attacker's opponent in this always-2-player
  // engine.
  applyGoblinGuideEffect(ctx) {
    const opponent = this.opponentOf(ctx.controllerId);
    if (opponent.library.length === 0) return;
    const revealed = opponent.library[0];
    if (isLand(revealed)) {
      opponent.library.shift();
      opponent.hand.push(revealed);
      this.log(`${opponent.name} reveals ${revealed.name} off the top of their library and puts it into their hand.`);
    } else {
      this.log(`${opponent.name} reveals ${revealed.name}, which isn't a land card.`);
    }
  }

  // "Create a token that's a copy of this Equipment/artifact/permanent"
  // (Bloodforged Battle-Axe's own attachedCreature-scoped combat-damage
  // trigger) — ctx.card already IS the source's own card object for this
  // trigger shape, so this just stamps out a fresh permanent from it. The
  // new token starts unattached, same as real rules (equipping it is a
  // separate action).
  applyTokenCopyOfSelfEffect(ctx) {
    this.createTokenCopy(ctx.card, ctx.controllerId);
    this.log(`${ctx.card.name} creates a token copy of itself.`);
  }

  // Creates a token copy of a card under controllerId, firing its own ETB
  // triggers. stats: { power, toughness } override (Offspring's 1/1).
  createTokenCopy(card, controllerId, stats = null) {
    const perm = makePermanent(makeTokenCopyCard(card, stats), controllerId);
    this.getPlayer(controllerId).battlefield.push(perm);
    this.checkStateBasedActions();
    this.triggerETB(perm);
    return perm;
  }

  // "Search your library for an artifact card with mana value X or less,
  // put it onto the battlefield, then shuffle." (Reshape) — a type-
  // restricted tutor straight to the BATTLEFIELD (not hand), capped by the
  // spell's own {X} value rather than a literal number.
  applyTutorToBattlefieldEffect(ctx, typeWord, maxCmc) {
    const p = this.getPlayer(ctx.controllerId);
    const candidates = p.library.filter(c => hasTypeWord(c, typeWord) && (c.cmc || 0) <= maxCmc);
    if (candidates.length === 0) {
      this.log(`${ctx.card.name} finds no matching ${typeWord} card in ${p.name}'s library.`);
      p.library = shuffle(p.library);
      return;
    }
    const best = candidates.sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    p.library = p.library.filter(c => c !== best);
    const perm = makePermanent(best, ctx.controllerId);
    p.battlefield.push(perm);
    this.log(`${ctx.card.name} puts ${best.name} onto the battlefield.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
    p.library = shuffle(p.library);
  }

  // "Return it to its owner's hand" (Rancor, and similar self-bouncing
  // Auras) — ctx.card is the dying permanent's own card, already sitting in
  // its owner's graveyard by the time a dies trigger runs.
  applyReturnSelfToHandEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const idx = p.graveyard.indexOf(ctx.card);
    if (idx === -1) return;
    const [card] = p.graveyard.splice(idx, 1);
    p.hand.push(card);
    this.log(`${card.name} returns to ${p.name}'s hand.`);
  }

  // "Return this card from your graveyard to the battlefield" as a
  // TRIGGERED effect (Bloodghast's own Landfall trigger) — as opposed to
  // interpretGraveyardAbilities' "{cost}: return this card..." (an
  // activated ability the player chooses to pay for), this fires
  // automatically off triggerLandfall, with ctx.card already pointing at
  // the graveyard card itself.
  applyReturnSelfFromGraveyardEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const idx = p.graveyard.indexOf(ctx.card);
    if (idx === -1) return;
    const [card] = p.graveyard.splice(idx, 1);
    const perm = makePermanent(card, ctx.controllerId);
    p.battlefield.push(perm);
    this.log(`${card.name} returns from ${p.name}'s graveyard to the battlefield.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
  }

  // Fires "whenever a counter is put on this creature/permanent" triggers —
  // self-only, called after a counter is actually added to `perm`.
  triggerCounterAdded(perm) {
    const steps = interpretCounterAddedTriggers(perm.card);
    if (steps.length === 0) return;
    this.resolveEffectSteps(steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
    this.checkStateBasedActions();
  }

  // Fires "whenever this becomes the target of a spell" triggers for every
  // permanent target in a newly-cast spell's target list.
  triggerBecomesTarget(targets, sourceControllerId = null) {
    for (const t of targets || []) {
      if (t?.type !== 'permanent') continue;
      const perm = this.findPermanent(t.id);
      if (!perm) continue;
      // Valiant: targeted by its controller's spell/ability, first time each turn.
      const valiant = memoSteps(interpretValiantTriggers, perm.card);
      if (valiant.length && sourceControllerId === perm.controllerId && perm.valiantTurn !== this.turnNumber) {
        perm.valiantTurn = this.turnNumber;
        this.runPermanentTrigger(perm, valiant);
      }
      const steps = interpretBecomesTargetTriggers(perm.card);
      if (steps.length === 0) continue;
      this.resolveEffectSteps(steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm, spellControllerId: sourceControllerId });
    }
    this.checkStateBasedActions();
  }

  // Ward: if a newly-cast spell or activated/triggered ability targets an
  // OPPONENT's permanent that has a Ward cost, the caster/activator either
  // pays it or the whole spell/ability is countered. No real mid-cast "do
  // you want to pay" decision exists in this engine (the same
  // simplification used for every other "unless ... pays" clause
  // elsewhere), so this always pays if the caster can currently afford
  // it — a defensible default, since someone casting removal/disruption
  // generally does want it to resolve — and counters otherwise. Wired into
  // castSpell/castCommander (returns true → caller removes the stack item)
  // and activateTapAbility/activateNonTapAbility/activateLoyaltyAbility
  // (returns true → caller skips resolveEffectSteps; the activation cost
  // already paid stays paid, same as a countered spell still cost its
  // caster mana). Not checked for mana abilities (real rules: they can't
  // be responded to at all) or for the handful of auto-resolved trigger
  // paths (tribal-ETB, landfall, ...) that have no real "activator" to
  // charge a tax to in the first place.
  checkWardAndMaybeCounter(playerId, targets) {
    const p = this.getPlayer(playerId);
    for (const t of targets || []) {
      if (t?.type !== 'permanent') continue;
      const perm = this.findPermanent(t.id);
      if (!perm || perm.controllerId === playerId) continue; // Ward only cares about an OPPONENT targeting it
      const ward = getWardCost(perm.card);
      if (!ward) continue;
      let canPay = false;
      if (ward.life != null) {
        canPay = p.life > ward.life; // don't let paying Ward itself be lethal
        if (canPay) p.life -= ward.life;
      } else if (ward.manaCost) {
        const parsed = parseManaCost(ward.manaCost);
        const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
        const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
        canPay = !!payment;
        if (canPay) {
          for (const land of payment.lands) land.tapped = true;
          for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
        }
      }
      if (canPay) {
        this.log(`${p.name} pays ${perm.card.name}'s Ward cost.`);
      } else {
        this.log(`${p.name} doesn't pay ${perm.card.name}'s Ward cost — the spell is countered.`);
        return true;
      }
    }
    return false;
  }

  loseGame(playerId, reason) {
    if (this.gameOver) return;
    const loser = this.getPlayer(playerId);
    loser.lost = true;
    this.gameOver = true;
    this.winner = this.opponentOf(playerId).id;
    this.log(`${loser.name} loses the game (${reason}). ${this.getPlayer(this.winner).name} wins!`, true);
    this.emit();
  }

  // ---------- turn structure ----------

  enterStep(stepName) {
    this.stepIndex = STEP_ORDER.indexOf(stepName);
    this.consecutivePasses = 0;
    this.priorityPlayerIndex = this.activePlayerIndex;
    this.log(`— ${STEP_LABEL[stepName]} (${this.active.name}) —`);
    this.runStepEntryActions();
  }

  advanceStep() {
    this.resetTriggerChain();
    // Firebending mana survives step changes until combat ends.
    const inCombat = ['declareAttackers', 'declareBlockers', 'combatDamage'].includes(this.step);
    for (const p of this.players) {
      const keep = inCombat && p.firebendLeft ? Math.min(p.firebendLeft, p.manaPool.R) : 0;
      p.manaPool = { W: 0, U: 0, B: 0, R: keep, G: 0, C: 0 };
      p.firebendLeft = keep;
    }
    // "There is an additional combat phase[, followed by an additional main
    // phase]" — checked only at the two boundaries where it actually
    // changes anything (leaving endCombat, which would otherwise go
    // straight to main2; leaving main2, which would otherwise end the
    // turn). Leaving main1 is deliberately NOT checked here: main1 already
    // flows into beginCombat next regardless, so consuming a pending count
    // there would burn it for zero extra phases — this way, a use during
    // main1 still grants a real extra combat+main later, at the natural
    // main2-to-end boundary. STEP_ORDER's own interleaved
    // combat/main structure means redirecting to 'beginCombat' and letting
    // it flow through 'endCombat' -> 'main2' naturally reproduces exactly
    // "one more combat phase followed by one more main phase" with no
    // separate bookkeeping needed for the main-phase half.
    if (this.pendingExtraCombats > 0 && (this.step === 'endCombat' || this.step === 'main2')) {
      this.pendingExtraCombats -= 1;
      this.enterStep('beginCombat');
      return;
    }
    let next = this.stepIndex + 1;
    if (next >= STEP_ORDER.length) {
      this.endTurn();
      return;
    }
    this.enterStep(STEP_ORDER[next]);
  }

  // Grants "an additional combat phase" (Aurelia's own attack trigger,
  // Relentless Assault, Waves of Aggression) — see advanceStep() for where
  // this actually gets inserted.
  queueExtraCombatPhase() {
    this.pendingExtraCombats += 1;
  }

  endTurn() {
    this.activePlayerIndex = 1 - this.activePlayerIndex;
    this.turnNumber += 1;
    this._firstTurn = false;
    this.enterStep('untap');
  }

  runStepEntryActions() {
    const step = this.step;
    for (const perm of this.active.battlefield) {
      // reset per-combat flags at the start of each turn's untap step
    }
    if (step === 'untap') {
      this.applyPhasingAtUntap(this.active);
      for (const perm of this.active.battlefield) {
        // Two ways a permanent can skip its own untap: a STATIC self-
        // declaration re-checked fresh every turn (Mana Vault's own "this
        // artifact doesn't untap during your untap step" — the only way
        // to untap it is the separate {4}-during-upkeep effect, see
        // applyPayToUntapEffect), or a one-shot flag an external effect
        // applied (Frost Breath's "doesn't untap during its controller's
        // next untap step") — consumed here regardless of which caused it.
        const selfText = replaceSelfNameExport(perm.card, perm.card.oracleText || '', 'this creature').toLowerCase();
        const unlessUntap = selfText.match(/this (?:artifact|creature|permanent) doesn'?t untap during your untap step unless ([^.]+)/);
        const staticSkip = unlessUntap
          ? !(parseCondition(unlessUntap[1])?.(this, { controllerId: perm.controllerId, sourcePerm: perm, card: perm.card }) ?? true)
          : /this (?:artifact|creature|permanent) doesn'?t untap during your untap step/.test(selfText);
        if (staticSkip || perm.skipNextUntap) {
          perm.skipNextUntap = false;
        } else {
          // Inspired: "whenever this creature becomes untapped".
          if (perm.tapped) (this._untappedThisStep ||= []).push(perm);
          perm.tapped = false;
        }
        perm.summoningSick = false;
        perm.attacking = false;
        perm.attackTarget = null;
        perm.blocking = null;
        perm.blockedBy = [];
        perm.dealtDamageThisCombat = false;
        perm.activatedLoyaltyAbilityThisTurn = false;
      }
      this.active.landPlayedThisTurn = false;
      for (const perm of this._untappedThisStep || []) {
        const inspired = memoSteps(interpretUntapTriggers, perm.card);
        if (inspired.length && this.findPermanent(perm.id)) this.runPermanentTrigger(perm, inspired);
      }
      this._untappedThisStep = [];
      // Day/night moves on from what happened last turn (before it's reset).
      this.advanceDayNight(this.opponentOf(this.active.id));
      // "This turn" is a shared, global concept (only one turn happens at a
      // time) — a new turn beginning resets it for BOTH players, not just
      // whoever's turn it now is.
      for (const pl of this.players) { pl.damageTakenThisTurn = 0; pl.cardsDrawnThisTurn = 0; pl.spellsCastThisTurn = 0; pl.lifeAtTurnStart = pl.life; pl.combatDamagerTypesThisTurn = []; pl.discardedThisTurn = []; for (const perm of pl.battlefield) { perm.attackedThisTurn = false; perm.boastedThisTurn = false; } pl.forecastThisTurn = false; pl.speedRaisedThisTurn = false; pl.attackedThisTurnFlag = false; pl.lifeGainedThisTurn = 0; pl._lastLife = pl.life; pl.nonlandEnteredThisTurn = 0; pl.descendedThisTurn = false; pl._gyCountAtTurnStart = pl.graveyard.length; if (pl.advokistLockedUntilTurnOf === this.active.id) pl.advokistLockedUntilTurnOf = null; pl._gyPermCount = pl.graveyard.filter(c => /artifact|battle|creature|enchantment|land|planeswalker/i.test(c.typeLine || '')).length; }
      this.permanentsLeftThisTurn = []; this.spellWarpedThisTurn = false;
      this.leftBattlefieldThisTurn = [];
      this.advanceStep();
      return;
    }
    if (step === 'upkeep') {
      this.tickSuspended();
      this.tickRebound();
      this.tickEpic();
      this.tickUpkeepKeywords();
      this.triggerPhase(interpretUpkeepTriggers);
      this.triggerEnchantedPlayerUpkeep();
      this.openPriorityWindow();
      return;
    }
    if (step === 'draw') {
      const skip = this._firstTurn && this.activePlayerIndex === 0;
      const dredgeable = !skip && !this.active.isAI ? this.dredgeOptions(this.active) : [];
      if (dredgeable.length) {
        const pl = this.active;
        this.requestChoice(pl.id, 'Draw step: draw, or dredge instead?', [
          { label: 'Draw a card', resolve: () => this.drawCard(pl, false, { noDredge: true }) },
          ...dredgeable.slice(0, 6).map(c => ({ label: `Dredge ${c.name} (mill ${getDredgeAmount(c)})`, resolve: () => this.dredge(pl, c) })),
        ]);
      } else if (!skip) this.drawCard(this.active);
      else this.log(`${this.active.name} skips their first draw (going first).`);
      // A genuinely new trigger dispatch point (Mana Vault's own "at the
      // beginning of your draw step, if this artifact is tapped, deals 1
      // damage to you") — previously only upkeep/end-step existed.
      this.triggerPhase(interpretDrawStepTriggers);
      this.openPriorityWindow();
      return;
    }
    if (step === 'declareAttackers') {
      this.beginDeclareAttackers();
      return;
    }
    if (step === 'declareBlockers') {
      this.beginDeclareBlockers();
      return;
    }
    if (step === 'combatDamage') {
      this.resolveCombatDamage();
      this.checkStateBasedActions();
      this.openPriorityWindow();
      return;
    }
    if (step === 'end') {
      if (this.monarch === this.active.id) { this.log(`${this.active.name} draws a card (the monarch).`); this.drawCard(this.active); }
      // Prized Amalgam returns.
      for (const { card, ownerId, zone } of this._amalgamReturns || []) {
        const owner = this.getPlayer(ownerId);
        const from = zone === 'exile' ? owner.exile : owner.graveyard;
        const i = from.indexOf(card);
        if (i === -1) continue;
        from.splice(i, 1);
        const perm = makePermanent(card, ownerId);
        perm.tapped = zone !== 'exile';
        owner.battlefield.push(perm);
        this.log(`${card.name} returns to the battlefield tapped.`);
        this.triggerETB(perm);
      }
      this._amalgamReturns = [];
      // Fraying Sanity: the enchanted player mills as many cards as went to
      // their graveyard this turn.
      for (const pl of this.players) for (const aura of pl.battlefield.filter(x => x.attachedToPlayerId && /at the beginning of each end step, enchanted player mills x cards/i.test(x.card.oracleText || ''))) {
        const victim = this.getPlayer(aura.attachedToPlayerId);
        const x = Math.max(0, victim.graveyard.length - (victim._gyCountAtTurnStart ?? victim.graveyard.length));
        if (x > 0) this.applyMillEffect({ controllerId: pl.id, card: aura.card, target: { type: 'player', id: victim.id } }, x);
      }
      this.tickImpending(this.active);
      // Cases: "To solve — COND", checked at your end step.
      for (const perm of this.active.battlefield) {
        const cond = !perm.solved && getCaseSolve(perm._baseCard || perm.card);
        const test = cond && parseCondition(cond);
        if (test && test(this, { controllerId: perm.controllerId, sourcePerm: perm, card: perm.card })) {
          perm.solved = true;
          this.log(`${perm.card.name} is solved.`);
          this.refreshCardState(perm);
        }
      }
      this.exileUnearthedPermanents();
      this.endStepAltCostCleanup();
      this.triggerPhase(interpretEndStepTriggers);
      this.openPriorityWindow();
      return;
    }
    if (step === 'cleanup') {
      this.doCleanup();
      return;
    }
    if (step === 'main2') this.triggerPhase(interpretSecondMainTriggers);
    if (step === 'main1') {
      this.advanceSagas();
      this.offerParadigmCopies(this.active);
      this.openPriorityWindow();
      return;
    }
    if (step === 'beginCombat') {
      this.triggerPhase(interpretBeginCombatTriggers);
      this.openPriorityWindow();
      return;
    }
    if (step === 'endCombat') {
      this.sacrificeDecayedAttackers();
      this.exileEndOfCombatTokens();
      this.checkStateBasedActions();
    }
    // endCombat, main2: just open priority
    this.openPriorityWindow();
  }

  // Puts a lore counter on a Saga and fires whichever chapter(s) match the
  // new total, then sacrifices it once its lore count reaches its final
  // chapter (real Sagas' "Sacrifice after [last numeral]" rule). Called once
  // when a Saga enters (its first counter/chapter I) and again at the
  // beginning of each of its controller's subsequent precombat main phases
  // (real templating says "after your draw step" — main1's step-entry is
  // the same moment in this engine's turn structure, one step later).
  advanceSaga(perm) {
    const chapters = interpretSagaChapters(perm.card);
    if (chapters.length === 0) return;
    perm.counters.lore = (perm.counters.lore || 0) + 1;
    const lore = perm.counters.lore;
    const matching = chapters.filter(c => c.numbers.includes(lore));
    for (const chapter of matching) {
      this.log(`${perm.card.name}'s chapter ${lore} triggers.`);
      this.resolveEffectSteps(chapter.steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
    }
    this.checkStateBasedActions();
    if (this.findPermanent(perm.id) !== perm) return; // already left the battlefield mid-chapter
    const maxChapter = Math.max(...chapters.flatMap(c => c.numbers));
    if (lore >= maxChapter) {
      this.log(`${perm.card.name} is sacrificed after its final chapter.`);
      this.movePermanentToGraveyard(perm, { sacrifice: true });
    }
  }

  advanceSagas() {
    // Snapshot the battlefield first — advanceSaga can sacrifice a Saga
    // (mutating this.active.battlefield) partway through the loop.
    for (const perm of [...this.active.battlefield]) {
      if (isSaga(perm.card) && (perm.counters.lore || 0) > 0) this.advanceSaga(perm);
    }
  }

  // ---------- "Enchant player" Auras (the Curse cycle) ----------

  // "At the beginning of enchanted player's upkeep, EFFECT" — scans EVERY
  // player's battlefield (a Curse is almost always controlled by someone
  // OTHER than the player it's attached to) for one attached to whoever's
  // upkeep this is. No real choose-target UI for the rare "that player or
  // a planeswalker they control" compound target some of these use (see
  // the effects.js clause comment) — the enchanted player themselves is
  // always the safe default target for any plain player-shaped kind.
  triggerEnchantedPlayerUpkeep() {
    for (const pl of this.players) {
      for (const perm of pl.battlefield) {
        if (perm.attachedToPlayerId !== this.active.id) continue;
        const steps = interpretEnchantedPlayerUpkeepTriggers(perm.card);
        if (steps.length === 0) continue;
        const kinds = expandTargetKinds(steps);
        const targets = kinds.map(k => (k === 'player' || k === 'creatureOrPlayer') ? { type: 'player', id: perm.attachedToPlayerId } : this.autoPickTarget(k, perm.controllerId)).filter(Boolean);
        this.resolveEffectSteps(steps, targets, { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
      }
    }
    this.checkStateBasedActions();
  }

  // "Whenever enchanted player is attacked, EFFECT" — fires once per
  // combat (mirroring triggerWhenYouAttack's own "once, not per attacker"
  // shape) whenever the just-declared attack targets the player a Curse is
  // attached to, scanning every player's battlefield the same way as
  // triggerEnchantedPlayerUpkeep above. Dispatched from declareAttackers,
  // once per combat, after attackers are declared.
  triggerEnchantedPlayerAttacked(defendingPlayerId) {
    for (const pl of this.players) {
      for (const perm of pl.battlefield) {
        if (perm.attachedToPlayerId !== defendingPlayerId) continue;
        const steps = interpretEnchantedPlayerAttackedTriggers(perm.card);
        if (steps.length === 0) continue;
        this.resolveEffectSteps(steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
      }
    }
    this.checkStateBasedActions();
  }

  // ---------- Class enchantments (Alchemist's Talent, Ranger Class, ...) ----------

  // Rewrites perm.card's own oracleText to the concatenation of every
  // active level's (1 through perm.classLevel) standing text — always
  // re-derived from perm.classOriginalOracleText (the untouched printed
  // text), never from whatever perm.card.oracleText currently holds, since
  // that's the OUTPUT of this same function from the last time it ran.
  // Every other trigger/static-effect dispatch point in this engine just
  // reads card.oracleText, so this one rewrite is all that's needed for a
  // Class's higher-level abilities to "just work" everywhere else.
  recomputeClassEffectiveOracleText(perm) {
    const levels = parseClassLevels({ typeLine: perm.card.typeLine, oracleText: perm.classOriginalOracleText });
    const activeText = levels.filter(l => l.level <= perm.classLevel).map(l => l.standingText).filter(Boolean).join('\n');
    perm.card = { ...perm.card, oracleText: activeText };
  }

  // UI convenience: the parsed level list for a Class permanent, re-derived
  // fresh from its untouched original text each time (see
  // recomputeClassEffectiveOracleText for why perm.card.oracleText itself
  // can't be used for this).
  getClassLevels(perm) {
    if (!perm.classOriginalOracleText) return [];
    return parseClassLevels({ typeLine: perm.card.typeLine, oracleText: perm.classOriginalOracleText });
  }

  canLevelUpClass(playerId, permId) {
    if (this.gameOver || this.pendingRequest) return false;
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || !perm.classOriginalOracleText) return false;
    if (this.priorityPlayer.id !== playerId) return false;
    // Sorcery speed only, same as any other "Level N" cost in real rules.
    if (!(playerId === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    const levels = parseClassLevels({ typeLine: perm.card.typeLine, oracleText: perm.classOriginalOracleText });
    const nextLevel = levels.find(l => l.level === perm.classLevel + 1);
    if (!nextLevel) return false;
    const p = this.getPlayer(playerId);
    const parsed = parseManaCost(nextLevel.cost);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
  }

  levelUpClass(playerId, permId) {
    if (!this.canLevelUpClass(playerId, permId)) return { ok: false, reason: 'Cannot level up right now.' };
    const perm = this.findPermanent(permId);
    const p = this.getPlayer(playerId);
    const levels = parseClassLevels({ typeLine: perm.card.typeLine, oracleText: perm.classOriginalOracleText });
    const nextLevel = levels.find(l => l.level === perm.classLevel + 1);
    const parsed = parseManaCost(nextLevel.cost);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    perm.classLevel = nextLevel.level;
    this.recomputeClassEffectiveOracleText(perm);
    this.log(`${p.name} levels up ${perm.card.name} to level ${perm.classLevel}.`);
    // "When this Class becomes level N, EFFECT" (Wizard Class's own level-2
    // draw) — a one-time trigger fired exactly now, pre-interpreted by
    // parseClassLevels rather than left in the standing text this permanent
    // will carry going forward.
    if (nextLevel.becomesLevelSteps.length > 0) {
      this.resolveEffectSteps(nextLevel.becomesLevelSteps, [], { controllerId: playerId, card: perm.card, sourcePerm: perm });
    }
    this.checkStateBasedActions();
    this.afterAction(playerId);
    return { ok: true };
  }

  // Fires "at the beginning of your upkeep/end step" triggers for every
  // permanent the active player controls (only their own step — see
  // interpretPhaseTriggers in effects.js for the "each upkeep" simplification).
  triggerPhase(interpretFn) {
    for (const perm of [...this.active.battlefield]) {
      if (!this.findPermanent(perm.id)) continue;
      const steps = interpretFn(perm.card);
      if (steps.length === 0) continue;
      this.resolveEffectSteps(steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
    }
    this.checkStateBasedActions();
  }

  openPriorityWindow() {
    if (this.gameOver) return;
    this.consecutivePasses = 0;
    this.priorityPlayerIndex = this.activePlayerIndex;
    this.checkStateBasedActions();
    if (this.gameOver) return;
    this.maybeLetAIAct();
    this.emit();
  }

  // Called any time the human takes an action or the AI acts, to reset the
  // "everyone passed" counter and hand priority appropriately.
  afterAction(actorId) {
    this.consecutivePasses = 0;
    this._actionsSinceLastPass += 1;
    const actorIndex = this.players.findIndex(p => p.id === actorId);
    this.priorityPlayerIndex = actorIndex; // actor keeps priority to act again or pass
    this.checkStateBasedActions();
    if (this.gameOver) return;
    this.maybeLetAIAct();
    this.emit();
  }

  pass(playerId) {
    if (this.gameOver) return;
    if (this.pendingRequest) return; // a declare-attackers/blockers decision is required first
    if (this.priorityPlayer.id !== playerId) return;
    this.consecutivePasses += 1;
    this._actionsSinceLastPass = 0;
    this.log(`${this.priorityPlayer.name} passes priority.`);

    if (this.consecutivePasses >= 2) {
      if (this.stack.length > 0) {
        this.resolveTop();
      } else {
        this.advanceStep();
        return;
      }
      this.consecutivePasses = 0;
      this.priorityPlayerIndex = this.activePlayerIndex;
    } else {
      this.priorityPlayerIndex = 1 - this.priorityPlayerIndex;
    }
    this.checkStateBasedActions();
    if (this.gameOver) return;
    this.maybeLetAIAct();
    this.emit();
  }

  // Runs fn() after aiThinkDelayMs — immediately (next microtask) when it's
  // 0, so a headless bot-vs-bot game still resolves as fast as possible;
  // with a real delay set (browser watch mode), each AI decision becomes
  // visible on screen before the next one fires.
  afterAIThinkDelay(fn) {
    if (this.aiThinkDelayMs > 0) setTimeout(fn, this.aiThinkDelayMs);
    else fn();
  }

  // Real turns — even greedy ones casting a hand full of spells, equipping,
  // activating several abilities — stay well under this. Anything beyond it
  // means some ability is being treated as free/repeatable when it isn't
  // (see the comment on _actionsSinceLastPass), so it's safer to force a
  // pass and let the game continue than to hang forever finding "one more
  // action" every time.
  static AI_ACTION_SAFETY_CAP = 60;

  maybeLetAIAct() {
    if (this.gameOver || this.pendingRequest) return;
    const p = this.priorityPlayer;
    if (!p.isAI) return;
    if (this._actionsSinceLastPass > Game.AI_ACTION_SAFETY_CAP) {
      this.log(`${p.name}'s turn hit the action safety cap — passing priority instead of continuing (this usually means an ability is wrongly being treated as free; worth checking the log above).`);
      this.pass(p.id);
      return;
    }
    // Imported lazily to avoid a circular import at module-eval time.
    import('./ai.js').then(({ takeAITurnAction }) => {
      if (this.gameOver) return;
      this.afterAIThinkDelay(() => { if (!this.gameOver) takeAITurnAction(this); });
    });
  }

  // ---------- land & spell casting ----------

  canPlayLand(playerId) {
    if (this.pendingRequest) return false;
    const p = this.getPlayer(playerId);
    return p.id === this.active.id && !p.landPlayedThisTurn &&
      (this.step === 'main1' || this.step === 'main2') &&
      this.stack.length === 0 && this.priorityPlayer.id === playerId;
  }

  // Whether a about-to-be-played land should enter tapped, for every
  // "conditional untapped" land cycle beyond a plain always/never split —
  // check lands (Woodland Cemetery: "...unless you control a Swamp or a
  // Forest"), fast lands (Inspiring Vantage/Blooming Marsh: "...unless you
  // control two or fewer other lands"), battle/tango lands (Prairie
  // Stream/Smoldering Marsh: "...unless you control two or more basic
  // lands"), and reveal lands (Choked Estuary/Foreboding Ruins: "you may
  // reveal an Island or Swamp card from your hand"). Returns null if the
  // text doesn't match any of these — including the shock-land cycle
  // (Sacred Foundry, ...), which is deliberately NOT handled here: that one
  // has a real side effect (paying life), so it goes through the normal
  // ETB-effect dispatch instead (applyPayLifeOrEntersTappedEffect); every
  // cycle here is a pure board-state/hand check with no side effect worth a
  // whole effect step, decided right here instead where the land actually
  // enters. The reveal cycle's "may reveal" has no real decline-anyway UI,
  // same simplification used everywhere else in this engine: always
  // reveals if a qualifying card exists.
  computeLandEntersTapped(card, controller) {
    const text = (card.oracleText || '').toLowerCase();
    let m;
    if ((m = text.match(/this land enters tapped unless you control an? ([a-z]+) or an? ([a-z]+)\./))) {
      const [, type1, type2] = m;
      return !controller.battlefield.some(perm => {
        const tl = (perm.card.typeLine || '').toLowerCase();
        return tl.includes(type1) || tl.includes(type2);
      });
    }
    if (/this land enters tapped unless you control two or fewer other lands\./.test(text)) {
      return controller.battlefield.filter(perm => isLand(perm.card)).length > 2;
    }
    if (/this land enters tapped unless you control two or more basic lands\./.test(text)) {
      return controller.battlefield.filter(perm => /\bbasic\b/.test((perm.card.typeLine || '').toLowerCase())).length < 2;
    }
    if ((m = text.match(/as this land enters, you may reveal an? ([a-z]+) or ([a-z]+) card from your hand\.\s*if you don'?t,?\s*this land enters tapped\./))) {
      const [, type1, type2] = m;
      const hasQualifyingCard = controller.hand.some(c => {
        const tl = (c.typeLine || '').toLowerCase();
        return tl.includes(type1) || tl.includes(type2);
      });
      return !hasQualifyingCard;
    }
    return null;
  }

  playLand(playerId, instanceId) {
    if (!this.canPlayLand(playerId)) return false;
    this.resetTriggerChain();
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    if (idx === -1 || !isLand(p.hand[idx])) return false;
    const [card] = p.hand.splice(idx, 1);
    const perm = makePermanent(card, playerId);
    perm.summoningSick = false;
    // Matches both older ("enters the battlefield tapped") and current
    // ("enters tapped") templating. computeLandEntersTapped's own cycles
    // (checked first) and the shock-land cycle's conditional wording
    // ("...if you don't, it enters tapped") are excluded from this plain
    // substring check — every one of them DOES contain the literal words
    // "enters tapped" somewhere in its own conditional sentence, which
    // would otherwise false-positive here as an unconditional tapped land
    // regardless of the real condition.
    const oracleLower = (card.oracleText || '').toLowerCase();
    const conditionalTapped = this.computeLandEntersTapped(card, p);
    const hasConditionalEntersTapped = /you may pay \d+ life\.\s*if you don'?t,?\s*it enters tapped/.test(oracleLower);
    if (conditionalTapped !== null) {
      perm.tapped = conditionalTapped;
    } else if (!hasConditionalEntersTapped && /enters(?: the battlefield)? tapped/.test(oracleLower)) {
      perm.tapped = true;
    }
    p.battlefield.push(perm);
    p.landPlayedThisTurn = true;
    this.log(`${p.name} plays ${card.name}${perm.tapped ? ' tapped' : ''}.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
    this.triggerLandfall(perm);
    this.afterAction(playerId);
    return true;
  }

  canCastSpell(playerId, card) {
    if (this.pendingRequest) return false;
    const p = this.getPlayer(playerId);
    if (this.priorityPlayer.id !== playerId) return false;
    // Split second on the stack; Epic's "for the rest of the game, you
    // can't cast spells".
    if (this.splitSecondActive() || p.cantCastSpells) return false;
    if (isLand(card)) return false;
    const instantSpeed = isInstant(card) || /flash/.test((card.keywords || []).join(','));
    if (instantSpeed) return true;
    return p.id === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0;
  }

  // modeIndexes matters only for modal spells (getSpellModes) — different
  // modes can need different targets, so this needs to know which mode(s)
  // were picked to report the right target kinds.
  // flags: cast-time choices the text can depend on (gift promised,
  // bargained, kicked — see effects.js's applyCastConditions); Into the
  // Flood Maw's promised gift widens its target from a creature to any
  // nonland permanent.
  getRequiredTargetKinds(card, modeIndexes = null, flags = null) {
    if (flags?.bestow) return ['yourCreature'];
    if (isAura(card)) return [isEnchantPlayerAura(card) ? 'player' : 'permanent'];
    if (!isInstant(card) && !isSorcery(card)) return [];
    return expandTargetKinds(interpretSpell(card, modeIndexes, flags));
  }

  // Companion to getRequiredTargetKinds — see minRequiredTargetCount's own
  // comment for why ai.js's "is this worth attempting" gates need this
  // instead of getRequiredTargetKinds(...).length.
  getMinRequiredTargetCount(card, modeIndexes = null, flags = null) {
    if (isAura(card)) return 1;
    if (!isInstant(card) && !isSorcery(card)) return 0;
    return minRequiredTargetCount(interpretSpell(card, modeIndexes, flags));
  }

  // Exposes expandTargetKinds/minRequiredTargetCount to ai.js, which only
  // ever gets a raw `game` instance (not game.js's own module internals) —
  // used for a modal spell's own per-mode steps, which arrive as a plain
  // steps array (modal.modes[i].steps) rather than through a whole card.
  expandTargetKinds(steps) {
    return expandTargetKinds(steps);
  }

  minRequiredTargetCount(steps) {
    return minRequiredTargetCount(steps);
  }

  getSpellModes(card) {
    return getSpellModesFromText(card);
  }

  // Static, self-referencing cost reductions printed directly on the card
  // being cast (Blasphemous Act's "costs {1} less to cast for each creature
  // on the battlefield" — both players' creatures, no "you control" here;
  // Ghalta, Primal Hunger's "costs {X} less, where X is the total power of
  // creatures you control") — recomputed fresh every time, since the board
  // state it depends on changes as the game plays out. Returns a flat
  // amount of GENERIC mana to subtract from the parsed cost; never reduces
  // colored pips, matching how these effects actually work.
  getCastCostReduction(card, controllerId) {
    // Reminder text stripped: Affinity's own reminder ("This spell costs
    // {1} less to cast for each artifact you control.") used to be what
    // made Affinity work at all, by accident — the explicit Affinity rule
    // below is the real handling now, and would double-count otherwise.
    const text = (card.oracleText || '').toLowerCase().replace(/\([^()]*\)/g, '');
    let selfReduction = 0;
    let m = text.match(/this spell costs \{(\d+)\} less to cast for each ([\w\s]+?)(?: on the battlefield| you control)/);
    if (m) {
      const perEach = parseInt(m[1], 10);
      const typeWord = m[2].trim().replace(/s$/, '');
      const onlyYours = / you control/.test(m[0]);
      let count = 0;
      if (onlyYours) {
        count = this.getPlayer(controllerId).battlefield.filter(p => hasTypeWord(p.card, typeWord)).length;
      } else {
        for (const pl of this.players) count += pl.battlefield.filter(p => hasTypeWord(p.card, typeWord)).length;
      }
      selfReduction = perEach * count;
    } else {
      m = text.match(/this spell costs \{x\} less to cast,? where x is the total power of creatures you control/);
      if (m) {
        const controller = this.getPlayer(controllerId);
        selfReduction = controller.battlefield.filter(p => isCreature(p.card)).reduce((sum, p) => sum + this.effectivePower(p), 0);
      }
    }
    const plain = text.replace(/\([^()]*\)/g, '');
    // Domain: "costs {2} less to cast for each basic land type among lands
    // you control"; and any other "for each" count parseForEach knows.
    if (!selfReduction) {
      const fe = plain.match(/this spell costs \{(\d+)\} less to cast for each ([^.]+)/);
      const count = fe && parseForEach(fe[2]);
      if (count) selfReduction = parseInt(fe[1], 10) * count(this, { controllerId, card });
    }
    // Delirium / Threshold style: "costs {2} less to cast as long as COND" / "if COND".
    const condRed = plain.match(/this spell costs \{(\d+)\} less to cast (?:as long as|if) ([^.]+)/);
    if (condRed && parseCondition(condRed[2]) && parseCondition(condRed[2])(this, { controllerId, card })) selfReduction += parseInt(condRed[1], 10);
    // Affinity for [type]: {1} less for each [type] you control (Frogmite,
    // Thoughtcast — "affinity for artifacts").
    const affinity = plain.match(/^affinity for ([a-z ]+?)\s*$/m);
    if (affinity) {
      const typeWord = affinity[1].trim().replace(/s$/, '');
      selfReduction += this.getPlayer(controllerId).battlefield.filter(p => hasTypeWord(p.card, typeWord)).length;
    }
    // Undaunted: {1} less for each opponent — always exactly one here.
    if (/^undaunted\s*$/m.test(plain)) selfReduction += 1;
    return selfReduction + this.getOtherSourceCostReduction(card, controllerId);
  }

  // "Other Dragon spells you cast cost {1} less to cast." (The Ur-Dragon's
  // own Eminence ability, and similar tribal cost-reduction lords) — a
  // reduction granted by ANOTHER permanent (or an Eminence-flagged
  // commander sitting in the command zone), as opposed to the
  // self-referencing reductions above (a spell reducing its own cost).
  // Strips the "As long as [Name] is in the command zone or on the
  // battlefield, " clause that wraps the real Eminence wording, and the
  // optional "Eminence — " ability-word prefix itself.
  getOtherSourceCostReduction(card, controllerId) {
    const controller = this.getPlayer(controllerId);
    const typeLine = (card.typeLine || '').toLowerCase();
    const re = /(?:eminence\s*—\s*)?(?:as long as [\w\s,'-]+? is in the command zone or on the battlefield,\s*)?other ([\w\s]+?) spells you cast cost \{(\d+)\} less to cast/g;
    let total = 0;
    const scan = (text) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const typeWord = m[1].trim().replace(/s$/, '');
        if (typeLine.includes(typeWord)) total += parseInt(m[2], 10);
      }
    };
    for (const perm of controller.battlefield) {
      scan((perm.card.oracleText || '').toLowerCase());
      // "Creature spells you cast of the chosen type cost {N} less to
      // cast" (Herald's Horn) — a different template from the "other
      // [Type] spells..." one above: no "other" prefix (so it discounts
      // recasting itself too, matching the real card), and "the chosen
      // type" resolves to THIS permanent's own chosenType (see
      // applyChooseCreatureTypeEffect) rather than a literal type name.
      if (perm.chosenType && typeLine.includes('creature')) {
        const text = (perm.card.oracleText || '').toLowerCase();
        const chosenMatch = text.match(/creature spells you cast of the chosen type cost \{(\d+)\} less to cast/);
        if (chosenMatch && typeLine.includes(perm.chosenType.toLowerCase())) total += parseInt(chosenMatch[1], 10);
      }
    }
    // "Other" Dragon spells never includes the commander's own cast — skip
    // the command-zone Eminence check when the card being cast IS that
    // commander (recasting itself from the zone doesn't discount itself).
    for (const entry of this.commanderMode ? controller.commanders || [] : []) {
      if (!entry.inZone || entry.card === card) continue;
      const text = (entry.card.oracleText || '').toLowerCase();
      if (/eminence/.test(text)) scan(text);
    }
    return total;
  }

  // Plans paying a spell's (already cost-reduced) parsed cost: untapped
  // lands and floating mana first, then — only for whatever they can't
  // cover — the spell's own alternative payment keywords: Delve (exile
  // graveyard cards, {1} each), Improvise (tap untapped artifacts, {1}
  // each), Convoke (tap untapped creatures, {1} each or one mana of that
  // creature's color). Tried in that order, cheapest-to-give-up first, and
  // only as many as needed — tapping a creature costs you an attacker or
  // blocker, so it's the last resort. Returns { lands, poolUsed, tapForCost,
  // exileFromGraveyard } or null.
  planSpellPayment(playerId, card, parsed, xValue = 0) {
    const p = this.getPlayer(playerId);
    // A card with no mana cost at all (Ancestral Vision, Living End, Lotus
    // Bloom) can't be cast normally — only through an alternative cost like
    // Suspend. Before this it was castable for free.
    if (!card.manaCost && !isLand(card)) return null;
    const lands = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    const base = planManaPayment(lands, parsed, xValue, p.manaPool);
    if (base) return { ...base, tapForCost: [], exileFromGraveyard: [], lifePaid: 0, phyrexianPaidWithLife: 0 };
    // Phyrexian mana ({U/P}, {G/W/P}): each symbol may be paid with 2 life
    // instead. Mana is preferred; life covers only the symbols mana can't,
    // and never so much that paying would put the player at 0 or less.
    const phyrexianIdx = parsed.hybrid.map((h, i) => (h.includes('P') ? i : -1)).filter(i => i >= 0);
    for (let k = 1; k <= phyrexianIdx.length && 2 * k < p.life; k++) {
      const drop = new Set(phyrexianIdx.slice(0, k));
      const plan = planManaPayment(lands, { ...parsed, hybrid: parsed.hybrid.filter((_, i) => !drop.has(i)) }, xValue, p.manaPool);
      if (plan) return { ...plan, tapForCost: [], exileFromGraveyard: [], lifePaid: 2 * k, phyrexianPaidWithLife: k };
    }
    const kws = card.keywords || [];
    const delve = kws.includes('delve'), improvise = kws.includes('improvise'), convoke = kws.includes('convoke');
    if (!delve && !improvise && !convoke) return null;
    const helpers = [];
    if (delve) for (const c of p.graveyard) helpers.push({ kind: 'exile', card: c, colors: [] });
    // Improvise taps ANY untapped artifact, artifact creatures included —
    // non-creature ones first, since tapping a creature costs a body.
    if (improvise) {
      const artifacts = p.battlefield.filter(perm => !perm.tapped && isArtifact(perm.card) && !isLand(perm.card))
        .sort((a, b) => (isCreature(a.card) ? 1 : 0) - (isCreature(b.card) ? 1 : 0));
      for (const perm of artifacts) helpers.push({ kind: 'tap', perm, colors: [] });
    }
    if (convoke) {
      const creatures = p.battlefield.filter(perm => !perm.tapped && isCreature(perm.card) && !helpers.some(h => h.perm === perm)).sort((a, b) => this.effectivePower(a) - this.effectivePower(b));
      for (const perm of creatures) helpers.push({ kind: 'tap', perm, colors: convoke ? (perm.card.colors || []) : [] });
    }
    if (helpers.length === 0) return null;
    // X folded into generic so helpers can pay for it too.
    const totalGeneric = parsed.generic + xValue * (parsed.x || 0);
    const colors = { ...parsed.colors };
    const used = [];
    const attempt = () => {
      for (let k = 0; k <= Math.min(totalGeneric, helpers.length - used.length); k++) {
        const remaining = helpers.filter(h => !used.includes(h)).slice(0, k);
        const plan = planManaPayment(lands, { ...parsed, generic: totalGeneric - k, x: 0, colors }, 0, p.manaPool);
        if (plan) return { ...plan, chosen: [...used, ...remaining] };
      }
      return null;
    };
    let result = attempt();
    // Still short: convoke creatures can also pay a colored pip of their
    // own color — cover colored pips one at a time and retry.
    if (!result && convoke) {
      for (const color of Object.keys(colors)) {
        while (!result && colors[color] > 0) {
          const h = helpers.find(x => !used.includes(x) && x.colors.includes(color));
          if (!h) break;
          used.push(h);
          colors[color] -= 1;
          result = attempt();
        }
        if (result) break;
      }
    }
    if (!result) return null;
    return {
      lands: result.lands, poolUsed: result.poolUsed,
      tapForCost: result.chosen.filter(h => h.kind === 'tap').map(h => h.perm),
      exileFromGraveyard: result.chosen.filter(h => h.kind === 'exile').map(h => h.card),
      lifePaid: 0, phyrexianPaidWithLife: 0,
    };
  }

  // Carries out a plan from planSpellPayment.
  applySpellPayment(playerId, card, plan) {
    const p = this.getPlayer(playerId);
    if (plan.lifePaid) {
      p.life -= plan.lifePaid;
      this.log(`${p.name} pays ${plan.lifePaid} life for ${card.name}'s Phyrexian mana.`);
    }
    for (const land of plan.lands) land.tapped = true;
    for (const color of Object.keys(plan.poolUsed)) p.manaPool[color] -= plan.poolUsed[color];
    for (const perm of plan.tapForCost) perm.tapped = true;
    if (plan.tapForCost.length) this.log(`${p.name} taps ${plan.tapForCost.map(x => x.card.name).join(', ')} to help pay for ${card.name}.`);
    for (const c of plan.exileFromGraveyard) {
      p.graveyard = p.graveyard.filter(x => x !== c);
      p.exile.push(c);
    }
    if (plan.exileFromGraveyard.length) this.log(`${p.name} exiles ${plan.exileFromGraveyard.length} card${plan.exileFromGraveyard.length > 1 ? 's' : ''} from their graveyard to delve for ${card.name}.`);
  }

  affordability(playerId, card) {
    const parsed = parseManaCost(card.manaCost);
    if (parsed.x > 0) return true; // let UI/AI decide X=0 minimum, always "affordable" at X=0
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    return !!this.planSpellPayment(playerId, card, parsed, 0);
  }

  // Whether this player could pay the card's base cost PLUS its Kicker cost
  // right now (Territorial Allosaurus, etc.) — used by the AI to decide
  // whether to opt into Kicker (see castSpell's `kicked` param) instead of
  // always casting unkicked. Returns false for a card with no Kicker cost.
  canAffordKicked(playerId, card) {
    const kickerCost = this.getOptionalAdditionalCost(card);
    if (!kickerCost) return false;
    const parsed = parseManaCost(card.manaCost + kickerCost);
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    return !!this.planSpellPayment(playerId, card, parsed, 0);
  }

  // Largest X a player could actually pay for an {X}-cost card's full cost
  // right now (0 if it has no X, or if even X=0 isn't affordable) — used by
  // the AI so it gets real value out of X spells instead of always casting
  // them at a hardcoded X=0 (a real bug: "twice X damage" at X=0 does
  // nothing at all, making X-payoff cards look like they never do anything).
  maxAffordableX(playerId, card) {
    const p = this.getPlayer(playerId);
    const parsed = parseManaCost(card.manaCost);
    if (parsed.x === 0) return 0;
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    const poolTotal = Object.values(p.manaPool).reduce((a, b) => a + b, 0);
    // Delve/Improvise/Convoke helpers can pay toward X too (Stoke the
    // Flames isn't X, but a convoke X spell like Chord of Calling is).
    const kws = card.keywords || [];
    const helperCount = (kws.includes('delve') ? p.graveyard.length : 0)
      + (kws.includes('improvise') || kws.includes('convoke') ? p.battlefield.filter(perm => !perm.tapped && !isLand(perm.card)).length : 0);
    const upperBound = untapped.length + poolTotal + helperCount;
    for (let x = upperBound; x >= 0; x--) {
      if (this.planSpellPayment(playerId, card, parsed, x)) return x;
    }
    return 0;
  }

  affordabilityForCommander(playerId, index = 0) {
    const p = this.getPlayer(playerId);
    const entry = p.commanders?.[index];
    if (!entry) return false;
    const parsed = parseManaCost(entry.card.manaCost);
    parsed.generic += 2 * entry.castCount;
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(entry.card, playerId));
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
  }

  // targets: array aligned with getRequiredTargetKinds(card, modeIndexes),
  // each entry either {type:'permanent', id} or {type:'player', id}.
  // modeIndexes: for a modal spell (getSpellModes), which mode(s) were
  // chosen — must be decided before targets are collected, since different
  // modes can need different targets; ignored for non-modal cards.
  // kicked: whether the caster is paying the card's optional Kicker cost
  // (see getKickerCost) — folded into the mana payment below, and recorded
  // on the resulting permanent as `wasKicked` (see resolveTop) for its own
  // "if it was kicked, ..." ETB trigger to read back.
  castSpell(playerId, instanceId, targets = [], xValue = 0, modeIndexes = null, kicked = false, { free = false, bypassTiming = false, ownerId = null, costOverride = null, viaSuspend = false, altCost = null, extras = {}, fromZone = 'hand' } = {}) {
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    if (idx === -1) return { ok: false, reason: 'Card not in hand.' };
    const card = p.hand[idx];
    if (!bypassTiming) this.resetTriggerChain();
    // `bypassTiming` (Etali, Primal Storm's own "cast ... from among those
    // cards" attack trigger — mid-combat, nowhere near a normal sorcery-
    // speed window) skips canCastSpell's own priority/step/stack checks
    // entirely: a resolving effect that explicitly grants permission to
    // cast a card is its own timing permission (real rule 601.3b), not
    // bound by the caster's own normal casting windows.
    // Sneak's own window (declare blockers) is its timing permission.
    if ((altCost?.kind === 'sneak' || altCost?.kind === 'offering') && this.priorityPlayer.id === playerId && !this.pendingRequest) bypassTiming = true;
    if (!bypassTiming && !this.canCastSpell(playerId, card)) return { ok: false, reason: 'Cannot cast that right now.' };
    if (p.cantCastSpells) return { ok: false, reason: "You can't cast spells for the rest of the game (epic)." };

    // `free` (Diluvian Primordial's own "cast ... without paying its mana
    // cost") skips ALL cost logic below entirely — no mana, no Kicker, no
    // life payment. Real cards that grant a free cast never also involve
    // those, so this is a clean either/or rather than something needing to
    // combine with them.
    let kickerCost = null;
    let phyrexianPaidWithLife = 0;
    let sunburstColors = 0;
    let sneakTarget = null;
    let manaSpent = 0;
    let castColors = {};
    // Optional cast-time costs (Replicate, Squad, Offspring, Conspire,
    // Casualty, Bargain, Gift, Escalate/Spree modes) — validated before
    // anything is paid; see resolveCastExtras.
    const ex = this.resolveCastExtras(playerId, card, modeIndexes, { ...extras, targetCount: targets.filter(Boolean).length }, { free });
    if (ex.error) return { ok: false, reason: ex.error };
    if (!free) {
      // "As an additional cost to cast this spell, pay X life" (Toxic
      // Deluge) — X here is a pure life cost, unrelated to the spell's own
      // mana cost (which may have no {X} in it at all — Toxic Deluge's is a
      // fixed {2}{B}), so it must NOT be folded into planManaPayment's own
      // xValue (that would wrongly demand X extra GENERIC MANA on top of
      // the real cost).
      const lifePaymentX = hasLifePaymentXCost(card);
      if (lifePaymentX && xValue >= p.life) return { ok: false, reason: 'Not enough life to pay.' };

      kickerCost = kicked ? this.getOptionalAdditionalCost(card) : null;
      // Concatenating the two cost STRINGS before parsing (rather than
      // parsing each separately and adding the results) reuses
      // parseManaCost's own symbol-scanning as-is — it just sees more
      // {...} tokens, in any order.
      // costOverride: an alternative cost replacing the mana cost (Miracle).
      // altCost: Dash/Blitz/Evoke/Emerge/Spectacle/Prowl/Surge/Freerunning/
      // Prototype — must be one getCastOptions currently offers.
      let altInfo = null, emergeVictim = null;
      if (altCost) {
        altInfo = this.getCastOptions(playerId, card).find(o => o.kind === altCost.kind && ((o.kind !== 'emerge' && o.kind !== 'offering') || o.emergeVictimId === altCost.emergeVictimId) && (o.kind !== 'mutate' || o.mutateTargetId === altCost.mutateTargetId));
        if (!altInfo) return { ok: false, reason: `Can't cast ${card.name} that way right now.` };
        if (altInfo.emergeVictimId) emergeVictim = this.findPermanent(altInfo.emergeVictimId);
      }
      const parsed = parseManaCost((altInfo ? altInfo.manaCost : (costOverride ?? card.manaCost)) + (kickerCost || '') + ex.manaCost);
      parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId) - (emergeVictim && altInfo?.kind === 'emerge' ? (emergeVictim.card.cmc || 0) : 0));
      const payment = this.planSpellPayment(playerId, card, parsed, lifePaymentX ? 0 : xValue);
      if (!payment) return { ok: false, reason: 'Not enough mana.' };
      this.applySpellPayment(playerId, card, payment);
      phyrexianPaidWithLife = payment.phyrexianPaidWithLife;
      if (/^sunburst\b/im.test((card.oracleText || '').replace(/\([^()]*\)/g, ''))) sunburstColors = this.colorsSpent(payment, parsed);
      castColors = this.colorCountsSpent(payment, parsed);
      if (emergeVictim) {
        this.log(`${p.name} sacrifices ${emergeVictim.card.name} to ${altInfo.kind === 'offering' ? 'offer' : 'emerge'} ${card.name}.`);
        this.movePermanentToGraveyard(emergeVictim, { sacrifice: true });
      }
      if (altInfo?.returnId) {
        const back = this.findPermanent(altInfo.returnId);
        if (back) {
          sneakTarget = back.attackTarget || null;
          this.log(`${p.name} returns ${back.card.name} to hand (${altInfo.kind}).`);
          this.returnPermanentToHand(back);
        }
      }
      manaSpent = totalCmc(parsed) + (lifePaymentX ? 0 : xValue * (parsed.x || 0));
      if (lifePaymentX && xValue > 0) {
        p.life -= xValue;
        this.log(`${p.name} pays ${xValue} life as an additional cost to cast ${card.name}.`);
      }
    }
    p.hand.splice(idx, 1);
    this.payCastExtras(playerId, card, ex);

    const stackItem = {
      id: uid('stk'),
      card,
      controllerId: playerId,
      // The card's real OWNER, when different from whoever's casting it
      // (Etali, Primal Storm's own "cast ... from among those cards"
      // attack trigger can cast an OPPONENT's exiled card) — defaults to
      // the caster, the overwhelmingly common case where they're the
      // same. Used by resolveTop to send an instant/sorcery to its real
      // owner's graveyard once it resolves, instead of the caster's own
      // (a latent bug before this existed, harmless until casting
      // someone else's card became possible at all).
      ownerId: ownerId || playerId,
      targets,
      xValue,
      modeIndexes,
      kicked: !!kickerCost && !!getKickerCost(card),
      phyrexianPaidWithLife,
      viaSuspend,
      altCostKind: altCost?.kind || null,
      mutateTargetId: altCost?.kind === 'mutate' ? altCost.mutateTargetId : null,
      buyback: !!kickerCost && !getKickerCost(card) && !!getBuybackCost(card),
      entwined: !!kickerCost && !getKickerCost(card) && !getBuybackCost(card) && !!getEntwineCost(card),
      isPermanentSpell: isPermanentType(card) && !isAura(card) && altCost?.kind !== 'bestow',
      isAura: isAura(card) || altCost?.kind === 'bestow',
      bestowed: altCost?.kind === 'bestow',
      bargained: ex.bargained,
      gift: ex.gift,
      // Where it was cast from — Rebound only applies to a spell cast from hand.
      fromZone,
      squadCount: ex.squad,
      offspring: ex.offspring,
      sunburstColors,
      sneakTarget,
      teamwork: ex.teamwork,
      // Adamant / Addendum / Converge read these back.
      castInfo: { colors: castColors, mainPhase: this.active.id === playerId && (this.step === 'main1' || this.step === 'main2') },
    };
    if (altCost?.kind === 'warp') this.spellWarpedThisTurn = true;
    // Teamwork's "choose both instead" (HULK SMASH!).
    if (ex.teamwork) {
      const modalT = getSpellModesFromText(card);
      if (modalT?.teamworkBoth) stackItem.modeIndexes = modalT.modes.map((_, i) => i);
    }
    // Entwine paid: every mode, regardless of which were picked.
    if (stackItem.entwined) {
      const modal = getSpellModesFromText(card);
      if (modal) stackItem.modeIndexes = modal.modes.map((_, i) => i);
    }
    this.stack.push(stackItem);
    p.spellsCastThisTurn = (p.spellsCastThisTurn || 0) + 1;
    const extraNotes = [ex.bargained && 'bargained', ex.gift && 'gift promised', ex.squad && `squad x${ex.squad}`, ex.offspring && 'offspring', ex.replicate && `replicated x${ex.replicate}`].filter(Boolean);
    this.log(`${p.name} casts ${card.name}${stackItem.altCostKind ? ` (${stackItem.altCostKind})` : ''}${stackItem.kicked ? ' (kicked)' : ''}${stackItem.buyback ? ' (with buyback)' : ''}${stackItem.entwined ? ' (entwined)' : ''}${extraNotes.length ? ` (${extraNotes.join(', ')})` : ''}${free ? ' without paying its mana cost' : ''}.`);
    this.triggerCastSpell(playerId, card);
    this.triggerBecomesTarget(targets, playerId);
    this.maybeCounterForWard(stackItem);
    this.applyCastKeywordTriggers(stackItem, playerId);
    this.triggerIncrement(playerId, manaSpent);
    if (/\barcane\b/i.test(card.typeLine || '')) this.offerSplices(playerId, stackItem);
    // Replicate/Conspire/Casualty: "when you cast this spell, copy it" —
    // the copies go on the stack above the original.
    const copies = ex.replicate + (ex.conspire ? 1 : 0) + (ex.casualty ? 1 : 0);
    if (copies && this.stack.includes(stackItem)) {
      const why = [ex.replicate && 'replicate', ex.conspire && 'conspire', ex.casualty && 'casualty'].filter(Boolean).join('/');
      for (let i = 0; i < copies; i++) this.copySpellOnStack(stackItem, playerId, why);
    }
    this.afterAction(playerId);
    return { ok: true };
  }

  // Spells cast this turn by everyone — Storm counts them all.
  totalSpellsThisTurn() { return this.players.reduce((n, pl) => n + (pl.spellsCastThisTurn || 0), 0); }

  // Whether a spell with split second is on the stack: while it is, no one
  // can cast spells or activate non-mana abilities.
  splitSecondActive() { return this.stack.some(item => hasSplitSecond(item.card)); }

  // "When you cast this spell" keywords: Storm (a copy per spell cast
  // before it this turn), Gravestorm (per permanent put into a graveyard
  // this turn), Demonstrate (copy it, and the opponent gets a copy too),
  // Ripple (printed, or granted by Thrumming Stone), and Cascade.
  applyCastKeywordTriggers(item, playerId) {
    const card = item.card;
    const p = this.getPlayer(playerId);
    if (hasStorm(card)) {
      const n = this.totalSpellsThisTurn() - 1;
      if (n > 0) {
        this.log(`Storm: ${card.name} is copied ${n} time${n > 1 ? 's' : ''}.`);
        for (let i = 0; i < n; i++) this.copySpellOnStack(item, playerId, 'storm');
      }
    }
    if (hasGravestorm(card)) {
      const n = this.leftBattlefieldThisTurn.length;
      if (n > 0) {
        this.log(`Gravestorm: ${card.name} is copied ${n} time${n > 1 ? 's' : ''}.`);
        for (let i = 0; i < n; i++) this.copySpellOnStack(item, playerId, 'gravestorm');
      }
    }
    if (hasDemonstrate(card)) {
      // AI: only when the opponent's copy would find no legal target but
      // ours would — otherwise it's handing them the same spell.
      const opp = this.opponentOf(playerId);
      const kinds = this.getRequiredTargetKinds(card, item.modeIndexes);
      const min = this.getMinRequiredTargetCount(card, item.modeIndexes);
      const theirs = pickTargetsForKinds(this, card, opp.id, kinds).filter(Boolean).length;
      const aiYes = min > 0 && theirs < min;
      this.requestChoice(playerId, `${card.name} — Demonstrate? (You copy it, and ${opp.name} copies it too.)`, [
        { label: 'Demonstrate', resolve: () => { this.copySpellOnStack(item, playerId, 'demonstrate'); this.copySpellOnStack(item, opp.id, 'demonstrate'); } },
        { label: "Don't demonstrate", resolve: () => {} },
      ], aiYes ? 0 : 1);
    }
    const granted = Math.max(0, ...p.battlefield.map(perm => parseInt(((perm.card.oracleText || '').match(/spells you cast have ripple (\d+)/i) || [])[1] || '0', 10)));
    const ripple = Math.max(getRippleAmount(card), granted);
    if (ripple > 0 && !item.isCopy) this.applyRipple(p, card, ripple);
    for (let i = 0; i < getCascadeCount(card); i++) this.applyCascade(p, card);
  }

  // Cascade: exile from the top until a nonland card with lesser mana
  // value; it may be cast free; the rest go to the bottom in random order.
  applyCascade(p, card) {
    const exiled = [];
    let hit = null;
    while (p.library.length) {
      const c = p.library.shift();
      exiled.push(c);
      if (!isLand(c) && (c.cmc || 0) < (card.cmc || 0)) { hit = c; break; }
    }
    if (!hit) {
      p.library.push(...shuffle(exiled));
      this.log(`${card.name} cascades but finds nothing (${exiled.length} card${exiled.length === 1 ? '' : 's'} put on the bottom).`);
      return;
    }
    this.log(`${card.name} cascades into ${hit.name}.`);
    const others = exiled.filter(c => c !== hit);
    this.requestChoice(p.id, `Cascade: cast ${hit.name} without paying its mana cost?`, [
      { label: `Cast ${hit.name} for free`, resolve: () => {
        if (!this.castFromOutsideHand(p.id, hit, { free: true, fromZone: 'exile', onFail: () => p.library.push(hit) })) { this.log(`${hit.name} can't be cast right now.`); others.push(hit); }
        p.library.push(...shuffle(others));
      } },
      { label: 'Put it on the bottom', resolve: () => p.library.push(...shuffle(exiled)) },
    ], 0);
  }

  // Ripple N: reveal the top N; cards with the same name may be cast free;
  // the rest go to the bottom.
  applyRipple(p, card, n) {
    const revealed = p.library.splice(0, n);
    if (!revealed.length) return;
    this.log(`Ripple ${n}: ${p.name} reveals ${revealed.map(c => c.name).join(', ')}.`);
    const matches = revealed.filter(c => c.name === card.name);
    p.library.push(...revealed.filter(c => c.name !== card.name));
    for (const c of matches) {
      this.requestChoice(p.id, `Ripple: cast ${c.name} for free?`, [
        { label: `Cast ${c.name} for free`, resolve: () => { if (!this.castFromOutsideHand(p.id, c, { free: true, fromZone: 'other', onFail: () => p.library.push(c) })) p.library.push(c); } },
        { label: 'Put it on the bottom', resolve: () => p.library.push(c) },
      ], 0);
    }
  }

  // Cipher / Epic copies, and Cipher's "cast a copy": a copy of `card`
  // controlled by controllerId, put straight on the stack with auto-picked
  // targets. `cast` copies count as casting a spell (Cipher); Epic's don't.
  putCopyOnStack(card, controllerId, { cast = false, why = 'copy', xValue = 0 } = {}) {
    const kinds = this.getRequiredTargetKinds(card);
    const targets = pickTargetsForKinds(this, card, controllerId, kinds).filter(Boolean);
    if (this.getMinRequiredTargetCount(card) > targets.length) { this.log(`The copy of ${card.name} has no legal target.`); return null; }
    const item = { id: uid('stk'), card, controllerId, ownerId: controllerId, targets, xValue, modeIndexes: null, isCopy: true, fromZone: 'other', isPermanentSpell: isPermanentType(card) && !isAura(card), isAura: false };
    this.stack.push(item);
    this.log(`${this.getPlayer(controllerId).name} ${cast ? 'casts' : 'puts'} a copy of ${card.name} on the stack (${why}).`);
    if (cast) {
      const p = this.getPlayer(controllerId);
      p.spellsCastThisTurn = (p.spellsCastThisTurn || 0) + 1;
      this.triggerCastSpell(controllerId, card);
    }
    this.triggerBecomesTarget(targets, controllerId);
    return item;
  }

  // Epic: at the beginning of each of your upkeeps, copy each epic spell
  // you've resolved (except for its epic ability).
  tickEpic() {
    const p = this.active;
    for (const card of p.epicSpells || []) this.putCopyOnStack(card, p.id, { why: 'epic' });
  }

  // Works out the optional cast-time costs chosen in `extras`, checking
  // they're legal right now. extras: { replicate: n, squad: n, offspring,
  // conspire, casualty, bargain, gift } — conspire/casualty/bargain accept
  // true (pick automatically) or the id(s) of the permanent(s) to use.
  // Escalate's and Spree's costs come from modeIndexes. Returns the added
  // mana cost plus what payCastExtras must do, or { error }.
  resolveCastExtras(playerId, card, modeIndexes, extras = {}, { free = false } = {}) {
    const p = this.getPlayer(playerId);
    const ex = { manaCost: '', discards: [], tapIds: [], sacrificeIds: [], replicate: 0, squad: 0, offspring: false, conspire: false, casualty: false, bargained: false, gift: false, teamwork: false };
    if (!free) ex.manaCost += getModeExtraCost(card, modeIndexes);
    const modal = modeIndexes?.length > 1 ? getSpellModesFromText(card) : null;
    if (modal?.escalate === 'discard') {
      const n = modeIndexes.length - 1;
      const pool = this.discardFodder(p, card).slice(0, n);
      if (pool.length < n) return { error: `Not enough cards to discard for escalate.` };
      ex.discards = pool;
    }
    // Strive: {N} more for each target beyond the first.
    const strive = getStriveCost(card);
    if (strive && !free && (extras.targetCount || 0) > 1) ex.manaCost += strive.repeat(extras.targetCount - 1);
    const replicateCost = getReplicateCost(card);
    if (extras.replicate > 0 && replicateCost) { ex.replicate = Math.floor(extras.replicate); if (!free) ex.manaCost += replicateCost.repeat(ex.replicate); }
    const squadCost = getSquadCost(card);
    if (extras.squad > 0 && squadCost) { ex.squad = Math.floor(extras.squad); if (!free) ex.manaCost += squadCost.repeat(ex.squad); }
    const offspringCost = getOffspringCost(card);
    if (extras.offspring && offspringCost) { ex.offspring = true; if (!free) ex.manaCost += offspringCost; }
    if (extras.conspire && hasConspire(card)) {
      const ids = Array.isArray(extras.conspire) ? extras.conspire : this.conspireCandidates(playerId, card).slice(0, 2).map(x => x.id);
      const legal = new Set(this.conspireCandidates(playerId, card).map(x => x.id));
      if (ids.length !== 2 || !ids.every(id => legal.has(id))) return { error: 'Conspire needs two untapped creatures that share a color with the spell.' };
      ex.conspire = true;
      ex.tapIds.push(...ids);
    }
    if (extras.casualty && getCasualtyAmount(card) != null) {
      const candidates = this.casualtyCandidates(playerId, card);
      const id = typeof extras.casualty === 'string' ? extras.casualty : candidates[0]?.id;
      if (!candidates.some(x => x.id === id)) return { error: `Casualty needs a creature with power ${getCasualtyAmount(card)} or greater to sacrifice.` };
      ex.casualty = true;
      ex.sacrificeIds.push(id);
    }
    if (extras.bargain && hasBargain(card)) {
      const candidates = this.bargainCandidates(playerId).filter(x => !ex.sacrificeIds.includes(x.id));
      const id = typeof extras.bargain === 'string' ? extras.bargain : candidates[0]?.id;
      if (!candidates.some(x => x.id === id)) return { error: 'Bargain needs an artifact, enchantment, or token to sacrifice.' };
      ex.bargained = true;
      ex.sacrificeIds.push(id);
    }
    // Teamwork N: tap creatures you control with total power N or more.
    const teamworkNeed = getTeamworkAmount(card);
    if (extras.teamwork && teamworkNeed) {
      const ids = Array.isArray(extras.teamwork) ? extras.teamwork : this.teamworkCrew(playerId, teamworkNeed).map(x => x.id);
      const crew = ids.map(id => this.findPermanent(id)).filter(x => x && x.controllerId === playerId && isCreature(x.card) && !x.tapped);
      if (crew.reduce((n, x) => n + this.effectivePower(x), 0) < teamworkNeed) return { error: `Teamwork needs untapped creatures with total power ${teamworkNeed}.` };
      ex.teamwork = true;
      ex.tapIds.push(...crew.map(x => x.id));
    }
    if (extras.gift && getGiftKind(card)) {
      if (!this.canGiveGift(card)) return { error: `This engine can't give "${getGiftKind(card)}" as a gift.` };
      ex.gift = true;
    }
    return ex;
  }

  // The non-mana half of resolveCastExtras: discards, taps, sacrifices.
  payCastExtras(playerId, card, ex) {
    const p = this.getPlayer(playerId);
    for (const c of ex.discards) {
      if (!p.hand.includes(c)) continue;
      this.log(`${p.name} discards ${c.name} to escalate ${card.name}.`);
      this.discardCard(p, c);
    }
    for (const id of ex.tapIds) {
      const perm = this.findPermanent(id);
      if (perm) perm.tapped = true;
    }
    if (ex.tapIds.length) this.log(`${p.name} taps ${ex.tapIds.map(id => this.findPermanent(id)?.card.name).join(' and ')} to ${ex.teamwork ? 'team up' : 'conspire'}.`);
    for (const id of ex.sacrificeIds) {
      const perm = this.findPermanent(id);
      if (!perm) continue;
      this.log(`${p.name} sacrifices ${perm.card.name} for ${card.name}'s ${ex.casualty && id === ex.sacrificeIds[0] ? 'casualty' : 'bargain'}.`);
      this.movePermanentToGraveyard(perm, { sacrifice: true });
    }
  }

  // Cards the AI (or an auto-picked escalate cost) is happiest to discard:
  // surplus lands when it already has plenty, then the cheapest spells.
  discardFodder(p, exceptCard = null) {
    const hand = p.hand.filter(c => c !== exceptCard);
    const landsInPlay = p.battlefield.filter(x => isLand(x.card)).length;
    return hand.slice().sort((a, b) => {
      const score = (c) => isLand(c) ? (landsInPlay >= 5 ? -1 : 2) : (c.cmc || 0);
      return score(a) - score(b);
    });
  }

  // Conspire: untapped creatures you control sharing a color with the
  // spell, weakest first.
  conspireCandidates(playerId, card) {
    const colors = new Set(card.colors || []);
    return this.getPlayer(playerId).battlefield
      .filter(x => isCreature(x.card) && !x.tapped && (x.card.colors || []).some(c => colors.has(c)))
      .sort((a, b) => this.effectivePower(a) - this.effectivePower(b));
  }

  // Casualty N: creatures with power N or greater, tokens and weakest first.
  casualtyCandidates(playerId, card) {
    const n = getCasualtyAmount(card) || 0;
    return this.getPlayer(playerId).battlefield
      .filter(x => isCreature(x.card) && this.effectivePower(x) >= n)
      .sort((a, b) => (isTokenCard(b.card) - isTokenCard(a.card)) || (this.effectivePower(a) - this.effectivePower(b)));
  }

  // Bargain: artifacts, enchantments, or tokens — noncreature tokens
  // (Treasure, Food, Clue) first, then creature tokens, then real cards.
  bargainCandidates(playerId) {
    const rank = (x) => isTokenCard(x.card) ? (isCreature(x.card) ? 1 : 0) : 2;
    return this.getPlayer(playerId).battlefield
      .filter(x => isTokenCard(x.card) || isArtifact(x.card) || isEnchantment(x.card))
      .sort((a, b) => rank(a) - rank(b) || (a.card.cmc || 0) - (b.card.cmc || 0));
  }

  // Gifts this engine can hand over (an extra turn isn't modeled).
  canGiveGift(card) {
    return ['card', 'food', 'tapped fish', 'fish', 'treasure', 'clue', 'octopus'].includes(getGiftKind(card));
  }

  // "They create a Food token / draw a card / ..." — the promised gift,
  // given to the opponent before the spell's other effects.
  deliverGift(card, casterId) {
    const kind = getGiftKind(card);
    const opponent = this.opponentOf(casterId);
    const ctx = { controllerId: opponent.id, card };
    this.log(`${opponent.name} gets the gift from ${card.name}.`);
    if (kind === 'card') this.drawCard(opponent);
    else if (kind === 'food') this.applyFoodTokenEffect(ctx, 1);
    else if (kind === 'treasure') this.applyTreasureTokenEffect(ctx, 1);
    else if (kind === 'clue') this.applyClueTokenEffect(ctx, 1);
    else if (kind === 'octopus') this.applyTokenEffect(ctx, 1, 8, 8, 'blue octopus');
    else if (kind === 'tapped fish' || kind === 'fish') {
      this.applyTokenEffect(ctx, 1, 1, 1, 'blue fish');
      if (kind === 'tapped fish') opponent.battlefield[opponent.battlefield.length - 1].tapped = true;
    }
  }

  // Puts a copy of a spell on the stack (Replicate, Conspire, Casualty). A
  // copy keeps the original's choices (modes, X, kicked/bargained/gift) and
  // may get new targets: the AI re-picks, avoiding the original's target
  // where it can; a human is asked when the spell has a single target.
  // Copies aren't cast (no cast triggers) and cease to exist on resolving.
  copySpellOnStack(item, controllerId, why = 'copy') {
    const copy = { ...item, id: uid('stk'), isCopy: true, controllerId, targets: [...item.targets] };
    this.stack.push(copy);
    this.log(`A copy of ${item.card.name} is put on the stack (${why}).`);
    const flags = { kicked: item.kicked, bargained: item.bargained, gift: item.gift, overload: item.altCostKind === 'overload' };
    const kinds = this.getRequiredTargetKinds(item.card, item.modeIndexes, flags);
    const permanentKinds = ['creature', 'yourCreature', 'creatureOrPlayer', 'planeswalker', 'playerOrPlaneswalker', 'permanent', 'player', 'artifact', 'enchantment', 'land'];
    if (kinds.length && kinds.every(k => permanentKinds.includes(k))) {
      const controller = this.getPlayer(controllerId);
      if (controller.isAI) {
        const avoid = item.targets.find(t => t?.type === 'permanent')?.id || null;
        const picked = pickTargetsForKinds(this, item.card, controllerId, kinds, avoid);
        copy.targets = picked.map((t, i) => t || item.targets[i]);
      } else if (kinds.length === 1) {
        const current = item.targets[0];
        const name = (t) => t?.type === 'player' ? this.getPlayer(t.id).name : this.findPermanent(t?.id)?.card.name || 'nothing';
        const options = [{ label: `Keep the same target (${name(current)})`, resolve: () => {} }];
        for (const t of this.legalTargetsForKind(kinds[0], controllerId, item.card)) {
          if (t.type === current?.type && t.id === current?.id) continue;
          options.push({ label: `Target ${name(t)}`, resolve: () => { if (this.stack.includes(copy)) copy.targets = [t]; } });
          if (options.length >= 9) break;
        }
        if (options.length > 1) this.requestChoice(controllerId, `Choose a new target for the copy of ${item.card.name}?`, options);
      }
    }
    this.triggerBecomesTarget(copy.targets, controllerId);
    this.maybeCounterForWard(copy);
    return copy;
  }

  // Every legal target of a coarse target kind (see effects.js's
  // describeTargetKind) for a spell/ability controlled by controllerId.
  legalTargetsForKind(kind, controllerId, sourceCard = null) {
    const out = [];
    if (['player', 'creatureOrPlayer', 'playerOrPlaneswalker'].includes(kind)) {
      for (const pl of this.players) if (!pl.lost) out.push({ type: 'player', id: pl.id });
    }
    for (const pl of this.players) {
      for (const perm of pl.battlefield) {
        if (!this.canBeTargetedBy(perm, controllerId, sourceCard)) continue;
        const ok = kind === 'permanent'
          || (kind === 'artifact' && isArtifact(perm.card))
          || (kind === 'enchantment' && isEnchantment(perm.card))
          || (kind === 'land' && isLand(perm.card))
          || (kind === 'creature' && isCreature(perm.card))
          || (kind === 'yourCreature' && isCreature(perm.card) && perm.controllerId === controllerId)
          || (kind === 'creatureOrPlayer' && (isCreature(perm.card) || isPlaneswalker(perm.card)))
          || ((kind === 'planeswalker' || kind === 'playerOrPlaneswalker') && isPlaneswalker(perm.card));
        if (ok) out.push({ type: 'permanent', id: perm.id });
      }
    }
    return out;
  }

  // How many times a repeatable optional cost (Replicate, Squad) could be
  // paid on top of the spell's cost right now — capped, since nothing real
  // goes past a handful. extraBase: other added costs already committed.
  maxAffordableRepeats(playerId, card, cost, extraBase = '', cap = 6) {
    let n = 0;
    while (n < cap && this.canAffordWithExtra(playerId, card, extraBase + cost.repeat(n + 1))) n++;
    return n;
  }

  // Whether the card's cost plus `extra` (a mana string) is payable now.
  canAffordWithExtra(playerId, card, extra = '') {
    const parsed = parseManaCost((card.manaCost || '') + extra);
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    return !!this.planSpellPayment(playerId, card, parsed, 0);
  }

  // Removes a just-cast spell from the stack if checkWardAndMaybeCounter
  // says it should be countered — a countered COMMANDER spell goes back to
  // the command zone rather than the graveyard, same as applyCounterEffect's
  // own Counterspell-style path.
  maybeCounterForWard(stackItem) {
    if (!this.checkWardAndMaybeCounter(stackItem.controllerId, stackItem.targets)) return;
    this.stack = this.stack.filter(s => s.id !== stackItem.id);
    if (stackItem.isCopy) return;
    if (stackItem.faceDown) stackItem.card = stackItem.faceDown.card;
    if (stackItem.card._dfcOriginal) stackItem.card = stackItem.card._dfcOriginal;
    // The card's real owner (see castSpell's own `ownerId` option/comment)
    // — almost always the same as the caster, but not for a card like
    // Etali, Primal Storm's own attack trigger casts someone else's.
    const owner = this.getPlayer(stackItem.ownerId || stackItem.controllerId);
    const wardEntry = this.commanderMode ? this.commanderEntryFor(owner, stackItem.card) : null;
    if (wardEntry) {
      wardEntry.inZone = true;
      this.syncCommanderFields(owner);
      this.log(`${stackItem.card.name} returns to ${owner.name}'s command zone instead.`);
    } else {
      owner.graveyard.push(stackItem.card);
    }
  }

  // ---------- command zone (Commander format only) ----------

  // Tax: {2} for each previous cast of THAT commander from the zone (each
  // partner has its own).
  commanderTax(player, index = 0) { return 2 * (player.commanders?.[index]?.castCount || 0); }

  // Legacy single-commander fields, kept in step with the first commander.
  syncCommanderFields(pl) {
    const first = pl.commanders?.[0];
    pl.commander = first?.card || null;
    pl.commanderZone = !!first?.inZone;
    pl.commanderCastCount = first?.castCount || 0;
  }

  commanderEntryFor(player, card) {
    return (player.commanders || []).find(e => e.card === card || e.card === card?._dfcOriginal || e.card === card?._baseCard) || null;
  }

  canCastCommander(playerId, index = 0) {
    const p = this.getPlayer(playerId);
    const entry = p.commanders?.[index];
    if (!this.commanderMode || !entry || !entry.inZone) return false;
    return this.canCastSpell(playerId, entry.card);
  }

  // Mirrors castSpell, but the card comes from the command zone (not hand)
  // and its cost is its mana cost plus {2} for every previous cast from the
  // zone this game (the "commander tax", cumulative and permanent).
  castCommander(playerId, targets = [], xValue = 0, index = 0) {
    const p = this.getPlayer(playerId);
    if (!this.canCastCommander(playerId, index)) return { ok: false, reason: 'Cannot cast your commander right now.' };
    const entry = p.commanders[index];
    const card = entry.card;

    const taxPaid = this.commanderTax(p, index);
    const parsed = parseManaCost(card.manaCost);
    parsed.generic += taxPaid;
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    const payment = planManaPayment(untapped, parsed, xValue, p.manaPool);
    if (!payment) return { ok: false, reason: 'Not enough mana.' };

    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    entry.inZone = false;
    entry.castCount += 1;
    this.syncCommanderFields(p);

    const stackItem = {
      id: uid('stk'),
      card,
      controllerId: playerId,
      targets,
      xValue,
      isPermanentSpell: isPermanentType(card) && !isAura(card),
      isAura: isAura(card),
    };
    this.stack.push(stackItem);
    this.log(`${p.name} casts ${card.name} from the command zone${taxPaid > 0 ? ` (tax paid: {${taxPaid}})` : ''}.`);
    this.triggerCastSpell(playerId, card);
    this.triggerBecomesTarget(targets, playerId);
    this.maybeCounterForWard(stackItem);
    this.afterAction(playerId);
    return { ok: true };
  }

  // Fires "whenever you cast a [type] spell" triggers on every permanent the
  // caster controls (these are almost always self-buffs, e.g. "put a +1/+0
  // counter on this creature" — a fundamentally different trigger shape from
  // triggerETB, which fires off one permanent entering rather than an event
  // affecting everything a player controls). Runs right after the spell is
  // committed to the stack, mirroring real Magic's "cast trigger" timing.
  triggerCastSpell(playerId, castCard) {
    this.triggerExtort(playerId, castCard);
    // Flurry-style: "whenever you cast your second spell each turn".
    const nthCaster = this.getPlayer(playerId);
    for (const perm of [...nthCaster.battlefield]) {
      for (const t of memoSteps(interpretNthSpellTriggers, perm.card)) {
        if ((nthCaster.spellsCastThisTurn || 0) === t.n) this.runPermanentTrigger(perm, t.steps, { castCard });
      }
    }
    // Prowess: whenever you cast a noncreature spell, +1/+1 until end of
    // turn. (Only its reminder text describes this, and reminder text is
    // stripped, so it never triggered before.)
    if (!isCreature(castCard)) {
      for (const perm of this.getPlayer(playerId).battlefield) {
        if (isCreature(perm.card) && this.effectiveKeywords(perm).has('prowess')) {
          this.applyPumpEffect({ controllerId: playerId, card: perm.card, target: { type: 'permanent', id: perm.id } }, 1, 1);
        }
      }
    }
    const caster = this.getPlayer(playerId);
    for (const perm of caster.battlefield) {
      const triggers = interpretCastTriggers(perm.card);
      for (const trig of triggers) {
        if (!spellMatchesFilter(castCard, trig.filter)) continue;
        this.resolveEffectSteps(trig.steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
      }
    }
    // Eminence (Edgar Markov, and the whole Eminence mechanic): an
    // Eminence-flagged cast trigger works from the COMMAND ZONE too, not
    // just the battlefield — checked separately since a commander sitting
    // in the command zone has no battlefield permanent object at all, so
    // the loop above never sees it. Only eminence-tagged triggers count
    // here; a commander's OTHER triggered abilities still require actually
    // being on the battlefield, same as any other permanent.
    for (const entry of this.commanderMode ? caster.commanders || [] : []) {
      if (!entry.inZone) continue;
      const triggers = interpretCastTriggers(entry.card).filter(t => t.eminence);
      for (const trig of triggers) {
        if (!spellMatchesFilter(castCard, trig.filter)) continue;
        this.resolveEffectSteps(trig.steps, [], { controllerId: caster.id, card: entry.card, sourcePerm: null });
      }
    }
  }

  // Fires "whenever ~ dies" triggers (Blood Artist, Grave Pact, Meren's
  // recursion engine, ...) — a fundamentally different shape from the other
  // trigger dispatchers: the watching permanent can belong to EITHER player
  // and the dying creature has already left the battlefield by the time
  // this runs (called from movePermanentToGraveyard), so it's passed in
  // directly rather than looked up. Any step needing a 'player' target
  // defaults to the dying creature's controller (matches the overwhelming
  // majority of real "that player loses life" wording); other target kinds
  // are left unfillable and degrade gracefully like anywhere else.
  // A dies-trigger's effect can itself cause another death (Grave Pact's
  // edict, a destroy effect, ...), which calls back into this same method —
  // bounded in practice by the finite number of creatures on the board (each
  // can only die once per resolution), but guarded explicitly anyway rather
  // than trusting that every future effect added here preserves that.
  static TRIGGER_CASCADE_DEPTH_CAP = 25;

  // previouslyAttachedIds: permanent ids that were attached to diedPerm
  // right before it left the battlefield (see movePermanentToGraveyard's
  // snapshot) — needed for "whenever equipped/enchanted creature dies"
  // triggers (Skullclamp's "draw two cards", most famously), since an
  // Equipment's own attachedTo is already cleared to null by the time this
  // runs, unlike an Aura (which would have gone to the graveyard itself
  // instead of surviving to watch).
  triggerDies(diedPerm, previouslyAttachedIds = new Set()) {
    this.applyDiesKeywords(diedPerm);
    this._diesCascadeDepth = (this._diesCascadeDepth || 0) + 1;
    if (this._diesCascadeDepth > Game.TRIGGER_CASCADE_DEPTH_CAP) {
      this.log(`Death-trigger cascade got ${Game.TRIGGER_CASCADE_DEPTH_CAP} deep — stopping here rather than risking a runaway chain.`);
      this._diesCascadeDepth -= 1;
      return;
    }
    try {
      // Afterlife N: "when this creature dies, create N 1/1 white and black
      // Spirit creature tokens with flying" — for its controller.
      // Blitz: a blitzed creature has "when this creature dies, draw a card".
      if (diedPerm.altCostKind === 'blitz') {
        this.log(`${diedPerm.card.name} was blitzed — its controller draws a card.`);
        this.drawCard(this.getPlayer(diedPerm.controllerId));
      }
      const afterlife = this.keywordAmount(diedPerm.card, 'afterlife');
      if (afterlife > 0) this.applyTokenEffect({ controllerId: diedPerm.controllerId, card: diedPerm.card }, afterlife, 1, 1, 'white black spirit', 'flying');
      const diedControllerId = diedPerm.controllerId;
      const watchers = [];
      for (const pl of this.players) for (const perm of pl.battlefield) watchers.push(perm);
      watchers.push(diedPerm); // its own "when this dies" still applies, even though it just left

      for (const watcher of watchers) {
        const triggers = interpretDiesTriggers(watcher.card);
        for (const trig of triggers) {
          if (trig.scope === 'attachedCreature') {
            if (!previouslyAttachedIds.has(watcher.id)) continue;
            this.resolveEffectSteps(trig.steps, [], { controllerId: watcher.controllerId, card: watcher.card, sourcePerm: diedPerm });
            continue;
          }
          const isSelf = watcher.id === diedPerm.id;
          const sameController = watcher.controllerId === diedControllerId;
          if (!ownerScopeMatches(trig.scope, isSelf, sameController)) continue;
          if (!dyingTypeMatches(trig.dyingType, diedPerm.card)) continue;
          // "Another nontoken creature" (Anax): a dying token doesn't count.
          if (trig.nontoken && isTokenCard(diedPerm.card) && diedPerm.id !== watcher.id) continue;
          const targets = trig.steps.filter(s => s.targeting !== 'none')
            .map(s => s.targeting === 'player' ? { type: 'player', id: diedControllerId } : null);
          // diedCard lets an effect refer to "it"/"that creature" meaning
          // the creature that just died (Athreos, God of Passage's "return
          // it to your hand"), distinct from ctx.card (the watcher's own
          // card) and ctx.sourcePerm (the watcher permanent itself).
          this.resolveEffectSteps(trig.steps, targets, { controllerId: watcher.controllerId, card: watcher.card, sourcePerm: watcher, diedCard: diedPerm.card });
        }
      }
      this.checkStateBasedActions();
    } finally {
      this._diesCascadeDepth -= 1;
    }
  }

  // Fires "whenever ~ attacks" triggers (Goblin Guide, Grave Titan's
  // "enters or attacks"). Only scans the attacker's own controller's
  // battlefield — real "whenever a creature you control attacks" effects
  // always belong to that same player, never an opponent watching.
  triggerAttacks(attackerPerm) {
    const controller = this.getPlayer(attackerPerm.controllerId);
    // Battalion: "whenever this creature and at least two other creatures attack".
    for (const b of memoSteps(interpretBattalionTriggers, attackerPerm.card)) {
      if (controller.battlefield.filter(x => x.attacking && x.id !== attackerPerm.id).length >= b.min) this.runPermanentTrigger(attackerPerm, b.steps);
    }
    for (const watcher of [...controller.battlefield]) {
      if (!this.findPermanent(watcher.id)) continue;
      const triggers = interpretAttackTriggers(watcher.card);
      for (const trig of triggers) {
        if (trig.whileSaddled && !(watcher.id === attackerPerm.id && attackerPerm.saddled)) continue;
        if (trig.battalion) continue;
        // "Whenever enchanted/equipped creature attacks, ..." (Ordeal of
        // Heliod, and the same template on plenty of other Auras and
        // Equipment) — only fires when the watcher (the Aura/Equipment
        // itself) is actually attached to the creature that's attacking, and
        // its effect's "it"/"this creature" self-reference has to resolve to
        // that ENCHANTED creature, not the Aura/Equipment permanent — unlike
        // every other attack trigger below, whose sourcePerm is the watcher.
        if (trig.scope === 'attachedCreature') {
          if (watcher.attachedTo !== attackerPerm.id) continue;
          this.resolveEffectSteps(trig.steps, [], { controllerId: watcher.controllerId, card: watcher.card, sourcePerm: attackerPerm });
          continue;
        }
        const isSelf = watcher.id === attackerPerm.id;
        if (!ownerScopeMatches(trig.scope, isSelf, true)) continue;
        this.resolveEffectSteps(trig.steps, [], { controllerId: watcher.controllerId, card: watcher.card, sourcePerm: watcher });
      }
    }
    this.checkStateBasedActions();
  }

  // Fires "whenever you attack, EFFECT" (Ranger Class's own level-2
  // ability) — ONCE per combat, for every permanent the attacking player
  // controls (not just creatures — Ranger Class is an enchantment), right
  // after attackers are declared. No real choose-target UI (this engine's
  // usual simplification): a plain creature-shaped target prefers the
  // controller's own best currently-attacking creature (the whole point of
  // a trigger like this is buffing an attacker), falling back to
  // autoPickTarget's usual pick for any other target kind.
  triggerWhenYouAttack(playerId) {
    const p = this.getPlayer(playerId);
    for (const perm of [...p.battlefield]) {
      const steps = interpretWhenYouAttackTriggers(perm.card);
      if (steps.length === 0) continue;
      const kinds = expandTargetKinds(steps);
      const ctxBase = { controllerId: playerId, card: perm.card, sourcePerm: perm };
      const targets = kinds.map(kind => {
        if (kind === 'creature' || kind === 'yourCreature' || kind === 'creatureOrPlayer' || kind === 'permanent') {
          const ownAttackers = p.battlefield.filter(x => x.attacking && isCreature(x.card));
          if (ownAttackers.length > 0) {
            const best = ownAttackers.sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
            return { type: 'permanent', id: best.id };
          }
        }
        return this.autoPickTarget(kind, playerId);
      }).filter(Boolean);
      this.resolveEffectSteps(steps, targets, ctxBase);
    }
    this.checkStateBasedActions();
  }

  // Fires "whenever ~ deals combat damage to a player" triggers (Ragavan and
  // similar). Only scans the source's own controller's battlefield, same as
  // triggerAttacks — this is always about a creature's own controller
  // seeing it connect, never an opponent watching it happen.
  triggerCombatDamageToPlayer(sourcePerm, amount) {
    // Hunter's Insight: draw that many cards.
    if (sourcePerm.drawOnCombatDamageTurn === this.turnNumber && amount > 0) { this.log(`${sourcePerm.card.name}'s damage draws ${amount} card${amount > 1 ? 's' : ''}.`); this.applyDrawEffect({ controllerId: sourcePerm.controllerId, card: sourcePerm.card }, amount); }
    // Cipher: cast a copy of each card encoded on this creature.
    for (const encoded of sourcePerm.encoded || []) this.putCopyOnStack(encoded, sourcePerm.controllerId, { cast: true, why: 'cipher' });
    // Renown N: "when this deals combat damage to a player, if it isn't
    // renowned, put N +1/+1 counters on it and it becomes renowned."
    const renown = this.keywordAmount(sourcePerm.card, 'renown');
    if (renown > 0 && !sourcePerm.renowned && this.findPermanent(sourcePerm.id)) {
      sourcePerm.renowned = true;
      this.log(`${sourcePerm.card.name} becomes renowned.`);
      this.applyCounterAdditionEffect({ controllerId: sourcePerm.controllerId, card: sourcePerm.card, target: { type: 'permanent', id: sourcePerm.id } }, renown, '+1/+1');
    }
    // Ingest: that player exiles the top card of their library.
    if (this.effectiveKeywords(sourcePerm).has('ingest')) {
      const victim = this.opponentOf(sourcePerm.controllerId);
      const top = victim.library.shift();
      if (top) { victim.exile.push(top); this.log(`Ingest: ${victim.name} exiles ${top.name} from the top of their library.`); }
    }
    const controller = this.getPlayer(sourcePerm.controllerId);
    // Snapshot: what triggers is fixed at the moment the damage is dealt. A
    // live loop let token copies made mid-loop trigger too — Bloodforged
    // Battle-Axe's copies, attached to the same creature by Sigarda's Aid,
    // copied themselves forever.
    for (const watcher of [...controller.battlefield]) {
      if (!this.findPermanent(watcher.id)) continue;
      const triggers = interpretCombatDamageTriggers(watcher.card);
      for (const trig of triggers) {
        // "Whenever enchanted/equipped creature deals combat damage to a
        // player, ..." (Celestial Mantle, and the same template as the
        // attack-trigger/dies-trigger cases above) — only fires when the
        // watcher is actually attached to the creature that just connected.
        if (trig.scope === 'attachedCreature') {
          if (watcher.attachedTo !== sourcePerm.id) continue;
          this.resolveEffectSteps(trig.steps, [], { controllerId: watcher.controllerId, card: watcher.card, sourcePerm, combatDamageAmount: amount });
          continue;
        }
        const isSelf = watcher.id === sourcePerm.id;
        if (!ownerScopeMatches(trig.scope, isSelf, true)) continue;
        this.resolveEffectSteps(trig.steps, [], { controllerId: watcher.controllerId, card: watcher.card, sourcePerm: watcher, combatDamageAmount: amount });
      }
    }
    this.checkStateBasedActions();
  }

  resolveTop() {
    this.resetTriggerChain();
    const item = this.stack.pop();
    if (!item) return;
    const { controllerId } = item;
    // A copy of a permanent spell becomes a token (rule 707.10f).
    const card = item.isCopy && item.isPermanentSpell ? makeTokenCopyCard(item.card) : item.card;
    const p = this.getPlayer(controllerId);
    // Gift: the opponent gets it before the spell's other effects (the
    // original only — a copy doesn't give a second gift).
    if (item.gift && !item.isCopy) this.deliverGift(card, controllerId);

    // Mutate: merge onto the target creature (if it's still a legal
    // non-Human creature its caster owns); otherwise it enters normally.
    if (item.isPermanentSpell && item.mutateTargetId) {
      const target = this.findPermanent(item.mutateTargetId);
      if (target && isCreature(target.card) && target.ownerId === controllerId && !/\bhuman\b/i.test(target.card.typeLine || '')) {
        const aiTop = (parseInt(card.power, 10) || 0) >= (parseInt(target.card.power, 10) || 0);
        this.requestChoice(controllerId, `Mutate ${card.name}: on top or underneath ${target.card.name}?`, [
          { label: `On top (it becomes ${card.name})`, resolve: () => (this.findPermanent(target.id) ? this.mergeMutate(target, card, true) : p.graveyard.push(card)) },
          { label: `Underneath (it stays ${target.card.name})`, resolve: () => (this.findPermanent(target.id) ? this.mergeMutate(target, card, false) : p.graveyard.push(card)) },
        ], aiTop ? 0 : 1);
        return;
      }
    }

    if (item.isPermanentSpell) {
      const perm = makePermanent(card, controllerId);
      if (item.faceDown) perm.faceDown = item.faceDown;
      if (card._dfcOriginal) perm._dfcCard = card._dfcOriginal;
      perm.disturbed = item.graveyardVia === 'disturb';
      if (item.fromZone === 'graveyard') perm.enteredFromGraveyardOf = controllerId;
      // Kumano Faces Kakkazan II: the next creature spell this turn gets a counter.
      if (isCreature(card) && !item.isCopy && p.nextCreatureExtraCounter === this.turnNumber) {
        p.nextCreatureExtraCounter = null;
        perm.counters['+1/+1'] = (perm.counters['+1/+1'] || 0) + 1;
      }
      perm.wasBargained = !!item.bargained;
      perm.castInfo = item.castInfo || null;
      perm.giftPromised = !!item.gift;
      perm.squadCount = item.squadCount || 0;
      perm.offspring = !!item.offspring;
      // makePermanent always sets ownerId = controllerId (the overwhelming
      // common case), which is wrong the moment caster and true owner
      // differ (Etali, Primal Storm casting an opponent's exiled
      // creature) — override it from the stack item's own `ownerId`
      // (castSpell's own option; defaults to the caster otherwise, so
      // this is a no-op for every normal cast).
      perm.ownerId = item.ownerId || controllerId;
      // Set BEFORE triggerETB, so "if it was kicked, ..." (Territorial
      // Allosaurus, and the whole Kicker archetype) sees the real value
      // when its own ETB trigger checks it.
      perm.wasKicked = !!item.kicked;
      // Suspend: a creature cast when its last time counter came off has haste.
      if (item.viaSuspend && isCreature(card)) perm.tempKeywords.push('haste');
      // Alternative costs that change the permanent itself.
      perm.altCostKind = item.altCostKind || null;
      if (item.altCostKind === 'impending') {
        const imp = getAlternativeCosts(card).find(a => a.kind === 'impending');
        perm.impending = true;
        perm.counters.time = (perm.counters.time || 0) + (imp?.amount || 0);
      }
      if (item.altCostKind === 'dash' || item.altCostKind === 'blitz') perm.tempKeywords.push('haste');
      if (item.altCostKind === 'sneak' && isCreature(card) && item.sneakTarget && ['declareBlockers', 'combatDamage'].includes(this.step)) {
        perm.tapped = true; perm.attacking = true; perm.attackedThisTurn = true; perm.attackTarget = item.sneakTarget; perm.blockedBy = [];
      }
      if (item.altCostKind === 'prototype') {
        const proto = getAlternativeCosts(card).find(a => a.kind === 'prototype');
        if (proto) perm.protoStats = { power: proto.power, toughness: proto.toughness };
      }
      // Compleated: a planeswalker enters with two fewer loyalty counters
      // for each Phyrexian symbol in its cost that was paid with life.
      if (item.phyrexianPaidWithLife && (card.keywords || []).includes('compleated') && perm.counters.loyalty != null) {
        perm.counters.loyalty = Math.max(0, perm.counters.loyalty - 2 * item.phyrexianPaidWithLife);
        this.log(`${card.name} is compleated — it enters with ${2 * item.phyrexianPaidWithLife} fewer loyalty counters.`);
      }
      // Same idea for Escape (Uro, Titan of Nature's Wrath's own "sacrifice
      // it unless it escaped") — see castFromGraveyard.
      perm.escaped = !!item.viaEscape;
      p.battlefield.push(perm);
      this.refreshCardState(perm);
      this.log(`${card.name} enters the battlefield under ${p.name}'s control.`);
      // "This creature enters with N +1/+1 counters on it" (Hangarback
      // Walker's own X-based count, Kalonian Hydra's fixed one) — applied
      // BEFORE the state-based-action check right below, since Hangarback
      // Walker's own printed 0/0 base stats need those counters in place
      // first to survive it at all. Routed through applyCounterAdditionEffect
      // (not a direct perm.counters mutation) so a Hardened Scales/Winding
      // Constrictor already on the battlefield boosts this the same as any
      // other counter placement. X=0 correctly adds nothing at all — real
      // rules only replace an ACTUAL "one or more counters" event.
      const entersWith = getEntersWithCounterCount(card);
      if (entersWith) {
        const amount = entersWith.isX ? (item.xValue || 0) : entersWith.amount;
        if (amount > 0) this.applyCounterAdditionEffect({ controllerId, card, target: { type: 'permanent', id: perm.id } }, amount, '+1/+1');
      }
      // Bloodthirst: same "enters with" replacement, conditional on an
      // opponent having been DEALT DAMAGE this turn (not merely losing
      // life — damageTakenThisTurn only counts real damage).
      // Ravenous: enters with X +1/+1 counters; if X is 5 or more, draw a card.
      if ((card.keywords || []).includes('ravenous')) {
        const x = item.xValue || 0;
        if (x > 0) this.applyCounterAdditionEffect({ controllerId, card, target: { type: 'permanent', id: perm.id } }, x, '+1/+1');
        if (x >= 5) { this.log(`${card.name}'s ravenous: X is ${x}, so its controller draws a card.`); this.drawCard(this.getPlayer(controllerId)); }
      }
      const bloodthirst = getBloodthirstAmount(card);
      if (bloodthirst > 0 && this.opponentOf(controllerId).damageTakenThisTurn > 0) {
        this.log(`${card.name}'s bloodthirst is satisfied.`);
        this.applyCounterAdditionEffect({ controllerId, card, target: { type: 'permanent', id: perm.id } }, bloodthirst, '+1/+1');
      }
      this.applyEntryCounterKeywords(perm, item);
      this.checkStateBasedActions();
      // Tribute: the opponent decides before the creature's ETB triggers
      // (which may check "if tribute wasn't paid") resolve.
      const tribute = this.keywordAmount(card, 'tribute');
      if (tribute > 0) this.offerTribute(perm, tribute, () => this.triggerETB(perm, item.xValue || 0));
      else this.triggerETB(perm, item.xValue || 0);
      // Evoke: "when it enters, sacrifice it" — after its own ETB triggers
      // (Mulldrifter still draws its two cards).
      if (perm.altCostKind === 'evoke' && this.findPermanent(perm.id)) {
        this.log(`${card.name} was evoked and is sacrificed.`);
        this.movePermanentToGraveyard(perm, { sacrifice: true });
      }
      if (isSaga(card)) {
        if (hasReadAhead(card)) this.chooseReadAheadChapter(perm);
        else this.advanceSaga(perm);
      }
      return;
    }

    if (item.isAura) {
      const target = item.targets[0];
      // "Enchant player" (the Curse cycle) — a genuinely different target
      // TYPE from every other Aura, so it gets its own perm.attachedToPlayerId
      // field rather than overloading perm.attachedTo (which every other
      // Aura/Equipment call site already assumes is a permanent's id).
      if (target?.type === 'player') {
        const targetPlayer = this.getPlayer(target.id);
        const perm = makePermanent(card, controllerId);
        perm.attachedToPlayerId = targetPlayer.id;
        p.battlefield.push(perm);
        this.log(`${card.name} enchants ${targetPlayer.name}.`);
        this.checkStateBasedActions();
        return;
      }
      const targetPerm = target && this.findPermanent(target.id);
      // Protection includes "can't be Enchanted by [quality]" — gaining it
      // in response makes the Aura's target illegal, same as it leaving.
      if (!targetPerm || this.isProtectedFrom(targetPerm, card)) {
        // A bestowed Aura whose target is gone enters as a creature instead.
        if (item.bestowed) {
          this.stack.push({ ...item, isAura: false, isPermanentSpell: true, bestowed: false, altCostKind: null });
          this.resolveTop();
          return;
        }
        this.log(`${card.name} has no legal target and is put into the graveyard.`);
        p.graveyard.push(card);
        return;
      }
      const perm = makePermanent(card, controllerId);
      if (item.bestowed) perm.bestowed = true;
      perm.attachedTo = targetPerm.id;
      p.battlefield.push(perm);
      this.refreshCardState(perm);
      this.log(`${card.name} enchants ${targetPerm.card.name}${item.bestowed ? ' (bestowed)' : ''}.`);
      // "You control enchanted creature." (Mind Control, Control Magic) — a
      // STATIC ability tying control to the Aura's own continued presence,
      // unlike every other control-changing effect in this engine (Threaten's
      // one-way "until end of turn", Gilded Drake's permanent two-way swap):
      // this reverts automatically the moment the AURA itself leaves the
      // battlefield — see detachFromLeavingBattlefield's own check for
      // perm.grantsControlOf, the general "any permanent leaves" hook every
      // removal path already calls.
      if (/you control enchanted creature/.test((card.oracleText || '').toLowerCase())) {
        this.applyAuraControlEffect(perm, targetPerm);
      }
      this.checkStateBasedActions();
      return;
    }

    // Instant / sorcery: run interpreted effect steps.
    // castFromGraveyard lets a clause key off "if this spell was cast from
    // a graveyard" (Increasing Confusion's own doubled mill) — set whenever
    // this resolution came from castFromGraveyard's Flashback/Escape path.
    const flags = { kicked: item.kicked, bargained: item.bargained, gift: item.gift, overload: item.altCostKind === 'overload', teamwork: item.teamwork, cleave: item.altCostKind === 'cleave' };
    this.resolveEffectSteps(interpretSpell(card, item.modeIndexes, flags), item.targets, { controllerId, card, xValue: item.xValue, castInfo: item.castInfo, castFromGraveyard: !!(item.viaFlashback || item.viaEscape || item.fromZone === 'graveyard') });
    if (item.altCostKind === 'awaken') {
      const aw = getAlternativeCosts(card).find(a => a.kind === 'awaken');
      if (aw) this.applyAwaken(controllerId, aw.amount);
    }
    // Spliced cards' effects happen too (their targets picked automatically).
    for (const sc of item.spliced || []) {
      const steps = interpretSpell(sc);
      const targets = pickTargetsForKinds(this, sc, controllerId, expandTargetKinds(steps)).filter(Boolean);
      this.log(`${sc.name}'s spliced effect resolves.`);
      this.resolveEffectSteps(steps, targets, { controllerId, card: sc, xValue: 0 });
    }
    // A copy of a spell ceases to exist instead of going anywhere.
    if (item.isCopy) {
      this.checkStateBasedActions();
      return;
    }
    // Epic: no more spells for this player, and a copy every upkeep.
    if (hasEpic(card)) {
      p.cantCastSpells = true;
      (p.epicSpells ||= []).push(card);
      this.log(`${p.name} can't cast spells for the rest of the game (epic); ${card.name} will be copied each upkeep.`);
    }
    // Cipher: exile the card encoded on a creature you control; whenever
    // that creature deals combat damage to a player, cast a copy. AI picks
    // its most evasive creature (flying/unblockable), then its strongest.
    const encodeTargets = hasCipher(card) ? p.battlefield.filter(x => isCreature(x.card)) : [];
    if (encodeTargets.length) {
      p.exile.push(card);
      const evasive = (x) => { const k = this.effectiveKeywords(x); return k.has('unblockable') || k.has('flying') || k.has('shadow') || k.has('menace'); };
      const ranked = encodeTargets.slice().sort((a, b) => (evasive(b) - evasive(a)) || (this.effectivePower(b) - this.effectivePower(a))).slice(0, 7);
      const encode = (perm) => () => {
        if (!this.findPermanent(perm.id)) return toGraveyard();
        (perm.encoded ||= []).push(card);
        this.log(`${card.name} is encoded on ${perm.card.name}.`);
      };
      const toGraveyard = () => { const i = p.exile.indexOf(card); if (i !== -1) { p.exile.splice(i, 1); this.getPlayer(item.ownerId || controllerId).graveyard.push(card); } };
      this.requestChoice(controllerId, `${card.name} — Cipher: encode it on a creature?`, [
        ...ranked.map(x => ({ label: `Encode on ${x.card.name}`, resolve: encode(x) })),
        { label: "Don't encode", resolve: toGraveyard },
      ], 0);
      this.checkStateBasedActions();
      return;
    }
    // The printed card (not just the cast face) goes to the zone.
    const zoneCard = card._dfcOriginal || card;
    // Adventure: the card goes on an adventure — exiled, castable later as
    // its creature face.
    if (item.faceKind === 'adventure') {
      p.exiledPlayable.push({ id: uid('exile'), card: zoneCard, remainingOwnTurns: Infinity, kind: 'adventure' });
      this.log(`${zoneCard.name} goes on an adventure (exiled; it can be cast as ${zoneCard.faces[0].name} later).`);
      this.checkStateBasedActions();
      return;
    }
    // Flashback and Escape both exile an instant/sorcery as it resolves
    // instead of putting it into the graveyard as usual (Flashback's own
    // "then exile it"; Escape's identical real-rules behavior for
    // non-permanent cards) — see castFromGraveyard.
    if (item.viaFlashback || item.viaEscape) {
      p.exile.push(zoneCard);
      this.log(`${card.name} is exiled instead of returning to the graveyard (cast from the graveyard).`);
    } else if (hasHaunt(zoneCard) && this.players.some(pl => pl.battlefield.some(x => isCreature(x.card)))) {
      // Haunt (spell): exiled haunting a creature instead of the graveyard.
      this.hauntCreature(this.getPlayer(item.ownerId || controllerId), zoneCard, controllerId, () => {});
    } else if (hasParadigm(card)) {
      // Paradigm: exiled; a free copy can be cast each first main phase.
      p.exile.push(zoneCard);
      if (!(p.paradigms ||= []).some(c => c.name === card.name)) p.paradigms.push(card);
      this.log(`${card.name} is exiled (paradigm) — ${p.name} may cast a copy at the start of each first main phase.`);
    } else if (hasRebound(card) && item.fromZone === 'hand' && !item.viaRebound) {
      // Rebound: cast from hand, so exile it as it resolves; it can be cast
      // free from exile at its controller's next upkeep (see tickRebound).
      (p.rebounding ||= []).push(card);
      this.log(`${card.name} is exiled (rebound) — it can be cast again at ${p.name}'s next upkeep.`);
    } else if (item.exileToOwnerId) {
      // Diluvian Primordial's own "if a spell cast this way would be put
      // into a graveyard, exile it instead" — the card's owner is whoever
      // it was cast FROM (an opponent's graveyard), not this spell's
      // CASTER (item.controllerId, who's just borrowing it), so this goes
      // to a different player's exile than the `p.exile` case above.
      this.getPlayer(item.exileToOwnerId).exile.push(zoneCard);
      this.log(`${card.name} is exiled instead of returning to its owner's graveyard.`);
    } else if (item.buyback) {
      // Buyback paid: "put this card into your hand as it resolves." Only on
      // RESOLUTION — a countered buyback spell still goes to the graveyard
      // (that path never reaches here), and the cast-from-graveyard exile
      // replacements above win, same as real rules.
      this.getPlayer(item.ownerId || controllerId).hand.push(zoneCard);
      this.log(`${card.name} returns to its owner's hand (buyback).`);
    } else {
      // Normally the caster's own graveyard, EXCEPT when the card's real
      // owner is someone else (Etali, Primal Storm casting an opponent's
      // exiled card, with no "exile it instead" text of its own) — see
      // castSpell's own `ownerId` option/comment.
      this.getPlayer(item.ownerId || controllerId).graveyard.push(zoneCard);
    }
    this.checkStateBasedActions();
  }

  // Runs a list of effect steps (from a spell, ETB trigger, or activated
  // ability) against a pre-chosen targets array aligned (via
  // expandTargetKinds's same flat-slot counting) to the steps that need
  // one. Shared so all three sources handle missing/removed targets the
  // same way. A step with targetCount > 1 ("up to two target creatures")
  // consumes that many consecutive slots instead of one, exposing them as
  // ctx.targets (array) — ctx.target is still set to the first one so every
  // existing single-target resolve function keeps working unchanged.
  resolveEffectSteps(steps, targets, ctxBase) {
    // Infinite-loop guard: count how often each source resolves within one
    // chain of triggers (reset at every player action, stack resolution, and
    // step). Past LOOP_LIMIT, it's a loop — see handleLoop.
    if (this._loopHalted || this.gameOver) return;
    const src = ctxBase?.card?.name;
    if (src) {
      const chain = (this._triggerChain ||= new Map());
      const n = (chain.get(src) || 0) + 1;
      chain.set(src, n);
      if (n > Game.LOOP_LIMIT) { this.handleLoop(); return; }
    }
    let cursor = 0;
    for (const step of steps) {
      const ctx = { ...ctxBase };
      if (step.targeting !== 'none') {
        const count = step.targetCount || 1;
        const picked = targets.slice(cursor, cursor + count);
        cursor += count;
        if (count === 1) {
          const t = picked[0];
          if (!t) {
            this.log(`${ctxBase.card.name}'s ability has no legal target; that part does nothing.`);
            continue;
          }
          if (t.type === 'permanent' && !this.findPermanent(t.id)) {
            this.log(`A target for ${ctxBase.card.name} is no longer legal; that part does nothing.`);
            continue;
          }
          ctx.target = t;
          ctx.targets = [t];
        } else {
          // "Up to N" (or a mandatory N): fewer than N legal targets is a
          // normal outcome, not a failure — only bail if NONE came through.
          const valid = picked.filter(t => t && (t.type !== 'permanent' || this.findPermanent(t.id)));
          if (valid.length === 0) {
            this.log(`${ctxBase.card.name}'s ability has no legal targets; that part does nothing.`);
            continue;
          }
          ctx.target = valid[0];
          ctx.targets = valid;
        }
      }
      if (step.targeting === 'yourCreature' && ctx.target?.type === 'permanent') this._biteSourceId = ctx.target.id;
      step.resolve(this, ctx);
    }
  }

  // "Each other creature you control of the chosen type enters with an
  // additional +1/+1 counter on it." (Metallic Mimic) — a narrow, specific
  // replacement effect on the ENTERING creature itself, not a general
  // "creature enters with a counter" framework (this engine's generic
  // replacement-effect support is a separate, documented gap — see
  // README). "The chosen type" reads other.chosenType, set by
  // applyChooseCreatureTypeEffect.
  applyCounterOnEntryBonus(enteredPerm) {
    if (!isCreature(enteredPerm.card)) return;
    const controller = this.getPlayer(enteredPerm.controllerId);
    for (const other of controller.battlefield) {
      if (other.id === enteredPerm.id || !other.chosenType) continue;
      const text = (other.card.oracleText || '').toLowerCase();
      if (!/each other creature you control of the chosen type enters with an additional \+1\/\+1 counter/.test(text)) continue;
      if (!(enteredPerm.card.typeLine || '').toLowerCase().includes(other.chosenType.toLowerCase())) continue;
      enteredPerm.counters['+1/+1'] = (enteredPerm.counters['+1/+1'] || 0) + 1;
      this.log(`${enteredPerm.card.name} enters with an additional +1/+1 counter from ${other.card.name}.`);
    }
  }

  // ---------- enters-the-battlefield triggers ----------

  // xValue: the {X} the caster paid, for an X-cost PERMANENT whose own ETB
  // trigger references X (The Meathook Massacre's "-X/-X" mass debuff, and
  // similar) — threaded through from resolveTop's stack item, which is the
  // only place that still knows what X was paid by the time this fires.
  triggerETB(perm, xValue = 0) {
    // Class enchantments (Alchemist's Talent, Ranger Class, Wizard Class,
    // ...) start at level 1 the moment they enter — narrow perm.card's own
    // oracleText down to just level 1's text BEFORE the ETB-trigger scan
    // below runs, so a level-1 "when this Class enters, ..." line (folded
    // into level 1's base text, since it comes before any "{cost}: Level
    // N" line) dispatches through the exact same interpretPermanentTriggers
    // call every other permanent already uses — no separate ETB path
    // needed. See levelUpClass for how leveling up later re-narrows this.
    if (isClassEnchantment(perm.card)) {
      perm.classOriginalOracleText = perm.card.oracleText;
      perm.classLevel = 1;
      this.recomputeClassEffectiveOracleText(perm);
    }
    // Checked FIRST (before any other ETB-shaped dispatch below) so a bonus
    // counter from this replacement effect is already present by the time
    // anything else reacts to this creature having entered.
    this.applyCounterOnEntryBonus(perm);
    // Celebration: nonland permanents entering under your control this turn.
    if (!isLand(perm.card)) { const ctl = this.getPlayer(perm.controllerId); ctl.nonlandEnteredThisTurn = (ctl.nonlandEnteredThisTurn || 0) + 1; }
    // Piggybacks tribal-ETB and any-permanent-ETB dispatch onto this same
    // "a permanent just entered" hub — every real path a permanent can
    // enter the battlefield already calls triggerETB from exactly the
    // right moment, so neither needs separate call sites of its own.
    this.triggerTribalEtb(perm);
    this.triggerAnyEtb(perm);
    this.triggerFabricate(perm);
    this.triggerEntryKeywords(perm);

    const steps = interpretPermanentTriggers(perm.card);
    if (steps.length === 0) return;
    const kinds = expandTargetKinds(steps);
    const ctxBase = { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm, xValue };

    if (kinds.length === 0) {
      this.resolveEffectSteps(steps, [], ctxBase);
      this.checkStateBasedActions();
      this.emit();
      return;
    }

    const controller = this.getPlayer(perm.controllerId);
    if (controller.isAI) {
      // Resolved right away (pickTargetsForKinds is statically imported) —
      // this used to defer to a later microtask via a dynamic import, so an
      // AI's ETB targets were chosen after whatever happened next.
      const targets = pickTargetsForKinds(this, perm.card, perm.controllerId, kinds, perm.id);
      this.resolveEffectSteps(steps, targets, ctxBase);
      this.checkStateBasedActions();
      this.emit();
      return;
    }

    this._pendingETB = { perm, steps, ctxBase };
    this.pendingRequest = { type: 'etbTarget', playerId: perm.controllerId, cardName: perm.card.name, kinds, collected: [], sourcePermId: perm.id };
    this.emit();
  }

  chooseETBTarget(playerId, target) {
    if (this.pendingRequest?.type !== 'etbTarget' || this.pendingRequest.playerId !== playerId) return false;
    this.pendingRequest.collected.push(target);
    if (this.pendingRequest.collected.length >= this.pendingRequest.kinds.length) {
      const { steps, ctxBase, onComplete } = this._pendingETB;
      const collected = this.pendingRequest.collected;
      this.pendingRequest = null;
      this._pendingETB = null;
      if (onComplete) onComplete(collected);
      else this.resolveEffectSteps(steps, collected, ctxBase);
      this.checkStateBasedActions();
    }
    this.emit();
    return true;
  }

  // A generic "choose one" prompt for keyword abilities that offer a real
  // choice (Fabricate's counters-or-Servos, ...). options: [{ label,
  // resolve }]. An AI player resolves aiPickIndex immediately; a human gets
  // a pendingRequest of plain labels, one button each in the action bar.
  // The resolve closures live in _pendingChoice rather than pendingRequest
  // because pendingRequest is deep-cloned for undo and can't hold
  // functions — the same split as _pendingETB above.
  // Human choices are QUEUED: several can come up at once (two Riot
  // creatures entering, Enlist and Exploit in the same turn), and one may
  // arrive while some other prompt (declaring attackers, an ETB target) is
  // still open. showNextChoice surfaces the next one whenever nothing else
  // is pending — it's called from emit(), so any state change that clears
  // a pendingRequest lets the queue advance.
  requestChoice(playerId, prompt, options, aiPickIndex = 0) {
    if (this.getPlayer(playerId).isAI) {
      options[aiPickIndex].resolve();
      return;
    }
    (this._choiceQueue ||= []).push({ playerId, prompt, options });
    this.showNextChoice();
  }

  showNextChoice() {
    if (this.pendingRequest || !this._choiceQueue?.length || this.gameOver) return;
    const next = this._choiceQueue.shift();
    this._pendingChoice = next.options;
    this.pendingRequest = { type: 'choice', playerId: next.playerId, prompt: next.prompt, labels: next.options.map(o => o.label) };
    this.emit();
  }

  makeChoice(playerId, index) {
    if (this.pendingRequest?.type !== 'choice' || this.pendingRequest.playerId !== playerId) return false;
    this.resetTriggerChain();
    const option = this._pendingChoice?.[index];
    if (!option) return false;
    this.pendingRequest = null;
    this._pendingChoice = null;
    option.resolve();
    this.checkStateBasedActions();
    this.emit();
    this.maybeLetAIAct();
    return true;
  }

  // Self-ETB keyword choices and triggers: Riot (counter or haste),
  // Unleash (counter, but then it can't block), Exploit (may sacrifice a
  // creature for a payoff), and Evolve on OTHER creatures you control.
  triggerEntryKeywords(perm) {
    this.applyHideaway(perm);
    if (getEcho(perm.card)) perm.echoDue = true;
    // Prized Amalgam: a creature entered from (or was cast from) its
    // owner's graveyard → Amalgams in that graveyard return tapped at the
    // next end step.
    if (perm.enteredFromGraveyardOf && isCreature(perm.card)) {
      const owner = this.getPlayer(perm.enteredFromGraveyardOf);
      for (const c of owner.graveyard) {
        if (c !== perm.card && /whenever a creature enters, if it entered from your graveyard or you cast it from your graveyard, return this card from your graveyard to the battlefield tapped at the beginning of the next end step/i.test(c.oracleText || '')) {
          (this._amalgamReturns ||= []).push({ card: c, ownerId: owner.id });
        }
      }
    }
    // Palace Siege-style "As this enters, choose A or B" — keeps only the
    // chosen "• A — ..." line.
    this.offerEntryModeChoice(perm);
    if (/^(?:daybound|nightbound)\b/im.test((perm.card.oracleText || '').replace(/\([^()]*\)/g, ''))) {
      if (!this.dayNight) this.setDayNight('day');
      else this.syncDayNightFaces();
    }
    if (hasForMirrodin(perm.card)) {
      // For Mirrodin!: a 2/2 red Rebel token, then attach this to it.
      const p = this.getPlayer(perm.controllerId);
      this.applyTokenEffect({ controllerId: p.id, card: perm.card }, 1, 2, 2, 'red rebel');
      const rebel = p.battlefield[p.battlefield.length - 1];
      if (this.findPermanent(perm.id)) { perm.attachedTo = rebel.id; this.log(`${perm.card.name} is attached to the Rebel.`); }
    }
    if (hasLivingWeapon(perm.card)) {
      // Living weapon: a 0/0 black Phyrexian Germ token, then attach this to it.
      const p = this.getPlayer(perm.controllerId);
      this.applyTokenEffect({ controllerId: p.id, card: perm.card }, 1, 0, 0, 'black phyrexian germ');
      const germ = p.battlefield[p.battlefield.length - 1];
      if (this.findPermanent(perm.id)) { germ.card = { ...germ.card, name: 'Phyrexian Germ' }; perm.attachedTo = germ.id; this.log(`${perm.card.name} is attached to a Phyrexian Germ.`); }
    }
    if (hasJobSelect(perm.card)) {
      // Job select: a 1/1 colorless Hero token, then attach this to it.
      const p = this.getPlayer(perm.controllerId);
      this.applyTokenEffect({ controllerId: p.id, card: perm.card }, 1, 1, 1, 'colorless hero');
      const hero = p.battlefield[p.battlefield.length - 1];
      if (this.findPermanent(perm.id)) { perm.attachedTo = hero.id; this.log(`${perm.card.name} is attached to the Hero.`); }
    }
    if (isCreature(perm.card)) this.offerSoulbond(perm);
    perm.enteredTurn = this.turnNumber;
    const championType = getChampionType(perm.card);
    if (championType) this.offerChampion(perm, championType);
    if (!isCreature(perm.card)) return;
    // Graft: whenever another creature enters, each graft creature may move
    // a +1/+1 counter onto it. The AI only feeds its own creatures, and only
    // from a graft creature with counters to spare.
    for (const pl of this.players) for (const g of pl.battlefield) {
      if (g.id === perm.id || !this.keywordAmount(g.card, 'graft') || !(g.counters['+1/+1'] > 0)) continue;
      const aiYes = pl.id === perm.controllerId && g.counters['+1/+1'] > 1;
      this.requestChoice(pl.id, `${g.card.name} — Graft: move a +1/+1 counter onto ${perm.card.name}?`, [
        { label: `Move a counter onto ${perm.card.name}`, resolve: () => {
          if (!this.findPermanent(g.id) || !this.findPermanent(perm.id) || !(g.counters['+1/+1'] > 0)) return;
          g.counters['+1/+1'] -= 1;
          this.applyCounterAdditionEffect({ controllerId: pl.id, card: g.card, target: { type: 'permanent', id: perm.id } }, 1, '+1/+1');
          this.log(`${g.card.name} grafts a counter onto ${perm.card.name}.`);
        } },
        { label: "Don't move one", resolve: () => {} },
      ], aiYes ? 0 : 1);
    }
    const kws = this.effectiveKeywords(perm);
    const controller = this.getPlayer(perm.controllerId);
    const opponent = this.opponentOf(perm.controllerId);
    const counterOn = (p) => () => {
      if (this.findPermanent(p.id)) this.applyCounterAdditionEffect({ controllerId: p.controllerId, card: p.card, target: { type: 'permanent', id: p.id } }, 1, '+1/+1');
    };

    // Squad: a token copy for each time the squad cost was paid. Offspring:
    // one 1/1 token copy. (The copies weren't cast with those costs paid,
    // so they don't make copies of their own.)
    if (perm.squadCount) {
      this.log(`${perm.card.name}'s squad creates ${perm.squadCount} token cop${perm.squadCount > 1 ? 'ies' : 'y'}.`);
      for (let i = 0; i < perm.squadCount; i++) this.createTokenCopy(perm.card, perm.controllerId);
    }
    if (perm.offspring) {
      this.log(`${perm.card.name}'s offspring creates a 1/1 token copy.`);
      this.createTokenCopy(perm.card, perm.controllerId, { power: 1, toughness: 1 });
    }

    // Backup N: N +1/+1 counters on target creature; if that's another
    // creature, it also gains this creature's keyword abilities until end
    // of turn (Boon-Bringer Valkyrie's flying, first strike, lifelink).
    // Granted triggered abilities (Guardian Scalelord's attack trigger)
    // aren't copied over. AI: the strongest other creature that can still
    // attack this turn, else the best other creature, else itself.
    const backup = getBackupAmount(perm.card);
    if (backup) {
      const granted = (perm.card.keywords || []).map(k => k.toLowerCase()).filter(k => k !== 'backup' && KNOWN_KEYWORDS.includes(k));
      const backupOnto = (target) => () => {
        if (!this.findPermanent(target.id)) return;
        this.applyCounterAdditionEffect({ controllerId: perm.controllerId, card: perm.card, target: { type: 'permanent', id: target.id } }, backup, '+1/+1');
        if (target.id !== perm.id && granted.length) {
          target.tempKeywords.push(...granted);
          this.log(`${target.card.name} gains ${granted.join(', ')} until end of turn (backup).`);
        }
      };
      const others = controller.battlefield.filter(x => x.id !== perm.id && isCreature(x.card))
        .sort((a, b) => this.effectivePower(b) - this.effectivePower(a));
      const choices = [...others.slice(0, 7), perm];
      const canAttack = (x) => !x.tapped && this.canDeclareAsAttacker(x);
      const aiIdx = Math.max(0, choices.findIndex(x => x !== perm && canAttack(x)));
      this.requestChoice(perm.controllerId, `${perm.card.name} — Backup ${backup}: put ${backup > 1 ? `${backup} +1/+1 counters` : 'a +1/+1 counter'} on which creature?`,
        choices.map(x => ({ label: x === perm ? `${x.card.name} (itself)` : x.card.name, resolve: backupOnto(x) })), aiIdx);
    }

    if (kws.has('riot')) {
      // AI: haste when the opponent has no creatures to block, else the counter.
      const noBlockers = !opponent.battlefield.some(x => isCreature(x.card) && !x.tapped);
      this.requestChoice(perm.controllerId, `${perm.card.name} — Riot`, [
        { label: 'Enter with a +1/+1 counter', resolve: counterOn(perm) },
        { label: 'Gain haste', resolve: () => { if (this.findPermanent(perm.id)) perm.tempKeywords.push('haste'); this.log(`${perm.card.name} gains haste (riot).`); } },
      ], noBlockers ? 1 : 0);
    }

    if (kws.has('unleash')) {
      // AI: take the counter (and give up blocking) only when ahead on life.
      this.requestChoice(perm.controllerId, `${perm.card.name} — Unleash`, [
        { label: 'Enter with a +1/+1 counter (it can\'t block)', resolve: counterOn(perm) },
        { label: 'No counter (it can block)', resolve: () => {} },
      ], controller.life >= opponent.life ? 0 : 1);
    }

    if (kws.has('exploit')) {
      const payoff = getExploitPayoffSteps(perm.card);
      const exploit = (victim) => () => {
        if (!this.findPermanent(victim.id)) return;
        this.log(`${perm.card.name} exploits ${victim.card.name}.`);
        this.movePermanentToGraveyard(victim, { sacrifice: true });
        if (payoff.length) {
          const targets = pickTargetsForKinds(this, perm.card, perm.controllerId, expandTargetKinds(payoff), perm.id).filter(Boolean);
          if (minRequiredTargetCount(payoff) <= targets.length) this.resolveEffectSteps(payoff, targets, { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
        }
      };
      const candidates = controller.battlefield.filter(x => isCreature(x.card)).sort((a, b) => this.effectivePower(a) - this.effectivePower(b));
      const options = [{ label: "Don't exploit", resolve: () => {} }, ...candidates.slice(0, 6).map(c => ({ label: `Sacrifice ${c.card.name}`, resolve: exploit(c) }))];
      // AI: exploit only a token or a creature weaker than this one, and
      // only when there's a real payoff to get.
      const fodderIdx = candidates.findIndex(c => c.id !== perm.id && (/\btoken\b/i.test(c.card.typeLine || '') || this.effectivePower(c) < this.effectivePower(perm)));
      this.requestChoice(perm.controllerId, `${perm.card.name} — Exploit`, options, payoff.length && fodderIdx >= 0 && fodderIdx < 6 ? fodderIdx + 1 : 0);
    }

    // Evolve on other creatures you control: +1/+1 counter if the newcomer
    // has greater power or greater toughness.
    for (const other of controller.battlefield) {
      if (other.id === perm.id || !isCreature(other.card) || !this.effectiveKeywords(other).has('evolve')) continue;
      if (this.effectivePower(perm) > this.effectivePower(other) || this.effectiveToughness(perm) > this.effectiveToughness(other)) {
        this.log(`Evolve: ${other.card.name} evolves.`);
        this.applyCounterAdditionEffect({ controllerId: other.controllerId, card: other.card, target: { type: 'permanent', id: other.id } }, 1, '+1/+1');
      }
    }
  }

  // Fabricate N: "when this creature enters, put N +1/+1 counters on it or
  // create N 1/1 colorless Servo artifact creature tokens." The AI goes wide
  // (Servos) when it has fewer creatures than its opponent — bodies to
  // block with — and otherwise grows the creature itself.
  triggerFabricate(perm) {
    const n = getFabricateAmount(perm.card);
    if (!n) return;
    const ctx = { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm };
    const mine = this.getPlayer(perm.controllerId).battlefield.filter(x => isCreature(x.card)).length;
    const theirs = this.opponentOf(perm.controllerId).battlefield.filter(x => isCreature(x.card)).length;
    this.requestChoice(perm.controllerId, `${perm.card.name} — Fabricate ${n}`, [
      {
        label: `Put ${n} +1/+1 counter${n > 1 ? 's' : ''} on ${perm.card.name}`,
        resolve: () => {
          if (!this.findPermanent(perm.id)) return;
          this.applyCounterAdditionEffect({ ...ctx, target: { type: 'permanent', id: perm.id } }, n, '+1/+1');
        },
      },
      {
        label: `Create ${n} 1/1 Servo token${n > 1 ? 's' : ''}`,
        resolve: () => this.applyTokenEffect(ctx, n, 1, 1, 'colorless servo artifact'),
      },
    ], mine < theirs ? 1 : 0);
  }

  // ---------- activated (tap) abilities ----------

  getTapAbilities(perm) {
    return interpretTapAbilities(perm.card);
  }

  getRequiredTargetKindsForAbility(perm, abilityIndex) {
    const ability = this.getTapAbilities(perm)[abilityIndex];
    if (!ability) return [];
    return expandTargetKinds(ability.steps);
  }

  getMinRequiredTargetCountForAbility(perm, abilityIndex) {
    const ability = this.getTapAbilities(perm)[abilityIndex];
    if (!ability) return 0;
    return minRequiredTargetCount(ability.steps);
  }

  canActivateTapAbility(playerId, permId, abilityIndex) {
    if (this.gameOver || this.pendingRequest) return false;
    if (this.priorityPlayer.id !== playerId) return false;
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || perm.tapped) return false;
    if (isCreature(perm.card) && perm.summoningSick && !this.effectiveKeywords(perm).has('haste')) return false;
    const ability = this.getTapAbilities(perm)[abilityIndex];
    if (!ability) return false;
    if (!ability.isManaAbility && this.splitSecondActive()) return false;
    if (!this.abilityUseAllowed(perm, ability)) return false;
    if (ability.exileCreatureCost && !this.getPlayer(playerId).battlefield.some(x => x.id !== perm.id && isCreature(x.card))) return false;
    if (ability.sorcerySpeedOnly && !(playerId === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    // Arrest/Faith's Fetters-style "its activated abilities can't be
    // activated [unless they're mana abilities]" restriction.
    const restrictionKws = this.effectiveKeywords(perm);
    if (restrictionKws.has('cantActivateAbilities')) return false;
    if (restrictionKws.has('cantActivateNonManaAbilities') && !ability.isManaAbility) return false;
    if (ability.manaCost) {
      const p = this.getPlayer(playerId);
      const parsed = parseManaCost(ability.manaCost);
      // The source itself can't fund its own cost by being tapped a second
      // time — it's already being tapped as the {T} part of this same cost.
      const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped && x.id !== perm.id);
      if (!planManaPayment(untapped, parsed, 0, p.manaPool)) return false;
    }
    return true;
  }

  // targets: array aligned with getRequiredTargetKindsForAbility(perm, abilityIndex)
  // chosenColor: set when a human explicitly picked which color to add from
  // a dual/multicolor land's own "{T}: Add {W} or {U}"-style ability (see
  // play.js's getAvailableActionsForPermanent, which offers one button per
  // color instead of a single activate click whenever there's more than
  // one) — threaded into ctx.chosenColor for the mana step's own resolve to
  // prefer over its usual pickAnyColorChoice heuristic.
  activateTapAbility(playerId, permId, abilityIndex, targets = [], { silent = false, chosenColor = null } = {}) {
    this.resetTriggerChain();
    if (!this.canActivateTapAbility(playerId, permId, abilityIndex)) return { ok: false, reason: 'Cannot activate that right now.' };
    const perm = this.findPermanent(permId);
    const ability = this.getTapAbilities(perm)[abilityIndex];
    const p = this.getPlayer(playerId);
    if (ability.manaCost) {
      const parsed = parseManaCost(ability.manaCost);
      const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped && x.id !== perm.id);
      const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
      for (const land of payment.lands) land.tapped = true;
      for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    }
    perm.tapped = true;
    this.markAbilityUsed(perm, ability);
    if (ability.exileCreatureCost) {
      const fodder = p.battlefield.filter(x => x.id !== perm.id && isCreature(x.card)).sort((a, b) => (isTokenCard(b.card) - isTokenCard(a.card)) || this.effectivePower(a) - this.effectivePower(b))[0];
      if (fodder) { this.log(`${p.name} exiles ${fodder.card.name} to pay for ${perm.card.name}.`); this.applyExileEffect({ controllerId: playerId, card: perm.card, target: { type: 'permanent', id: fodder.id } }); }
    }
    if (ability.payLife) p.life -= ability.payLife;
    if (ability.sacrificeCost) this.movePermanentToGraveyard(perm, { sacrifice: true });
    this.log(`${p.name} activates ${perm.card.name}'s ability${ability.manaCost ? ` (${ability.manaCost})` : ''}${ability.payLife ? `, paying ${ability.payLife} life` : ''}${ability.sacrificeCost ? ', sacrificing it' : ''}.`);
    // Ward (mana abilities are exempt — real rules: they can't be
    // responded to and don't use the stack at all). The cost above is
    // already paid regardless, same as a countered spell still cost its
    // caster mana — Ward only stops the EFFECT from happening.
    if (!ability.isManaAbility && this.checkWardAndMaybeCounter(playerId, targets)) {
      this.checkStateBasedActions();
      if (silent) this.emit();
      else this.afterAction(playerId);
      return { ok: true };
    }
    this.resolveEffectSteps(ability.steps, targets, { controllerId: playerId, card: perm.card, sourcePerm: perm, chosenColor });
    this.checkStateBasedActions();
    if (silent) this.emit();
    else this.afterAction(playerId);
    return { ok: true };
  }

  // ---------- non-tap activated abilities (sacrifice/mana-only costs) ----------
  // A meaningfully different shape from tap abilities: no {T} means the
  // source doesn't need to be untapped, doesn't care about summoning
  // sickness, and can be activated any number of times per turn (mana/
  // sacrifice fodder permitting) rather than once.

  getNonTapAbilities(perm) {
    const abilities = interpretNonTapAbilities(perm.card);
    // Power-up costs less by the card's mana cost on the turn it entered.
    if (perm.enteredTurn === this.turnNumber) {
      return abilities.map(a => (a.powerUp ? { ...a, manaCost: subtractManaCost(a.manaCost, perm.card.manaCost) } : a));
    }
    return abilities;
  }

  getRequiredTargetKindsForNonTapAbility(perm, abilityIndex) {
    const ability = this.getNonTapAbilities(perm)[abilityIndex];
    if (!ability) return [];
    return expandTargetKinds(ability.steps);
  }

  getMinRequiredTargetCountForNonTapAbility(perm, abilityIndex) {
    const ability = this.getNonTapAbilities(perm)[abilityIndex];
    if (!ability) return 0;
    return minRequiredTargetCount(ability.steps);
  }

  // Finds which creature a "sacrifice" cost would actually consume, without
  // mutating anything — used by both the affordability check and the real
  // activation. Cheapest (lowest effective power) other creature first,
  // falling back to the source itself when the cost allows it ("a
  // creature", not "another creature") and nothing else qualifies.
  findSacrificeFodder(playerId, sourcePerm, sacrificeKind) {
    if (sacrificeKind === 'self') return sourcePerm;
    const p = this.getPlayer(playerId);
    const others = p.battlefield.filter(x => isCreature(x.card) && x.id !== sourcePerm.id);
    if (others.length > 0) return others.sort((a, b) => this.effectivePower(a) - this.effectivePower(b))[0];
    if (sacrificeKind === 'any' && isCreature(sourcePerm.card)) return sourcePerm;
    return null;
  }

  canActivateNonTapAbility(playerId, permId, abilityIndex) {
    if (this.gameOver || this.pendingRequest) return false;
    if (this.priorityPlayer.id !== playerId) return false;
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId) return false;
    const ability = this.getNonTapAbilities(perm)[abilityIndex];
    if (!ability) return false;
    if (!ability.isManaAbility && this.splitSecondActive()) return false;
    if (!this.abilityUseAllowed(perm, ability)) return false;
    if (ability.sorcerySpeedOnly && !(playerId === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    const restrictionKws = this.effectiveKeywords(perm);
    if (restrictionKws.has('cantActivateAbilities')) return false;
    if (restrictionKws.has('cantActivateNonManaAbilities') && !ability.isManaAbility) return false;
    if (ability.sacrifice && !this.findSacrificeFodder(playerId, perm, ability.sacrifice)) return false;
    if (ability.removeCounters && (perm.counters[ability.removeCounters.counterType] || 0) < ability.removeCounters.amount) return false;
    if (ability.manaCost) {
      const p = this.getPlayer(playerId);
      const parsed = parseManaCost(ability.manaCost);
      const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
      if (!planManaPayment(untapped, parsed, 0, p.manaPool)) return false;
    }
    return true;
  }

  // targets: array aligned with getRequiredTargetKindsForNonTapAbility(perm, abilityIndex)
  activateNonTapAbility(playerId, permId, abilityIndex, targets = []) {
    this.resetTriggerChain();
    if (!this.canActivateNonTapAbility(playerId, permId, abilityIndex)) return { ok: false, reason: 'Cannot activate that right now.' };
    const perm = this.findPermanent(permId);
    const ability = this.getNonTapAbilities(perm)[abilityIndex];
    const p = this.getPlayer(playerId);

    if (ability.manaCost) {
      const parsed = parseManaCost(ability.manaCost);
      const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
      const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
      for (const land of payment.lands) land.tapped = true;
      for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    }

    this.markAbilityUsed(perm, ability);
    if (ability.discardNamed) { const p0 = this.getPlayer(playerId); const twin = p0.hand.find(c => c.name === perm.card.name); if (twin) { this.log(`${p0.name} discards another ${twin.name} (grandeur).`); this.discardCard(p0, twin); } }
    let sacrificedName = null;
    if (ability.sacrifice) {
      const toSac = this.findSacrificeFodder(playerId, perm, ability.sacrifice);
      sacrificedName = toSac.card.name;
      this.movePermanentToGraveyard(toSac, { sacrifice: true });
    }

    let removedCountersDesc = null;
    if (ability.removeCounters) {
      const { amount, counterType } = ability.removeCounters;
      perm.counters[counterType] = (perm.counters[counterType] || 0) - amount;
      removedCountersDesc = `${amount} ${counterType} counter${amount > 1 ? 's' : ''}`;
    }

    this.log(`${p.name} activates ${perm.card.name}'s ability${sacrificedName ? `, sacrificing ${sacrificedName}` : ''}${removedCountersDesc ? `, removing ${removedCountersDesc}` : ''}.`);
    if (!ability.isManaAbility && this.checkWardAndMaybeCounter(playerId, targets)) {
      this.checkStateBasedActions();
      this.afterAction(playerId);
      return { ok: true };
    }
    this.resolveEffectSteps(ability.steps, targets, { controllerId: playerId, card: perm.card, sourcePerm: perm });
    this.checkStateBasedActions();
    this.afterAction(playerId);
    return { ok: true };
  }

  // ---------- planeswalker loyalty abilities ----------
  // A meaningfully different shape from every other activated ability type
  // above: the "cost" is a loyalty change (not mana, tapping, or a
  // sacrifice), only one may be activated per PLANESWALKER per turn (not
  // per player — two different planeswalkers can each use one the same
  // turn), and it's sorcery-speed only (your own main phase, empty stack) —
  // same restriction already established for graveyard abilities above.

  getLoyaltyAbilities(perm) {
    if (!isPlaneswalker(perm.card)) return [];
    return interpretLoyaltyAbilities(perm.card);
  }

  getRequiredTargetKindsForLoyaltyAbility(perm, abilityIndex) {
    const ability = this.getLoyaltyAbilities(perm)[abilityIndex];
    if (!ability) return [];
    return expandTargetKinds(ability.steps);
  }

  getMinRequiredTargetCountForLoyaltyAbility(perm, abilityIndex) {
    const ability = this.getLoyaltyAbilities(perm)[abilityIndex];
    if (!ability) return 0;
    return minRequiredTargetCount(ability.steps);
  }

  canActivateLoyaltyAbility(playerId, permId, abilityIndex) {
    if (this.gameOver || this.pendingRequest) return false;
    if (this.priorityPlayer.id !== playerId) return false;
    const sorcerySpeedOk = playerId === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0;
    if (!sorcerySpeedOk) return false;
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || !isPlaneswalker(perm.card)) return false;
    if (perm.activatedLoyaltyAbilityThisTurn) return false;
    const ability = this.getLoyaltyAbilities(perm)[abilityIndex];
    if (!ability) return false;
    // A cost that would take loyalty below 0 simply isn't legal to
    // activate — unlike mana, there's no way to "not afford" a POSITIVE
    // loyalty ability, only a negative one exceeding what's available.
    return (perm.counters.loyalty || 0) + ability.cost >= 0;
  }

  // targets: array aligned with getRequiredTargetKindsForLoyaltyAbility(perm, abilityIndex)
  activateLoyaltyAbility(playerId, permId, abilityIndex, targets = []) {
    if (!this.canActivateLoyaltyAbility(playerId, permId, abilityIndex)) return { ok: false, reason: 'Cannot activate that right now.' };
    const perm = this.findPermanent(permId);
    const ability = this.getLoyaltyAbilities(perm)[abilityIndex];
    const p = this.getPlayer(playerId);

    perm.counters.loyalty = (perm.counters.loyalty || 0) + ability.cost;
    perm.activatedLoyaltyAbilityThisTurn = true;
    const sign = ability.cost >= 0 ? '+' : '';
    this.log(`${p.name} activates ${perm.card.name}'s ${sign}${ability.cost} loyalty ability.`);
    if (this.checkWardAndMaybeCounter(playerId, targets)) {
      this.checkStateBasedActions();
      this.afterAction(playerId);
      return { ok: true };
    }
    this.resolveEffectSteps(ability.steps, targets, { controllerId: playerId, card: perm.card, sourcePerm: perm });
    this.checkStateBasedActions();
    this.afterAction(playerId);
    return { ok: true };
  }

  // ---------- graveyard-activated abilities (Reassembling Skeleton, ...) ----------
  // A meaningfully different shape from every other ability type above: the
  // source is a plain card sitting in a graveyard array, not a permanent
  // wrapper on a battlefield — so there's no perm.id to key off, just the
  // card's own instanceId.

  getGraveyardAbilities(playerId) {
    const p = this.getPlayer(playerId);
    return p.graveyard
      .map(card => ({ card, abilities: interpretGraveyardAbilities(card) }))
      .filter(entry => entry.abilities.length > 0);
  }

  canActivateGraveyardAbility(playerId, cardInstanceId) {
    if (this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    if (this.priorityPlayer.id !== playerId) return false;
    const p = this.getPlayer(playerId);
    const card = p.graveyard.find(c => c.instanceId === cardInstanceId);
    if (!card) return false;
    const ability = interpretGraveyardAbilities(card)[0];
    if (!ability) return false;
    if (ability.sorcerySpeedOnly) {
      const sorcerySpeedOk = p.id === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0;
      if (!sorcerySpeedOk) return false;
    }
    // Encore makes a token for each opponent; it needs one to exist.
    // Scavenge needs some creature to target at all.
    if (ability.scavenge && !this.players.some(pl => pl.battlefield.some(perm => isCreature(perm.card) && this.canBeTargetedBy(perm, playerId)))) return false;
    const parsed = parseManaCost(ability.manaCost);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
  }

  // targets: only Scavenge takes one (a creature) — see interpretGraveyardAbilities.
  activateGraveyardAbility(playerId, cardInstanceId, targets = []) {
    if (!this.canActivateGraveyardAbility(playerId, cardInstanceId)) return { ok: false, reason: 'Cannot activate that right now.' };
    const p = this.getPlayer(playerId);
    const idx = p.graveyard.findIndex(c => c.instanceId === cardInstanceId);
    const card = p.graveyard[idx];
    const ability = interpretGraveyardAbilities(card)[0];
    let scavengeTarget = null;
    if (ability.scavenge) {
      const t = targets[0];
      scavengeTarget = t?.type === 'permanent' ? this.findPermanent(t.id) : null;
      if (!scavengeTarget || !isCreature(scavengeTarget.card)) return { ok: false, reason: 'Scavenge needs a target creature.' };
    }
    const parsed = parseManaCost(ability.manaCost);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    p.graveyard.splice(idx, 1);
    if (ability.embalm || ability.eternalize || ability.encore) {
      // Exiling the card is part of the cost. Embalm: a white Zombie token
      // copy with no mana cost. Eternalize: the same but a 4/4 black
      // Zombie. Encore: for each opponent, a token copy with haste that
      // attacks that opponent this turn and is sacrificed at the next end
      // step.
      p.exile.push(card);
      const kind = ability.embalm ? 'embalm' : ability.eternalize ? 'eternalize' : 'encore';
      this.log(`${p.name} ${kind === 'embalm' ? 'embalms' : kind === 'eternalize' ? 'eternalizes' : 'encores'} ${card.name}.`);
      const base = { ...card, manaCost: kind === 'encore' ? card.manaCost : '', cmc: kind === 'encore' ? card.cmc : 0 };
      if (kind !== 'encore') {
        const [types, subtypes = ''] = (card.typeLine || '').split('—').map(x => x.trim());
        base.typeLine = `${types} — Zombie${subtypes ? ` ${subtypes}` : ''}`;
        base.colors = [kind === 'embalm' ? 'W' : 'B'];
      }
      const count = kind === 'encore' ? this.players.filter(pl => pl.id !== playerId && !pl.lost).length : 1;
      for (let i = 0; i < count; i++) {
        const perm = this.createTokenCopy(base, playerId, kind === 'eternalize' ? { power: 4, toughness: 4 } : null);
        if (kind === 'encore') {
          perm.tempKeywords.push('haste');
          perm.sacrificeAtEndStep = true;
        }
      }
      this.afterAction(playerId);
      return { ok: true };
    }
    if (ability.scavenge) {
      // Exiling the card is part of the cost, so it's gone even if Ward
      // then counters the ability.
      p.exile.push(card);
      const amount = parseInt(card.power, 10) || 0;
      this.log(`${p.name} scavenges ${card.name}, targeting ${scavengeTarget.card.name}.`);
      if (!this.checkWardAndMaybeCounter(playerId, targets) && amount > 0) {
        this.applyCounterAdditionEffect({ controllerId: playerId, card, target: { type: 'permanent', id: scavengeTarget.id } }, amount, '+1/+1');
      }
      this.checkStateBasedActions();
      this.afterAction(playerId);
      return { ok: true };
    }
    const perm = makePermanent(card, playerId);
    perm.enteredFromGraveyardOf = playerId;
    if (ability.tapped) perm.tapped = true;
    if (ability.unearth) {
      perm.unearthed = true;
      perm.tempKeywords.push('haste');
    }
    p.battlefield.push(perm);
    this.log(`${p.name} ${ability.unearth ? 'unearths' : 'returns'} ${card.name} from their graveyard to the battlefield${ability.tapped ? ' tapped' : ''}.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
    this.afterAction(playerId);
    return { ok: true };
  }

  // ---------- cycling (an ability activated from the HAND) ----------
  // Instant speed: usable any time the player has priority. The card is
  // discarded as part of the cost; "when you cycle this card" triggers
  // resolve before the draw/search, matching real stack order.

  getCyclingAbility(card) { return getCyclingAbility(card); }

  canCycle(playerId, instanceId) {
    if (this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    if (this.priorityPlayer.id !== playerId) return false;
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    if (!card) return false;
    const cycling = getCyclingAbility(card);
    if (!cycling) return false;
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    return !!planManaPayment(untapped, parseManaCost(cycling.manaCost), 0, p.manaPool);
  }

  cycle(playerId, instanceId) {
    if (!this.canCycle(playerId, instanceId)) return { ok: false, reason: 'Cannot cycle that right now.' };
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    const card = p.hand[idx];
    const cycling = getCyclingAbility(card);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parseManaCost(cycling.manaCost), 0, p.manaPool);
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    this.log(`${p.name} cycles ${card.name} (${cycling.manaCost}).`);
    this.discardCard(p, card);
    const ctx = { controllerId: playerId, card };
    // A "when you cycle" trigger that needs a target isn't modeled — there's
    // no hand-zone source to drive a targeting prompt from — so only
    // untargeted ones (Krosan Tusker's land search, the Decrees' sweepers)
    // resolve; a targeted one is logged rather than silently skipped.
    const triggerSteps = interpretCycleTriggers(card);
    if (triggerSteps.length > 0) {
      if (expandTargetKinds(triggerSteps).length === 0) this.resolveEffectSteps(triggerSteps, [], ctx);
      else this.log(`${card.name}'s targeted cycle trigger isn't modeled in detail yet — it resolves with no game effect.`);
    }
    if (cycling.searchType) this.applyTutorEffect(ctx, cycling.searchType);
    else this.applyDrawEffect(ctx, 1);
    this.checkStateBasedActions();
    this.afterAction(playerId);
    return { ok: true };
  }

  // Casts `card` outside the normal click-to-cast flow — Suspend's free
  // cast when the last time counter comes off, Miracle's cast on draw —
  // with targets chosen automatically by the same picker the AI uses (it
  // knows a "target player draws" spell should target its caster). Reuses
  // castSpell entirely by putting the card in hand first if it isn't
  // already there; on failure that temporary hand copy is removed again
  // and the caller decides where the card goes.
  castFromOutsideHand(playerId, card, castOpts = {}) {
    const { onFail = null, ...opts } = castOpts;
    castOpts = opts;
    const p = this.getPlayer(playerId);
    const wasInHand = p.hand.includes(card);
    if (!wasInHand) p.hand.push(card);
    const kinds = this.getRequiredTargetKinds(card);
    const targets = pickTargetsForKinds(this, card, playerId, kinds).filter(Boolean);
    // A human chooses the targets themselves (the same prompt an ETB
    // trigger uses); the cast happens once they're picked. If it then
    // can't be cast, onFail puts the card where it belongs.
    if (!p.isAI && kinds.length && this.getMinRequiredTargetCount(card) <= targets.length && !this.pendingRequest) {
      this._pendingETB = { onComplete: (chosen) => {
        const r = this.castSpell(playerId, card.instanceId, chosen, castOpts.xValue || 0, null, false, { bypassTiming: true, fromZone: wasInHand ? 'hand' : 'other', ...castOpts });
        if (!r.ok && !wasInHand) {
          const i = p.hand.findIndex(c => c.instanceId === card.instanceId);
          if (i !== -1) p.hand.splice(i, 1);
          this.log(`${card.name} can't be cast: ${r.reason}`);
          onFail?.();
        }
      } };
      this.pendingRequest = { type: 'etbTarget', playerId, cardName: card.name, kinds, collected: [], sourcePermId: null };
      this.emit();
      return true;
    }
    let result = { ok: false };
    if (this.getMinRequiredTargetCount(card) <= targets.length) {
      result = this.castSpell(playerId, card.instanceId, targets, castOpts.xValue || 0, null, false, { bypassTiming: true, fromZone: wasInHand ? 'hand' : 'other', ...castOpts });
    }
    if (!result.ok && !wasInHand) {
      const i = p.hand.findIndex(c => c.instanceId === card.instanceId);
      if (i !== -1) p.hand.splice(i, 1);
    }
    return result.ok;
  }


  // ---------- alternative casting costs ----------
  // Ways to cast `card` from hand for an alternative cost RIGHT NOW (the
  // condition met and the cost affordable): [{ kind, manaCost, label,
  // emergeVictimId? }]. Spectacle needs an opponent to have lost life this
  // turn; Surge, another spell cast this turn; Prowl, a creature sharing a
  // type to have dealt combat damage to a player; Freerunning, an Assassin
  // or commander to have; Emerge sacrifices a creature and reduces the cost
  // by its mana value (one option per creature you could sacrifice).
  getCastOptions(playerId, card) {
    const p = this.getPlayer(playerId);
    const opp = this.opponentOf(playerId);
    const subtypes = ((card.typeLine || '').toLowerCase().split('—')[1] || '').split(/\s+/).filter(Boolean);
    const options = [];
    for (const alt of getAlternativeCosts(card)) {
      if (alt.kind === 'spectacle' && !(opp.life < (opp.lifeAtTurnStart ?? opp.life) || opp.damageTakenThisTurn > 0)) continue;
      if (alt.kind === 'surge' && !(p.spellsCastThisTurn > 0)) continue;
      if (alt.kind === 'prowl' && !subtypes.some(s => p.combatDamagerTypesThisTurn.includes(s))) continue;
      if (alt.kind === 'freerunning' && !p.combatDamagerTypesThisTurn.some(s => s === 'assassin' || s === 'commander')) continue;
      const label = `${alt.kind[0].toUpperCase()}${alt.kind.slice(1)} ${card.name} (${alt.manaCost}${alt.power ? `, ${alt.power}/${alt.toughness}` : ''})`;
      const reduction = this.getCastCostReduction(card, playerId);
      if (alt.kind === 'emerge') {
        const victims = p.battlefield.filter(x => isCreature(x.card)).sort((a, b) => (b.card.cmc || 0) - (a.card.cmc || 0)).slice(0, 4);
        for (const v of victims) {
          const parsed = parseManaCost(alt.manaCost);
          parsed.generic = Math.max(0, parsed.generic - reduction - (v.card.cmc || 0));
          if (this.planSpellPayment(playerId, card, parsed, 0)) options.push({ ...alt, emergeVictimId: v.id, label: `Emerge ${card.name}, sacrificing ${v.card.name}` });
        }
        continue;
      }
      // Web-slinging: also return a tapped creature you control to hand.
      // Sneak: only during the declare blockers step, returning an
      // unblocked attacker (the creature cast this way enters tapped and
      // attacking in its place).
      if (alt.kind === 'web-slinging' || alt.kind === 'sneak') {
        const pool = alt.kind === 'web-slinging'
          ? p.battlefield.filter(x => isCreature(x.card) && x.tapped)
          : (this.step === 'declareBlockers' && this.active.id === playerId && !this.pendingRequest ? p.battlefield.filter(x => x.attacking && x.blockedBy.length === 0) : []);
        const back = pool.sort((a, b) => (a.card.cmc || 0) - (b.card.cmc || 0))[0];
        if (!back) continue;
        const parsedW = parseManaCost(alt.manaCost);
        parsedW.generic = Math.max(0, parsedW.generic - reduction);
        if (this.planSpellPayment(playerId, card, parsedW, 0)) options.push({ ...alt, returnId: back.id, label: `${alt.kind === 'sneak' ? 'Sneak' : 'Web-sling'} ${card.name} (${alt.manaCost}, returning ${back.card.name})` });
        continue;
      }
      if (alt.kind === 'offering') {
        // One option per creature of the type to sacrifice; costs the
        // difference in mana costs, at instant speed.
        for (const v of p.battlefield.filter(x => isCreature(x.card) && hasTypeWord(x.card, alt.offeringType)).slice(0, 4)) {
          const cost = subtractManaCost(card.manaCost, v.card.manaCost);
          const parsedO = parseManaCost(cost);
          parsedO.generic = Math.max(0, parsedO.generic - reduction);
          if (this.priorityPlayer.id === playerId && !this.pendingRequest && this.planSpellPayment(playerId, { ...card, manaCost: cost || '{0}' }, parsedO, 0)) options.push({ ...alt, manaCost: cost || '{0}', emergeVictimId: v.id, offering: true, label: `Offering: sacrifice ${v.card.name} to cast ${card.name} (${cost || '{0}'})` });
        }
        continue;
      }
      if (alt.kind === 'mutate') {
        // One option per non-Human creature you own and control.
        const parsedM = parseManaCost(alt.manaCost);
        parsedM.generic = Math.max(0, parsedM.generic - reduction);
        if (!this.planSpellPayment(playerId, card, parsedM, 0)) continue;
        const hosts = p.battlefield.filter(x => isCreature(x.card) && x.ownerId === playerId && !x.faceDown && !/\bhuman\b/i.test(x.card.typeLine || '') && this.canBeTargetedBy(x, playerId, card))
          .sort((a, b) => this.effectivePower(b) - this.effectivePower(a)).slice(0, 5);
        for (const h of hosts) options.push({ ...alt, mutateTargetId: h.id, label: `Mutate ${card.name} onto ${h.card.name} (${alt.manaCost})` });
        continue;
      }
      const parsed = parseManaCost(alt.manaCost);
      parsed.generic = Math.max(0, parsed.generic - reduction);
      if (this.planSpellPayment(playerId, card, parsed, 0)) options.push({ ...alt, label });
    }
    return options;
  }

  // At the beginning of the end step: a dashed creature returns to its
  // owner's hand, a blitzed one is sacrificed. (Both are only ever cast at
  // sorcery speed, so "the next end step" is always this turn's.)
  endStepAltCostCleanup() {
    for (const pl of this.players) {
      // Encore tokens are sacrificed at the next end step.
      for (const perm of pl.battlefield.filter(x => x.sacrificeAtEndStep)) {
        this.log(`${perm.card.name} is sacrificed at the end step (encore).`);
        this.movePermanentToGraveyard(perm, { sacrifice: true });
      }
      // Warp: exiled at the next end step, then castable from exile on a
      // later turn (for its normal cost).
      for (const perm of pl.battlefield.filter(x => x.altCostKind === 'warp')) {
        pl.battlefield = pl.battlefield.filter(x => x.id !== perm.id);
        this.detachFromLeavingBattlefield(perm);
        this.triggerLeavesBattlefield(perm);
        if (isTokenCard(perm.card) || this.redirectCommanderToZone(perm)) continue;
        this.getPlayer(perm.ownerId).exiledPlayable.push({ id: uid('exile'), card: perm.card, remainingOwnTurns: Infinity, kind: 'warp', notOnTurn: this.turnNumber });
        this.log(`${perm.card.name} is exiled (warp) — it can be cast from exile on a later turn.`);
      }
      for (const perm of pl.battlefield.filter(x => x.altCostKind === 'dash' || x.altCostKind === 'blitz')) {
        if (perm.altCostKind === 'dash') {
          pl.battlefield = pl.battlefield.filter(x => x.id !== perm.id);
          this.detachFromLeavingBattlefield(perm);
          this.triggerLeavesBattlefield(perm);
          if (this.redirectCommanderToZone(perm)) continue;
          this.getPlayer(perm.ownerId).hand.push(perm.card);
          this.log(`${perm.card.name} returns to its owner's hand (dash).`);
        } else {
          this.log(`${perm.card.name} is sacrificed at the end step (blitz).`);
          this.movePermanentToGraveyard(perm, { sacrifice: true });
        }
      }
    }
  }

  // "Return all creature cards with power N or less from your graveyard to
  // your hand / the battlefield".
  applyMassReturnFromGraveyard(ctx, stat, n, toHand) {
    const p = this.getPlayer(ctx.controllerId);
    const picks = p.graveyard.filter(c => isCreature(c) && (stat === 'power' ? (parseInt(c.power, 10) || 0) : (c.cmc || 0)) <= n);
    for (const c of picks) {
      p.graveyard.splice(p.graveyard.indexOf(c), 1);
      if (toHand) p.hand.push(c);
      else { const perm = makePermanent(c, p.id); p.battlefield.push(perm); this.triggerETB(perm); }
    }
    if (picks.length) this.log(`${ctx.card.name} returns ${picks.map(c => c.name).join(', ')} to ${toHand ? 'hand' : 'the battlefield'}.`);
    this.checkStateBasedActions();
  }

  // Level up {cost}: put a level counter on it (sorcery speed).
  canLevelUp(playerId, permId) {
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    const lu = getLevelUp(perm._baseCard || perm.card);
    if (!lu || !(this.active.id === playerId && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    return this.payableNow(playerId, lu.cost);
  }

  levelUp(playerId, permId) {
    if (!this.canLevelUp(playerId, permId)) return { ok: false, reason: "Can't level up right now." };
    const perm = this.findPermanent(permId);
    this.payNow(playerId, getLevelUp(perm._baseCard || perm.card).cost);
    perm.counters.level = (perm.counters.level || 0) + 1;
    this.refreshCardState(perm);
    this.log(`${perm.card.name} levels up (level ${perm.counters.level}).`);
    this.afterAction(playerId);
    return { ok: true };
  }

  getLevelUp(card) { return getLevelUp(card); }

  // Haunt: exile `card` haunting a creature (the AI's pick: the opponent's
  // best creature, so its death soon pays off), remembered on that creature.
  hauntCreature(owner, card, controllerId, removeFromZone) {
    const opp = this.opponentOf(controllerId);
    const pool = [...opp.battlefield, ...this.getPlayer(controllerId).battlefield].filter(x => isCreature(x.card));
    const target = pool.sort((a, b) => (b.controllerId !== controllerId) - (a.controllerId !== controllerId) || this.effectivePower(b) - this.effectivePower(a))[0];
    if (!target) return false;
    removeFromZone();
    owner.exile.push(card);
    (target.hauntedBy ||= []).push({ card, controllerId });
    this.log(`${card.name} haunts ${target.card.name}.`);
    return true;
  }

  runHauntEffect(card, controllerId) {
    const steps = interpretHauntTriggers(card);
    if (!steps.length) return;
    const targets = pickTargetsForKinds(this, card, controllerId, expandTargetKinds(steps)).filter(Boolean);
    this.log(`The creature ${card.name} haunted died.`);
    this.resolveEffectSteps(steps, targets, { controllerId, card });
  }

  // Splice onto Arcane: as you cast an Arcane spell, reveal Splice cards
  // from your hand and pay their splice costs to add their effects. The AI
  // splices whatever it can afford.
  offerSplices(playerId, item) {
    const p = this.getPlayer(playerId);
    for (const sc of p.hand.filter(c => c !== item.card && getSpliceCost(c))) {
      const cost = getSpliceCost(sc);
      if (!this.payableNow(playerId, cost)) continue;
      this.requestChoice(playerId, `Splice ${sc.name} onto ${item.card.name} for ${cost}?`, [
        { label: `Splice (${cost})`, resolve: () => {
          if (!this.stack.includes(item) || !this.payNow(playerId, cost)) return;
          (item.spliced ||= []).push(sc);
          this.log(`${p.name} splices ${sc.name} onto ${item.card.name}.`);
        } },
        { label: "Don't splice", resolve: () => {} },
      ], 0);
    }
  }

  // ---------- Batch 13: Partner, Companion ----------
  // Companion: once per game, pay {3} at sorcery speed to put your companion
  // (from outside the game) into your hand.
  canFetchCompanion(playerId) {
    const p = this.getPlayer(playerId);
    if (!p.companion || p.companionUsed || this.gameOver || this.pendingRequest) return false;
    if (!(this.active.id === playerId && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    return this.payableNow(playerId, '{3}');
  }

  fetchCompanion(playerId) {
    if (!this.canFetchCompanion(playerId)) return { ok: false, reason: "Can't put your companion into your hand right now." };
    const p = this.getPlayer(playerId);
    this.payNow(playerId, '{3}');
    p.companionUsed = true;
    p.hand.push({ ...p.companion, instanceId: p.companion.instanceId || uid('companion') });
    this.log(`${p.name} pays {3} to put their companion, ${p.companion.name}, into their hand.`);
    this.afterAction(playerId);
    return { ok: true };
  }

  // The conditional static bonuses that currently apply to `perm` (from its
  // own text, or anthem-shaped ones from any permanent). Conditions that
  // read power (Coven, Formidable) would re-enter here, so nested calls
  // see no conditional bonuses.
  // How many conditional statics a card has that this engine understands.
  static conditionalStaticCount(card) { return conditionalStatics(card).length; }

  conditionalBonuses(perm) {
    if (this._inConditionalStatics) return [];
    this._inConditionalStatics = true;
    try {
      const out = [];
      for (const pl of this.players) for (const source of pl.battlefield) {
        for (const cs of conditionalStatics(source.card)) {
          const ctx = { controllerId: source.controllerId, sourcePerm: source, card: source.card };
          if (cs.self && source.id === perm.id && isCreature(perm.card)) { if (cs.test(this, ctx)) out.push(cs.self); }
          else if (cs.anthem && isCreature(perm.card) && anthemAppliesTo(cs.anthem, source, perm) && cs.test(this, ctx)) out.push({ power: cs.anthem.power, toughness: cs.anthem.toughness, grant: cs.anthem.grantText });
        }
      }
      return out;
    } finally {
      this._inConditionalStatics = false;
    }
  }

  // ---------- Batch 12: double-faced, split, and adventure cards ----------
  faceCard(card, idx) { return faceCard(card, idx); }

  // Other ways to cast a hand card by one of its faces: an Adventure, a
  // modal double-faced card's back (nonland) face, a split card's right
  // half (or both, with Fuse), or a More Than Meets the Eye card converted.
  // [{ kind, label, card }] — only those castable right now.
  faceOptions(playerId, card) {
    if (!card.faces?.[1]) return [];
    const out = [];
    const back = card.faces[1];
    const add = (kind, label, clone) => { if (clone && this.canCastSpell(playerId, clone) && this.affordability(playerId, clone)) out.push({ kind, label, card: clone }); };
    if (card.layout === 'adventure') add('adventure', `Adventure: ${back.name} (${back.manaCost})`, faceCard(card, 1));
    if (card.layout === 'modal_dfc' && !/\bland\b/i.test(back.typeLine)) add('backFace', `Cast ${back.name} (${back.manaCost})`, faceCard(card, 1));
    if (card.layout === 'split' && !/^aftermath\b/im.test(back.oracleText)) {
      add('splitRight', `Cast ${back.name} (${back.manaCost})`, faceCard(card, 1));
      if (/^fuse\b/im.test(card.faces[0].oracleText) && /^fuse\b/im.test(back.oracleText)) add('fuse', `Fuse: cast both halves (${card.faces[0].manaCost}${back.manaCost})`, fusedCard(card));
    }
    const convert = getConvertCost(card);
    if (convert) add('convert', `Cast ${back.name} converted (${convert})`, { ...faceCard(card, 1), manaCost: convert, cmc: totalCmc(parseManaCost(convert)) });
    return out;
  }

  faceForCast(card, kind) {
    return this.faceOptions(this.priorityPlayer.id, card).find(o => o.kind === kind)?.card
      || (kind === 'fuse' ? fusedCard(card) : faceCard(card, 1));
  }

  // Cast a hand card by one of its faces: the face (with the card's own
  // instanceId) temporarily stands in for it in hand, then castSpell runs
  // as usual. The real card goes wherever the face would.
  castFace(playerId, instanceId, kind, targets = [], xValue = 0, modeIndexes = null, kicked = false, opts = {}) {
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    if (idx === -1) return { ok: false, reason: 'Card not in hand.' };
    const real = p.hand[idx];
    const option = this.faceOptions(playerId, real).find(o => o.kind === kind);
    if (!option) return { ok: false, reason: "Can't cast that face right now." };
    p.hand.splice(idx, 1, option.card);
    const result = this.castSpell(playerId, instanceId, targets, xValue, modeIndexes, kicked, opts);
    if (!result.ok) {
      const i = p.hand.indexOf(option.card);
      if (i !== -1) p.hand.splice(i, 1, real);
      return result;
    }
    const item = this.stack.find(x => x.card === option.card);
    if (item) item.faceKind = kind;
    return result;
  }

  // A modal double-faced card's land face (either side) played as a land.
  landFaces(card) {
    if (card.layout !== 'modal_dfc' || !card.faces) return [];
    return card.faces.map((f, i) => ({ f, i })).filter(({ f }) => /\bland\b/i.test(f.typeLine)).map(({ f, i }) => ({ index: i, name: f.name }));
  }

  playLandFace(playerId, instanceId, faceIndex) {
    if (!this.canPlayLand(playerId)) return false;
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    if (idx === -1) return false;
    const real = p.hand[idx];
    const clone = faceIndex === 0 ? null : faceCard(real, faceIndex);
    if (clone) p.hand.splice(idx, 1, clone);
    const ok = this.playLand(playerId, instanceId);
    if (!ok && clone) { const i = p.hand.indexOf(clone); if (i !== -1) p.hand.splice(i, 1, real); }
    return ok;
  }

  // Transform / convert: flip to the other face (the printed card is kept
  // in perm._dfcCard for whatever zone it goes to later).
  transformPermanent(perm) {
    if (!perm || !this.findPermanent(perm.id)) return;
    if (perm._baseCard) { perm.card = perm._baseCard; delete perm._baseCard; }
    const original = perm._dfcCard || perm.card;
    if (!original.faces?.[1] || original.layout === 'adventure' || original.layout === 'split') return;
    const toBack = (perm.card.faceIndex ?? 0) === 0;
    if (toBack) { perm._dfcCard = original; perm.card = faceCard(original, 1); }
    else { perm.card = original; delete perm._dfcCard; }
    this.log(`${original.faces[toBack ? 0 : 1].name} transforms into ${perm.card.name}.`);
    this.refreshCardState(perm);
    this.checkStateBasedActions();
  }

  // "Exile this Saga, then return it to the battlefield transformed"
  // (Fable of the Mirror-Breaker): a new object enters as its back face.
  exileAndReturnTransformed(perm) {
    if (!perm || !this.findPermanent(perm.id)) return;
    const p = this.getPlayer(perm.controllerId);
    p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
    this.detachFromLeavingBattlefield(perm);
    this.triggerLeavesBattlefield(perm);
    const original = perm.card;
    if (!original.faces?.[1]) { this.getPlayer(perm.ownerId).exile.push(original); return; }
    const back = makePermanent(faceCard(original, 1), perm.ownerId);
    back._dfcCard = original;
    this.getPlayer(perm.ownerId).battlefield.push(back);
    this.log(`${original.faces[0].name} returns transformed as ${back.card.name}.`);
    this.checkStateBasedActions();
    this.triggerETB(back);
  }

  // Day / night (Daybound / Nightbound). It becomes day when a daybound
  // permanent appears and it's neither; each turn it flips to night if the
  // previous turn's active player cast no spells, or back to day if a
  // player cast two or more. Daybound faces show by day, nightbound by night.
  setDayNight(value) {
    if (this.dayNight === value) return;
    this.dayNight = value;
    this.log(`It becomes ${value}.`);
    this.syncDayNightFaces();
  }

  syncDayNightFaces() {
    for (const pl of this.players) for (const perm of [...pl.battlefield]) {
      const text = (perm.card.oracleText || '').replace(/\([^()]*\)/g, '');
      if ((this.dayNight === 'night' && /^daybound\b/im.test(text)) || (this.dayNight === 'day' && /^nightbound\b/im.test(text))) this.transformPermanent(perm);
    }
  }

  advanceDayNight(prevActive) {
    this.spellsCastLastTurn = this.totalSpellsThisTurn();
    this.maxSpellsByOnePlayerLastTurn = Math.max(0, ...this.players.map(p => p.spellsCastThisTurn || 0));
    if (this.dayNight === 'day' && prevActive && (prevActive.spellsCastThisTurn || 0) === 0) this.setDayNight('night');
    else if (this.dayNight === 'night' && this.maxSpellsByOnePlayerLastTurn >= 2) this.setDayNight('day');
  }

  // Craft with [material] {cost}: exile this and a matching permanent you
  // control or card in your graveyard; return it transformed. Sorcery
  // speed. The AI uses its least valuable material.
  craftMaterial(playerId, perm) {
    const info = getCraft(perm._dfcCard || perm.card);
    if (!info) return null;
    const word = info.material.replace(/^(?:one or more|two or more|three or more|an?|other)\s+/, '').replace(/s$/, '');
    const matches = (c) => word === 'artifact' ? isArtifact(c) : word === 'creature' ? isCreature(c) : word === 'land' ? isLand(c) : hasTypeWord(c, word);
    const p = this.getPlayer(playerId);
    const fromBf = p.battlefield.filter(x => x.id !== perm.id && matches(x.card)).sort((a, b) => (isTokenCard(b.card) - isTokenCard(a.card)) || (a.card.cmc || 0) - (b.card.cmc || 0))[0];
    const fromGy = p.graveyard.filter(matches).sort((a, b) => (a.cmc || 0) - (b.cmc || 0))[0];
    return fromGy ? { card: fromGy } : fromBf ? { perm: fromBf } : null;
  }

  canCraft(playerId, permId) {
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    const info = getCraft(perm._dfcCard || perm.card);
    if (!info || !(perm._dfcCard || perm.card).faces?.[1]) return false;
    if (!(this.active.id === playerId && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    return !!this.craftMaterial(playerId, perm) && this.payableNow(playerId, info.manaCost);
  }

  craft(playerId, permId) {
    if (!this.canCraft(playerId, permId)) return { ok: false, reason: "Can't craft right now." };
    const perm = this.findPermanent(permId);
    const p = this.getPlayer(playerId);
    const info = getCraft(perm._dfcCard || perm.card);
    const material = this.craftMaterial(playerId, perm);
    this.payNow(playerId, info.manaCost);
    if (material.card) { p.graveyard.splice(p.graveyard.indexOf(material.card), 1); p.exile.push(material.card); }
    else this.applyExileEffect({ controllerId: playerId, card: perm.card, target: { type: 'permanent', id: material.perm.id } });
    this.log(`${p.name} crafts ${perm.card.name} with ${(material.card || material.perm.card).name}.`);
    this.exileAndReturnTransformed(perm);
    this.afterAction(playerId);
    return { ok: true };
  }

  getCraft(card) { return getCraft(card); }

  // ---------- Batch 11: permanents that become (or stop being) creatures ----------
  // A permanent's current card is derived from its original (perm._baseCard)
  // plus its state: crewed Vehicles and permanents under Living Metal (on
  // their controller's turn), Spacecraft past their station threshold, and
  // awakened lands are creatures; an attached Reconfigure Equipment, an
  // Impending permanent with time counters, and a God short on devotion
  // aren't. Station also unlocks its "N+ | ..." lines. Called whenever one
  // of those states may have changed.
  tracksCardState(perm) {
    if (perm.crewed || perm.awakened || perm.impending || perm._baseCard || perm.bestowed) return true;
    const base = perm.card;
    let tracked = CARD_STATE_MEMO.get(base);
    if (tracked === undefined) {
      tracked = !!(getReconfigureCost(base) || hasLivingMetal(base) || hasStation(base) || getDevotionRequirement(base) || this.keywordAmount(base, 'crew') || getLevelUp(base) || getCaseSolve(base));
      CARD_STATE_MEMO.set(base, tracked);
    }
    return tracked;
  }

  refreshCardState(perm) {
    if (!this.tracksCardState(perm)) return;
    const base = perm._baseCard || perm.card;
    let text = base.oracleText || '';
    let creature = null;
    const station = hasStation(base) ? getStationInfo(base) : null;
    if (station) {
      const charge = perm.counters.charge || 0;
      text = text.split('\n').map(l => { const m = l.match(/^(\d+)\+ \| (.+)$/); return m ? (charge >= parseInt(m[1], 10) ? m[2] : null) : l; }).filter(l => l !== null).join('\n');
      if (station.creatureAt != null && charge >= station.creatureAt) creature = true;
    }
    if (perm.crewed) creature = true;
    if (hasLivingMetal(base) && this.active?.id === perm.controllerId) creature = true;
    const devotion = getDevotionRequirement(base);
    if (devotion && this.devotion(perm.controllerId, devotion.colors) < devotion.need) creature = false;
    if (getReconfigureCost(base) && perm.attachedTo) creature = false;
    let bestowAura = false;
    if (perm.bestowed && perm.attachedTo) { creature = false; bestowAura = true; }
    if (perm.impending && (perm.counters.time || 0) > 0) creature = false;
    // Cases: "Solved — ABILITY" only once solved; the "To solve" line itself
    // is never an ability.
    if (getCaseSolve(base)) {
      text = text.split('\n').filter(l => !/^to solve\s*—/i.test(l)).map(l => { const sm = l.match(/^solved\s*—\s*(.+)$/i); return sm ? (perm.solved ? sm[1] : null) : l; }).filter(l => l !== null).join('\n');
    }
    let card = { ...base, oracleText: text };
    // Level Up: the level-counter tier in effect sets stats and abilities.
    const leveler = getLevelUp(base);
    if (leveler) {
      const level = perm.counters.level || 0;
      const tier = leveler.tiers.find(t => level >= t.min && level <= t.max);
      card.oracleText = tier ? `${leveler.base}\n${tier.text}` : leveler.base;
      card.keywords = [...new Set([...extractKnownKeywords(card.oracleText.toLowerCase())])];
      if (tier?.power != null) { card.power = tier.power; card.toughness = tier.toughness; }
    }
    if (station) {
      // Keywords on station lines count only once unlocked.
      const charge = perm.counters.charge || 0;
      const locked = new Set(station.tiers.filter(t => charge < t.n).flatMap(t => extractKnownKeywords(t.text.toLowerCase())));
      const unlocked = station.tiers.filter(t => charge >= t.n).flatMap(t => extractKnownKeywords(t.text.toLowerCase()));
      card.keywords = [...new Set([...(base.keywords || []).filter(k => !locked.has(k.toLowerCase())), ...unlocked])];
    }
    if (perm.awakened) {
      card = { ...card, typeLine: withCreatureType(base.typeLine, true, 'Elemental'), power: '0', toughness: '0', keywords: [...new Set([...(base.keywords || []), 'haste'])] };
    } else if (bestowAura) {
      card = { ...card, typeLine: 'Enchantment — Aura' };
    } else if (creature !== null && creature !== isCreature(base)) {
      card = { ...card, typeLine: withCreatureType(base.typeLine, creature) };
    } else if (text === (base.oracleText || '') && !station && !leveler && !getCaseSolve(base)) {
      card = base;
    }
    if (card === base) { if (perm._baseCard) { perm.card = base; delete perm._baseCard; } return; }
    perm._baseCard = base;
    perm.card = card;
  }

  refreshAllCardStates() {
    for (const pl of this.players) for (const perm of pl.battlefield) this.refreshCardState(perm);
  }

  // Devotion: colored mana symbols among the mana costs of your permanents.
  devotion(playerId, colors) {
    let n = 0;
    for (const perm of this.getPlayer(playerId).battlefield) {
      const parsed = parseManaCost((perm._baseCard || perm.card).manaCost || '');
      for (const c of colors) n += parsed.colors[c] || 0;
      for (const h of parsed.hybrid) if (h.some(c => colors.includes(c))) n += 1;
    }
    return n;
  }

  // Crew N / Saddle N: tap other untapped creatures with total power N or
  // more (summoning-sick ones are fine). The AI and the default pick use
  // the weakest set that's enough.
  crewPick(playerId, perm, need) {
    const pool = this.getPlayer(playerId).battlefield.filter(x => x.id !== perm.id && isCreature(x.card) && !x.tapped && this.effectivePower(x) > 0)
      .sort((a, b) => (b.summoningSick - a.summoningSick) || (this.effectivePower(a) - this.effectivePower(b)));
    const crew = [];
    let total = 0;
    for (const x of pool) { if (total >= need) break; crew.push(x); total += this.effectivePower(x); }
    return total >= need ? crew : null;
  }

  canCrew(playerId, permId) {
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || perm.crewed || this.gameOver || this.pendingRequest || this.priorityPlayer.id !== playerId || this.splitSecondActive()) return false;
    const n = this.keywordAmount(perm._baseCard || perm.card, 'crew');
    return n > 0 && !!this.crewPick(playerId, perm, n);
  }

  crew(playerId, permId) {
    if (!this.canCrew(playerId, permId)) return { ok: false, reason: "Can't crew that right now." };
    const perm = this.findPermanent(permId);
    const crew = this.crewPick(playerId, perm, this.keywordAmount(perm._baseCard || perm.card, 'crew'));
    for (const x of crew) x.tapped = true;
    perm.crewed = true;
    this.refreshCardState(perm);
    this.log(`${this.getPlayer(playerId).name} crews ${perm.card.name} with ${crew.map(x => x.card.name).join(', ')}.`);
    this.afterAction(playerId);
    return { ok: true };
  }

  canSaddle(playerId, permId) {
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || perm.saddled || this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    if (!(this.active.id === playerId && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    const n = this.keywordAmount(perm.card, 'saddle');
    return n > 0 && !!this.crewPick(playerId, perm, n);
  }

  saddle(playerId, permId) {
    if (!this.canSaddle(playerId, permId)) return { ok: false, reason: "Can't saddle that right now." };
    const perm = this.findPermanent(permId);
    const crew = this.crewPick(playerId, perm, this.keywordAmount(perm.card, 'saddle'));
    for (const x of crew) x.tapped = true;
    perm.saddled = true;
    this.log(`${this.getPlayer(playerId).name} saddles ${perm.card.name} with ${crew.map(x => x.card.name).join(', ')}.`);
    this.afterAction(playerId);
    return { ok: true };
  }

  // Station: tap another creature you control to put charge counters equal
  // to its power on this (sorcery speed). The AI stations with its
  // strongest untapped creature that isn't going to attack.
  canStation(playerId, permId) {
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || !hasStation(perm._baseCard || perm.card) || this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    if (!(this.active.id === playerId && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    return this.getPlayer(playerId).battlefield.some(x => x.id !== perm.id && isCreature(x.card) && !x.tapped && this.effectivePower(x) > 0);
  }

  station(playerId, permId, creatureId = null) {
    if (!this.canStation(playerId, permId)) return { ok: false, reason: "Can't station right now." };
    const perm = this.findPermanent(permId);
    const pool = this.getPlayer(playerId).battlefield.filter(x => x.id !== perm.id && isCreature(x.card) && !x.tapped && this.effectivePower(x) > 0);
    const helper = pool.find(x => x.id === creatureId) || pool.sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
    helper.tapped = true;
    const n = this.effectivePower(helper);
    perm.counters.charge = (perm.counters.charge || 0) + n;
    this.refreshCardState(perm);
    this.log(`${this.getPlayer(playerId).name} stations ${perm.card.name} with ${helper.card.name} (${perm.counters.charge} charge).`);
    this.afterAction(playerId);
    return { ok: true };
  }

  // Reconfigure {cost}: attach to a creature you control (the AI's best),
  // or unattach; sorcery speed. While attached it isn't a creature.
  canReconfigure(playerId, permId) {
    const perm = this.findPermanent(permId);
    if (!perm || perm.controllerId !== playerId || this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    const cost = getReconfigureCost(perm._baseCard || perm.card);
    if (!cost || !(this.active.id === playerId && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    if (!perm.attachedTo && !this.getPlayer(playerId).battlefield.some(x => x.id !== perm.id && isCreature(x.card))) return false;
    return this.payableNow(playerId, cost);
  }

  reconfigure(playerId, permId, targetId = null) {
    if (!this.canReconfigure(playerId, permId)) return { ok: false, reason: "Can't reconfigure right now." };
    const perm = this.findPermanent(permId);
    this.payNow(playerId, getReconfigureCost(perm._baseCard || perm.card));
    if (perm.attachedTo) {
      perm.attachedTo = null;
      this.log(`${perm.card.name} unattaches and is a creature again.`);
    } else {
      const pool = this.getPlayer(playerId).battlefield.filter(x => x.id !== perm.id && isCreature(x.card));
      const host = pool.find(x => x.id === targetId) || pool.sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
      perm.attachedTo = host.id;
      perm.attacking = false; perm.blocking = null;
      this.log(`${perm.card.name} reconfigures onto ${host.card.name}.`);
    }
    this.refreshCardState(perm);
    this.afterAction(playerId);
    return { ok: true };
  }

  // Awaken: the land you control that gets the counters and becomes a 0/0
  // Elemental creature with haste — a tapped land first, so untapped mana
  // isn't lost.
  applyAwaken(playerId, amount) {
    const p = this.getPlayer(playerId);
    const lands = p.battlefield.filter(x => isLand(x.card) && !x.awakened);
    const land = lands.find(x => x.tapped) || lands[0];
    if (!land) return;
    land.awakened = true;
    this.refreshCardState(land);
    this.applyCounterAdditionEffect({ controllerId: playerId, card: land.card, target: { type: 'permanent', id: land.id } }, amount, '+1/+1');
    this.log(`${land.card.name} awakens as a ${amount}/${amount} Elemental with haste.`);
  }

  // Impending: at the beginning of your end step, remove a time counter;
  // with none left, it's a creature.
  tickImpending(p) {
    for (const perm of p.battlefield.filter(x => x.impending && (x.counters.time || 0) > 0)) {
      perm.counters.time -= 1;
      if (perm.counters.time === 0) { perm.impending = false; this.log(`${perm.card.name}'s last time counter is removed — it's a creature now.`); }
      this.refreshCardState(perm);
    }
  }

  // ---------- Batch 10: current Standard set mechanics ----------

  // Returns a permanent to its owner's hand as a cost (Web-slinging, Sneak).
  returnPermanentToHand(perm) {
    const p = this.getPlayer(perm.controllerId);
    p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
    this.detachFromLeavingBattlefield(perm);
    this.triggerLeavesBattlefield(perm);
    if (this.exileIfUnearthed(perm) || this.redirectCommanderToZone(perm)) return;
    if (!isTokenCard(perm.card)) this.getPlayer(perm.ownerId).hand.push(...this.cardsOf(perm));
  }

  // Teamwork: the fewest weakest untapped creatures adding up to N power.
  teamworkCrew(playerId, need) {
    const pool = this.getPlayer(playerId).battlefield.filter(x => isCreature(x.card) && !x.tapped && this.effectivePower(x) > 0)
      .sort((a, b) => this.effectivePower(b) - this.effectivePower(a));
    const crew = [];
    let total = 0;
    for (const x of pool) { if (total >= need) break; crew.push(x); total += this.effectivePower(x); }
    return total >= need ? crew : [];
  }

  // Increment: whenever you cast a spell, each increment creature you
  // control gets a +1/+1 counter if the mana spent beats its power or
  // toughness.
  triggerIncrement(playerId, manaSpent) {
    if (!manaSpent) return;
    for (const perm of this.getPlayer(playerId).battlefield.filter(x => isCreature(x.card) && hasIncrement(x.card))) {
      if (manaSpent > this.effectivePower(perm) || manaSpent > this.effectiveToughness(perm)) {
        this.log(`${perm.card.name} increments (${manaSpent} mana spent).`);
        this.applyCounterAdditionEffect({ controllerId: playerId, card: perm.card, target: { type: 'permanent', id: perm.id } }, 1, '+1/+1');
      }
    }
  }

  // Paradigm: at the beginning of your first main phase, you may cast a
  // free copy of each paradigm spell you've resolved.
  offerParadigmCopies(p) {
    for (const card of p.paradigms || []) {
      this.requestChoice(p.id, `${card.name} — Paradigm: cast a free copy?`, [
        { label: `Cast a copy of ${card.name}`, resolve: () => this.putCopyOnStack(card, p.id, { cast: true, why: 'paradigm' }) },
        { label: 'Not this turn', resolve: () => {} },
      ], 0);
    }
  }

  // Harmonize's helper: the strongest untapped creature you control.
  harmonizeHelper(p) {
    const best = p.battlefield.filter(x => isCreature(x.card) && !x.tapped && this.effectivePower(x) > 0)
      .sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
    return best ? { perm: best, power: this.effectivePower(best) } : null;
  }

  // Infinity Stones: "Harness [this]" switches on its ∞ abilities.
  harness(perm) {
    if (!perm || perm.harnessed || !this.findPermanent(perm.id)) return;
    perm.harnessed = true;
    perm.card = { ...perm.card, oracleText: (perm.card.oracleText || '').replace(/^∞\s*—\s*/gm, '') };
    this.log(`${perm.card.name} is harnessed — its ∞ ability is active.`);
  }

  getTeamworkAmount(card) { return getTeamworkAmount(card); }

  // ---------- Batch 9: face-down permanents, Mutate, Phasing ----------
  getFaceDownCost(card) { return getFaceDownCost(card); }

  // Cast a Morph/Megamorph/Disguise card face down as a nameless 2/2 for
  // {3} (Disguise's also has ward {2}).
  canCastFaceDown(playerId, instanceId) {
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    if (!card || !getFaceDownCost(card)) return false;
    const fd = makeFaceDownCard(card, getFaceDownCost(card).kind);
    return this.canCastSpell(playerId, fd) && this.payableNow(playerId, '{3}');
  }

  castFaceDown(playerId, instanceId) {
    if (!this.canCastFaceDown(playerId, instanceId)) return { ok: false, reason: "Can't cast that face down right now." };
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    const real = p.hand[idx];
    const info = getFaceDownCost(real);
    const fd = { ...makeFaceDownCard(real, info.kind), manaCost: '{3}' };
    p.hand.splice(idx, 1, fd);
    const result = this.castSpell(playerId, fd.instanceId, [], 0, null, false, { costOverride: '{3}' });
    if (!result.ok) {
      const i = p.hand.indexOf(fd);
      if (i !== -1) p.hand.splice(i, 1, real);
      return result;
    }
    fd.manaCost = '';
    const item = this.stack.find(x => x.card === fd);
    if (item) item.faceDown = { card: real, kind: info.kind };
    return result;
  }

  // Manifest / cloak: the top card of the library onto the battlefield
  // face down as a 2/2 (cloak's with ward {2}).
  manifestTop(playerId, kind = 'manifest') {
    const p = this.getPlayer(playerId);
    const real = p.library.shift();
    if (!real) return null;
    const perm = makePermanent(makeFaceDownCard(real, kind), playerId);
    perm.faceDown = { card: real, kind };
    p.battlefield.push(perm);
    this.log(`${p.name} ${kind === 'cloak' ? 'cloaks' : 'manifests'} the top card of their library.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
    return perm;
  }

  // The cost to turn a face-down permanent face up: its morph/megamorph/
  // disguise cost, or for a manifested/cloaked creature card its mana cost.
  faceUpCost(perm) {
    if (!perm.faceDown) return null;
    const real = perm.faceDown.card;
    const own = getFaceDownCost(real);
    if (own) return own.cost;
    return isCreature(real) && real.manaCost ? real.manaCost : null;
  }

  // Turning face up is a special action: any time you have priority.
  canTurnFaceUp(playerId, permId) {
    const perm = this.findPermanent(permId);
    if (!perm?.faceDown || perm.controllerId !== playerId || this.gameOver || this.pendingRequest || this.priorityPlayer.id !== playerId) return false;
    const cost = this.faceUpCost(perm);
    return !!cost && this.payableNow(playerId, cost);
  }

  turnFaceUp(playerId, permId) {
    if (!this.canTurnFaceUp(playerId, permId)) return { ok: false, reason: "Can't turn that face up right now." };
    const perm = this.findPermanent(permId);
    const cost = this.faceUpCost(perm);
    this.payNow(playerId, cost);
    const { card: real, kind } = perm.faceDown;
    perm.faceDown = null;
    perm.card = real;
    this.log(`${this.getPlayer(playerId).name} turns ${real.name} face up (${cost}).`);
    if (getFaceDownCost(real)?.kind === 'megamorph') this.applyCounterAdditionEffect({ controllerId: playerId, card: real, target: { type: 'permanent', id: perm.id } }, 1, '+1/+1');
    this.runPermanentTrigger(perm, interpretTurnFaceUpTriggers(real));
    this.checkStateBasedActions();
    this.afterAction(playerId);
    return { ok: true };
  }

  // A permanent's own triggered steps, with targets: picked by the AI, or
  // asked of a human through the same prompt as an ETB target.
  runPermanentTrigger(perm, steps, extraCtx = {}) {
    if (!steps.length) return;
    const kinds = expandTargetKinds(steps);
    const ctxBase = { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm, ...extraCtx };
    if (!kinds.length || this.getPlayer(perm.controllerId).isAI || this.pendingRequest) {
      const targets = kinds.length ? pickTargetsForKinds(this, perm.card, perm.controllerId, kinds, perm.id) : [];
      this.resolveEffectSteps(steps, targets, ctxBase);
      this.checkStateBasedActions();
      return;
    }
    this._pendingETB = { perm, steps, ctxBase };
    this.pendingRequest = { type: 'etbTarget', playerId: perm.controllerId, cardName: perm.card.name, kinds, collected: [], sourcePermId: perm.id };
    this.emit();
  }

  // ---------- Ability words: votes, shared offers, hand/graveyard abilities ----------

  // Will of the council / Council's dilemma: each player votes for A or B
  // (starting with the caster). `per`: steps run once per vote for that
  // option; `more`: steps when that option gets more votes (or ties, if
  // the card says so). The AI votes for whichever option it judges better
  // for itself — the caster's own effects are good for the caster, so an
  // opponent votes for the option the caster gets less from.
  runVote(ctx, [a, b], per, more) {
    const votes = { [a]: 0, [b]: 0 };
    const value = (opt) => ((per[opt] || []).length + (more[opt]?.steps.length || 0));
    const finish = () => {
      for (const opt of [a, b]) for (let i = 0; i < votes[opt]; i++) if (per[opt]) this.resolveEffectSteps(per[opt], pickTargetsForKinds(this, ctx.card, ctx.controllerId, expandTargetKinds(per[opt])).filter(Boolean), ctx);
      for (const [opt, other] of [[a, b], [b, a]]) {
        const m = more[opt];
        if (m && (votes[opt] > votes[other] || (m.tie && votes[opt] === votes[other]))) this.resolveEffectSteps(m.steps, pickTargetsForKinds(this, ctx.card, ctx.controllerId, expandTargetKinds(m.steps)).filter(Boolean), ctx);
      }
      this.checkStateBasedActions();
    };
    // AI votes count immediately; the result waits for every human vote.
    let waiting = this.players.filter(pl => !pl.isAI).length;
    for (const pl of this.players) {
      const casterSide = pl.id === ctx.controllerId;
      const aiPick = (value(a) >= value(b)) === casterSide ? a : b;
      const cast = (opt) => () => {
        votes[opt] += 1;
        this.log(`${pl.name} votes for ${opt}.`);
        if (!pl.isAI && --waiting === 0) finish();
      };
      this.requestChoice(pl.id, `${ctx.card.name}: vote for ${a} or ${b}`, [{ label: `Vote ${a}`, resolve: cast(a) }, { label: `Vote ${b}`, resolve: cast(b) }], aiPick === a ? 0 : 1);
    }
    if (waiting === 0) finish();
  }

  // Join forces: each player may pay any amount of mana; returns the total.
  // The caster's side pays everything it has; an AI opponent pays nothing
  // (it only helps the caster), a human opponent is asked.
  runJoinForces(ctx) {
    let total = 0;
    for (const pl of this.players) {
      const lands = pl.battlefield.filter(x => isLand(x.card) && !x.tapped);
      const pay = pl.id === ctx.controllerId ? lands.length : 0;
      for (const l of lands.slice(0, pay)) l.tapped = true;
      if (pay) this.log(`${pl.name} pays ${pay} mana (join forces).`);
      total += pay;
    }
    return total;
  }

  // Tempting offer: the opponent may take the same effect; for each who
  // does, the caster gets it again. The AI accepts when it's something it
  // wants (cards, life, tokens, mana).
  runTemptingOffer(ctx, theirSteps, againSteps, theirText) {
    const opp = this.opponentOf(ctx.controllerId);
    const good = /\b(?:draw|gain|create|search|put|add|treasure|token)\b/i.test(theirText) && !/\blose|sacrifice|discard|damage\b/i.test(theirText);
    this.requestChoice(opp.id, `${ctx.card.name} — Tempting offer: take it too? (${theirText})`, [
      { label: 'Take it', resolve: () => {
        this.resolveEffectSteps(theirSteps, pickTargetsForKinds(this, ctx.card, opp.id, expandTargetKinds(theirSteps)).filter(Boolean), { ...ctx, controllerId: opp.id });
        this.resolveEffectSteps(againSteps, pickTargetsForKinds(this, ctx.card, ctx.controllerId, expandTargetKinds(againSteps)).filter(Boolean), ctx);
        this.log(`${opp.name} takes the tempting offer; ${this.getPlayer(ctx.controllerId).name} gets it again.`);
      } },
      { label: 'Decline', resolve: () => this.log(`${opp.name} declines the tempting offer.`) },
    ], good ? 0 : 1);
  }

  // Hand abilities: "COST, Discard this card: EFFECT" (Channel, Bloodrush).
  // Bloodrush's target is an attacking creature.
  getHandAbilities(card) { return getHandAbilities(card); }

  canActivateHandAbility(playerId, instanceId, index) {
    const p = this.getPlayer(playerId);
    if (this.gameOver || this.pendingRequest || this.priorityPlayer.id !== playerId || this.splitSecondActive()) return false;
    const card = p.hand.find(c => c.instanceId === instanceId);
    const ab = card && getHandAbilities(card)[index];
    if (!ab || isFullyUnsupportedSteps(ab.steps)) return false;
    if (ab.attackingTarget && !this.players.some(pl => pl.battlefield.some(x => x.attacking))) return false;
    return !ab.manaCost || this.payableNow(playerId, ab.manaCost);
  }

  activateHandAbility(playerId, instanceId, index, targets = []) {
    if (!this.canActivateHandAbility(playerId, instanceId, index)) return { ok: false, reason: "Can't do that right now." };
    this.resetTriggerChain();
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    const ab = getHandAbilities(card)[index];
    if (ab.attackingTarget && targets[0] && !this.findPermanent(targets[0].id)?.attacking) return { ok: false, reason: 'Bloodrush needs an attacking creature.' };
    if (ab.manaCost) this.payNow(playerId, ab.manaCost);
    this.log(`${p.name} discards ${card.name} to activate it (${ab.effectText}).`);
    this.discardCard(p, card);
    this.resolveEffectSteps(ab.steps, targets, { controllerId: playerId, card });
    this.checkStateBasedActions();
    this.afterAction(playerId);
    return { ok: true };
  }

  getRenew(card) { return getRenew(card); }

  // Renew: exile this card from your graveyard for its effect (sorcery speed).
  canRenew(playerId, instanceId) {
    const p = this.getPlayer(playerId);
    const card = p.graveyard.find(c => c.instanceId === instanceId);
    const r = card && getRenew(card);
    if (!r || this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    if (!(this.active.id === playerId && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    return this.payableNow(playerId, r.manaCost);
  }

  renew(playerId, instanceId, targets = null) {
    if (!this.canRenew(playerId, instanceId)) return { ok: false, reason: "Can't renew that right now." };
    this.resetTriggerChain();
    const p = this.getPlayer(playerId);
    const card = p.graveyard.find(c => c.instanceId === instanceId);
    const r = getRenew(card);
    this.payNow(playerId, r.manaCost);
    p.graveyard.splice(p.graveyard.indexOf(card), 1);
    p.exile.push(card);
    this.log(`${p.name} renews ${card.name}.`);
    const t = targets || pickTargetsForKinds(this, card, playerId, expandTargetKinds(r.steps)).filter(Boolean);
    this.resolveEffectSteps(r.steps, t, { controllerId: playerId, card });
    this.checkStateBasedActions();
    this.afterAction(playerId);
    return { ok: true };
  }

  // Meld: exile this permanent and its partner (both owned and controlled
  // by the same player), then put the melded card onto the battlefield.
  // The melded permanent remembers both cards — if it leaves, they go to
  // the zone separately (cardsOf / mutateCards).
  meldPermanents(perm, partnerName, resultName) {
    if (!perm || !this.findPermanent(perm.id)) return;
    const p = this.getPlayer(perm.controllerId);
    const partner = p.battlefield.find(x => x.id !== perm.id && x.card.name.toLowerCase() === partnerName.toLowerCase() && x.ownerId === p.id);
    if (!partner || perm.ownerId !== p.id) return;
    const result = perm.card.meldResultCard || partner.card.meldResultCard;
    if (!result) { this.log(`${perm.card.name} can't meld: ${resultName}'s card data wasn't loaded.`); return; }
    for (const x of [perm, partner]) {
      p.battlefield = p.battlefield.filter(y => y.id !== x.id);
      this.detachFromLeavingBattlefield(x);
      this.triggerLeavesBattlefield(x);
    }
    const melded = makePermanent({ ...result, instanceId: uid('meld') }, p.id);
    melded.mutateCards = [perm.card, partner.card];
    melded.card = { ...result, instanceId: melded.card.instanceId };
    p.battlefield.push(melded);
    this.log(`${perm.card.name} and ${partner.card.name} meld into ${result.name}.`);
    this.checkStateBasedActions();
    this.triggerETB(melded);
  }

  // ---------- Common effect shapes for the preset decks' leftover cards ----------

  // "Reveal the top N cards. You may put a [type] card from among them into
  // your hand (or: put all [type] cards into your hand). Put the rest into
  // your graveyard." The AI takes the best match (a land if short on lands).
  applyRevealPick(ctx, n, types, all) {
    const p = this.getPlayer(ctx.controllerId);
    const revealed = p.library.splice(0, n);
    if (!revealed.length) return;
    const matches = revealed.filter(c => types.some(t => hasTypeWord(c, t)));
    let picks = [];
    if (all) picks = matches;
    else if (matches.length) {
      const lands = p.battlefield.filter(x => isLand(x.card)).length;
      picks = [matches.slice().sort((a, b) => (isLand(b) && lands < 5 ? 1 : 0) - (isLand(a) && lands < 5 ? 1 : 0) || (b.cmc || 0) - (a.cmc || 0))[0]];
    }
    p.hand.push(...picks);
    p.graveyard.push(...revealed.filter(c => !picks.includes(c)));
    this.log(`${ctx.card.name} reveals ${revealed.map(c => c.name).join(', ')}; ${picks.length ? `${picks.map(c => c.name).join(', ')} to hand,` : ''} the rest to the graveyard.`);
    this.checkStateBasedActions();
  }

  // "Discard up to N cards. If you do, draw that many." The AI pitches
  // surplus lands (once it has five) and cards it can't cast soon; a human
  // picks one at a time, or stops.
  applyRummageUpTo(ctx, n) {
    const p = this.getPlayer(ctx.controllerId);
    if (p.isAI) {
      const lands = p.battlefield.filter(x => isLand(x.card)).length;
      const pitch = p.hand.filter(c => isLand(c) ? lands >= 5 : (c.cmc || 0) > lands + 2).slice(0, n);
      for (const c of pitch) { this.log(`${p.name} discards ${c.name}.`); this.discardCard(p, c); }
      if (pitch.length) this.applyDrawEffect({ ...ctx, target: null }, pitch.length);
      return;
    }
    let count = 0;
    const ask = () => {
      if (count >= n || !p.hand.length) { if (count) this.applyDrawEffect({ ...ctx, target: null }, count); return; }
      const seen = new Set();
      const options = [{ label: count ? `Done — draw ${count}` : "Don't discard", resolve: () => { if (count) this.applyDrawEffect({ ...ctx, target: null }, count); } }];
      for (const c of p.hand) { if (seen.has(c.name)) continue; seen.add(c.name); options.push({ label: `Discard ${c.name}`, resolve: () => { this.log(`${p.name} discards ${c.name}.`); this.discardCard(p, c); count++; ask(); } }); }
      this.requestChoice(p.id, `${ctx.card.name}: discard up to ${n - count} more card${n - count > 1 ? 's' : ''}, then draw that many`, options, 0);
    };
    ask();
  }

  // "You may pay {COST}. If you do, EFFECT." The AI pays when it can.
  offerPayFor(ctx, cost, steps) {
    const p = this.getPlayer(ctx.controllerId);
    if (!this.payableNow(p.id, cost)) return;
    this.requestChoice(p.id, `${ctx.card.name}: pay ${cost}?`, [
      { label: `Pay ${cost}`, resolve: () => { if (!this.payNow(p.id, cost)) return; const t = pickTargetsForKinds(this, ctx.card, p.id, expandTargetKinds(steps)).filter(Boolean); this.resolveEffectSteps(steps, t, ctx); } },
      { label: "Don't pay", resolve: () => {} },
    ], 0);
  }

  // A named creature token ("Ragavan, a legendary 2/1 red Monkey"),
  // optionally entering tapped and attacking and exiled at end of combat.
  createNamedToken(ctx, { name, legendary, power, toughness, typeDesc, keywordText, attacking, exileAtEndOfCombat }) {
    const p = this.getPlayer(ctx.controllerId);
    this.applyTokenEffect(ctx, 1, power, toughness, typeDesc, keywordText);
    const tok = p.battlefield[p.battlefield.length - 1];
    const titled = name.replace(/\b\w/g, ch => ch.toUpperCase());
    tok.card = { ...tok.card, name: titled, typeLine: legendary ? tok.card.typeLine.replace(/^Token /, 'Token Legendary ') : tok.card.typeLine };
    if (attacking && ctx.sourcePerm?.attacking) Object.assign(tok, { tapped: true, attacking: true, attackedThisTurn: true, attackTarget: ctx.sourcePerm.attackTarget, blockedBy: [] });
    if (exileAtEndOfCombat) tok.exileAtEndOfCombat = true;
    this.log(`${p.name} creates ${titled}${attacking ? ', tapped and attacking' : ''}.`);
  }

  // "Each player discards their hand, then draws N cards."
  applyWheel(ctx, n) {
    for (const pl of this.players) {
      if (pl.hand.length) this.log(`${pl.name} discards their hand (${pl.hand.length}).`);
      for (const c of [...pl.hand]) this.discardCard(pl, c);
    }
    for (const pl of this.players) for (let i = 0; i < n; i++) this.drawCard(pl);
  }

  // "Search your library for up to N [types] cards" to the battlefield
  // (tapped or not) or the top of the library.
  applyMultiTutor(ctx, n, words, dest, tapped) {
    const p = this.getPlayer(ctx.controllerId);
    const types = words.toLowerCase().replace(/\bcards?\b/g, '').split(/\s+and\/or\s+|\s+or\s+|,\s*/).map(w => w.trim()).filter(Boolean);
    const fits = (c) => types.some(t => t === 'basic land' ? /\bbasic\b/i.test(c.typeLine || '') && isLand(c) : hasTypeWord(c, t.replace(/s$/, '')));
    const picks = [];
    for (const c of p.library.filter(fits).sort((a, b) => (b.cmc || 0) - (a.cmc || 0))) { if (picks.length >= n) break; if (!picks.some(x => x.name === c.name) || isLand(c)) picks.push(c); }
    p.library = shuffle(p.library.filter(c => !picks.includes(c)));
    if (dest === 'top') { p.library.unshift(...picks); this.log(`${ctx.card.name} puts ${picks.length} card${picks.length === 1 ? '' : 's'} on top of ${p.name}'s library.`); return; }
    for (const c of picks) {
      const perm = makePermanent(c, p.id);
      perm.tapped = tapped;
      if (isLand(c)) perm.summoningSick = false;
      p.battlefield.push(perm);
      this.triggerETB(perm);
    }
    this.log(`${ctx.card.name} puts ${picks.map(c => c.name).join(', ') || 'nothing'} onto the battlefield${tapped ? ' tapped' : ''}.`);
    this.checkStateBasedActions();
  }

  // Sepulchral Primordial: the best creature card from the opponent's graveyard.
  applyReanimateFromOpponentGraveyard(ctx) {
    const opp = this.opponentOf(ctx.controllerId);
    const best = opp.graveyard.filter(c => isCreature(c)).sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    if (!best) return;
    opp.graveyard.splice(opp.graveyard.indexOf(best), 1);
    const perm = makePermanent(best, ctx.controllerId);
    perm.ownerId = opp.id;
    perm.enteredFromGraveyardOf = opp.id;
    this.getPlayer(ctx.controllerId).battlefield.push(perm);
    this.log(`${ctx.card.name} puts ${best.name} from ${opp.name}'s graveyard onto the battlefield.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
  }

  // Karrthus: "gain control of all Dragons, then untap all Dragons".
  applyGainControlOfAll(ctx, type, untap) {
    const me = this.getPlayer(ctx.controllerId);
    for (const pl of this.players) for (const perm of [...pl.battlefield]) {
      if (!hasTypeWord(perm.card, type)) continue;
      if (pl.id !== me.id) { pl.battlefield = pl.battlefield.filter(x => x !== perm); perm.controllerId = me.id; perm.summoningSick = true; me.battlefield.push(perm); this.log(`${me.name} gains control of ${perm.card.name}.`); }
      if (untap) perm.tapped = false;
    }
  }

  // Volcano Hellion: damage of your choice to you and the target — the AI
  // picks the target's remaining toughness if it can spare the life.
  applyChosenDamageToYouAndTarget(ctx) {
    const target = ctx.target?.type === 'permanent' ? this.findPermanent(ctx.target.id) : null;
    const p = this.getPlayer(ctx.controllerId);
    if (!target) return;
    const need = Math.max(0, this.effectiveToughness(target) - target.damage);
    const amount = target.controllerId === p.id ? 0 : (p.life > need + 1 ? need : 0);
    if (!amount) { this.log(`${ctx.card.name} deals no damage.`); return; }
    this.applyDamageEffect({ ...ctx, target: { type: 'player', id: p.id } }, amount);
    this.applyDamageEffect(ctx, amount);
  }

  // Divided damage among the chosen targets: lethal to creatures first (in
  // the order chosen), the rest to the last target.
  applyDividedDamage(ctx, amount) {
    const targets = (ctx.targets || [ctx.target]).filter(Boolean);
    this._lastDividedDamaged = [];
    let left = amount;
    targets.forEach((t, i) => {
      if (left <= 0) return;
      let share = left;
      if (i < targets.length - 1 && t.type === 'permanent') {
        const perm = this.findPermanent(t.id);
        share = perm ? Math.min(left, Math.max(1, this.effectiveToughness(perm) - perm.damage)) : 0;
      } else if (i < targets.length - 1) share = Math.ceil(left / (targets.length - i));
      if (share <= 0) return;
      left -= share;
      if (t.type === 'permanent') this._lastDividedDamaged.push(t.id);
      this.applyDamageEffect({ ...ctx, target: t, targets: null }, share);
    });
    this.checkStateBasedActions();
  }

  // Bloodthirsty Adversary: pay {2}{R} as many times as you like (the AI:
  // as many as it can); that many +1/+1 counters, and that many instant /
  // sorcery cards with mana value 3 or less from your graveyard are exiled
  // and copied, the copies cast free.
  applyPayAnyNumberOfTimes(ctx, cost) {
    const p = this.getPlayer(ctx.controllerId);
    let times = 0;
    while (times < 5 && this.payableNow(p.id, cost.repeat(times + 1))) times++;
    if (!times) return;
    this.payNow(p.id, cost.repeat(times));
    this.log(`${p.name} pays ${cost} ${times} time${times > 1 ? 's' : ''}.`);
    if (ctx.sourcePerm) this.applyCounterAdditionEffect({ ...ctx, target: { type: 'permanent', id: ctx.sourcePerm.id } }, times, '+1/+1');
    if (/exile up to that many target instant and\/or sorcery cards/i.test(ctx.card.oracleText || '')) {
      const spells = p.graveyard.filter(c => (isInstant(c) || isSorcery(c)) && (c.cmc || 0) <= 3).sort((a, b) => (b.cmc || 0) - (a.cmc || 0)).slice(0, times);
      for (const sp of spells) {
        p.graveyard.splice(p.graveyard.indexOf(sp), 1);
        p.exile.push(sp);
        this.putCopyOnStack(sp, p.id, { cast: true, why: ctx.card.name });
      }
    }
  }

  // "As this enters, choose Khans or Dragons." Keeps only the chosen mode's
  // "• Khans — ..." line (the printed card returns if it leaves). AI: the
  // mode with a target available / Dragons when the opponent is low.
  offerEntryModeChoice(perm) {
    const text = perm.card.oracleText || '';
    const m = text.match(/^as this (?:enchantment|permanent|creature|artifact) enters, choose (\w+) or (\w+)\.?$/im) || replaceSelfNameExport(perm.card, text, 'this permanent').match(/^as this (?:enchantment|permanent|creature|artifact) enters, choose (\w+) or (\w+)\.?$/im);
    if (!m || perm._modeChosen) return;
    const [a, b] = [m[1], m[2]];
    const choose = (opt) => () => {
      if (!this.findPermanent(perm.id)) return;
      perm._modeChosen = opt;
      const printed = perm.card;
      const kept = text.split('\n').filter(l => !/^as this .* enters, choose/i.test(l)).map(l => { const bm = l.match(/^•\s*(\w+)\s*—\s*(.+)$/); return bm ? (bm[1].toLowerCase() === opt.toLowerCase() ? bm[2] : null) : l; }).filter(l => l !== null).join('\n');
      perm.card = { ...printed, oracleText: kept, _printed: printed };
      this.log(`${printed.name}: ${opt} chosen.`);
    };
    const p = this.getPlayer(perm.controllerId);
    const opp = this.opponentOf(perm.controllerId);
    const aiB = p.graveyard.filter(c => isCreature(c)).length < 2 || opp.life <= 10;
    this.requestChoice(perm.controllerId, `${perm.card.name}: choose ${a} or ${b}`, [{ label: a, resolve: choose(a) }, { label: b, resolve: choose(b) }], aiB ? 1 : 0);
  }

  // Orzhov Advokist: at your upkeep each player may put two +1/+1 counters on
  // a creature they control; any player who does can't attack you or your
  // planeswalkers until your next turn. The AI (as the opponent) accepts
  // when it isn't threatening much of an attack anyway.
  applyAdvokist(ctx) {
    const me = this.getPlayer(ctx.controllerId);
    for (const pl of this.players) {
      const best = pl.battlefield.filter(x => isCreature(x.card)).sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
      if (!best) continue;
      const give = () => {
        this.applyCounterAdditionEffect({ controllerId: pl.id, card: ctx.card, target: { type: 'permanent', id: best.id } }, 2, '+1/+1');
        if (pl.id !== me.id) { pl.advokistLockedUntilTurnOf = me.id; pl.advokistSetTurn = this.turnNumber; this.log(`${pl.name}'s creatures can't attack ${me.name} until ${me.name}'s next turn.`); }
      };
      if (pl.id === me.id) { give(); continue; }
      const attackPower = pl.battlefield.filter(x => isCreature(x.card)).reduce((n, x) => n + this.effectivePower(x), 0);
      this.requestChoice(pl.id, `${ctx.card.name}: put two +1/+1 counters on ${best.card.name}? (Your creatures then can't attack ${me.name} until their next turn.)`, [
        { label: 'Take the counters', resolve: give },
        { label: 'Decline', resolve: () => {} },
      ], attackPower < 4 ? 0 : 1);
    }
  }

  // Yorion: exile your other nonland permanents (the AI: ones with "enters"
  // triggers, never tokens) and return them at the next end step.
  applyDelayedBlinkOwn(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const picks = p.battlefield.filter(x => x !== ctx.sourcePerm && !isLand(x.card) && !isTokenCard(x.card) && (x.ownerId ?? x.controllerId) === p.id && /\bwhen (?:this|~|[^.,]*?) enters\b/i.test(replaceSelfNameExport(x.card, x.card.oracleText || '', 'this permanent')));
    if (!p.isAI && picks.length) {
      const chosen = [];
      const ask = (rest) => {
        const opts = [{ label: chosen.length ? `Done (${chosen.length})` : 'Exile nothing', resolve: () => this.blinkUntilEndStep(p, chosen, ctx) }];
        for (const x of rest) opts.push({ label: `Exile ${x.card.name}`, resolve: () => { chosen.push(x); ask(rest.filter(y => y !== x)); } });
        this.requestChoice(p.id, `${ctx.card.name}: exile permanents to return at end step`, opts, 0);
      };
      ask(picks);
      return;
    }
    this.blinkUntilEndStep(p, picks, ctx);
  }

  blinkUntilEndStep(p, perms, ctx) {
    for (const perm of perms) {
      if (!this.findPermanent(perm.id)) continue;
      p.battlefield = p.battlefield.filter(x => x !== perm);
      this.detachFromLeavingBattlefield(perm);
      this.triggerLeavesBattlefield(perm);
      const card = perm.card._printed || perm._baseCard || perm.card;
      p.exile.push(card);
      (this._amalgamReturns ||= []).push({ card, ownerId: p.id, zone: 'exile' });
      this.log(`${ctx.card.name} exiles ${card.name} until the next end step.`);
    }
  }

  // Scry / surveil: look at the top N; each goes on top or to the bottom
  // (scry) / graveyard (surveil). The AI keeps lands while it has fewer
  // than five on the battlefield and spells it can cast within two more
  // land drops; a human decides card by card.
  applyLookAndSort(ctx, n, dest) {
    const p = this.getPlayer(ctx.controllerId);
    const looked = p.library.slice(0, n);
    if (!looked.length) return;
    const verb = dest === 'graveyard' ? 'surveils' : 'scries';
    const lands = p.battlefield.filter(x => isLand(x.card)).length;
    const keepAI = (c) => isLand(c) ? lands < 5 : (c.cmc || 0) <= lands + 2;
    const finish = (keep) => {
      const kept = looked.filter(c => keep.has(c));
      const away = looked.filter(c => !keep.has(c));
      p.library = [...kept, ...p.library.slice(looked.length)];
      if (dest === 'graveyard') p.graveyard.push(...away); else p.library.push(...away);
      this.log(`${p.name} ${verb} ${n}: ${kept.length} on top, ${away.length} ${dest === 'graveyard' ? 'into the graveyard' : 'on the bottom'}.`);
      this.checkStateBasedActions();
    };
    if (p.isAI) { finish(new Set(looked.filter(keepAI))); return; }
    const keep = new Set();
    const ask = (i) => {
      if (i >= looked.length) { finish(keep); return; }
      const c = looked[i];
      this.requestChoice(p.id, `${ctx.card.name} — ${verb.replace(/s$/, '')} ${i + 1}/${looked.length}: ${c.name}`, [
        { label: 'Keep on top', resolve: () => { keep.add(c); ask(i + 1); } },
        { label: dest === 'graveyard' ? 'Put into graveyard' : 'Put on bottom', resolve: () => ask(i + 1) },
      ], keepAI(c) ? 0 : 1);
    };
    ask(0);
  }

  // Puts a card from outside the battlefield (already removed from its
  // zone) onto the battlefield under its owner's control.
  putCardOntoBattlefield(card, playerId, { tapped = false } = {}) {
    const perm = makePermanent(card, playerId);
    perm.tapped = tapped;
    if (isLand(card)) perm.summoningSick = false;
    this.getPlayer(playerId).battlefield.push(perm);
    this.triggerETB(perm);
    this.checkStateBasedActions();
    return perm;
  }

  // Gains control of a target permanent until the game ends — or, when
  // `linked`, only for as long as the source stays on the battlefield under
  // the same controller (checked with state-based actions).
  applyStealEffect(ctx, { linked }) {
    const perm = ctx.target?.type === 'permanent' ? this.findPermanent(ctx.target.id) : null;
    if (!perm || perm.controllerId === ctx.controllerId) return;
    const from = this.getPlayer(perm.controllerId), to = this.getPlayer(ctx.controllerId);
    from.battlefield = from.battlefield.filter(x => x !== perm);
    perm.controllerId = to.id; perm.summoningSick = true; perm.attacking = false; perm.blocking = null;
    to.battlefield.push(perm);
    if (linked && ctx.sourcePerm) (this.linkedControl ||= []).push({ permId: perm.id, sourceId: ctx.sourcePerm.id, controllerId: to.id, originalControllerId: from.id });
    this.log(`${to.name} gains control of ${perm.card.name}${linked ? ` for as long as they control ${ctx.card.name}` : ''}.`);
  }

  // Ends "for as long as you control X" control effects whose X is gone.
  checkLinkedControl() {
    if (!this.linkedControl?.length) return;
    this.linkedControl = this.linkedControl.filter(link => {
      const src = this.findPermanent(link.sourceId);
      if (src && src.controllerId === link.controllerId) return true;
      const perm = this.findPermanent(link.permId);
      if (perm && perm.controllerId === link.controllerId) {
        const holder = this.getPlayer(link.controllerId), back = this.getPlayer(link.originalControllerId);
        holder.battlefield = holder.battlefield.filter(x => x !== perm);
        perm.controllerId = back.id; perm.attacking = false; perm.blocking = null;
        back.battlefield.push(perm);
        this.log(`${perm.card.name} returns to ${back.name}'s control.`);
      }
      return false;
    });
  }

  hasTypeWordPublic(card, word) { return hasTypeWord(card, word); }

  applyRedirectSpell(ctx) {
    const item = this.stack.find(x => x.id === ctx.target?.id);
    if (!item || (item.targets || []).filter(Boolean).length !== 1) return;
    const kinds = this.getRequiredTargetKinds(item.card);
    const next = pickTargetsForKinds(this, item.card, ctx.controllerId, kinds).filter(Boolean)[0];
    const cur = item.targets.find(Boolean);
    if (!next || (next.type === cur.type && next.id === cur.id)) { this.log(`${ctx.card.name} leaves ${item.card.name}'s target unchanged.`); return; }
    item.targets = item.targets.map(t => (t ? next : t));
    const name = next.type === 'player' ? this.getPlayer(next.id).name : this.findPermanent(next.id)?.card.name;
    this.log(`${ctx.card.name} changes ${item.card.name}'s target to ${name}.`);
  }

  // ---------- Infinite loops ----------
  // A chain of abilities that keeps re-triggering itself (Polyraptor +
  // Forerunner of the Empire) is cut off once one source has resolved
  // LOOP_LIMIT times without a player getting to act. Following the rules
  // for loops (CR 732): if any of the looping abilities is optional ("you
  // may", "up to"), its controller simply chooses to stop it there; if
  // every one is mandatory, the game is a draw (CR 104.4b).
  static LOOP_LIMIT = 100;

  resetTriggerChain() {
    this._triggerChain = new Map();
    this._loopHalted = false;
  }

  handleLoop() {
    if (this._loopHalted) return;
    this._loopHalted = true;
    const looping = [...(this._triggerChain || new Map()).entries()].filter(([, n]) => n > Game.LOOP_LIMIT / 2).map(([name]) => name);
    const cards = this.players.flatMap(pl => [...pl.battlefield.map(x => x.card), ...pl.graveyard, ...pl.hand, ...this.stack.map(i => i.card)]);
    const textOf = (name) => (cards.find(c => c.name === name)?.oracleText || '');
    const optional = looping.some(name => /you may|may have|up to/i.test(textOf(name)));
    if (optional) {
      this.log(`Infinite loop (${looping.join(' + ')}): stopped after ${Game.LOOP_LIMIT} repetitions — the loop includes an optional ability, so its controller chooses to stop there.`);
    } else {
      this.declareDraw(`mandatory infinite loop: ${looping.join(' + ')}`);
    }
  }

  declareDraw(reason) {
    if (this.gameOver) return;
    this.gameOver = true;
    this.winner = null;
    this.isDraw = true;
    this.log(`The game is a draw (${reason}).`, true);
    this.emit();
  }

  // Every real card a permanent represents (a mutated creature is several).
  cardsOf(perm) { return perm.mutateCards ? [...perm.mutateCards] : [perm.card]; }

  // Mutate: merge `card` over or under `target`. The merged creature has
  // the top card's name, types, and stats plus every card's abilities.
  // Then its "whenever this creature mutates" triggers fire.
  mergeMutate(target, card, onTop) {
    const under = target.mutateCards || [target.card];
    const cards = onTop ? [card, ...under] : [...under, card];
    const top = cards[0];
    target.mutateCards = cards;
    target.card = {
      ...top,
      oracleText: cards.map(c => c.oracleText || '').filter(Boolean).join('\n'),
      keywords: [...new Set(cards.flatMap(c => c.keywords || []))],
    };
    this.log(`${card.name} mutates ${onTop ? 'onto' : 'under'} ${under[0].name} — it's now ${top.name}.`);
    this.runPermanentTrigger(target, interpretMutateTriggers(target.card));
    this.checkStateBasedActions();
  }

  // Phasing: a phased-out permanent (and what's attached to it) is treated
  // as though it doesn't exist — held aside with no leave/enter triggers —
  // until it phases back in during its controller's untap step (or, for
  // Oubliette-style effects, when the source leaves the battlefield).
  phaseOut(perm, untilSource = null) {
    const p = this.getPlayer(perm.controllerId);
    if (!p.battlefield.includes(perm)) return;
    const attached = this.players.flatMap(pl => pl.battlefield.filter(x => x.attachedTo === perm.id));
    for (const a of attached) { const ap = this.getPlayer(a.controllerId); ap.battlefield = ap.battlefield.filter(x => x !== a); }
    p.battlefield = p.battlefield.filter(x => x !== perm);
    perm.attacking = false; perm.blockedBy = []; perm.blocking = null;
    (p.phasedOut ||= []).push({ perm, attached, untilSourceId: untilSource?.id || null, phasedOutOnTurn: this.turnNumber });
    if (untilSource) (untilSource.phasedOutByThis ||= []).push(perm.id);
    this.log(`${perm.card.name} phases out.`);
  }

  phaseIn(entry, { tap = false } = {}) {
    const p = this.getPlayer(entry.perm.controllerId);
    p.phasedOut = (p.phasedOut || []).filter(e => e !== entry);
    p.battlefield.push(entry.perm);
    for (const a of entry.attached) this.getPlayer(a.controllerId).battlefield.push(a);
    if (tap) entry.perm.tapped = true;
    this.log(`${entry.perm.card.name} phases in${tap ? ' tapped' : ''}.`);
  }

  // Untap step: phased-out permanents phase in and phasing permanents phase
  // out, simultaneously.
  applyPhasingAtUntap(p) {
    const goingOut = p.battlefield.filter(x => this.effectiveKeywords(x).has('phasing'));
    for (const entry of [...(p.phasedOut || [])]) if (!entry.untilSourceId) this.phaseIn(entry);
    for (const perm of goingOut) this.phaseOut(perm);
  }

  // ---------- Batch 8 ----------
  hasTypeWord(card, word) { return hasTypeWord(card, word); }

  // The monarch draws at their end step; combat damage to the monarch
  // takes it. Palace Jailer's exiles return when an opponent of its
  // controller becomes the monarch.
  becomeMonarch(playerId) {
    if (this.monarch === playerId) return;
    this.monarch = playerId;
    this.log(`${this.getPlayer(playerId).name} becomes the monarch.`);
    for (const entry of [...(this.monarchExiles || [])]) {
      if (entry.controllerId === playerId) continue;
      this.monarchExiles = this.monarchExiles.filter(e => e !== entry);
      const owner = this.getPlayer(entry.ownerId);
      const i = owner.exile.indexOf(entry.card);
      if (i === -1) continue;
      owner.exile.splice(i, 1);
      const back = makePermanent(entry.card, owner.id);
      owner.battlefield.push(back);
      this.log(`${entry.card.name} returns to the battlefield (an opponent became the monarch).`);
      this.triggerETB(back);
    }
  }

  applyMonarchExile(ctx) {
    const perm = ctx.target?.type === 'permanent' ? this.findPermanent(ctx.target.id) : null;
    if (!perm) return;
    this.applyExileEffect(ctx);
    const owner = this.getPlayer(perm.ownerId);
    if (owner.exile.includes(perm.card)) (this.monarchExiles ||= []).push({ card: perm.card, ownerId: perm.ownerId, controllerId: ctx.controllerId });
  }

  // Amass [type] N: put N +1/+1 counters on an Army you control (it gains
  // the type); if you have none, create a 0/0 black [type] Army first.
  applyAmass(ctx, n, type = null) {
    const p = this.getPlayer(ctx.controllerId);
    let army = p.battlefield.find(x => isCreature(x.card) && /\barmy\b/i.test(x.card.typeLine || ''));
    const typeName = type ? type[0].toUpperCase() + type.slice(1) : '';
    if (!army) {
      this.applyTokenEffect(ctx, 1, 0, 0, `black ${type || ''} army`.replace(/\s+/g, ' '));
      army = p.battlefield[p.battlefield.length - 1];
    } else if (type && !hasTypeWord(army.card, type)) {
      army.card = { ...army.card, typeLine: army.card.typeLine.replace(/—\s*/, `— ${typeName} `) };
    }
    if (n > 0) this.applyCounterAdditionEffect({ ...ctx, target: { type: 'permanent', id: army.id } }, n, '+1/+1');
    this.log(`${p.name} amasses ${n}.`);
  }

  // Overload sweeps: destroy / bounce / damage each permanent of a type,
  // optionally only those the caster doesn't control.
  applyEachPermanentEffect(ctx, type, theirsOnly, action, amount = 0) {
    const matches = (perm) => type === 'permanent' ? true
      : type === 'nonland permanent' ? !isLand(perm.card)
      : hasTypeWord(perm.card, type);
    const victims = this.players.filter(pl => !theirsOnly || pl.id !== ctx.controllerId)
      .flatMap(pl => pl.battlefield.filter(matches));
    for (const perm of victims) {
      if (!this.findPermanent(perm.id)) continue;
      if (action === 'destroy') this.applyDestroyEffect({ ...ctx, target: { type: 'permanent', id: perm.id }, targets: null });
      else if (action === 'bounce') this.applyBounceEffect({ ...ctx, target: { type: 'permanent', id: perm.id } });
      else if (action === 'damage') this.applyDamageEffect({ ...ctx, target: { type: 'permanent', id: perm.id } }, amount);
    }
    this.checkStateBasedActions();
  }

  // Absorb N on a creature (printed, or "All Sliver creatures have absorb N").
  absorbAmount(perm) {
    let n = this.keywordAmount(perm.card, 'absorb');
    for (const pl of this.players) for (const other of pl.battlefield) {
      const m = (other.card.oracleText || '').match(/all (\w+) creatures have absorb (\d+)/i);
      if (m && hasTypeWord(perm.card, m[1].toLowerCase())) n = Math.max(n, parseInt(m[2], 10));
    }
    return n;
  }

  // Extort: whenever you cast a spell, each extort permanent you control
  // lets you pay {W/B} to drain 1. AI pays when it can.
  triggerExtort(playerId, spellCard) {
    const p = this.getPlayer(playerId);
    for (const perm of p.battlefield.filter(x => /^extort\b/im.test((x.card.oracleText || '').replace(/\([^()]*\)/g, '')))) {
      if (!this.payableNow(playerId, '{W/B}')) continue;
      const pay = () => {
        if (!this.payNow(playerId, '{W/B}')) return;
        const opp = this.opponentOf(playerId);
        opp.life -= 1; p.life += 1;
        this.log(`${perm.card.name} extorts: ${opp.name} loses 1 life and ${p.name} gains 1.`);
        this.checkStateBasedActions();
      };
      this.requestChoice(playerId, `${perm.card.name} — Extort (${spellCard.name} was cast): pay {W/B}?`, [
        { label: 'Pay {W/B} (drain 1)', resolve: pay },
        { label: "Don't pay", resolve: () => {} },
      ], 0);
    }
  }

  // Ascend: "can't attack or block unless you have the city's blessing"
  // and "has KW as long as you have the city's blessing".
  applyBlessingKeywords(perm, set) {
    const text = (perm.card.oracleText || '').toLowerCase();
    if (!/city'?s blessing/.test(text)) return;
    const blessed = !!this.getPlayer(perm.controllerId)?.citysBlessing;
    if (!blessed && /can'?t attack or block unless you have the city'?s blessing/.test(text)) { set.add('cantAttack'); set.add('cantBlock'); }
    const grant = text.match(/(?:as long as you have the city'?s blessing, this (?:creature|permanent) (?:has|gets [^.]*? and has) ([^.]+))|(?:this (?:creature|permanent) has ([^.]+?) as long as you have the city'?s blessing)/);
    if (blessed && grant) for (const kw of extractKnownKeywords(grant[1] || grant[2])) set.add(kw);
  }

  // Soulbond: when a soulbond creature enters, or a creature enters while
  // you control an unpaired soulbond creature, you may pair them. Pair
  // bonuses: "As long as this creature is paired with another creature,
  // both creatures have KW / each of those creatures gets +N/+N".
  offerSoulbond(perm) {
    const p = this.getPlayer(perm.controllerId);
    const unpaired = (x) => isCreature(x.card) && !this.pairedPartner(x);
    if (hasSoulbond(perm.card)) {
      const partners = p.battlefield.filter(x => x.id !== perm.id && unpaired(x)).sort((a, b) => this.effectivePower(b) - this.effectivePower(a)).slice(0, 7);
      if (partners.length) {
        this.requestChoice(p.id, `${perm.card.name} — Soulbond: pair with?`, [
          ...partners.map(x => ({ label: `Pair with ${x.card.name}`, resolve: () => this.pairCreatures(perm, x) })),
          { label: "Don't pair", resolve: () => {} },
        ], 0);
      }
      return;
    }
    const bonder = p.battlefield.find(x => x.id !== perm.id && hasSoulbond(x.card) && unpaired(x));
    if (bonder && unpaired(perm)) {
      this.requestChoice(p.id, `${bonder.card.name} — Soulbond: pair with ${perm.card.name}?`, [
        { label: `Pair ${bonder.card.name} with ${perm.card.name}`, resolve: () => this.pairCreatures(bonder, perm) },
        { label: "Don't pair", resolve: () => {} },
      ], 0);
    }
  }

  pairCreatures(a, b) {
    if (!this.findPermanent(a.id) || !this.findPermanent(b.id)) return;
    a.pairedWith = b.id; b.pairedWith = a.id;
    this.log(`${a.card.name} and ${b.card.name} are paired (soulbond).`);
  }

  // A creature's current pair partner, if the pairing still holds (both on
  // the battlefield under the same controller).
  pairedPartner(perm) {
    if (!perm.pairedWith) return null;
    const other = this.findPermanent(perm.pairedWith);
    return other && other.pairedWith === perm.id && other.controllerId === perm.controllerId ? other : null;
  }

  pairBonus(perm) {
    const bonus = { power: 0, toughness: 0, keywords: [] };
    const partner = this.pairedPartner(perm);
    if (!partner) return bonus;
    for (const source of [perm, partner]) {
      const text = (source.card.oracleText || '').toLowerCase();
      const m = text.match(/as long as (?:this creature|[^,]+?) is paired with another creature, (?:both creatures|each of those creatures) (?:have|has|gets?) ([^.]+)/);
      if (!m) continue;
      const stats = m[1].match(/([+-]\d+)\/([+-]\d+)/);
      if (stats) { bonus.power += parseInt(stats[1], 10); bonus.toughness += parseInt(stats[2], 10); }
      bonus.keywords.push(...extractKnownKeywords(m[1]));
    }
    return bonus;
  }

  // Transfigure: (this creature was sacrificed as the cost) find a creature
  // card with the same mana value, put it onto the battlefield, shuffle.
  applyTransfigure(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const cmc = ctx.card.cmc || 0;
    const pick = p.library.filter(c => isCreature(c) && (c.cmc || 0) === cmc && c.name !== ctx.card.name)
      .sort((a, b) => (parseInt(b.power, 10) || 0) - (parseInt(a.power, 10) || 0))[0];
    p.library = shuffle(p.library.filter(c => c !== pick));
    if (!pick) { this.log(`${ctx.card.name}'s transfigure finds nothing.`); return; }
    const perm = makePermanent(pick, p.id);
    p.battlefield.push(perm);
    this.log(`${ctx.card.name} transfigures into ${pick.name}.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
  }

  // Aura swap: exchange this Aura with an Aura card in hand (the priciest),
  // attached to the same thing.
  applyAuraSwap(ctx) {
    const aura = ctx.sourcePerm;
    const p = this.getPlayer(ctx.controllerId);
    if (!aura || !this.findPermanent(aura.id)) return;
    const incoming = p.hand.filter(c => isAura(c)).sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    if (!incoming) { this.log(`${p.name} has no Aura card to swap in.`); return; }
    const host = aura.attachedTo;
    p.battlefield = p.battlefield.filter(x => x.id !== aura.id);
    this.detachFromLeavingBattlefield(aura);
    this.triggerLeavesBattlefield(aura);
    this.getPlayer(aura.ownerId).hand.push(aura.card);
    p.hand.splice(p.hand.indexOf(incoming), 1);
    const perm = makePermanent(incoming, p.id);
    perm.attachedTo = host;
    p.battlefield.push(perm);
    this.log(`${p.name} swaps ${aura.card.name} for ${incoming.name}.`);
    this.checkStateBasedActions();
  }

  // Fortify {cost}: attach this Fortification to a land you control
  // (sorcery speed).
  canFortify(playerId, permId) {
    const perm = this.findPermanent(permId);
    const p = this.getPlayer(playerId);
    if (!perm || perm.controllerId !== playerId || this.gameOver || this.pendingRequest || this.splitSecondActive()) return false;
    const cost = getFortifyCost(perm.card);
    if (!cost || !(p.id === this.active.id && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    return p.battlefield.some(x => isLand(x.card)) && this.payableNow(playerId, cost);
  }

  fortify(playerId, permId, landId) {
    if (!this.canFortify(playerId, permId)) return { ok: false, reason: "Can't fortify right now." };
    const perm = this.findPermanent(permId);
    const land = this.findPermanent(landId);
    if (!land || land.controllerId !== playerId || !isLand(land.card)) return { ok: false, reason: 'Fortify needs a land you control.' };
    this.payNow(playerId, getFortifyCost(perm.card));
    perm.attachedTo = land.id;
    this.log(`${this.getPlayer(playerId).name} fortifies ${land.card.name} with ${perm.card.name}.`);
    this.afterAction(playerId);
    return { ok: true };
  }

  getFortifyCost(card) { return getFortifyCost(card); }

  // ---------- Batch 7: counters, upkeep costs, and other timing keywords ----------

  // Colors of mana spent on a payment (Sunburst), counted the way a player
  // would maximize them: colored pips and pool mana count their colors,
  // single-color lands theirs, and each multicolor land adds a color not
  // already counted if it can.
  // Mana spent by color (for Adamant / Converge), counted the same
  // player-friendly way as colorsSpent.
  colorCountsSpent(payment, parsed) {
    const counts = {};
    const add = (c, n = 1) => { if (c && c !== 'C' && n > 0) counts[c] = (counts[c] || 0) + n; };
    for (const c of ['W', 'U', 'B', 'R', 'G']) add(c, parsed.colors[c] || 0);
    for (const c of ['W', 'U', 'B', 'R', 'G']) add(c, payment.poolUsed?.[c] || 0);
    const coloredNeeded = ['W', 'U', 'B', 'R', 'G'].reduce((n, c) => n + (parsed.colors[c] || 0), 0);
    const lands = (payment.lands || []).map(l => (l.card.producedMana || []).filter(c => c !== 'C'));
    lands.slice(coloredNeeded).forEach(prod => add(prod[0]));
    return counts;
  }

  colorsSpent(payment, parsed) {
    const colors = new Set(['W', 'U', 'B', 'R', 'G'].filter(c => (parsed.colors[c] || 0) > 0));
    for (const c of ['W', 'U', 'B', 'R', 'G']) if ((payment.poolUsed?.[c] || 0) > 0) colors.add(c);
    const lands = (payment.lands || []).map(l => (l.card.producedMana || []).filter(c => c !== 'C'));
    for (const prod of lands.filter(x => x.length === 1)) colors.add(prod[0]);
    for (const prod of lands.filter(x => x.length > 1)) { const fresh = prod.find(c => !colors.has(c)); if (fresh) colors.add(fresh); }
    return colors.size;
  }

  // "Enters with" keyword counters, applied before state-based actions so a
  // 0/0 (Arcbound Worker, a sunburst creature) survives: Modular, Vanishing,
  // Fading, Sunburst, Amplify, and Devour (a choice).
  applyEntryCounterKeywords(perm, item) {
    const card = perm.card;
    const ctx = { controllerId: perm.controllerId, card, target: { type: 'permanent', id: perm.id } };
    const p = this.getPlayer(perm.controllerId);
    const modular = this.keywordAmount(card, 'modular');
    if (modular) this.applyCounterAdditionEffect(ctx, modular, '+1/+1');
    const forEachCounters = (card.oracleText || '').toLowerCase().match(/enters with an? \+1\/\+1 counter on it for each ([^.]+)/);
    if (forEachCounters && parseForEach(forEachCounters[1])) {
      const n = parseForEach(forEachCounters[1])(this, { controllerId: perm.controllerId, sourcePerm: perm, card, castInfo: item?.castInfo });
      if (n > 0) this.applyCounterAdditionEffect(ctx, n, '+1/+1');
    }
    const graft = this.keywordAmount(card, 'graft');
    if (graft) this.applyCounterAdditionEffect(ctx, graft, '+1/+1');
    const vanishing = this.keywordAmount(card, 'vanishing');
    if (vanishing) perm.counters.time = (perm.counters.time || 0) + vanishing;
    const fading = this.keywordAmount(card, 'fading');
    if (fading) perm.counters.fade = (perm.counters.fade || 0) + fading;
    if (item?.sunburstColors) {
      if (isCreature(card)) this.applyCounterAdditionEffect(ctx, item.sunburstColors, '+1/+1');
      else perm.counters.charge = (perm.counters.charge || 0) + item.sunburstColors;
      this.log(`${card.name} enters with ${item.sunburstColors} ${isCreature(card) ? '+1/+1' : 'charge'} counter${item.sunburstColors === 1 ? '' : 's'} (sunburst).`);
    }
    // Amplify N: reveal any number of cards in hand sharing a creature type
    // with it — always all of them (revealing costs nothing here).
    const amplify = this.keywordAmount(card, 'amplify');
    if (amplify) {
      const revealed = p.hand.filter(c => this.sharesCreatureType(c, card));
      if (revealed.length) {
        this.log(`${p.name} reveals ${revealed.map(c => c.name).join(', ')} (amplify).`);
        this.applyCounterAdditionEffect(ctx, amplify * revealed.length, '+1/+1');
      }
    }
    // Devour N: sacrifice any number of other creatures; N counters each.
    // AI devours its creature tokens with 1 or less power.
    const devour = this.keywordAmount(card, 'devour');
    if (devour) {
      const others = p.battlefield.filter(x => x.id !== perm.id && isCreature(x.card));
      const fodder = others.filter(x => isTokenCard(x.card) && this.effectivePower(x) <= 1);
      const eat = (victims) => () => {
        const live = victims.filter(v => this.findPermanent(v.id));
        if (!live.length) return;
        this.log(`${card.name} devours ${live.map(v => v.card.name).join(', ')}.`);
        for (const v of live) this.movePermanentToGraveyard(v, { sacrifice: true });
        if (this.findPermanent(perm.id)) this.applyCounterAdditionEffect(ctx, devour * live.length, '+1/+1');
      };
      const options = [{ label: "Don't devour", resolve: () => {} }];
      if (fodder.length) options.push({ label: `Devour your small tokens (${fodder.length})`, resolve: eat(fodder) });
      if (others.length) options.push({ label: `Devour every other creature you control (${others.length})`, resolve: eat(others) });
      if (others.length) this.requestChoice(p.id, `${card.name} — Devour ${devour}`, options, fodder.length ? 1 : 0);
    }
  }

  sharesCreatureType(a, b) {
    const sub = (c) => ((c.typeLine || '').split('—')[1] || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!/creature/i.test(a.typeLine || '')) return false;
    if ((a.keywords || []).includes('changeling') || /\bchangeling\b/i.test(a.oracleText || '')) return true;
    const bs = new Set(sub(b));
    return sub(a).some(t => bs.has(t));
  }

  // Tribute N: an opponent may put N +1/+1 counters on it; its ETB
  // triggers (some checking "if tribute wasn't paid") run after the choice.
  // The AI pays when the unpaid bonus would hurt it (damage, removal, card
  // draw, life loss, tokens), and otherwise lets it be.
  offerTribute(perm, n, then) {
    const opp = this.opponentOf(perm.controllerId);
    const text = (perm.card.oracleText || '').toLowerCase();
    const unpaid = (text.match(/if tribute wasn't paid,([^.]*)/) || [])[1] || '';
    const aiPays = /damage|destroy|draw|loses?|exile|sacrifice|create/.test(unpaid);
    this.requestChoice(opp.id, `${perm.card.name} — Tribute ${n}: put ${n} +1/+1 counter${n > 1 ? 's' : ''} on it?`, [
      { label: `Pay tribute (${n} +1/+1 counter${n > 1 ? 's' : ''})`, resolve: () => {
        perm.tributePaid = true;
        this.log(`${opp.name} pays tribute.`);
        if (this.findPermanent(perm.id)) this.applyCounterAdditionEffect({ controllerId: perm.controllerId, card: perm.card, target: { type: 'permanent', id: perm.id } }, n, '+1/+1');
        then();
      } },
      { label: "Don't pay tribute", resolve: () => { perm.tributePaid = false; this.log(`${opp.name} doesn't pay tribute.`); then(); } },
    ], aiPays ? 0 : 1);
  }

  // Read ahead: choose the starting chapter; earlier chapters don't trigger.
  // The AI starts at chapter I.
  chooseReadAheadChapter(perm) {
    const chapters = interpretSagaChapters(perm.card);
    const max = Math.max(1, ...chapters.flatMap(c => c.numbers));
    const roman = ['I', 'II', 'III', 'IV', 'V', 'VI'];
    this.requestChoice(perm.controllerId, `${perm.card.name} — Read ahead: start at which chapter?`,
      Array.from({ length: max }, (_, i) => ({ label: `Chapter ${roman[i] || i + 1}`, resolve: () => {
        if (!this.findPermanent(perm.id)) return;
        perm.counters.lore = i;
        this.advanceSaga(perm);
      } })), 0);
  }

  // Upkeep: Vanishing (remove a time counter; sacrifice when the last
  // goes), Fading (remove a fade counter; sacrifice if you can't), and
  // Cumulative upkeep (add an age counter, then pay for each or sacrifice).
  // AI pays cumulative upkeep while it's cheap (mana it has spare, or life
  // it can afford).
  tickUpkeepKeywords() {
    const p = this.active;
    for (const perm of [...p.battlefield]) {
      const card = perm.card;
      // Echo: pay its echo cost or sacrifice it, the first upkeep after it
      // came under your control. The AI pays mana or a discard when it can
      // (not a life-total X).
      const echo = perm.echoDue && getEcho(card);
      if (echo) {
        perm.echoDue = false;
        const sac = () => { if (this.findPermanent(perm.id)) { this.log(`${p.name} doesn't pay echo — ${card.name} is sacrificed.`); this.movePermanentToGraveyard(perm, { sacrifice: true }); } };
        const label = echo.mana ? `Pay echo ${echo.mana}` : echo.discard ? 'Pay echo: discard a card' : `Pay echo {${p.life}} (your life total)`;
        const canPay = echo.mana ? this.payableNow(p.id, echo.mana) : echo.discard ? p.hand.length > 0 : this.payableNow(p.id, `{${p.life}}`);
        if (!canPay) { sac(); continue; }
        const pay = () => {
          if (!this.findPermanent(perm.id)) return;
          if (echo.mana) this.payNow(p.id, echo.mana);
          else if (echo.discard) { const c = this.discardFodder(p)[0]; if (c) { this.log(`${p.name} discards ${c.name} for echo.`); this.discardCard(p, c); } }
          else this.payNow(p.id, `{${p.life}}`);
          this.log(`${p.name} pays ${card.name}'s echo.`);
        };
        this.requestChoice(p.id, `${card.name} — Echo`, [{ label, resolve: pay }, { label: `Sacrifice ${card.name}`, resolve: sac }], echo.lifeTotal ? 1 : 0);
        continue;
      }
      if (this.keywordAmount(card, 'vanishing') && perm.counters.time > 0) {
        perm.counters.time -= 1;
        if (perm.counters.time === 0) {
          this.log(`${card.name}'s last time counter is removed — it's sacrificed (vanishing).`);
          this.movePermanentToGraveyard(perm, { sacrifice: true });
          continue;
        }
      }
      if (this.keywordAmount(card, 'fading')) {
        if ((perm.counters.fade || 0) > 0) perm.counters.fade -= 1;
        else {
          this.log(`${card.name} has no fade counters left — it's sacrificed (fading).`);
          this.movePermanentToGraveyard(perm, { sacrifice: true });
          continue;
        }
      }
      const cu = getCumulativeUpkeep(card);
      if (cu) {
        perm.counters.age = (perm.counters.age || 0) + 1;
        const age = perm.counters.age;
        const sacrifice = () => { if (this.findPermanent(perm.id)) { this.log(`${p.name} doesn't pay ${card.name}'s cumulative upkeep — it's sacrificed.`); this.movePermanentToGraveyard(perm, { sacrifice: true }); } };
        if (cu.unsupported) { sacrifice(); continue; }
        const manaTotal = cu.mana ? cu.mana.repeat(age) : '';
        const canPay = cu.mana ? this.payableNow(p.id, manaTotal) : p.life > cu.life * age;
        const pay = () => {
          if (!this.findPermanent(perm.id)) return;
          if (cu.mana ? !this.payNow(p.id, manaTotal) : p.life <= cu.life * age) return sacrifice();
          if (cu.life) p.life -= cu.life * age;
          this.log(`${p.name} pays ${cu.mana ? manaTotal : `${cu.life * age} life`} for ${card.name}'s cumulative upkeep.`);
        };
        const aiPays = canPay && (cu.mana ? totalCmc(parseManaCost(manaTotal)) <= 3 : p.life - cu.life * age >= 10);
        this.requestChoice(p.id, `${card.name} — Cumulative upkeep (${age} age counter${age > 1 ? 's' : ''})`, [
          { label: `Pay ${cu.mana ? manaTotal : `${cu.life * age} life`}`, resolve: pay },
          { label: `Sacrifice ${card.name}`, resolve: sacrifice },
        ], aiPays ? 0 : 1);
      }
    }
    // AI forecasts during its own upkeep (see forecast below).
    if (p.isAI) {
      for (const card of [...p.hand]) if (this.canForecast(p.id, card.instanceId)) { this.forecast(p.id, card.instanceId); break; }
    }
  }

  // Dies: Modular (move its +1/+1 counters onto an artifact creature you
  // control — the AI's best) and Soulshift N (return a Spirit card with
  // mana value N or less from your graveyard to hand — the priciest).
  applyDiesKeywords(diedPerm) {
    const card = diedPerm.card;
    const controller = this.getPlayer(diedPerm.controllerId);
    // The creature it haunts died: each haunting card's effect happens.
    for (const h of diedPerm.hauntedBy || []) this.runHauntEffect(h.card, h.controllerId);
    // Haunt (creature): exile it haunting a creature.
    if (hasHaunt(card) && isCreature(card)) {
      const owner = this.getPlayer(diedPerm.ownerId);
      const gi = owner.graveyard.indexOf(card);
      if (gi !== -1) this.hauntCreature(owner, card, controller.id, () => owner.graveyard.splice(owner.graveyard.indexOf(card), 1));
    }
    const counters = diedPerm.counters?.['+1/+1'] || 0;
    if (this.keywordAmount(card, 'modular') && counters > 0) {
      const targets = controller.battlefield.filter(x => x.id !== diedPerm.id && isCreature(x.card) && isArtifact(x.card) && this.canBeTargetedBy(x, controller.id, card))
        .sort((a, b) => this.effectivePower(b) - this.effectivePower(a)).slice(0, 7);
      if (targets.length) {
        this.requestChoice(controller.id, `${card.name} died — Modular: move its ${counters} +1/+1 counter${counters > 1 ? 's' : ''}?`, [
          ...targets.map(x => ({ label: `Onto ${x.card.name}`, resolve: () => { if (this.findPermanent(x.id)) { this.log(`${card.name}'s modular counters move onto ${x.card.name}.`); this.applyCounterAdditionEffect({ controllerId: controller.id, card, target: { type: 'permanent', id: x.id } }, counters, '+1/+1'); } } })),
          { label: "Don't move them", resolve: () => {} },
        ], 0);
      }
    }
    const soulshift = this.keywordAmount(card, 'soulshift');
    if (soulshift) {
      const owner = this.getPlayer(diedPerm.ownerId);
      const pick = owner.graveyard.filter(c => c !== card && /\bspirit\b/i.test(c.typeLine || '') && (c.cmc || 0) <= soulshift).sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
      if (pick) {
        owner.graveyard.splice(owner.graveyard.indexOf(pick), 1);
        owner.hand.push(pick);
        this.log(`${card.name}'s soulshift returns ${pick.name} to ${owner.name}'s hand.`);
      }
    }
  }

  // Champion a [type]: when it enters, sacrifice it unless you exile
  // another [type] you control; that card returns when this leaves. AI
  // champions its weakest nontoken creature of the type (a token would
  // simply cease to exist), else a token, else sacrifices.
  offerChampion(perm, type) {
    const p = this.getPlayer(perm.controllerId);
    const fits = (x) => x.id !== perm.id && (type === 'creature' ? isCreature(x.card) : (x.card.typeLine || '').toLowerCase().includes(type) || (isCreature(x.card) && /\bchangeling\b/i.test(x.card.oracleText || '')));
    const candidates = p.battlefield.filter(fits).sort((a, b) => (isTokenCard(a.card) - isTokenCard(b.card)) || (this.effectivePower(a) - this.effectivePower(b)));
    const sacrifice = () => { if (this.findPermanent(perm.id)) { this.log(`${perm.card.name} is sacrificed (nothing championed).`); this.movePermanentToGraveyard(perm, { sacrifice: true }); } };
    if (!candidates.length) { sacrifice(); return; }
    const champion = (x) => () => {
      if (!this.findPermanent(perm.id) || !this.findPermanent(x.id)) return sacrifice();
      const owner = this.getPlayer(x.ownerId);
      this.getPlayer(x.controllerId).battlefield = this.getPlayer(x.controllerId).battlefield.filter(y => y.id !== x.id);
      this.detachFromLeavingBattlefield(x);
      this.triggerLeavesBattlefield(x);
      if (!isTokenCard(x.card)) { owner.exile.push(x.card); perm.championed = { card: x.card, ownerId: x.ownerId }; }
      this.log(`${perm.card.name} champions ${x.card.name}.`);
    };
    this.requestChoice(p.id, `${perm.card.name} — Champion a ${type}`, [
      ...candidates.slice(0, 7).map(x => ({ label: `Exile ${x.card.name}`, resolve: champion(x) })),
      { label: `Sacrifice ${perm.card.name} instead`, resolve: sacrifice },
    ], 0);
  }

  // Hideaway N: when it enters, look at the top N cards, exile one face
  // down (the AI's priciest nonland), put the rest on the bottom.
  applyHideaway(perm) {
    const n = this.keywordAmount(perm.card, 'hideaway');
    if (!n) return;
    const p = this.getPlayer(perm.controllerId);
    const looked = p.library.splice(0, n);
    if (!looked.length) return;
    const finish = (pick) => () => {
      perm.hideaway = pick;
      p.exile.push(pick);
      p.library.push(...shuffle(looked.filter(c => c !== pick)));
      this.log(`${p.name} exiles a card face down with ${perm.card.name} (hideaway).`);
    };
    const ranked = looked.slice().sort((a, b) => (isLand(a) - isLand(b)) || ((b.cmc || 0) - (a.cmc || 0)));
    this.requestChoice(p.id, `${perm.card.name} — Hideaway: exile which card?`, ranked.map(c => ({ label: c.name, resolve: finish(c) })), 0);
  }

  // A hideaway land's payoff — play the exiled card free if the condition
  // holds. Conditions understood: total power N or greater, attacked with N
  // or more creatures this turn, a library with N or fewer cards, each
  // player having N or fewer cards in hand; anything else counts as unmet.
  applyHideawayPlay(ctx, condition) {
    const perm = ctx.sourcePerm;
    const p = this.getPlayer(ctx.controllerId);
    const card = perm?.hideaway;
    if (!card || !p.exile.includes(card)) { this.log(`${ctx.card.name} has no hidden card.`); return; }
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, twenty: 20 };
    const num = (t) => words[t] ?? parseInt(t, 10);
    let ok = !condition;
    let m;
    if (condition) {
      if ((m = condition.match(/creatures you control have total power (\w+) or greater/))) ok = p.battlefield.filter(x => isCreature(x.card)).reduce((a, x) => a + this.effectivePower(x), 0) >= num(m[1]);
      else if ((m = condition.match(/you attacked with (\w+) or more creatures this turn/))) ok = p.battlefield.filter(x => x.attackedThisTurn).length >= num(m[1]);
      else if ((m = condition.match(/a library has (\w+) or fewer cards in it/))) ok = this.players.some(pl => pl.library.length <= num(m[1]));
      else if ((m = condition.match(/each player has (\w+) or fewer cards in hand/))) ok = this.players.every(pl => pl.hand.length <= num(m[1]));
    }
    if (!ok) { this.log(`${ctx.card.name}'s condition isn't met — the hidden card stays exiled.`); return; }
    p.exile.splice(p.exile.indexOf(card), 1);
    perm.hideaway = null;
    if (isLand(card)) {
      const land = makePermanent(card, p.id);
      p.battlefield.push(land);
      this.log(`${p.name} plays ${card.name} from hideaway.`);
      this.triggerETB(land);
    } else if (!this.castFromOutsideHand(p.id, card, { free: true, fromZone: 'exile', onFail: () => { p.exile.push(card); perm.hideaway = card; } })) {
      p.exile.push(card);
      perm.hideaway = card;
      this.log(`${card.name} can't be cast right now.`);
    } else this.log(`${p.name} casts ${card.name} from hideaway for free.`);
  }

  // Exhaust abilities work once per permanent; Boast abilities only if the
  // creature attacked this turn, once per turn.
  abilityUseAllowed(perm, ability) {
    // Formidable-style "Activate only if COND".
    if (ability.activateOnlyIf) { const test = parseCondition(ability.activateOnlyIf); if (test && !test(this, { controllerId: perm.controllerId, sourcePerm: perm, card: perm.card })) return false; }
    // Grandeur: needs another card with this name in hand.
    if (ability.discardNamed && !this.getPlayer(perm.controllerId).hand.some(c => c.name === perm.card.name)) return false;
    if (ability.maxSpeed && (this.getPlayer(perm.controllerId)?.speed || 0) < 4) return false;
    if (ability.exhaust && (perm.exhaustUsed || []).includes(ability.effectText)) return false;
    if (ability.boast && (!perm.attackedThisTurn || perm.boastedThisTurn)) return false;
    return true;
  }

  markAbilityUsed(perm, ability) {
    if (ability.exhaust) (perm.exhaustUsed ||= []).push(ability.effectText);
    if (ability.boast) perm.boastedThisTurn = true;
  }

  // Forecast: reveal from hand during your upkeep, once per turn, pay the
  // cost, get the effect (targets auto-picked). Reinforce N: pay the cost,
  // discard the card, put N +1/+1 counters on target creature.
  canForecast(playerId, instanceId) {
    const p = this.getPlayer(playerId);
    if (this.gameOver || this.pendingRequest || this.step !== 'upkeep' || this.active.id !== playerId || p.forecastThisTurn || this.splitSecondActive()) return false;
    const card = p.hand.find(c => c.instanceId === instanceId);
    const fc = card && getForecast(card);
    if (!fc || !this.payableNow(playerId, fc.manaCost)) return false;
    return minRequiredTargetCount(fc.steps) <= pickTargetsForKinds(this, card, playerId, expandTargetKinds(fc.steps)).filter(Boolean).length;
  }

  forecast(playerId, instanceId) {
    if (!this.canForecast(playerId, instanceId)) return { ok: false, reason: "Can't forecast that right now." };
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    const fc = getForecast(card);
    this.payNow(playerId, fc.manaCost);
    p.forecastThisTurn = true;
    this.log(`${p.name} reveals ${card.name} (forecast).`);
    const targets = pickTargetsForKinds(this, card, playerId, expandTargetKinds(fc.steps)).filter(Boolean);
    this.resolveEffectSteps(fc.steps, targets, { controllerId: playerId, card });
    this.checkStateBasedActions();
    this.afterAction(playerId);
    return { ok: true };
  }

  canReinforce(playerId, instanceId) {
    if (this.gameOver || this.pendingRequest || this.priorityPlayer.id !== playerId || this.splitSecondActive()) return false;
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    const rf = card && getReinforce(card);
    return !!(rf && rf.amount !== 'x' && this.payableNow(playerId, rf.manaCost) && this.players.some(pl => pl.battlefield.some(x => isCreature(x.card) && this.canBeTargetedBy(x, playerId, card))));
  }

  reinforce(playerId, instanceId, targetPermId) {
    if (!this.canReinforce(playerId, instanceId)) return { ok: false, reason: "Can't reinforce right now." };
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    const target = this.findPermanent(targetPermId);
    if (!target || !isCreature(target.card)) return { ok: false, reason: 'Reinforce needs a target creature.' };
    const rf = getReinforce(card);
    this.payNow(playerId, rf.manaCost);
    this.log(`${p.name} reinforces ${target.card.name} with ${card.name}.`);
    this.discardCard(p, card);
    if (!this.checkWardAndMaybeCounter(playerId, [{ type: 'permanent', id: target.id }])) {
      this.applyCounterAdditionEffect({ controllerId: playerId, card, target: { type: 'permanent', id: target.id } }, rf.amount, '+1/+1');
    }
    this.afterAction(playerId);
    return { ok: true };
  }

  getForecast(card) { return getForecast(card); }
  getReinforce(card) { return getReinforce(card); }

  // ---------- Rebound ----------
  // At the beginning of your upkeep, each card you rebounded may be cast
  // from exile without paying its mana cost. The AI always does (if it
  // has targets); a human chooses. Not cast: it stays in exile.
  tickRebound() {
    const p = this.active;
    const cards = p.rebounding || [];
    if (!cards.length) return;
    p.rebounding = [];
    for (const card of cards) {
      const castIt = () => {
        if (!this.castFromOutsideHand(p.id, card, { free: true, fromZone: 'exile', viaRebound: true, onFail: () => p.exile.push(card) })) {
          this.log(`${card.name} can't be cast from rebound right now; it stays in exile.`);
          p.exile.push(card);
          return;
        }
        const item = this.stack.find(x => x.card === card);
        if (item) item.viaRebound = true;
        this.log(`${p.name} casts ${card.name} from exile (rebound).`);
      };
      this.requestChoice(p.id, `${card.name} — Rebound`, [
        { label: `Cast ${card.name} for free`, resolve: castIt },
        { label: 'Leave it in exile', resolve: () => p.exile.push(card) },
      ], 0);
    }
  }

  // ---------- Dredge ----------
  // "If you would draw a card, you may mill N cards instead. If you do,
  // return this card from your graveyard to your hand." Needs N cards in
  // the library. The AI dredges any non-land dredge card while its library
  // is comfortably deep; a human is offered it for the draw step's draw.
  dredgeOptions(player) {
    return player.graveyard.filter(c => { const n = getDredgeAmount(c); return n > 0 && player.library.length >= n; });
  }

  aiDredgeChoice(player) {
    return this.dredgeOptions(player)
      .filter(c => !isLand(c) && player.library.length >= getDredgeAmount(c) + 10)
      .sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0] || null;
  }

  dredge(player, card) {
    const n = getDredgeAmount(card);
    const i = player.graveyard.indexOf(card);
    if (i === -1 || player.library.length < n) return false;
    player.graveyard.splice(i, 1);
    const milled = player.library.splice(0, n);
    player.graveyard.push(...milled);
    player.hand.push(card);
    this.log(`${player.name} dredges ${card.name} (mills ${n}) instead of drawing.`);
    return true;
  }

  // ---------- Recover ----------
  // "When a creature is put into your graveyard from the battlefield, you
  // may pay [cost]. If you do, return this card from your graveyard to
  // your hand. Otherwise, exile this card." AI pays when it can.
  triggerRecover(owner, diedCard) {
    for (const card of owner.graveyard.filter(c => c !== diedCard && getRecoverCost(c))) {
      const cost = getRecoverCost(card);
      const payBack = () => {
        const i = owner.graveyard.indexOf(card);
        if (i === -1) return;
        const parsed = parseManaCost(cost);
        const payment = this.planSpellPayment(owner.id, card, parsed, 0);
        if (!payment) return exile();
        this.applySpellPayment(owner.id, card, payment);
        owner.graveyard.splice(i, 1);
        owner.hand.push(card);
        this.log(`${owner.name} pays ${cost} to recover ${card.name} to their hand.`);
      };
      const exile = () => {
        const i = owner.graveyard.indexOf(card);
        if (i === -1) return;
        owner.graveyard.splice(i, 1);
        owner.exile.push(card);
        this.log(`${card.name} is exiled (recover not paid).`);
      };
      const affordable = !!this.planSpellPayment(owner.id, card, parseManaCost(cost), 0);
      this.requestChoice(owner.id, `${diedCard.name} died — Recover ${card.name} for ${cost}?`, [
        { label: `Pay ${cost} and return ${card.name} to hand`, resolve: payBack },
        { label: `Exile ${card.name}`, resolve: exile },
      ], affordable ? 0 : 1);
    }
  }

  // ---------- Foretell / Plot ----------
  // Foretell: during your turn, pay {2} and exile the card from your hand
  // face down; cast it on a later turn for its foretell cost. Plot: pay the
  // plot cost and exile it (sorcery speed); cast it free, as a sorcery, on
  // a later turn. Both live in exiledPlayable (see playCardFromExile).
  canForetell(playerId, instanceId) {
    if (this.gameOver || this.pendingRequest || this.priorityPlayer.id !== playerId || this.active.id !== playerId) return false;
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    return !!(card && getForetellCost(card) && this.payableNow(playerId, '{2}'));
  }

  foretell(playerId, instanceId) {
    if (!this.canForetell(playerId, instanceId)) return { ok: false, reason: "Can't foretell that right now." };
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    this.payNow(playerId, '{2}');
    p.hand.splice(p.hand.indexOf(card), 1);
    p.exiledPlayable.push({ id: uid('exile'), card, remainingOwnTurns: Infinity, kind: 'foretell', costOverride: getForetellCost(card), notOnTurn: this.turnNumber });
    this.log(`${p.name} foretells a card (exiled face down).`);
    this.afterAction(playerId);
    return { ok: true };
  }

  canPlot(playerId, instanceId) {
    if (this.gameOver || this.pendingRequest || this.priorityPlayer.id !== playerId) return false;
    const p = this.getPlayer(playerId);
    if (!(p.id === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    const card = p.hand.find(c => c.instanceId === instanceId);
    return !!(card && getPlotCost(card) && this.payableNow(playerId, getPlotCost(card)));
  }

  plot(playerId, instanceId) {
    if (!this.canPlot(playerId, instanceId)) return { ok: false, reason: "Can't plot that right now." };
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    this.payNow(playerId, getPlotCost(card));
    p.hand.splice(p.hand.indexOf(card), 1);
    p.exiledPlayable.push({ id: uid('exile'), card, remainingOwnTurns: Infinity, kind: 'plot', free: true, sorceryOnly: true, notOnTurn: this.turnNumber });
    this.log(`${p.name} plots ${card.name}.`);
    this.afterAction(playerId);
    return { ok: true };
  }

  // Paying a plain mana cost outside of casting (foretell's {2}, a plot
  // cost) — lands and the mana pool only.
  payableNow(playerId, cost) {
    const p = this.getPlayer(playerId);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    return !!planManaPayment(untapped, parseManaCost(cost), 0, p.manaPool);
  }

  payNow(playerId, cost) {
    const p = this.getPlayer(playerId);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parseManaCost(cost), 0, p.manaPool);
    if (!payment) return false;
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    return true;
  }

  getForetellCost(card) { return getForetellCost(card); }
  getPlotCost(card) { return getPlotCost(card); }
  getMadnessCost(card) { return getMadnessCost(card); }

  // ---------- Suspend ----------
  // "Rather than cast this card from your hand, you may pay [cost] and exile
  // it with N time counters on it." Usable whenever the card could be cast
  // (an instant at instant speed, otherwise sorcery speed).

  getSuspendInfo(card) { return getSuspendInfo(card); }

  canSuspend(playerId, instanceId) {
    if (this.gameOver || this.pendingRequest) return false;
    if (this.priorityPlayer.id !== playerId) return false;
    const p = this.getPlayer(playerId);
    const card = p.hand.find(c => c.instanceId === instanceId);
    const info = card && getSuspendInfo(card);
    if (!info) return false;
    const instantSpeed = isInstant(card) || /flash/.test((card.keywords || []).join(','));
    if (!instantSpeed && !(p.id === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    return !!planManaPayment(untapped, parseManaCost(info.manaCost), 0, p.manaPool);
  }

  suspend(playerId, instanceId) {
    if (!this.canSuspend(playerId, instanceId)) return { ok: false, reason: 'Cannot suspend that right now.' };
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    const card = p.hand[idx];
    const info = getSuspendInfo(card);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parseManaCost(info.manaCost), 0, p.manaPool);
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    p.hand.splice(idx, 1);
    p.suspended.push({ card, timeCounters: info.time });
    this.log(`${p.name} suspends ${card.name} with ${info.time} time counter${info.time === 1 ? '' : 's'}.`);
    this.afterAction(playerId);
    return { ok: true };
  }

  // At the beginning of its owner's upkeep, each suspended card loses a
  // time counter; when the last comes off it's cast without paying its
  // mana cost (a creature cast this way gains haste — see resolveTop's
  // viaSuspend). One it can't be cast (no legal target) stays exiled.
  tickSuspended() {
    const p = this.active;
    for (const entry of [...p.suspended]) {
      entry.timeCounters -= 1;
      if (entry.timeCounters > 0) {
        this.log(`${entry.card.name} loses a time counter (${entry.timeCounters} left).`);
        continue;
      }
      p.suspended = p.suspended.filter(e => e !== entry);
      this.log(`The last time counter is removed from ${entry.card.name}.`);
      if (!this.castFromOutsideHand(p.id, entry.card, { free: true, viaSuspend: true, onFail: () => p.exile.push(entry.card) })) {
        p.exile.push(entry.card);
        this.log(`${entry.card.name} can't be cast and stays exiled.`);
      }
    }
  }

  // ---------- Miracle ----------
  // "You may cast this card for its miracle cost when you draw it if it's
  // the first card you drew this turn." Called from drawCard. The AI casts
  // it when affordable and worthwhile (a board wipe only when it hurts the
  // opponent more); a human is asked.
  offerMiracle(player, card) {
    const cost = getMiracleCost(card);
    if (!cost || this.gameOver) return;
    const parsed = parseManaCost(cost);
    let xValue = 0;
    if (parsed.x > 0) {
      const p = player;
      const bound = p.battlefield.filter(x => isLand(x.card) && !x.tapped).length + Object.values(p.manaPool).reduce((a, b) => a + b, 0);
      for (let x = bound; x >= 1; x--) if (this.planSpellPayment(player.id, card, parsed, x)) { xValue = x; break; }
      if (xValue === 0) return;
    } else if (!this.planSpellPayment(player.id, card, parsed, 0)) {
      return;
    }
    const cast = () => {
      if (!player.hand.includes(card)) return;
      if (this.castFromOutsideHand(player.id, card, { costOverride: cost, xValue })) {
        this.log(`${player.name} casts ${card.name} for its miracle cost.`);
      }
    };
    if (player.isAI) {
      const text = (card.oracleText || '').toLowerCase();
      if (/\ball creatures\b|\beach creature\b/.test(text)) {
        const power = pl => pl.battlefield.filter(x => isCreature(x.card)).reduce((s, x) => s + this.effectivePower(x), 0);
        if (power(this.opponentOf(player.id)) <= power(player)) return;
      }
      cast();
      return;
    }
    this.requestChoice(player.id, `Miracle — ${card.name}`, [
      { label: `Cast ${card.name} for its miracle cost ${cost}${xValue ? ` (X=${xValue})` : ''}`, resolve: cast },
      { label: 'Keep it in hand', resolve: () => {} },
    ]);
  }

  // ---------- Transmute ----------
  // "{cost}, Discard this card: Search your library for a card with the same
  // mana value as this card, reveal it, put it into your hand, then
  // shuffle. Transmute only as a sorcery." Picks a nonland card with a
  // different name when there is one (no real choose-a-card UI).

  getTransmuteCost(card) { return getTransmuteCost(card); }

  canTransmute(playerId, instanceId) {
    if (this.gameOver || this.pendingRequest) return false;
    const p = this.getPlayer(playerId);
    if (!(p.id === this.active.id && this.priorityPlayer.id === playerId && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    const card = p.hand.find(c => c.instanceId === instanceId);
    const cost = card && getTransmuteCost(card);
    if (!cost) return false;
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    return !!planManaPayment(untapped, parseManaCost(cost), 0, p.manaPool);
  }

  transmute(playerId, instanceId) {
    if (!this.canTransmute(playerId, instanceId)) return { ok: false, reason: 'Cannot transmute that right now.' };
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    const card = p.hand[idx];
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parseManaCost(getTransmuteCost(card)), 0, p.manaPool);
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    this.log(`${p.name} transmutes ${card.name}.`);
    this.discardCard(p, card);
    const sameCmc = p.library.filter(c => (c.cmc || 0) === (card.cmc || 0));
    const pick = sameCmc.find(c => !isLand(c) && c.name !== card.name) || sameCmc[0];
    if (pick) {
      p.library = p.library.filter(c => c !== pick);
      p.hand.push(pick);
      this.log(`${card.name} finds ${pick.name}.`);
    } else {
      this.log(`${card.name} finds no card with mana value ${card.cmc || 0}.`);
    }
    p.library = shuffle(p.library);
    this.afterAction(playerId);
    return { ok: true };
  }

  // N from a numbered keyword line on the card's own text ("Bushido 2",
  // "Afflict 1", "Renown 1", "Afterlife 3"), or 0. Reminder text stripped.
  keywordAmount(card, keyword) {
    const text = (card.oracleText || '').replace(/\([^()]*\)/g, '');
    const m = text.match(new RegExp(`(?:^|,\\s*)${keyword} (\\d+)`, 'im'));
    return m ? parseInt(m[1], 10) : 0;
  }

  // "Whenever this creature attacks" keyword triggers that care about the
  // whole attack: Mentor (a +1/+1 counter on another attacker with lesser
  // power — auto-picks the strongest such, which is what you'd want) and
  // Training (a counter on itself if it attacks alongside something with
  // greater power). Decayed attackers are marked to be sacrificed at end
  // of combat.
  applyAttackKeywordTriggers(attackers) {
    for (const perm of [...attackers]) {
      const owner = this.getPlayer(perm.controllerId);
      // Mobilize N: N tapped-and-attacking 1/1 red Warriors, sacrificed at
      // the next end step.
      const mob = getMobilize(perm.card);
      const mobN = mob ? (mob.amount ?? owner.graveyard.filter(c => isCreature(c)).length) : 0;
      for (let i = 0; i < mobN; i++) {
        this.applyTokenEffect({ controllerId: owner.id, card: perm.card }, 1, 1, 1, 'red warrior');
        const w = owner.battlefield[owner.battlefield.length - 1];
        Object.assign(w, { tapped: true, attacking: true, attackedThisTurn: true, attackTarget: perm.attackTarget, blockedBy: [], sacrificeAtEndStep: true });
      }
      if (mobN) this.log(`${perm.card.name} mobilizes ${mobN} Warrior${mobN > 1 ? 's' : ''}.`);
      // Firebending N: add N {R} that lasts until end of combat.
      const fb = getFirebending(perm.card);
      const fbN = fb ? (fb.amount ?? this.effectivePower(perm)) : 0;
      if (fbN > 0) {
        owner.manaPool.R += fbN;
        owner.firebendLeft = (owner.firebendLeft || 0) + fbN;
        this.log(`${perm.card.name} firebends: ${owner.name} adds ${'{R}'.repeat(fbN)} until end of combat.`);
      }
    }
    for (const perm of attackers) {
      const kws = this.effectiveKeywords(perm);
      const power = this.effectivePower(perm);
      if (kws.has('mentor')) {
        const pupils = attackers.filter(o => o.id !== perm.id && this.effectivePower(o) < power && this.canBeTargetedBy(o, perm.controllerId, perm.card));
        if (pupils.length > 0) {
          const pupil = pupils.sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
          this.log(`Mentor: ${perm.card.name} mentors ${pupil.card.name}.`);
          this.applyCounterAdditionEffect({ controllerId: perm.controllerId, card: perm.card, target: { type: 'permanent', id: pupil.id } }, 1, '+1/+1');
        }
      }
      if (kws.has('training') && attackers.some(o => o.id !== perm.id && this.effectivePower(o) > power)) {
        this.log(`Training: ${perm.card.name} trains.`);
        this.applyCounterAdditionEffect({ controllerId: perm.controllerId, card: perm.card, target: { type: 'permanent', id: perm.id } }, 1, '+1/+1');
      }
      if (kws.has('decayed')) perm.sacrificeAtEndOfCombat = true;

      const controller = this.getPlayer(perm.controllerId);
      const defending = this.opponentOf(perm.controllerId);
      // Battle cry: each OTHER attacking creature gets +1/+0.
      if (kws.has('battle cry')) {
        for (const o of attackers) if (o.id !== perm.id) o.tempBuffs.push({ power: 1, toughness: 0 });
        this.log(`Battle cry: ${perm.card.name} gives each other attacker +1/+0.`);
      }
      // Dethrone: +1/+1 counter if attacking the player with the most life
      // (or tied) — in two-player, the defender at least as high as us.
      if (kws.has('dethrone') && perm.attackTarget?.type !== 'planeswalker' && defending.life >= controller.life) {
        this.log(`Dethrone: ${perm.card.name} attacks the player with the most life.`);
        this.applyCounterAdditionEffect({ controllerId: perm.controllerId, card: perm.card, target: { type: 'permanent', id: perm.id } }, 1, '+1/+1');
      }
      // Melee: +1/+1 for each opponent attacked this combat (one, here).
      if (kws.has('melee')) {
        perm.tempBuffs.push({ power: 1, toughness: 1 });
        this.log(`Melee: ${perm.card.name} gets +1/+1 until end of turn.`);
      }
      // Annihilator N: the defending player sacrifices N permanents —
      // tokens first, then lands, then the cheapest (no choice UI; same
      // auto-pick simplification as edicts).
      const annihilator = this.keywordAmount(perm.card, 'annihilator');
      if (annihilator > 0) {
        const ranked = defending.battlefield.slice().sort((a, b) => {
          const rank = x => (/\btoken\b/i.test(x.card.typeLine || '') ? 0 : isLand(x.card) ? 1 : 2);
          return rank(a) - rank(b) || (a.card.cmc || 0) - (b.card.cmc || 0);
        });
        const victims = ranked.slice(0, annihilator);
        if (victims.length) this.log(`Annihilator ${annihilator}: ${defending.name} sacrifices ${victims.map(v => v.card.name).join(', ')}.`);
        for (const v of victims) this.movePermanentToGraveyard(v, { sacrifice: true });
      }
      // Provoke: untap target creature the defending player controls; it
      // blocks this attacker if able (enforced in declareBlockers). Picks a
      // creature this attacker would kill and survive, else skips.
      if (kws.has('provoke')) {
        const power = this.effectivePower(perm), toughness = this.effectiveToughness(perm);
        const target = defending.battlefield
          .filter(x => isCreature(x.card) && this.canBeTargetedBy(x, perm.controllerId, perm.card))
          .filter(x => this.effectiveToughness(x) <= power && this.effectivePower(x) < toughness)
          .sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
        if (target) {
          target.tapped = false;
          target.provokedBy = perm.id;
          this.log(`Provoke: ${perm.card.name} provokes ${target.card.name}.`);
        }
      }
      // Enlist: tap a non-attacking creature you control that could attack
      // to add its power to this one. The AI enlists its strongest spare
      // creature when it isn't outnumbered on board (that creature then
      // can't block next turn); a human is asked.
      if (kws.has('enlist')) {
        const eligible = controller.battlefield.filter(x => x.id !== perm.id && !x.attacking && !x.tapped && isCreature(x.card) && this.canDeclareAsAttacker(x))
          .sort((a, b) => this.effectivePower(b) - this.effectivePower(a));
        if (eligible.length > 0) {
          const enlist = (helper) => () => {
            if (!this.findPermanent(helper.id) || helper.tapped) return;
            helper.tapped = true;
            const bonus = this.effectivePower(helper);
            perm.tempBuffs.push({ power: bonus, toughness: 0 });
            this.log(`Enlist: ${helper.card.name} is tapped to give ${perm.card.name} +${bonus}/+0.`);
          };
          const options = [{ label: "Don't enlist", resolve: () => {} }, ...eligible.slice(0, 5).map(h => ({ label: `Enlist ${h.card.name} (+${this.effectivePower(h)}/+0)`, resolve: enlist(h) }))];
          const theirCreatures = defending.battlefield.filter(x => isCreature(x.card)).length;
          const aiPick = controller.battlefield.filter(x => isCreature(x.card)).length > theirCreatures ? 1 : 0;
          this.requestChoice(perm.controllerId, `${perm.card.name} — Enlist`, options, aiPick);
        }
      }
    }
  }

  // "Whenever this creature blocks or becomes blocked" keyword triggers,
  // checked once blocks are locked in: Bushido N (+N/+N until end of turn,
  // for blockers and blocked attackers alike) and Afflict N (the defending
  // player loses N life when this attacker becomes blocked).
  applyBlockKeywordTriggers() {
    for (const pl of this.players) {
      for (const perm of pl.battlefield) {
        const isBlocking = !!perm.blocking;
        const isBlocked = perm.attacking && perm.blockedBy.length > 0;
        if (!isBlocking && !isBlocked) continue;
        const bushido = this.keywordAmount(perm.card, 'bushido');
        if (bushido > 0) {
          perm.tempBuffs.push({ power: bushido, toughness: bushido });
          this.log(`Bushido: ${perm.card.name} gets +${bushido}/+${bushido} until end of turn.`);
        }
        // Rampage N: +N/+N for each creature blocking it beyond the first.
        const rampage = isBlocked ? this.keywordAmount(perm.card, 'rampage') : 0;
        if (rampage > 0 && perm.blockedBy.length > 1) {
          const n = rampage * (perm.blockedBy.length - 1);
          perm.tempBuffs.push({ power: n, toughness: n });
          this.log(`Rampage: ${perm.card.name} gets +${n}/+${n} until end of turn.`);
        }
        // Flanking: each blocker without flanking gets -1/-1.
        if (isBlocked && this.effectiveKeywords(perm).has('flanking')) {
          for (const id of perm.blockedBy) {
            const b = this.findPermanent(id);
            if (b && !this.effectiveKeywords(b).has('flanking')) {
              b.tempBuffs.push({ power: -1, toughness: -1 });
              this.log(`Flanking: ${b.card.name} gets -1/-1 for blocking ${perm.card.name}.`);
            }
          }
        }
        const afflict = isBlocked ? this.keywordAmount(perm.card, 'afflict') : 0;
        if (afflict > 0) {
          const defending = this.opponentOf(perm.controllerId);
          defending.life -= afflict;
          this.log(`Afflict: ${perm.card.name} became blocked — ${defending.name} loses ${afflict} life.`);
        }
      }
    }
    // Frenzy N: "whenever this attacks and isn't blocked, +N/+0".
    for (const perm of this.active.battlefield) {
      if (!perm.attacking || perm.blockedBy.length > 0) continue;
      const frenzy = this.keywordAmount(perm.card, 'frenzy');
      if (frenzy > 0) {
        perm.tempBuffs.push({ power: frenzy, toughness: 0 });
        this.log(`Frenzy: ${perm.card.name} isn't blocked and gets +${frenzy}/+0.`);
      }
    }
    this.checkStateBasedActions();
  }

  // Decayed: "When this creature attacks, sacrifice it at end of combat."
  exileEndOfCombatTokens() {
    for (const pl of this.players) for (const perm of pl.battlefield.filter(x => x.exileAtEndOfCombat)) {
      pl.battlefield = pl.battlefield.filter(x => x !== perm);
      this.detachFromLeavingBattlefield(perm);
      this.triggerLeavesBattlefield(perm);
      this.log(`${perm.card.name} is exiled at end of combat.`);
    }
  }

  sacrificeDecayedAttackers() {
    for (const pl of this.players) {
      for (const perm of pl.battlefield.filter(x => x.sacrificeAtEndOfCombat)) {
        this.log(`${perm.card.name} is sacrificed at end of combat (decayed).`);
        this.movePermanentToGraveyard(perm, { sacrifice: true });
      }
    }
  }

  // Exalted: "whenever a creature you control attacks alone, that creature
  // gets +1/+1 until end of turn" — one trigger per exalted instance the
  // attacking player controls, on any permanent type (Cathedral of War is
  // a land, Finest Hour an enchantment), so they stack.
  applyExalted(playerId, attacker) {
    const p = this.getPlayer(playerId);
    const count = p.battlefield.filter(perm => this.effectiveKeywords(perm).has('exalted')).length;
    if (count === 0) return;
    attacker.tempBuffs.push({ power: count, toughness: count });
    this.log(`Exalted: ${attacker.card.name} attacks alone and gets +${count}/+${count} until end of turn.`);
  }

  // Unearth's "if it would leave the battlefield, exile it instead" — called
  // by each battlefield-to-graveyard/hand path right before it would put
  // the card in its destination zone. Returns true when it handled the move.
  exileIfUnearthed(perm) {
    if (!perm.unearthed) return false;
    this.getPlayer(perm.ownerId).exile.push(perm.card);
    this.log(`${perm.card.name} is exiled instead (unearth).`);
    return true;
  }

  // Unearth's other half: "exile it at the beginning of the next end step."
  // Unearth is sorcery-speed, so the next end step is always this same
  // turn's — no per-permanent turn bookkeeping needed.
  exileUnearthedPermanents() {
    for (const p of this.players) {
      for (const perm of p.battlefield.filter(x => x.unearthed)) {
        p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
        this.detachFromLeavingBattlefield(perm);
        this.triggerLeavesBattlefield(perm);
        this.getPlayer(perm.ownerId).exile.push(perm.card);
        this.log(`${perm.card.name} is exiled at the beginning of the end step (unearth).`);
      }
    }
  }

  // ---------- equip (Equipment's "Equip {cost}" ability) ----------

  // null if this permanent has no equip ability, else its cost as written
  // (e.g. "{1}"). A separate concept from tap abilities: equip has no {T} in
  // its cost and — unlike tap abilities — is sorcery-speed only.
  getEquipCost(perm) {
    // Kíli the Resourceful: with an enduring story, the first equip each
    // turn may cost {0}.
    const p = this.getPlayer(perm.controllerId);
    if (p?.enduringStory && p.kiliEquipTurn !== this.turnNumber && p.battlefield.some(x => /you may pay \{0\} rather than pay the equip cost of the first equip ability you activate each turn/i.test(x.card.oracleText || ''))) return '{0}';
    return interpretEquipCost(perm.card);
  }

  // Attack taxes on the defending player's side: Propaganda / Ghostly
  // Prison ("Creatures can't attack you unless their controller pays {2}
  // for each creature they control that's attacking you"), Collective
  // Restraint (X = Domain), Dáin (conditional, {1}). The cost per attacker.
  attackTaxPerCreature(defenderId) {
    let total = 0;
    for (const src of this.getPlayer(defenderId).battlefield) {
      const text = stripAbilityWords(replaceSelfNameExport(src.card, src.card.oracleText || '', 'this creature').toLowerCase());
      const m = text.match(/(?:as long as ([^,]+), )?creatures can'?t attack you(?: or planeswalkers you control)? unless their controller pays \{(\d+|x)\} for each (?:creature they control that'?s attacking you|of those creatures)(?:, where x is ([^.]+))?/);
      if (!m) continue;
      const ctx = { controllerId: defenderId, sourcePerm: src, card: src.card };
      if (m[1] && !(parseCondition(m[1])?.(this, ctx))) continue;
      total += m[2] === 'x' ? (parseCount(m[3] || '')?.(this, ctx) || 0) : parseInt(m[2], 10);
    }
    return total;
  }

  // "Equip abilities you activate that target this creature cost {N} less
  // to activate" (Fervent Champion) — keyed on the EQUIP TARGET (the
  // creature being equipped onto), not the Equipment or its cost type the
  // way getCastCostReduction/getOtherSourceCostReduction work, so this
  // scans for a grantor whose own permanent IS the target.
  getEquipCostReduction(controllerId, targetPermId) {
    const controller = this.getPlayer(controllerId);
    let total = 0;
    for (const perm of controller.battlefield) {
      if (perm.id !== targetPermId) continue;
      const text = (perm.card.oracleText || '').toLowerCase();
      const m = text.match(/equip abilities you activate that target (?:this creature|this permanent|it) cost \{(\d+)\} less to activate/);
      if (m) total += parseInt(m[1], 10);
    }
    return total;
  }

  affordabilityForEquip(playerId, equipPerm) {
    const cost = this.getEquipCost(equipPerm);
    if (!cost) return false;
    const p = this.getPlayer(playerId);
    const parsed = parseManaCost(cost);
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
  }

  canActivateEquip(playerId, equipPermId) {
    if (this.gameOver || this.pendingRequest) return false;
    if (this.priorityPlayer.id !== playerId || this.active.id !== playerId) return false;
    if (this.step !== 'main1' && this.step !== 'main2') return false;
    if (this.stack.length > 0) return false;
    const perm = this.findPermanent(equipPermId);
    if (!perm || perm.controllerId !== playerId) return false;
    return !!this.getEquipCost(perm);
  }

  // Equipment can only attach to a creature its controller controls — real
  // rules restriction, unlike Auras which (in this engine) can target any
  // creature.
  activateEquip(playerId, equipPermId, targetPermId) {
    if (!this.canActivateEquip(playerId, equipPermId)) return { ok: false, reason: 'Cannot equip right now.' };
    const equipPerm = this.findPermanent(equipPermId);
    const target = this.findPermanent(targetPermId);
    if (!target || target.controllerId !== playerId || !isCreature(target.card)) {
      return { ok: false, reason: 'Must target a creature you control.' };
    }
    if (this.isProtectedFrom(target, equipPerm.card)) return { ok: false, reason: `${target.card.name} has protection from ${equipPerm.card.name}.` };

    const p = this.getPlayer(playerId);
    const equipCost = this.getEquipCost(equipPerm);
    if (equipCost === '{0}') this.getPlayer(playerId).kiliEquipTurn = this.turnNumber;
    const parsed = parseManaCost(equipCost);
    parsed.generic = Math.max(0, parsed.generic - this.getEquipCostReduction(playerId, target.id));
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
    if (!payment) return { ok: false, reason: 'Not enough mana.' };

    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];

    equipPerm.attachedTo = target.id;
    this.log(`${p.name} attaches ${equipPerm.card.name} to ${target.card.name}.`);
    this.afterAction(playerId);
    return { ok: true };
  }

  // ---------- spell effect implementations (called from effects.js) ----------

  // Damage to a creature from a source with these keywords: Infect and
  // Wither deal it as -1/-1 counters instead of marked damage.
  damageCreature(target, amount, sourceKws) {
    // Absorb N: prevent N of each damage event (printed, or granted —
    // Lymph Sliver's "All Sliver creatures have absorb 1").
    const absorb = this.absorbAmount(target);
    if (absorb > 0 && amount > 0) {
      amount = Math.max(0, amount - absorb);
      this.log(`${target.card.name} absorbs ${absorb} damage.`);
    }
    if (amount <= 0) return;
    if (sourceKws.has('infect') || sourceKws.has('wither')) {
      target.counters['-1/-1'] = (target.counters['-1/-1'] || 0) + amount;
    } else {
      target.damage += amount;
    }
    // Enrage: "whenever this creature is dealt damage".
    const enrage = memoSteps(interpretDealtDamageTriggers, target.card);
    if (enrage.length && this.findPermanent(target.id)) this.runPermanentTrigger(target, enrage, { damageAmount: amount });
  }

  // Damage to a player: Infect gives poison counters instead of life loss.
  // Still "damage dealt" either way (Bloodthirst, etc. see it).
  damagePlayer(player, amount, sourceKws, sourceName) {
    if (amount <= 0) return;
    player.damageTakenThisTurn += amount;
    if (sourceKws.has('infect')) {
      player.counters.poison = (player.counters.poison || 0) + amount;
      this.log(`${sourceName} deals ${amount} infect damage to ${player.name} (${player.counters.poison} poison).`);
    } else {
      player.life -= amount;
      this.log(`${sourceName} deals ${amount} damage to ${player.name}.`);
    }
  }

  // Keywords of whatever is dealing damage: its permanent if it has one
  // (equipment-granted infect counts), else the card's printed keywords.
  damageSourceKeywords(ctx) {
    return ctx.sourcePerm && this.findPermanent(ctx.sourcePerm.id) ? this.effectiveKeywords(ctx.sourcePerm) : new Set(ctx.card?.keywords || []);
  }

  applyDamageEffect(ctx, amount) {
    // Multi-target ("deals 1 damage to each of up to two target creatures"
    // — Cast into the Fire): the SAME amount to EACH chosen target — re-
    // dispatch once per one, same wrapper pattern as the other multi-
    // target-capable apply*Effect methods. (A divided/split total among
    // several targets, like Dragonlord Atarka's "5 damage divided as you
    // choose," is a DIFFERENT shape — see applyDivideDamageEffect below.)
    if (ctx.targets && ctx.targets.length > 1) {
      for (const t of ctx.targets) this.applyDamageEffect({ ...ctx, target: t, targets: null }, amount);
      return;
    }
    if (ctx.target?.type === 'permanent') {
      const perm = this.findPermanent(ctx.target.id);
      if (perm && this.isProtectedFrom(perm, ctx.card)) {
        this.log(`${perm.card.name} has protection — the damage from ${ctx.card.name} is prevented.`);
        return;
      }
      if (perm) {
        // Real rule 120.3c: damage to a planeswalker removes that many
        // loyalty counters immediately, rather than being marked as damage
        // for state-based actions to check later the way creature damage
        // works.
        if (isPlaneswalker(perm.card)) {
          perm.counters.loyalty = (perm.counters.loyalty || 0) - amount;
          this.log(`${ctx.card.name} deals ${amount} damage to ${perm.card.name}, removing ${amount} loyalty counter${amount === 1 ? '' : 's'}.`);
        } else {
          this.damageCreature(perm, amount, this.damageSourceKeywords(ctx));
          this.log(`${ctx.card.name} deals ${amount} damage to ${perm.card.name}.`);
        }
      }
    } else if (ctx.target?.type === 'player') {
      const pl = this.getPlayer(ctx.target.id);
      if (pl) this.damagePlayer(pl, amount, this.damageSourceKeywords(ctx), ctx.card.name);
    }
  }

  // "N damage divided as you choose among any number of target creatures
  // and/or planeswalkers your opponents control" (Dragonlord Atarka) — a
  // genuinely different shape from applyDamageEffect's own multi-target
  // case above (same amount to EACH target): here the total is a fixed
  // pool split unevenly across however many targets the caster picks. No
  // real "choose how many, then divide arbitrarily" UI, so this greedily
  // kills as many of the opponent's creatures/planeswalkers as possible
  // (cheapest effective toughness/loyalty first, each dealt EXACTLY its
  // own lethal amount — no overkill), then dumps any leftover on the
  // biggest surviving threat rather than wasting it.
  applyDivideDamageEffect(ctx, totalAmount) {
    if (totalAmount <= 0) return;
    const opponent = this.opponentOf(ctx.controllerId);
    const candidates = opponent.battlefield.filter(perm => isCreature(perm.card) || isPlaneswalker(perm.card));
    if (candidates.length === 0) return;
    const toughnessOf = perm => isPlaneswalker(perm.card) ? (perm.counters.loyalty || 0) : this.effectiveToughness(perm);
    const sorted = candidates.slice().sort((a, b) => toughnessOf(a) - toughnessOf(b));
    let remaining = totalAmount;
    const killed = new Set();
    for (const perm of sorted) {
      const need = Math.max(1, toughnessOf(perm));
      if (need > remaining) continue;
      this.applyDamageEffect({ ...ctx, target: { type: 'permanent', id: perm.id } }, need);
      remaining -= need;
      killed.add(perm.id);
    }
    if (remaining > 0) {
      const leftoverTarget = [...sorted].reverse().find(p => !killed.has(p.id));
      if (leftoverTarget) this.applyDamageEffect({ ...ctx, target: { type: 'permanent', id: leftoverTarget.id } }, remaining);
    }
    this.checkStateBasedActions();
  }

  // "It deals that much damage to each creature that player controls"
  // (Balefire Dragon's own combat-damage trigger) — "that player" is always
  // the source's controller's opponent in this always-2-player engine, so
  // this doesn't need a real target to resolve who "that player" is.
  applyDamageToOpponentCreaturesEffect(ctx, amount) {
    const opponent = this.opponentOf(ctx.controllerId);
    for (const perm of [...opponent.battlefield]) {
      if (!isCreature(perm.card)) continue;
      this.applyDamageEffect({ ...ctx, target: { type: 'permanent', id: perm.id } }, amount);
    }
    this.checkStateBasedActions();
  }

  applyDestroyEffect(ctx) {
    // Multi-target ("destroy up to two target creatures", ...): re-dispatch
    // once per chosen target — see resolveEffectSteps for ctx.targets.
    if (ctx.targets && ctx.targets.length > 1) {
      for (const t of ctx.targets) this.applyDestroyEffect({ ...ctx, target: t, targets: null });
      return;
    }
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    if (this.effectiveKeywords(perm).has('indestructible')) {
      this.log(`${perm.card.name} is indestructible and isn't destroyed.`);
      return;
    }
    if (this.tryUmbraArmor(perm)) return;
    this.movePermanentToGraveyard(perm);
    this.log(`${ctx.card.name} destroys ${perm.card.name}.`);
  }

  // Umbra armor: if the enchanted creature would be destroyed, instead
  // remove all damage from it and destroy the Aura. Returns true if it
  // saved the creature.
  tryUmbraArmor(perm) {
    for (const pl of this.players) {
      const umbra = pl.battlefield.find(x => x.attachedTo === perm.id && hasUmbraArmor(x.card));
      if (!umbra) continue;
      perm.damage = 0;
      this.log(`${umbra.card.name}'s umbra armor saves ${perm.card.name}; ${umbra.card.name} is destroyed instead.`);
      this.movePermanentToGraveyard(umbra);
      return true;
    }
    return false;
  }

  // "Destroy all creatures" (Wrath of God, Damnation, ...), optionally
  // restricted to a type ("all Dragon creatures" — Crux of Fate) or its
  // negation ("all non-Dragon creatures") — both players' creatures,
  // snapshotting each battlefield first since destroying one can trigger
  // more (Grave Pact-style) deaths mid-sweep.
  applyMassDestroyEffect(ctx, typeWord = null, negate = false) {
    for (const pl of this.players) {
      for (const perm of [...pl.battlefield]) {
        if (!isCreature(perm.card)) continue;
        if (typeWord) {
          const matches = hasTypeWord(perm.card, typeWord);
          if (negate ? matches : !matches) continue;
        }
        this.applyDestroyEffect({ ...ctx, target: { type: 'permanent', id: perm.id } });
      }
    }
    this.checkStateBasedActions();
  }

  // Whether `counterCard` can counter this stack item: not itself, not a
  // "this spell can't be countered" spell, and matching the counterspell's
  // own type restriction (Negate's noncreature, Essence Scatter's creature,
  // ...). Permanent spells ARE counterable — the engine used to only ever
  // let a counterspell target instants and sorceries, so even a plain
  // Counterspell couldn't touch a creature spell.
  canCounterTarget(item, counterCard) {
    if (!item || !counterCard || item.card === counterCard) return false;
    if (/this spell can'?t be countered/i.test(item.card.oracleText || '')) return false;
    const filter = getCounterSpellFilter(counterCard);
    if (filter === undefined) return true; // a non-standard counter effect — no restriction to check
    return spellMatchesFilter(item.card, filter);
  }

  applyCounterEffect(ctx) {
    let idx = ctx.target?.type === 'stack' ? this.stack.findIndex(s => s.id === ctx.target.id && this.canCounterTarget(s, ctx.card)) : -1;
    if (idx === -1) {
      // Fall back to the topmost counterable OPPONENT's spell (closest to
      // resolving) if no legal target was supplied or it's gone.
      for (let i = this.stack.length - 1; i >= 0; i--) {
        if (this.stack[i].controllerId !== ctx.controllerId && this.canCounterTarget(this.stack[i], ctx.card)) { idx = i; break; }
      }
    }
    if (idx === -1) {
      this.log(`${ctx.card.name} has no spell to counter.`);
      return;
    }
    const countered = this.stack.splice(idx, 1)[0];
    if (countered.faceDown) countered.card = countered.faceDown.card;
    if (countered.card._dfcOriginal) countered.card = countered.card._dfcOriginal;
    const owner = this.getPlayer(countered.controllerId);
    // A countered COMMANDER spell goes back to the command zone, not the
    // graveyard, same "commander replacement effect" already applied
    // everywhere a commander leaves the battlefield (redirectCommanderToZone) —
    // this is the one other zone a commander can leave FROM (the stack).
    if (countered.isCopy) {
      this.log(`${ctx.card.name} counters the copy of ${countered.card.name}.`);
    } else if (this.commanderMode && this.commanderEntryFor(owner, countered.card)) {
      this.commanderEntryFor(owner, countered.card).inZone = true;
      this.syncCommanderFields(owner);
      this.log(`${ctx.card.name} counters ${countered.card.name}; it returns to ${owner.name}'s command zone instead.`);
    } else {
      owner.graveyard.push(countered.card);
      this.log(`${ctx.card.name} counters ${countered.card.name}.`);
    }
  }

  applyDrawEffect(ctx, amount) {
    const p = ctx.target?.type === 'player' ? this.getPlayer(ctx.target.id) : this.getPlayer(ctx.controllerId);
    for (let i = 0; i < amount; i++) this.drawCard(p);
  }

  // "If you control the [type] with the greatest mana value or tied for
  // the greatest mana value, draw a card" (Padeem, Consul of Innovation's
  // own upkeep trigger) — a real board-state condition evaluated fresh
  // every upkeep, not a one-time check.
  applyGreatestManaValueDrawEffect(ctx, typeWord) {
    const controller = this.getPlayer(ctx.controllerId);
    const matches = (perm) => hasTypeWord(perm.card, typeWord);
    const globalMax = Math.max(0, ...this.players.flatMap(pl => pl.battlefield.filter(matches).map(p => p.card.cmc || 0)));
    const ownMax = Math.max(0, ...controller.battlefield.filter(matches).map(p => p.card.cmc || 0));
    if (controller.battlefield.some(matches) && ownMax >= globalMax) this.applyDrawEffect(ctx, 1);
  }

  applyPumpEffect(ctx, power, toughness) {
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    perm.tempBuffs.push({ power, toughness });
    this.log(`${perm.card.name} gets ${power >= 0 ? '+' : ''}${power}/${toughness >= 0 ? '+' : ''}${toughness} until end of turn.`);
  }

  // "It gets +1/+0 until end of turn for each other attacking Goblin"
  // (Goblin Rabblemaster's own attack trigger) — "it" is the attacking
  // source itself (ctx.sourcePerm), pumped once per OTHER currently-
  // attacking creature matching the named subtype.
  applyAttackCountPumpEffect(ctx, power, toughness, typeWord) {
    if (!ctx.sourcePerm) return;
    const perm = this.findPermanent(ctx.sourcePerm.id);
    if (!perm) return;
    let count = 0;
    for (const pl of this.players) {
      for (const other of pl.battlefield) {
        if (other.id === perm.id || !other.attacking) continue;
        if (typeWord && !typeOf(other.card, typeWord)) continue;
        count++;
      }
    }
    if (count === 0) return;
    perm.tempBuffs.push({ power: power * count, toughness: toughness * count });
    this.log(`${perm.card.name} gets ${power * count >= 0 ? '+' : ''}${power * count}/${toughness * count >= 0 ? '+' : ''}${toughness * count} until end of turn (${count} other attacking ${typeWord || 'creature'}${count > 1 ? 's' : ''}).`);
  }

  // Sacrifices ctx.sourcePerm itself — used both for an unconditional
  // "sacrifice this creature" effect and, via effects.js's own conditional
  // wrapper, for Uro's "sacrifice it unless it escaped" (see castFromGraveyard's
  // perm.escaped flag).
  applySacrificeSelfEffect(ctx) {
    if (!ctx.sourcePerm) return;
    const perm = this.findPermanent(ctx.sourcePerm.id);
    if (!perm) return;
    this.movePermanentToGraveyard(perm);
    this.log(`${perm.card.name} is sacrificed.`);
  }

  // "You may put a land card from your hand onto the battlefield" (Uro,
  // Titan of Nature's Wrath's own combo trigger, and similar "free extra
  // land drop" effects) — unlike playLand, this doesn't consume the turn's
  // land drop or go through canPlayLand's once-per-turn gate. Same "may"
  // simplification as everywhere else in this engine: always does it if a
  // land is available.
  applyPutLandFromHandEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const idx = p.hand.findIndex(c => isLand(c));
    if (idx === -1) {
      this.log(`${ctx.card.name} finds no land card in ${p.name}'s hand.`);
      return;
    }
    const [card] = p.hand.splice(idx, 1);
    const perm = makePermanent(card, ctx.controllerId);
    perm.summoningSick = false;
    p.battlefield.push(perm);
    this.log(`${ctx.card.name} puts ${card.name} onto the battlefield from ${p.name}'s hand.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
    this.triggerLandfall(perm);
  }

  applyLifegainEffect(ctx, amount) {
    const p = ctx.target?.type === 'player' ? this.getPlayer(ctx.target.id) : this.getPlayer(ctx.controllerId);
    p.life += amount;
    this.log(amount >= 0 ? `${p.name} gains ${amount} life.` : `${p.name} loses ${-amount} life.`);
  }

  // A player's devotion to a color: the number of mana symbols of that
  // color among the mana costs of permanents they control (rule 704.5m-ish,
  // as used by Gray Merchant of Asphodel, Nykthos, Erebos, and the other
  // devotion payoffs) — a hybrid or Phyrexian symbol containing the color
  // counts too, same as real rules, since it's still "of that color" for
  // this purpose. Counts every permanent type, not just creatures.
  getDevotion(playerId, colorLetter) {
    const p = this.getPlayer(playerId);
    let total = 0;
    for (const perm of p.battlefield) {
      const symbols = (perm.card.manaCost || '').match(/\{[^}]+\}/g) || [];
      for (const sym of symbols) {
        if (sym.toUpperCase().includes(colorLetter)) total++;
      }
    }
    return total;
  }

  // "Each opponent loses X life, where X is your devotion to black, and you
  // gain that much life." (Gray Merchant of Asphodel, and the same template
  // on its reprints/variants) — a 2-player-only stand-in for "each
  // opponent" same as the other dynamic drain effects, computing its own X
  // from devotion rather than a paid {X} cost (resolveAmount's 'x' handling
  // is for the latter only, so this needed its own amount source instead of
  // reusing that).
  applyDevotionDrainEffect(ctx, colorLetter) {
    const controller = this.getPlayer(ctx.controllerId);
    const opponent = this.opponentOf(ctx.controllerId);
    const amount = this.getDevotion(ctx.controllerId, colorLetter);
    opponent.life -= amount;
    controller.life += amount;
    this.log(`${ctx.card.name}'s devotion drain: ${opponent.name} loses ${amount} life and ${controller.name} gains ${amount} life.`);
  }

  // "Attach it to target creature you control" (Sigarda's Aid's own
  // tribal-ETB trigger for entering Equipment) — "it" is ctx.enteredPerm;
  // no real target-choice UI, so this picks the controller's own strongest
  // OTHER creature to attach to.
  applyAutoAttachEffect(ctx) {
    if (!ctx.enteredPerm) return;
    const controller = this.getPlayer(ctx.controllerId);
    const creatures = controller.battlefield.filter(perm => isCreature(perm.card) && perm.id !== ctx.enteredPerm.id);
    if (creatures.length === 0) return;
    const best = creatures.sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
    ctx.enteredPerm.attachedTo = best.id;
    this.log(`${ctx.card.name} attaches ${ctx.enteredPerm.card.name} to ${best.card.name}.`);
  }

  // "Double its controller's life total" (Celestial Mantle) — a one-off
  // multiplicative effect, distinct from every other lifegain pattern here
  // (which all add a fixed or computed amount). "Its" is the equipped/
  // enchanted creature, whose controller is ctx.controllerId (the watching
  // Aura's own controller — see triggerCombatDamageToPlayer's
  // 'attachedCreature' dispatch, which is always the same player in every
  // normal game).
  applyDoubleLifeEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    p.life *= 2;
    this.log(`${ctx.card.name} doubles ${p.name}'s life total to ${p.life}.`);
  }

  applyManaEffect(ctx, color) {
    const p = this.getPlayer(ctx.controllerId);
    p.manaPool[color] = (p.manaPool[color] || 0) + 1;
    this.log(`${ctx.card.name} adds {${color}} to ${p.name}'s mana pool.`);
  }

  // "Add {G} for each Elf you control" / "... on the battlefield" (Priest of
  // Titania, Elvish Archdruid, and similar dynamic-count mana abilities) —
  // onlyYours restricts the count to the controller's own battlefield;
  // otherwise it's every permanent of that type either player controls.
  applyDynamicManaEffect(ctx, color, typeWord, onlyYours) {
    let count = 0;
    if (onlyYours) {
      count = this.getPlayer(ctx.controllerId).battlefield.filter(p => hasTypeWord(p.card, typeWord)).length;
    } else {
      for (const pl of this.players) count += pl.battlefield.filter(p => hasTypeWord(p.card, typeWord)).length;
    }
    for (let i = 0; i < count; i++) this.applyManaEffect(ctx, color);
  }

  // "Add {C}. If you control [Land A] and [Land B], add {C}{C} instead."
  // (the Urza's-lands cycle: Mine/Power-Plant/Tower, each one checking the
  // OTHER two by name) — 1 colorless normally, or bonusAmount instead once
  // all three pieces of the "Urzatron" are assembled.
  applyConditionalManaEffect(ctx, land1Name, land2Name, bonusAmount) {
    const p = this.getPlayer(ctx.controllerId);
    const hasBoth = p.battlefield.some(perm => perm.card.name.toLowerCase() === land1Name)
      && p.battlefield.some(perm => perm.card.name.toLowerCase() === land2Name);
    const amount = hasBoth ? bonusAmount : 1;
    for (let i = 0; i < amount; i++) this.applyManaEffect(ctx, 'C');
  }

  // Generic counter-placement replacement effects (Hardened Scales,
  // Winding Constrictor's first clause) — "if one or more [+1/+1]
  // counter(s) would be put on a [creature/artifact] you control, that
  // many plus one are put on it instead." Not a general replacement-effect
  // framework (see README's Known Limitations — this engine doesn't have
  // one), just these two specific, well-known static texts recognized by
  // name-free pattern match, checked at the ONE choke point almost every
  // real "put N counters on target creature" card already funnels through
  // (applyCounterAdditionEffect below). Multiple copies stack (each adds
  // its own +1), matching real replacement-effect rules.
  getCounterPlacementBonus(perm, counterType) {
    const controller = this.getPlayer(perm.controllerId);
    let bonus = 0;
    for (const other of controller.battlefield) {
      const text = (other.card.oracleText || '').toLowerCase();
      if (counterType === '+1/+1' && isCreature(perm.card) &&
          /if one or more \+1\/\+1 counters would be put on a creature you control,?\s*that many plus one \+1\/\+1 counters are put on it instead/.test(text)) {
        bonus += 1;
      }
      if ((isCreature(perm.card) || isArtifact(perm.card)) &&
          /if one or more counters would be put on an artifact or creature you control,?\s*that many plus one of each of those kinds of counters are put on that permanent instead/.test(text)) {
        bonus += 1;
      }
    }
    return bonus;
  }

  applyCounterAdditionEffect(ctx, amount, counterType = '+1/+1') {
    // Multi-target ("put a +1/+1 counter on each of up to two target
    // creatures" — Rishkar, Peema Renegade; Byrke; Zimone; and many more):
    // re-dispatch once per chosen target — see resolveEffectSteps for
    // ctx.targets.
    if (ctx.targets && ctx.targets.length > 1) {
      for (const t of ctx.targets) this.applyCounterAdditionEffect({ ...ctx, target: t, targets: null }, amount, counterType);
      return;
    }
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    const bonus = this.getCounterPlacementBonus(perm, counterType);
    const total = amount + bonus;
    perm.counters[counterType] = (perm.counters[counterType] || 0) + total;
    this.log(`${ctx.card.name} puts ${total} ${counterType} counter${total > 1 ? 's' : ''} on ${perm.card.name}${bonus > 0 ? ` (${amount} boosted by a counters-doubling effect)` : ''}.`);
    this.triggerCounterAdded(perm);
  }

  // "All creatures gain KEYWORD[, KEYWORD] until end of turn" (Kenrith, the
  // Returned King's red ability, and similar mass-buff effects) — every
  // creature on the battlefield, both players'.
  applyMassKeywordGrantEffect(ctx, keywordText) {
    const keywords = extractKnownKeywords(keywordText.toLowerCase());
    if (keywords.length === 0) return;
    for (const pl of this.players) {
      for (const perm of pl.battlefield) {
        if (!isCreature(perm.card)) continue;
        perm.tempKeywords.push(...keywords);
      }
    }
    this.log(`${ctx.card.name} gives all creatures ${keywords.join(' and ')} until end of turn.`);
  }

  // "Untap all creatures you control" (Aurelia, the Warleader's own attack
  // trigger) / "untap all creatures that attacked this turn" (Relentless
  // Assault, Waves of Aggression) — attackedOnly restricts to creatures
  // still flagged perm.attacking (cleared at the next untap step, so this
  // stays accurate for the rest of the current turn).
  // permType: 'creature' (default) or 'land'. color: an optional single
  // color letter restriction (Battle Cry's "untap all WHITE creatures you
  // control"). maxCount: "up to N" (Peregrine Drake's "untap up to five
  // lands") — no real choice UI for which ones, so this just untaps
  // whichever N are currently tapped, same simplification used everywhere
  // else in this engine for an unmodeled player choice.
  applyMassUntapEffect(ctx, { attackedOnly = false, permType = 'creature', color = null, maxCount = null } = {}) {
    const controller = this.getPlayer(ctx.controllerId);
    let candidates;
    if (attackedOnly) {
      candidates = this.players.flatMap(pl => pl.battlefield).filter(perm => perm.attacking);
    } else {
      candidates = controller.battlefield.filter(perm => (permType === 'land' ? isLand(perm.card) : isCreature(perm.card)));
      if (color) candidates = candidates.filter(perm => (perm.card.colors || []).includes(color));
    }
    if (maxCount != null) candidates = candidates.filter(perm => perm.tapped).slice(0, maxCount);
    for (const perm of candidates) perm.tapped = false;
    const desc = attackedOnly ? 'all creatures that attacked this turn'
      : maxCount != null ? `up to ${maxCount} ${permType}${maxCount > 1 ? 's' : ''}`
      : `${controller.name}'s ${color ? 'matching ' : ''}${permType}s`;
    this.log(`${ctx.card.name} untaps ${desc}.`);
  }

  // "Creatures you control get +X/+X" / "creatures your opponents control
  // get -X/-X until end of turn" (Doomwake Giant's Constellation trigger,
  // Intangible Virtue-style anthems worded as one-shot pumps, and similar)
  // — scope is 'you' (controller's own creatures) or 'opponents' (every
  // other player's), no real per-target choice involved either way.
  // excludeSelf skips ctx.sourcePerm itself (End-Raze Forerunners' own
  // "OTHER creatures you control get +2/+2..."); keywordText grants
  // whichever known keywords it names alongside the stat bump (its own
  // "and gain vigilance and trample until end of turn").
  // scope 'all' (The Meathook Massacre's own "each creature gets -X/-X" —
  // a board-wipe-shaped debuff, unlike the 'you'/'opponents' scopes below
  // which only ever affect ONE side) hits every creature on every
  // battlefield, caster's own included.
  applyMassPumpEffect(ctx, scope, power, toughness, { excludeSelf = false, keywordText = null, attackingOnly = false } = {}) {
    const controller = this.getPlayer(ctx.controllerId);
    const affectedPlayers = scope === 'all' ? this.players
      : scope === 'opponents' ? this.players.filter(pl => pl.id !== controller.id)
      : [controller];
    const keywords = keywordText ? extractKnownKeywords(keywordText.toLowerCase()) : [];
    for (const pl of affectedPlayers) {
      for (const perm of pl.battlefield) {
        if (!isCreature(perm.card)) continue;
        if (excludeSelf && ctx.sourcePerm && perm.id === ctx.sourcePerm.id) continue;
        if (attackingOnly && !perm.attacking) continue;
        perm.tempBuffs.push({ power, toughness });
        if (keywords.length) perm.tempKeywords.push(...keywords);
      }
    }
    const sign = power >= 0 ? '+' : '';
    const scopeDesc = scope === 'all' ? 'every creature' : scope === 'opponents' ? "opponents' creatures" : `${controller.name}'s creatures`;
    this.log(`${ctx.card.name} gives ${scopeDesc} ${sign}${power}/${sign}${toughness}${keywords.length ? ` and ${keywords.join(' and ')}` : ''} until end of turn.`);
    this.checkStateBasedActions();
  }

  // "Monstrosity N" — a one-time self-buff: if not already monstrous, put N
  // +1/+1 counters on the source and flip perm.monstrous permanently on
  // (checked by effectiveKeywords for a paired "as long as ... monstrous,
  // it has ..." static ability). Activating it again once already monstrous
  // correctly does nothing, matching the real keyword's own rule.
  applyMonstrosityEffect(ctx, amount) {
    const perm = ctx.sourcePerm;
    if (!perm || perm.monstrous) {
      this.log(`${ctx.card.name} is already monstrous.`);
      return;
    }
    perm.monstrous = true;
    const bonus = this.getCounterPlacementBonus(perm, '+1/+1');
    const total = amount + bonus;
    perm.counters['+1/+1'] = (perm.counters['+1/+1'] || 0) + total;
    this.log(`${ctx.card.name} becomes monstrous, getting ${total} +1/+1 counter${total > 1 ? 's' : ''}.`);
    this.triggerCounterAdded(perm);
    // "When this creature enters OR BECOMES MONSTROUS, EFFECT" (Protector
    // of the Wastes) — becoming monstrous is a real trigger EVENT of its
    // own, separate from the static "as long as monstrous, it has ..."
    // condition effectiveKeywords already handles. Fires every time this
    // permanent becomes monstrous (which, per the guard above, can only
    // ever happen once per permanent — matching the real keyword's rule).
    this.triggerMonstrous(perm);
  }

  // Dispatches a "... or becomes monstrous, EFFECT" trigger — same target-
  // collection machinery as triggerETB (AI auto-picks via a dynamic
  // import, a human gets the same etbTarget pendingRequest/chooseETBTarget
  // flow), since both are "one-shot event needs targets, then resolves"
  // dispatch points with nothing else in this engine using it in between.
  triggerMonstrous(perm) {
    const steps = interpretMonstrousTriggers(perm.card);
    if (steps.length === 0) return;
    const kinds = expandTargetKinds(steps);
    const ctxBase = { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm };
    if (kinds.length === 0) {
      this.resolveEffectSteps(steps, [], ctxBase);
      this.checkStateBasedActions();
      this.emit();
      return;
    }
    const controller = this.getPlayer(perm.controllerId);
    if (controller.isAI) {
      // Resolved right away (pickTargetsForKinds is statically imported) —
      // this used to defer to a later microtask via a dynamic import, so an
      // AI's ETB targets were chosen after whatever happened next.
      const targets = pickTargetsForKinds(this, perm.card, perm.controllerId, kinds, perm.id);
      this.resolveEffectSteps(steps, targets, ctxBase);
      this.checkStateBasedActions();
      this.emit();
      return;
    }
    this._pendingETB = { perm, steps, ctxBase };
    this.pendingRequest = { type: 'etbTarget', playerId: perm.controllerId, cardName: perm.card.name, kinds, collected: [], sourcePermId: perm.id };
    this.emit();
  }

  // Player-level counters (experience, energy, poison, ...) — always land
  // on the effect's own controller ("you get..."), never a chosen target.
  applyPlayerCounterEffect(ctx, amount, counterType) {
    const p = this.getPlayer(ctx.controllerId);
    // Winding Constrictor's own SECOND clause — "If you would get one or
    // more counters, you get that many plus one of each of those kinds of
    // counters instead" — a separate replacement effect from its
    // permanent-counter one (see getCounterPlacementBonus), this one for
    // PLAYER-level counters (experience, energy, ...). Each copy stacks.
    const bonus = p.battlefield.filter(perm =>
      /if you would get one or more counters,?\s*you get that many plus one of each of those kinds of counters instead/.test((perm.card.oracleText || '').toLowerCase())
    ).length;
    const total = amount + bonus;
    p.counters[counterType] = (p.counters[counterType] || 0) + total;
    this.log(`${p.name} gets ${total} ${counterType} counter${total > 1 ? 's' : ''}.`);
  }

  // "You get an emblem with '...'" (a planeswalker ultimate — Gideon, Ally
  // of Zendikar; Elspeth, Sun's Champion; ...) — just remembers the raw
  // granted-ability text on the player (see makePlayer's own `emblems`
  // field comment); anthemBonus/effectiveKeywords are the two places that
  // actually read it back, the same way they already read a permanent's
  // own printed anthem/keyword-grant text. A non-static-anthem-shaped
  // emblem (a triggered ability, say) is recognized as "got an emblem" but
  // its own granted text has no dispatch point reading it — see README.
  applyGetEmblemEffect(ctx, emblemText) {
    const p = this.getPlayer(ctx.controllerId);
    p.emblems.push(emblemText);
    this.log(`${p.name} gets an emblem with "${emblemText}"`);
  }

  // Proliferate: one more of each counter kind already present, on every
  // permanent and player that has at least one. See the "no choice UI"
  // simplification note where this is parsed, in effects.js.
  applyProliferateEffect(ctx) {
    let touched = 0;
    for (const pl of this.players) {
      for (const [type, count] of Object.entries(pl.counters)) {
        if (count > 0) { pl.counters[type] += 1; touched++; }
      }
      for (const perm of pl.battlefield) {
        let addedToThisPerm = false;
        for (const [type, count] of Object.entries(perm.counters)) {
          if (count > 0) { perm.counters[type] += 1; touched++; addedToThisPerm = true; }
        }
        if (addedToThisPerm) this.triggerCounterAdded(perm);
      }
    }
    this.log(`${ctx.card.name} proliferates${touched > 0 ? '' : ' (nothing had a counter to add to)'}.`);
  }

  // Simplification: grabs the first basic land found rather than letting the
  // player choose a specific one.
  // landTypes (if given) restricts the search to lands whose type line
  // includes one of the named types (e.g. ['forest'], or Farseek's
  // ['plains','island','swamp','mountain']) — this also happens to match
  // non-basic lands with that type, same as the real card would fetch.
  // null means "any basic land", the more common restriction.
  applyFetchLandEffect(ctx, { ontoBattlefield, tapped, landTypes = null, basicOnly = false }) {
    const p = this.getPlayer(ctx.controllerId);
    const idx = p.library.findIndex(c => isLand(c) && (
      landTypes
        ? landTypes.some(t => c.typeLine.toLowerCase().includes(t)) && (!basicOnly || /\bBasic Land\b/.test(c.typeLine))
        : /\bBasic Land\b/.test(c.typeLine)
    ));
    if (idx === -1) {
      this.log(`${ctx.card.name} finds no matching land in ${p.name}'s library.`);
      return;
    }
    const [land] = p.library.splice(idx, 1);
    if (ontoBattlefield) {
      const perm = makePermanent(land, ctx.controllerId);
      perm.summoningSick = false;
      if (tapped) perm.tapped = true;
      p.battlefield.push(perm);
      this.log(`${ctx.card.name} puts ${land.name} onto the battlefield${tapped ? ' tapped' : ''}.`);
      this.triggerETB(perm);
      this.triggerLandfall(perm);
    } else {
      p.hand.push(land);
      this.log(`${ctx.card.name} puts ${land.name} into ${p.name}'s hand.`);
    }
    p.library = shuffle(p.library);
  }

  // "Put target creature card from a graveyard onto the battlefield under
  // its owner's control" (Kenrith, the Returned King's black ability, and
  // similar reanimation effects) — which specific card in which graveyard
  // isn't a real target this engine's UI can prompt for, same simplification
  // as the tutor/regrowth auto-picks: grabs the highest-cost creature card
  // from EITHER player's graveyard.
  // opts.underCasterControl: Reanimate-style effects put the card under the
  // CASTER's control instead of its owner's. opts.loseLifeEqualToCmc:
  // Reanimate's own cost, applied here (rather than as a separate step)
  // since only this method knows which card actually got reanimated.
  applyReanimateAnyGraveyardEffect(ctx, opts = {}) {
    const { underCasterControl = false, loseLifeEqualToCmc = false } = opts;
    let best = null, bestOwner = null;
    for (const pl of this.players) {
      for (const c of pl.graveyard) {
        if (!isCreature(c)) continue;
        if (!best || (c.cmc || 0) > (best.cmc || 0)) { best = c; bestOwner = pl; }
      }
    }
    if (!best) {
      this.log(`${ctx.card.name} finds no creature card in any graveyard.`);
      return;
    }
    bestOwner.graveyard = bestOwner.graveyard.filter(c => c !== best);
    const controller = underCasterControl ? this.getPlayer(ctx.controllerId) : bestOwner;
    const perm = makePermanent(best, controller.id);
    controller.battlefield.push(perm);
    this.log(`${ctx.card.name} puts ${best.name} onto the battlefield under ${controller.name}'s control.`);
    if (loseLifeEqualToCmc) {
      const caster = this.getPlayer(ctx.controllerId);
      caster.life -= (best.cmc || 0);
      this.log(`${caster.name} loses ${best.cmc || 0} life.`);
    }
    this.checkStateBasedActions();
    this.triggerETB(perm);
  }

  // Meren of Clan Nel Toth's own end-step trigger: "choose target creature
  // card in your graveyard. If that card's mana value is less than or
  // equal to the number of experience counters you have, return it to the
  // battlefield. Otherwise, put it into your hand." — unlike the plain
  // reanimation effects, EVERY creature card in the graveyard is a legal
  // choice (no CMC ceiling on the choice itself, only on the OUTCOME), and
  // there's always a fallback (into hand) instead of doing nothing when the
  // CMC check fails. No real choose-target UI (this engine's usual
  // simplification): picks the highest-CMC card that actually QUALIFIES for
  // reanimation if experience allows one, otherwise the highest-CMC card
  // overall (the most valuable one to get into hand instead).
  applyMerenEndStepEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const candidates = p.graveyard.filter(c => isCreature(c));
    if (candidates.length === 0) return;
    const experience = p.counters.experience || 0;
    const qualifying = candidates.filter(c => (c.cmc || 0) <= experience);
    const pickFrom = qualifying.length > 0 ? qualifying : candidates;
    const chosen = pickFrom.sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    p.graveyard = p.graveyard.filter(c => c !== chosen);
    if ((chosen.cmc || 0) <= experience) {
      const perm = makePermanent(chosen, p.id);
      p.battlefield.push(perm);
      this.log(`${p.name} returns ${chosen.name} from their graveyard to the battlefield (mana value ${chosen.cmc || 0} <= ${experience} experience counters).`);
      this.checkStateBasedActions();
      this.triggerETB(perm);
    } else {
      p.hand.push(chosen);
      this.log(`${p.name} puts ${chosen.name} into their hand (mana value ${chosen.cmc || 0} > ${experience} experience counters).`);
    }
  }

  // "Return target creature/permanent card [with mana value N or less] from
  // your graveyard to the battlefield" (Karmic Guide, Sun Titan) — unlike
  // applyReanimateAnyGraveyardEffect above, this is restricted to the
  // CASTER's own graveyard (never an opponent's) and always returns it
  // under their own control. Same auto-pick simplification: highest CMC
  // among the qualifying cards.
  applyReanimateFromOwnGraveyardEffect(ctx, { typeWord = 'creature', maxCmc = Infinity, maxPower = Infinity } = {}) {
    const p = this.getPlayer(ctx.controllerId);
    const fitsType = (c) => typeWord === 'permanent' ? isPermanentType(c) : typeWord === 'creature' ? isCreature(c) : typeWord.split(' or ').some(t => hasTypeWord(c, t));
    const candidates = p.graveyard.filter(c => fitsType(c) && (c.cmc || 0) <= maxCmc && (parseInt(c.power, 10) || 0) <= maxPower);
    if (candidates.length === 0) {
      this.log(`${ctx.card.name} finds no matching card in ${p.name}'s graveyard.`);
      return;
    }
    const best = candidates.slice().sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    p.graveyard = p.graveyard.filter(c => c !== best);
    const perm = makePermanent(best, ctx.controllerId);
    perm.enteredFromGraveyardOf = p.id;
    p.battlefield.push(perm);
    this.log(`${ctx.card.name} returns ${best.name} from ${p.name}'s graveyard to the battlefield.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
  }

  // "You may put an Aura or Equipment card from your hand or graveyard onto
  // the battlefield attached to this creature" (Danitha, Benalia's Hope) —
  // a genuine three-zone source choice (hand OR graveyard, either card
  // type), unlike every other "put a card onto the battlefield" effect in
  // this engine, which only ever pulls from a single zone. No real
  // choose-which-card UI: auto-picks the highest-CMC qualifying card
  // across both zones combined (the most impactful attachment), same
  // simplification used for every other no-real-choice pick elsewhere.
  applyPutAuraOrEquipmentFromHandOrGraveyardEffect(ctx) {
    if (!ctx.sourcePerm) return;
    const p = this.getPlayer(ctx.controllerId);
    const isAuraOrEquipment = c => isAura(c) || typeOf(c, 'equipment');
    const candidates = [
      ...p.hand.filter(isAuraOrEquipment).map(card => ({ card, zone: 'hand' })),
      ...p.graveyard.filter(isAuraOrEquipment).map(card => ({ card, zone: 'graveyard' })),
    ];
    if (candidates.length === 0) return;
    const chosen = candidates.sort((a, b) => (b.card.cmc || 0) - (a.card.cmc || 0))[0];
    if (chosen.zone === 'hand') p.hand = p.hand.filter(c => c !== chosen.card);
    else p.graveyard = p.graveyard.filter(c => c !== chosen.card);
    const perm = makePermanent(chosen.card, ctx.controllerId);
    perm.attachedTo = ctx.sourcePerm.id;
    p.battlefield.push(perm);
    this.log(`${p.name} puts ${chosen.card.name} from their ${chosen.zone} onto the battlefield attached to ${ctx.sourcePerm.card.name}.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
  }

  // "Look at the top N cards of your library" and distribute them (Expressive
  // Iteration, and similar) — no real UI for which card goes where, so this
  // auto-picks: the highest-mana-value card to hand, the lowest to the
  // bottom, and (for N=3, "put one/one/one" splits) the middle card ALSO to
  // hand rather than modeling a temporary exile-and-play-this-turn zone this
  // engine doesn't have.
  applyLookTopDistributeEffect(ctx, n) {
    const p = this.getPlayer(ctx.controllerId);
    const seen = [];
    for (let i = 0; i < n && p.library.length > 0; i++) seen.push(p.library.shift());
    if (seen.length === 0) return;
    seen.sort((a, b) => (b.cmc || 0) - (a.cmc || 0));
    const toHand = [seen[0], seen[2]].filter(Boolean);
    const toBottom = seen[1] ? [seen[1]] : [];
    for (const c of toHand) p.hand.push(c);
    for (const c of toBottom) p.library.push(c);
    this.log(`${ctx.card.name} looks at the top ${seen.length} card${seen.length > 1 ? 's' : ''}, keeping ${toHand.length} and putting ${toBottom.length} on the bottom.`);
  }

  // "Look at the top N cards of your library. You may reveal a [Type] card
  // from among them and put it into your hand. Put the rest on the bottom
  // of your library in any order." (Commune with Dinosaurs, and similar
  // digs) — no real which-card UI, so (same simplification as the tutor
  // effects) this auto-picks the highest-CMC qualifying card and bottoms
  // the rest. typeWords is null for the unrestricted sibling shape
  // ("put one of them into your hand", no type filter — Dragonlord
  // Ojutai's own combat-damage trigger), where every seen card qualifies.
  applyDigRevealToHandEffect(ctx, n, typeWords) {
    const p = this.getPlayer(ctx.controllerId);
    const seen = [];
    for (let i = 0; i < n && p.library.length > 0; i++) seen.push(p.library.shift());
    const qualifying = typeWords ? seen.filter(c => typeWords.some(w => (c.typeLine || '').toLowerCase().includes(w))) : seen;
    let chosen = null;
    if (qualifying.length > 0) {
      chosen = qualifying.sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
      p.hand.push(chosen);
    }
    for (const c of seen) {
      if (c !== chosen) p.library.push(c);
    }
    this.log(`${ctx.card.name} looks at the top ${seen.length} card${seen.length !== 1 ? 's' : ''}${chosen ? `, revealing ${chosen.name} and putting it into hand` : ', finding nothing to keep'}.`);
  }

  // Single-target keyword grant "until end of turn" (Mishra's Command's
  // "gains haste" mode, and similar) — as opposed to applyMassKeywordGrantEffect
  // above, which hits every creature on the battlefield.
  // Grants one keyword-like flag to the targeted creature until end of turn
  // (cleared with the rest of tempKeywords at cleanup).
  applyTempKeyword(ctx, keyword) {
    const perm = ctx.target?.type === 'permanent' ? this.findPermanent(ctx.target.id) : null;
    if (!perm) return;
    perm.tempKeywords.push(keyword);
    this.log(`${perm.card.name} ${keyword === 'unblockable' ? "can't be blocked" : `gains ${keyword}`} this turn.`);
  }

  applyTargetKeywordGrantEffect(ctx, keywordText) {
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    const keywords = extractKnownKeywords(keywordText.toLowerCase());
    if (keywords.length === 0) return;
    perm.tempKeywords.push(...keywords);
    this.log(`${perm.card.name} gains ${keywords.join(' and ')} until end of turn.`);
  }

  // "Choose target player. They may discard up to N cards. Then they draw a
  // card for each card discarded this way." (Mishra's Command, and similar
  // looting-a-player effects) — same "may" simplification as everywhere
  // else in this engine: always discards up to the max, then draws that many.
  applyLootEffect(ctx, amount) {
    if (ctx.target?.type !== 'player') return;
    const p = this.getPlayer(ctx.target.id);
    if (!p) return;
    const count = Math.min(amount, p.hand.length);
    for (let i = 0; i < count; i++) this.discardCard(p, p.hand[Math.floor(Math.random() * p.hand.length)]);
    for (let i = 0; i < count; i++) this.drawCard(p);
    if (count > 0) this.log(`${p.name} discards ${count} card${count > 1 ? 's' : ''} and draws ${count} card${count > 1 ? 's' : ''}.`);
  }

  // Type-restricted tutor-to-TOP-of-library (Forerunner of the Empire's own
  // ETB, and similar) — grabs the first matching card found, same auto-pick
  // simplification as everywhere else in this engine.
  applyTutorToTopEffect(ctx, typeWord) {
    const p = this.getPlayer(ctx.controllerId);
    const idx = p.library.findIndex(c => hasTypeWord(c, typeWord));
    if (idx === -1) {
      this.log(`${ctx.card.name} finds no ${typeWord} card in ${p.name}'s library.`);
      p.library = shuffle(p.library);
      return;
    }
    const [card] = p.library.splice(idx, 1);
    p.library = shuffle(p.library);
    p.library.unshift(card);
    this.log(`${ctx.card.name} reveals ${card.name} and puts it on top of ${p.name}'s library.`);
  }

  // Unrestricted tutor (Diabolic Tutor, ...), or type-restricted to a
  // non-land card type (Stoneforge Mystic's "an Equipment card", and
  // similar) when typeWord is given: no real target UI for "which card", so
  // — same simplification as applyFetchLandEffect's restricted search above
  // — it always grabs the highest-cost matching card.
  // typeWord: a type/subtype substring restriction (Stoneforge Mystic's
  // "Equipment", Trophy Mage's "artifact"). maxCmc: an optional mana-value
  // cap (Trophy Mage's own "with mana value 3"). color: an optional single
  // color-letter restriction (Merchant Scroll's "blue instant").
  // typeWord may itself be a compound "X or Y" restriction (Open the
  // Armory's "an Aura or Equipment card") — split into alternatives and
  // OR'd together, rather than requiring the whole phrase to literally
  // appear in a card's type line (which would never match anything).
  applyTutorEffect(ctx, typeWord = null, { maxCmc = Infinity, maxPower = Infinity, maxToughness = Infinity, color = null } = {}) {
    const p = this.getPlayer(ctx.controllerId);
    const typeWords = typeWord ? typeWord.split(/\s+or\s+/) : null;
    let candidates = typeWords ? p.library.filter(c => typeWords.some(w => (c.typeLine || '').toLowerCase().includes(w))) : p.library;
    if (maxCmc !== Infinity) candidates = candidates.filter(c => (c.cmc || 0) <= maxCmc);
    if (maxPower !== Infinity) candidates = candidates.filter(c => parseInt(c.power, 10) <= maxPower);
    if (maxToughness !== Infinity) candidates = candidates.filter(c => parseInt(c.toughness, 10) <= maxToughness);
    if (color) candidates = candidates.filter(c => (c.colors || []).includes(color));
    if (candidates.length === 0) {
      this.log(`${ctx.card.name} finds no${typeWord ? ` ${typeWord}` : ''} card in ${p.name}'s library.`);
      return;
    }
    const best = candidates.slice().sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    p.library = p.library.filter(c => c !== best);
    p.hand.push(best);
    this.log(`${ctx.card.name} finds ${best.name} and puts it into ${p.name}'s hand.`);
    p.library = shuffle(p.library);
  }

  // Cultivate/Kodama's Reach shape: up to two basic lands, one onto the
  // battlefield (maybe tapped), the other into hand. If only one is found,
  // it goes to the battlefield and there's no second land for hand.
  applyFetchTwoLandsEffect(ctx, { tapped }) {
    const p = this.getPlayer(ctx.controllerId);
    const found = [];
    for (let i = 0; i < 2; i++) {
      const idx = p.library.findIndex(c => isLand(c) && /\bBasic Land\b/.test(c.typeLine));
      if (idx === -1) break;
      found.push(p.library.splice(idx, 1)[0]);
    }
    if (found.length === 0) {
      this.log(`${ctx.card.name} finds no basic land in ${p.name}'s library.`);
      p.library = shuffle(p.library);
      return;
    }
    const [toBattlefield, toHand] = found;
    const perm = makePermanent(toBattlefield, ctx.controllerId);
    perm.summoningSick = false;
    if (tapped) perm.tapped = true;
    p.battlefield.push(perm);
    const handPart = toHand ? ` and ${toHand.name} into ${p.name}'s hand` : '';
    this.log(`${ctx.card.name} puts ${toBattlefield.name} onto the battlefield${tapped ? ' tapped' : ''}${handPart}.`);
    this.triggerETB(perm);
    this.triggerLandfall(perm);
    if (toHand) p.hand.push(toHand);
    p.library = shuffle(p.library);
  }

  // "Search your library for up to two basic Forest cards, ... put one onto
  // the battlefield tapped and the rest into your hand." (Nissa's
  // Pilgrimage) — restricted to a NAMED basic land type, and (unlike
  // applyFetchTwoLandsEffect above) ALL cards beyond the first go to hand,
  // not just a second one.
  applyFetchNamedBasicLandsEffect(ctx, landTypeWord, maxCount) {
    const p = this.getPlayer(ctx.controllerId);
    const found = [];
    for (let i = 0; i < maxCount; i++) {
      const idx = p.library.findIndex(c => isLand(c) && /\bBasic Land\b/.test(c.typeLine) && c.typeLine.toLowerCase().includes(landTypeWord));
      if (idx === -1) break;
      found.push(p.library.splice(idx, 1)[0]);
    }
    if (found.length === 0) {
      this.log(`${ctx.card.name} finds no basic ${landTypeWord} in ${p.name}'s library.`);
      p.library = shuffle(p.library);
      return;
    }
    const [toBattlefield, ...toHand] = found;
    const perm = makePermanent(toBattlefield, ctx.controllerId);
    perm.tapped = true;
    p.battlefield.push(perm);
    const handPart = toHand.length ? ` and ${toHand.map(c => c.name).join(', ')} into ${p.name}'s hand` : '';
    this.log(`${ctx.card.name} puts ${toBattlefield.name} onto the battlefield tapped${handPart}.`);
    this.triggerETB(perm);
    this.triggerLandfall(perm);
    for (const c of toHand) p.hand.push(c);
    p.library = shuffle(p.library);
  }

  // "Search your library for up to two basic land cards, put them onto the
  // battlefield tapped, then shuffle" (Migration Path) — BOTH onto the
  // battlefield, unlike applyFetchTwoLandsEffect above (one battlefield,
  // one hand).
  // landType (e.g. "forest") restricts the search to that named land type
  // instead of the "Basic Land" supertype (Ranger's Path's own "up to two
  // Forest cards" — not necessarily basics).
  applyFetchTwoLandsBothToBattlefieldEffect(ctx, landType = null) {
    const p = this.getPlayer(ctx.controllerId);
    const matches = (c) => isLand(c) && (landType ? (c.typeLine || '').toLowerCase().includes(landType) : /\bBasic Land\b/.test(c.typeLine));
    const found = [];
    for (let i = 0; i < 2; i++) {
      const idx = p.library.findIndex(matches);
      if (idx === -1) break;
      found.push(p.library.splice(idx, 1)[0]);
    }
    if (found.length === 0) {
      this.log(`${ctx.card.name} finds no${landType ? ` ${landType}` : ' basic'} land in ${p.name}'s library.`);
      p.library = shuffle(p.library);
      return;
    }
    for (const card of found) {
      const perm = makePermanent(card, ctx.controllerId);
      perm.tapped = true;
      p.battlefield.push(perm);
      this.triggerETB(perm);
      this.triggerLandfall(perm);
    }
    this.log(`${ctx.card.name} puts ${found.map(c => c.name).join(' and ')} onto the battlefield tapped.`);
    p.library = shuffle(p.library);
  }

  // "Search your library for up to two basic land cards, ... put them into
  // your hand, then shuffle" (Yavimaya Elder's death trigger, and similar)
  // — both go to hand, unlike applyFetchTwoLandsEffect above (one onto the
  // battlefield, one to hand — Cultivate's shape).
  applyFetchTwoLandsToHandEffect(ctx, count = 2) {
    const p = this.getPlayer(ctx.controllerId);
    const found = [];
    for (let i = 0; i < count; i++) {
      const idx = p.library.findIndex(c => isLand(c) && /\bBasic Land\b/.test(c.typeLine));
      if (idx === -1) break;
      found.push(p.library.splice(idx, 1)[0]);
    }
    if (found.length === 0) {
      this.log(`${ctx.card.name} finds no basic land in ${p.name}'s library.`);
      p.library = shuffle(p.library);
      return;
    }
    for (const card of found) p.hand.push(card);
    this.log(`${ctx.card.name} puts ${found.map(c => c.name).join(' and ')} into ${p.name}'s hand.`);
    p.library = shuffle(p.library);
  }

  // "Search your library for up to two creature cards with mana value 1 or
  // less, ... put them into your hand, then shuffle." (Ranger of Eos) — a
  // general (non-land) sibling of applyFetchTwoLandsToHandEffect: any card
  // type, with a mana-value cap, all found copies go straight to hand.
  applyFetchUpToNCardsToHandEffect(ctx, typeWord, maxCount, maxCmc) {
    const p = this.getPlayer(ctx.controllerId);
    const found = [];
    for (let i = 0; i < maxCount; i++) {
      const idx = p.library.findIndex(c => hasTypeWord(c, typeWord) && (c.cmc || 0) <= maxCmc);
      if (idx === -1) break;
      found.push(p.library.splice(idx, 1)[0]);
    }
    if (found.length === 0) {
      this.log(`${ctx.card.name} finds no matching ${typeWord} card in ${p.name}'s library.`);
      p.library = shuffle(p.library);
      return;
    }
    for (const card of found) p.hand.push(card);
    this.log(`${ctx.card.name} puts ${found.map(c => c.name).join(' and ')} into ${p.name}'s hand.`);
    p.library = shuffle(p.library);
  }

  // "Return all land cards from your graveyard to the battlefield tapped."
  // (Splendid Reclamation) — every matching card at once, no auto-pick
  // needed since it's unconditional.
  applySplendidReclamationEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const lands = p.graveyard.filter(c => isLand(c));
    if (lands.length === 0) return;
    p.graveyard = p.graveyard.filter(c => !lands.includes(c));
    for (const card of lands) {
      const perm = makePermanent(card, ctx.controllerId);
      perm.tapped = true;
      p.battlefield.push(perm);
      this.triggerETB(perm);
      this.triggerLandfall(perm);
    }
    this.log(`${ctx.card.name} returns ${lands.length} land${lands.length > 1 ? 's' : ''} from ${p.name}'s graveyard to the battlefield tapped.`);
    this.checkStateBasedActions();
  }

  // "Return to the battlefield all permanent cards in your graveyard that
  // were put there from the battlefield this turn." (Faith's Reward) —
  // uses this.leftBattlefieldThisTurn (populated by movePermanentToGraveyard,
  // cleared each untap step) to distinguish freshly-dead cards from
  // whatever was already sitting in the graveyard from earlier turns.
  applyFaithsRewardEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const candidates = this.leftBattlefieldThisTurn
      .filter(entry => entry.ownerId === ctx.controllerId && isPermanentType(entry.card) && p.graveyard.includes(entry.card))
      .map(entry => entry.card);
    if (candidates.length === 0) return;
    for (const card of candidates) {
      p.graveyard = p.graveyard.filter(c => c !== card);
      const perm = makePermanent(card, ctx.controllerId);
      p.battlefield.push(perm);
      this.triggerETB(perm);
    }
    this.log(`${ctx.card.name} returns ${candidates.length} permanent${candidates.length > 1 ? 's' : ''} from ${p.name}'s graveyard to the battlefield.`);
    this.checkStateBasedActions();
  }

  // "Each player discards their hand, then draws cards equal to the
  // greatest number of cards a player discarded this way." (Windfall) — a
  // symmetric wheel effect; every player draws up to the SAME amount (the
  // largest hand any of them had), not just their own hand size.
  applyWindfallEffect(ctx) {
    let maxDiscarded = 0;
    for (const pl of this.players) {
      maxDiscarded = Math.max(maxDiscarded, pl.hand.length);
      for (const c of [...pl.hand]) this.discardCard(pl, c);
    }
    for (const pl of this.players) {
      for (let i = 0; i < maxDiscarded; i++) this.drawCard(pl);
    }
    this.log(`${ctx.card.name} has each player discard their hand and draw ${maxDiscarded} card${maxDiscarded === 1 ? '' : 's'}.`);
  }

  // "Reveal the top five cards of your library. An opponent separates
  // those cards into two piles. Put one pile into your hand and the other
  // into your graveyard." (Fact or Fiction) — no real "opponent splits the
  // piles" choice UI, so this splits as evenly as possible by mana value
  // (alternating assignment), then gives the caster the higher-value pile
  // — a reasonable, favorable-to-the-caster stand-in for the real choice.
  applyFactOrFictionEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const revealed = p.library.splice(0, Math.min(5, p.library.length));
    if (revealed.length === 0) return;
    const sorted = [...revealed].sort((a, b) => (b.cmc || 0) - (a.cmc || 0));
    const pileA = [], pileB = [];
    sorted.forEach((c, i) => (i % 2 === 0 ? pileA : pileB).push(c));
    const cmcTotal = (pile) => pile.reduce((s, c) => s + (c.cmc || 0), 0);
    const [handPile, gyPile] = cmcTotal(pileA) >= cmcTotal(pileB) ? [pileA, pileB] : [pileB, pileA];
    for (const c of handPile) p.hand.push(c);
    for (const c of gyPile) p.graveyard.push(c);
    this.log(`${ctx.card.name} reveals ${revealed.length} cards, putting ${handPile.length} into ${p.name}'s hand and ${gyPile.length} into the graveyard.`);
  }

  // "Will of the council — ... exile each permanent with the most votes"
  // (Council's Judgment) — no real vote UI; in this always-2-player engine,
  // this simplifies to exiling the opponent's single best (highest-CMC)
  // nonland permanent.
  applyCouncilsJudgmentEffect(ctx) {
    const opponent = this.opponentOf(ctx.controllerId);
    const candidates = opponent.battlefield.filter(perm => !isLand(perm.card));
    if (candidates.length === 0) return;
    const best = candidates.sort((a, b) => (b.card.cmc || 0) - (a.card.cmc || 0))[0];
    opponent.battlefield = opponent.battlefield.filter(x => x.id !== best.id);
    this.detachFromLeavingBattlefield(best);
    this.triggerLeavesBattlefield(best);
    opponent.exile.push(best.card);
    this.log(`${ctx.card.name} exiles ${best.card.name}.`);
    this.checkStateBasedActions();
  }

  // "Target creature you control deals damage equal to its power to each
  // other creature and each opponent." (Chandra's Ignition) — a sweep
  // sized by the target's current power, hitting every OTHER creature on
  // either battlefield plus the caster's opponent, but not the source
  // creature itself.
  applyChandrasIgnitionEffect(ctx) {
    if (ctx.target?.type !== 'permanent') return;
    const source = this.findPermanent(ctx.target.id);
    if (!source) return;
    const amount = this.effectivePower(source);
    for (const pl of this.players) {
      for (const perm of pl.battlefield) {
        if (perm.id === source.id || !isCreature(perm.card)) continue;
        this.applyDamageEffect({ ...ctx, target: { type: 'permanent', id: perm.id } }, amount);
      }
    }
    const opponent = this.opponentOf(ctx.controllerId);
    this.applyDamageEffect({ ...ctx, target: { type: 'player', id: opponent.id } }, amount);
    this.checkStateBasedActions();
  }

  // Thoughtseize/Duress-style: the target player reveals their hand and the
  // caster picks a card matching `filter` ("nonland", "noncreature,
  // nonland", "instant or sorcery", ...) for them to discard. "nonX" terms
  // must all hold; plain type terms are alternatives. The AI takes the
  // priciest match; a human caster picks from buttons.
  applyRevealDiscardEffect(ctx, filter, maxCmc = null) {
    if (ctx.target?.type !== 'player') return;
    const victim = this.getPlayer(ctx.target.id);
    const terms = filter.toLowerCase().split(/,\s*or\s+|,\s*|\s+or\s+/).map(t => t.trim()).filter(Boolean);
    const negatives = terms.filter(t => t.startsWith('non')).map(t => t.slice(3).replace(/^-/, ''));
    const positives = terms.filter(t => !t.startsWith('non') && t !== 'card');
    const typeLine = (c) => (c.typeLine || '').toLowerCase();
    const matches = (c) => negatives.every(t => !typeLine(c).includes(t))
      && (!positives.length || positives.some(t => typeLine(c).includes(t)))
      && (maxCmc == null || (c.cmc || 0) <= maxCmc);
    this.log(`${victim.name} reveals their hand: ${victim.hand.map(c => c.name).join(', ') || '(empty)'}.`);
    const candidates = victim.hand.filter(matches);
    if (!candidates.length) { this.log(`${ctx.card.name} finds nothing to take.`); return; }
    const take = (c) => {
      if (!victim.hand.includes(c)) return;
      this.log(`${victim.name} discards ${c.name} (${ctx.card.name}).`);
      this.discardCard(victim, c);
    };
    const sorted = candidates.slice().sort((a, b) => (b.cmc || 0) - (a.cmc || 0));
    const seen = new Set();
    const options = sorted.filter(c => !seen.has(c.name) && seen.add(c.name)).map(c => ({ label: `Take ${c.name}`, resolve: () => take(c) }));
    this.requestChoice(ctx.controllerId, `${ctx.card.name}: choose a card for ${victim.name} to discard`, options, 0);
  }

  // Every discard goes through here, so discard-matters keywords see all of
  // them: Mayhem (castable from the graveyard if discarded this turn) and
  // Madness (discarded into exile instead, then cast for its madness cost
  // or put into the graveyard). Callers log the discard themselves.
  discardCard(p, card) {
    const i = p.hand.indexOf(card);
    if (i === -1) return;
    p.hand.splice(i, 1);
    (p.discardedThisTurn ||= []).push(card.instanceId);
    const madness = getMadnessCost(card);
    if (!madness) { p.graveyard.push(card); return; }
    p.exile.push(card);
    const toGraveyard = () => {
      const j = p.exile.indexOf(card);
      if (j !== -1) { p.exile.splice(j, 1); p.graveyard.push(card); }
    };
    const cast = () => {
      const j = p.exile.indexOf(card);
      if (j === -1) return;
      p.exile.splice(j, 1);
      if (this.castFromOutsideHand(p.id, card, { costOverride: madness, fromZone: 'exile', onFail: () => p.graveyard.push(card) })) {
        this.log(`${p.name} casts ${card.name} for its madness cost (${madness}).`);
      } else {
        this.log(`${card.name} can't be cast for madness right now.`);
        p.graveyard.push(card);
      }
    };
    const affordable = this.canAffordCost(p.id, card, madness);
    this.requestChoice(p.id, `${card.name} was discarded — Madness ${madness}`, [
      { label: `Cast it for ${madness}`, resolve: cast },
      { label: 'Put it into your graveyard', resolve: toGraveyard },
    ], affordable ? 0 : 1);
  }

  // Whether `cost` (a mana string standing in for the card's own cost) is
  // payable right now, with the card's usual cost reductions.
  canAffordCost(playerId, card, cost) {
    const parsed = parseManaCost(cost || '');
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    return !!this.planSpellPayment(playerId, card, parsed, 0);
  }

  // "Draw two cards, then discard a card" — the controller chooses what to
  // discard: the AI its least useful cards (discardFodder), a human picks
  // one at a time from buttons.
  applyLootDiscard(ctx, amount) {
    const p = this.getPlayer(ctx.controllerId);
    const discardOne = (c) => {
      if (!p.hand.includes(c)) return;
      this.log(`${p.name} discards ${c.name}.`);
      this.discardCard(p, c);
    };
    if (p.isAI) {
      for (const c of this.discardFodder(p).slice(0, amount)) discardOne(c);
      return;
    }
    const askOnce = (left) => {
      if (left <= 0 || p.hand.length === 0) return;
      const names = new Set();
      const options = [];
      for (const c of p.hand) {
        if (names.has(c.name)) continue;
        names.add(c.name);
        options.push({ label: `Discard ${c.name}`, resolve: () => { discardOne(c); askOnce(left - 1); } });
      }
      this.requestChoice(p.id, `${ctx.card.name}: discard ${left > 1 ? `${left} cards (one at a time)` : 'a card'}`, options);
    };
    askOnce(amount);
  }

  // Simplification: picks randomly rather than letting the discarding player choose.
  applyDiscardEffect(ctx, amount) {
    if (ctx.target?.type !== 'player') return;
    const p = this.getPlayer(ctx.target.id);
    if (!p) return;
    let discarded = 0;
    for (let i = 0; i < amount && p.hand.length > 0; i++) {
      this.discardCard(p, p.hand[Math.floor(Math.random() * p.hand.length)]);
      discarded++;
    }
    if (discarded > 0) this.log(`${p.name} discards ${discarded} card${discarded > 1 ? 's' : ''}.`);
  }

  // "That player exiles the top two cards of their library" (Sire of
  // Stagnation's own opponent-scoped landfall trigger) — a mill-shaped
  // effect, but to EXILE rather than the graveyard, and always the
  // controller's OPPONENT (real "that player" in that trigger always means
  // whichever opponent's land just entered) rather than a real target.
  applyExileMillEffect(ctx, amount) {
    const p = this.opponentOf(ctx.controllerId);
    let exiled = 0;
    for (let i = 0; i < amount && p.library.length > 0; i++) {
      p.exile.push(p.library.shift());
      exiled++;
    }
    this.log(`${p.name} exiles the top ${exiled} card${exiled === 1 ? '' : 's'} of their library.`);
  }

  // "Exile the top card of that player's library. Until the end of your
  // next turn, you may play that card." (Ragavan, Nimble Pilferer;
  // Nightveil Specter) — a REAL temporary exile-and-play permission,
  // distinct from this engine's older "impulse-draw as a straight draw"
  // simplification used for cards like Light Up the Stage (no expiration to
  // track there). The entry lives on the ALLOWED player's own
  // exiledPlayable list (see playCardFromExile to actually play it, and
  // doCleanup below for how it expires).
  applyExileAndPlayEffect(ctx, { fromOpponent = true, persistent = false } = {}) {
    const allowed = this.getPlayer(ctx.controllerId);
    const source = fromOpponent ? this.opponentOf(ctx.controllerId) : allowed;
    if (source.library.length === 0) return;
    const card = source.library.shift();
    // `persistent: true` (Nightveil Specter's own "cards exiled with this
    // creature" pool) never expires via doCleanup's own-turn countdown —
    // Infinity just always fails that `> 0` check going forward.
    allowed.exiledPlayable.push({ id: uid('exile'), card, remainingOwnTurns: persistent ? Infinity : 2 });
    this.log(`${allowed.name} exiles ${card.name} from ${fromOpponent ? `${source.name}'s` : 'their own'} library — they may play it ${persistent ? 'for the rest of the game' : 'until the end of their next turn'}.`);
  }

  // Plays or casts a card straight out of a player's exiledPlayable list
  // (see applyExileAndPlayEffect above), rather than out of their hand.
  // Reuses playLand/castSpell entirely rather than re-implementing mana
  // payment/ETB/stack logic: the card is temporarily reunited with the
  // player's hand (exactly where those methods already expect to find a
  // card by instanceId), and only actually removed from the exile list once
  // the play/cast SUCCEEDS — an illegal or unaffordable attempt leaves it
  // in exile to try again later, with no other side effect.
  playCardFromExile(playerId, exileId, { targets = [], xValue = 0, modeIndexes = null, kicked = false } = {}) {
    const p = this.getPlayer(playerId);
    const idx = p.exiledPlayable.findIndex(e => e.id === exileId);
    if (idx === -1) return { ok: false, reason: 'That card is no longer available to play.' };
    const entry = p.exiledPlayable[idx];
    const card = entry.card;
    if (!this.canPlayFromExile(playerId, exileId)) return { ok: false, reason: entry.notOnTurn === this.turnNumber ? "That can't be cast until a later turn." : 'Cannot play that right now.' };
    p.hand.push(card);
    // Foretold cards cost their foretell cost; plotted ones are free.
    const result = isLand(card)
      ? (this.playLand(playerId, card.instanceId) ? { ok: true } : { ok: false, reason: 'Cannot play that land right now.' })
      : this.castSpell(playerId, card.instanceId, targets, xValue, modeIndexes, kicked, { free: !!entry.free, costOverride: entry.costOverride || null, fromZone: 'exile' });
    if (result.ok) {
      p.exiledPlayable.splice(idx, 1);
    } else {
      const handIdx = p.hand.findIndex(c => c.instanceId === card.instanceId);
      if (handIdx !== -1) p.hand.splice(handIdx, 1);
    }
    return result;
  }

  getExiledPlayable(playerId) {
    return this.getPlayer(playerId).exiledPlayable;
  }

  canPlayFromExile(playerId, exileId) {
    const p = this.getPlayer(playerId);
    const entry = p.exiledPlayable.find(e => e.id === exileId);
    if (!entry) return false;
    const card = entry.card;
    // Foretold/plotted/warped cards: only on a later turn; plotted ones
    // only at sorcery speed.
    if (entry.notOnTurn === this.turnNumber) return false;
    if (!isLand(card) && (this.splitSecondActive() || p.cantCastSpells)) return false;
    if (entry.sorceryOnly && !(p.id === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    if (isLand(card)) return this.canPlayLand(playerId);
    if (!this.canCastSpell(playerId, card)) return false;
    if (entry.free) return true;
    return entry.costOverride ? this.canAffordCost(playerId, card, entry.costOverride) : this.affordability(playerId, card);
  }

  // ---------- casting from the graveyard (Flashback, Escape) ----------
  // A meaningfully different shape from exile-and-play above: the
  // alternative cost ISN'T the card's own printed mana cost (Flashback
  // {2}{R} on a {1}{U} instant, say), and Escape adds a real second cost
  // (exiling N OTHER graveyard cards) on top of its own mana cost.

  getFlashbackCost(card) { return getFlashbackCost(card); }
  getEscapeCost(card) { return getEscapeCost(card); }

  // Graveyard cast options for a card: see effects.js's getGraveyardCastCosts.
  getGraveyardCastCosts(card) { return getGraveyardCastCosts(card); }

  // Ways `card` in playerId's graveyard can be cast right now: the
  // getGraveyardCastCosts entries whose extra requirements are met (enough
  // other cards for Escape, a card/land to discard for Jump-start/Retrace,
  // discarded this turn for Mayhem), at legal timing, and affordable.
  getGraveyardCastWays(playerId, cardInstanceId) {
    if (this.pendingRequest || this.priorityPlayer.id !== playerId || this.splitSecondActive()) return [];
    if (this.getPlayer(playerId).cantCastSpells) return [];
    const p = this.getPlayer(playerId);
    const card = p.graveyard.find(c => c.instanceId === cardInstanceId);
    if (!card) return [];
    const instantSpeed = isInstant(card) || /flash/.test((card.keywords || []).join(','));
    if (!instantSpeed && !(p.id === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return [];
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    return getGraveyardCastCosts(card).filter(way => {
      if (way.exileCount && p.graveyard.length - 1 < way.exileCount) return false;
      if (way.discard === 'any' && p.hand.length === 0) return false;
      if (way.discard === 'land' && !p.hand.some(isLand)) return false;
      if (way.needsDiscardedThisTurn && !(p.discardedThisTurn || []).includes(card.instanceId)) return false;
      const parsedG = parseManaCost(way.manaCost);
      if (way.tapReduce) parsedG.generic = Math.max(0, parsedG.generic - (this.harmonizeHelper(p)?.power || 0));
      return !!planManaPayment(untapped, parsedG, 0, p.manaPool);
    });
  }

  // via: 'flashback' | 'escape' | 'jumpstart' | 'retrace' | 'mayhem'
  // (viaEscape: true is the older spelling of via: 'escape').
  canCastFromGraveyard(playerId, cardInstanceId, { viaEscape = false, via = null } = {}) {
    const kind = via || (viaEscape ? 'escape' : 'flashback');
    return this.getGraveyardCastWays(playerId, cardInstanceId).some(w => w.via === kind);
  }

  // Casts a card straight out of the graveyard. Same "temporarily reunite
  // with hand, reuse castSpell entirely" trick as playCardFromExile —
  // except the reunited card's manaCost is TEMPORARILY OVERRIDDEN to the
  // graveyard cost first (so castSpell charges the right amount), then
  // restored right after a successful cast. Extra costs are paid after the
  // cast succeeds: Escape exiles other graveyard cards; Jump-start and
  // Retrace discard a card (`discardId`, or the least useful one). Flashback,
  // Jump-start, and Escape (for a nonpermanent) exile the card as it
  // resolves; Retrace and Mayhem don't.
  castFromGraveyard(playerId, cardInstanceId, { targets = [], xValue = 0, modeIndexes = null, viaEscape = false, via = null, discardId = null } = {}) {
    const kind = via || (viaEscape ? 'escape' : 'flashback');
    const way = this.getGraveyardCastWays(playerId, cardInstanceId).find(w => w.via === kind);
    if (!way) return { ok: false, reason: 'Cannot cast that from the graveyard right now.' };
    const p = this.getPlayer(playerId);
    let discard = null;
    if (way.discard) {
      const pool = way.discard === 'land' ? p.hand.filter(isLand) : p.hand;
      discard = pool.find(c => c.instanceId === discardId) || this.discardFodder(p).find(c => pool.includes(c));
      if (!discard) return { ok: false, reason: `${kind === 'retrace' ? 'Retrace needs a land card' : 'Jump-start needs a card'} to discard.` };
    }
    const idx = p.graveyard.findIndex(c => c.instanceId === cardInstanceId);
    const original = p.graveyard[idx];
    const originalManaCost = original.manaCost;
    // Harmonize: tap our strongest untapped creature to cut the generic cost.
    let manaCost = way.manaCost;
    const helper = way.tapReduce ? this.harmonizeHelper(p) : null;
    if (helper) manaCost = subtractManaCost(way.manaCost, `{${helper.power}}`);
    const overridden = way.face ? { ...faceCard(original, way.face), manaCost } : { ...original, manaCost };
    p.graveyard.splice(idx, 1);
    p.hand.push(overridden);
    const result = this.castSpell(playerId, overridden.instanceId, targets, xValue, modeIndexes, false, { fromZone: 'graveyard' });
    if (!result.ok) {
      const handIdx = p.hand.findIndex(c => c.instanceId === overridden.instanceId);
      if (handIdx !== -1) p.hand.splice(handIdx, 1);
      p.graveyard.splice(idx, 0, original);
      return result;
    }
    if (!way.face) overridden.manaCost = originalManaCost;
    if (kind === 'escape') {
      for (let i = 0; i < way.exileCount && p.graveyard.length > 0; i++) p.exile.push(p.graveyard.shift());
      this.log(`${p.name} exiles ${way.exileCount} other card${way.exileCount === 1 ? '' : 's'} from their graveyard to pay Escape.`);
    }
    if (helper) { helper.perm.tapped = true; this.log(`${p.name} taps ${helper.perm.card.name} to harmonize ${original.name}.`); }
    if (discard) {
      this.log(`${p.name} discards ${discard.name} to ${kind === 'retrace' ? 'retrace' : 'jump-start'} ${original.name}.`);
      this.discardCard(p, discard);
    }
    const stackItem = this.stack.find(item => item.card === overridden);
    if (stackItem) {
      stackItem.viaFlashback = kind === 'flashback' || kind === 'jumpstart' || kind === 'harmonize' || kind === 'aftermath';
      stackItem.viaEscape = kind === 'escape';
      stackItem.graveyardVia = kind;
    }
    return result;
  }

  // "For each opponent, you may cast up to one target instant or sorcery
  // card from that player's graveyard without paying its mana cost. If a
  // spell cast this way would be put into a graveyard, exile it instead."
  // (Diluvian Primordial) — genuinely different from castFromGraveyard
  // above: the CASTER (ctx.controllerId) isn't the card's owner, the cast
  // is entirely free (castSpell's `free` option), and the card needs to
  // come back to ITS OWNER's exile, not the caster's, once it resolves
  // (see resolveTop's `item.exileToOwnerId`). No real "which card" choose
  // UI, so (same simplification as every other "target card from a
  // graveyard" effect in this engine) this auto-picks the highest-CMC
  // instant/sorcery in the opponent's graveyard.
  applyFreeCastFromOpponentGraveyardEffect(ctx) {
    if (!ctx.controllerId) return;
    const caster = this.getPlayer(ctx.controllerId);
    const opponent = this.opponentOf(ctx.controllerId);
    const candidates = opponent.graveyard.filter(c => isInstant(c) || isSorcery(c));
    if (candidates.length === 0) return;
    const card = candidates.sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    const idx = opponent.graveyard.indexOf(card);
    opponent.graveyard.splice(idx, 1);
    caster.hand.push(card);

    const kinds = this.getRequiredTargetKinds(card);
    const targets = kinds.map(k => this.autoPickTarget(k, ctx.controllerId)).filter(Boolean);
    if (this.getMinRequiredTargetCount(card) > targets.length) {
      // No legal target for the borrowed spell — give it back rather than
      // burn it for nothing.
      const handIdx = caster.hand.findIndex(c => c.instanceId === card.instanceId);
      if (handIdx !== -1) caster.hand.splice(handIdx, 1);
      opponent.graveyard.splice(idx, 0, card);
      return;
    }

    const result = this.castSpell(ctx.controllerId, card.instanceId, targets, 0, null, false, { free: true });
    if (!result.ok) {
      const handIdx = caster.hand.findIndex(c => c.instanceId === card.instanceId);
      if (handIdx !== -1) caster.hand.splice(handIdx, 1);
      opponent.graveyard.splice(idx, 0, card);
      return;
    }
    const stackItem = this.stack[this.stack.length - 1];
    if (stackItem && stackItem.card === card) stackItem.exileToOwnerId = opponent.id;
  }

  // "Whenever Etali attacks, exile the top card of each player's library,
  // then you may cast any number of spells from among those cards without
  // paying their mana costs." (Etali, Primal Storm) — exiles ONE card per
  // player (including Etali's own controller), then attempts to cast
  // EVERY exiled non-land card for free. No real "which ones, in what
  // order, what to target" choice UI, so it just tries them all, auto-
  // targeting each and skipping (leaving exiled) any with no legal
  // target or that otherwise fail to cast. Unlike Diluvian Primordial's
  // own free-cast (which explicitly says "exile it instead" if a card
  // would go to a graveyard), Etali's text has no such clause, so a spell
  // cast this way just goes to its OWNER's graveyard normally once it
  // resolves — see castSpell's own `ownerId` option, which this relies on
  // whenever the card's owner isn't Etali's own controller.
  applyEtaliAttackTriggerEffect(ctx) {
    const caster = this.getPlayer(ctx.controllerId);
    const exiledFrom = [];
    for (const pl of this.players) {
      if (pl.library.length === 0) continue;
      const card = pl.library.shift();
      pl.exile.push(card);
      exiledFrom.push({ card, ownerId: pl.id });
      this.log(`${ctx.card.name} exiles the top card of ${pl.name}'s library: ${card.name}.`);
    }
    for (const { card, ownerId } of exiledFrom) {
      if (isLand(card)) continue;
      const owner = this.getPlayer(ownerId);
      const exileIdx = owner.exile.indexOf(card);
      if (exileIdx === -1) continue;
      owner.exile.splice(exileIdx, 1);
      caster.hand.push(card);
      const kinds = this.getRequiredTargetKinds(card);
      const targets = kinds.map(k => this.autoPickTarget(k, ctx.controllerId)).filter(Boolean);
      if (this.getMinRequiredTargetCount(card) > targets.length) {
        const handIdx = caster.hand.findIndex(c => c.instanceId === card.instanceId);
        if (handIdx !== -1) caster.hand.splice(handIdx, 1);
        owner.exile.push(card);
        continue;
      }
      const result = this.castSpell(ctx.controllerId, card.instanceId, targets, 0, null, false,
        { free: true, bypassTiming: true, ownerId });
      if (!result.ok) {
        const handIdx = caster.hand.findIndex(c => c.instanceId === card.instanceId);
        if (handIdx !== -1) caster.hand.splice(handIdx, 1);
        owner.exile.push(card);
      }
    }
    this.checkStateBasedActions();
  }

  // "Each opponent reveals cards from the top of their library until they
  // reveal X land cards, then puts all cards revealed this way into their
  // graveyard." (Mind Grind) — this engine is strictly 2-player, so "each
  // opponent" is always just the one. "X can't be 0" is acknowledged as
  // its own clause elsewhere but not enforced as an actual casting
  // restriction (same "recognized, not enforced" simplification used for
  // other rare cost/target restrictions this engine can't fully validate).
  applyRevealUntilLandsMillEffect(ctx, xValue) {
    if (xValue <= 0) return;
    const opponent = this.opponentOf(ctx.controllerId);
    let landsRevealed = 0;
    let milled = 0;
    while (landsRevealed < xValue && opponent.library.length > 0) {
      const card = opponent.library.shift();
      opponent.graveyard.push(card);
      milled++;
      if (isLand(card)) landsRevealed++;
    }
    this.log(`${opponent.name} reveals cards from their library until revealing ${xValue} land card${xValue === 1 ? '' : 's'}, milling ${milled} card${milled === 1 ? '' : 's'} total.`);
  }

  applyMillEffect(ctx, amount) {
    const p = ctx.target?.type === 'player' ? this.getPlayer(ctx.target.id) : this.getPlayer(ctx.controllerId);
    if (!p) return;
    let milled = 0;
    for (let i = 0; i < amount && p.library.length > 0; i++) {
      p.graveyard.push(p.library.shift());
      milled++;
    }
    this.log(`${p.name} mills ${milled} card${milled === 1 ? '' : 's'}.`);
  }

  applyExileEffect(ctx) {
    // Multi-target ("exile up to two target artifacts and/or enchantments"
    // — Angel of the Ruins, Sylvan Reclamation, Protector of the Wastes):
    // re-dispatch once per chosen target — see resolveEffectSteps for
    // ctx.targets. Also resets sourcePerm.exiledCards to an empty list
    // first so a (currently hypothetical) paired "return the exiled cards"
    // trigger — see applyReturnExiledCardsEffect, built for Detention
    // Sphere — would collect every one of them, not just the last.
    if (ctx.targets && ctx.targets.length > 1) {
      if (ctx.sourcePerm) ctx.sourcePerm.exiledCards = [];
      for (const t of ctx.targets) this.applyExileEffect({ ...ctx, target: t, targets: null });
      return;
    }
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    const p = this.getPlayer(perm.controllerId);
    p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
    this.detachFromLeavingBattlefield(perm);
    this.triggerLeavesBattlefield(perm);
    // Remember what THIS source exiled (and who owns it), for a paired
    // "when this leaves the battlefield, return the exiled card" effect
    // (Oblivion Ring, Journey to Nowhere, Banishing Light, ...). Harmless
    // bookkeeping for any exile effect that has no such pairing.
    if (ctx.sourcePerm) {
      ctx.sourcePerm.exiledCard = perm.card;
      ctx.sourcePerm.exiledCardOwnerId = perm.ownerId;
      if (ctx.sourcePerm.exiledCards) ctx.sourcePerm.exiledCards.push({ card: perm.card, ownerId: perm.ownerId });
    }
    if (this.redirectCommanderToZone(perm)) return;
    this.getPlayer(perm.ownerId).exile.push(...this.cardsOf(perm));
    this.log(`${ctx.card.name} exiles ${perm.card.name}.`);
  }

  // "Exile target creature you control, then return that card to the
  // battlefield under your/its owner's control" (Restoration Angel,
  // Momentary Blink, Ghostly Flicker, and the whole "flicker"/blink
  // archetype) — an IMMEDIATE combined exile-and-return, unlike Oblivion
  // Ring's exile-now/return-later split across two separate triggers. Re-
  // entering is what actually re-fires ETB triggers, which is the entire
  // point of a blink effect. underCasterControl distinguishes "under your
  // control" (Restoration Angel — control changes, but NOT ownership,
  // hence overriding newPerm.ownerId below) from "under its owner's
  // control" (Ghostly Flicker — controller is unchanged, own permanents).
  applyFlickerEffect(ctx, underCasterControl) {
    // Multi-target ("up to two target artifacts, creatures, and/or lands
    // you control" — Ghostly Flicker): re-dispatch once per chosen target
    // rather than duplicating the single-target logic below. See
    // resolveEffectSteps for how ctx.targets gets populated.
    if (ctx.targets && ctx.targets.length > 1) {
      for (const t of ctx.targets) this.applyFlickerEffect({ ...ctx, target: t, targets: null }, underCasterControl);
      return;
    }
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    const p = this.getPlayer(perm.controllerId);
    p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
    this.detachFromLeavingBattlefield(perm);
    this.triggerLeavesBattlefield(perm);
    const newControllerId = underCasterControl ? ctx.controllerId : perm.ownerId;
    const controller = this.getPlayer(newControllerId);
    const newPerm = makePermanent(perm.card, newControllerId);
    newPerm.ownerId = perm.ownerId;
    controller.battlefield.push(newPerm);
    this.log(`${ctx.card.name} exiles ${perm.card.name}, then returns it to the battlefield under ${controller.name}'s control.`);
    this.checkStateBasedActions();
    this.triggerETB(newPerm);
  }

  // "Exile any number of target nonland permanents you control, then return
  // those cards to the battlefield under their owner's control" (Brago,
  // King Eternal's own combat-damage trigger) — "any number" has no real
  // multi-target choose UI (same simplification used for Genesis Wave's
  // "any number of permanent cards" and Gishath's "any number of Dinosaur
  // cards"), so this flickers every qualifying permanent the controller
  // controls, always back under their own control (Brago never steals
  // anything — "their owner's control" is always the same player here).
  applyMassFlickerOwnEffect(ctx, typeWord = null) {
    const controller = this.getPlayer(ctx.controllerId);
    for (const perm of [...controller.battlefield]) {
      if (typeWord === 'nonland' && isLand(perm.card)) continue;
      controller.battlefield = controller.battlefield.filter(x => x.id !== perm.id);
      this.detachFromLeavingBattlefield(perm);
      this.triggerLeavesBattlefield(perm);
      const newPerm = makePermanent(perm.card, perm.controllerId);
      newPerm.ownerId = perm.ownerId;
      controller.battlefield.push(newPerm);
      this.log(`${ctx.card.name} exiles ${perm.card.name}, then returns it to the battlefield under ${controller.name}'s control.`);
      this.checkStateBasedActions();
      this.triggerETB(newPerm);
    }
  }

  // "Whenever another creature you own dies, return it to your hand unless
  // target opponent pays 3 life" (Athreos, God of Passage) — "it" is the
  // creature that just died (ctx.diedCard, threaded from triggerDies),
  // found in ITS OWNER's graveyard (not necessarily ctx.controllerId's own,
  // though in this engine's ownerId/controllerId always coincide since
  // there's no control-stealing). Same "may"-style simplification used
  // throughout this engine for optional costs/effects: the opponent never
  // actually pays, so the creature always comes back.
  applyReturnDiedCardToHandEffect(ctx) {
    if (!ctx.diedCard) return;
    const p = this.getPlayer(ctx.controllerId);
    const idx = p.graveyard.indexOf(ctx.diedCard);
    if (idx === -1) return;
    p.graveyard.splice(idx, 1);
    p.hand.push(ctx.diedCard);
    this.log(`${ctx.card.name} returns ${ctx.diedCard.name} to ${p.name}'s hand.`);
  }

  // "Gain control of target permanent until end of turn" (Zealous
  // Conscripts, Threaten, and the whole "Threaten effect" archetype) —
  // control is a function of WHICH player's battlefield array a permanent
  // sits in, so this actually moves it rather than just flipping a field.
  // Remembers the original controller in this.controlChanges so
  // revertControlChanges (called at cleanup) can move it back at the end
  // of the turn — the same "until end of turn" duration as tempBuffs/
  // tempKeywords. Optionally untaps it and/or grants haste, matching the
  // "Untap that permanent. It gains haste until end of turn." half almost
  // every real Threaten effect pairs with this. Scoped to the temporary
  // "until end of turn" shape only — a permanent control-change tied to an
  // Aura staying on the battlefield (Mind Control) is a different duration
  // this doesn't handle.
  applyGainControlEffect(ctx, { untap = false, haste = false } = {}) {
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    const oldController = this.getPlayer(perm.controllerId);
    const newController = this.getPlayer(ctx.controllerId);
    if (oldController.id === newController.id) return;
    oldController.battlefield = oldController.battlefield.filter(x => x.id !== perm.id);
    newController.battlefield.push(perm);
    perm.controllerId = newController.id;
    this.controlChanges.push({ permId: perm.id, originalControllerId: oldController.id });
    if (untap) perm.tapped = false;
    if (haste) perm.tempKeywords.push('haste');
    this.log(`${newController.name} gains control of ${perm.card.name} until end of turn.`);
    this.checkStateBasedActions();
  }

  // Reverts every pending control change (see applyGainControlEffect) at
  // cleanup — moves each permanent back to its original controller's
  // battlefield and restores controllerId. A permanent no longer on ANY
  // battlefield (died, got exiled, etc. while under temporary control) is
  // just dropped — nothing left to revert.
  revertControlChanges() {
    if (this.controlChanges.length === 0) return;
    for (const { permId, originalControllerId } of this.controlChanges) {
      const perm = this.findPermanent(permId);
      if (!perm) continue;
      const originalController = this.getPlayer(originalControllerId);
      if (!originalController || perm.controllerId === originalControllerId) continue;
      const currentController = this.getPlayer(perm.controllerId);
      currentController.battlefield = currentController.battlefield.filter(x => x.id !== perm.id);
      perm.controllerId = originalControllerId;
      originalController.battlefield.push(perm);
      this.log(`${perm.card.name} returns to ${originalController.name}'s control.`);
    }
    this.controlChanges = [];
  }

  // "Exchange control of this creature and up to one target creature an
  // opponent controls." (Gilded Drake, and the whole "exchange control"
  // archetype) — a PERMANENT two-way swap, unlike applyGainControlEffect's
  // "until end of turn" Threaten shape: each creature just switches
  // controller for good, with no reversion at cleanup. Returns whether the
  // exchange actually happened, so the caller (the effects.js clause) can
  // fall through to "sacrifice this creature" when it didn't.
  applyExchangeControlEffect(ctx) {
    if (!ctx.sourcePerm || ctx.target?.type !== 'permanent') return { exchanged: false };
    const self = this.findPermanent(ctx.sourcePerm.id);
    const other = this.findPermanent(ctx.target.id);
    if (!self || !other) return { exchanged: false };
    const selfController = this.getPlayer(self.controllerId);
    const otherController = this.getPlayer(other.controllerId);
    if (selfController.id === otherController.id) return { exchanged: false };
    selfController.battlefield = selfController.battlefield.filter(x => x.id !== self.id);
    otherController.battlefield = otherController.battlefield.filter(x => x.id !== other.id);
    self.controllerId = otherController.id;
    other.controllerId = selfController.id;
    otherController.battlefield.push(self);
    selfController.battlefield.push(other);
    this.log(`${selfController.name} and ${otherController.name} exchange control of ${self.card.name} and ${other.card.name}.`);
    this.checkStateBasedActions();
    return { exchanged: true };
  }

  // "You control enchanted creature." (Mind Control, Control Magic) — moves
  // the enchanted creature to the AURA's controller's battlefield and
  // records the link (auraPerm.grantsControlOf) so detachFromLeavingBattlefield
  // can hand it back the moment this Aura itself leaves the battlefield.
  // Unlike applyExchangeControlEffect above, there's no reversion at
  // cleanup and no swap — just a one-way move, permanent for as long as
  // the Aura stays right where it is.
  applyAuraControlEffect(auraPerm, targetPerm) {
    const newController = this.getPlayer(auraPerm.controllerId);
    const oldController = this.getPlayer(targetPerm.controllerId);
    if (newController.id === oldController.id) return;
    oldController.battlefield = oldController.battlefield.filter(x => x.id !== targetPerm.id);
    targetPerm.controllerId = newController.id;
    targetPerm.summoningSick = true;
    newController.battlefield.push(targetPerm);
    auraPerm.grantsControlOf = targetPerm.id;
    this.log(`${newController.name} gains control of ${targetPerm.card.name} via ${auraPerm.card.name}.`);
  }

  // "It fights another target creature" (Territorial Allosaurus's own
  // Kicker payoff, and any plain Fight spell like Prey Upon) — each
  // creature deals damage to the other equal to its power, simultaneously,
  // independent of combat (no blocking, no first strike, no lifelink
  // interaction — a pure damage exchange). ctx.sourcePerm is one fighter,
  // ctx.target the other.
  // Bite (one-sided) or fight between the "creature you control" chosen
  // earlier in this resolution and the target.
  applyBiteEffect(ctx, fight = false) {
    const src = this._biteSourceId ? this.findPermanent(this._biteSourceId) : ctx.sourcePerm;
    const victim = ctx.target?.type === 'permanent' ? this.findPermanent(ctx.target.id) : null;
    if (!src || !victim || src.id === victim.id) return;
    const sp = this.effectivePower(src), vp = this.effectivePower(victim);
    this.applyDamageEffect({ ...ctx, card: src.card, sourcePerm: src, target: { type: 'permanent', id: victim.id } }, sp);
    if (fight) this.applyDamageEffect({ ...ctx, card: victim.card, sourcePerm: victim, target: { type: 'permanent', id: src.id } }, vp);
    this.log(`${src.card.name} ${fight ? 'fights' : 'bites'} ${victim.card.name}.`);
    this.checkStateBasedActions();
  }

  applyFightEffect(ctx) {
    if (!ctx.sourcePerm || ctx.target?.type !== 'permanent') return;
    const self = this.findPermanent(ctx.sourcePerm.id);
    const other = this.findPermanent(ctx.target.id);
    if (!self || !other) return;
    const selfPower = this.effectivePower(self);
    const otherPower = this.effectivePower(other);
    this.damageCreature(other, selfPower, this.effectiveKeywords(self));
    this.damageCreature(self, otherPower, this.effectiveKeywords(other));
    this.log(`${self.card.name} fights ${other.card.name} (${selfPower} damage to ${other.card.name}, ${otherPower} damage to ${self.card.name}).`);
    this.checkStateBasedActions();
  }

  // Puts a permanent on the bottom of its OWNER's library — or every
  // creature, for Terminus. It leaves the battlefield without dying, so no
  // "dies" triggers; a commander may go to the command zone instead.
  applyTuckEffect(ctx, { allCreatures = false } = {}) {
    let perms;
    if (allCreatures) {
      perms = this.players.flatMap(pl => pl.battlefield.filter(x => isCreature(x.card)));
    } else {
      const perm = ctx.target?.type === 'permanent' ? this.findPermanent(ctx.target.id) : null;
      perms = perm ? [perm] : [];
    }
    for (const perm of perms) {
      const p = this.getPlayer(perm.controllerId);
      this._lastTucked = { controllerId: perm.controllerId, toughness: this.effectiveToughness(perm) };
      p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
      this.detachFromLeavingBattlefield(perm);
      this.triggerLeavesBattlefield(perm);
      if (this.exileIfUnearthed(perm)) continue;
      if (this.redirectCommanderToZone(perm)) continue;
      this.getPlayer(perm.ownerId).library.push(perm.card);
    }
    if (perms.length) this.log(`${ctx.card.name} puts ${allCreatures ? `${perms.length} creature${perms.length === 1 ? '' : 's'}` : perms[0].card.name} on the bottom of ${allCreatures ? "their owners' libraries" : "its owner's library"}.`);
    this.checkStateBasedActions();
  }

  applyLastTuckedLifegain() {
    if (!this._lastTucked) return;
    const pl = this.getPlayer(this._lastTucked.controllerId);
    const amount = Math.max(0, this._lastTucked.toughness);
    pl.life += amount;
    this.log(`${pl.name} gains ${amount} life.`);
    this._lastTucked = null;
  }

  applyBounceEffect(ctx) {
    // Multi-target ("return up to two target creatures to their owners'
    // hands" — Horses of the Bruinen, Hoverguard Sweepers, ...): re-
    // dispatch once per chosen target — see resolveEffectSteps for
    // ctx.targets.
    if (ctx.targets && ctx.targets.length > 1) {
      for (const t of ctx.targets) this.applyBounceEffect({ ...ctx, target: t, targets: null });
      return;
    }
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    const owner = this.getPlayer(perm.ownerId);
    const p = this.getPlayer(perm.controllerId);
    p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
    this.detachFromLeavingBattlefield(perm);
    this.triggerLeavesBattlefield(perm);
    if (this.exileIfUnearthed(perm)) return;
    if (this.redirectCommanderToZone(perm)) return;
    owner.hand.push(...this.cardsOf(perm));
    this.log(`${ctx.card.name} returns ${perm.card.name} to ${owner.name}'s hand.`);
  }

  // "Regrowth" effect: a card from a graveyard to hand — a different zone
  // than applyBounceEffect's battlefield-to-hand. Which card is a
  // graveyard choice this engine's targeting UI has no way to prompt for,
  // so — same simplification as applyEdictEffect's "weakest creature"
  // auto-pick below — it always grabs the highest-cost qualifying card.
  // An optional typeWords list (Archaeomancer's "instant or sorcery",
  // e.g.) restricts the pool; with none given, it defaults to nonland
  // cards (Regrowth/Eternal Witness's own unrestricted "target card").
  applyRegrowthEffect(ctx, typeWords = null, { excludeSelf = false } = {}) {
    const p = this.getPlayer(ctx.controllerId);
    if (excludeSelf) return this.applyRegrowthEffect({ ...ctx, _exclude: ctx.diedCard || ctx.card }, typeWords);
    if (p.graveyard.length === 0) {
      this.log(`${ctx.card.name} finds no card in ${p.name}'s graveyard.`);
      return;
    }
    const gy = ctx._exclude ? p.graveyard.filter(c => c !== ctx._exclude && c.name !== ctx._exclude.name) : p.graveyard;
    const pool = typeWords
      ? gy.filter(c => typeWords.some(w => (c.typeLine || '').toLowerCase().includes(w)))
      : (gy.some(c => !isLand(c)) ? gy.filter(c => !isLand(c)) : gy);
    if (pool.length === 0) {
      this.log(`${ctx.card.name} finds no matching card in ${p.name}'s graveyard.`);
      return;
    }
    const best = pool.slice().sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    p.graveyard = p.graveyard.filter(c => c !== best);
    p.hand.push(best);
    this.log(`${ctx.card.name} returns ${best.name} from ${p.name}'s graveyard to their hand.`);
  }

  // Simplification: picks the target player's weakest creature rather than
  // letting them choose.
  applyEdictEffect(ctx) {
    if (ctx.target?.type !== 'player') return;
    const p = this.getPlayer(ctx.target.id);
    if (!p) return;
    const creatures = p.battlefield.filter(perm => isCreature(perm.card));
    if (creatures.length === 0) {
      this.log(`${p.name} has no creature to sacrifice.`);
      return;
    }
    const worst = creatures.sort((a, b) => this.effectivePower(a) - this.effectivePower(b))[0];
    this.movePermanentToGraveyard(worst, { sacrifice: true });
    this.log(`${p.name} sacrifices ${worst.card.name}.`);
  }

  // "Return a creature you control to its owner's hand" (Whitemane Lion,
  // and similar mandatory-bounce drawbacks) — no real choice UI, so this
  // picks the cheapest creature controlled (same "worst first" simplification
  // as the edict above), which for a card like Whitemane Lion is very often
  // itself — enabling the real deck's actual flash-bounce-recast loop.
  // "Return a creature/land/artifact you control to its owner's hand"
  // (Whitemane Lion, and — with typeWord 'land' — the whole bounce-land
  // cycle: Boros Garrison and its friends) — no real choice UI, so this
  // picks the cheapest matching permanent (same "worst first" simplification
  // as the edict above). excludeSelf skips the source permanent itself —
  // needed for a bounce land (bouncing itself back would be a pointless,
  // degenerate loop instead of the intended "trade a land drop for fixing"
  // play), but NOT for Whitemane Lion, where bouncing itself is the actual
  // real, commonly-played flash-recast line.
  applyBounceOwnPermanentEffect(ctx, typeWord, { excludeSelf = false } = {}) {
    const p = this.getPlayer(ctx.controllerId);
    // "permanent" (Kor Skyfisher) isn't a real type-line word — it means
    // any permanent at all, no type filter.
    let candidates = typeWord === 'permanent' ? p.battlefield.slice() : p.battlefield.filter(perm => hasTypeWord(perm.card, typeWord));
    if (excludeSelf && ctx.sourcePerm) candidates = candidates.filter(perm => perm.id !== ctx.sourcePerm.id);
    if (candidates.length === 0) return;
    const cheapest = candidates.sort((a, b) => (a.card.cmc || 0) - (b.card.cmc || 0))[0];
    const owner = this.getPlayer(cheapest.ownerId);
    p.battlefield = p.battlefield.filter(x => x.id !== cheapest.id);
    this.detachFromLeavingBattlefield(cheapest);
    this.triggerLeavesBattlefield(cheapest);
    if (this.exileIfUnearthed(cheapest)) { this.checkStateBasedActions(); return; }
    owner.hand.push(cheapest.card);
    this.log(`${ctx.card.name} returns ${cheapest.card.name} to ${owner.name}'s hand.`);
    this.checkStateBasedActions();
  }

  applyTokenEffect(ctx, amount, power, toughness, typeDesc, keywordText = null) {
    const p = this.getPlayer(ctx.controllerId);
    const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    const words = typeDesc.split(/\s+/).filter(Boolean);
    const colors = words.filter(w => COLOR_WORDS[w]).map(w => COLOR_WORDS[w]);
    // "Artifact creature token" (Myr Battlesphere's own Myr tokens, and many
    // others) needs Artifact as a REAL extra card type on the token's type
    // line, not folded into its subtype/name — otherwise any artifact-
    // matters effect elsewhere in this engine (anthems, Academy
    // Manufactor, ...) would wrongly see these tokens as non-artifacts.
    const isArtifactToken = words.includes('artifact');
    const creatureType = words.filter(w => !COLOR_WORDS[w] && w !== 'colorless' && w !== 'artifact')
      .map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Token';
    const keywords = keywordText ? extractKnownKeywords(keywordText.toLowerCase()) : [];
    for (let i = 0; i < amount; i++) {
      const tokenCard = {
        id: uid('tokencard'), name: creatureType, manaCost: '', cmc: 0,
        typeLine: `Token${isArtifactToken ? ' Artifact' : ''} Creature — ${creatureType}`, oracleText: '',
        power: String(power), toughness: String(toughness),
        colors, colorIdentity: colors, keywords, producedMana: null, image: null,
      };
      p.battlefield.push(makePermanent(tokenCard, ctx.controllerId));
    }
    this.log(`${p.name} creates ${amount} ${power}/${toughness}${isArtifactToken ? ' artifact' : ''} ${creatureType} creature token${amount > 1 ? 's' : ''}${keywords.length ? ` with ${keywords.join(' and ')}` : ''}.`);
  }

  applyTreasureTokenEffect(ctx, amount, { tapped = false } = {}) {
    const p = this.getPlayer(ctx.controllerId);
    for (let i = 0; i < amount; i++) {
      const tokenCard = {
        id: uid('tokencard'), name: 'Treasure', manaCost: '', cmc: 0,
        typeLine: 'Token Artifact — Treasure',
        oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.',
        power: null, toughness: null, colors: [], colorIdentity: [], keywords: [], producedMana: null, image: null,
      };
      const perm = makePermanent(tokenCard, ctx.controllerId);
      perm.tapped = tapped;
      p.battlefield.push(perm);
    }
    this.log(`${p.name} creates ${amount}${tapped ? ' tapped' : ''} Treasure token${amount > 1 ? 's' : ''}.`);
    if (this.controllerHasAcademyManufactor(ctx.controllerId)) {
      this.applyFoodTokenEffect(ctx, amount);
      this.applyClueTokenEffect(ctx, amount);
    }
  }

  // Academy Manufactor's "If you would create a Clue, Food, or Treasure
  // token, instead create one of each" — a bespoke static replacement
  // effect, checked by oracle text rather than a general replacement-effect
  // system (same category as Hardened Scales/Winding Constrictor, still not
  // modeled in general). Only wired into Treasure creation below, since
  // that's the only one of the three token types anything in this engine
  // actually creates right now — Food/Clue creation from other cards would
  // need the same check added symmetrically if that ever changes.
  controllerHasAcademyManufactor(controllerId) {
    const p = this.getPlayer(controllerId);
    return p.battlefield.some(perm => /if you would create a clue, food, or treasure token, instead create one of each/i.test(perm.card.oracleText || ''));
  }

  applyFoodTokenEffect(ctx, amount) {
    const p = this.getPlayer(ctx.controllerId);
    for (let i = 0; i < amount; i++) {
      const tokenCard = {
        id: uid('tokencard'), name: 'Food', manaCost: '', cmc: 0,
        typeLine: 'Token Artifact — Food',
        oracleText: '{2}, {T}, Sacrifice this artifact: You gain 3 life.',
        power: null, toughness: null, colors: [], colorIdentity: [], keywords: [], producedMana: null, image: null,
      };
      p.battlefield.push(makePermanent(tokenCard, ctx.controllerId));
    }
    this.log(`${p.name} creates ${amount} Food token${amount > 1 ? 's' : ''}.`);
  }

  applyClueTokenEffect(ctx, amount) {
    const p = this.getPlayer(ctx.controllerId);
    for (let i = 0; i < amount; i++) {
      const tokenCard = {
        id: uid('tokencard'), name: 'Clue', manaCost: '', cmc: 0,
        typeLine: 'Token Artifact — Clue',
        oracleText: '{2}, Sacrifice this artifact: Draw a card.',
        power: null, toughness: null, colors: [], colorIdentity: [], keywords: [], producedMana: null, image: null,
      };
      p.battlefield.push(makePermanent(tokenCard, ctx.controllerId));
    }
    this.log(`${p.name} creates ${amount} Clue token${amount > 1 ? 's' : ''}.`);
  }

  // A best-effort stand-in for a real "choose a color" player decision (no
  // UI prompt exists for this yet — same simplification already made for
  // edict's "weakest creature" and regrowth's "highest-cost card" auto-picks):
  // picks whichever color the controller's hand most needs to cast something,
  // falling back to whatever color their own lands already produce most.
  // `allowedColors` narrows the choice to a specific set (a dual land's
  // "Add {W} or {U}" only ever gets to pick between those two, not all five)
  // — omit it for a true "any color" source like a Treasure.
  pickAnyColorChoice(ctx, allowedColors = null) {
    const p = this.getPlayer(ctx.controllerId);
    const allowed = allowedColors && allowedColors.length ? allowedColors : ['W', 'U', 'B', 'R', 'G'];
    const need = Object.fromEntries(allowed.map(c => [c, 0]));
    for (const card of p.hand) {
      const parsed = parseManaCost(card.manaCost);
      for (const color of allowed) need[color] += parsed.colors[color] || 0;
      for (const opts of parsed.hybrid) for (const o of opts) if (need[o] !== undefined) need[o] += 1;
    }
    const bestNeed = Object.entries(need).sort((a, b) => b[1] - a[1])[0];
    if (bestNeed[1] > 0) return bestNeed[0];
    const produced = {};
    for (const perm of p.battlefield) for (const c of (perm.card.producedMana || [])) {
      if (c !== 'C' && allowed.includes(c)) produced[c] = (produced[c] || 0) + 1;
    }
    const bestProduced = Object.entries(produced).sort((a, b) => b[1] - a[1])[0];
    return bestProduced ? bestProduced[0] : allowed[0];
  }

  // "As this enters, choose a creature type" (Herald's Horn, Cavern of
  // Souls, Metallic Mimic, Adaptive Automaton, ...) — same "heuristic over
  // a whole new choice UI" philosophy as pickAnyColorChoice above: picks
  // whichever creature type is most common among the controller's own
  // hand and battlefield creatures (extracted from each card's own
  // subtype words after the type line's em dash), so the choice actually
  // synergizes with what they're likely to play. Falls back to a
  // placeholder type when nothing on hand/board qualifies.
  pickCreatureTypeChoice(controllerId) {
    const p = this.getPlayer(controllerId);
    const counts = {};
    const scan = (card) => {
      const typeLine = card.typeLine || '';
      if (!typeLine.toLowerCase().includes('creature')) return;
      const dashIdx = typeLine.indexOf('—');
      if (dashIdx === -1) return;
      for (const word of typeLine.slice(dashIdx + 1).trim().split(/\s+/)) {
        if (word) counts[word] = (counts[word] || 0) + 1;
      }
    };
    for (const card of p.hand) scan(card);
    for (const perm of p.battlefield) scan(perm.card);
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : 'Shapeshifter';
  }

  applyChooseCreatureTypeEffect(ctx) {
    if (!ctx.sourcePerm) return;
    const type = this.pickCreatureTypeChoice(ctx.controllerId);
    ctx.sourcePerm.chosenType = type;
    this.log(`${ctx.card.name} chooses ${type}.`);
  }

  // "You may pay {N}. If you do, untap this artifact." (Mana Vault's own
  // upkeep trigger, paired with its "doesn't untap during your untap
  // step" static — see the untap-step handling above) — same "may"
  // simplification as everywhere else: always pays if currently
  // affordable. A no-op if the permanent is already untapped (no reason
  // to pay for nothing).
  applyPayToUntapEffect(ctx, cost) {
    if (!ctx.sourcePerm || !ctx.sourcePerm.tapped) return;
    const p = this.getPlayer(ctx.controllerId);
    const parsed = parseManaCost(`{${cost}}`);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
    if (!payment) return;
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    ctx.sourcePerm.tapped = false;
    this.log(`${p.name} pays {${cost}} to untap ${ctx.sourcePerm.card.name}.`);
  }

  // "As this land enters, you may pay N life. If you don't, it enters
  // tapped." (the shock-land cycle). Runs from the land's own self-ETB
  // dispatch, immediately after it's already on the battlefield untapped by
  // default (playLand's own simple "enters tapped" check doesn't match this
  // conditional wording, which is exactly why it needs its own handling
  // here) — so declining just flips `.tapped` back on rather than replaying
  // how it entered. Same "always pay if it wouldn't be self-damaging"
  // simplification used for every other optional-cost decision in this
  // engine: pays only if it would leave the controller above the cost
  // (never risks going to 0 life over an untapped land).
  applyPayLifeOrEntersTappedEffect(ctx, cost) {
    if (!ctx.sourcePerm) return;
    const p = this.getPlayer(ctx.controllerId);
    if (p.life > cost) {
      p.life -= cost;
      this.log(`${p.name} pays ${cost} life to have ${ctx.sourcePerm.card.name} enter untapped.`);
    } else {
      ctx.sourcePerm.tapped = true;
      this.log(`${ctx.sourcePerm.card.name} enters tapped.`);
    }
  }

  // "Look at the top card of your library. If it's a creature card of the
  // chosen type, you may reveal it and put it into your hand." (Herald's
  // Horn's own upkeep trigger) — "the chosen type" reads back
  // ctx.sourcePerm.chosenType, set by applyChooseCreatureTypeEffect when
  // Herald's Horn itself entered. Same "may" simplification as everywhere
  // else: always takes it when it qualifies.
  applyChosenTypeTopCardDigEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const chosenType = ctx.sourcePerm?.chosenType;
    if (!chosenType || p.library.length === 0) return;
    const top = p.library[0];
    if (isCreature(top) && (top.typeLine || '').toLowerCase().includes(chosenType.toLowerCase())) {
      p.library.shift();
      p.hand.push(top);
      this.log(`${ctx.card.name} reveals ${top.name} (a ${chosenType}) and puts it into ${p.name}'s hand.`);
    } else {
      this.log(`${ctx.card.name} looks at the top card of ${p.name}'s library — not a ${chosenType}.`);
    }
  }

  applyTapEffect(ctx, tapped) {
    // Multi-target ("tap up to two target creatures" — Tamiyo, Field
    // Researcher; Scroll of Isildur; ...): re-dispatch once per chosen
    // target — see resolveEffectSteps for ctx.targets.
    if (ctx.targets && ctx.targets.length > 1) {
      for (const t of ctx.targets) this.applyTapEffect({ ...ctx, target: t, targets: null }, tapped);
      return;
    }
    if (ctx.target?.type !== 'permanent') return;
    const perm = this.findPermanent(ctx.target.id);
    if (!perm) return;
    perm.tapped = tapped;
    this.log(`${ctx.card.name} ${tapped ? 'taps' : 'untaps'} ${perm.card.name}.`);
  }

  // Myr Battlesphere's own attack trigger: tap every other untapped Myr the
  // controller has (see the effects.js clause comment for why this always
  // taps ALL of them, not some chosen subset), then pump the Battlesphere
  // itself by that count and deal that much damage to whatever it's
  // attacking — reading ctx.sourcePerm's own attackTarget directly (set by
  // declareAttackers) rather than the "always the opponent" simplification
  // used elsewhere, since this is a selfOnly trigger with a real specific
  // attacker to read from.
  applyTapMyrForPumpEffect(ctx) {
    if (!ctx.sourcePerm) return;
    const perm = this.findPermanent(ctx.sourcePerm.id);
    if (!perm) return;
    const p = this.getPlayer(ctx.controllerId);
    const untappedMyr = p.battlefield.filter(other =>
      other.id !== perm.id && !other.tapped && isCreature(other.card) && (other.card.typeLine || '').toLowerCase().includes('myr'));
    const x = untappedMyr.length;
    if (x === 0) return;
    for (const myr of untappedMyr) myr.tapped = true;
    perm.tempBuffs.push({ power: x, toughness: 0 });
    const attackTarget = perm.attackTarget;
    const damageTarget = attackTarget?.type === 'planeswalker' ? { type: 'permanent', id: attackTarget.id } : attackTarget;
    if (damageTarget) this.applyDamageEffect({ ...ctx, target: damageTarget }, x);
    this.log(`${p.name} taps ${x} untapped Myr, giving ${perm.card.name} +${x}/+0 and dealing ${x} damage.`);
  }

  movePermanentToGraveyard(perm, { sacrifice = false } = {}) {
    const p = this.getPlayer(perm.controllerId);
    // Snapshot what was attached to `perm` BEFORE detaching it — an
    // Equipment (Skullclamp's "whenever equipped creature dies, draw two
    // cards.") stays on the battlefield with attachedTo cleared to null by
    // detachFromLeavingBattlefield below, so by the time triggerDies runs
    // there'd be no way left to tell it was ever attached to the creature
    // that just died.
    const previouslyAttachedIds = new Set();
    for (const pl of this.players) for (const other of pl.battlefield) if (other.attachedTo === perm.id) previouslyAttachedIds.add(other.id);
    p.battlefield = p.battlefield.filter(x => x.id !== perm.id);
    this.detachFromLeavingBattlefield(perm);
    this.triggerLeavesBattlefield(perm);
    const wasCreature = isCreature(perm.card);

    // "Whenever you sacrifice a permanent" fires independently of anything
    // below (undying's replacement, a commander's zone redirect, ...) — a
    // sacrifice is a sacrifice the moment it happens, regardless of what
    // happens to the permanent afterward.
    if (sacrifice) this.triggerSacrifice(perm);

    // Disturb: a permanent cast transformed this way is exiled instead.
    if (perm.disturbed) {
      this.getPlayer(perm.ownerId).exile.push(perm.card);
      this.log(`${perm.card.name} is exiled instead (disturb).`);
      return;
    }
    // Unearth's replacement: it never reaches the graveyard, so it doesn't
    // "die" either — checked before undying/persist and the dies trigger.
    if (this.exileIfUnearthed(perm)) return;

    // Undying/persist: the creature still dies (so "dies" triggers still
    // see it), but a replacement effect returns it right away with a
    // counter instead of it landing in the graveyard — and the counter
    // itself is what keeps this from looping forever (a creature that
    // already has one +1/+1 counter doesn't undying again).
    if (wasCreature) {
      const kws = this.effectiveKeywords(perm);
      if (kws.has('undying') && !perm.counters['+1/+1']) return this.reenterWithCounter(perm, '+1/+1', 'undying', previouslyAttachedIds);
      if (kws.has('persist') && !perm.counters['-1/-1']) return this.reenterWithCounter(perm, '-1/-1', 'persist', previouslyAttachedIds);
    }

    // A commander redirected to the command zone still "died" for trigger
    // purposes (the replacement only changes where it ends up) — so
    // triggerDies fires either way, just the graveyard push doesn't happen.
    // Fires for every permanent type, not just creatures — modern rules
    // unified "dies" to mean any permanent going to the graveyard from the
    // battlefield (Disciple of the Vault-style artifact triggers included);
    // interpretDiesTriggers/dyingTypeMatches are what keep a creature-only
    // trigger from also firing when an unrelated land or artifact dies.
    if (this.redirectCommanderToZone(perm)) {
      this.triggerDies(perm, previouslyAttachedIds);
      return;
    }
    // A dying permanent always goes to its OWNER's graveyard, not its
    // controller's — these only ever diverge for a permanent currently
    // under temporary control (a Threaten effect — see
    // applyGainControlEffect), but real rules are unconditional about it.
    this.getPlayer(perm.ownerId).graveyard.push(...this.cardsOf(perm));
    this.leftBattlefieldThisTurn.push({ card: perm.card, ownerId: perm.ownerId });
    this.triggerDies(perm, previouslyAttachedIds);
    if (wasCreature) this.triggerRecover(this.getPlayer(perm.ownerId), perm.card);
  }

  // Fires "whenever you sacrifice a permanent/creature/artifact" triggers
  // (Korvold, Fae-Cursed King's payoff, and similar "aristocrats" cards) on
  // every permanent the SACRIFICING PLAYER controls — self-referential to
  // their own controller, same as triggerDrawCard, regardless of why the
  // sacrifice happened (an activation cost, an edict, a Saga's own
  // end-of-arc self-sacrifice, ...). Includes the sacrificed permanent
  // itself in the watcher list, same as triggerDies does for "when this
  // dies" — it just left the battlefield, but its own trigger still applies.
  triggerSacrifice(sacrificedPerm) {
    const p = this.getPlayer(sacrificedPerm.controllerId);
    const watchers = [...p.battlefield, sacrificedPerm];
    for (const perm of watchers) {
      const steps = interpretSacrificeTriggers(perm.card);
      if (steps.length === 0) continue;
      this.resolveEffectSteps(steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
    }
    this.checkStateBasedActions();
  }

  // "Sacrifice another permanent" (Korvold's own enters-or-attacks trigger)
  // — which permanent isn't a real target this engine's UI can prompt for,
  // same simplification as edict's "weakest creature" auto-pick: prefers a
  // token (the least painful thing to lose) over a real card, then the
  // lowest-cost one.
  applySacrificePermanentEffect(ctx) {
    const p = this.getPlayer(ctx.controllerId);
    const candidates = p.battlefield.filter(x => x.id !== ctx.sourcePerm?.id);
    if (candidates.length === 0) {
      this.log(`${ctx.card.name} has nothing else to sacrifice.`);
      return;
    }
    const tokens = candidates.filter(x => (x.card.id || '').startsWith('tokencard'));
    const pool = tokens.length > 0 ? tokens : candidates;
    const worst = pool.sort((a, b) => (a.card.cmc || 0) - (b.card.cmc || 0))[0];
    this.movePermanentToGraveyard(worst, { sacrifice: true });
    this.log(`${ctx.card.name} sacrifices ${worst.card.name}.`);
  }

  reenterWithCounter(perm, counterType, keywordName, previouslyAttachedIds = new Set()) {
    const owner = this.getPlayer(perm.ownerId);
    const fresh = makePermanent(perm.card, perm.ownerId);
    fresh.counters[counterType] = 1;
    owner.battlefield.push(fresh);
    this.log(`${perm.card.name} returns to the battlefield with a ${counterType} counter (${keywordName}).`);
    this.triggerDies(perm, previouslyAttachedIds);
  }

  // When a permanent leaves the battlefield (dies, gets exiled, bounced —
  // called from every path that removes one), anything attached to it needs
  // resolving: an Aura can't exist unattached so it goes to the graveyard
  // too, while Equipment (or anything else using attachedTo) just becomes
  // unattached and stays on the battlefield — that's the actual rules
  // difference between the two, not just an implementation detail.
  detachFromLeavingBattlefield(perm) {
    // Revolt / Void: which permanents left the battlefield this turn.
    (this.permanentsLeftThisTurn ||= []).push({ controllerId: perm.controllerId, isLand: isLand(perm._baseCard || perm._dfcCard || perm.card) });
    // A face-down permanent is revealed as it leaves the battlefield.
    if (perm.faceDown) { perm.card = perm.faceDown.card; perm.faceDown = null; }
    if (perm.card._printed) perm.card = perm.card._printed;
    // Vehicles, awakened lands, etc. go to other zones as their real card.
    if (perm._baseCard) { perm.card = perm._baseCard; delete perm._baseCard; }
    if (perm._dfcCard) { perm.card = perm._dfcCard; delete perm._dfcCard; }
    for (const pl of this.players) {
      for (const other of pl.battlefield.filter(x => x.attachedTo === perm.id)) {
        // A bestowed Aura becomes a creature again instead of falling off.
        if (other.bestowed) { other.attachedTo = null; this.refreshCardState(other); this.log(`${other.card.name} is no longer attached — it's a creature again.`); continue; }
        if (isAura(other.card)) this.movePermanentToGraveyard(other);
        else other.attachedTo = null;
      }
    }
    // "You control enchanted creature." (Mind Control, Control Magic) —
    // when the AURA ITSELF (not what it's attached to) leaves the
    // battlefield, whatever it was controlling reverts to its OWNER. Loose
    // "still stolen" check (controllerId !== ownerId) rather than tracking
    // exactly who to hand it back to — a reasonable simplification for the
    // rare case of a SECOND control effect layered on top of this one.
    if (perm.grantsControlOf) {
      const controlled = this.findPermanent(perm.grantsControlOf);
      if (controlled && controlled.controllerId !== controlled.ownerId) {
        const currentController = this.getPlayer(controlled.controllerId);
        const owner = this.getPlayer(controlled.ownerId);
        currentController.battlefield = currentController.battlefield.filter(x => x.id !== controlled.id);
        controlled.controllerId = owner.id;
        owner.battlefield.push(controlled);
        this.log(`${controlled.card.name} returns to ${owner.name}'s control now that ${perm.card.name} has left the battlefield.`);
      }
      perm.grantsControlOf = null;
    }
  }

  // Commander-format "move to the command zone" replacement: a commander
  // that would go to the graveyard, exile, or its owner's hand goes back to
  // the command zone instead (recastable later, tax and all). Real Magic
  // makes this the owner's choice; this engine always takes it, matching
  // how most games actually play it out.
  redirectCommanderToZone(perm) {
    const owner = this.getPlayer(perm.ownerId);
    const entry = this.commanderMode ? this.commanderEntryFor(owner, perm.card) : null;
    if (!entry) return false;
    entry.inZone = true;
    this.syncCommanderFields(owner);
    this.log(`${perm.card.name} returns to ${owner.name}'s command zone instead.`);
    return true;
  }

  // ---------- effective stats (base + counters + temp buffs + auras) ----------

  // Characteristic-defining stats: "This creature's power and toughness are
  // each equal to <count>" (Chroma's Primalcrux, Fathomless descent's Souls
  // of the Lost: "... power is equal to <count> and its toughness is equal
  // to that number plus 1").
  cdaStats(perm) {
    const card = perm.card;
    if (!/power (?:and toughness are each|is) equal to/i.test(card.oracleText || '')) return null;
    const text = stripAbilityWords(replaceSelfNameExport(card, card.oracleText || '', 'this creature').toLowerCase());
    let m = text.match(/this creature'?s power and toughness are each equal to ([^.]+)/);
    if (m && parseCount(m[1])) { const n = parseCount(m[1])(this, { controllerId: perm.controllerId, sourcePerm: perm, card }); return { power: n, toughness: n }; }
    m = text.match(/this creature'?s power is equal to ([^.]+?) and its toughness is equal to that number plus (\d+)/);
    if (m && parseCount(m[1])) { const n = parseCount(m[1])(this, { controllerId: perm.controllerId, sourcePerm: perm, card }); return { power: n, toughness: n + parseInt(m[2], 10) }; }
    return null;
  }

  effectivePower(perm) {
    let power = parseInt(this.cdaStats(perm)?.power ?? perm.protoStats?.power ?? perm.card.power, 10) || 0;
    power += this.auraBonus(perm, 'power');
    power += this.anthemBonus(perm, 'power');
    power += this.selfAttachmentBonus(perm, 'power');
    power += counterStatTotal(perm.counters, 'power');
    power += perm.tempBuffs.reduce((s, b) => s + b.power, 0);
    power += this.pairBonus(perm).power;
    return power;
  }

  effectiveToughness(perm) {
    let t = parseInt(this.cdaStats(perm)?.toughness ?? perm.protoStats?.toughness ?? perm.card.toughness, 10) || 0;
    t += this.auraBonus(perm, 'toughness');
    t += this.anthemBonus(perm, 'toughness');
    t += this.selfAttachmentBonus(perm, 'toughness');
    t += counterStatTotal(perm.counters, 'toughness');
    t += perm.tempBuffs.reduce((s, b) => s + b.toughness, 0);
    t += this.pairBonus(perm).toughness;
    return t;
  }

  // Self-referencing dynamic pump scaling with the permanent's OWN
  // attachments (Uril, the Miststalker's "gets +2/+2 for each Aura attached
  // to it") — a third kind of bonus, distinct from anthemBonus (granted by
  // ANOTHER permanent to creatures generally) and auraBonus (a fixed amount
  // from one specific attached Aura's own text): this reads the creature's
  // own oracle text and counts a live number of matching attachments.
  // Handles the card self-referencing by its own short name (before a
  // comma), same normalization interpretSacrificeTriggers uses in effects.js.
  selfAttachmentBonus(perm, stat) {
    const shortName = perm.card.name.split(',')[0].trim();
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePattern = new RegExp(`\\b(?:${escape(perm.card.name)}|${escape(shortName)})\\b`, 'gi');
    const text = (perm.card.oracleText || '').replace(namePattern, 'this creature').toLowerCase();
    const m = text.match(/this creature gets \+(\d+)\/\+(\d+) for each (aura|equipment) attached to it/);
    if (!m) return 0;
    const perEach = stat === 'power' ? parseInt(m[1], 10) : parseInt(m[2], 10);
    let count = 0;
    for (const pl of this.players) {
      for (const other of pl.battlefield) {
        if (other.attachedTo !== perm.id) continue;
        if (m[3] === 'aura' && !isAura(other.card)) continue;
        if (m[3] === 'equipment' && !typeOf(other.card, 'equipment')) continue;
        count++;
      }
    }
    return perEach * count;
  }

  // Static "anthem" effects that grant a flat +P/+T bonus, e.g. Glorious
  // Anthem ("Creatures you control get +1/+1"), Intangible Virtue
  // ("Creature tokens you control get +1/+1..."). Mirrors effectiveKeywords'
  // scan for keyword-granting anthems below, just for numeric bonuses.
  anthemBonus(perm, stat) {
    if (!isCreature(perm.card)) return 0;
    let bonus = 0;
    const controller = this.getPlayer(perm.controllerId);
    const isToken = /\btoken\b/i.test(perm.card.typeLine || '');
    // Every player's battlefield, not just the controller's: a tribal lord
    // with no "you control" (Lord of Atlantis's "Other Merfolk get +1/+1")
    // pumps the opponent's creatures of that type too. parseCreatureAnthemLine
    // / anthemAppliesTo handle "you control", "other", token-only, the
    // chosen type (Adaptive Automaton), and the subtype restriction itself
    // (Elvish Archdruid's "Other Elf creatures you control" — this used to
    // pump every creature you control, Elf or not).
    for (const pl of this.players) {
      for (const other of pl.battlefield) {
        for (const line of (other.card.oracleText || '').toLowerCase().replace(/\([^()]*\)/g, '').split('\n')) {
          const a = parseCreatureAnthemLine(line.trim());
          if (!a || (!a.power && !a.toughness) || !anthemAppliesTo(a, other, perm)) continue;
          bonus += stat === 'power' ? a.power : a.toughness;
        }
      }
    }
    for (const b of this.conditionalBonuses(perm)) bonus += stat === 'power' ? b.power : b.toughness;
    // Emblems (Gideon, Ally of Zendikar's "You get an emblem with
    // 'Creatures you control get +1/+1.'", and similar) — no physical
    // permanent to scan, so this checks the controller's own `emblems`
    // list (raw granted-ability text strings, from applyGetEmblemEffect)
    // with the SAME anthem-line matching logic as the battlefield loop
    // above. An emblem has no permanent identity, so the "other creatures"
    // qualifier can never exclude `perm` itself here — matching the real
    // rule that an emblem's grant applies to every creature you control,
    // including ones that didn't exist yet when you got it.
    for (const emblemText of controller.emblems || []) {
      const lines = emblemText.toLowerCase().split('\n');
      for (const line of lines) {
        const isTokenOnly = /^creature tokens you control /.test(line);
        if (isTokenOnly && !isToken) continue;
        if (!isTokenOnly && !/^(?:other )?(?:[a-z-]+ )?creatures you control /.test(line)) continue;
        const m = line.match(/get ([+-]\d+)\/([+-]\d+)/);
        if (m) bonus += stat === 'power' ? parseInt(m[1], 10) : parseInt(m[2], 10);
      }
    }
    return bonus;
  }

  auraBonus(perm, stat) {
    let bonus = 0;
    for (const pl of this.players) {
      for (const other of pl.battlefield) {
        if (other.attachedTo !== perm.id) continue;
        const text = (other.card.oracleText || '').toLowerCase();
        const m = text.match(/(?:enchanted|equipped) creature (?:gets|has base power and toughness) \+?(-?\d+)\/\+?(-?\d+)/);
        if (m) bonus += stat === 'power' ? parseInt(m[1], 10) : parseInt(m[2], 10);
      }
    }
    return bonus;
  }

  // How many permanents of a given type are attached to `perm` (Kemba, Kha
  // Regent's "create a token for each Equipment attached to Kemba", and
  // similar self-attachment-count effects) — counts across both players'
  // battlefields, same as auraBonus above, since nothing stops an opponent's
  // Aura from being attached to your creature.
  countAttachedMatching(perm, typeWord) {
    if (!perm) return 0;
    let count = 0;
    for (const pl of this.players) {
      for (const other of pl.battlefield) {
        if (other.attachedTo === perm.id && hasTypeWord(other.card, typeWord)) count++;
      }
    }
    return count;
  }

  effectiveKeywords(perm) {
    const set = new Set(perm.card.keywords || []);
    for (const kw of perm.tempKeywords || []) set.add(kw);
    // Soulbond pair keyword grants, and city's-blessing (Ascend) conditions.
    for (const kw of this.pairBonus(perm).keywords) set.add(kw);
    // Keyword counters (a flying counter grants flying, ...).
    for (const [type, n] of Object.entries(perm.counters || {})) {
      if (n > 0 && KNOWN_KEYWORDS.includes(type)) set.add(type);
    }
    // Ability-word conditional statics (Threshold, Metalcraft, Coven, ...).
    for (const b of this.conditionalBonuses(perm)) {
      if (b.grant === 'unblockable') set.add('unblockable');
      else if (b.grant === 'cantattack cantblock') { set.add('cantAttack'); set.add('cantBlock'); }
      else if (b.grant) for (const kw of extractKnownKeywords(b.grant)) set.add(kw);
    }
    this.applyBlessingKeywords(perm, set);
    // Fortified land: "Fortified land has indestructible."
    for (const pl of this.players) for (const f of pl.battlefield) {
      if (f.attachedTo !== perm.id) continue;
      const fm = (f.card.oracleText || '').toLowerCase().match(/fortified land (?:has|gains) ([^.]+)/);
      if (fm) for (const kw of extractKnownKeywords(fm[1])) set.add(kw);
    }

    // Auras/Equipment granting keywords to what they're attached to, e.g.
    // "Enchanted creature has flying, first strike, and vigilance." or
    // "Equipped creature has vigilance."
    for (const pl of this.players) {
      for (const other of pl.battlefield) {
        if (other.attachedTo !== perm.id) continue;
        const text = (other.card.oracleText || '').toLowerCase();
        // Optional "gets +X/+Y and " prefix (Rancor's "Enchanted creature
        // gets +2/+0 and has trample") — the keyword grant is often bundled
        // into the same sentence as a stat bonus, not its own "Enchanted
        // creature has ..." sentence.
        const m = text.match(/(?:enchanted|equipped) creature (?:gets [+-]?\d+\/[+-]?\d+ and )?(?:has|gains) ([^.]+)/);
        if (m) for (const kw of extractKnownKeywords(m[1])) set.add(kw);

        // "Enchanted/equipped creature can't attack or block[, and its
        // activated abilities can't be activated (unless they're mana
        // abilities)]" (Pacifism, Arrest, Faith's Fetters) — represented as
        // synthetic pseudo-keywords in this same set (not real MTG keyword
        // names) so canDeclareAsAttacker/declareBlockers/activation checks
        // can all just check for them the same way as any other keyword.
        const restriction = text.match(/(?:enchanted|equipped) (?:creature|permanent) can't attack or block(?:, and its activated abilities can't be activated(?: unless they'?re mana abilities)?)?/);
        if (restriction) {
          set.add('cantAttack');
          set.add('cantBlock');
          if (restriction[0].includes("can't be activated")) {
            set.add(restriction[0].includes('mana abilities') ? 'cantActivateNonManaAbilities' : 'cantActivateAbilities');
          }
        }
      }
    }

    // Static "anthem"/"lord" effects on the controller's own battlefield,
    // e.g. "Other creatures you control have flying.",
    // "Creatures you control have haste.", (token-restricted, like
    // Intangible Virtue) "Creature tokens you control ... have vigilance.",
    // or — the same template applied to a different permanent type —
    // "Artifacts you control have hexproof." (Padeem, Consul of Innovation).
    if (isCreature(perm.card) || isArtifact(perm.card)) {
      const controller = this.getPlayer(perm.controllerId);
      // Creature anthems/tribal lords: same parser and same every-player
      // scope as anthemBonus (Goblin King's "Other Goblins ... have
      // mountainwalk" reaches the opponent's Goblins too).
      if (isCreature(perm.card)) {
        for (const pl of this.players) {
          for (const other of pl.battlefield) {
            for (const line of (other.card.oracleText || '').toLowerCase().replace(/\([^()]*\)/g, '').split('\n')) {
              const a = parseCreatureAnthemLine(line.trim());
              if (!a || !a.grantText || !anthemAppliesTo(a, other, perm)) continue;
              for (const kw of extractKnownKeywords(a.grantText)) set.add(kw);
            }
          }
        }
      }
      for (const other of controller.battlefield) {
        const lines = (other.card.oracleText || '').toLowerCase().split('\n');
        for (const line of lines) {
          if (isArtifact(perm.card)) {
            const isOtherOnlyArtifact = /^other artifacts you control /.test(line);
            if (isOtherOnlyArtifact && other.id === perm.id) continue;
            if (isOtherOnlyArtifact || /^artifacts you control /.test(line)) {
              for (const kw of extractKnownKeywords(line)) set.add(kw);
            }
          }
        }
      }
      // Emblems (Elspeth, Sun's Champion's "You get an emblem with
      // 'Artifacts, creatures, enchantments, lands, and planeswalkers you
      // control have indestructible.'", and similar) — no permanent
      // identity to exclude via an "other" qualifier, so that check never
      // applies here. Unlike a permanent's own printed anthem text (always
      // a single type — "creatures you control", "artifacts you control"),
      // an emblem's grant is often a COMPOUND list of types in one sentence
      // (Elspeth's own five-type list above), so this splits that list on
      // commas/"and" and checks whether "creatures"/"artifacts" appears in
      // it anywhere, rather than requiring the line to literally START with
      // one specific type word.
      for (const emblemText of controller.emblems || []) {
        const lines = emblemText.toLowerCase().split('\n');
        for (const line of lines) {
          // Optional "get +N/+N and " prefix (Elspeth, Sun's Champion's own
          // emblem: "Creatures you control get +2/+2 and have flying.") —
          // same bundled-pump-and-keyword shape as an Aura's own "gets
          // +2/+0 and has trample" handled elsewhere in this function.
          const m = line.match(/^(?:other )?([\w\s,]+?) you control (?:get [+-]?\d+\/[+-]?\d+ and )?(?:have|has) ([^.]+)/);
          if (!m) continue;
          // Same Oxford-comma normalization as the fetch-land type list in
          // effects.js: splitting on `,\s*` OR `\s+and\s+` as independent
          // alternatives leaves a list's LAST item bundled as "and word"
          // (the comma before "and" only ever satisfies the comma
          // alternative, consuming just the comma+space and leaving "and
          // word" as one unsplit token) — harmless for Elspeth's own five-
          // type list above (neither "creatures" nor "artifacts" happens to
          // be the last item), but a real latent bug for any other emblem
          // where the checked type IS last.
          const subjectWords = m[1].replace(/,?\s+and\s+/g, ', ').split(/,\s*/).map(w => w.trim());
          const grantsToCreature = isCreature(perm.card) && subjectWords.some(w => w === 'creatures' || (w === 'creature tokens' && isToken));
          const grantsToArtifact = isArtifact(perm.card) && subjectWords.includes('artifacts');
          if (!grantsToCreature && !grantsToArtifact) continue;
          for (const kw of extractKnownKeywords(m[2])) set.add(kw);
        }
      }
    }

    // "As long as this creature is monstrous, it has X[, Y]." (Fleecemane
    // Lion) — gated on perm.monstrous, set once by applyMonstrosityEffect.
    if (perm.monstrous) {
      const text = (perm.card.oracleText || '').toLowerCase();
      const m = text.match(/as long as this creature is monstrous, it has ([^.]+)/);
      if (m) for (const kw of extractKnownKeywords(m[1])) set.add(kw);
    }

    // "<Name> has hexproof as long as it's untapped" (Dragonlord Ojutai) —
    // a self-conditional static grant gated on perm.tapped, same "as long
    // as [state], it has [keyword]" template as the monstrous case above,
    // just keyed off tapped/untapped instead. Matches either the card's own
    // (full or pre-comma short) name or a generic "this creature"
    // self-reference, since this engine doesn't normalize self-names in
    // static ability text the way it does for triggered abilities.
    if (!perm.tapped) {
      const text = (perm.card.oracleText || '').toLowerCase();
      const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameAlt = [perm.card.name, perm.card.name.split(',')[0]].map(n => escape(n.toLowerCase()));
      const m = text.match(new RegExp(`(?:this creature|${nameAlt.join('|')}) has ([^.]+) as long as it'?s untapped`));
      if (m) for (const kw of extractKnownKeywords(m[1])) set.add(kw);
    }

    return set;
  }

  // Whether `perm` is a legal target for a spell/ability controlled by
  // `byControllerId` — hexproof blocks only opponents, shroud blocks
  // everyone (including its own controller). Checked by both the human UI
  // (play.js's isLegalPermanentTarget) and the AI's own target-picking
  // (ai.js's pickTargetsForKinds) so a hexproof/shroud permanent is
  // actually unselectable by either, not just reported as having the
  // keyword. Ward isn't checked here — unlike hexproof/shroud, targeting a
  // ward permanent IS legal, it just triggers a reactive tax/counter (see
  // checkWardAndMaybeCounter, wired into castSpell/castCommander) rather
  // than blocking the target from being chosen at all.
  // sourceCard (optional): the spell or ability source doing the targeting,
  // so Protection ("can't be Targeted by anything [quality]") can apply.
  canBeTargetedBy(perm, byControllerId, sourceCard = null) {
    const kws = this.effectiveKeywords(perm);
    if (kws.has('shroud')) return false;
    if (kws.has('hexproof') && perm.controllerId !== byControllerId) return false;
    if (sourceCard && this.isProtectedFrom(perm, sourceCard)) return false;
    return true;
  }

  // ---------- Protection ----------
  // "Protection from [quality]" means DEBT: damage from sources with that
  // quality is prevented, it can't be Enchanted/Equipped by them, Blocked
  // by creatures with it, or Targeted by them. Qualities come from the
  // permanent's own text ("Protection from black", Paladin en-Vec's "...
  // protection from black and from red") and from whatever is attached to
  // it (Sword of Fire and Ice's "equipped creature ... has protection from
  // red and from blue"), plus perm.tempProtections for "gains protection
  // from ... until end of turn" effects. Returns an array of qualities:
  // a color letter, 'everything', 'multicolored', 'monocolored', or a
  // lowercase singular type/subtype word ('creature', 'artifact', 'dragon').
  getProtections(perm) {
    const COLOR = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    const qualities = [...(perm.tempProtections || [])];
    const collect = (text) => {
      const clean = (text || '').replace(/\([^()]*\)/g, '');
      for (const m of clean.matchAll(/protection from ([^.;\n]+)/gi)) {
        for (let q of m[1].toLowerCase().split(/,?\s*and from\s+|,\s*from\s+/)) {
          q = q.trim().replace(/^the color of your choice$/, '');
          if (!q) continue;
          if (COLOR[q]) qualities.push(COLOR[q]);
          else if (q === 'all colors' || q === 'each color') qualities.push('W', 'U', 'B', 'R', 'G');
          else qualities.push(q.replace(/s$/, ''));
        }
      }
    };
    collect(perm.card.oracleText);
    for (const pl of this.players) {
      for (const other of pl.battlefield) {
        if (other.attachedTo !== perm.id) continue;
        const m = (other.card.oracleText || '').match(/(?:enchanted|equipped) creature[^.]*?\bhas\b([^.]*protection from[^.]*)/i);
        if (m) collect(m[1]);
      }
    }
    return qualities;
  }

  isProtectedFrom(perm, sourceCard) {
    if (!sourceCard) return false;
    const qualities = this.getProtections(perm);
    if (qualities.length === 0) return false;
    const colors = sourceCard.colors || [];
    const typeLine = (sourceCard.typeLine || '').toLowerCase();
    return qualities.some(q => {
      if (q === 'everything') return true;
      if (q.length === 1) return colors.includes(q);
      if (q === 'multicolored') return colors.length > 1;
      if (q === 'monocolored') return colors.length === 1;
      if (q === 'colorless') return colors.length === 0;
      return new RegExp(`\\b${q}s?\\b`).test(typeLine);
    });
  }

  // Static blocking restrictions printed on a creature or granted by what's
  // attached to it: "This creature can't be blocked" (Invisible Stalker;
  // Whispersilk Cloak's "Equipped creature can't be blocked"), "can't be
  // blocked except by creatures with flying or reach" (Signal Pest),
  // "except by two or more creatures", "by more than one creature"
  // (Krosan Vorine), "by creatures with power 2 or less", and its own
  // "can't block" (Tormented Soul). Reminder text ignored.
  getBlockRestrictions(perm) {
    const r = { unblockable: false, exceptKeywords: null, minBlockers: 1, maxBlockers: Infinity, minBlockerPower: null, cantBlock: false };
    const texts = [];
    const name = perm.card.name, shortName = name.split(',')[0];
    const self = (perm.card.oracleText || '').split(name).join('this creature').split(shortName).join('this creature');
    texts.push(self);
    for (const pl of this.players) for (const other of pl.battlefield) {
      if (other.attachedTo === perm.id) texts.push((other.card.oracleText || '').replace(/(?:equipped|enchanted) creature/gi, 'this creature'));
    }
    for (const raw of texts) {
      const text = raw.toLowerCase().replace(/\([^()]*\)/g, '');
      if (/this creature can'?t block\b/.test(text)) r.cantBlock = true;
      if (/this creature (?:can'?t block and )?can'?t be blocked(?! except| by)/.test(text) || /\band can'?t be blocked(?! except| by)/.test(text)) r.unblockable = true;
      let m = text.match(/can'?t be blocked except by creatures with ([a-z ]+?)(?: or ([a-z ]+?))?\./);
      if (m) r.exceptKeywords = [m[1].trim(), m[2]?.trim()].filter(Boolean);
      if (/can'?t be blocked except by two or more creatures/.test(text)) r.minBlockers = 2;
      if (/can'?t be blocked by more than one creature/.test(text)) r.maxBlockers = 1;
      m = text.match(/can'?t be blocked by creatures with power (\d+) or less/);
      if (m) r.minBlockerPower = parseInt(m[1], 10) + 1;
    }
    if ((perm.tempKeywords || []).includes('unblockable')) r.unblockable = true;
    return r;
  }

  // Whether `blocker` may legally block `attacker` — every per-pair
  // blocking restriction in one place, used by declareBlockers, the AI, and
  // the UI alike. (Menace is a whole-block rule, not per-pair; see
  // declareBlockers.)
  canBlockAttacker(blocker, attacker) {
    if (!blocker || !attacker || blocker.tapped || !isCreature(blocker.card)) return false;
    const bk = this.effectiveKeywords(blocker);
    const ak = this.effectiveKeywords(attacker);
    if (bk.has('cantBlock') || bk.has('decayed')) return false;
    if (this.getBlockRestrictions(blocker).cantBlock) return false;
    const ar = this.getBlockRestrictions(attacker);
    if (ar.unblockable) return false;
    if (ar.exceptKeywords && !ar.exceptKeywords.some(k => bk.has(k))) return false;
    if (ar.minBlockerPower != null && this.effectivePower(blocker) < ar.minBlockerPower) return false;
    // Skulk: can't be blocked by creatures with greater power.
    if (ak.has('skulk') && this.effectivePower(blocker) > this.effectivePower(attacker)) return false;
    // Unleash: can't block while it has a +1/+1 counter on it.
    if (bk.has('unleash') && (blocker.counters['+1/+1'] || 0) > 0) return false;
    if (ak.has('flying') && !bk.has('flying') && !bk.has('reach')) return false;
    // Shadow: blocks and is blocked only by creatures with shadow.
    if (ak.has('shadow') !== bk.has('shadow')) return false;
    // Horsemanship: only creatures with horsemanship can block it.
    if (ak.has('horsemanship') && !bk.has('horsemanship')) return false;
    const blockerColors = blocker.card.colors || [];
    const blockerIsArtifact = /\bartifact\b/i.test(blocker.card.typeLine || '');
    // Fear: only artifact and/or black creatures can block it.
    if (ak.has('fear') && !blockerIsArtifact && !blockerColors.includes('B')) return false;
    // Intimidate: only artifact creatures and/or ones sharing a color.
    if (ak.has('intimidate') && !blockerIsArtifact && !blockerColors.some(c => (attacker.card.colors || []).includes(c))) return false;
    // Landwalk: unblockable while the defending player controls that land type.
    const defender = this.getPlayer(blocker.controllerId);
    for (const [kw, landType] of [['plainswalk', 'plains'], ['islandwalk', 'island'], ['swampwalk', 'swamp'], ['mountainwalk', 'mountain'], ['forestwalk', 'forest']]) {
      if (ak.has(kw) && defender.battlefield.some(p => (p.card.typeLine || '').toLowerCase().includes(landType))) return false;
    }
    if (this.isProtectedFrom(attacker, blocker.card)) return false;
    return true;
  }

  // Auto-picks a target for an effect that needs one but has no real
  // interactive target-choice UI to hang off of (a tribal-ETB trigger fires
  // automatically as a side effect of something else entering, never as a
  // direct player action) — the opponent's best (highest power) creature
  // that's actually a legal target (respecting hexproof/shroud), or the
  // opponent player themselves if there's no such creature.
  autoPickTarget(kind, controllerId) {
    const opponent = this.opponentOf(controllerId);
    if (kind === 'player' || kind === 'playerOrPlaneswalker') return { type: 'player', id: opponent.id };
    if (kind === 'yourCreature') {
      const own = this.getPlayer(controllerId).battlefield.filter(perm => isCreature(perm.card)).sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
      return own ? { type: 'permanent', id: own.id } : null;
    }
    if (kind === 'artifact' || kind === 'enchantment' || kind === 'land') {
      const match = kind === 'artifact' ? isArtifact : kind === 'enchantment' ? isEnchantment : isLand;
      const best = opponent.battlefield.filter(perm => match(perm.card) && this.canBeTargetedBy(perm, controllerId))
        .sort((a, b) => (b.card.cmc || 0) - (a.card.cmc || 0))[0];
      return best ? { type: 'permanent', id: best.id } : null;
    }
    const enemyCreatures = opponent.battlefield.filter(perm => isCreature(perm.card) && this.canBeTargetedBy(perm, controllerId));
    if (enemyCreatures.length > 0) {
      const best = enemyCreatures.sort((a, b) => this.effectivePower(b) - this.effectivePower(a))[0];
      return { type: 'permanent', id: best.id };
    }
    if (kind === 'creatureOrPlayer' || kind === 'player') return { type: 'player', id: opponent.id };
    return null;
  }

  // ---------- combat ----------

  // A creature can attack if it's not summoning-sick, OR it is but has
  // haste (its own keyword, or anthem-granted — effectiveKeywords covers both).
  canAttackDespiteSickness(perm) {
    return !perm.summoningSick || this.effectiveKeywords(perm).has('haste');
  }

  // Combines the sickness/haste check above with a "can't attack"
  // restriction from an attached Aura/Equipment (Pacifism, Arrest, Faith's
  // Fetters) — the actual "is this creature allowed to attack" check;
  // canAttackDespiteSickness alone only answers the sickness half.
  canDeclareAsAttacker(perm) {
    const kws = this.effectiveKeywords(perm);
    // Orzhov Advokist's deal: no attacking that player until their next turn.
    const owner = this.getPlayer(perm.controllerId);
    if (owner?.advokistLockedUntilTurnOf && this.active.id === owner.id) return false;
    // Defender can't attack (unless something lets it attack "as though it
    // didn't have defender") — it was listed as a keyword but never enforced.
    if (kws.has('defender') && !/as though (?:it|they) didn'?t have defender/i.test(this.allOracleTextAffecting(perm))) return false;
    return this.canAttackDespiteSickness(perm) && !kws.has('cantAttack');
  }

  // The permanent's own text plus every other permanent's (for "as though
  // it didn't have defender"-style permissions granted from elsewhere).
  allOracleTextAffecting(perm) {
    return [perm.card.oracleText || '', ...this.players.flatMap(pl => pl.battlefield.filter(x => x !== perm).map(x => x.card.oracleText || ''))].join('\n');
  }

  beginDeclareAttackers() {
    const canAttack = this.active.battlefield.some(perm =>
      isCreature(perm.card) && !perm.tapped && this.canDeclareAsAttacker(perm));
    if (!canAttack) {
      this.log(`${this.active.name} has no creatures that can attack.`);
      this.stepIndex = STEP_ORDER.indexOf('endCombat');
      this.openPriorityWindow();
      return;
    }
    this.pendingRequest = { type: 'declareAttackers', playerId: this.active.id };
    this.emit();
    if (this.active.isAI) {
      import('./ai.js').then(({ aiDeclareAttackers }) => {
        this.afterAIThinkDelay(() => { if (!this.gameOver) aiDeclareAttackers(this); });
      });
    }
  }

  // attackTargets: optional { [attackerId]: planeswalkerPermId } — any
  // attacker not named in it (the overwhelmingly common case) just attacks
  // the opponent player as usual.
  declareAttackers(playerId, attackerIds, attackTargets = {}) {
    if (playerId !== this.active.id || this.step !== 'declareAttackers') return false;
    const p = this.getPlayer(playerId);
    // Attack tax: pay for each creature attacking the player; attackers that
    // can't be paid for don't attack (planeswalker attacks aren't taxed).
    const tax = this.attackTaxPerCreature(this.opponentOf(playerId).id);
    if (tax > 0) {
      const atPlayer = attackerIds.filter(id => !attackTargets[id]);
      let affordable = 0;
      while (affordable < atPlayer.length && this.payableNow(playerId, `{${tax * (affordable + 1)}}`)) affordable++;
      if (affordable < atPlayer.length) {
        const dropped = new Set(atPlayer.slice(affordable));
        attackerIds = attackerIds.filter(id => !dropped.has(id));
        this.log(`${p.name} can only pay the attack tax for ${affordable} creature${affordable === 1 ? '' : 's'}.`);
      }
      if (affordable) { this.payNow(playerId, `{${tax * affordable}}`); this.log(`${p.name} pays {${tax * affordable}} to attack.`); }
    }
    const opponent = this.opponentOf(playerId);
    const newAttackers = [];
    for (const id of attackerIds) {
      const perm = p.battlefield.find(x => x.id === id);
      if (!perm || !isCreature(perm.card) || perm.tapped || !this.canDeclareAsAttacker(perm)) continue;
      const kws = this.effectiveKeywords(perm);
      perm.attacking = true;
      perm.attackedThisTurn = true;
      p.attackedThisTurnFlag = true;
      if (!kws.has('vigilance')) perm.tapped = true;
      const pwId = attackTargets[id];
      const pw = pwId ? opponent.battlefield.find(x => x.id === pwId && isPlaneswalker(x.card)) : null;
      perm.attackTarget = pw ? { type: 'planeswalker', id: pw.id } : { type: 'player', id: opponent.id };
      newAttackers.push(perm);
    }
    for (const perm of newAttackers) this.triggerAttacks(perm);
    if (newAttackers.length > 0) {
      this.triggerWhenYouAttack(playerId);
      this.triggerEnchantedPlayerAttacked(opponent.id);
    }
    if (newAttackers.length === 1) this.applyExalted(playerId, newAttackers[0]);
    this.applyAttackKeywordTriggers(newAttackers);
    this.pendingRequest = null;
    const anyAttackers = p.battlefield.some(x => x.attacking);
    this.log(anyAttackers
      ? `${p.name} attacks with ${p.battlefield.filter(x => x.attacking).map(x => {
          const tgt = x.attackTarget;
          const tgtDesc = tgt?.type === 'planeswalker' ? ` (attacking ${this.findPermanent(tgt.id)?.card.name || 'a planeswalker'})` : '';
          return `${x.card.name}${tgtDesc}`;
        }).join(', ')}.`
      : `${p.name} doesn't attack.`);
    if (!anyAttackers) {
      // skip straight past blockers/damage to end of combat
      this.stepIndex = STEP_ORDER.indexOf('endCombat');
      this.openPriorityWindow();
      return true;
    }
    this.openPriorityWindow();
    return true;
  }

  beginDeclareBlockers() {
    const attackers = this.active.battlefield.filter(x => x.attacking);
    if (attackers.length === 0) { this.advanceStep(); return; }
    this.pendingRequest = { type: 'declareBlockers', playerId: this.defender.id };
    this.emit();
    if (this.defender.isAI) {
      import('./ai.js').then(({ aiDeclareBlockers }) => {
        this.afterAIThinkDelay(() => { if (!this.gameOver) aiDeclareBlockers(this); });
      });
    }
  }

  // blockMap: array of { blockerId, attackerId }
  declareBlockers(playerId, blockMap) {
    if (playerId !== this.defender.id || this.step !== 'declareBlockers') return false;
    const p = this.getPlayer(playerId);
    // Provoke: a provoked creature blocks the provoker if it's able to,
    // whatever was declared for it.
    for (const blocker of p.battlefield.filter(x => x.provokedBy)) {
      const provoker = this.findPermanent(blocker.provokedBy);
      blocker.provokedBy = null;
      if (provoker?.attacking && this.canBlockAttacker(blocker, provoker)) {
        blockMap = [{ blockerId: blocker.id, attackerId: provoker.id }, ...blockMap.filter(b => b.blockerId !== blocker.id)];
      }
    }
    const usedBlockers = new Set();
    for (const { blockerId, attackerId } of blockMap) {
      const blocker = p.battlefield.find(x => x.id === blockerId);
      const attacker = this.findPermanent(attackerId);
      if (!attacker || !attacker.attacking || usedBlockers.has(blockerId)) continue;
      if (!this.canBlockAttacker(blocker, attacker)) continue;
      usedBlockers.add(blockerId);
      blocker.blocking = attacker.id;
      attacker.blockedBy.push(blocker.id);
    }
    // Menace: "can't be blocked except by two or more creatures" — a rule
    // about the whole block, so it's checked once every block is assigned.
    // A lone blocker on a menace attacker is removed (that blocker simply
    // doesn't block, which is what an illegal block declaration amounts to).
    for (const attacker of this.active.battlefield.filter(x => x.attacking)) {
      const ar = this.getBlockRestrictions(attacker);
      const minBlockers = Math.max(ar.minBlockers, this.effectiveKeywords(attacker).has('menace') ? 2 : 1);
      if (attacker.blockedBy.length > 0 && attacker.blockedBy.length < minBlockers) {
        for (const id of attacker.blockedBy) { const b = this.findPermanent(id); if (b) b.blocking = null; }
        attacker.blockedBy = [];
        this.log(`${attacker.card.name} can't be blocked except by ${minBlockers} or more creatures.`);
      }
      // "Can't be blocked by more than one creature": extra blockers drop out.
      if (attacker.blockedBy.length > ar.maxBlockers) {
        for (const id of attacker.blockedBy.slice(ar.maxBlockers)) { const b = this.findPermanent(id); if (b) b.blocking = null; }
        attacker.blockedBy = attacker.blockedBy.slice(0, ar.maxBlockers);
        this.log(`${attacker.card.name} can't be blocked by more than ${ar.maxBlockers} creature.`);
      }
    }
    this.applyBlockKeywordTriggers();
    this.pendingRequest = null;
    const blockedCount = p.battlefield.filter(x => x.blocking).length;
    this.log(blockedCount > 0 ? `${p.name} assigns blockers.` : `${p.name} doesn't block.`);
    this.openPriorityWindow();
    return true;
  }

  // ---------- Ninjutsu ----------
  // A genuinely different action shape from every other ability in this
  // engine: not a spell on the stack, not an activated ability on a
  // battlefield permanent — a special action usable only during the
  // declare-blockers step, once blocks are locked in (this engine's own
  // openPriorityWindow call right above `declareBlockers` re-opens
  // priority in exactly that window), swapping an unblocked attacker for a
  // Ninja from hand.

  getNinjutsuCost(card) { return getNinjutsuCost(card); }

  canActivateNinjutsu(playerId, ninjaInstanceId, attackerId) {
    if (this.gameOver || this.pendingRequest) return false;
    if (this.step !== 'declareBlockers' || this.stack.length > 0) return false;
    if (this.priorityPlayer.id !== playerId || playerId !== this.active.id) return false;
    const p = this.getPlayer(playerId);
    const ninjaCard = p.hand.find(c => c.instanceId === ninjaInstanceId);
    if (!ninjaCard) return false;
    const cost = getNinjutsuCost(ninjaCard);
    if (!cost) return false;
    const attacker = this.findPermanent(attackerId);
    if (!attacker || attacker.controllerId !== playerId || !attacker.attacking || attacker.blockedBy.length > 0) return false;
    const parsed = parseManaCost(cost);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
  }

  activateNinjutsu(playerId, ninjaInstanceId, attackerId) {
    if (!this.canActivateNinjutsu(playerId, ninjaInstanceId, attackerId)) return { ok: false, reason: 'Cannot activate Ninjutsu right now.' };
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === ninjaInstanceId);
    const ninjaCard = p.hand[idx];
    const cost = getNinjutsuCost(ninjaCard);
    const parsed = parseManaCost(cost);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];

    const attacker = this.findPermanent(attackerId);
    const attackTarget = attacker.attackTarget;
    // "Return an unblocked attacker you control to hand" — to its OWNER's
    // hand, not necessarily the activating player's, in the rare case the
    // attacker was under temporary/stolen control (Threaten-style) when it
    // attacked. Same detach cleanup as any other permanent leaving the
    // battlefield (an attached Aura/Equipment falls off or unattaches).
    this.detachFromLeavingBattlefield(attacker);
    p.battlefield = p.battlefield.filter(x => x.id !== attacker.id);
    if (!this.exileIfUnearthed(attacker)) this.getPlayer(attacker.ownerId).hand.push(attacker.card);
    this.log(`${p.name} returns ${attacker.card.name} to hand to ninjutsu in ${ninjaCard.name}.`);

    p.hand.splice(idx, 1);
    const perm = makePermanent(ninjaCard, playerId);
    perm.tapped = true;
    perm.attacking = true;
    perm.attackTarget = attackTarget;
    // Entering already tapped and attacking mid-combat is the whole point
    // of Ninjutsu — real rules don't apply summoning sickness to this at
    // all, since it's replacing an attacker already committed to combat.
    perm.summoningSick = false;
    p.battlefield.push(perm);
    this.log(`${p.name} puts ${ninjaCard.name} onto the battlefield tapped and attacking via ninjutsu.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
    this.afterAction(playerId);
    return { ok: true };
  }

  resolveCombatDamage() {
    const attackers = this.allCreatures().filter(x => x.attacking);
    if (attackers.length === 0) return;

    const hasFirstStrikers = attackers.some(a => this.effectiveKeywords(a).has('first strike') || this.effectiveKeywords(a).has('double strike')) ||
      attackers.some(a => a.blockedBy.some(id => {
        const b = this.findPermanent(id);
        return b && (this.effectiveKeywords(b).has('first strike') || this.effectiveKeywords(b).has('double strike'));
      }));

    if (hasFirstStrikers) {
      this.dealCombatDamageWave(attackers, wave => {
        const kws = this.effectiveKeywords(wave);
        return kws.has('first strike') || kws.has('double strike');
      });
      this.checkStateBasedActions();
      this.dealCombatDamageWave(attackers, wave => {
        const kws = this.effectiveKeywords(wave);
        return !kws.has('first strike') || kws.has('double strike');
      });
    } else {
      this.dealCombatDamageWave(attackers, () => true);
    }
  }

  // Where UNBLOCKED (or trampled-over) combat damage actually lands: the
  // planeswalker the attacker declared as its target, if it's still around,
  // otherwise the defending player. A planeswalker whose target already
  // left the battlefield some other way mid-combat just has its damage
  // fizzle (real rules: damage that would go to a permanent that's no
  // longer there isn't redirected anywhere). Lifelink is handled by the
  // caller regardless of which branch this takes, since it triggers off
  // damage dealt to ANY object, not just a player — and "whenever ~ deals
  // combat damage to a PLAYER" triggers correctly do NOT fire when the
  // damage actually went to a planeswalker instead.
  dealCombatDamageToDefender(attackerPerm, amount, isCommanderSource) {
    const target = attackerPerm.attackTarget;
    if (target?.type === 'planeswalker') {
      const pw = this.findPermanent(target.id);
      if (!pw) return;
      pw.counters.loyalty = (pw.counters.loyalty || 0) - amount;
      this.log(`${attackerPerm.card.name} deals ${amount} damage to ${pw.card.name}, removing ${amount} loyalty counter${amount === 1 ? '' : 's'}.`);
      return;
    }
    const defenderPlayer = this.getPlayer(this.opponentOf(attackerPerm.controllerId).id);
    const kws = this.effectiveKeywords(attackerPerm);
    this.damagePlayer(defenderPlayer, amount, kws, attackerPerm.card.name);
    // For Prowl/Freerunning: which creature types (and whether a commander)
    // dealt combat damage to a player this turn.
    if (amount > 0) {
      const attackerOwner = this.getPlayer(attackerPerm.controllerId);
      const subtypes = ((attackerPerm.card.typeLine || '').toLowerCase().split('—')[1] || '').split(/\s+/).filter(Boolean);
      for (const st of [...subtypes, ...(isCommanderSource ? ['commander'] : [])]) {
        if (!attackerOwner.combatDamagerTypesThisTurn.includes(st)) attackerOwner.combatDamagerTypesThisTurn.push(st);
      }
    }
    if (isCommanderSource) {
      // 21 combat damage from any ONE commander loses the game (partners
      // are counted separately).
      const key = (attackerPerm._dfcCard || attackerPerm._baseCard || attackerPerm.card).name;
      defenderPlayer.commanderDamageFrom[key] = (defenderPlayer.commanderDamageFrom[key] || 0) + amount;
      defenderPlayer.commanderDamageTaken = Math.max(...Object.values(defenderPlayer.commanderDamageFrom));
    }
    // Combat damage to the monarch makes the attacker's controller the monarch.
    if (amount > 0 && this.monarch === defenderPlayer.id) this.becomeMonarch(attackerPerm.controllerId);
    // Poisonous N: combat damage to a player gives N poison counters
    // (printed, or granted: Snake Cult Initiation's "Enchanted creature has
    // poisonous 3").
    if (amount > 0) {
      let poisonous = this.keywordAmount(attackerPerm.card, 'poisonous');
      for (const pl of this.players) for (const a of pl.battlefield) {
        const pm = a.attachedTo === attackerPerm.id && (a.card.oracleText || '').match(/(?:enchanted|equipped) creature has poisonous (\d+)/i);
        if (pm) poisonous += parseInt(pm[1], 10);
      }
      if (poisonous > 0) {
        defenderPlayer.counters.poison = (defenderPlayer.counters.poison || 0) + poisonous;
        this.log(`Poisonous: ${defenderPlayer.name} gets ${poisonous} poison counter${poisonous > 1 ? 's' : ''} (${defenderPlayer.counters.poison}).`);
      }
    }
    // Toxic N: combat damage to a player also gives N poison counters.
    const toxic = this.keywordAmount(attackerPerm.card, 'toxic');
    if (toxic > 0) {
      defenderPlayer.counters.poison = (defenderPlayer.counters.poison || 0) + toxic;
      this.log(`Toxic: ${defenderPlayer.name} gets ${toxic} poison counter${toxic > 1 ? 's' : ''} (${defenderPlayer.counters.poison} total).`);
    }
    this.triggerCombatDamageToPlayer(attackerPerm, amount);
  }

  dealCombatDamageWave(attackers, includeFn) {
    for (const attacker of attackers) {
      if (!includeFn(attacker)) continue;
      const attackerPerm = this.findPermanent(attacker.id);
      if (!attackerPerm) continue;
      const kws = this.effectiveKeywords(attackerPerm);
      const power = this.effectivePower(attackerPerm);
      const blockers = attackerPerm.blockedBy.map(id => this.findPermanent(id)).filter(Boolean);
      // Commander format's second loss condition: 21+ combat damage from a
      // single commander, tracked separately from life total (see
      // checkStateBasedActions).
      const isCommanderSource = this.commanderMode && !!this.commanderEntryFor(this.getPlayer(attackerPerm.ownerId), attackerPerm._dfcCard || attackerPerm._baseCard || attackerPerm.card);

      if (blockers.length === 0) {
        if (kws.has('lifelink')) this.getPlayer(attackerPerm.controllerId).life += power;
        if (power > 0) this.dealCombatDamageToDefender(attackerPerm, power, isCommanderSource);
        continue;
      }

      let remaining = power;
      for (let i = 0; i < blockers.length; i++) {
        if (remaining <= 0) break;
        const blocker = blockers[i];
        const isLast = i === blockers.length - 1;
        const need = kws.has('deathtouch') ? 1 : Math.max(this.effectiveToughness(blocker) - blocker.damage, 0);
        const assign = (kws.has('trample') || !isLast) ? Math.min(remaining, need) : remaining;
        remaining -= assign;
        // Protection: the damage is still ASSIGNED (it counts toward lethal
        // for trample), just prevented — no damage, no lifelink.
        if (this.isProtectedFrom(blocker, attackerPerm.card)) {
          this.log(`${blocker.card.name} has protection — ${attackerPerm.card.name}'s ${assign} damage is prevented.`);
          continue;
        }
        this.damageCreature(blocker, assign, kws);
        this.log(`${attackerPerm.card.name} deals ${assign} damage to ${blocker.card.name}.`);
        if (kws.has('lifelink')) this.getPlayer(attackerPerm.controllerId).life += assign;
      }
      if (kws.has('trample') && remaining > 0) {
        if (kws.has('lifelink')) this.getPlayer(attackerPerm.controllerId).life += remaining;
        this.dealCombatDamageToDefender(attackerPerm, remaining, isCommanderSource);
      }

      // blockers deal damage back to attacker
      let incoming = 0;
      let blockerHasDeathtouch = false;
      for (const blocker of blockers) {
        if (this.isProtectedFrom(attackerPerm, blocker.card)) {
          this.log(`${attackerPerm.card.name} has protection — ${blocker.card.name}'s damage is prevented.`);
          continue;
        }
        const blockerKws = this.effectiveKeywords(blocker);
        if (blockerKws.has('infect') || blockerKws.has('wither')) {
          // -1/-1 counters, not marked damage — applied directly.
          this.damageCreature(attackerPerm, this.effectivePower(blocker), blockerKws);
          if (blockerKws.has('deathtouch') && this.effectivePower(blocker) > 0) blockerHasDeathtouch = true;
          if (blockerKws.has('lifelink')) this.getPlayer(blocker.controllerId).life += this.effectivePower(blocker);
          continue;
        }
        incoming += this.effectivePower(blocker);
        if (blockerKws.has('deathtouch')) blockerHasDeathtouch = true;
        if (this.effectiveKeywords(blocker).has('lifelink')) {
          this.getPlayer(blocker.controllerId).life += this.effectivePower(blocker);
        }
      }
      this.damageCreature(attackerPerm, incoming, new Set());
      if (incoming > 0) this.log(`${blockers.map(b => b.card.name).join(' and ')} deal${blockers.length === 1 ? 's' : ''} ${incoming} damage to ${attackerPerm.card.name}.`);
      if (blockerHasDeathtouch) attackerPerm.damage = Math.max(attackerPerm.damage, this.effectiveToughness(attackerPerm));
    }
  }

  checkStateBasedActions() {
    this.checkLinkedControl();
    if (this.gameOver) return;
    this.refreshAllCardStates();
    // Infusion (life gained this turn) and Descend (a permanent card put
    // into your graveyard this turn), noticed here as they change.
    for (const p of this.players) {
      if (p._lastLife != null && p.life > p._lastLife) p.lifeGainedThisTurn = (p.lifeGainedThisTurn || 0) + (p.life - p._lastLife);
      p._lastLife = p.life;
      const gyPerms = p.graveyard.filter(c => /artifact|battle|creature|enchantment|land|planeswalker/i.test(c.typeLine || '')).length;
      if (p._gyPermCount != null && gyPerms > p._gyPermCount) p.descendedThisTurn = true;
      p._gyPermCount = gyPerms;
    }
    // Start your engines!: speed starts at 1; it rises once per turn (max 4)
    // when an opponent loses life during your turn. Storied: three or more
    // artifacts/legendaries/Sagas gives an enduring story for good.
    for (const p of this.players) {
      if (p.speed == null && p.battlefield.some(x => hasStartYourEngines(x.card))) { p.speed = 1; this.log(`${p.name}'s speed is 1.`); }
      if (!p.enduringStory && p.battlefield.some(x => hasStoried(x.card)) && p.battlefield.filter(x => isArtifact(x.card) || /legendary|saga/i.test(x.card.typeLine || '')).length >= 3) {
        p.enduringStory = true;
        this.log(`${p.name} has an enduring story.`);
      }
    }
    const act = this.active;
    if (act?.speed && act.speed < 4 && !act.speedRaisedThisTurn && this.players.some(o => o.id !== act.id && o.life < (o.lifeAtTurnStart ?? o.life))) {
      act.speed += 1; act.speedRaisedThisTurn = true;
      this.log(`${act.name}'s speed increases to ${act.speed}${act.speed === 4 ? ' (max speed)' : ''}.`);
    }
    // Ascend: ten or more permanents with an ascend permanent in play gives
    // the city's blessing for the rest of the game.
    for (const p of this.players) {
      if (!p.citysBlessing && p.battlefield.length >= 10 && p.battlefield.some(x => hasAscend(x.card))) {
        p.citysBlessing = true;
        this.log(`${p.name} gets the city's blessing.`);
      }
    }
    // Rule 704.5d: a token that's left the battlefield (died, bounced,
    // exiled) ceases to exist. Its "dies" triggers have already fired by
    // the time this runs; without this, dead tokens piled up in graveyards
    // where they could be reanimated, delved, or counted.
    for (const p of this.players) {
      for (const zone of ['graveyard', 'hand', 'exile', 'library']) {
        if (p[zone].some(isTokenCard)) p[zone] = p[zone].filter(c => !isTokenCard(c));
      }
    }
    for (const p of this.players) {
      if (p.life <= 0 && !p.lost) { this.loseGame(p.id, 'life total reached 0'); return; }
      // Rule 704.5c — poison counters were tracked but never lost a game.
      if ((p.counters.poison || 0) >= 10 && !p.lost) { this.loseGame(p.id, 'ten or more poison counters'); return; }
    }
    if (this.commanderMode) {
      for (const p of this.players) {
        if (p.commanderDamageTaken >= 21 && !p.lost) { this.loseGame(p.id, '21+ commander damage taken'); return; }
      }
    }
    for (const p of this.players) {
      const dead = p.battlefield.filter(perm => isCreature(perm.card) &&
        (perm.damage >= this.effectiveToughness(perm) || this.effectiveToughness(perm) <= 0));
      for (const perm of dead) {
        if (this.effectiveToughness(perm) > 0 && (this.effectiveKeywords(perm).has('indestructible') || this.tryUmbraArmor(perm))) continue;
        this.log(`${perm.card.name} dies.`);
        this.movePermanentToGraveyard(perm);
      }
      // A planeswalker at 0 (or less) loyalty goes to the graveyard —
      // unlike a creature, there's no "indestructible" escape hatch for
      // this (loyalty loss isn't damage, so indestructible never applies).
      const depleted = p.battlefield.filter(perm => isPlaneswalker(perm.card) && (perm.counters.loyalty || 0) <= 0);
      for (const perm of depleted) {
        this.log(`${perm.card.name} is put into its owner's graveyard (0 loyalty).`);
        this.movePermanentToGraveyard(perm);
      }
    }
  }

  doCleanup() {
    for (const p of this.players) {
      while (p.hand.length > 7) {
        const discard = p.hand[p.hand.length - 1];
        this.log(`${p.name} discards ${discard.name} at the maximum hand size.`);
        this.discardCard(p, discard);
      }
      for (const perm of p.battlefield) {
        perm.damage = 0;
        perm.tempBuffs = [];
        perm.tempKeywords = [];
        // Crewed / saddled last until end of turn.
        if (perm.crewed || perm.saddled) { perm.crewed = false; perm.saddled = false; this.refreshCardState(perm); }
      }
      p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    }
    // Exile-and-play permission (see applyExileAndPlayEffect) lasts "until
    // the end of your next turn" — since it's always granted during the
    // active player's OWN turn (a combat-damage trigger), that means it
    // survives cleanup of the granting turn once (remainingOwnTurns 2 -> 1)
    // and expires at cleanup of that SAME player's very next turn
    // (1 -> 0). Only this.active's own entries tick down here, since
    // cleanup only fires once per turn for whoever's turn it is.
    for (const entry of this.active.exiledPlayable) entry.remainingOwnTurns -= 1;
    const expired = this.active.exiledPlayable.filter(e => e.remainingOwnTurns <= 0);
    for (const entry of expired) this.log(`${this.active.name} can no longer play ${entry.card.name} — its exile permission has expired.`);
    this.active.exiledPlayable = this.active.exiledPlayable.filter(e => e.remainingOwnTurns > 0);
    this.revertControlChanges();
    this.endTurn();
  }

  // ---------- convenience for the UI ----------

  isCreature(card) { return isCreature(card); }
  isLand(card) { return isLand(card); }
  isArtifact(card) { return isArtifact(card); }
  isEnchantment(card) { return isEnchantment(card); }
  isAura(card) { return isAura(card); }
  isPlaneswalker(card) { return isPlaneswalker(card); }
  isInstantOrSorcery(card) { return isInstant(card) || isSorcery(card); }
  hasLifePaymentXCost(card) { return hasLifePaymentXCost(card); }

  getKickerCost(card) { return getKickerCost(card); }
  getBuybackCost(card) { return getBuybackCost(card); }

  // The one optional additional cost a spell offers, if any — Kicker or
  // Buyback. Both go through the same `kicked` flag on castSpell (and the
  // same "pay extra?" decision for the AI and the human prompt); the stack
  // item records which one it was, since their payoffs differ.
  getOptionalAdditionalCost(card) { return getKickerCost(card) || getBuybackCost(card) || getEntwineCost(card); }
  getEntwineCost(card) { return getEntwineCost(card); }
  getReplicateCost(card) { return getReplicateCost(card); }
  getSquadCost(card) { return getSquadCost(card); }
  getOffspringCost(card) { return getOffspringCost(card); }
  getCasualtyAmount(card) { return getCasualtyAmount(card); }
  hasConspire(card) { return hasConspire(card); }
  hasBargain(card) { return hasBargain(card); }
  getGiftKind(card) { return getGiftKind(card); }
  getModeExtraCost(card, modeIndexes) { return getModeExtraCost(card, modeIndexes); }

  // The most life a "pay X life as an additional cost" spell (Toxic
  // Deluge) can reasonably ask for — leaves at least 1, since paying
  // yourself to 0 as a COST (not damage) still just kills you via
  // state-based actions with nothing gained.
  getMaxLifePaymentX(playerId) {
    return Math.max(0, this.getPlayer(playerId).life - 1);
  }
}
