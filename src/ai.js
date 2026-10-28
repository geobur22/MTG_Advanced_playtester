// A heuristic (non-learning) bot. It plays lands, casts what it can afford,
// attacks when it's ahead or safe, blocks to avoid unnecessary damage/losses,
// and will fire off removal/burn at instant speed when it clearly helps.

import { isFullyUnsupported as isFullyUnsupportedSteps, hasLifePaymentXCost, getBloodthirstAmount } from './effects.js';
import { parseManaCost, totalCmc } from './mana.js';

function isCreature(g, card) { return g.isCreature(card); }
function isLand(g, card) { return g.isLand(card); }
function isAura(g, card) { return g.isAura(card); }

// Basalt Monolith/Grim Monolith-style "{T}: Add {C}{C}{C}." + "{3}: Untap
// this artifact." is a genuine break-even loop in real Magic — it only
// becomes profitable with a mana doubler (Rings of Brighthearth, Power
// Artifact), so a human would never bother activating the untap on its own.
// Without this check the AI's "activate whatever's affordable" loop below
// has no such judgment and would tap-for-mana/pay-to-untap forever,
// achieving nothing and burning its whole turn on the safety cap instead of
// ever doing anything useful with the mana (confirmed live: exactly this
// loop on Basalt Monolith tripped Game.AI_ACTION_SAFETY_CAP in a real
// Urza, Lord High Artificer game). Only returns false for a plain "pay N to
// untap" ability whose own permanent's tap-for-mana ability wouldn't
// produce MORE than N — anything that nets a real gain, or where the
// permanent's own tap ability isn't mana at all (so there's no generic way
// to judge it), is unaffected.
function isWorthwhilePayToUntap(game, perm, ability) {
  if (ability.steps.length !== 1 || ability.steps[0].kind !== 'untap') return true;
  const manaStep = game.getTapAbilities(perm).flatMap(a => a.steps).find(s => s.kind === 'mana');
  if (!manaStep) return true;
  const produced = manaStep.colors?.length || manaStep.amount || 1;
  const untapCost = totalCmc(parseManaCost(ability.manaCost || ''));
  return produced > untapCost;
}

// Auras get a blanket 'permanent' targeting kind regardless of what they
// actually do (see getRequiredTargetKinds), so a removal-style aura like
// Pacifism looks identical, target-kind-wise, to a beneficial one like
// Rancor. Without this check the AI would attach either kind to its own
// best creature — great for Rancor, disastrous for Pacifism.
function isDetrimentalAura(card) {
  const text = (card.oracleText || '').toLowerCase();
  // "You control enchanted creature" (Mind Control, Control Magic) isn't
  // detrimental to the creature itself, but it's exactly as
  // opponent-seeking as a real removal-style Aura from the CASTER's own
  // point of view — attaching it to your own creature would be a pointless
  // no-op instead of stealing the opponent's best one.
  return /can't attack|can't block|doesn't untap|gets -\d|loses all abilities|base power and toughness 0\/1|you control enchanted creature/.test(text);
}

// Same idea for non-Aura 'permanent'-targeted effects: tap/destroy/exile/
// bounce effects phrased broadly enough to fall back to "permanent" (Icy
// Manipulator's "tap target artifact, creature, or land", or a "destroy
// target permanent") are things you want to point at the OPPONENT's board,
// not your own.
function wantsOpponentPermanent(game, card) {
  if (isAura(game, card)) return isDetrimentalAura(card);
  return /destroy target|exile target|tap target|return target permanent/i.test(card.oracleText || '');
}

// Treasures and other sacrifice-for-mana sources: if some uncastable,
// non-X spell in hand becomes castable with k of them, sacrifice exactly k
// (choosing the colors it needs) and return true so the next action casts
// it. Simulated by temporarily adding that mana to the pool. Only when
// nothing is castable already (castWays empty) or the enabled spell costs
// more than everything that is.
function crackOneShotManaFor(game, p, castWays) {
  const sources = [];
  for (const perm of p.battlefield) {
    if (perm.tapped) continue;
    game.getTapAbilities(perm).forEach((a, idx) => {
      if (a.isManaAbility && a.sacrificeCost && game.canActivateTapAbility(p.id, perm.id, idx)) sources.push({ perm, idx });
    });
  }
  if (!sources.length) return false;
  const bestCastable = Math.max(0, ...[...castWays.keys()].map(c => c.cmc || 0));
  const wanted = p.hand
    .filter(c => !isLand(game, c) && !castWays.has(c) && (c.cmc || 0) > bestCastable && !/\{X\}/i.test(c.manaCost || '') && game.canCastSpell(p.id, c))
    .sort((a, b) => (b.cmc || 0) - (a.cmc || 0));
  for (const card of wanted) {
    const parsed = parseManaCost(card.manaCost || '');
    const pips = Object.entries(parsed.colors || {}).flatMap(([c, n]) => Array(n).fill(c));
    for (let k = 1; k <= sources.length; k++) {
      const colors = Array.from({ length: k }, (_, i) => pips[i] || 'C');
      const saved = { ...p.manaPool };
      for (const c of colors) p.manaPool[c] = (p.manaPool[c] || 0) + 1;
      const ok = game.affordability(p.id, card);
      p.manaPool = saved;
      if (!ok) continue;
      colors.forEach((c, i) => game.activateTapAbility(p.id, sources[i].perm.id, sources[i].idx, [], { chosenColor: c === 'C' ? null : c }));
      return true;
    }
  }
  return false;
}

// Which permanents a 'permanent'/'artifact'/'enchantment'/'land' target
// kind can actually hit — see pickTargetsForKinds.
function permanentTargetMatcher(game, card, kind) {
  if (kind === 'artifact') return (p) => game.isArtifact(p.card);
  if (kind === 'enchantment') return (p) => game.isEnchantment(p.card);
  if (kind === 'land') return (p) => game.isLand(p.card);
  const phrase = ((card.oracleText || '').replace(/\([^()]*\)/g, '').toLowerCase().match(/target ([^.;:]*?)(?:permanent|\.|,|$)/) || [])[1] || '';
  const named = ['artifact', 'creature', 'enchantment', 'land', 'planeswalker'].filter(t => new RegExp(`(?<!non)\\b${t}\\b`).test(phrase));
  const nonland = /\bnonland\b/.test(phrase);
  if (named.length) {
    return (p) => named.some(t => (t === 'creature' ? isCreature(game, p.card) : (p.card.typeLine || '').toLowerCase().includes(t)));
  }
  if (nonland) return (p) => !game.isLand(p.card);
  if (isAura(game, card)) return (p) => isCreature(game, p.card);
  return (p) => !game.isLand(p.card);
}

function pickTargetsFor(game, card, controllerId, modeIndexes = null) {
  return pickTargetsForKinds(game, card, controllerId, game.getRequiredTargetKinds(card, modeIndexes));
}

