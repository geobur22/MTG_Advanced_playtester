import { shuffle } from './deck.js';
import { interpretSpell, interpretPermanentTriggers, interpretTapAbilities, interpretCastTriggers, interpretEquipCost, getSpellModes as getSpellModesFromText, interpretDiesTriggers, interpretAttackTriggers, interpretCombatDamageTriggers, interpretUpkeepTriggers, interpretEndStepTriggers, interpretBeginCombatTriggers, interpretNonTapAbilities, interpretLoyaltyAbilities, interpretSagaChapters, interpretDrawTriggers, interpretCounterAddedTriggers, interpretBecomesTargetTriggers, getWardCost, interpretGraveyardAbilities, interpretSacrificeTriggers, interpretLeavesTriggers, interpretLandfallTriggers, interpretTribalEtbTriggers, interpretAnyEtbTriggers, interpretDrawStepTriggers, hasLifePaymentXCost, getKickerCost, getFlashbackCost, getEscapeCost, parseClassLevels, interpretWhenYouAttackTriggers, interpretEnchantedPlayerUpkeepTriggers, interpretEnchantedPlayerAttackedTriggers, getEntersWithCounterCount, getNinjutsuCost, interpretMonstrousTriggers } from './effects.js';
import { parseManaCost, planManaPayment, totalCmc } from './mana.js';

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
];

