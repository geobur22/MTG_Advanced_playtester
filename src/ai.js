// A heuristic (non-learning) bot. It plays lands, casts what it can afford,
// attacks when it's ahead or safe, blocks to avoid unnecessary damage/losses,
// and will fire off removal/burn at instant speed when it clearly helps.

import { isFullyUnsupported as isFullyUnsupportedSteps, hasLifePaymentXCost } from './effects.js';

function isCreature(g, card) { return g.isCreature(card); }
function isLand(g, card) { return g.isLand(card); }
function isAura(g, card) { return g.isAura(card); }

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

function pickTargetsFor(game, card, controllerId, modeIndexes = null) {
  return pickTargetsForKinds(game, card, controllerId, game.getRequiredTargetKinds(card, modeIndexes));
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
    if (kind === 'player' ) { targets.push({ type: 'player', id: opponent.id }); continue; }
    if (kind === 'creatureOrPlayer' || kind === 'creature') {
      // "Fights" (Fight — Territorial Allosaurus, Prey Upon, ...) is
      // removal-shaped for targeting purposes even though it neither deals
      // damage nor destroys directly: the whole point is to pick the best
      // enemy creature to trade into, same as burn/destroy.
      const isRemoval = /deal|destroy|-\d+\/-\d+|fights?\b/i.test(card.oracleText || '');
      const enemyCreatures = opponent.battlefield.filter(p => isCreature(game, p.card) && game.canBeTargetedBy(p, controllerId) && !usedIds.has(p.id));
      // "Any target"/"creature or player" (kind 'creatureOrPlayer' only —
      // bare 'creature' never includes them) can legally hit a planeswalker
      // in real rules text too. Worth considering for removal/damage:
      // finishing off a low-loyalty planeswalker is often the best use of
      // a burn spell, so ties are broken toward whichever's lowest loyalty.
      const enemyPlaneswalkers = kind === 'creatureOrPlayer'
        ? opponent.battlefield.filter(p => game.isPlaneswalker(p.card) && game.canBeTargetedBy(p, controllerId) && !usedIds.has(p.id))
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
        const own = game.getPlayer(controllerId).battlefield.filter(p => isCreature(game, p.card) && game.canBeTargetedBy(p, controllerId) && !usedIds.has(p.id));
        if (own.length > 0) { targets.push({ type: 'permanent', id: own[0].id }); usedIds.add(own[0].id); }
        else targets.push({ type: 'player', id: opponent.id });
      }
      continue;
    }
    if (kind === 'planeswalker') {
      const enemyPlaneswalkers = opponent.battlefield.filter(p => game.isPlaneswalker(p.card) && game.canBeTargetedBy(p, controllerId) && !usedIds.has(p.id));
      if (enemyPlaneswalkers.length > 0) {
        const chosen = enemyPlaneswalkers.sort((a, b) => (a.counters.loyalty || 0) - (b.counters.loyalty || 0))[0];
        targets.push({ type: 'permanent', id: chosen.id });
        usedIds.add(chosen.id);
      } else {
        targets.push(null);
      }
      continue;
    }
    if (kind === 'permanent') {
      const preferOpponent = wantsOpponentPermanent(game, card);
      const primaryPool = (preferOpponent ? opponent : game.getPlayer(controllerId)).battlefield.filter(p => isCreature(game, p.card) && game.canBeTargetedBy(p, controllerId) && !usedIds.has(p.id));
      if (primaryPool.length > 0) {
        const chosen = primaryPool.sort((a, b) => game.effectivePower(b) - game.effectivePower(a))[0];
        targets.push({ type: 'permanent', id: chosen.id });
        usedIds.add(chosen.id);
      } else {
        // No legal creature in the preferred pool (e.g. a removal aura but
        // the opponent has no creatures yet) — fall back to the other side
        // rather than skip a castable spell entirely.
        const fallbackPool = (preferOpponent ? game.getPlayer(controllerId) : opponent).battlefield.filter(p => isCreature(game, p.card) && game.canBeTargetedBy(p, controllerId) && !usedIds.has(p.id));
        if (fallbackPool.length > 0) { targets.push({ type: 'permanent', id: fallbackPool[0].id }); usedIds.add(fallbackPool[0].id); }
        else targets.push(null);
      }
      continue;
    }
    if (kind === 'stackSpell') {
      let top = null;
      for (let i = game.stack.length - 1; i >= 0; i--) {
        const s = game.stack[i];
        if (!s.isPermanentSpell && !s.isAura) { top = s; break; }
      }
      targets.push(top ? { type: 'stack', id: top.id } : null);
      continue;
    }
    targets.push(null);
  }
  return targets;
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
    }
    // Tap any available mana-producing abilities up front so casting checks
    // below see the full mana we could have available this turn.
    for (const perm of p.battlefield) {
      if (perm.tapped) continue;
      game.getTapAbilities(perm).forEach((ability, idx) => {
        if (ability.isManaAbility && game.canActivateTapAbility(p.id, perm.id, idx)) {
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
      if (!game.canCastSpell(p.id, card) || !game.affordability(p.id, card)) continue;
      const modal = game.getSpellModes(card);
      let modeIndexes = null;
      if (modal) {
        modeIndexes = pickModesFor(game, modal, card, p.id);
        if (!modeIndexes) continue;
      }
      const hasX = /\{X\}/i.test(card.manaCost || '');
      const xValue = hasX ? game.maxAffordableX(p.id, card) : 0;
      if (hasX && xValue === 0) continue;
      const kinds = game.getRequiredTargetKinds(card, modeIndexes);
      const targets = pickTargetsForKinds(game, card, p.id, kinds).filter(Boolean);
      if (game.getMinRequiredTargetCount(card, modeIndexes) > targets.length) continue;
      const result = game.playCardFromExile(p.id, entry.id, { targets, xValue, modeIndexes });
      if (result.ok) return;
    }

    // Flashback/Escape — a card sitting in the graveyard with either cost
    // is otherwise permanently wasted value once it's died/been cast
    // normally, so try both (Escape checked second since it also consumes
    // other graveyard cards, a real cost Flashback doesn't have).
    for (const card of [...p.graveyard]) {
      for (const viaEscape of [false, true]) {
        if (!game.canCastFromGraveyard(p.id, card.instanceId, { viaEscape })) continue;
        const modal = game.getSpellModes(card);
        let modeIndexes = null;
        if (modal) {
          modeIndexes = pickModesFor(game, modal, card, p.id);
          if (!modeIndexes) continue;
        }
        const kinds = game.getRequiredTargetKinds(card, modeIndexes);
        const targets = pickTargetsForKinds(game, card, p.id, kinds).filter(Boolean);
        if (game.getMinRequiredTargetCount(card, modeIndexes) > targets.length) continue;
        const result = game.castFromGraveyard(p.id, card.instanceId, { targets, modeIndexes, viaEscape });
        if (result.ok) return;
      }
    }

    // Commander format: get the commander down as soon as it's affordable
    // rather than waiting — a bot that never touches its own command zone
    // would never actually test the format.
    if (game.canCastCommander(p.id) && game.affordabilityForCommander(p.id)) {
      const commanderCard = p.commander;
      const targets = pickTargetsFor(game, commanderCard, p.id).filter(Boolean);
      if (game.getMinRequiredTargetCount(commanderCard) <= targets.length) {
        const result = game.castCommander(p.id, targets);
        if (result.ok) return;
      }
    }

    const playable = p.hand
      .filter(c => !isLand(game, c) && game.canCastSpell(p.id, c) && game.affordability(p.id, c))
      .sort((a, b) => (b.cmc || 0) - (a.cmc || 0));
    for (const card of playable) {
      const modal = game.getSpellModes(card);
      let modeIndexes = null;
      if (modal) {
        modeIndexes = pickModesFor(game, modal, card, p.id);
        if (!modeIndexes) continue; // no satisfiable combination of modes — skip this card
      }
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
      const kinds = game.getRequiredTargetKinds(card, modeIndexes);
      const targets = pickTargetsForKinds(game, card, p.id, kinds).filter(Boolean);
      if (game.getMinRequiredTargetCount(card, modeIndexes) > targets.length) continue; // couldn't find enough legal targets
      // Opt into Kicker (Territorial Allosaurus, etc.) whenever the extra
      // cost is affordable — a bot that never pays optional costs would
      // never actually exercise the payoff half of a Kicker card.
      const kicked = game.canAffordKicked(p.id, card);
      const result = game.castSpell(p.id, card.instanceId, targets, xValue, modeIndexes, kicked);
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
        if (ability.sacrifice && p.battlefield.filter(x => isCreature(game, x.card)).length < 2) continue;
        if (!game.canActivateNonTapAbility(p.id, perm.id, i)) continue;
        const kinds = game.getRequiredTargetKindsForNonTapAbility(perm, i);
        const targets = pickTargetsForKinds(game, perm.card, p.id, kinds).filter(Boolean);
        if (game.getMinRequiredTargetCountForNonTapAbility(perm, i) > targets.length) continue;
        const result = game.activateNonTapAbility(p.id, perm.id, i, targets);
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
      if (!game.canActivateGraveyardAbility(p.id, entry.card.instanceId)) continue;
      const result = game.activateGraveyardAbility(p.id, entry.card.instanceId);
      if (result.ok) return;
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
      const wantsToCounter = text.includes('counter target spell') && game.stack.some(s => s.controllerId !== p.id && !s.isPermanentSpell);
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

  game.pass(p.id);
}

export function aiDeclareAttackers(game) {
  const p = game.active;
  const opponent = game.opponentOf(p.id);
  const myCreatures = p.battlefield.filter(perm => isCreature(game, perm.card) && game.canDeclareAsAttacker(perm) && !perm.tapped);
  const theirBlockers = opponent.battlefield.filter(perm => isCreature(game, perm.card));

  const attackers = myCreatures.filter(perm => {
    const power = game.effectivePower(perm);
    if (power <= 0) return false;
    const kws = game.effectiveKeywords(perm);
    if (theirBlockers.length === 0) return true;
    // Attack if it's evasive, or if trading favorably/we outnumber their blockers.
    if (kws.has('flying') && !theirBlockers.some(b => game.effectiveKeywords(b).has('flying') || game.effectiveKeywords(b).has('reach'))) return true;
    const canBeKilledForFree = theirBlockers.some(b => game.effectivePower(b) >= game.effectiveToughness(perm) && game.effectiveToughness(b) > power);
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
    const kws = game.effectiveKeywords(attacker);
    const candidate = myBlockers.find(b => {
      if (used.has(b.id)) return false;
      const bKws = game.effectiveKeywords(b);
      if (kws.has('flying') && !bKws.has('flying') && !bKws.has('reach')) return false;
      const trade = game.effectivePower(b) >= game.effectiveToughness(attacker) || game.effectiveToughness(b) > game.effectivePower(attacker);
      return trade;
    });
    if (candidate) {
      used.add(candidate.id);
      blockMap.push({ blockerId: candidate.id, attackerId: attacker.id });
    } else if (p.life - game.effectivePower(attacker) <= 4) {
      // chump block if it's needed to survive
      const chump = myBlockers.find(b => !used.has(b.id));
      if (chump) {
        used.add(chump.id);
        blockMap.push({ blockerId: chump.id, attackerId: attacker.id });
      }
    }
  }

  game.declareBlockers(p.id, blockMap);
}