// Gift: promise it when what the opponent gets is minor (a Food, a tapped
// Fish, a Treasure, a Clue) or when the spell punishes not promising —
// never an 8/8 Octopus or an extra turn, and a card only when the promised
// version of the spell is actually better.
function shouldPromiseGift(game, card) {
  const kind = game.getGiftKind(card);
  if (!kind || !game.canGiveGift(card)) return false;
  const text = (card.oracleText || '').toLowerCase();
  if (/if the gift wasn't promised/.test(text)) return kind !== 'octopus';
  if (['food', 'tapped fish', 'fish', 'treasure', 'clue'].includes(kind)) return /if the gift was promised/.test(text);
  return kind === 'card' && /if the gift was promised/.test(text) && !/\bdraw/.test(text.split('if the gift was promised')[0]);
}

// Tokens worth giving up for a payoff (Bargain, Casualty): any noncreature
// token, or a creature token with 1 or less power.
function isTokenFodder(game, perm) {
  if (!/\btoken\b/i.test(perm.card.typeLine || '')) return false;
  return !isCreature(game, perm.card) || game.effectivePower(perm) <= 1;
}

// Optional cast-time costs worth paying (see game.castSpell's `extras`):
// as many Replicate copies / Squad tokens as the mana allows, Offspring
// when affordable, Conspire when two creatures sharing a color are free to
// tap (after combat, or summoning sick), Casualty with a token, Bargain
// with token fodder, and the gift decided above.
function chooseCastExtras(game, p, card, modeIndexes, kicked, { gift, bargainFodder }) {
  const extras = {};
  let committed = game.getModeExtraCost(card, modeIndexes) + (kicked ? (game.getOptionalAdditionalCost(card) || '') : '');
  if (gift) extras.gift = true;
  if (bargainFodder) extras.bargain = bargainFodder.id;
  const replicate = game.getReplicateCost(card);
  if (replicate) {
    const n = game.maxAffordableRepeats(p.id, card, replicate, committed, 4);
    if (n) { extras.replicate = n; committed += replicate.repeat(n); }
  }
  const squad = game.getSquadCost(card);
  if (squad) {
    const n = game.maxAffordableRepeats(p.id, card, squad, committed, 3);
    if (n) { extras.squad = n; committed += squad.repeat(n); }
  }
  const offspring = game.getOffspringCost(card);
  if (offspring && game.canAffordWithExtra(p.id, card, committed + offspring)) { extras.offspring = true; committed += offspring; }
  if (game.hasConspire(card)) {
    const tappers = game.conspireCandidates(p.id, card).filter(x => game.step !== 'main1' || !game.canDeclareAsAttacker(x));
    if (tappers.length >= 2) extras.conspire = tappers.slice(0, 2).map(x => x.id);
  }
  if (game.getCasualtyAmount(card) != null) {
    const victim = game.casualtyCandidates(p.id, card).find(x => /\btoken\b/i.test(x.card.typeLine || '') && x.id !== extras.bargain);
    if (victim) extras.casualty = victim.id;
  }
  return extras;
}

// For a modal spell, greedily picks mode(s) (in printed order) whose
// targets are actually satisfiable, up to however many the spell requires.
// Returns null if it can't find enough satisfiable modes (the caller should
// skip the card entirely then, same as when a non-modal spell has no legal
// target) — no attempt at judging which mode is "best," just which ones
// are legal to cast at all.
function pickModesFor(game, modal, card, controllerId) {
  const chosen = [];
  for (let i = 0; i < modal.modes.length && chosen.length < modal.count; i++) {
    const steps = modal.modes[i].steps;
    const kinds = game.expandTargetKinds(steps);
    const targets = pickTargetsForKinds(game, card, controllerId, kinds).filter(Boolean);
    if (game.minRequiredTargetCount(steps) <= targets.length) chosen.push(i);
  }
  const needed = modal.upTo ? 1 : modal.count;
  return chosen.length >= needed ? chosen : null;
}

// Shared by spell casting and ETB-trigger resolution: picks a best-effort
// target for each requested kind.
// usedIds tracks permanents already picked earlier in THIS SAME call, so a
// multi-target step (expandTargetKinds' repeated-kind slots — "up to two
// target creatures") picks distinct permanents instead of the same "best"
// one twice. Starts empty and only ever filters what a single-target call
// would already see, so single-target behavior is unchanged.
// excludeId (an ETB trigger's own just-entered permanent, e.g. Territorial
// Allosaurus fighting "ANOTHER target creature") is filtered out of every
// candidate pool below — without it, a card whose only "own" creature is
// itself would otherwise end up selected as its own target.
export function pickTargetsForKinds(game, card, controllerId, kinds, excludeId = null) {
  const opponent = game.opponentOf(controllerId);
  const targets = [];
  const usedIds = new Set();
  if (excludeId) usedIds.add(excludeId);
  for (const kind of kinds) {
    if (kind === 'player') {
      // "Target player draws three cards" (Ancestral Vision) or "target
      // player draws two cards and loses 2 life" (Sign in Blood) helps
      // whoever it targets — point it at ourselves, unless the attached
      // life loss would finish off the opponent. Everything else (discard,
      // mill, damage, plain life loss) goes at the opponent. This used to
      // always pick the opponent, handing them the cards.
      const text = (card.oracleText || '').toLowerCase();
      // Only when the TARGETED player is the one drawing/gaining — "target
      // player loses 2 life and you gain 2 life" (a drain) used to count.
      const helps = /target player (?:draws?|gains?)\b/.test(text);
      const loss = text.match(/loses? (\d+) life/);
      const lethal = loss && opponent.life <= parseInt(loss[1], 10);
      targets.push({ type: 'player', id: helps && !lethal ? controllerId : opponent.id });
      continue;
    }
    // "Target creature you control": our best creature (biggest power — the
    // right pick for a bite's source and for a pump alike).
    if (kind === 'yourCreature') {
      const own = game.getPlayer(controllerId).battlefield.filter(p => isCreature(game, p.card) && game.canBeTargetedBy(p, controllerId, card) && !usedIds.has(p.id))
        .sort((a, b) => game.effectivePower(b) - game.effectivePower(a));
      if (own.length) { targets.push({ type: 'permanent', id: own[0].id }); usedIds.add(own[0].id); }
      else targets.push(null);
      continue;
    }
    if (kind === 'creatureOrPlayer' || kind === 'creature') {
      // "Fights" (Fight — Territorial Allosaurus, Prey Upon, ...) is
      // removal-shaped for targeting purposes even though it neither deals
      // damage nor destroys directly: the whole point is to pick the best
      // enemy creature to trade into, same as burn/destroy.
      // (Also exile, and anything that says it targets a creature "an
      // opponent controls" / "you don't control" — Palace Jailer's exile
      // used to target nothing, finding no creature of its own to pick.)
      const isRemoval = /deal|destroy|exile target (?![^.]*\byou control\b)|-\d+\/-\d+|fights?\b|target creature an opponent controls|target creature you don'?t control|phases out until/i.test(card.oracleText || '');
      const enemyCreatures = opponent.battlefield.filter(p => isCreature(game, p.card) && game.canBeTargetedBy(p, controllerId, card) && !usedIds.has(p.id));
      // "Any target"/"creature or player" (kind 'creatureOrPlayer' only —
      // bare 'creature' never includes them) can legally hit a planeswalker
      // in real rules text too. Worth considering for removal/damage:
      // finishing off a low-loyalty planeswalker is often the best use of
      // a burn spell, so ties are broken toward whichever's lowest loyalty.
      const enemyPlaneswalkers = kind === 'creatureOrPlayer'
        ? opponent.battlefield.filter(p => game.isPlaneswalker(p.card) && game.canBeTargetedBy(p, controllerId, card) && !usedIds.has(p.id))
        : [];
      if (isRemoval && (enemyCreatures.length > 0 || enemyPlaneswalkers.length > 0)) {
        const bestCreature = enemyCreatures.length > 0 ? enemyCreatures.sort((a, b) => game.effectivePower(b) - game.effectivePower(a))[0] : null;
        const lowestLoyaltyPw = enemyPlaneswalkers.length > 0 ? enemyPlaneswalkers.sort((a, b) => (a.counters.loyalty || 0) - (b.counters.loyalty || 0))[0] : null;
        const chosen = bestCreature || lowestLoyaltyPw;
        targets.push({ type: 'permanent', id: chosen.id });
        usedIds.add(chosen.id);
      } else if (kind === 'creatureOrPlayer' && enemyCreatures.length === 0 && enemyPlaneswalkers.length === 0) {
        targets.push({ type: 'player', id: opponent.id });
      } else {
        const own = game.getPlayer(controllerId).battlefield.filter(p => isCreature(game, p.card) && game.canBeTargetedBy(p, controllerId, card) && !usedIds.has(p.id));
        if (own.length > 0) { targets.push({ type: 'permanent', id: own[0].id }); usedIds.add(own[0].id); }
        // Bare "target creature" with no creature anywhere: no legal target
        // (this used to fall back to targeting the opponent PLAYER).
        else targets.push(kind === 'creature' ? null : { type: 'player', id: opponent.id });
      }
      continue;
    }
    // "Target player or planeswalker": the opponent, unless one of their
    // planeswalkers is low enough on loyalty to be worth finishing off.
    if (kind === 'playerOrPlaneswalker') {
      const weakPw = opponent.battlefield
        .filter(p => game.isPlaneswalker(p.card) && game.canBeTargetedBy(p, controllerId, card) && !usedIds.has(p.id) && (p.counters.loyalty || 0) <= 3)
        .sort((a, b) => (a.counters.loyalty || 0) - (b.counters.loyalty || 0))[0];
      if (weakPw) { targets.push({ type: 'permanent', id: weakPw.id }); usedIds.add(weakPw.id); }
      else targets.push({ type: 'player', id: opponent.id });
      continue;
    }
    if (kind === 'planeswalker') {
      const enemyPlaneswalkers = opponent.battlefield.filter(p => game.isPlaneswalker(p.card) && game.canBeTargetedBy(p, controllerId, card) && !usedIds.has(p.id));
      if (enemyPlaneswalkers.length > 0) {
        const chosen = enemyPlaneswalkers.sort((a, b) => (a.counters.loyalty || 0) - (b.counters.loyalty || 0))[0];
        targets.push({ type: 'permanent', id: chosen.id });
        usedIds.add(chosen.id);
      } else {
        targets.push(null);
      }
      continue;
    }
    if (kind === 'permanent' || kind === 'artifact' || kind === 'enchantment' || kind === 'land') {
      // Which permanents qualify: the kind itself for a single type, or for
      // a broad 'permanent' kind, whatever types the card's own "target ..."
      // phrase names ("artifact or enchantment", "nonland permanent") —
      // creatures only when nothing narrower is named (Auras, "target
      // permanent" bounce). Creatures rank by power, everything else by
      // mana value.
      const matches = permanentTargetMatcher(game, card, kind);
      const preferOpponent = kind === 'land' || wantsOpponentPermanent(game, card) || kind === 'artifact' || kind === 'enchantment';
      const rank = (p) => isCreature(game, p.card) ? game.effectivePower(p) + 1 : (p.card.cmc || 0);
      const poolOf = (pl) => pl.battlefield.filter(p => matches(p) && game.canBeTargetedBy(p, controllerId, card) && !usedIds.has(p.id)).sort((a, b) => rank(b) - rank(a));
      const primaryPool = poolOf(preferOpponent ? opponent : game.getPlayer(controllerId));
      // No legal target in the preferred pool (a removal aura but the
      // opponent has no creatures yet) — fall back to the other side
      // rather than skip a castable spell, except for destruction: never
      // blow up our own artifact/enchantment/land.
      const harmful = /destroy|exile|sacrifice/i.test(card.oracleText || '') && kind !== 'permanent';
      const fallbackPool = harmful ? [] : poolOf(preferOpponent ? game.getPlayer(controllerId) : opponent);
      const chosen = primaryPool[0] || fallbackPool[fallbackPool.length - 1] || null;
      if (chosen) { targets.push({ type: 'permanent', id: chosen.id }); usedIds.add(chosen.id); }
      else targets.push(null);
      continue;
    }
    if (kind === 'copySpell') {
      // Copy our own topmost instant/sorcery, else the opponent's.
      const spells = game.stack.filter(x => /\b(instant|sorcery)\b/i.test(x.card.typeLine || '') && x.card !== card);
      const pick = spells.filter(x => x.controllerId === controllerId).pop() || spells.pop();
      targets.push(pick ? { type: 'stack', id: pick.id } : null);
      continue;
    }
    if (kind === 'stackSpell') {
      // The topmost OPPONENT's spell this counterspell can legally counter
      // (any spell type — permanents included — subject to its own filter).
      let top = null;
      for (let i = game.stack.length - 1; i >= 0; i--) {
        const s = game.stack[i];
        if (s.controllerId !== controllerId && game.canCounterTarget(s, card)) { top = s; break; }
      }
      targets.push(top ? { type: 'stack', id: top.id } : null);
      continue;
    }
    targets.push(null);
  }
  return targets;
}

// Picks how to cast a hand card: { altCost: null } for its normal cost, {
// altCost: { kind, emergeVictimId? } } for an alternative cost, or null if
// it can't be cast at all right now. A strictly cheaper alternative
// (Spectacle, Surge, Prowl, Freerunning, Dash, Prototype) wins — Dash only
// in the first main phase, where its haste can still attack. Evoke only
// when the normal cost isn't affordable AND the card has an enters/leaves
// trigger worth having (Mulldrifter's draw). Emerge only by sacrificing a
// token or a small creature (power 2 or less).
function chooseCastWay(game, p, card) {
  const normal = game.affordability(p.id, card);
  const options = game.getCastOptions(p.id, card);
  const cmcOf = (cost) => totalCmc(parseManaCost(cost));
  const cheaper = options.filter(o => ['spectacle', 'surge', 'prowl', 'freerunning', 'dash', 'prototype', 'web-slinging'].includes(o.kind)
    && (o.kind !== 'web-slinging' || game.step === 'main2')
    && (o.kind !== 'dash' || game.step === 'main1')
    && cmcOf(o.manaCost) < (card.cmc || 0))
    .sort((x, y) => cmcOf(x.manaCost) - cmcOf(y.manaCost))[0];
  if (cheaper) return { altCost: { kind: cheaper.kind } };
  // Bestow: onto our best creature when we have one (it stays a creature
  // if that creature dies).
  if (options.some(o => o.kind === 'bestow') && p.battlefield.some(x => isCreature(game, x.card))) return { altCost: { kind: 'bestow' } };
  // Cleave: the full-text version whenever it's affordable. Offering: when
  // the normal cost isn't, sacrificing the weakest creature of the type.
  if (options.some(o => o.kind === 'cleave')) return { altCost: { kind: 'cleave' } };
  const offering = options.filter(o => o.kind === 'offering').sort((a, b) => game.effectivePower(game.findPermanent(a.emergeVictimId)) - game.effectivePower(game.findPermanent(b.emergeVictimId)))[0];
  if (offering && !normal) return { altCost: { kind: 'offering', emergeVictimId: offering.emergeVictimId } };
  // Awaken: the bigger version whenever it's affordable.
  if (options.some(o => o.kind === 'awaken')) return { altCost: { kind: 'awaken' } };
  // Overload: worth it when the sweep hits more of the opponent's
  // permanents than ours, and at least two of theirs.
  const overload = options.find(o => o.kind === 'overload');
  if (overload) {
    const text = (card.oracleText || '').toLowerCase();
    const type = (text.match(/target (creature|artifact|enchantment|nonland permanent|permanent|land)/) || [])[1];
    const theirsOnly = /you don'?t control/.test(text);
    const matches = (perm) => !type || type === 'permanent' || (type === 'nonland permanent' ? !isLand(game, perm.card) : game.hasTypeWord(perm.card, type));
    const theirs = game.opponentOf(p.id).battlefield.filter(matches).length;
    const ours = theirsOnly ? 0 : p.battlefield.filter(matches).length;
    if (theirs >= 2 && theirs > ours) return { altCost: { kind: 'overload' } };
  }
  // Mutate onto our best non-Human creature when it's cheaper than
  // casting normally, or the normal cost isn't affordable.
  const mutate = options.find(o => o.kind === 'mutate');
  if (mutate && (!normal || cmcOf(mutate.manaCost) <= (card.cmc || 0))) return { altCost: { kind: 'mutate', mutateTargetId: mutate.mutateTargetId } };
  const emerge = options.find(o => {
    const v = o.kind === 'emerge' && game.findPermanent(o.emergeVictimId);
    return v && (/\btoken\b/i.test(v.card.typeLine || '') || game.effectivePower(v) <= 2);
  });
  if (emerge && !normal) return { altCost: { kind: 'emerge', emergeVictimId: emerge.emergeVictimId } };
  if (normal) return { altCost: null };
  const evoke = options.find(o => o.kind === 'evoke');
  if (evoke && /when this creature (?:enters|leaves)/i.test((card.oracleText || '').split(card.name).join('this creature'))) return { altCost: { kind: 'evoke' } };
  const prototype = options.find(o => o.kind === 'prototype');
  if (prototype) return { altCost: { kind: 'prototype' } };
  // Impending: the cheap non-creature version when the full cost is out of reach.
  if (options.some(o => o.kind === 'impending')) return { altCost: { kind: 'impending' } };
  // Warp: a cheap cast now for the enters trigger (the creature is exiled
  // at end of turn and can be recast later) — only when the normal cost
  // isn't affordable and there's an ETB worth having, in main 1 so it can
  // also attack if it has haste.
  const warp = options.find(o => o.kind === 'warp');
  if (warp && /when this creature enters/i.test((card.oracleText || '').split(card.name).join('this creature'))) return { altCost: { kind: 'warp' } };
  return null;
}

export function takeAITurnAction(game) {
  if (game.gameOver) return;
  const p = game.priorityPlayer;
  if (!p.isAI) return;

  const isMyMainPhase = p.id === game.active.id && (game.step === 'main1' || game.step === 'main2') && game.stack.length === 0;

  if (isMyMainPhase) {
    if (!p.landPlayedThisTurn) {
      const land = p.hand.find(c => isLand(game, c));
      if (land) { game.playLand(p.id, land.instanceId); return; }
      // A modal double-faced card's land face (Pathways, the MDFC spell//land cycle).
      const mdfc = p.hand.find(c => game.landFaces(c).length);
      if (mdfc && game.playLandFace(p.id, mdfc.instanceId, game.landFaces(mdfc)[0].index)) return;
      // No land to play: a landcycler (Ash Barrens, the Plainscycling
      // cycle, ...) can go find one first, and the land drop then happens
      // on the very next action.
      const landcycler = p.hand.find(c => /land|plains|island|swamp|mountain|forest/.test(game.getCyclingAbility(c)?.searchType || '') && game.canCycle(p.id, c.instanceId));
      if (landcycler) { game.cycle(p.id, landcycler.instanceId); return; }
    }
    // Tap NON-LAND mana sources (Sol Ring, Llanowar Elves, ...) up front so
    // casting checks below see the full mana available this turn — the
    // payment planner only counts untapped lands directly, so anything else
    // has to be in the pool to count. Lands are deliberately left alone:
    // the planner already taps exactly the ones a payment needs, and
    // tapping them all here (as this used to) burned any mana the AI didn't
    // spend — the pool empties every step, and lands only untap in their
    // controller's own untap step, so they sat tapped through main 2 AND
    // the opponent's whole turn. That quietly broke both holding a creature
    // for main 2 and ever casting an instant on the opponent's turn
    // (Dimir Control cast zero off-turn spells across 8 games before this).
    for (const perm of p.battlefield) {
      if (perm.tapped || isLand(game, perm.card)) continue;
      game.getTapAbilities(perm).forEach((ability, idx) => {
        // One-shot sources (Treasure's "{T}, Sacrifice this artifact") are
        // NOT cracked up front — that threw a Treasure away every main
        // phase whether or not anything got cast. See crackOneShotManaFor.
        if (ability.isManaAbility && !ability.sacrificeCost && game.canActivateTapAbility(p.id, perm.id, idx)) {
          game.activateTapAbility(p.id, perm.id, idx, [], { silent: true });
        }
      });
    }
    // Cards exiled with a temporary play permission (Ragavan, Nimble
    // Pilferer; Nightveil Specter) expire at the end of this player's next
    // turn (see game.js's doCleanup) — play them opportunistically now,
    // same "otherwise it just sits unused" logic as equip/graveyard
    // abilities elsewhere in this file.
    for (const entry of [...p.exiledPlayable]) {
      const card = entry.card;
      if (isLand(game, card)) {
        if (p.landPlayedThisTurn || !game.canPlayLand(p.id)) continue;
        const result = game.playCardFromExile(p.id, entry.id);
        if (result.ok) return;
        continue;
      }
      // (canPlayFromExile also covers foretold/plotted/warped cards' own
      // costs and timing.)
      if (!game.canPlayFromExile(p.id, entry.id)) continue;
      const modal = game.getSpellModes(card);
      let modeIndexes = null;
      if (modal) {
        modeIndexes = pickModesFor(game, modal, card, p.id);
        if (!modeIndexes) continue;
      }
      const hasX = /\{X\}/i.test(card.manaCost || '') && !entry.free;
      const xValue = hasX ? game.maxAffordableX(p.id, card) : 0;
      if (hasX && xValue === 0) continue;
      const kinds = game.getRequiredTargetKinds(card, modeIndexes);
      const targets = pickTargetsForKinds(game, card, p.id, kinds).filter(Boolean);
      if (game.getMinRequiredTargetCount(card, modeIndexes) > targets.length) continue;
      const result = game.playCardFromExile(p.id, entry.id, { targets, xValue, modeIndexes });
      if (result.ok) return;
    }

    // Casting from the graveyard (Flashback, Escape, Jump-start, Retrace,
    // Mayhem) — a card sitting there is otherwise wasted value. Ways that
    // only cost mana come first; Escape (eats other graveyard cards) and
    // Jump-start (discards a real card) after; Retrace only by discarding
    // a land the AI can spare.
    const order = { flashback: 0, mayhem: 0, harmonize: 0, retrace: 1, escape: 2, jumpstart: 3 };
    const myLands = p.battlefield.filter(perm => isLand(game, perm.card)).length;
    for (const card of [...p.graveyard]) {
      const ways = game.getGraveyardCastWays(p.id, card.instanceId).sort((a, b) => order[a.via] - order[b.via]);
      for (const way of ways) {
        if (way.via === 'retrace' && myLands < 4) continue;
        if (way.via === 'jumpstart' && !game.discardFodder(p).some(c => isLand(game, c) && myLands >= 5)) continue;
        const viaEscape = way.via === 'escape';
        // Disturb / Aftermath cast a different face — target with that face.
        const castCard = way.face ? game.faceCard(card, way.face) : card;
        const modal = game.getSpellModes(castCard);
        let modeIndexes = null;
        if (modal) {
          modeIndexes = pickModesFor(game, modal, castCard, p.id);
          if (!modeIndexes) continue;
        }
        const kinds = game.getRequiredTargetKinds(castCard, modeIndexes);
        const targets = pickTargetsForKinds(game, castCard, p.id, kinds).filter(Boolean);
        if (game.getMinRequiredTargetCount(castCard, modeIndexes) > targets.length) continue;
        const result = game.castFromGraveyard(p.id, card.instanceId, { targets, modeIndexes, via: way.via, viaEscape });
        if (result.ok) return;
      }
    }

    // Commander format: get the commander down as soon as it's affordable
    // rather than waiting — a bot that never touches its own command zone
    // would never actually test the format.
    // (Each partner commander separately.)
    for (let ci = 0; ci < (p.commanders || []).length; ci++) {
      if (!game.canCastCommander(p.id, ci) || !game.affordabilityForCommander(p.id, ci)) continue;
      const commanderCard = p.commanders[ci].card;
      const targets = pickTargetsFor(game, commanderCard, p.id).filter(Boolean);
      if (game.getMinRequiredTargetCount(commanderCard) <= targets.length) {
        const result = game.castCommander(p.id, targets, 0, ci);
        if (result.ok) return;
      }
    }
    // Companion: put it into hand once there's spare mana and nothing better.
    if (game.step === 'main2' && game.canFetchCompanion(p.id) && game.fetchCompanion(p.id).ok) return;

    // Suspend: always for a card that can't be cast any other way
    // (Ancestral Vision), otherwise when the normal cost isn't affordable
    // yet but the suspend cost is, or when a short suspend is much cheaper
    // (Rift Bolt's suspend 1 for {R} instead of {2}{R}).
    for (const card of p.hand) {
      const info = game.getSuspendInfo(card);
      if (!info || !game.canSuspend(p.id, card.instanceId)) continue;
      const suspendCmc = totalCmc(parseManaCost(info.manaCost));
      const worthIt = !card.manaCost || !game.affordability(p.id, card) || (info.time <= 1 && suspendCmc < (card.cmc || 0));
      if (worthIt) { game.suspend(p.id, card.instanceId); return; }
    }

    // How to cast each card: its normal cost, or an alternative cost
    // (see chooseCastWay) — a card castable only through an alternative
    // (an evoked Mulldrifter, a prototyped Fleshgorger) is still playable.
    const castWays = new Map();
    for (const c of p.hand) {
      if (isLand(game, c) || !game.canCastSpell(p.id, c)) continue;
      const way = chooseCastWay(game, p, c);
      if (way) castWays.set(c, way);
    }
    // Nothing castable from lands and mana rocks alone? Sacrifice just
    // enough Treasures to cast the biggest spell they'd enable.
    if (crackOneShotManaFor(game, p, castWays)) return;
    // Storm spells go last, after everything else that can be cast this
    // turn has raised the count.
    const isStorm = (c) => /^(?:storm|gravestorm)\b/im.test((c.oracleText || '').replace(/\([^()]*\)/g, ''));
    // Casting by face: an Adventure first whenever it has a use (the
    // creature stays castable from exile afterward); otherwise a modal
    // card's back face, a split card's other half (or both, fused), or a
    // converted card — when the normal cast isn't available.
    for (const card of p.hand) {
      const opts = game.faceOptions(p.id, card).sort((a, b) => (b.kind === 'fuse') - (a.kind === 'fuse') || (b.card.cmc || 0) - (a.card.cmc || 0));
      for (const opt of opts) {
        if (opt.kind !== 'adventure' && opt.kind !== 'fuse' && castWays.has(card)) continue;
        if (opt.kind === 'convert' && castWays.has(card)) continue;
        const face = opt.card;
        const modal = game.getSpellModes(face);
        let modeIndexes = null;
        if (modal) { modeIndexes = pickModesFor(game, modal, face, p.id); if (!modeIndexes) continue; }
        const kinds = game.getRequiredTargetKinds(face, modeIndexes);
        const targets = pickTargetsForKinds(game, face, p.id, kinds).filter(Boolean);
        if (game.getMinRequiredTargetCount(face, modeIndexes) > targets.length) continue;
        if (game.castFace(p.id, card.instanceId, opt.kind, targets, 0, modeIndexes).ok) return;
      }
    }
    const playable = [...castWays.keys()].sort((a, b) => (isStorm(a) - isStorm(b)) || ((b.cmc || 0) - (a.cmc || 0)));
    for (const card of playable) {
      const altCost = castWays.get(card).altCost;
      // Bloodthirst only pays off once the opponent has been dealt damage
      // this turn — so before combat, hold the creature for the second main
      // phase instead of casting it as a vanilla body. Still cast it in
      // main 2 either way, damage or not.
      if (game.step === 'main1' && getBloodthirstAmount(card) > 0 && game.opponentOf(p.id).damageTakenThisTurn === 0) continue;
      const modal = game.getSpellModes(card);
      let modeIndexes = null;
      // Entwine: pay the extra cost and get every mode, when it's affordable
      // and every mode can actually find its targets. Decided before
      // targets are picked, since entwining changes which targets are needed.
      let entwine = false;
      if (modal && game.getEntwineCost(card) && game.canAffordKicked(p.id, card)) {
        const all = modal.modes.map((_, i) => i);
        const allKinds = game.getRequiredTargetKinds(card, all);
        const allTargets = pickTargetsForKinds(game, card, p.id, allKinds).filter(Boolean);
        if (game.getMinRequiredTargetCount(card, all) <= allTargets.length) { modeIndexes = all; entwine = true; }
      }
      // Teamwork: decided before modes, since it can mean "choose both".
      const teamworkNeed = game.getTeamworkAmount(card);
      const teamCrew = teamworkNeed ? game.teamworkCrew(p.id, teamworkNeed).filter(x => game.step !== 'main1' || !game.canDeclareAsAttacker(x)) : [];
      const useTeamwork = teamworkNeed > 0 && teamCrew.reduce((n, x) => n + game.effectivePower(x), 0) >= teamworkNeed;
      if (modal && modal.teamworkBoth && useTeamwork) {
        const all = modal.modes.map((_, i) => i);
        if (game.getMinRequiredTargetCount(card, all) <= pickTargetsForKinds(game, card, p.id, game.getRequiredTargetKinds(card, all)).filter(Boolean).length) { modeIndexes = all; entwine = true; }
      }
      if (modal && !entwine) {
        modeIndexes = pickModesFor(game, modal, card, p.id);
        if (!modeIndexes) continue; // no satisfiable combination of modes — skip this card
        // Escalate/Spree: extra modes cost extra — keep only as many as can
        // be paid for (an escalate discard only when the hand can spare it).
        // Tiered: the most expensive tier that's affordable and has targets.
        if (modal.tiered) {
          const ok = modal.modes.map((m, i) => i).filter(i => game.canAffordWithExtra(p.id, card, game.getModeExtraCost(card, [i])) && game.minRequiredTargetCount(modal.modes[i].steps) <= pickTargetsForKinds(game, card, p.id, game.expandTargetKinds(modal.modes[i].steps)).filter(Boolean).length);
          if (!ok.length) continue;
          modeIndexes = [ok[ok.length - 1]];
        }
        if (modal.spree || modal.escalate) {
          const kept = [];
          for (const i of modeIndexes) {
            const next = [...kept, i];
            if (modal.escalate === 'discard' && next.length > 1 && p.hand.length - 1 < next.length + 1) break;
            if (!game.canAffordWithExtra(p.id, card, game.getModeExtraCost(card, next))) continue;
            kept.push(i);
          }
          if (!kept.length) continue;
          modeIndexes = kept;
        }
      }
      // Choices made while casting that change what the spell does (and
      // so what it targets): promise a gift, bargain, kick.
      const kicked = game.getEntwineCost(card) ? entwine : game.canAffordKicked(p.id, card);
      const gift = !altCost && shouldPromiseGift(game, card);
      const bargainFodder = game.hasBargain(card) ? game.bargainCandidates(p.id).find(x => isTokenFodder(game, x)) : null;
      const flags = { kicked, gift, bargained: !!bargainFodder, overload: altCost?.kind === 'overload', teamwork: useTeamwork, bestow: altCost?.kind === 'bestow', cleave: altCost?.kind === 'cleave' };
      // An {X} spell cast at a hardcoded X=0 achieves nothing (Comet Storm-
      // style payoffs are the whole point of the card) — spend as much as
      // can actually be afforded instead, and skip the card entirely rather
      // than wasting it if X would still come out to 0.
      const hasX = /\{X\}/i.test(card.manaCost || '');
      const hasLifeX = hasLifePaymentXCost(card);
      let xValue = 0;
      if (hasX) {
        xValue = game.maxAffordableX(p.id, card);
        if (xValue === 0) continue;
      } else if (hasLifeX) {
        // A "pay X life" cost (Toxic Deluge) isn't tied to mana at all —
        // pick just enough to kill the opponent's toughest creature (the
        // whole point of a board-wipe-shaped card like this), capped by
        // how much life this player can safely spare.
        const opponent = game.opponentOf(p.id);
        const biggestToughness = Math.max(0, ...opponent.battlefield.filter(perm => isCreature(game, perm.card)).map(perm => game.effectiveToughness(perm)));
        xValue = Math.min(game.getMaxLifePaymentX(p.id), biggestToughness);
        if (xValue === 0) continue; // nothing worth killing, or can't afford to pay for it
      }
      const kinds = game.getRequiredTargetKinds(card, modeIndexes, flags);
      const targets = pickTargetsForKinds(game, card, p.id, kinds).filter(Boolean);
      if (game.getMinRequiredTargetCount(card, modeIndexes, flags) > targets.length) continue; // couldn't find enough legal targets
      // Kicker (decided above) is paid whenever affordable — a bot that never
      // pays optional costs would never exercise the payoff half of a Kicker
      // card. (An Entwine card's optional cost is entwine itself — only paid
      // when decided above, never just because it happens to be affordable.)
      const extras = altCost ? {} : chooseCastExtras(game, p, card, modeIndexes, kicked, { gift, bargainFodder });
      if (useTeamwork && !altCost) extras.teamwork = teamCrew.map(x => x.id);
      const result = game.castSpell(p.id, card.instanceId, targets, xValue, modeIndexes, kicked, { ...(altCost ? { altCost } : {}), extras });
      if (result.ok) return;
    }

    // Level up any Class enchantment whenever the next level is affordable
    // — otherwise a Class just sits at level 1 forever, which isn't what a
    // real player does with spare mana.
    for (const perm of p.battlefield) {
      if (game.canLevelUpClass(p.id, perm.id)) {
        const result = game.levelUpClass(p.id, perm.id);
        if (result.ok) return;
      }
    }

    // Vehicles / Mounts before combat: crew or saddle with creatures that
    // aren't attacking anyway (summoning sick first), when the Vehicle hits
    // harder than its crew. Spacecraft: station in main 2 with what's left.
    // Reconfigure: put an Equipment creature on our biggest creature.
    for (const perm of p.battlefield) {
      if (game.step === 'main1' && game.canCrew(p.id, perm.id)) {
        const crew = game.crewPick(p.id, perm, game.keywordAmount(perm.card, 'crew'));
        const crewPower = crew.filter(x => !x.summoningSick).reduce((n, x) => n + game.effectivePower(x), 0);
        if ((parseInt((perm._baseCard || perm.card).power, 10) || 0) > crewPower && !perm.summoningSick && game.crew(p.id, perm.id).ok) return;
      }
      if (game.step === 'main1' && game.canSaddle(p.id, perm.id) && game.canDeclareAsAttacker(perm)) {
        const crew = game.crewPick(p.id, perm, game.keywordAmount(perm.card, 'saddle'));
        if (crew.every(x => x.summoningSick || game.effectivePower(x) <= 1) && game.saddle(p.id, perm.id).ok) return;
      }
      if (game.step === 'main2' && game.canStation(p.id, perm.id) && game.station(p.id, perm.id).ok) return;
      if (game.step === 'main1' && !perm.attachedTo && game.canReconfigure(p.id, perm.id)) {
        const host = p.battlefield.filter(x => x.id !== perm.id && isCreature(game, x.card)).sort((a, b) => game.effectivePower(b) - game.effectivePower(a))[0];
        if (host && game.effectivePower(host) >= 3 && game.reconfigure(p.id, perm.id, host.id).ok) return;
      }
    }

    // Channel (and other "discard this card:" abilities) in main 2, for a
    // card we can't cast anyway; Renew from the graveyard.
    if (game.step === 'main2') {
      const landsNow = p.battlefield.filter(x => isLand(game, x.card)).length;
      for (const card of p.hand) {
        const abs = game.getHandAbilities(card);
        for (let i = 0; i < abs.length; i++) {
          if (abs[i].attackingTarget || !game.canActivateHandAbility(p.id, card.instanceId, i)) continue;
          if (game.affordability(p.id, card) && (card.cmc || 0) <= landsNow) continue;
          const kinds = game.expandTargetKinds(abs[i].steps);
          const targets = pickTargetsForKinds(game, card, p.id, kinds).filter(Boolean);
          if (game.minRequiredTargetCount(abs[i].steps) > targets.length) continue;
          if (game.activateHandAbility(p.id, card.instanceId, i, targets).ok) return;
        }
      }
      for (const card of [...p.graveyard]) {
        const r = game.getRenew(card);
        if (!r || !game.canRenew(p.id, card.instanceId)) continue;
        const targets = pickTargetsForKinds(game, card, p.id, game.expandTargetKinds(r.steps)).filter(Boolean);
        if (game.minRequiredTargetCount(r.steps) > targets.length) continue;
        if (game.renew(p.id, card.instanceId, targets).ok) return;
      }
    }

    // Level up Leveler creatures with spare mana in main 2.
    if (game.step === 'main2') {
      for (const perm of p.battlefield) if (game.getLevelUp(perm._baseCard || perm.card) && game.canLevelUp(p.id, perm.id) && game.levelUp(p.id, perm.id).ok) return;
    }

    // Craft whenever possible (the back face is the payoff).
    for (const perm of p.battlefield) {
      if (game.getCraft(perm._dfcCard || perm.card) && game.canCraft(p.id, perm.id) && game.craft(p.id, perm.id).ok) return;
    }

    // Fortify: attach an unattached Fortification to a land.
    for (const perm of p.battlefield) {
      if (perm.attachedTo || !game.getFortifyCost(perm.card) || !game.canFortify(p.id, perm.id)) continue;
      const land = p.battlefield.find(x => isLand(game, x.card));
      if (land && game.fortify(p.id, perm.id, land.id).ok) return;
    }

    // Equip our best creature with any Equipment sitting unused (or
    // attached somewhere worse) — otherwise Equipment on the battlefield
    // just sits there doing nothing, which isn't what a real player does.
    const myCreatures = p.battlefield.filter(perm => isCreature(game, perm.card));
    if (myCreatures.length > 0) {
      const best = myCreatures.sort((a, b) => game.effectivePower(b) - game.effectivePower(a))[0];
      for (const perm of p.battlefield) {
        if (!game.getEquipCost(perm) || perm.attachedTo === best.id) continue;
        if (!game.canActivateEquip(p.id, perm.id) || !game.affordabilityForEquip(p.id, perm)) continue;
        const result = game.activateEquip(p.id, perm.id, best.id);
        if (result.ok) return;
      }
    }

    // Non-tap activated abilities (a flat mana cost, or "sacrifice a
    // creature") — same idea as equip above, otherwise these just sit
    // unused. Sacrifice-cost ones only fire with a creature to spare (2+
    // on board), so the bot doesn't sac its last blocker for value.
    for (const perm of p.battlefield) {
      const abilities = game.getNonTapAbilities(perm);
      for (let i = 0; i < abilities.length; i++) {
        const ability = abilities[i];
        if (isFullyUnsupportedSteps(ability.steps)) continue; // no point activating a no-op
        // Transfigure only into something bigger; Aura swap only for a
        // pricier Aura from hand.
        if (ability.steps.some(s => s.kind === 'phase')) continue; // phasing ourselves out is defensive, not for random use
        if (ability.transfigure && !p.library.some(c => isCreature(game, c) && (c.cmc || 0) === (perm.card.cmc || 0) && (parseInt(c.power, 10) || 0) > game.effectivePower(perm))) continue;
        if (ability.auraSwap && !p.hand.some(c => isAura(game, c) && (c.cmc || 0) > (perm.card.cmc || 0))) continue;
        if (ability.sacrifice && p.battlefield.filter(x => isCreature(game, x.card)).length < 2) continue;
        if (!isWorthwhilePayToUntap(game, perm, ability)) continue;
        if (!game.canActivateNonTapAbility(p.id, perm.id, i)) continue;
        const kinds = game.getRequiredTargetKindsForNonTapAbility(perm, i);
        const targets = pickTargetsForKinds(game, perm.card, p.id, kinds).filter(Boolean);
        if (game.getMinRequiredTargetCountForNonTapAbility(perm, i) > targets.length) continue;
        const result = game.activateNonTapAbility(p.id, perm.id, i, targets);
        if (result.ok) return;
      }
    }

    // Non-mana tap abilities (Icy Manipulator, Prodigal Pyromancer, a
    // fetchland, Food, Outlast, ...). Mana abilities are already tapped up
    // front above; before this, nothing else ever used a {T} ability, so
    // every one of these was inert in the AI's hands. A creature's own tap
    // ability waits for the second main phase, so using it never costs an
    // attack; anything else fires whenever it's affordable. No loop risk —
    // a tapped permanent can't activate again until it untaps.
    for (const perm of p.battlefield) {
      if (perm.tapped) continue;
      if (isCreature(game, perm.card) && game.step !== 'main2') continue;
      const abilities = game.getTapAbilities(perm);
      for (let i = 0; i < abilities.length; i++) {
        const ability = abilities[i];
        if (ability.isManaAbility || isFullyUnsupportedSteps(ability.steps)) continue;
        if (!game.canActivateTapAbility(p.id, perm.id, i)) continue;
        const kinds = game.getRequiredTargetKindsForAbility(perm, i);
        const targets = pickTargetsForKinds(game, perm.card, p.id, kinds, perm.id).filter(Boolean);
        if (game.getMinRequiredTargetCountForAbility(perm, i) > targets.length) continue;
        const result = game.activateTapAbility(p.id, perm.id, i, targets);
        if (result.ok) return;
      }
    }

    // Planeswalker loyalty abilities — once per planeswalker per turn.
    // Prefers the most powerful safely-affordable ability (most negative
    // cost first, since a planeswalker's biggest, most game-swinging
    // ability is usually its last-listed "ultimate"), falling back to a
    // loyalty-building "+" ability to protect it for future turns when the
    // ultimate isn't affordable yet.
    for (const perm of p.battlefield) {
      const abilities = game.getLoyaltyAbilities(perm);
      if (abilities.length === 0) continue;
      const order = abilities
        .map((ability, i) => ({ ability, i }))
        .filter(({ ability }) => !isFullyUnsupportedSteps(ability.steps))
        .sort((a, b) => a.ability.cost - b.ability.cost);
      for (const { ability, i } of order) {
        if (!game.canActivateLoyaltyAbility(p.id, perm.id, i)) continue;
        const kinds = game.getRequiredTargetKindsForLoyaltyAbility(perm, i);
        const targets = pickTargetsForKinds(game, perm.card, p.id, kinds).filter(Boolean);
        if (game.getMinRequiredTargetCountForLoyaltyAbility(perm, i) > targets.length) continue;
        const result = game.activateLoyaltyAbility(p.id, perm.id, i, targets);
        if (result.ok) return;
      }
    }

    // Graveyard-activated abilities (Reassembling Skeleton's own recursion,
    // ...) — bring back a body if there's mana to spare, same "otherwise it
    // just sits unused" logic as equip/non-tap abilities above.
    for (const entry of game.getGraveyardAbilities(p.id)) {
      // An unearthed creature is exiled at this turn's end step, so its
      // whole value is attacking this turn — after combat it's pure waste.
      if ((entry.abilities[0].unearth || entry.abilities[0].encore) && game.step !== 'main1') continue;
      if (!game.canActivateGraveyardAbility(p.id, entry.card.instanceId)) continue;
      // Scavenge: grow our own biggest creature; never feed the opponent's.
      let targets = [];
      if (entry.abilities[0].scavenge) {
        const own = p.battlefield.filter(perm => isCreature(game, perm.card));
        if (own.length === 0) continue;
        const best = own.sort((a, b) => game.effectivePower(b) - game.effectivePower(a))[0];
        targets = [{ type: 'permanent', id: best.id }];
      }
      const result = game.activateGraveyardAbility(p.id, entry.card.instanceId, targets);
      if (result.ok) return;
    }

    // Face-down: turn a face-down creature up whenever affordable (main 1
    // first, so it attacks as the real thing); cast a morph/disguise card
    // face down when its normal cost is out of reach but {3} isn't.
    for (const perm of p.battlefield) {
      if (perm.faceDown && game.canTurnFaceUp(p.id, perm.id) && game.turnFaceUp(p.id, perm.id).ok) return;
    }
    for (const card of p.hand) {
      if (game.getFaceDownCost(card) && !game.affordability(p.id, card) && game.canCastFaceDown(p.id, card.instanceId)) {
        if (game.castFaceDown(p.id, card.instanceId).ok) return;
      }
    }

    // Foretell / Plot with mana left over after everything above (nothing
    // else got cast): set up a cheaper (foretell) or free (plot) cast for a
    // later turn. Only in main 2, so main 1 mana goes to real spells first.
    if (game.step === 'main2') {
      for (const card of p.hand) {
        const foretell = game.getForetellCost(card);
        if (foretell && game.canForetell(p.id, card.instanceId) && totalCmc(parseManaCost(foretell)) <= (card.cmc || 0)) {
          if (game.foretell(p.id, card.instanceId).ok) return;
        }
        if (game.getPlotCost(card) && game.canPlot(p.id, card.instanceId)) {
          if (game.plot(p.id, card.instanceId).ok) return;
        }
      }
    }

    // Reinforce: a spare land (with plenty already in play) or a creature
    // card too expensive to cast soon becomes +1/+1 counters on our best
    // creature.
    {
      const lands = p.battlefield.filter(perm => isLand(game, perm.card)).length;
      const best = p.battlefield.filter(perm => isCreature(game, perm.card)).sort((a, b) => game.effectivePower(b) - game.effectivePower(a))[0];
      for (const card of best ? p.hand : []) {
        if (!game.getReinforce(card) || !game.canReinforce(p.id, card.instanceId)) continue;
        const spare = isLand(game, card) ? lands >= 5 : (card.cmc || 0) > lands + 2;
        if (spare && game.reinforce(p.id, card.instanceId, best.id).ok) return;
      }
    }

    // Cycle away dead cards with mana left over after everything above: a
    // cycling land once there's plenty of mana already, or a spell still far
    // too expensive to cast any time soon. Landcyclers are kept for the
    // land-drop branch at the top instead.
    const landCount = p.battlefield.filter(perm => isLand(game, perm.card)).length;
    for (const card of p.hand) {
      const cycling = game.getCyclingAbility(card);
      if (!cycling || cycling.searchType) continue;
      const dead = isLand(game, card) ? landCount >= 6 : (card.cmc || 0) > landCount + 3;
      if (dead && game.canCycle(p.id, card.instanceId)) { game.cycle(p.id, card.instanceId); return; }
    }

    game.pass(p.id);
    return;
  }

  // Ninjutsu window: after blockers are locked in (this engine's own
  // declareBlockers step re-opens priority right where real Ninjutsu is
  // actually usable), the ATTACKING player may swap an unblocked attacker
  // for a Ninja from hand. Prefers the highest-CMC (most impactful) Ninja
  // affordable right now, returning the WEAKEST unblocked attacker to
  // preserve as much of this combat's own damage as possible.
  if (p.id === game.active.id && game.step === 'declareBlockers' && game.stack.length === 0) {
    const unblockedAttackers = p.battlefield.filter(perm => perm.attacking && perm.blockedBy.length === 0);
    // Bloodrush: pump an unblocked attacker (biggest first) with a hand card.
    if (unblockedAttackers.length) {
      const target = unblockedAttackers.slice().sort((a, b) => game.effectivePower(b) - game.effectivePower(a))[0];
      for (const card of p.hand) {
        const abs = game.getHandAbilities(card);
        const i = abs.findIndex(ab => ab.attackingTarget);
        if (i >= 0 && game.canActivateHandAbility(p.id, card.instanceId, i) && game.activateHandAbility(p.id, card.instanceId, i, [{ type: 'permanent', id: target.id }]).ok) return;
      }
    }
    // Sneak: swap the weakest unblocked attacker for a sneak card — a
    // creature that hits harder, or a spell worth casting cheaply.
    for (const card of p.hand) {
      const opt = game.getCastOptions(p.id, card).find(o => o.kind === 'sneak');
      if (!opt) continue;
      const back = game.findPermanent(opt.returnId);
      if (isCreature(game, card) && (parseInt(card.power, 10) || 0) <= game.effectivePower(back)) continue;
      const kinds = game.getRequiredTargetKinds(card);
      const targets = pickTargetsForKinds(game, card, p.id, kinds).filter(Boolean);
      if (game.getMinRequiredTargetCount(card) > targets.length) continue;
      if (game.castSpell(p.id, card.instanceId, targets, 0, null, false, { altCost: { kind: 'sneak' } }).ok) return;
    }
    if (unblockedAttackers.length > 0) {
      const ninjas = p.hand.filter(c => game.getNinjutsuCost(c)).sort((a, b) => (b.cmc || 0) - (a.cmc || 0));
      const weakestAttacker = unblockedAttackers.slice().sort((a, b) => game.effectivePower(a) - game.effectivePower(b))[0];
      for (const ninja of ninjas) {
        if (game.canActivateNinjutsu(p.id, ninja.instanceId, weakestAttacker.id)) {
          const result = game.activateNinjutsu(p.id, ninja.instanceId, weakestAttacker.id);
          if (result.ok) return;
        }
      }
    }
  }

  // Instant-speed window (including opponent's turn): consider reactive plays.
  if (game.step !== 'declareAttackers' && game.step !== 'declareBlockers') {
    const instants = p.hand.filter(c => /instant/i.test(c.typeLine) && game.canCastSpell(p.id, c) && game.affordability(p.id, c));
    for (const card of instants) {
      const text = (card.oracleText || '').toLowerCase();
      // Any counterspell (Counterspell, Negate, Essence Scatter, Muddle the
      // Mixture, ...) that has a legal opposing spell to counter — this used
      // to recognize only the exact words "counter target spell", and only
      // against instants/sorceries.
      const wantsToCounter = /counter target (?:[\w\s,-]+? )?spell/.test(text) && game.stack.some(s => s.controllerId !== p.id && game.canCounterTarget(s, card));
      // Includes X-based damage ("deals twice X damage to target creature")
      // alongside the plain-digit case — otherwise an X-payoff removal
      // spell like Khaaaaaaaaaaaannn! is never even considered as removal.
      const isRemoval = /destroy target creature|deals? (?:\d+|x|twice x) damage to target creature/.test(text);
      const opponentHasBigThreat = game.opponentOf(p.id).battlefield
        .some(perm => isCreature(game, perm.card) && game.effectivePower(perm) >= 3);
      if (wantsToCounter || (isRemoval && opponentHasBigThreat)) {
        const hasX = /\{X\}/i.test(card.manaCost || '');
        const xValue = hasX ? game.maxAffordableX(p.id, card) : 0;
        if (hasX && xValue === 0) continue;
        const targets = pickTargetsFor(game, card, p.id).filter(Boolean);
        if (game.getMinRequiredTargetCount(card) > targets.length) continue;
        const result = game.castSpell(p.id, card.instanceId, targets, xValue);
        if (result.ok) return;
      }
    }
  }

  // End of the opponent's turn: any mana still untapped is about to go to
  // waste, so this is the classic moment to cycle. Looser than the
  // main-phase rule since nothing else competes for this mana — cycle a
  // spell that won't be castable next turn even after a land drop, a
  // cycling land once there's plenty of mana, or a landcycler while still
  // short on lands.
  if (game.step === 'end' && game.active.id !== p.id && game.stack.length === 0) {
    const landCount = p.battlefield.filter(perm => isLand(game, perm.card)).length;
    for (const card of p.hand) {
      const cycling = game.getCyclingAbility(card);
      if (!cycling || !game.canCycle(p.id, card.instanceId)) continue;
      const isLandcycler = /land|plains|island|swamp|mountain|forest/.test(cycling.searchType || '');
      const worthIt = isLandcycler ? landCount < 5
        : cycling.searchType ? false
        : isLand(game, card) ? landCount >= 6
        : (card.cmc || 0) > landCount + 1;
      if (worthIt) { game.cycle(p.id, card.instanceId); return; }
    }
  }

  game.pass(p.id);
}

export function aiDeclareAttackers(game) {
  const p = game.active;
  const opponent = game.opponentOf(p.id);
  const myCreatures = p.battlefield.filter(perm => isCreature(game, perm.card) && game.canDeclareAsAttacker(perm) && !perm.tapped);
  const theirBlockers = opponent.battlefield.filter(perm => isCreature(game, perm.card));

  const attackers = myCreatures.filter(perm => {
    const power = game.effectivePower(perm);
    const kws = game.effectiveKeywords(perm);
    // A 0-power creature only attacks for its trigger (Battle cry pumps
    // everyone else), and only if it won't just die for nothing.
    if (power <= 0 && !kws.has('battle cry')) return false;
    // Only creatures that could LEGALLY block this attacker matter — every
    // evasion rule (flying, fear, intimidate, landwalk, protection) and
    // tapped blockers come from game.canBlockAttacker, the same check the
    // engine enforces. No legal blocker at all means it's effectively
    // unblockable this turn; menace needs two.
    const legalBlockers = theirBlockers.filter(b => game.canBlockAttacker(b, perm));
    if (legalBlockers.length === 0) return true;
    if ((kws.has('menace') || game.getBlockRestrictions(perm).minBlockers >= 2) && legalBlockers.length < 2) return true;
    if (power <= 0) return legalBlockers.every(b => game.effectivePower(b) <= 0);
    const canBeKilledForFree = legalBlockers.some(b => game.effectivePower(b) >= game.effectiveToughness(perm) && game.effectiveToughness(b) > power);
    return !canBeKilledForFree;
  });

  // Send just enough attackers at the opponent's cheapest-to-kill
  // planeswalker to finish it off, UNLESS the full attack is already
  // lethal on the player — winning outright always beats trading for
  // value. A simple, not-fully-optimal greedy allocation (biggest attacker
  // first) rather than an exact subset-sum, matching this engine's
  // "reasonable heuristic over perfect play" approach everywhere else.
  const attackTargets = {};
  const theirPlaneswalkers = opponent.battlefield.filter(perm => game.isPlaneswalker(perm.card));
  const totalAttackPower = attackers.reduce((sum, a) => sum + game.effectivePower(a), 0);
  const isLethalOnPlayer = totalAttackPower >= opponent.life;
  if (theirPlaneswalkers.length > 0 && !isLethalOnPlayer) {
    const target = theirPlaneswalkers.sort((a, b) => (a.counters.loyalty || 0) - (b.counters.loyalty || 0))[0];
    const loyalty = target.counters.loyalty || 0;
    let assigned = 0;
    for (const a of attackers.slice().sort((a, b) => game.effectivePower(b) - game.effectivePower(a))) {
      if (assigned >= loyalty) break;
      attackTargets[a.id] = target.id;
      assigned += game.effectivePower(a);
    }
  }

  game.declareAttackers(p.id, attackers.map(a => a.id), attackTargets);
}

export function aiDeclareBlockers(game) {
  const p = game.defender;
  const attackers = game.active.battlefield.filter(perm => perm.attacking);
  const myBlockers = p.battlefield.filter(perm => isCreature(game, perm.card) && !perm.tapped && !game.effectiveKeywords(perm).has('cantBlock'));

  const blockMap = [];
  const used = new Set();
  const sortedAttackers = attackers.slice().sort((a, b) => game.effectivePower(b) - game.effectivePower(a));

  for (const attacker of sortedAttackers) {
    // Every per-pair restriction (flying, fear, intimidate, landwalk,
    // protection) lives in game.canBlockAttacker — including for chump
    // blocks, which used to skip legality entirely.
    const legal = myBlockers.filter(b => !used.has(b.id) && game.canBlockAttacker(b, attacker));
    const mustChump = p.life - game.effectivePower(attacker) <= 4;

    // Menace (or "can't be blocked except by two or more creatures"): two
    // blockers or none at all.
    if (game.effectiveKeywords(attacker).has('menace') || game.getBlockRestrictions(attacker).minBlockers >= 2) {
      if (legal.length < 2) continue;
      const pair = legal.slice().sort((a, b) => game.effectivePower(b) - game.effectivePower(a)).slice(0, 2);
      const kills = pair.reduce((s, b) => s + game.effectivePower(b), 0) >= game.effectiveToughness(attacker);
      if (kills || mustChump) {
        for (const b of pair) { used.add(b.id); blockMap.push({ blockerId: b.id, attackerId: attacker.id }); }
      }
      continue;
    }

    const candidate = legal.find(b => game.effectivePower(b) >= game.effectiveToughness(attacker) || game.effectiveToughness(b) > game.effectivePower(attacker));
    const chosen = candidate || (mustChump ? legal[0] : null);
    if (chosen) {
      used.add(chosen.id);
      blockMap.push({ blockerId: chosen.id, attackerId: attacker.id });
    }
  }

  game.declareBlockers(p.id, blockMap);
}