// Finds any recognized keyword abilities named in a chunk of (already
// lowercased) text, e.g. "flying, first strike, and vigilance" or
// "haste and reach". Matching against a whitelist rather than splitting on
// commas/"and" means it isn't thrown off by punctuation variations.
function extractKnownKeywords(text) {
  return KNOWN_KEYWORDS.filter(kw => text.includes(kw));
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
    summoningSick: isCreature(card),
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
    commanderZone: false,
    commanderCastCount: 0,
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
    commanderMode = false, commanderA = null, commanderB = null,
  }) {
    const startingLife = commanderMode ? 40 : 20;
    this.players = [
      makePlayer('p0', nameA, deckA, aiControlsA, startingLife),
      makePlayer('p1', nameB, deckB, aiControlsB, startingLife),
    ];
    this.commanderMode = commanderMode;
    if (commanderMode) {
      this.players[0].commander = commanderA;
      this.players[0].commanderZone = !!commanderA;
      this.players[1].commander = commanderB;
      this.players[1].commanderZone = !!commanderB;
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
  emit() { for (const fn of this.listeners) fn(this); }

  // ---------- undo ----------
  // Only these fields are real game STATE — deliberately excludes
  // `listeners` (app wiring, not state, and holds live callback functions
  // structuredClone can't touch) and `_pendingETB` (an in-flight ETB
  // target-choice closure that also holds functions — mid-ETB-prompt undo
  // just isn't supported, a rare enough moment to click Undo in).
  static SNAPSHOT_FIELDS = [
    'players', 'stack', 'activePlayerIndex', 'priorityPlayerIndex', 'consecutivePasses',
    'stepIndex', 'turnNumber', 'logLines', 'gameOver', 'winner', 'pendingRequest',
    '_firstTurn', 'mulligans', '_actionsSinceLastPass', 'pendingExtraCombats', 'leftBattlefieldThisTurn',
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

  log(line) {
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

  drawCard(player, silent = false) {
    if (player.library.length === 0) {
      this.loseGame(player.id, 'tried to draw from an empty library');
      return;
    }
    const card = player.library.shift();
    player.hand.push(card);
    if (!silent) {
      this.log(`${player.name} draws a card.`);
      this.triggerDrawCard(player);
    }
  }

  // Fires "whenever you draw a card" triggers (Fathom Mage, ...) — always
  // self-referential to the drawing player's own permanents.
  triggerDrawCard(player) {
    for (const perm of player.battlefield) {
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
    for (const watcher of controller.battlefield) {
      const entries = interpretTribalEtbTriggers(watcher.card);
      for (const entry of entries) {
        if (!enteredTypeLine.includes(entry.typeWord)) continue;
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
      for (const watcher of pl.battlefield) {
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
      for (const watcher of pl.battlefield) {
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
    const p = this.getPlayer(ctx.controllerId);
    const tokenCard = { ...ctx.card, id: uid('tokencard'), instanceId: uid('tokeninst') };
    const perm = makePermanent(tokenCard, ctx.controllerId);
    p.battlefield.push(perm);
    this.log(`${ctx.card.name} creates a token copy of itself.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
  }

  // "Search your library for an artifact card with mana value X or less,
  // put it onto the battlefield, then shuffle." (Reshape) — a type-
  // restricted tutor straight to the BATTLEFIELD (not hand), capped by the
  // spell's own {X} value rather than a literal number.
  applyTutorToBattlefieldEffect(ctx, typeWord, maxCmc) {
    const p = this.getPlayer(ctx.controllerId);
    const candidates = p.library.filter(c => (c.typeLine || '').toLowerCase().includes(typeWord) && (c.cmc || 0) <= maxCmc);
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
  triggerBecomesTarget(targets) {
    for (const t of targets || []) {
      if (t?.type !== 'permanent') continue;
      const perm = this.findPermanent(t.id);
      if (!perm) continue;
      const steps = interpretBecomesTargetTriggers(perm.card);
      if (steps.length === 0) continue;
      this.resolveEffectSteps(steps, [], { controllerId: perm.controllerId, card: perm.card, sourcePerm: perm });
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
    this.log(`${loser.name} loses the game (${reason}). ${this.getPlayer(this.winner).name} wins!`);
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
    for (const p of this.players) p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
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
      for (const perm of this.active.battlefield) {
        // Two ways a permanent can skip its own untap: a STATIC self-
        // declaration re-checked fresh every turn (Mana Vault's own "this
        // artifact doesn't untap during your untap step" — the only way
        // to untap it is the separate {4}-during-upkeep effect, see
        // applyPayToUntapEffect), or a one-shot flag an external effect
        // applied (Frost Breath's "doesn't untap during its controller's
        // next untap step") — consumed here regardless of which caused it.
        const staticSkip = /this (?:artifact|creature|permanent) doesn'?t untap during your untap step/.test((perm.card.oracleText || '').toLowerCase());
        if (staticSkip || perm.skipNextUntap) {
          perm.skipNextUntap = false;
        } else {
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
      // "This turn" is a shared, global concept (only one turn happens at a
      // time) — a new turn beginning resets it for BOTH players, not just
      // whoever's turn it now is.
      for (const pl of this.players) pl.damageTakenThisTurn = 0;
      this.leftBattlefieldThisTurn = [];
      this.advanceStep();
      return;
    }
    if (step === 'upkeep') {
      this.triggerPhase(interpretUpkeepTriggers);
      this.triggerEnchantedPlayerUpkeep();
      this.openPriorityWindow();
      return;
    }
    if (step === 'draw') {
      const skip = this._firstTurn && this.activePlayerIndex === 0;
      if (!skip) this.drawCard(this.active);
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
      this.triggerPhase(interpretEndStepTriggers);
      this.openPriorityWindow();
      return;
    }
    if (step === 'cleanup') {
      this.doCleanup();
      return;
    }
    if (step === 'main1') {
      this.advanceSagas();
      this.openPriorityWindow();
      return;
    }
    if (step === 'beginCombat') {
      this.triggerPhase(interpretBeginCombatTriggers);
      this.openPriorityWindow();
      return;
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
    for (const perm of this.active.battlefield) {
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
    if (isLand(card)) return false;
    const instantSpeed = isInstant(card) || /flash/.test((card.keywords || []).join(','));
    if (instantSpeed) return true;
    return p.id === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0;
  }

  // modeIndexes matters only for modal spells (getSpellModes) — different
  // modes can need different targets, so this needs to know which mode(s)
  // were picked to report the right target kinds.
  getRequiredTargetKinds(card, modeIndexes = null) {
    if (isAura(card)) return [isEnchantPlayerAura(card) ? 'player' : 'permanent'];
    if (!isInstant(card) && !isSorcery(card)) return [];
    return expandTargetKinds(interpretSpell(card, modeIndexes));
  }

  // Companion to getRequiredTargetKinds — see minRequiredTargetCount's own
  // comment for why ai.js's "is this worth attempting" gates need this
  // instead of getRequiredTargetKinds(...).length.
  getMinRequiredTargetCount(card, modeIndexes = null) {
    if (isAura(card)) return 1;
    if (!isInstant(card) && !isSorcery(card)) return 0;
    return minRequiredTargetCount(interpretSpell(card, modeIndexes));
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
    const text = (card.oracleText || '').toLowerCase();
    let selfReduction = 0;
    let m = text.match(/this spell costs \{(\d+)\} less to cast for each ([\w\s]+?)(?: on the battlefield| you control)/);
    if (m) {
      const perEach = parseInt(m[1], 10);
      const typeWord = m[2].trim().replace(/s$/, '');
      const onlyYours = / you control/.test(m[0]);
      let count = 0;
      if (onlyYours) {
        count = this.getPlayer(controllerId).battlefield.filter(p => p.card.typeLine.toLowerCase().includes(typeWord)).length;
      } else {
        for (const pl of this.players) count += pl.battlefield.filter(p => p.card.typeLine.toLowerCase().includes(typeWord)).length;
      }
      selfReduction = perEach * count;
    } else {
      m = text.match(/this spell costs \{x\} less to cast,? where x is the total power of creatures you control/);
      if (m) {
        const controller = this.getPlayer(controllerId);
        selfReduction = controller.battlefield.filter(p => isCreature(p.card)).reduce((sum, p) => sum + this.effectivePower(p), 0);
      }
    }
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
    if (this.commanderMode && controller.commanderZone && controller.commander && controller.commander !== card) {
      const text = (controller.commander.oracleText || '').toLowerCase();
      if (/eminence/.test(text)) scan(text);
    }
    return total;
  }

  affordability(playerId, card) {
    const p = this.getPlayer(playerId);
    const parsed = parseManaCost(card.manaCost);
    if (parsed.x > 0) return true; // let UI/AI decide X=0 minimum, always "affordable" at X=0
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
  }

  // Whether this player could pay the card's base cost PLUS its Kicker cost
  // right now (Territorial Allosaurus, etc.) — used by the AI to decide
  // whether to opt into Kicker (see castSpell's `kicked` param) instead of
  // always casting unkicked. Returns false for a card with no Kicker cost.
  canAffordKicked(playerId, card) {
    const kickerCost = getKickerCost(card);
    if (!kickerCost) return false;
    const p = this.getPlayer(playerId);
    const parsed = parseManaCost(card.manaCost + kickerCost);
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
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
    const upperBound = untapped.length + poolTotal;
    for (let x = upperBound; x >= 0; x--) {
      if (planManaPayment(untapped, parsed, x, p.manaPool)) return x;
    }
    return 0;
  }

  affordabilityForCommander(playerId) {
    const p = this.getPlayer(playerId);
    if (!p.commander) return false;
    const parsed = parseManaCost(p.commander.manaCost);
    parsed.generic += this.commanderTax(p);
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(p.commander, playerId));
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
  castSpell(playerId, instanceId, targets = [], xValue = 0, modeIndexes = null, kicked = false, { free = false, bypassTiming = false, ownerId = null } = {}) {
    const p = this.getPlayer(playerId);
    const idx = p.hand.findIndex(c => c.instanceId === instanceId);
    if (idx === -1) return { ok: false, reason: 'Card not in hand.' };
    const card = p.hand[idx];
    // `bypassTiming` (Etali, Primal Storm's own "cast ... from among those
    // cards" attack trigger — mid-combat, nowhere near a normal sorcery-
    // speed window) skips canCastSpell's own priority/step/stack checks
    // entirely: a resolving effect that explicitly grants permission to
    // cast a card is its own timing permission (real rule 601.3b), not
    // bound by the caster's own normal casting windows.
    if (!bypassTiming && !this.canCastSpell(playerId, card)) return { ok: false, reason: 'Cannot cast that right now.' };

    // `free` (Diluvian Primordial's own "cast ... without paying its mana
    // cost") skips ALL cost logic below entirely — no mana, no Kicker, no
    // life payment. Real cards that grant a free cast never also involve
    // those, so this is a clean either/or rather than something needing to
    // combine with them.
    let kickerCost = null;
    if (!free) {
      // "As an additional cost to cast this spell, pay X life" (Toxic
      // Deluge) — X here is a pure life cost, unrelated to the spell's own
      // mana cost (which may have no {X} in it at all — Toxic Deluge's is a
      // fixed {2}{B}), so it must NOT be folded into planManaPayment's own
      // xValue (that would wrongly demand X extra GENERIC MANA on top of
      // the real cost).
      const lifePaymentX = hasLifePaymentXCost(card);
      if (lifePaymentX && xValue >= p.life) return { ok: false, reason: 'Not enough life to pay.' };

      kickerCost = kicked ? getKickerCost(card) : null;
      // Concatenating the two cost STRINGS before parsing (rather than
      // parsing each separately and adding the results) reuses
      // parseManaCost's own symbol-scanning as-is — it just sees more
      // {...} tokens, in any order.
      const parsed = parseManaCost(card.manaCost + (kickerCost || ''));
      parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
      const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
      const payment = planManaPayment(untapped, parsed, lifePaymentX ? 0 : xValue, p.manaPool);
      if (!payment) return { ok: false, reason: 'Not enough mana.' };

      for (const land of payment.lands) land.tapped = true;
      for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
      if (lifePaymentX && xValue > 0) {
        p.life -= xValue;
        this.log(`${p.name} pays ${xValue} life as an additional cost to cast ${card.name}.`);
      }
    }
    p.hand.splice(idx, 1);

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
      kicked: !!kickerCost,
      isPermanentSpell: isPermanentType(card) && !isAura(card),
      isAura: isAura(card),
    };
    this.stack.push(stackItem);
    this.log(`${p.name} casts ${card.name}${stackItem.kicked ? ' (kicked)' : ''}${free ? ' without paying its mana cost' : ''}.`);
    this.triggerCastSpell(playerId, card);
    this.triggerBecomesTarget(targets);
    this.maybeCounterForWard(stackItem);
    this.afterAction(playerId);
    return { ok: true };
  }

  // Removes a just-cast spell from the stack if checkWardAndMaybeCounter
  // says it should be countered — a countered COMMANDER spell goes back to
  // the command zone rather than the graveyard, same as applyCounterEffect's
  // own Counterspell-style path.
  maybeCounterForWard(stackItem) {
    if (!this.checkWardAndMaybeCounter(stackItem.controllerId, stackItem.targets)) return;
    this.stack = this.stack.filter(s => s.id !== stackItem.id);
    // The card's real owner (see castSpell's own `ownerId` option/comment)
    // — almost always the same as the caster, but not for a card like
    // Etali, Primal Storm's own attack trigger casts someone else's.
    const owner = this.getPlayer(stackItem.ownerId || stackItem.controllerId);
    if (this.commanderMode && owner.commander === stackItem.card) {
      owner.commanderZone = true;
      this.log(`${stackItem.card.name} returns to ${owner.name}'s command zone instead.`);
    } else {
      owner.graveyard.push(stackItem.card);
    }
  }

  // ---------- command zone (Commander format only) ----------

  commanderTax(player) { return 2 * player.commanderCastCount; }

  canCastCommander(playerId) {
    const p = this.getPlayer(playerId);
    if (!this.commanderMode || !p.commander || !p.commanderZone) return false;
    return this.canCastSpell(playerId, p.commander);
  }

  // Mirrors castSpell, but the card comes from the command zone (not hand)
  // and its cost is its mana cost plus {2} for every previous cast from the
  // zone this game (the "commander tax", cumulative and permanent).
  castCommander(playerId, targets = [], xValue = 0) {
    const p = this.getPlayer(playerId);
    if (!this.canCastCommander(playerId)) return { ok: false, reason: 'Cannot cast your commander right now.' };
    const card = p.commander;

    const taxPaid = this.commanderTax(p);
    const parsed = parseManaCost(card.manaCost);
    parsed.generic += taxPaid;
    parsed.generic = Math.max(0, parsed.generic - this.getCastCostReduction(card, playerId));
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    const payment = planManaPayment(untapped, parsed, xValue, p.manaPool);
    if (!payment) return { ok: false, reason: 'Not enough mana.' };

    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    p.commanderZone = false;
    p.commanderCastCount += 1;

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
    this.triggerBecomesTarget(targets);
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
    if (this.commanderMode && caster.commanderZone && caster.commander) {
      const triggers = interpretCastTriggers(caster.commander).filter(t => t.eminence);
      for (const trig of triggers) {
        if (!spellMatchesFilter(castCard, trig.filter)) continue;
        this.resolveEffectSteps(trig.steps, [], { controllerId: caster.id, card: caster.commander, sourcePerm: null });
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
    this._diesCascadeDepth = (this._diesCascadeDepth || 0) + 1;
    if (this._diesCascadeDepth > Game.TRIGGER_CASCADE_DEPTH_CAP) {
      this.log(`Death-trigger cascade got ${Game.TRIGGER_CASCADE_DEPTH_CAP} deep — stopping here rather than risking a runaway chain.`);
      this._diesCascadeDepth -= 1;
      return;
    }
    try {
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
    for (const watcher of controller.battlefield) {
      const triggers = interpretAttackTriggers(watcher.card);
      for (const trig of triggers) {
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
        if (kind === 'creature' || kind === 'creatureOrPlayer' || kind === 'permanent') {
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
    const controller = this.getPlayer(sourcePerm.controllerId);
    for (const watcher of controller.battlefield) {
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
    const item = this.stack.pop();
    if (!item) return;
    const { card, controllerId } = item;
    const p = this.getPlayer(controllerId);

    if (item.isPermanentSpell) {
      const perm = makePermanent(card, controllerId);
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
      // Same idea for Escape (Uro, Titan of Nature's Wrath's own "sacrifice
      // it unless it escaped") — see castFromGraveyard.
      perm.escaped = !!item.viaEscape;
      p.battlefield.push(perm);
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
      this.checkStateBasedActions();
      this.triggerETB(perm, item.xValue || 0);
      if (isSaga(card)) this.advanceSaga(perm);
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
      if (!targetPerm) {
        this.log(`${card.name} has no legal target and is put into the graveyard.`);
        p.graveyard.push(card);
        return;
      }
      const perm = makePermanent(card, controllerId);
      perm.attachedTo = targetPerm.id;
      p.battlefield.push(perm);
      this.log(`${card.name} enchants ${targetPerm.card.name}.`);
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
    this.resolveEffectSteps(interpretSpell(card, item.modeIndexes), item.targets, { controllerId, card, xValue: item.xValue, castFromGraveyard: !!(item.viaFlashback || item.viaEscape) });
    // Flashback and Escape both exile an instant/sorcery as it resolves
    // instead of putting it into the graveyard as usual (Flashback's own
    // "then exile it"; Escape's identical real-rules behavior for
    // non-permanent cards) — see castFromGraveyard.
    if (item.viaFlashback || item.viaEscape) {
      p.exile.push(card);
      this.log(`${card.name} is exiled instead of returning to the graveyard (cast from the graveyard).`);
    } else if (item.exileToOwnerId) {
      // Diluvian Primordial's own "if a spell cast this way would be put
      // into a graveyard, exile it instead" — the card's owner is whoever
      // it was cast FROM (an opponent's graveyard), not this spell's
      // CASTER (item.controllerId, who's just borrowing it), so this goes
      // to a different player's exile than the `p.exile` case above.
      this.getPlayer(item.exileToOwnerId).exile.push(card);
      this.log(`${card.name} is exiled instead of returning to its owner's graveyard.`);
    } else {
      // Normally the caster's own graveyard, EXCEPT when the card's real
      // owner is someone else (Etali, Primal Storm casting an opponent's
      // exiled card, with no "exile it instead" text of its own) — see
      // castSpell's own `ownerId` option/comment.
      this.getPlayer(item.ownerId || controllerId).graveyard.push(card);
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
    // Piggybacks tribal-ETB and any-permanent-ETB dispatch onto this same
    // "a permanent just entered" hub — every real path a permanent can
    // enter the battlefield already calls triggerETB from exactly the
    // right moment, so neither needs separate call sites of its own.
    this.triggerTribalEtb(perm);
    this.triggerAnyEtb(perm);

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
      import('./ai.js').then(({ pickTargetsForKinds }) => {
        if (this.gameOver || !this.findPermanent(perm.id)) return;
        const targets = pickTargetsForKinds(this, perm.card, perm.controllerId, kinds, perm.id);
        this.resolveEffectSteps(steps, targets, ctxBase);
        this.checkStateBasedActions();
        this.emit();
      });
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
      const { steps, ctxBase } = this._pendingETB;
      const collected = this.pendingRequest.collected;
      this.pendingRequest = null;
      this._pendingETB = null;
      this.resolveEffectSteps(steps, collected, ctxBase);
      this.checkStateBasedActions();
    }
    this.emit();
    return true;
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
    return interpretNonTapAbilities(perm.card);
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
    if (this.gameOver || this.pendingRequest) return false;
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
    const parsed = parseManaCost(ability.manaCost);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
  }

  activateGraveyardAbility(playerId, cardInstanceId) {
    if (!this.canActivateGraveyardAbility(playerId, cardInstanceId)) return { ok: false, reason: 'Cannot activate that right now.' };
    const p = this.getPlayer(playerId);
    const idx = p.graveyard.findIndex(c => c.instanceId === cardInstanceId);
    const card = p.graveyard[idx];
    const ability = interpretGraveyardAbilities(card)[0];
    const parsed = parseManaCost(ability.manaCost);
    const untapped = p.battlefield.filter(x => isLand(x.card) && !x.tapped);
    const payment = planManaPayment(untapped, parsed, 0, p.manaPool);
    for (const land of payment.lands) land.tapped = true;
    for (const color of Object.keys(payment.poolUsed)) p.manaPool[color] -= payment.poolUsed[color];
    p.graveyard.splice(idx, 1);
    const perm = makePermanent(card, playerId);
    if (ability.tapped) perm.tapped = true;
    p.battlefield.push(perm);
    this.log(`${p.name} returns ${card.name} from their graveyard to the battlefield${ability.tapped ? ' tapped' : ''}.`);
    this.checkStateBasedActions();
    this.triggerETB(perm);
    this.afterAction(playerId);
    return { ok: true };
  }

  // ---------- equip (Equipment's "Equip {cost}" ability) ----------

  // null if this permanent has no equip ability, else its cost as written
  // (e.g. "{1}"). A separate concept from tap abilities: equip has no {T} in
  // its cost and — unlike tap abilities — is sorcery-speed only.
  getEquipCost(perm) {
    return interpretEquipCost(perm.card);
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

    const p = this.getPlayer(playerId);
    const parsed = parseManaCost(this.getEquipCost(equipPerm));
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
      if (perm) {
        // Real rule 120.3c: damage to a planeswalker removes that many
        // loyalty counters immediately, rather than being marked as damage
        // for state-based actions to check later the way creature damage
        // works.
        if (isPlaneswalker(perm.card)) {
          perm.counters.loyalty = (perm.counters.loyalty || 0) - amount;
          this.log(`${ctx.card.name} deals ${amount} damage to ${perm.card.name}, removing ${amount} loyalty counter${amount === 1 ? '' : 's'}.`);
        } else {
          perm.damage += amount;
          this.log(`${ctx.card.name} deals ${amount} damage to ${perm.card.name}.`);
        }
      }
    } else if (ctx.target?.type === 'player') {
      const pl = this.getPlayer(ctx.target.id);
      if (pl) {
        pl.life -= amount;
        pl.damageTakenThisTurn += amount;
        this.log(`${ctx.card.name} deals ${amount} damage to ${pl.name}.`);
      }
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
    if ((perm.card.keywords || []).includes('indestructible')) {
      this.log(`${perm.card.name} is indestructible and isn't destroyed.`);
      return;
    }
    this.movePermanentToGraveyard(perm);
    this.log(`${ctx.card.name} destroys ${perm.card.name}.`);
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
          const matches = (perm.card.typeLine || '').toLowerCase().includes(typeWord);
          if (negate ? matches : !matches) continue;
        }
        this.applyDestroyEffect({ ...ctx, target: { type: 'permanent', id: perm.id } });
      }
    }
    this.checkStateBasedActions();
  }

  applyCounterEffect(ctx) {
    let idx = ctx.target?.type === 'stack' ? this.stack.findIndex(s => s.id === ctx.target.id) : -1;
    if (idx === -1) {
      // Fall back to the topmost eligible spell (closest to resolving) if no
      // specific target was supplied or it's no longer on the stack.
      for (let i = this.stack.length - 1; i >= 0; i--) {
        if (!this.stack[i].isPermanentSpell && !this.stack[i].isAura) { idx = i; break; }
      }
    }
    if (idx === -1) {
      this.log(`${ctx.card.name} has no spell to counter.`);
      return;
    }
    const countered = this.stack.splice(idx, 1)[0];
    const owner = this.getPlayer(countered.controllerId);
    // A countered COMMANDER spell goes back to the command zone, not the
    // graveyard, same "commander replacement effect" already applied
    // everywhere a commander leaves the battlefield (redirectCommanderToZone) —
    // this is the one other zone a commander can leave FROM (the stack).
    if (this.commanderMode && owner.commander === countered.card) {
      owner.commanderZone = true;
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
    const matches = (perm) => (perm.card.typeLine || '').toLowerCase().includes(typeWord);
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
      count = this.getPlayer(ctx.controllerId).battlefield.filter(p => (p.card.typeLine || '').toLowerCase().includes(typeWord)).length;
    } else {
      for (const pl of this.players) count += pl.battlefield.filter(p => (p.card.typeLine || '').toLowerCase().includes(typeWord)).length;
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
  applyMassPumpEffect(ctx, scope, power, toughness, { excludeSelf = false, keywordText = null } = {}) {
    const controller = this.getPlayer(ctx.controllerId);
    const affectedPlayers = scope === 'all' ? this.players
      : scope === 'opponents' ? this.players.filter(pl => pl.id !== controller.id)
      : [controller];
    const keywords = keywordText ? extractKnownKeywords(keywordText.toLowerCase()) : [];
    for (const pl of affectedPlayers) {
      for (const perm of pl.battlefield) {
        if (!isCreature(perm.card)) continue;
        if (excludeSelf && ctx.sourcePerm && perm.id === ctx.sourcePerm.id) continue;
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
      import('./ai.js').then(({ pickTargetsForKinds }) => {
        if (this.gameOver || !this.findPermanent(perm.id)) return;
        const targets = pickTargetsForKinds(this, perm.card, perm.controllerId, kinds, perm.id);
        this.resolveEffectSteps(steps, targets, ctxBase);
        this.checkStateBasedActions();
        this.emit();
      });
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
  applyReanimateFromOwnGraveyardEffect(ctx, { typeWord = 'creature', maxCmc = Infinity } = {}) {
    const p = this.getPlayer(ctx.controllerId);
    const candidates = p.graveyard.filter(c => (typeWord === 'permanent' ? isPermanentType(c) : isCreature(c)) && (c.cmc || 0) <= maxCmc);
    if (candidates.length === 0) {
      this.log(`${ctx.card.name} finds no matching card in ${p.name}'s graveyard.`);
      return;
    }
    const best = candidates.slice().sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    p.graveyard = p.graveyard.filter(c => c !== best);
    const perm = makePermanent(best, ctx.controllerId);
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
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * p.hand.length);
      p.graveyard.push(p.hand.splice(idx, 1)[0]);
    }
    for (let i = 0; i < count; i++) this.drawCard(p);
    if (count > 0) this.log(`${p.name} discards ${count} card${count > 1 ? 's' : ''} and draws ${count} card${count > 1 ? 's' : ''}.`);
  }

  // Type-restricted tutor-to-TOP-of-library (Forerunner of the Empire's own
  // ETB, and similar) — grabs the first matching card found, same auto-pick
  // simplification as everywhere else in this engine.
  applyTutorToTopEffect(ctx, typeWord) {
    const p = this.getPlayer(ctx.controllerId);
    const idx = p.library.findIndex(c => (c.typeLine || '').toLowerCase().includes(typeWord));
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
      const idx = p.library.findIndex(c => (c.typeLine || '').toLowerCase().includes(typeWord) && (c.cmc || 0) <= maxCmc);
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
      pl.graveyard.push(...pl.hand);
      pl.hand = [];
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

  // Simplification: picks randomly rather than letting the discarding player choose.
  applyDiscardEffect(ctx, amount) {
    if (ctx.target?.type !== 'player') return;
    const p = this.getPlayer(ctx.target.id);
    if (!p) return;
    let discarded = 0;
    for (let i = 0; i < amount && p.hand.length > 0; i++) {
      const idx = Math.floor(Math.random() * p.hand.length);
      p.graveyard.push(p.hand.splice(idx, 1)[0]);
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
    const card = p.exiledPlayable[idx].card;
    p.hand.push(card);
    const result = isLand(card)
      ? (this.playLand(playerId, card.instanceId) ? { ok: true } : { ok: false, reason: 'Cannot play that land right now.' })
      : this.castSpell(playerId, card.instanceId, targets, xValue, modeIndexes, kicked);
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
    return isLand(card) ? this.canPlayLand(playerId) : (this.canCastSpell(playerId, card) && this.affordability(playerId, card));
  }

  // ---------- casting from the graveyard (Flashback, Escape) ----------
  // A meaningfully different shape from exile-and-play above: the
  // alternative cost ISN'T the card's own printed mana cost (Flashback
  // {2}{R} on a {1}{U} instant, say), and Escape adds a real second cost
  // (exiling N OTHER graveyard cards) on top of its own mana cost.

  getFlashbackCost(card) { return getFlashbackCost(card); }
  getEscapeCost(card) { return getEscapeCost(card); }

  canCastFromGraveyard(playerId, cardInstanceId, { viaEscape = false } = {}) {
    if (this.pendingRequest) return false;
    const p = this.getPlayer(playerId);
    if (this.priorityPlayer.id !== playerId) return false;
    const card = p.graveyard.find(c => c.instanceId === cardInstanceId);
    if (!card) return false;
    const altCost = viaEscape ? getEscapeCost(card) : getFlashbackCost(card);
    if (!altCost) return false;
    if (viaEscape) {
      const others = p.graveyard.filter(c => c.instanceId !== cardInstanceId).length;
      if (others < altCost.exileCount) return false;
    }
    const instantSpeed = isInstant(card) || /flash/.test((card.keywords || []).join(','));
    if (!instantSpeed && !(p.id === this.active.id && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0)) return false;
    const parsed = parseManaCost(viaEscape ? altCost.manaCost : altCost);
    const untapped = p.battlefield.filter(perm => isLand(perm.card) && !perm.tapped);
    return !!planManaPayment(untapped, parsed, 0, p.manaPool);
  }

  // Casts/plays a card straight out of the graveyard via Flashback or
  // Escape. Same "temporarily reunite with hand, reuse castSpell entirely"
  // trick as playCardFromExile — except here the reunited card's manaCost
  // is TEMPORARILY OVERRIDDEN to the alternative cost first (so
  // castSpell's own mana-payment logic charges the right amount), then
  // restored immediately after a successful cast (payment has already
  // happened by then, so restoring it only fixes the card's own displayed/
  // remembered cost going forward — e.g. if it becomes a permanent).
  castFromGraveyard(playerId, cardInstanceId, { targets = [], xValue = 0, modeIndexes = null, viaEscape = false } = {}) {
    if (!this.canCastFromGraveyard(playerId, cardInstanceId, { viaEscape })) return { ok: false, reason: 'Cannot cast that from the graveyard right now.' };
    const p = this.getPlayer(playerId);
    const idx = p.graveyard.findIndex(c => c.instanceId === cardInstanceId);
    const original = p.graveyard[idx];
    const altCost = viaEscape ? getEscapeCost(original) : getFlashbackCost(original);
    const originalManaCost = original.manaCost;
    const overridden = { ...original, manaCost: viaEscape ? altCost.manaCost : altCost };
    p.graveyard.splice(idx, 1);
    p.hand.push(overridden);
    const result = this.castSpell(playerId, overridden.instanceId, targets, xValue, modeIndexes);
    if (!result.ok) {
      const handIdx = p.hand.findIndex(c => c.instanceId === overridden.instanceId);
      if (handIdx !== -1) p.hand.splice(handIdx, 1);
      p.graveyard.splice(idx, 0, original);
      return result;
    }
    overridden.manaCost = originalManaCost;
    if (viaEscape) {
      for (let i = 0; i < altCost.exileCount && p.graveyard.length > 0; i++) p.exile.push(p.graveyard.shift());
      this.log(`${p.name} exiles ${altCost.exileCount} other card${altCost.exileCount === 1 ? '' : 's'} from their graveyard to pay Escape.`);
    }
    const stackItem = this.stack[this.stack.length - 1];
    if (stackItem && stackItem.card === overridden) {
      stackItem.viaFlashback = !viaEscape;
      stackItem.viaEscape = viaEscape;
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
    this.getPlayer(perm.ownerId).exile.push(perm.card);
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
  applyFightEffect(ctx) {
    if (!ctx.sourcePerm || ctx.target?.type !== 'permanent') return;
    const self = this.findPermanent(ctx.sourcePerm.id);
    const other = this.findPermanent(ctx.target.id);
    if (!self || !other) return;
    const selfPower = this.effectivePower(self);
    const otherPower = this.effectivePower(other);
    other.damage += selfPower;
    self.damage += otherPower;
    this.log(`${self.card.name} fights ${other.card.name} (${selfPower} damage to ${other.card.name}, ${otherPower} damage to ${self.card.name}).`);
    this.checkStateBasedActions();
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
    if (this.redirectCommanderToZone(perm)) return;
    owner.hand.push(perm.card);
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
  applyRegrowthEffect(ctx, typeWords = null) {
    const p = this.getPlayer(ctx.controllerId);
    if (p.graveyard.length === 0) {
      this.log(`${ctx.card.name} finds no card in ${p.name}'s graveyard.`);
      return;
    }
    const pool = typeWords
      ? p.graveyard.filter(c => typeWords.some(w => (c.typeLine || '').toLowerCase().includes(w)))
      : (p.graveyard.some(c => !isLand(c)) ? p.graveyard.filter(c => !isLand(c)) : p.graveyard);
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
    let candidates = typeWord === 'permanent' ? p.battlefield.slice() : p.battlefield.filter(perm => (perm.card.typeLine || '').toLowerCase().includes(typeWord));
    if (excludeSelf && ctx.sourcePerm) candidates = candidates.filter(perm => perm.id !== ctx.sourcePerm.id);
    if (candidates.length === 0) return;
    const cheapest = candidates.sort((a, b) => (a.card.cmc || 0) - (b.card.cmc || 0))[0];
    const owner = this.getPlayer(cheapest.ownerId);
    p.battlefield = p.battlefield.filter(x => x.id !== cheapest.id);
    this.detachFromLeavingBattlefield(cheapest);
    this.triggerLeavesBattlefield(cheapest);
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
    this.getPlayer(perm.ownerId).graveyard.push(perm.card);
    this.leftBattlefieldThisTurn.push({ card: perm.card, ownerId: perm.ownerId });
    this.triggerDies(perm, previouslyAttachedIds);
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
    for (const pl of this.players) {
      for (const other of pl.battlefield.filter(x => x.attachedTo === perm.id)) {
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
    if (!this.commanderMode || owner.commander !== perm.card) return false;
    owner.commanderZone = true;
    this.log(`${perm.card.name} returns to ${owner.name}'s command zone instead.`);
    return true;
  }

  // ---------- effective stats (base + counters + temp buffs + auras) ----------

  effectivePower(perm) {
    let power = parseInt(perm.card.power, 10) || 0;
    power += this.auraBonus(perm, 'power');
    power += this.anthemBonus(perm, 'power');
    power += this.selfAttachmentBonus(perm, 'power');
    power += counterStatTotal(perm.counters, 'power');
    power += perm.tempBuffs.reduce((s, b) => s + b.power, 0);
    return power;
  }

  effectiveToughness(perm) {
    let t = parseInt(perm.card.toughness, 10) || 0;
    t += this.auraBonus(perm, 'toughness');
    t += this.anthemBonus(perm, 'toughness');
    t += this.selfAttachmentBonus(perm, 'toughness');
    t += counterStatTotal(perm.counters, 'toughness');
    t += perm.tempBuffs.reduce((s, b) => s + b.toughness, 0);
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
    for (const other of controller.battlefield) {
      const lines = (other.card.oracleText || '').toLowerCase().split('\n');
      for (const line of lines) {
        // An optional single qualifier word before "creatures you control"
        // (Mikaeus's "other non-Human creatures you control") is recognized
        // so the line matches at all, but — like other qualifiers this
        // engine can't fully enforce — the type restriction itself isn't
        // checked, so it applies a bit more broadly than the real card.
        const isOtherOnly = /^other (?:[a-z-]+ )?creatures you control /.test(line);
        const isTokenOnly = /^creature tokens you control /.test(line);
        if (isOtherOnly && other.id === perm.id) continue;
        if (isTokenOnly && !isToken) continue;
        if (!isOtherOnly && !isTokenOnly && !/^(?:[a-z-]+ )?creatures you control /.test(line)) continue;
        // "Other creatures you control OF THE CHOSEN TYPE get +1/+1"
        // (Adaptive Automaton) — unlike the qualifier-word case above,
        // this restriction IS enforced, since "the chosen type" resolves
        // to a real, specific value (other.chosenType, set by
        // applyChooseCreatureTypeEffect) rather than a type word this
        // engine can't fully check.
        if (/of the chosen type/.test(line)) {
          if (!other.chosenType || !(perm.card.typeLine || '').toLowerCase().includes(other.chosenType.toLowerCase())) continue;
        }
        const m = line.match(/get ([+-]\d+)\/([+-]\d+)/);
        if (m) bonus += stat === 'power' ? parseInt(m[1], 10) : parseInt(m[2], 10);
      }
    }
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
        if (other.attachedTo === perm.id && (other.card.typeLine || '').toLowerCase().includes(typeWord)) count++;
      }
    }
    return count;
  }

  effectiveKeywords(perm) {
    const set = new Set(perm.card.keywords || []);
    for (const kw of perm.tempKeywords || []) set.add(kw);

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
      const isToken = /\btoken\b/i.test(perm.card.typeLine || '');
      for (const other of controller.battlefield) {
        const lines = (other.card.oracleText || '').toLowerCase().split('\n');
        for (const line of lines) {
          if (isCreature(perm.card)) {
            // See anthemBonus's matching comment: an optional qualifier word
            // (Mikaeus's "other non-Human creatures you control") is
            // recognized syntactically but not enforced as a real restriction.
            const isOtherOnly = /^other (?:[a-z-]+ )?creatures you control /.test(line);
            const isTokenOnly = /^creature tokens you control /.test(line);
            if (isOtherOnly && other.id === perm.id) continue;
            if (isTokenOnly && !isToken) continue;
            if (isOtherOnly || isTokenOnly || /^(?:[a-z-]+ )?creatures you control /.test(line)) {
              for (const kw of extractKnownKeywords(line)) set.add(kw);
            }
          }
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
  canBeTargetedBy(perm, byControllerId) {
    const kws = this.effectiveKeywords(perm);
    if (kws.has('shroud')) return false;
    if (kws.has('hexproof') && perm.controllerId !== byControllerId) return false;
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
    if (kind === 'player') return { type: 'player', id: opponent.id };
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
    return this.canAttackDespiteSickness(perm) && !this.effectiveKeywords(perm).has('cantAttack');
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
    const opponent = this.opponentOf(playerId);
    const newAttackers = [];
    for (const id of attackerIds) {
      const perm = p.battlefield.find(x => x.id === id);
      if (!perm || !isCreature(perm.card) || perm.tapped || !this.canDeclareAsAttacker(perm)) continue;
      const kws = this.effectiveKeywords(perm);
      perm.attacking = true;
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
    for (const { blockerId, attackerId } of blockMap) {
      const blocker = p.battlefield.find(x => x.id === blockerId);
      const attacker = this.findPermanent(attackerId);
      if (!blocker || !attacker || blocker.tapped) continue;
      if (this.effectiveKeywords(blocker).has('cantBlock')) continue;
      const attackerKws = this.effectiveKeywords(attacker);
      if (attackerKws.has('flying') || attackerKws.has('reach')) {
        const blockerKws = this.effectiveKeywords(blocker);
        if (attackerKws.has('flying') && !blockerKws.has('flying') && !blockerKws.has('reach')) continue;
      }
      blocker.blocking = attacker.id;
      attacker.blockedBy.push(blocker.id);
    }
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
    this.getPlayer(attacker.ownerId).hand.push(attacker.card);
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
    defenderPlayer.life -= amount;
    defenderPlayer.damageTakenThisTurn += amount;
    if (isCommanderSource) defenderPlayer.commanderDamageTaken += amount;
    this.log(`${attackerPerm.card.name} deals ${amount} damage to ${defenderPlayer.name}.`);
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
      const isCommanderSource = this.commanderMode && this.getPlayer(attackerPerm.controllerId).commander === attackerPerm.card;

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
        blocker.damage += assign;
        remaining -= assign;
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
        incoming += this.effectivePower(blocker);
        if (this.effectiveKeywords(blocker).has('deathtouch')) blockerHasDeathtouch = true;
        if (this.effectiveKeywords(blocker).has('lifelink')) {
          this.getPlayer(blocker.controllerId).life += this.effectivePower(blocker);
        }
      }
      attackerPerm.damage += incoming;
      if (incoming > 0) this.log(`${blockers.map(b => b.card.name).join(' and ')} deal${blockers.length === 1 ? 's' : ''} ${incoming} damage to ${attackerPerm.card.name}.`);
      if (blockerHasDeathtouch) attackerPerm.damage = Math.max(attackerPerm.damage, this.effectiveToughness(attackerPerm));
    }
  }

  checkStateBasedActions() {
    if (this.gameOver) return;
    for (const p of this.players) {
      if (p.life <= 0 && !p.lost) { this.loseGame(p.id, 'life total reached 0'); return; }
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
        if ((perm.card.keywords || []).includes('indestructible') && this.effectiveToughness(perm) > 0) continue;
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
        const discard = p.hand.pop();
        p.graveyard.push(discard);
        this.log(`${p.name} discards ${discard.name} at the maximum hand size.`);
      }
      for (const perm of p.battlefield) {
        perm.damage = 0;
        perm.tempBuffs = [];
        perm.tempKeywords = [];
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
  isAura(card) { return isAura(card); }
  isPlaneswalker(card) { return isPlaneswalker(card); }
  isInstantOrSorcery(card) { return isInstant(card) || isSorcery(card); }
  hasLifePaymentXCost(card) { return hasLifePaymentXCost(card); }

  getKickerCost(card) { return getKickerCost(card); }

  // The most life a "pay X life as an additional cost" spell (Toxic
  // Deluge) can reasonably ask for — leaves at least 1, since paying
  // yourself to 0 as a COST (not damage) still just kills you via
  // state-based actions with nothing gained.
  getMaxLifePaymentX(playerId) {
    return Math.max(0, this.getPlayer(playerId).life - 1);
  }
}
