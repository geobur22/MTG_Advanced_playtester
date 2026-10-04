// A lightweight interpreter for common spell and ability effects. Magic has
// thousands of unique cards with bespoke rules text, and fully implementing
// all of them is out of scope here — instead this recognizes the most common
// effect patterns (damage, removal, draw, pump, counter, lifegain, mana) so a
// real, classic-constructed-style deck is playable. Anything the patterns
// below don't recognize falls back to an offline-precomputed AI
// interpretation if one is loaded (see aiAdapter.js), and otherwise resolves
// as a no-op with a log message rather than breaking the game.

import { getAISpellEffect, getAIETBSteps, getAITapAbilities, getAICastTriggers, getAIDiesTriggers, getAIAttackTriggers, getAICombatDamageTriggers, getAIUpkeepTriggers, getAIEndStepTriggers, getAINonTapAbilities } from './aiAdapter.js';

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};
const MANA_SYMBOL_COLOR = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', C: 'C' };

function parseAmount(token) {
  if (!token) return 1;
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return NUMBER_WORDS[token.toLowerCase()] ?? 1;
}

// For a matched amount token that might be the literal "X" (Comet Storm,
// Exsanguinate, and any other {X}-cost spell): the real value isn't known
// until the spell is actually cast (the player's chosen X, threaded through
// as ctx.xValue — see castSpell/resolveTop), so this must be called from
// inside a step's resolve(), never at interpret time like parseAmount above.
function resolveAmount(token, ctx) {
  return token.toLowerCase() === 'x' ? (ctx.xValue || 0) : parseAmount(token);
}

// True only for a {...} symbol parseManaCost actually knows how to charge
// (a number, X, C, a color pip, or hybrid) — see interpretNonTapAbilities
// for why this matters (an unrecognized symbol like "{E}" would otherwise
// silently become a free cost).
function isPayableManaSymbol(sym) {
  const inner = sym.slice(1, -1).toUpperCase();
  return inner === 'X' || inner === 'C' || /^\d+$/.test(inner) || ['W', 'U', 'B', 'R', 'G'].includes(inner) || inner.includes('/');
}

// Turns one already-lowercased chunk of oracle text into a list of effect
// steps. Shared by spells, triggered abilities, and activated abilities so
// they all recognize the same vocabulary of effects.
function interpretEffectText(text) {
  const steps = [];

  // Reminder text in parentheses restates rules already given in plain
  // English elsewhere on the same line (e.g. Monstrosity's own "(If this
  // creature isn't monstrous, put three +1/+1 counters on it and it
  // becomes monstrous.)") — it's never itself an independent rule.
  // Parsing it as one was a real, previously-latent bug: Protector of the
  // Wastes' own "{4}{W}: Monstrosity 3." kept adding +1/+1 counters via
  // its reminder text's own embedded "put three +1/+1 counters on it"
  // fragment on EVERY activation, even once already monstrous — only the
  // REAL "Monstrosity N" clause elsewhere on the same line correctly
  // gates that to once. Stripped up front so nothing below — including
  // the multi-sentence combos right after this — ever sees it.
  text = text.replace(/\([^()]*\)/g, ' ');

  // "Choose target player. They may discard up to X cards. Then they draw a
  // card for each card discarded this way." (Mishra's Command's looting
  // mode, and similar) — spans three separate sentences that'd otherwise be
  // processed as three independent (and unsupported) clauses once split
  // below, so this is matched against the whole text up front and stripped
  // out before the normal per-clause split runs.
  const lootMatch = text.match(/choose target player\. they may discard up to (\d+|x) cards?\. then they draw a card for each card discarded this way\.?/);
  if (lootMatch) {
    const amountToken = lootMatch[1];
    steps.push({
      kind: 'loot',
      targeting: 'player',
      resolve: (game, ctx) => game.applyLootEffect(ctx, resolveAmount(amountToken, ctx)),
    });
    text = text.slice(0, lootMatch.index) + text.slice(lootMatch.index + lootMatch[0].length);
  }

  // "Add {C}. If you control an Urza's Power-Plant and an Urza's Tower, add
  // {C}{C} instead." (the whole Urza's-lands cycle: Mine/Power-Plant/Tower)
  // — a conditional AMOUNT keyed off controlling two other, specifically-
  // NAMED lands, spanning two sentences that'd otherwise be processed as
  // independent clauses (the base "add {c}" would then always apply
  // alongside the conditional one, double-counting mana when the condition
  // is actually met) — so, same as the loot pattern above, this is matched
  // against the whole text up front and stripped out first.
  const urzaMatch = text.match(/^add \{c\}\.\s*if you control (?:an? )?([\w'\s-]+?) and (?:an? )?([\w'\s-]+?),\s*add ((?:\{c\})+) instead\.?$/);
  if (urzaMatch) {
    const land1 = urzaMatch[1].trim();
    const land2 = urzaMatch[2].trim();
    const bonusAmount = (urzaMatch[3].match(/\{c\}/g) || []).length;
    steps.push({
      kind: 'mana',
      targeting: 'none',
      resolve: (game, ctx) => game.applyConditionalManaEffect(ctx, land1, land2, bonusAmount),
    });
    text = text.slice(0, urzaMatch.index) + text.slice(urzaMatch.index + urzaMatch[0].length);
  }

  // "Reveal the top five cards of your library. An opponent separates
  // those cards into two piles. Put one pile into your hand and the other
  // into your graveyard." (Fact or Fiction) — spans three sentences that'd
  // otherwise be processed independently; matched and stripped up front
  // the same way as the loot/Urza's-lands patterns above.
  const factOrFictionMatch = text.match(/reveal the top five cards of your library\. an opponent separates those cards into two piles\. put one pile into your hand and the other into your graveyard\.?/);
  if (factOrFictionMatch) {
    steps.push({
      kind: 'factOrFiction',
      targeting: 'none',
      resolve: (game, ctx) => game.applyFactOrFictionEffect(ctx),
    });
    text = text.slice(0, factOrFictionMatch.index) + text.slice(factOrFictionMatch.index + factOrFictionMatch[0].length);
  }

  // "Each opponent loses X life, where X is your devotion to black. You
  // gain life equal to the life lost this way." (Gray Merchant of
  // Asphodel's current oracle wording, and reprints using the same
  // template for other colors) — two sentences whose SECOND half
  // ("you gain life equal to the life lost this way") already has its own
  // generic pattern elsewhere in this file, but that one resolves its
  // amount from ctx.xValue (built for Exsanguinate-style paid-{X} spells)
  // — which is undefined/0 here, since this X comes from devotion, not a
  // cast cost. Matching both sentences together up front, the same way as
  // the loot/Urza's-lands/Fact-or-Fiction patterns above, avoids that
  // mismatch entirely rather than trying to thread a computed amount
  // across the per-clause split.
  const devotionDrainMatch = text.match(/each opponent loses x life, where x is your devotion to (white|blue|black|red|green)\.\s*you gain life equal to the life lost this way\.?/);
  if (devotionDrainMatch) {
    const colorLetter = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[devotionDrainMatch[1]];
    steps.push({
      kind: 'devotionDrain',
      targeting: 'none',
      resolve: (game, ctx) => game.applyDevotionDrainEffect(ctx, colorLetter),
    });
    text = text.slice(0, devotionDrainMatch.index) + text.slice(devotionDrainMatch.index + devotionDrainMatch[0].length);
  }

  // "Will of the council — Starting with you, each player votes for a
  // nonland permanent you don't control. Exile each permanent with the
  // most votes or tied for most votes." (Council's Judgment) — no real
  // vote UI, and this engine is always exactly 2 players, so this
  // simplifies to exiling the opponent's best (highest-CMC) nonland
  // permanent — the realistic 2-player outcome most of the time anyway.
  const councilsJudgmentMatch = text.match(/(?:will of the council\s*—\s*)?starting with you,? each player votes for a nonland permanent you don'?t control\. exile each permanent with the most votes or tied for most votes\.?/);
  if (councilsJudgmentMatch) {
    steps.push({
      kind: 'edictExile',
      targeting: 'none',
      resolve: (game, ctx) => game.applyCouncilsJudgmentEffect(ctx),
    });
    text = text.slice(0, councilsJudgmentMatch.index) + text.slice(councilsJudgmentMatch.index + councilsJudgmentMatch[0].length);
  }

  // "Look at the top five cards of your library. You may reveal a Dinosaur
  // or land card from among them and put it into your hand. Put the rest
  // on the bottom of your library in any order." (Commune with Dinosaurs,
  // and the same template on plenty of similar digs) — spans three
  // sentences that'd otherwise be processed independently, so matched and
  // stripped up front the same way as the loot/Urza's-lands/Fact or
  // Fiction patterns above.
  const digRevealMatch = text.match(/look at the top (\d+|two|three|four|five) cards? of your library\.\s*(?:you may )?reveal an? ([\w\s]+?) card from among them and put it into your hand\.\s*put the rest on the bottom of your library(?: in (?:any|a random) order)?\.?/);
  if (digRevealMatch) {
    const n = parseAmount(digRevealMatch[1]);
    const typeWords = digRevealMatch[2].trim().toLowerCase().split(/\s+or\s+/);
    steps.push({
      kind: 'digReveal',
      targeting: 'none',
      resolve: (game, ctx) => game.applyDigRevealToHandEffect(ctx, n, typeWords),
    });
    text = text.slice(0, digRevealMatch.index) + text.slice(digRevealMatch.index + digRevealMatch[0].length);
  }

  // "Look at the top three cards of your library. Put one of them into your
  // hand and the rest on the bottom of your library in any order."
  // (Dragonlord Ojutai's own combat-damage trigger) — the unrestricted
  // sibling of the Commune with Dinosaurs shape above (no "reveal a [Type]
  // card" filter, so every seen card qualifies); same two-sentence-span
  // preprocessing needed since "put one of them..." would otherwise be
  // read as its own independent (and unsupported) clause.
  const digRevealNoFilterMatch = text.match(/look at the top (\d+|two|three|four|five) cards? of your library\.\s*put one of them into your hand and the rest on the bottom of your library(?: in (?:any|a random) order)?\.?/);
  if (digRevealNoFilterMatch) {
    const n = parseAmount(digRevealNoFilterMatch[1]);
    steps.push({
      kind: 'digReveal',
      targeting: 'none',
      resolve: (game, ctx) => game.applyDigRevealToHandEffect(ctx, n, null),
    });
    text = text.slice(0, digRevealNoFilterMatch.index) + text.slice(digRevealNoFilterMatch.index + digRevealNoFilterMatch[0].length);
  }

  // "Gain control of target permanent until end of turn. Untap that
  // permanent. It gains haste until end of turn." (Zealous Conscripts, and
  // the whole "Threaten effect" archetype) — three sentences that all have
  // to resolve together against the SAME chosen permanent (see
  // applyGainControlEffect), so this needs the same two/three-sentence-span
  // preprocessing as the dig-reveal patterns above; independently parsing
  // "untap that permanent" as its own clause would have no idea which
  // permanent "that" refers to. The trailing untap/haste sentences are
  // individually optional — some real Threaten effects grant only one of
  // them, or neither.
  const gainControlMatch = text.match(/gain control of target permanent until end of turn\.(?:\s*untap that permanent\.)?(?:\s*it gains haste until end of turn\.?)?/);
  if (gainControlMatch) {
    const untap = /untap that permanent/.test(gainControlMatch[0]);
    const haste = /it gains haste/.test(gainControlMatch[0]);
    steps.push({
      kind: 'gainControl',
      targeting: 'permanent',
      resolve: (game, ctx) => game.applyGainControlEffect(ctx, { untap, haste }),
    });
    text = text.slice(0, gainControlMatch.index) + text.slice(gainControlMatch.index + gainControlMatch[0].length);
  }

  // "Tap up to two target creatures. Those creatures don't untap during
  // their controller's next untap step." (Frost Breath) — both sentences
  // bind to the SAME chosen targets (setting perm.skipNextUntap, checked
  // by game.js's untap-step handling — the same one-shot flag mechanism
  // Mana Vault's own static "doesn't untap" text feeds into a different
  // way), so this needs the combo preprocessing rather than two
  // independently-parsed clauses (the second sentence's "those creatures"
  // would have no idea what was tapped).
  const tapAndSkipUntapMatch = text.match(/tap (?:up to (\w+)|(two|three)) target ([\w\s',-]+?)\.\s*those creatures don'?t untap during their controller'?s next untap step\.?/);
  if (tapAndSkipUntapMatch) {
    const targetCount = parseAmount(tapAndSkipUntapMatch[1] || tapAndSkipUntapMatch[2]);
    const targetDesc = tapAndSkipUntapMatch[3];
    steps.push({
      kind: 'tap',
      targeting: describeTargetKind('target ' + targetDesc),
      targetCount,
      minTargets: 0,
      resolve: (game, ctx) => {
        game.applyTapEffect(ctx, true);
        for (const t of (ctx.targets || [])) {
          if (t.type !== 'permanent') continue;
          const perm = game.findPermanent(t.id);
          if (perm) perm.skipNextUntap = true;
        }
      },
    });
    text = text.slice(0, tapAndSkipUntapMatch.index) + text.slice(tapAndSkipUntapMatch.index + tapAndSkipUntapMatch[0].length);
  }

  // "At the beginning of your upkeep, you may pay {4}. If you do, untap
  // this artifact." (Mana Vault, Grim Monolith, and similar fast-mana
  // artifacts) — both sentences resolve together (whether the payment
  // happened decides whether the untap does), same span-preprocessing
  // shape as the other multi-sentence combos here. Same "may" simplification
  // as everywhere else: always pays if currently affordable.
  const payToUntapMatch = text.match(/you may pay \{(\d+)\}\.\s*if you do,?\s*untap this (?:artifact|creature|permanent)\.?/);
  if (payToUntapMatch) {
    const cost = parseInt(payToUntapMatch[1], 10);
    steps.push({
      kind: 'payToUntap',
      targeting: 'none',
      resolve: (game, ctx) => game.applyPayToUntapEffect(ctx, cost),
    });
    text = text.slice(0, payToUntapMatch.index) + text.slice(payToUntapMatch.index + payToUntapMatch[0].length);
  }

  // "As this land enters, you may pay 2 life. If you don't, it enters
  // tapped." (the whole shock-land cycle: Sacred Foundry, Watery Grave,
  // Overgrown Tomb, Steam Vents, ...) — a replacement effect on how the
  // land itself enters, not a real triggered ability, but this engine
  // dispatches both through the same "as/when ~ enters" mechanism
  // (interpretPermanentTriggers), so it reaches here the same way. Same
  // "always pay if currently affordable" simplification as every other
  // optional cost in this engine (Ward, Mana Vault's untap, ...); resolves
  // immediately (targeting 'none', no stack interaction) since real
  // rules apply this the instant the land enters, before anyone gets
  // priority. `ctx.sourcePerm` is the land itself — this is the land's OWN
  // self-ETB trigger (triggerETB's ctxBase), not the tribal/any-ETB watcher
  // shape where the entering permanent is a separate `ctx.enteredPerm`.
  const shockLandMatch = text.match(/you may pay (\d+) life\.\s*if you don'?t,?\s*it enters tapped\.?/);
  if (shockLandMatch) {
    const cost = parseInt(shockLandMatch[1], 10);
    steps.push({
      kind: 'payLifeOrEntersTapped',
      targeting: 'none',
      resolve: (game, ctx) => game.applyPayLifeOrEntersTappedEffect(ctx, cost),
    });
    text = text.slice(0, shockLandMatch.index) + text.slice(shockLandMatch.index + shockLandMatch[0].length);
  }

  // "As this land enters, you may reveal an Island or Swamp card from your
  // hand. If you don't, this land enters tapped." (the reveal-land cycle:
  // Choked Estuary, Foreboding Ruins, ...) — same reasoning as the
  // shock-land cycle just above, but the actual tapped/untapped decision is
  // made directly in playLand's own computeLandEntersTapped BEFORE this
  // trigger dispatch ever runs (a pure hand check, no life payment or other
  // side effect to resolve), so this is just acknowledged as already
  // handled rather than pushed as its own step.
  const revealLandMatch = text.match(/you may reveal an? [a-z]+ or [a-z]+ card from your hand\.\s*if you don'?t,?\s*this land enters tapped\.?/);
  if (revealLandMatch) {
    // A real step still needs pushing (not just stripped, unlike the
    // acknowledged-no-op clauses elsewhere in this file) — if this is the
    // card's ONLY clause, an empty steps array here would otherwise hit the
    // catch-all "isn't modeled" fallback at the bottom of this function,
    // exactly the outcome this whole pattern exists to avoid.
    steps.push({ kind: 'revealLandEntersTapped', targeting: 'none', resolve: () => {} });
    text = text.slice(0, revealLandMatch.index) + text.slice(revealLandMatch.index + revealLandMatch[0].length);
  }

  // "Exchange control of this creature and up to one target creature an
  // opponent controls. If you don't or can't make an exchange, sacrifice
  // this creature." (Gilded Drake, and the whole "exchange control"
  // archetype) — a genuine two-way PERMANENT swap (applyExchangeControlEffect),
  // distinct from applyGainControlEffect's one-way "until end of turn"
  // Threaten shape above. "Up to one" has no real choose-or-decline UI, so
  // (same auto-pick philosophy used for every other no-real-choice target
  // in this engine) this always takes the opponent's best creature if one
  // exists, falling through to the sacrifice clause otherwise — both
  // outcomes live inside the one resolve function below, since whether the
  // exchange happened decides whether the sacrifice half fires.
  const exchangeControlMatch = text.match(/exchange control of this creature and up to one target creature an opponent controls\.\s*if you don'?t or can'?t make an exchange,?\s*sacrifice this creature\.?(?:\s*this ability still resolves if its target becomes illegal\.?)?/);
  if (exchangeControlMatch) {
    steps.push({
      kind: 'exchangeControl',
      targeting: 'none',
      resolve: (game, ctx) => {
        const auto = game.autoPickTarget('permanent', ctx.controllerId);
        const result = auto?.type === 'permanent' ? game.applyExchangeControlEffect({ ...ctx, target: auto }) : { exchanged: false };
        if (!result.exchanged) game.applySacrificeSelfEffect(ctx);
      },
    });
    text = text.slice(0, exchangeControlMatch.index) + text.slice(exchangeControlMatch.index + exchangeControlMatch[0].length);
  }

  // "Look at the top card of your library. If it's a creature card of the
  // chosen type, you may reveal it and put it into your hand." (Herald's
  // Horn's own upkeep trigger) — both sentences resolve together (which
  // card was seen, and whether it qualified, both live inside
  // applyChosenTypeTopCardDigEffect), same span-preprocessing need as the
  // other multi-sentence combos above.
  const chosenTypeDigMatch = text.match(/look at the top card of your library\.\s*if it'?s a creature card of the chosen type,?\s*(?:you may )?reveal it and put it into your hand\.?/);
  if (chosenTypeDigMatch) {
    steps.push({
      kind: 'digReveal',
      targeting: 'none',
      resolve: (game, ctx) => game.applyChosenTypeTopCardDigEffect(ctx),
    });
    text = text.slice(0, chosenTypeDigMatch.index) + text.slice(chosenTypeDigMatch.index + chosenTypeDigMatch[0].length);
  }

  // "Exile the top card of that player's library [or "of your library"].
  // Until the end of your next turn, you may play that card." (Ragavan,
  // Nimble Pilferer's own combat-damage trigger; Nightveil Specter's
  // near-identical wording) — a REAL temporary exile-and-play permission
  // (game.js's applyExileAndPlayEffect / playCardFromExile), unlike this
  // engine's older "impulse-draw as a straight draw into hand" simplification
  // used elsewhere for cards like Light Up the Stage (no expiration to
  // track there, and the card always comes from your OWN library — that
  // shape is left alone below, still just a draw). Spans two sentences
  // (the grant, and the "you may play" permission attached to it) that must
  // resolve together, hence the same top-of-function preprocessing as the
  // other multi-sentence combos above.
  const exileAndPlayMatch = text.match(/exile the top card of (that player'?s?|your) library\.\s*until the end of your next turn,?\s*you may play (?:that|this) card\.?/);
  if (exileAndPlayMatch) {
    const fromOpponent = /^that player/.test(exileAndPlayMatch[1]);
    steps.push({
      kind: 'exileAndPlay',
      targeting: 'none',
      resolve: (game, ctx) => game.applyExileAndPlayEffect(ctx, { fromOpponent }),
    });
    text = text.slice(0, exileAndPlayMatch.index) + text.slice(exileAndPlayMatch.index + exileAndPlayMatch[0].length);
  }

  // "Target player mills X cards. If this spell was cast from a graveyard,
  // that player mills twice that many cards instead." (Increasing
  // Confusion's own Flashback payoff) — the doubling condition needs
  // ctx.castFromGraveyard (set by game.js's resolveTop only for a spell
  // actually resolved via castFromGraveyard's Flashback/Escape path), and
  // X isn't known until resolve time (see resolveAmount), so both
  // sentences are combined here before the per-clause split, same as every
  // other multi-sentence combo above.
  const millXFromGraveyardMatch = text.match(/target player mills x cards?\.\s*if this spell was cast from a graveyard,?\s*that player mills twice that many cards? instead\.?/);
  if (millXFromGraveyardMatch) {
    steps.push({
      kind: 'mill',
      targeting: 'player',
      resolve: (game, ctx) => {
        const base = resolveAmount('x', ctx);
        game.applyMillEffect(ctx, ctx.castFromGraveyard ? base * 2 : base);
      },
    });
    text = text.slice(0, millXFromGraveyardMatch.index) + text.slice(millXFromGraveyardMatch.index + millXFromGraveyardMatch[0].length);
  }

  // "For each opponent, you may cast up to one target instant or sorcery
  // card from that player's graveyard without paying its mana cost. If a
  // spell cast this way would be put into a graveyard, exile it instead."
  // (Diluvian Primordial's own ETB) — this engine is strictly 2-player, so
  // "for each opponent" always means exactly the one opponent (same
  // simplification used for every other "each opponent" effect); the
  // second sentence (exile instead of graveyard) is handled entirely
  // inside applyFreeCastFromOpponentGraveyardEffect/resolveTop, so it's
  // just stripped here alongside the first rather than left to fall
  // through as its own unsupported clause.
  const freeCastFromOpponentGraveyardMatch = text.match(/for each opponent,?\s*you may cast up to one target instant or sorcery card from that player'?s graveyard without paying its mana cost\.\s*if a spell cast this way would be put into a graveyard,?\s*exile it instead\.?/);
  if (freeCastFromOpponentGraveyardMatch) {
    steps.push({
      kind: 'freeCastFromGraveyard',
      targeting: 'none',
      resolve: (game, ctx) => game.applyFreeCastFromOpponentGraveyardEffect(ctx),
    });
    text = text.slice(0, freeCastFromOpponentGraveyardMatch.index) + text.slice(freeCastFromOpponentGraveyardMatch.index + freeCastFromOpponentGraveyardMatch[0].length);
  }

  // "Choose target creature card in your graveyard. If that card's mana
  // value is less than or equal to the number of experience counters you
  // have, return it to the battlefield. Otherwise, put it into your hand."
  // (Meren of Clan Nel Toth's own end-step trigger) — three sentences that
  // must resolve together (which card was chosen decides both the
  // condition AND which of the two outcomes fires), same top-of-function
  // preprocessing as every other multi-sentence combo above. The dies-
  // trigger half that grants the experience counter ("whenever another
  // creature you control dies, you get an experience counter") is a
  // separate, already-supported clause elsewhere — see applyPlayerCounterEffect.
  const merenEndStepMatch = text.match(/choose target creature card in your graveyard\.\s*if that card'?s (?:mana value|converted mana cost) is less than or equal to the number of experience counters you have,?\s*return it to the battlefield\.\s*otherwise,?\s*put it into your hand\.?/);
  if (merenEndStepMatch) {
    steps.push({
      kind: 'reanimateOrHand',
      targeting: 'none',
      resolve: (game, ctx) => game.applyMerenEndStepEffect(ctx),
    });
    text = text.slice(0, merenEndStepMatch.index) + text.slice(merenEndStepMatch.index + merenEndStepMatch[0].length);
  }

  // "You may tap X untapped Myr you control. If you do, this creature
  // gets +X/+0 until end of turn and deals X damage to the player or
  // planeswalker it's attacking." (Myr Battlesphere's own attack trigger)
  // — X isn't chosen by the caster at all here (unlike a real {X} cost);
  // it's just "however many untapped Myr you have", so this always taps
  // ALL of them (same "always take the best available outcome" simplification
  // used for every other no-real-choice optional cost in this engine).
  const tapMyrForPumpMatch = text.match(/you may tap x untapped myr you control\.\s*if you do,?\s*this creature gets \+x\/\+0 until end of turn and deals x damage to the player or planeswalker it'?s attacking\.?/);
  if (tapMyrForPumpMatch) {
    steps.push({
      kind: 'tapForPump',
      targeting: 'none',
      resolve: (game, ctx) => game.applyTapMyrForPumpEffect(ctx),
    });
    text = text.slice(0, tapMyrForPumpMatch.index) + text.slice(tapMyrForPumpMatch.index + tapMyrForPumpMatch[0].length);
  }

  // "You get an emblem with 'Creatures you control get +1/+1.'" (a
  // planeswalker ultimate — Gideon, Ally of Zendikar; Elspeth, Sun's
  // Champion; ...) — the granted ability text is quoted and very often
  // contains its OWN internal period ("get +1/+1."), which would otherwise
  // get sliced apart by the per-clause split below before a same-clause
  // regex ever saw it whole; matched against the full text up front and
  // stripped out first, same as every other multi-sentence combo above.
  // game.js's applyGetEmblemEffect just remembers the raw text — see its
  // own comment for which two places (anthemBonus/effectiveKeywords)
  // actually read a static-anthem-shaped emblem back.
  const emblemMatch = text.match(/you get an emblem with "([^"]+)"/i);
  if (emblemMatch) {
    const emblemText = emblemMatch[1];
    steps.push({
      kind: 'emblem',
      targeting: 'none',
      resolve: (game, ctx) => game.applyGetEmblemEffect(ctx, emblemText),
    });
    text = text.slice(0, emblemMatch.index) + text.slice(emblemMatch.index + emblemMatch[0].length);
  }

  const clauses = text.split(/[.\n]/).map(c => c.trim()).filter(Boolean);

  for (let clause of clauses) {
    // A leading "you may " is stripped once here rather than added to every
    // individual pattern below — "may" isn't modeled anywhere in this
    // engine (every optional effect just always happens, same established
    // simplification as everywhere else), so every clause pattern benefits
    // uniformly instead of silently missing cards worded this way (Solemn
    // Simulacrum's "you may draw a card" used to fall through to
    // unsupported purely because of this prefix).
    clause = clause.replace(/^you may /, '');
    let m;

    // "deals twice X damage to ..." (Torch the Witness) — checked before the
    // plain damage regex below so its "twice" doesn't get swallowed as part
    // of the target description.
    if ((m = clause.match(/deals? twice x damage to (target [\w\s',-]+|any target)/))) {
      const amountToken = 'x';
      const targetDesc = m[1];
      steps.push({
        kind: 'damage',
        targeting: describeTargetKind(targetDesc),
        resolve: (game, ctx) => game.applyDamageEffect(ctx, 2 * resolveAmount(amountToken, ctx)),
      });
      continue;
    }

    // "Deals 1 damage to each of up to two target creatures" (Cast into
    // the Fire's own first mode, and similar) — the SAME amount to EACH of
    // several real chosen targets (unlike a divided/split total, which this
    // engine still doesn't support — see README's Known limitations).
    // Checked before the general damage pattern below, whose target-
    // description capture doesn't recognize the "each of up to N target"
    // shape at all (so there's no overlap/ordering risk).
    if ((m = clause.match(/deals (\d+|x|a|an|one|two|three) damage to each of (?:up to (\w+)|(two|three)) target ([\w\s',-]+?)$/))) {
      const amountToken = m[1];
      const targetCount = parseAmount(m[2] || m[3]);
      const targetDesc = m[4];
      // "up to N" (m[2]) is a real choice of fewer targets — 0 is a legal
      // cast against an empty board. A bare "N" with no "up to" (m[3]) is
      // mandatory: all N slots are required for a legal cast.
      const minTargets = m[2] ? 0 : targetCount;
      steps.push({
        kind: 'damage',
        targeting: describeTargetKind('target ' + targetDesc),
        targetCount,
        minTargets,
        resolve: (game, ctx) => game.applyDamageEffect(ctx, resolveAmount(amountToken, ctx)),
      });
      continue;
    }

    // "If this artifact is tapped, it deals 1 damage to you." (Mana
    // Vault's own draw-step trigger — see interpretDrawStepTriggers) —
    // self-referential to ctx.sourcePerm's own tapped state. Checked
    // BEFORE the general damage pattern right below, whose unanchored
    // "deals N damage to you" would otherwise match inside this same
    // clause and silently ignore the "if this artifact is tapped,"
    // condition entirely, dealing the damage unconditionally.
    if ((m = clause.match(/^if this (?:artifact|creature|permanent) is tapped,?\s*it deals (\d+) damage to you$/))) {
      const amount = parseInt(m[1], 10);
      steps.push({
        kind: 'damage',
        targeting: 'none',
        resolve: (game, ctx) => {
          if (ctx.sourcePerm?.tapped) game.applyDamageEffect({ ...ctx, target: { type: 'player', id: ctx.controllerId } }, amount);
        },
      });
      continue;
    }

    // "This Aura deals N damage to that player or a planeswalker that
    // player controls" (Curse of the Pierced Heart) — an "Enchant player"
    // Curse-only compound target shape (the enchanted player OR one of
    // their planeswalkers); simplified to just the enchanted player
    // directly, read from ctx.sourcePerm.attachedToPlayerId — same
    // "recognized, not the rarer secondary target option" simplification
    // used elsewhere for compound targets this engine doesn't fully
    // enumerate. Checked BEFORE the general damage clause right below,
    // whose own target-description alternation doesn't include this
    // phrasing anyway, but keeping specific-before-general is this
    // engine's own established ordering convention.
    // "N damage divided as you choose among any number of target creatures
    // and/or planeswalkers your opponents control" (Dragonlord Atarka) — no
    // real "choose how many, then divide arbitrarily" UI, so
    // applyDivideDamageEffect auto-picks: greedily kills as many of the
    // opponent's creatures/planeswalkers as possible (cheapest effective
    // toughness/loyalty first, each dealt EXACTLY its own lethal amount),
    // then dumps any leftover on the biggest surviving threat rather than
    // wasting it. Checked before the general damage clause below, whose
    // own "damage to (target ...)" shape doesn't match "damage divided..."
    // anyway, but specific-before-general is this file's own convention.
    if ((m = clause.match(/^(?:it )?deals? (\d+|x) damage divided as you choose among any number of target creatures and\/or planeswalkers (?:your opponents?|an opponent|opponents) controls?$/))) {
      const amountToken = m[1];
      steps.push({
        kind: 'divideDamage',
        targeting: 'none',
        resolve: (game, ctx) => game.applyDivideDamageEffect(ctx, resolveAmount(amountToken, ctx)),
      });
      continue;
    }

    if ((m = clause.match(/^this aura deals (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten) damage to that player or a planeswalker that player controls$/))) {
      const amount = parseAmount(m[1]);
      steps.push({
        kind: 'damage',
        targeting: 'none',
        resolve: (game, ctx) => {
          if (ctx.sourcePerm?.attachedToPlayerId) game.applyDamageEffect({ ...ctx, target: { type: 'player', id: ctx.sourcePerm.attachedToPlayerId } }, amount);
        },
      });
      continue;
    }

    if ((m = clause.match(/deals? (\d+|x|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty) damage to (target [\w\s',-]+|any target|each opponent|each creature|you)(?: and (?:you )?(?:draws? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+) cards?|gains? (\d+) life))?/))) {
      const amountToken = m[1];
      const amount = parseAmount(amountToken);
      const targetDesc = m[2];
      // Trailing "... and you draw a card" (Midnight Reaper's "this
      // creature deals 1 damage to you and you draw a card") or "... and
      // you gain N life" (Slimefoot, the Stowaway's own dies trigger,
      // normalized to "this creature deals 1 damage to each opponent and
      // you gain 1 life") — same combo-clause shape used elsewhere in this
      // file, since the whole clause is consumed by this one match and a
      // second pass over it never happens.
      const drawAmount = m[3] ? parseAmount(m[3]) : 0;
      const lifeGainAmount = m[4] ? parseInt(m[4], 10) : 0;
      // "you" (Midnight Reaper's damage target, and similar self-inflicted-
      // damage payoffs) always means the controller of whatever's dealing
      // the damage — never a real target choice.
      const sweep = targetDesc === 'each creature' ? 'creature' : (targetDesc === 'each opponent' ? 'opponent' : (targetDesc === 'you' ? 'self' : null));
      steps.push({
        kind: 'damage',
        amount,
        targeting: sweep ? 'none' : describeTargetKind(targetDesc),
        sweep,
        resolve: (game, ctx) => {
          const amt = resolveAmount(amountToken, ctx);
          if (sweep === 'self') {
            game.applyDamageEffect({ ...ctx, target: { type: 'player', id: ctx.controllerId } }, amt);
          } else if (sweep === 'creature') {
            // A board-wipe-shaped sweep (Blasphemous Act, Star of
            // Extinction, ...) — every creature on either side takes it,
            // resolved as a batch of single-target hits so lifelink/
            // deathtouch-style per-hit logic in applyDamageEffect still
            // applies to each one individually.
            for (const pl of game.players) {
              for (const perm of pl.battlefield) {
                if (game.isCreature(perm.card)) game.applyDamageEffect({ ...ctx, target: { type: 'permanent', id: perm.id } }, amt);
              }
            }
            game.checkStateBasedActions();
          } else if (sweep === 'opponent') {
            // Only ever a single opponent — this engine is 2-player only.
            game.applyDamageEffect({ ...ctx, target: { type: 'player', id: game.opponentOf(ctx.controllerId).id } }, amt);
          } else {
            game.applyDamageEffect(ctx, amt);
          }
        },
      });
      if (drawAmount > 0) {
        steps.push({ kind: 'draw', amount: drawAmount, targeting: 'none', resolve: (game, ctx) => game.applyDrawEffect(ctx, drawAmount) });
      }
      if (lifeGainAmount > 0) {
        steps.push({ kind: 'lifegain', amount: lifeGainAmount, targeting: 'none', resolve: (game, ctx) => game.applyLifegainEffect(ctx, lifeGainAmount) });
      }
      continue;
    }

    // "deals damage equal to its power to ..." (Murderous Redcap and
    // similar) — the amount isn't fixed, so it's computed at resolve time
    // from the source permanent's current power rather than parsed here.
    if ((m = clause.match(/deals? damage equal to its power to (target [\w\s',-]+|any target)/))) {
      const targetDesc = m[1];
      steps.push({
        kind: 'damage',
        targeting: describeTargetKind(targetDesc),
        resolve: (game, ctx) => game.applyDamageEffect(ctx, ctx.sourcePerm ? game.effectivePower(ctx.sourcePerm) : 0),
      });
      continue;
    }

    // "Target creature deals damage to itself equal to its power" (Cut
    // Propulsion and similar removal) — the amount AND the recipient both
    // come from the chosen target, not the source permanent, unlike the
    // "equal to its power" pattern above. The optional "if it has flying,
    // twice that much instead" clause some of these carry isn't enforced —
    // same simplification as elsewhere for a qualifier the engine
    // recognizes structurally but doesn't fully model.
    if (/^target creature deals damage to itself equal to its power/.test(clause)) {
      steps.push({
        kind: 'damage',
        targeting: 'creature',
        resolve: (game, ctx) => {
          const targetPerm = ctx.target?.type === 'permanent' ? game.findPermanent(ctx.target.id) : null;
          game.applyDamageEffect(ctx, targetPerm ? game.effectivePower(targetPerm) : 0);
        },
      });
      continue;
    }

    // "deals damage equal to the number of Treasures you control to any
    // target" (Smaug the Magnificent) — a different dynamic-amount source
    // from the power-based pattern above: the count is of a named permanent
    // type the controller has out, computed at resolve time since it
    // changes as the game plays out. Naive singular/plural match against
    // typeLine (Treasures -> "Treasure") covers the common case.
    if ((m = clause.match(/deals? damage equal to the number of ([\w\s]+?) you control to (target [\w\s',-]+|any target)/))) {
      const typeWord = m[1].trim().replace(/s$/, '');
      const targetDesc = m[2];
      steps.push({
        kind: 'damage',
        targeting: describeTargetKind(targetDesc),
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          const count = controller.battlefield.filter(p => p.card.typeLine.toLowerCase().includes(typeWord.toLowerCase())).length;
          game.applyDamageEffect(ctx, count);
        },
      });
      continue;
    }

    // "deals damage to target creature you control equal to the damage
    // dealt to you this turn" (Simulacrum) — a third dynamic-amount source,
    // read from the controller's own running per-turn damage tally (see
    // game.js's damageTakenThisTurn, reset each turn and incremented
    // wherever a player actually takes damage).
    if ((m = clause.match(/deals? damage to (target [\w\s',-]+|any target) equal to the damage dealt to you this turn/))) {
      const targetDesc = m[1];
      steps.push({
        kind: 'damage',
        targeting: describeTargetKind(targetDesc),
        resolve: (game, ctx) => game.applyDamageEffect(ctx, game.getPlayer(ctx.controllerId).damageTakenThisTurn),
      });
      continue;
    }

    // "You gain life equal to the damage dealt to you this turn." — the
    // companion clause to the one above.
    if (/^you gain life equal to the damage dealt to you this turn/.test(clause)) {
      steps.push({
        kind: 'lifegain',
        targeting: 'none',
        resolve: (game, ctx) => game.applyLifegainEffect(ctx, game.getPlayer(ctx.controllerId).damageTakenThisTurn),
      });
      continue;
    }

    // "Draw cards equal to the power of target creature you control"
    // (Soul's Majesty, and similar) — the amount comes from the TARGET's
    // current power, computed at resolve time since it can change.
    if (/^draw cards equal to the power of target creature/.test(clause)) {
      steps.push({
        kind: 'draw',
        targeting: 'creature',
        resolve: (game, ctx) => {
          const perm = ctx.target?.type === 'permanent' ? game.findPermanent(ctx.target.id) : null;
          game.applyDrawEffect(ctx, perm ? game.effectivePower(perm) : 0);
        },
      });
      continue;
    }

    // "You draw X cards and you lose X life, where X is the number of
    // Vampires you control" (Champion of Dusk, and similar tribal
    // draw-and-drain payoffs) — reuses the same "count a controlled type"
    // approach as Smaug the Magnificent's damage/Edgar Markov's counters.
    if ((m = clause.match(/^you draw x cards? and you lose x life,? where x is the number of ([\w\s]+?) you control/))) {
      const typeWord = m[1].trim().replace(/s$/, '').toLowerCase();
      steps.push({
        kind: 'draw',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          const count = controller.battlefield.filter(p => p.card.typeLine.toLowerCase().includes(typeWord)).length;
          game.applyDrawEffect(ctx, count);
          game.applyLifegainEffect(ctx, -count);
        },
      });
      continue;
    }

    // "You draw X cards and you lose X life" with no "where X is..." suffix
    // (Cut of the Profits, and similar {X}-cost spells) — X comes from the
    // spell's own {X} cost instead of a board-state count, resolved via
    // ctx.xValue same as every other X-cost effect.
    if (/^you draw x cards? and you lose x life$/.test(clause)) {
      steps.push({
        kind: 'draw',
        targeting: 'none',
        resolve: (game, ctx) => {
          const x = ctx.xValue || 0;
          game.applyDrawEffect(ctx, x);
          game.applyLifegainEffect(ctx, -x);
        },
      });
      continue;
    }

    // "Destroy all creatures" (Wrath of God, Damnation, ...), optionally
    // restricted to a type or its negation ("all Dragon creatures" / "all
    // non-Dragon creatures" — Crux of Fate's own modal wording). Checked
    // BEFORE the single-target "destroy target X" pattern right below,
    // since "all" isn't "target" but could otherwise be swept up by a
    // sufficiently loose match.
    if ((m = clause.match(/^destroy all (?:(non-)?([\w-]+) )?creatures$/))) {
      const negate = !!m[1];
      const typeWord = m[2] ? m[2].toLowerCase() : null;
      steps.push({
        kind: 'destroy',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassDestroyEffect(ctx, typeWord, negate),
      });
      continue;
    }

    // Accepts a leading "up to two"/"two" count (Liliana, the Necromancer's
    // ultimate, Fatal Lore, Deadly Designs) — a real multi-target step
    // (targetCount), checked before the plain single-target pattern right
    // below so it isn't misread as an unenforced "up to" qualifier the way
    // it used to be everywhere in this file.
    if ((m = clause.match(/destroy (?:up to (\w+) |(two|three) )target ([\w\s',-]+?)(?: that| unless| with|$)/))) {
      const targetCount = parseAmount(m[1] || m[2]);
      steps.push({
        kind: 'destroy',
        targeting: describeTargetKind('target ' + m[3]),
        targetCount,
        minTargets: m[1] ? 0 : targetCount,
        resolve: (game, ctx) => game.applyDestroyEffect(ctx),
      });
      continue;
    }

    if ((m = clause.match(/destroy target ([\w\s',-]+?)(?: that| unless| with|$)/))) {
      steps.push({
        kind: 'destroy',
        targeting: describeTargetKind('target ' + m[1]),
        resolve: (game, ctx) => game.applyDestroyEffect(ctx),
      });
      continue;
    }

    // Allows an optional qualifier word (Negate's "noncreature", Essence
    // Scatter's "creature", Dispel's "instant") — the engine doesn't enforce
    // the restriction itself (same simplification as elsewhere: any legal
    // stack target can be chosen), but recognizing the pattern at all is
    // what matters here.
    if ((m = clause.match(/counter target (?:\w+ )?spell/))) {
      steps.push({
        kind: 'counter',
        targeting: 'stackSpell',
        resolve: (game, ctx) => game.applyCounterEffect(ctx),
      });
      continue;
    }

    // "draws?" (not just "draw") so this also matches third-person phrasing
    // like "target player draws two cards" (Sign in Blood), not just
    // first/second-person "draw a card". Also optionally captures a trailing
    // "and loses N life" (Sign in Blood's other half) in the same match,
    // since it's joined by "and" rather than a separate sentence — a whole
    // separate clause-splitting pass isn't otherwise able to see both halves
    // (the loop moves to the next clause once one pattern matches).
    // Anchored at the clause start (allowing only a known subject prefix)
    // so this doesn't spuriously match a "draw a card" appearing AFTER an
    // unrelated leading clause like "you lose 1 life and draw a card" —
    // that's the life-loss regex's own trailing-draw combo below instead.
    // "That creature's controller may draw a card" (Fecundity, and similar
    // dies-trigger payoffs with NO controller restriction of their own —
    // "whenever A creature dies", so the beneficiary might be either
    // player) — reuses the SAME targeting:'player' auto-fill every other
    // dies-trigger 'player'-targeting step already gets (see triggerDies in
    // game.js, which defaults an unfilled player target to the dying
    // creature's own controller), rather than always benefiting the
    // watcher's controller like a bare "draws a card" would.
    if (/^that creature'?s controller (?:may )?draws? a card$/.test(clause)) {
      steps.push({
        kind: 'draw',
        targeting: 'player',
        resolve: (game, ctx) => game.applyDrawEffect(ctx, 1),
      });
      continue;
    }

    if ((m = clause.match(/^(?:target player |target opponent |you |each player )?draws? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+) cards?(?: and loses? (\d+) life)?/))) {
      const amount = parseAmount(m[1]);
      const hasTarget = /^target (?:player|opponent)/.test(clause);
      const drawTargeting = hasTarget ? 'player' : 'none';
      steps.push({
        kind: 'draw',
        amount,
        targeting: drawTargeting,
        resolve: (game, ctx) => game.applyDrawEffect(ctx, amount),
      });
      if (m[2]) {
        const lifeLoss = parseInt(m[2], 10);
        steps.push({
          kind: 'lifegain',
          amount: -lifeLoss,
          targeting: drawTargeting,
          resolve: (game, ctx) => game.applyLifegainEffect(ctx, -lifeLoss),
        });
      }
      continue;
    }

    // "loses X life" — targeted (Sign in Blood's other half, "that player"
    // from a dies-trigger's established subject), self ("you lose life"),
    // or "each opponent" (a 2-player-only stand-in for a real sweep).
    // Reuses applyLifegainEffect with a negated amount rather than a
    // separate method, since the two are mechanically identical. Also
    // optionally captures a trailing "and you gain N life" (the "drain"
    // template — Blood Artist, Zulaport Cutthroat, ...) or "and draw(s) N
    // card(s)" (Phyrexian Arena) — needs both halves recognized from one
    // clause the same way the draws-and-loses-life combo above does, just
    // in the opposite order.
    // "You gain life equal to the life lost this way" (Exsanguinate) — the
    // companion sentence to an "each opponent loses X life" clause just
    // before it. Every real card using this exact template drains its own
    // {X} value, so this reuses ctx.xValue directly rather than trying to
    // thread the previous clause's computed amount across clause boundaries.
    if (/^you gain life equal to the life lost this way/.test(clause)) {
      steps.push({
        kind: 'lifegain',
        targeting: 'none',
        resolve: (game, ctx) => game.applyLifegainEffect(ctx, ctx.xValue || 0),
      });
      continue;
    }

    // Optional leading "have " (Disciple of the Vault's "you may have
    // target opponent lose 1 life" — the leading "you may " is already
    // stripped generically above, leaving just "have") — the "may" isn't
    // enforced, same simplification as everywhere else in this engine that
    // recognizes an optional/conditional qualifier without a real prompt.
    if ((m = clause.match(/^(?:have )?(target player |target opponent |that player |each opponent |you )?loses? (\d+|x) life(?: and (?:you gains? (\d+) life|draws? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+) cards?))?/))) {
      const subject = (m[1] || '').trim();
      const loseAmountToken = m[2];
      const gainAmount = m[3] ? parseInt(m[3], 10) : 0;
      const drawAmount = m[4] ? parseAmount(m[4]) : 0;
      // "target opponent" is forced (there's only one, in a 2-player game),
      // same auto-resolve as "each opponent" — it never needs a real
      // targeting UI, and (this matters for dies-triggers specifically,
      // e.g. Disciple of the Vault) it must NOT be auto-filled with the
      // dying permanent's controller the way "that player"/"target player"
      // correctly are elsewhere — an opponent-targeting effect wants the
      // WATCHER's opponent, which could be a different player entirely.
      const autoOpponent = subject === 'each opponent' || subject === 'target opponent';
      const hasTarget = subject === 'target player' || subject === 'that player';
      steps.push({
        kind: 'lifegain',
        targeting: hasTarget ? 'player' : 'none',
        resolve: (game, ctx) => game.applyLifegainEffect(
          autoOpponent ? { ...ctx, target: { type: 'player', id: game.opponentOf(ctx.controllerId).id } } : ctx,
          -resolveAmount(loseAmountToken, ctx),
        ),
      });
      if (drawAmount > 0) {
        steps.push({ kind: 'draw', amount: drawAmount, targeting: 'none', resolve: (game, ctx) => game.applyDrawEffect(ctx, drawAmount) });
      }
      if (gainAmount > 0) {
        steps.push({
          kind: 'lifegain',
          amount: gainAmount,
          targeting: 'none',
          resolve: (game, ctx) => game.applyLifegainEffect(ctx, gainAmount),
        });
      }
      continue;
    }

    // Dynamic mass pump where X is the controller's own creature count
    // (Craterhoof Behemoth's finisher effect) — computed at RESOLVE time
    // (not here), since the creature count changes as the game plays out.
    // The paired "gain trample" grant IS modeled (perm.tempKeywords, read by
    // effectiveKeywords, already exists for exactly this "until end of turn"
    // shape — see applyTargetKeywordGrantEffect), so it isn't a partial gap.
    if (/creatures you control (?:gain trample and )?get \+x\/\+x until end of turn,?\s*where x is the number of creatures you control/.test(clause)) {
      const grantsTrample = /gain trample and/.test(clause);
      steps.push({
        kind: 'pump',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          const count = controller.battlefield.filter(p => game.isCreature(p.card)).length;
          for (const perm of controller.battlefield) {
            if (!game.isCreature(perm.card)) continue;
            perm.tempBuffs.push({ power: count, toughness: count });
            if (grantsTrample) perm.tempKeywords.push('trample');
          }
          game.log(`${ctx.card.name} gives ${controller.name}'s creatures +${count}/+${count}${grantsTrample ? ' and trample' : ''} until end of turn.`);
        },
      });
      continue;
    }

    // "Each creature gets -X/-X until end of turn" (The Meathook Massacre)
    // or "All creatures get -X/-X until end of turn" (Toxic Deluge, whose
    // X is paid as LIFE — an additional cost, not part of its mana cost at
    // all — see hasLifePaymentXCost/castSpell) — unlike the "creatures
    // you/opponents control" pattern right below, both hit EVERY creature
    // regardless of controller (scope 'all'). Accepts either the spell's
    // own paid {X} (or life-paid X — resolveAmount reads ctx.xValue either
    // way, castSpell doesn't care which kind of cost funded it) or a
    // literal fixed number (a bare "-2/-2"-style board wipe using this
    // same template).
    if ((m = clause.match(/^(?:each|all) creatures? gets? ([+-])(x|\d+)\/([+-])(x|\d+) until end of turn$/))) {
      const powerSign = m[1] === '-' ? -1 : 1;
      const powerToken = m[2];
      const toughnessSign = m[3] === '-' ? -1 : 1;
      const toughnessToken = m[4];
      steps.push({
        kind: 'pump',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassPumpEffect(ctx, 'all', powerSign * resolveAmount(powerToken, ctx), toughnessSign * resolveAmount(toughnessToken, ctx)),
      });
      continue;
    }

    // Fixed-amount mass pump/debuff: "creatures you control get +1/+1" or
    // "creatures your opponents control get -1/-1[, until end of turn]"
    // (Doomwake Giant's Constellation trigger, and similar) — distinct from
    // the dynamic Craterhoof-style clause above, which computes its own X.
    // Accepts an optional leading "other" (End-Raze Forerunners' own ETB —
    // excludes the source itself from its own mass pump) and an optional
    // trailing "and gain [keywords] until end of turn" (its "gain
    // vigilance and trample", same combo shape as the target-creature pump
    // above).
    if ((m = clause.match(/^(other )?creatures (you control|your opponents control|opponents control) get ([+-]\d+)\/([+-]\d+)(?: and gain ([a-z\s]+) until end of turn)?/))) {
      const excludeSelf = !!m[1];
      const scope = m[2] === 'you control' ? 'you' : 'opponents';
      const power = parseInt(m[3], 10), toughness = parseInt(m[4], 10);
      const keywordText = m[5] || null;
      steps.push({
        kind: 'pump',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassPumpEffect(ctx, scope, power, toughness, { excludeSelf, keywordText }),
      });
      continue;
    }

    // "Another target attacking Knight you control gets +1/+0 until end of
    // turn" (Fervent Champion's own attack trigger) — a type-restricted
    // sibling of the plain "target creature gets +X/+Y" pump just below;
    // the "attacking"/"another"/type/"you control" qualifiers aren't
    // enforced at the targeting-legality level (same simplification used
    // throughout this engine), just tolerated so the clause parses and
    // pumps a real target. Checked first since its target description
    // doesn't contain the literal word "creature" the pattern below needs.
    if ((m = clause.match(/^(?:another )?target attacking [\w-]+(?: you control)? gets ([+-]\d+)\/([+-]\d+) until end of turn$/))) {
      const p = parseInt(m[1], 10), t = parseInt(m[2], 10);
      steps.push({
        kind: 'pump',
        targeting: 'creature',
        resolve: (game, ctx) => game.applyPumpEffect(ctx, p, t),
      });
      continue;
    }

    // Target-creature pump, generalized to cover a fixed amount ("+1/+1",
    // "-2/-2") OR an {X}-cost spell's X ("+X/+0" — Mishra's Command), plus an
    // optional trailing keyword grant ("... and gains haste until end of
    // turn") folded into the same step since it's the same single target.
    // Accepts an optional "you control" restriction (Ranger's Guile's own
    // "target creature you control gets +1/+1 and gains hexproof..." —
    // like elsewhere in this engine, the "you control" half isn't enforced
    // at the targeting-legality level, just tolerated so the clause parses).
    if ((m = clause.match(/target creature(?: you control)? (?:gets|gains) ([+-]x|[+-]\d+)\/([+-]x|[+-]\d+)(?: and gains ([a-z\s]+) until end of turn)?/))) {
      const pToken = m[1], tToken = m[2], keywordText = m[3];
      const resolveSigned = (token, ctx) => {
        const neg = token.startsWith('-');
        const amt = token.slice(1).toLowerCase() === 'x' ? resolveAmount('x', ctx) : parseInt(token.slice(1), 10);
        return neg ? -amt : amt;
      };
      steps.push({
        kind: 'pump',
        targeting: 'creature',
        resolve: (game, ctx) => {
          game.applyPumpEffect(ctx, resolveSigned(pToken, ctx), resolveSigned(tToken, ctx));
          if (keywordText) game.applyTargetKeywordGrantEffect(ctx, keywordText);
        },
      });
      continue;
    }

    // "It gets +1/+0 until end of turn for each other attacking Goblin"
    // (Goblin Rabblemaster's own attack trigger) — "it" is the attacker
    // itself (ctx.sourcePerm, set by triggerAttacks), pumped dynamically by
    // a live count of other currently-attacking creatures of the named
    // subtype, not a fixed amount — checked before the plain self-pump
    // pattern below since it needs the count computed at resolve time.
    if ((m = clause.match(/^it gets ([+-]\d+)\/([+-]\d+) until end of turn for each other attacking ([\w\s-]+)$/))) {
      const p = parseInt(m[1], 10), t = parseInt(m[2], 10);
      const typeWord = m[3].trim().replace(/s$/, '');
      steps.push({
        kind: 'pump',
        targeting: 'none',
        resolve: (game, ctx) => game.applyAttackCountPumpEffect(ctx, p, t, typeWord),
      });
      continue;
    }

    // Self-referencing pump, e.g. "this creature gets +1/+1 until end of
    // turn" — common in "whenever you cast ~" triggers (prowess-style
    // effects). Needs no player-chosen target: the source permanent buffs
    // itself, via ctx.sourcePerm (set by triggerCastSpell/triggerETB).
    if ((m = clause.match(/this (?:creature|permanent) gets ([+-]\d+)\/([+-]\d+)/))) {
      const p = parseInt(m[1], 10), t = parseInt(m[2], 10);
      steps.push({
        kind: 'pump',
        power: p, toughness: t,
        targeting: 'none',
        resolve: (game, ctx) => game.applyPumpEffect({ ...ctx, target: { type: 'permanent', id: ctx.sourcePerm?.id } }, p, t),
      });
      continue;
    }

    // "If you control the artifact with the greatest mana value or tied
    // for the greatest mana value, draw a card" (Padeem, Consul of
    // Innovation's own upkeep trigger) — a real board-state condition
    // re-evaluated every upkeep (see applyGreatestManaValueDrawEffect).
    if ((m = clause.match(/^if you control the ([\w\s]+?) with the greatest mana value or tied for the greatest mana value,? draw a card$/))) {
      const typeWord = m[1].trim().toLowerCase();
      steps.push({
        kind: 'draw',
        targeting: 'none',
        resolve: (game, ctx) => game.applyGreatestManaValueDrawEffect(ctx, typeWord),
      });
      continue;
    }

    // "Sacrifice it unless it escaped" (Uro, Titan of Nature's Wrath's own
    // ETB trigger) — ctx.sourcePerm.escaped is set by game.js's
    // castFromGraveyard/resolveTop when this permanent was actually cast
    // via its Escape cost; a normal hand-cast leaves it false, making the
    // sacrifice unconditional (the correct real-game outcome either way).
    if (/^sacrifice it unless it escaped$/.test(clause)) {
      steps.push({
        kind: 'sacrifice',
        targeting: 'none',
        resolve: (game, ctx) => { if (!ctx.sourcePerm?.escaped) game.applySacrificeSelfEffect(ctx); },
      });
      continue;
    }

    // "Target player draws cards equal to half the number of cards in
    // their library and loses half their life. Round up each time." (Peer
    // into the Abyss) — both dynamic amounts are computed fresh at resolve
    // time from the target's CURRENT library size/life total, before the
    // draw happens (drawing doesn't itself change either number, but the
    // amount has to be captured once up front rather than recomputed after
    // any side effects). The trailing "Round up each time." sentence is
    // its own clause (split on the period) — acknowledged as a no-op since
    // the rounding is already baked into this resolve.
    if (/^target player draws cards equal to half the number of cards in their library and loses half their life$/.test(clause)) {
      steps.push({
        kind: 'draw',
        targeting: 'player',
        resolve: (game, ctx) => {
          const p = ctx.target?.type === 'player' ? game.getPlayer(ctx.target.id) : game.getPlayer(ctx.controllerId);
          const drawAmount = Math.ceil(p.library.length / 2);
          const lifeLoss = Math.ceil(p.life / 2);
          game.applyDrawEffect(ctx, drawAmount);
          game.applyLifegainEffect(ctx, -lifeLoss);
        },
      });
      continue;
    }
    if (/^round up each time$/.test(clause)) {
      continue;
    }

    // "You gain 3 life and draw a card, then you may put a land card from
    // your hand onto the battlefield" (Uro, Titan of Nature's Wrath's own
    // "enters or attacks" trigger) — a three-effect combo that'd otherwise
    // be swallowed down to just the lifegain half: the generic "gains N
    // life" pattern below matches only its own prefix (not anchored past
    // "life"), silently discarding everything after it in the same clause,
    // same "and draw a card"/"and gain N life" combo-clause shape used for
    // damage/life-loss effects elsewhere in this file. Checked first so its
    // "gain N life" prefix isn't consumed by the plainer pattern below.
    if ((m = clause.match(/^(?:you )?gains? (\d+) life and draws? a card,? then you may put a land card from your hand onto the battlefield$/))) {
      const amount = parseInt(m[1], 10);
      steps.push({ kind: 'lifegain', targeting: 'none', resolve: (game, ctx) => game.applyLifegainEffect(ctx, amount) });
      steps.push({ kind: 'draw', targeting: 'none', resolve: (game, ctx) => game.applyDrawEffect(ctx, 1) });
      steps.push({ kind: 'putLandFromHand', targeting: 'none', resolve: (game, ctx) => game.applyPutLandFromHandEffect(ctx) });
      continue;
    }

    // "You gain N life" (self) or "target player gains N life" (Kenrith,
    // the Returned King's own ability, and similar) — the latter is a real
    // choice (could target either player), unlike "you gain" which never
    // needs a target at all.
    if ((m = clause.match(/^(target player |you )?gains? (\d+) life/))) {
      const hasTarget = (m[1] || '').trim() === 'target player';
      const amount = parseInt(m[2], 10);
      steps.push({
        kind: 'lifegain',
        targeting: hasTarget ? 'player' : 'none',
        resolve: (game, ctx) => game.applyLifegainEffect(ctx, amount),
      });
      continue;
    }

    // "Double its controller's life total" (Celestial Mantle's combat-
    // damage trigger) — "its" is the enchanted creature, resolved via
    // ctx.controllerId same as every other 'attachedCreature'-scoped
    // trigger's effect text.
    if (/^double its controller'?s life total$/.test(clause)) {
      steps.push({
        kind: 'lifegain',
        targeting: 'none',
        resolve: (game, ctx) => game.applyDoubleLifeEffect(ctx),
      });
      continue;
    }

    // "You gain life equal to that creature's toughness" (Verdant Sun's
    // Avatar's tribal-ETB trigger) — "that creature" is whichever creature
    // actually entered and fired this (ctx.enteredPerm, threaded through by
    // triggerTribalEtb), NOT the watcher itself.
    if (/^you gain life equal to that creature'?s toughness$/.test(clause)) {
      steps.push({
        kind: 'lifegain',
        targeting: 'none',
        resolve: (game, ctx) => game.applyLifegainEffect(ctx, ctx.enteredPerm ? game.effectiveToughness(ctx.enteredPerm) : 0),
      });
      continue;
    }

    // "It gains haste until end of turn" (Dragon Tempest's own tribal-ETB
    // trigger — "it" is the entering creature itself, ctx.enteredPerm, same
    // self/other distinction as Verdant Sun's Avatar above) — falls back to
    // ctx.sourcePerm for any other trigger shape that might phrase a
    // self-keyword-grant this way without an enteredPerm in play.
    if ((m = clause.match(/^it gains ([a-z\s]+?) until end of turn$/))) {
      const keywordText = m[1];
      steps.push({
        kind: 'pump',
        targeting: 'none',
        resolve: (game, ctx) => {
          const perm = ctx.enteredPerm || ctx.sourcePerm;
          if (perm) game.applyTargetKeywordGrantEffect({ ...ctx, target: { type: 'permanent', id: perm.id } }, keywordText);
        },
      });
      continue;
    }

    // "This creature deals damage equal to that creature's power to any
    // target" (Terror of the Peaks' own tribal-ETB trigger) — "that
    // creature" is ctx.enteredPerm, same self/other distinction as Verdant
    // Sun's Avatar above; the "any target" half is auto-picked by
    // triggerTribalEtb since this fires with no direct player action to
    // hang a real target-choice UI off of.
    if (/^this creature deals damage equal to that creature'?s power to any target$/.test(clause)) {
      steps.push({
        kind: 'damage',
        targeting: 'creatureOrPlayer',
        resolve: (game, ctx) => game.applyDamageEffect(ctx, ctx.enteredPerm ? game.effectivePower(ctx.enteredPerm) : 0),
      });
      continue;
    }

    // "It deals that much damage to each creature that player controls"
    // (Balefire Dragon's own combat-damage trigger, "Whenever Balefire
    // Dragon deals damage to a player, it deals that much damage to each
    // creature that player controls.") — "that much" is ctx.combatDamageAmount
    // (see game.js's triggerCombatDamageToPlayer), and "that player" is
    // always the source's controller's opponent in this always-2-player
    // engine, so no real target-choice UI is needed.
    if (/^it deals that much damage to each creature that player controls$/.test(clause)) {
      steps.push({
        kind: 'damage',
        targeting: 'none',
        resolve: (game, ctx) => game.applyDamageToOpponentCreaturesEffect(ctx, ctx.combatDamageAmount || 0),
      });
      continue;
    }

    // "Exile any number of target nonland permanents you control, then
    // return those cards to the battlefield under their owner's control"
    // (Brago, King Eternal's own combat-damage trigger) — "any number" has
    // no real multi-target choose UI, so this flickers every nonland
    // permanent the controller controls (see applyMassFlickerOwnEffect).
    if (/^exile any number of target nonland permanents you control,? then return (?:those cards|them) to the battlefield under their owner'?s control$/.test(clause)) {
      steps.push({
        kind: 'flicker',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassFlickerOwnEffect(ctx, 'nonland'),
      });
      continue;
    }

    // "Choose a creature type" (Herald's Horn, Cavern of Souls, Metallic
    // Mimic, Adaptive Automaton, ...) — no real player-facing choice UI
    // exists for this, so applyChooseCreatureTypeEffect auto-picks
    // whatever creature type is most common in the controller's own hand/
    // battlefield, storing it on ctx.sourcePerm.chosenType for whichever
    // other ability on the same card reads "the chosen type" back.
    // "As an additional cost to cast this spell, pay X life." (Toxic
    // Deluge) — the actual life payment is handled by castSpell itself
    // (see hasLifePaymentXCost), before this spell even resolves; this is
    // just acknowledged here so the clause isn't flagged unsupported.
    if (/^as an additional cost to cast this spell,? pay x life$/.test(clause)) {
      continue;
    }

    // "If it was kicked, it fights another target creature." (Territorial
    // Allosaurus, and the whole Kicker+Fight combo) — "it" is
    // ctx.sourcePerm; the condition reads ctx.sourcePerm.wasKicked, set by
    // game.js's castSpell when the caster paid the optional Kicker cost
    // (see getKickerCost). Fight (each of two creatures deals damage to
    // the other equal to its power, independent of combat) is its own
    // effect, applyFightEffect.
    if (/^if it was kicked,?\s*it fights another target creature$/.test(clause)) {
      steps.push({
        kind: 'fight',
        targeting: 'creature',
        resolve: (game, ctx) => {
          if (ctx.sourcePerm?.wasKicked) game.applyFightEffect(ctx);
        },
      });
      continue;
    }

    // "It fights target creature" (a plain, unconditional Fight spell —
    // Prey Upon, and similar) — same applyFightEffect, no Kicker gate.
    if (/^(?:this creature|it) fights target creature$/.test(clause)) {
      steps.push({
        kind: 'fight',
        targeting: 'creature',
        resolve: (game, ctx) => game.applyFightEffect(ctx),
      });
      continue;
    }

    if (/^choose a creature type$/.test(clause)) {
      steps.push({
        kind: 'chooseType',
        targeting: 'none',
        resolve: (game, ctx) => game.applyChooseCreatureTypeEffect(ctx),
      });
      continue;
    }

    // "You may attach it to target creature you control" (Sigarda's Aid's
    // own tribal-ETB trigger, "Whenever an Equipment you control enters,
    // ...") — "it" is the entering Equipment (ctx.enteredPerm), and there's
    // no real target-choice UI for which creature, so this auto-picks the
    // controller's own strongest other creature.
    if (/^attach it to target creature you control$/.test(clause)) {
      steps.push({
        kind: 'autoAttach',
        targeting: 'none',
        resolve: (game, ctx) => game.applyAutoAttachEffect(ctx),
      });
      continue;
    }

    // "That player discards a card and you untap all lands you control"
    // (Sword of Feast and Famine's own attachedCreature-scoped combat-
    // damage trigger) — "that player" is whoever the equipped creature just
    // hit, which in this always-2-player engine is simply ctx.controllerId's
    // one opponent (same trick as Hellrider/Goblin Guide).
    if (/^that player discards a card and you untap all lands you control$/.test(clause)) {
      steps.push({
        kind: 'discard',
        targeting: 'none',
        resolve: (game, ctx) => {
          const opponent = game.opponentOf(ctx.controllerId);
          game.applyDiscardEffect({ ...ctx, target: { type: 'player', id: opponent.id } }, 1);
          game.applyMassUntapEffect(ctx, { permType: 'land' });
        },
      });
      continue;
    }

    // "Create a token that's a copy of this Equipment/artifact/permanent"
    // (Bloodforged Battle-Axe's own attachedCreature-scoped combat-damage
    // trigger) — ctx.card is already the source's own card for this
    // trigger shape.
    if (/^create a token that'?s a copy of this (?:equipment|artifact|permanent)$/.test(clause)) {
      steps.push({
        kind: 'tokenCopy',
        targeting: 'none',
        resolve: (game, ctx) => game.applyTokenCopyOfSelfEffect(ctx),
      });
      continue;
    }

    // Player-level counters (experience, energy, poison, ...) — a
    // different "location" than a permanent's own counters (put on the
    // controller directly, e.g. Meren's "you get an experience counter").
    // {E} is written with the actual energy symbol in real oracle text, but
    // Scryfall's oracle_text spells it "{E}" literally too.
    if ((m = clause.match(/you get (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) ([a-z]+) counters?/)) || (m = clause.match(/you get (\{e\}(?:\{e\})*)/))) {
      let amount, counterType;
      if (m[2]) { amount = parseAmount(m[1]); counterType = m[2]; }
      else { amount = m[1].match(/\{e\}/g).length; counterType = 'energy'; }
      steps.push({
        kind: 'playerCounters',
        amount, counterType,
        targeting: 'none',
        resolve: (game, ctx) => game.applyPlayerCounterEffect(ctx, amount, counterType),
      });
      continue;
    }

    // "Proliferate" — give another counter of each kind already present to
    // every permanent and player that has at least one. Real rules let you
    // choose which ones; this engine has no UI for that choice, so (same
    // simplification already used for edict/regrowth's auto-picks) it just
    // applies to everything that qualifies.
    // "All creatures gain trample and haste until end of turn" (Kenrith,
    // the Returned King's red ability, and similar mass-buff effects) —
    // every creature on the battlefield, both players' (there's no "you
    // control" restriction in this wording, unlike an anthem).
    if ((m = clause.match(/^all creatures gain ([\w\s,]+?) until end of turn/))) {
      const keywordText = m[1];
      steps.push({
        kind: 'massKeywordGrant',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassKeywordGrantEffect(ctx, keywordText),
      });
      continue;
    }

    // "Untap all creatures you control" (Aurelia, the Warleader's own
    // attack trigger) — checked BEFORE the generic single-target untap
    // clause elsewhere in this file so it isn't misread as a target
    // description.
    if (/^untap all creatures you control$/.test(clause)) {
      steps.push({
        kind: 'untap',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassUntapEffect(ctx),
      });
      continue;
    }

    // "Untap all lands you control" (Wilderness Reclamation's own end-step
    // trigger, and similar unrestricted land-untaps) — the land sibling of
    // "untap all creatures you control" just above, with no count cap.
    if (/^untap all lands you control$/.test(clause)) {
      steps.push({
        kind: 'untap',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassUntapEffect(ctx, { permType: 'land' }),
      });
      continue;
    }

    // "Untap up to five lands" (Peregrine Drake's own ETB, and similar
    // mana-ramp-via-untap effects) — no real "which lands" choice UI, so
    // this untaps whichever N happen to be tapped already.
    if ((m = clause.match(/^untap up to (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten) lands?$/))) {
      const maxCount = parseAmount(m[1]);
      steps.push({
        kind: 'untap',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassUntapEffect(ctx, { permType: 'land', maxCount }),
      });
      continue;
    }

    // "Untap all white creatures you control" (Battle Cry, and similar
    // color-restricted mass untaps) — checked before the generic
    // single-target untap clause elsewhere in this file.
    if ((m = clause.match(/^untap all (white|blue|black|red|green) creatures you control$/))) {
      const color = SPELL_FILTER_COLORS[m[1]];
      steps.push({
        kind: 'untap',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassUntapEffect(ctx, { color }),
      });
      continue;
    }

    // "Untap all creatures that attacked this turn" (Relentless Assault,
    // Waves of Aggression, and the rest of the "extra combat" cycle).
    if (/^untap all creatures that attacked this turn$/.test(clause)) {
      steps.push({
        kind: 'untap',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassUntapEffect(ctx, { attackedOnly: true }),
      });
      continue;
    }

    // "After this [main ]phase, there is an additional combat phase[,
    // followed by an additional main phase]" (Aurelia, the Warleader;
    // Relentless Assault; Waves of Aggression), or "After the second main
    // phase this turn, there's an additional combat phase followed by an
    // additional main phase" (World at War's own wording for the same
    // mechanic) — see game.js's queueExtraCombatPhase/advanceStep for where
    // this is actually inserted into the turn structure. The "followed by
    // an additional main phase" half needs no separate handling:
    // STEP_ORDER's own interleaved combat/main structure means redirecting
    // into 'beginCombat' already flows through a real main phase afterward.
    if (/^after (?:this (?:main )?phase|the second main phase this turn),? there(?:'s| is) an additional combat phase(?:,? followed by an additional main phase)?$/.test(clause)) {
      steps.push({
        kind: 'extraCombat',
        targeting: 'none',
        resolve: (game, ctx) => game.queueExtraCombatPhase(),
      });
      continue;
    }

    // "At the beginning of that combat, untap all creatures that attacked
    // this turn" (World at War's own phrasing of the same untap-attackers
    // effect Relentless Assault states as its own leading sentence).
    if (/^at the beginning of that combat,? untap all creatures that attacked this turn$/.test(clause)) {
      steps.push({
        kind: 'untap',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMassUntapEffect(ctx, { attackedOnly: true }),
      });
      continue;
    }

    // "Sacrifice another permanent" (Korvold, Fae-Cursed King's own
    // enters-or-attacks trigger) — self-inflicted, no target UI needed; see
    // applySacrificePermanentEffect for the auto-pick.
    if (/^sacrifice another permanent/.test(clause)) {
      steps.push({
        kind: 'sacrificePermanent',
        targeting: 'none',
        resolve: (game, ctx) => game.applySacrificePermanentEffect(ctx),
      });
      continue;
    }

    // "Monstrosity N" (Fleecemane Lion and the Theros monstrous cycle) — a
    // one-time self-buff keyword shorthand for "if this creature isn't
    // monstrous, put N +1/+1 counters on it and it becomes monstrous."
    // perm.monstrous is what a paired "as long as this creature is
    // monstrous, it has ..." static ability checks (see effectiveKeywords).
    if ((m = clause.match(/^monstrosity (\d+)/))) {
      const amount = parseInt(m[1], 10);
      steps.push({
        kind: 'monstrosity',
        targeting: 'none',
        resolve: (game, ctx) => game.applyMonstrosityEffect(ctx, amount),
      });
      continue;
    }

    if (/^proliferate\b/.test(clause)) {
      steps.push({
        kind: 'proliferate',
        targeting: 'none',
        resolve: (game, ctx) => game.applyProliferateEffect(ctx),
      });
      continue;
    }

    // "Put a +1/+1 counter on each Vampire you control" (Edgar Markov's own
    // attack trigger, and similar tribal payoffs) — applies to every
    // matching permanent the controller has, not a single chosen target.
    if ((m = clause.match(/put (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (\+\d+\/\+\d+|-\d+\/-\d+|[a-z]+) counters? on each ([\w\s]+?) you control/))) {
      const amount = parseAmount(m[1]);
      const counterType = m[2];
      const typeWord = m[3].trim().replace(/s$/, '');
      steps.push({
        kind: 'counters',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          for (const perm of controller.battlefield) {
            if (perm.card.typeLine.toLowerCase().includes(typeWord.toLowerCase())) {
              game.applyCounterAdditionEffect({ ...ctx, target: { type: 'permanent', id: perm.id } }, amount, counterType);
            }
          }
        },
      });
      continue;
    }

    // "Put a +1/+1 counter on each of up to two target creatures" (Rishkar,
    // Peema Renegade; Byrke, Long Ear of the Law; Zimone, Paradox
    // Sculptor's ETB; and many other counter-matters staples) — a real
    // multi-target step (targetCount, consumed by game.js's
    // resolveEffectSteps/expandTargetKinds), unlike the single-target
    // pattern right below. Checked first since "on each of" is more
    // specific than the plain "on target creature" wording.
    if ((m = clause.match(/put (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (\+\d+\/\+\d+|-\d+\/-\d+|[a-z]+) counters? on each of (?:up to (\w+)|(two|three)) target creatures/))) {
      const amount = parseAmount(m[1]);
      const counterType = m[2];
      const targetCount = parseAmount(m[3] || m[4]);
      steps.push({
        kind: 'counters',
        amount, counterType,
        targeting: 'creature',
        targetCount,
        minTargets: m[3] ? 0 : targetCount,
        resolve: (game, ctx) => game.applyCounterAdditionEffect(ctx, amount, counterType),
      });
      continue;
    }

    // Accepts an optional "attacking"/"blocking" qualifier before "creature"
    // (Ranger Class's own "put a +1/+1 counter on target attacking
    // creature") — recognized but not enforced as an extra targeting
    // restriction, same simplification this engine already makes for other
    // qualifier words it can't fully validate a target against.
    if ((m = clause.match(/put (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (\+\d+\/\+\d+|-\d+\/-\d+|[a-z]+) counters? on target (?:attacking |blocking )?creature/))) {
      const amount = parseAmount(m[1]);
      const counterType = m[2];
      steps.push({
        kind: 'counters',
        amount, counterType,
        targeting: 'creature',
        resolve: (game, ctx) => game.applyCounterAdditionEffect(ctx, amount, counterType),
      });
      continue;
    }

    // Self-referencing counters, e.g. "put a +1/+0 counter on this
    // creature" — same self-target pattern as the pump clause above. Also
    // accepts "on it" (Ordeal of Heliod's "put a +1/+1 counter on it",
    // referring back to "enchanted creature" earlier in the same trigger),
    // and "this enchantment"/"this artifact" (Beastmaster Ascension's own
    // "put a quest counter on this enchantment") — both resolve via
    // ctx.sourcePerm, which triggerAttacks already points at the right
    // permanent for each case (the watcher itself normally, or the
    // enchanted/equipped creature for an 'attachedCreature'-scoped
    // trigger). Also captures a trailing "and draw a card" (Korvold's own
    // payoff trigger, once its own name has been normalized to "this
    // permanent" — see interpretSacrificeTriggers), the same combo-clause
    // shape already used for the draws/loses-life patterns elsewhere here.
    if ((m = clause.match(/put (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (\+\d+\/\+\d+|-\d+\/-\d+|[a-z]+) counters? on (?:this (?:creature|permanent|enchantment|artifact)|it)(?: and draws? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) cards?)?/))) {
      const amount = parseAmount(m[1]);
      const counterType = m[2];
      const drawAmount = m[3] ? parseAmount(m[3]) : 0;
      steps.push({
        kind: 'counters',
        amount, counterType,
        targeting: 'none',
        resolve: (game, ctx) => game.applyCounterAdditionEffect({ ...ctx, target: { type: 'permanent', id: ctx.sourcePerm?.id } }, amount, counterType),
      });
      if (drawAmount > 0) {
        steps.push({ kind: 'draw', amount: drawAmount, targeting: 'none', resolve: (game, ctx) => game.applyDrawEffect(ctx, drawAmount) });
      }
      continue;
    }

    // Cultivate/Kodama's Reach shape: fetch two basic lands at once, one to
    // the battlefield (maybe tapped) and one to hand. Checked before the
    // single-land pattern below since its "up to two ... cards" wording
    // otherwise falls through harmlessly (no "a ... card" singular match).
    if ((m = clause.match(/search your library for up to two basic land cards.*?put one (onto the battlefield(?: tapped)?) and the other into (?:your|their) hand/))) {
      const tapped = m[1].includes('tapped');
      steps.push({
        kind: 'fetchTwoLands',
        targeting: 'none',
        resolve: (game, ctx) => game.applyFetchTwoLandsEffect(ctx, { tapped }),
      });
      continue;
    }

    // "Search your library for up to two basic Forest cards, reveal those
    // cards, and put one onto the battlefield tapped and the rest into
    // your hand" (Nissa's Pilgrimage) — a NAMED basic land type (not the
    // bare "basic land" supertype Cultivate uses), where only ONE of
    // however many are found goes to the battlefield and the rest (0 or
    // more) all go to hand — a different split shape than Cultivate's
    // fixed one-and-one. The "Spell mastery" clause that can raise the
    // count to three isn't enforced (an accepted simplification, same as
    // other unenforced qualifiers elsewhere in this file) — always
    // resolves as if searching for up to two.
    if ((m = clause.match(/^search your library for up to two basic (\w+) cards,? reveal those cards,? and put one onto the battlefield tapped and the rest into your hand$/))) {
      const landTypeWord = m[1].toLowerCase();
      steps.push({
        kind: 'fetchNamedLands',
        targeting: 'none',
        resolve: (game, ctx) => game.applyFetchNamedBasicLandsEffect(ctx, landTypeWord, 2),
      });
      continue;
    }

    // "Then shuffle" — the tail end of a search clause split into its own
    // sentence; every tutor/fetch effect here already shuffles internally,
    // so this is just acknowledged rather than treated as unsupported.
    if (/^then shuffle$/.test(clause)) {
      continue;
    }

    // "Search your library for up to two basic land cards, put them onto
    // the battlefield tapped, then shuffle" (Migration Path) — BOTH onto
    // the battlefield, unlike the Cultivate-shaped pattern above (one
    // battlefield, one hand). Also accepts a specific named land type in
    // place of "basic land" (Ranger's Path's own "up to two Forest cards"),
    // which isn't necessarily the "Basic Land" supertype.
    if ((m = clause.match(/^search your library for up to two (basic land|[a-z]+) cards?,? put them onto the battlefield tapped,? then shuffle$/))) {
      const landType = m[1] === 'basic land' ? null : m[1];
      steps.push({
        kind: 'fetchTwoLandsBattlefield',
        targeting: 'none',
        resolve: (game, ctx) => game.applyFetchTwoLandsBothToBattlefieldEffect(ctx, landType),
      });
      continue;
    }

    // "Search your library for up to two basic land cards, reveal them, put
    // them into your hand, then shuffle" (Yavimaya Elder's death trigger,
    // and similar) — BOTH to hand, unlike the Cultivate-shaped pattern just
    // above (one onto the battlefield, one to hand). Checked after it since
    // that one's own "up to two ... cards" phrasing is more specific and
    // should win when it actually matches.
    if (/^search your library for up to two basic land cards,? reveal them,? put them into your hand,? then shuffle$/.test(clause)) {
      steps.push({
        kind: 'fetchTwoLandsToHand',
        targeting: 'none',
        resolve: (game, ctx) => game.applyFetchTwoLandsToHandEffect(ctx),
      });
      continue;
    }

    // "Search your library for up to two creature cards with mana value 1
    // or less, ... put them into your hand, then shuffle." (Ranger of Eos,
    // and similar) — a non-land sibling of the Yavimaya Elder pattern just
    // above: any card type, with an optional mana-value cap. Also covers
    // "up to three [Type] cards with different names" (Three Dreams) — the
    // "different names" qualifier is unenforced but harmless in this
    // engine's singleton-only Commander decks, where it's already implied.
    if ((m = clause.match(/^search your library for up to (two|three) ([\w\s]+?) cards?(?: with mana value (\d+) or less)?(?: with different names)?,? reveal them,? put them into your hand,?(?: then shuffle)?$/))) {
      const maxCount = m[1] === 'three' ? 3 : 2;
      const typeWord = m[2].trim().toLowerCase();
      const maxCmc = m[3] ? parseInt(m[3], 10) : Infinity;
      steps.push({
        kind: 'fetchUpToNCardsToHand',
        targeting: 'none',
        resolve: (game, ctx) => game.applyFetchUpToNCardsToHandEffect(ctx, typeWord, maxCount, maxCmc),
      });
      continue;
    }

    // "If an opponent controls more lands than you, you may search your
    // library for up to three basic land cards, reveal them, put them into
    // your hand, then shuffle" (Land Tax) — a genuine conditional upkeep
    // trigger; the board-state check is only evaluated at resolve time.
    if (/^if an opponent controls more lands than you,? (?:you may )?search your library for up to three basic land cards,? reveal them,? put them into your hand,? then shuffle$/.test(clause)) {
      steps.push({
        kind: 'fetchThreeLandsToHand',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          const myLands = controller.battlefield.filter(p => game.isLand(p.card)).length;
          const oppLands = game.opponentOf(ctx.controllerId).battlefield.filter(p => game.isLand(p.card)).length;
          if (oppLands > myLands) game.applyFetchTwoLandsToHandEffect(ctx, 3);
        },
      });
      continue;
    }

    // "If you control a creature with power N or greater, draw a card"
    // (Colossal Majesty) — another genuine conditional upkeep trigger.
    if ((m = clause.match(/^if you control a creature with power (\d+) or greater,? draws? a card$/))) {
      const minPower = parseInt(m[1], 10);
      steps.push({
        kind: 'draw',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          const qualifies = controller.battlefield.some(perm => game.isCreature(perm.card) && game.effectivePower(perm) >= minPower);
          if (qualifies) game.applyDrawEffect(ctx, 1);
        },
      });
      continue;
    }

    // "Return all land cards from your graveyard to the battlefield
    // tapped." (Splendid Reclamation) — every matching card, unconditional.
    if (/^return all land cards from your graveyard to the battlefield tapped$/.test(clause)) {
      steps.push({
        kind: 'massLandReturn',
        targeting: 'none',
        resolve: (game, ctx) => game.applySplendidReclamationEffect(ctx),
      });
      continue;
    }

    // "Target creature you control deals damage equal to its power to each
    // other creature and each opponent." (Chandra's Ignition) — the amount
    // is only known at resolve time (the target's current power).
    if (/^target creature you control deals damage equal to its power to each other creature and each opponent$/.test(clause)) {
      steps.push({
        kind: 'damage',
        targeting: 'creature',
        resolve: (game, ctx) => game.applyChandrasIgnitionEffect(ctx),
      });
      continue;
    }

    // "Each player discards their hand, then draws cards equal to the
    // greatest number of cards a player discarded this way." (Windfall)
    if (/^each player discards their hand,? then draws cards equal to the greatest number of cards a player discarded this way$/.test(clause)) {
      steps.push({
        kind: 'wheel',
        targeting: 'none',
        resolve: (game, ctx) => game.applyWindfallEffect(ctx),
      });
      continue;
    }

    // "Return to the battlefield all permanent cards in your graveyard
    // that were put there from the battlefield this turn." (Faith's Reward)
    if (/^return to the battlefield all permanent cards in your graveyard that were put there from the battlefield this turn$/.test(clause)) {
      steps.push({
        kind: 'massReanimate',
        targeting: 'none',
        resolve: (game, ctx) => game.applyFaithsRewardEffect(ctx),
      });
      continue;
    }

    // "That player exiles the top two cards of their library and you draw
    // two cards" (Sire of Stagnation's own opponent-scoped landfall
    // trigger) — "that player" is always the controller's opponent here
    // (see game.js's triggerLandfall, which only dispatches this scope for
    // an opponent's own land entering), and the exile is a real removal to
    // EXILE (not a mill-to-graveyard, and not this engine's usual
    // exile-to-hand impulse-draw simplification either — the opponent gets
    // nothing back from it).
    if ((m = clause.match(/^that player exiles the top (\d+|two|three) cards? of their library and you draws? (\d+|two|three) cards?$/))) {
      const exileAmount = parseAmount(m[1]);
      const drawAmount = parseAmount(m[2]);
      steps.push({
        kind: 'mill',
        targeting: 'none',
        resolve: (game, ctx) => {
          game.applyExileMillEffect(ctx, exileAmount);
          game.applyDrawEffect(ctx, drawAmount);
        },
      });
      continue;
    }

    // "Exile the top two cards of your library" (Light Up the Stage, and
    // similar impulse-draw effects) — same documented simplification as
    // Expressive Iteration: no "cards you may currently cast from exile"
    // zone exists in this engine, so both cards go straight into hand
    // instead of a temporary exile-and-play window.
    if (/^exile the top two cards of your library$/.test(clause)) {
      steps.push({
        kind: 'impulseDraw',
        amount: 2,
        targeting: 'none',
        resolve: (game, ctx) => game.applyDrawEffect(ctx, 2),
      });
      continue;
    }

    // "Until the end of your next turn, you may play those cards" — the
    // temporary-play half of the clause above; already folded into a
    // straight draw there, so this is just acknowledged.
    if (/^until the end of your next turn,? you may play those cards$/.test(clause)) {
      continue;
    }

    // "This creature deals 1 damage to the player or planeswalker it's
    // attacking" (Hellrider's own attack trigger) — the ATTACKING creature
    // that fired this trigger might not be the watcher itself (Hellrider's
    // scope is "a creature you control attacks", any of them), but in this
    // always-2-player engine "the player ... it's attacking" can only ever
    // be the controller's one opponent, so no real per-attacker tracking is
    // needed to get the right answer.
    if ((m = clause.match(/^this creature deals (\d+|a|an|one|two|three) damage to the player or planeswalker it'?s attacking$/))) {
      const amount = parseAmount(m[1]);
      steps.push({
        kind: 'damage',
        targeting: 'none',
        resolve: (game, ctx) => game.applyDamageEffect({ ...ctx, target: { type: 'player', id: game.opponentOf(ctx.controllerId).id } }, amount),
      });
      continue;
    }

    // Type-restricted tutor to HAND for a non-land card type ("search your
    // library for an Equipment card, reveal it, put it into your hand, then
    // shuffle" — Stoneforge Mystic; "an artifact card with mana value 3" —
    // Trophy Mage; "a blue instant card" — Merchant Scroll). Checked BEFORE
    // the land-fetch pattern right below, whose type-word capture is really
    // meant for land type names (Forest, Plains, ...) but is a bare
    // `[a-z]+` class with nothing stopping it from ALSO matching
    // "equipment" — which used to route Stoneforge Mystic into
    // applyFetchLandEffect, whose isLand() check then meant it could never
    // find anything, ever. Also accepts an optional leading color
    // qualifier and a trailing "with mana value N" cap, both enforced —
    // and both of which used to break this regex outright when present
    // (Trophy Mage's mana-value clause sat between "card" and "reveal it",
    // Merchant Scroll's "blue instant" is two words where this only
    // recognizes the second as a real type, and Recruiter of the Guard's
    // "with toughness 2 or less" is the same shape as mana value but for a
    // different stat).
    if ((m = clause.match(/^search your library for an? (?:(white|blue|black|red|green)\s+)?([\w\s]+?) card(?: with (mana value|power|toughness) (\d+)(?: or less)?)?,?(?: reveal (?:it|that card),?)? put (?:it|that card) into your hand,?(?: then shuffle)?$/))) {
      const color = m[1] ? SPELL_FILTER_COLORS[m[1]] : null;
      const typeWord = m[2].trim().toLowerCase();
      const statName = m[3]; // 'mana value' | 'power' | 'toughness' | undefined
      const statCap = m[4] ? parseInt(m[4], 10) : Infinity;
      // Accepts a compound "Aura or Equipment"-style restriction (Open the
      // Armory) — every alternative has to be a recognized nonland type
      // word, OR'd together at resolve time by applyTutorEffect.
      const KNOWN_TUTOR_TYPES = ['artifact', 'creature', 'instant', 'sorcery', 'enchantment', 'equipment', 'aura', 'vehicle', 'planeswalker', 'battle'];
      if (typeWord.split(/\s+or\s+/).every(w => KNOWN_TUTOR_TYPES.includes(w))) {
        steps.push({
          kind: 'tutor',
          targeting: 'none',
          resolve: (game, ctx) => game.applyTutorEffect(ctx, typeWord, {
            maxCmc: statName === 'mana value' ? statCap : Infinity,
            maxPower: statName === 'power' ? statCap : Infinity,
            maxToughness: statName === 'toughness' ? statCap : Infinity,
            color,
          }),
        });
        continue;
      }
      // Not a recognized nonland type word — falls through to the land-fetch
      // pattern below, which is what a real land type name actually means.
    }

    // "Search your library for an artifact card [with mana value X or
    // less], put it/that card onto the battlefield, then shuffle." (Tinker,
    // Reshape, and similar) — a type-restricted tutor straight to the
    // BATTLEFIELD, optionally capped by the spell's own {X}; a different
    // shape from the to-HAND pattern just above. Checked before the
    // land-fetch pattern below, whose permissive `.*?` would otherwise
    // swallow the qualifier (when present) and misroute this the same way
    // Trophy Mage's did before that was fixed — and, when the qualifier is
    // ABSENT (Tinker has no mana-value cap at all), the land-fetch
    // pattern's `.*?` swallows the bare "card, " instead, silently trying
    // (and always failing) to find a LAND named "artifact".
    if ((m = clause.match(/^search your library for an? ([\w\s]+?) card(?: with mana value x or less)?,? put (?:it|that card) onto the battlefield,?(?: then shuffle)?$/))) {
      const typeWord = m[1].trim().toLowerCase();
      if (['artifact', 'creature', 'instant', 'sorcery', 'enchantment', 'equipment', 'aura', 'vehicle', 'planeswalker', 'battle', 'land'].includes(typeWord)) {
        steps.push({
          kind: 'tutorToBattlefield',
          targeting: 'none',
          resolve: (game, ctx) => game.applyTutorToBattlefieldEffect(ctx, typeWord, /with mana value x or less/.test(clause) ? (ctx.xValue || 0) : Infinity),
        });
        continue;
      }
    }

    // Fetches a land restricted either to the basic supertype ("a basic
    // land card") or to one or more named land types ("a Forest card",
    // "a Plains, Island, Swamp, or Mountain card", or — with the "basic"
    // qualifier captured separately — "a basic Forest card", Nissa,
    // Vastwood Seer's own wording, which needs BOTH the type AND the basic
    // restriction, not just one), then puts it onto the battlefield (maybe
    // tapped) or into hand. Accepts both "put it" and "put that card" —
    // Wizards' templating has used both over the years.
    if ((m = clause.match(/search your library for an? (basic )?(land|[a-z]+(?:,\s*[a-z]+)*(?:,?\s+or\s+[a-z]+)?) card.*?put (?:it|that card) (onto the battlefield(?: tapped)?|into (?:your|their) hand)/))) {
      const basicOnly = !!m[1];
      const ontoBattlefield = m[3].startsWith('onto the battlefield');
      const tapped = m[3].includes('tapped');
      // "Plains, Island, Swamp, or Mountain" (Farseek, and any other
      // Oxford-comma-style list) — splitting on `,\s*` OR `\s+or\s+`
      // separately (as if only one delimiter shape could ever appear) left
      // the comma-before-"or" case bundled wrong: ", or mountain" only ever
      // matches the COMMA alternative first, consuming just the comma and
      // its trailing space and leaving "or mountain" stuck together as one
      // bogus land-type token — which then never matches any real land's
      // type line, so Farseek silently found nothing even in a deck full of
      // Mountains. Normalizing any ", or "/" or " to a plain ", " first
      // sidesteps the ambiguity entirely, for lists of any length.
      const landTypes = m[2] === 'land' ? null : m[2].replace(/,?\s+or\s+/g, ', ').split(/,\s*/).filter(Boolean);
      steps.push({
        kind: 'fetchLand',
        targeting: 'none',
        resolve: (game, ctx) => game.applyFetchLandEffect(ctx, { ontoBattlefield, tapped, landTypes, basicOnly }),
      });
      continue;
    }

    // "Return the exiled card to the battlefield under its owner's control"
    // (the second half of Oblivion Ring/Journey to Nowhere's exile-and-
    // return combo, fired from a "leaves the battlefield" trigger) — no
    // target needed, it always means whatever THIS permanent itself exiled.
    // "Put any number of Dinosaur creature cards from among them onto the
    // battlefield and the rest on the bottom of your library in a random
    // order" (Gishath, Sun's Avatar and similar "reveal that many cards"
    // combat-damage payoffs) — "that many" comes from ctx.combatDamageAmount
    // (see game.js's triggerCombatDamageToPlayer). No real "choose which to
    // keep" UI, so every matching card found is put onto the battlefield —
    // a reasonable default, since a real player facing this choice almost
    // always wants all of them anyway.
    if ((m = clause.match(/^put any number of ([\w\s]+?) cards? from among them onto the battlefield/))) {
      const typeWord = m[1].trim();
      steps.push({
        kind: 'revealDamageDig',
        targeting: 'none',
        resolve: (game, ctx) => game.applyRevealDamageDigEffect(ctx, typeWord),
      });
      continue;
    }

    // "Reveal the top X cards of your library" (Genesis Wave, and similar) —
    // purely descriptive setup for the CMC-filtered dig clause right below;
    // the real work happens there.
    if (/^reveal the top x cards of your library$/.test(clause)) {
      continue;
    }

    // "You may put any number of permanent cards with mana value X or less
    // from among them onto the battlefield" (Genesis Wave) — a CMC-filtered
    // sibling of the type-filtered dig above (Gishath's "any number of
    // [Type] cards"), reusing the same "no real choose-which-to-keep UI, so
    // grab everything that qualifies" simplification.
    if (/^put any number of permanent cards with mana value x or less from among them onto the battlefield$/.test(clause)) {
      steps.push({
        kind: 'genesisWave',
        targeting: 'none',
        resolve: (game, ctx) => game.applyGenesisWaveEffect(ctx),
      });
      continue;
    }

    // "Then put all cards revealed this way that weren't put onto the
    // battlefield into your graveyard" — already handled inside
    // applyGenesisWaveEffect, so just acknowledged here.
    if (/^put all cards revealed this way that weren'?t put onto the battlefield into your graveyard$/.test(clause)) {
      continue;
    }

    // "Defending player reveals the top card of their library. If it's a
    // land card, that player puts it into their hand." (Goblin Guide's own
    // attack trigger) — "defending player" in this always-2-player engine
    // is simply the attacker's opponent; both sentences are resolved
    // together here since only this resolve knows what got revealed.
    if (/^defending player reveals the top card of their library$/.test(clause)) {
      steps.push({
        kind: 'revealTopLandToHand',
        targeting: 'none',
        resolve: (game, ctx) => game.applyGoblinGuideEffect(ctx),
      });
      continue;
    }

    // The conditional half of the clause above — already applied inside
    // applyGoblinGuideEffect, so just acknowledged here.
    if (/^if it'?s a land card,? that player puts it into their hand$/.test(clause)) {
      continue;
    }

    if (/^return the exiled card to the battlefield under its owner'?s control/.test(clause)) {
      steps.push({
        kind: 'returnExiledCard',
        targeting: 'none',
        resolve: (game, ctx) => game.applyReturnExiledCardEffect(ctx),
      });
      continue;
    }

    // Plural sibling of the above (Detention Sphere's own leaves trigger,
    // "return the exiled cards to the battlefield under their owner's
    // control") — pairs with applyExileWithSameNameEffect's
    // ctx.sourcePerm.exiledCards list rather than the singular exiledCard.
    if (/^return the exiled cards to the battlefield under their owner'?s control/.test(clause)) {
      steps.push({
        kind: 'returnExiledCard',
        targeting: 'none',
        resolve: (game, ctx) => game.applyReturnExiledCardsEffect(ctx),
      });
      continue;
    }

    // "The owner of target permanent shuffles it into their library, then
    // reveals the top card of their library." (Chaos Warp) — the whole
    // effect (shuffle away, then maybe get something random back) is
    // resolved in one go here, since only this resolve function knows what
    // actually got revealed.
    if (/^the owner of target permanent shuffles it into their library,? then reveals the top card of their library$/.test(clause)) {
      steps.push({
        kind: 'chaosWarp',
        targeting: 'permanent',
        resolve: (game, ctx) => game.applyChaosWarpEffect(ctx),
      });
      continue;
    }

    // "If it's a permanent card, they put it onto the battlefield" — the
    // conditional half of Chaos Warp's effect, already applied inside
    // applyChaosWarpEffect, so just acknowledged here.
    if (/^if it'?s a permanent card,? they put it onto the battlefield$/.test(clause)) {
      continue;
    }

    // "You may put an Aura or Equipment card from your hand or graveyard
    // onto the battlefield attached to this creature" (Danitha, Benalia's
    // Hope) — a genuinely three-zone source choice (hand OR graveyard, of
    // either card type) this engine has no other precedent for. No real
    // choose-which-card UI: auto-picks the highest-CMC qualifying card
    // across BOTH zones combined, same "most impactful" simplification
    // used for every other no-real-choice pick elsewhere.
    if (/^put an aura or equipment card from your hand or graveyard onto the battlefield attached to this creature$/.test(clause)) {
      steps.push({
        kind: 'attachFromHandOrGraveyard',
        targeting: 'none',
        resolve: (game, ctx) => game.applyPutAuraOrEquipmentFromHandOrGraveyardEffect(ctx),
      });
      continue;
    }

    // "Return it to its owner's hand" (Rancor's "When this Aura is put into
    // a graveyard from the battlefield, return it to its owner's hand", and
    // similar self-bouncing Auras) — "it" is the dying permanent's OWN
    // card, which is already sitting in the graveyard by the time a dies
    // trigger runs (see movePermanentToGraveyard), so this just moves
    // ctx.card back out of there.
    if (/^return it to its owner'?s hand$/.test(clause)) {
      steps.push({
        kind: 'returnSelfToHand',
        targeting: 'none',
        resolve: (game, ctx) => game.applyReturnSelfToHandEffect(ctx),
      });
      continue;
    }

    // "Return this card from your graveyard to the battlefield" as a
    // TRIGGERED effect (Bloodghast's own Landfall trigger) — distinct from
    // interpretGraveyardAbilities' identically-worded "{cost}: return this
    // card..." ACTIVATED ability; this one fires automatically, dispatched
    // from game.js's triggerLandfall scanning the graveyard directly.
    if (/^return this card from your graveyard to the battlefield$/.test(clause)) {
      steps.push({
        kind: 'selfGraveyardReanimate',
        targeting: 'none',
        resolve: (game, ctx) => game.applyReturnSelfFromGraveyardEffect(ctx),
      });
      continue;
    }

    // "Put target creature card from a graveyard onto the battlefield under
    // its owner's control" (Kenrith, the Returned King's black ability, and
    // similar reanimation effects) — which specific card in which graveyard
    // isn't a real target this engine's UI can prompt for; see
    // applyReanimateAnyGraveyardEffect for the auto-pick.
    if (/^put target creature card from a graveyard onto the battlefield under its owner'?s control/.test(clause)) {
      steps.push({
        kind: 'reanimate',
        targeting: 'none',
        resolve: (game, ctx) => game.applyReanimateAnyGraveyardEffect(ctx),
      });
      continue;
    }

    // "Put target creature card from a graveyard onto the battlefield under
    // YOUR control" (Reanimate, and similar) — as opposed to the
    // owner's-control version above, the caster keeps it. Often paired with
    // a life-loss-equal-to-mana-value clause (checked against the full text,
    // not just this clause, since it's a separate sentence) that's folded
    // into the same resolve since only it knows which card actually got
    // reanimated.
    if (/^put target creature card from a graveyard onto the battlefield under your control/.test(clause)) {
      const alsoLosesLife = /you lose life equal to that card'?s mana value/.test(text);
      steps.push({
        kind: 'reanimate',
        targeting: 'none',
        resolve: (game, ctx) => game.applyReanimateAnyGraveyardEffect(ctx, { underCasterControl: true, loseLifeEqualToCmc: alsoLosesLife }),
      });
      continue;
    }

    // The life-loss half of the clause above — already applied inside
    // applyReanimateAnyGraveyardEffect, so just acknowledged here so it
    // doesn't fall through as its own unsupported step.
    if (/^you lose life equal to that card'?s mana value$/.test(clause)) {
      continue;
    }

    // "Return target creature/permanent card [with mana value N or less]
    // from your graveyard to the battlefield" (Karmic Guide, Sun Titan, and
    // similar) — a differently-worded reanimation shape from the two above
    // ("return ... from YOUR graveyard", not "put ... from A graveyard"),
    // restricted to the caster's OWN graveyard and sometimes CMC-capped.
    // Same "no real which-card UI" simplification as the untargeted
    // versions: auto-picks the highest-CMC qualifying card.
    if ((m = clause.match(/^return target (creature|permanent) card(?: with mana value (\d+) or less)? from your graveyard to the battlefield$/))) {
      const typeWord = m[1];
      const maxCmc = m[2] ? parseInt(m[2], 10) : Infinity;
      steps.push({
        kind: 'reanimate',
        targeting: 'none',
        resolve: (game, ctx) => game.applyReanimateFromOwnGraveyardEffect(ctx, { typeWord, maxCmc }),
      });
      continue;
    }

    // "Look at the top three cards of your library" (Expressive Iteration,
    // and similar) — purely descriptive setup for the distribution clause
    // right below; the real work happens there.
    if (/^look at the top (?:\d+|two|three|four|five) cards? of your library$/.test(clause)) {
      continue;
    }

    // "Put one of them into your hand, put one of them on the bottom of your
    // library, and exile one of them" (Expressive Iteration) — no real
    // target UI for which of the three goes where, so this auto-picks: the
    // highest-mana-value card to hand, the lowest to the bottom, and the
    // "exiled" one ALSO straight to hand rather than modeling a temporary
    // exile-and-play-this-turn zone this engine doesn't have (a deliberate,
    // documented simplification — see README's Known limitations).
    if (/^put one of them into your hand,? put one of them on the bottom of your library,? and exile one of them$/.test(clause)) {
      steps.push({
        kind: 'lookTopDistribute',
        targeting: 'none',
        resolve: (game, ctx) => game.applyLookTopDistributeEffect(ctx, 3),
      });
      continue;
    }

    // "You may play the exiled card this turn" — the exiled-card half of the
    // clause above; already folded into applyLookTopDistributeEffect (which
    // puts it straight into hand instead), so this is just acknowledged.
    if (/^play the exiled card this turn$/.test(clause)) {
      continue;
    }

    // "Put one of them into your hand and the other on the bottom of your
    // library" (Sea Gate Oracle's simpler 2-card version of the same "look
    // at the top N" template above) — applyLookTopDistributeEffect(ctx, 2)
    // already produces exactly this shape (1 to hand, 1 to bottom) with no
    // changes needed, since its n=3 indexing degrades correctly to n=2.
    if (/^put one of them into your hand and the other on the bottom of your library$/.test(clause)) {
      steps.push({
        kind: 'lookTopDistribute',
        targeting: 'none',
        resolve: (game, ctx) => game.applyLookTopDistributeEffect(ctx, 2),
      });
      continue;
    }

    // "Return a creature/land you control to its owner's hand" (Whitemane
    // Lion's ETB drawback, and — for "land" — the whole bounce-land cycle:
    // "This land enters tapped. When this land enters, return a land you
    // control to its owner's hand." Boros Garrison, Dimir Aqueduct, and the
    // other 9 two-color Karoo lands all share this exact template) — no
    // "target" at all, a self-selected choice; see
    // applyBounceOwnPermanentEffect for the cheapest-first auto-pick, and
    // why only the land case excludes the source itself.
    if ((m = clause.match(/^return an? (creature|land|artifact|permanent) you control to its owner'?s hand$/))) {
      const typeWord = m[1];
      steps.push({
        kind: 'bounce',
        targeting: 'none',
        resolve: (game, ctx) => game.applyBounceOwnPermanentEffect(ctx, typeWord, { excludeSelf: typeWord === 'land' }),
      });
      continue;
    }

    // "Search your library for a Dinosaur card, reveal it, then shuffle and
    // put that card on top" (Forerunner of the Empire's own ETB, and
    // similar type-restricted tutor-to-TOP effects) — distinct from the
    // unrestricted put-into-hand tutor below in both the type restriction
    // and the destination. Same "no real target UI" simplification as
    // every other auto-pick here: grabs the first matching card found.
    if ((m = clause.match(/^search your library for an? ([\w\s]+?) card,? reveal it,? then shuffle and put that card on top/))) {
      const typeWord = m[1].trim().toLowerCase();
      steps.push({
        kind: 'tutorToTop',
        targeting: 'none',
        resolve: (game, ctx) => game.applyTutorToTopEffect(ctx, typeWord),
      });
      continue;
    }

    // Generic tutor: "Search your library for a card, put that card into
    // your hand, then shuffle." (Diabolic Tutor and many similar effects) —
    // no type restriction at all, unlike the land-specific fetch above.
    // Which card isn't a real target this engine's UI can prompt for — same
    // simplification already used for edict's "weakest creature" and
    // regrowth's "highest-cost card" auto-picks — grabs the library's
    // highest-cost card.
    if (/^search your library for a card,? put (?:it|that card) into your hand/.test(clause)) {
      steps.push({
        kind: 'tutor',
        targeting: 'none',
        resolve: (game, ctx) => game.applyTutorEffect(ctx),
      });
      continue;
    }

    if ((m = clause.match(/(target (?:player|opponent)|each opponent) discards (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) cards?/))) {
      // "target opponent" is forced (there's only one, in a 2-player game) —
      // same auto-resolve as "each opponent", no real targeting UI needed.
      // Only "target player" is a genuine choice (could be either player),
      // so that one alone still needs a real target.
      const autoOpponent = m[1] === 'each opponent' || m[1] === 'target opponent';
      const amount = parseAmount(m[2]);
      steps.push({
        kind: 'discard',
        amount,
        targeting: autoOpponent ? 'none' : 'player',
        resolve: (game, ctx) => game.applyDiscardEffect(
          autoOpponent ? { ...ctx, target: { type: 'player', id: game.opponentOf(ctx.controllerId).id } } : ctx,
          amount,
        ),
      });
      continue;
    }

    // "Traumatize"-style dynamic amount, checked first since it doesn't fit
    // the fixed "mills N cards" shape below at all. Accepts both "rounded
    // down" (Traumatize) and "rounded up" (Fleet Swallower).
    if ((m = clause.match(/(target player |target opponent |you )?mills? half (?:their|your) library,? rounded (down|up)/))) {
      const subject = (m[1] || '').trim();
      const roundUp = m[2] === 'up';
      const hasTarget = subject === 'target player' || subject === 'target opponent';
      steps.push({
        kind: 'mill',
        targeting: hasTarget ? 'player' : 'none',
        resolve: (game, ctx) => {
          const p = ctx.target?.type === 'player' ? game.getPlayer(ctx.target.id) : game.getPlayer(ctx.controllerId);
          const amount = roundUp ? Math.ceil(p.library.length / 2) : Math.floor(p.library.length / 2);
          game.applyMillEffect(ctx, amount);
        },
      });
      continue;
    }

    // "Each opponent reveals cards from the top of their library until
    // they reveal X land cards, then puts all cards revealed this way
    // into their graveyard." (Mind Grind) — a "reveal-until" mill shape,
    // genuinely different from every plain "mill N cards" pattern below
    // (the AMOUNT milled is however many cards it took to hit X lands, not
    // a fixed number) — this engine is strictly 2-player, so "each
    // opponent" is always just the one. Checked before the general mill
    // clause right below, whose own "mills N cards" shape doesn't match
    // this wording anyway, but specific-before-general is this file's own
    // convention. X comes from the spell's own {X} cost.
    if ((m = clause.match(/^each opponent reveals cards from the top of their library until they reveal (\d+|x) land cards?,?\s*then puts all cards revealed this way into their graveyard$/))) {
      const amountToken = m[1];
      steps.push({
        kind: 'millUntilLands',
        targeting: 'none',
        resolve: (game, ctx) => game.applyRevealUntilLandsMillEffect(ctx, resolveAmount(amountToken, ctx)),
      });
      continue;
    }

    // "X can't be 0" (Mind Grind's own casting restriction) — acknowledged
    // so it doesn't fall through as its own unsupported clause; not
    // enforced as an actual minimum-X casting restriction (this engine has
    // no general mechanism for a per-card minimum X value), same
    // "recognized, not enforced" simplification used for other rare
    // restrictions elsewhere.
    if (/^x can'?t be 0$/.test(clause)) {
      continue;
    }

    // "Exile the top card of each player's library, then you may cast any
    // number of spells from among those cards without paying their mana
    // costs." (Etali, Primal Storm's own attack trigger) — a genuinely
    // different shape from the single-opponent free-cast-from-graveyard
    // effect above: exiles from EVERY player's library (including the
    // caster's own), and may cast ANY NUMBER of the results, not just up
    // to one. No real "which ones, what order, what to target" choice UI,
    // so applyEtaliAttackTriggerEffect just tries every non-land result.
    if (/^exile the top card of each player'?s library,?\s*then you may cast any number of spells from among those cards without paying their mana costs$/.test(clause)) {
      steps.push({
        kind: 'etaliAttack',
        targeting: 'none',
        resolve: (game, ctx) => game.applyEtaliAttackTriggerEffect(ctx),
      });
      continue;
    }

    // "Defending player mills ten cards" (Nemesis of Reason's attack
    // trigger, and similar) — auto-resolves to the attacker's controller's
    // opponent, same as "each opponent"/"target opponent" do elsewhere;
    // only "target player" is a genuine choice needing a real target.
    if ((m = clause.match(/(target player |target opponent |each opponent |defending player |you )?mills? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+) cards?/))) {
      const subject = (m[1] || '').trim();
      const amount = parseAmount(m[2]);
      const autoOpponent = subject === 'each opponent' || subject === 'target opponent' || subject === 'defending player';
      const hasTarget = subject === 'target player';
      steps.push({
        kind: 'mill',
        amount,
        targeting: hasTarget ? 'player' : 'none',
        resolve: (game, ctx) => game.applyMillEffect(
          autoOpponent ? { ...ctx, target: { type: 'player', id: game.opponentOf(ctx.controllerId).id } } : ctx,
          amount,
        ),
      });
      continue;
    }

    // "Exile target creature you control, then return that card to the
    // battlefield under your/its owner's control" (Restoration Angel,
    // Momentary Blink, Ghostly Flicker, and the whole blink archetype) — an
    // IMMEDIATE combined exile-and-return, checked BEFORE the plain exile
    // pattern right below. That plain pattern's target-description capture
    // is unanchored and would otherwise greedily run all the way to the
    // word "that" INSIDE "return that card" later in the same clause,
    // producing a garbled target description and — much worse — silently
    // dropping the whole "return that card" half, so the exiled creature
    // would just vanish forever instead of blinking back.
    //
    // A leading "up to two"/"two" (real multi-target, tracked via
    // targetCount — see game.js's expandTargetKinds/resolveEffectSteps) is
    // a different shape from "up to one" (still a single optional target,
    // no plural tracking needed), so only "two"+ sets targetCount. Also
    // accepts the plural "those cards"/"them" return phrasing Ghostly
    // Flicker's real wording uses for its 2-target version, alongside the
    // existing singular "that card"/"it".
    if ((m = clause.match(/^exile (?:up to (\w+) |(two|three) )?(?:other |another )?target ([\w\s',/-]+?),? then return (?:that card|it|those cards|them) to the battlefield under (its owner'?s|their owner'?s|your) control$/))) {
      const countWord = m[1] || m[2];
      const targetCount = countWord ? parseAmount(countWord) : 1;
      const underCasterControl = m[4] === 'your';
      steps.push({
        kind: 'flicker',
        targeting: describeTargetKind('target ' + m[3]),
        // m[1] ("up to N") is a real choice of fewer targets — legal even
        // against an empty board. m[2] (a bare "two"/"three", no "up to")
        // is mandatory.
        ...(targetCount > 1 ? { targetCount, minTargets: m[1] ? 0 : targetCount } : {}),
        resolve: (game, ctx) => game.applyFlickerEffect(ctx, underCasterControl),
      });
      continue;
    }

    // "Exile target nonland permanent not named Detention Sphere and all
    // other permanents with the same name as that permanent" (Detention
    // Sphere) — a multi-target sibling of the single-card Oblivion Ring
    // pattern below; checked first since it needs its own tracking
    // (ctx.sourcePerm.exiledCards, a list) rather than the singular
    // exiledCard field the plain "exile target X" pattern pairs with.
    if ((m = clause.match(/^exile target nonland permanent not named [\w\s,'-]+ and all other permanents with the same name as that permanent$/))) {
      steps.push({
        kind: 'exile',
        targeting: 'permanent',
        resolve: (game, ctx) => game.applyExileWithSameNameEffect(ctx),
      });
      continue;
    }

    // "up to one other target creature" (Solitude-style), "exile another
    // target nonland permanent" (Oblivion Ring's own wording — "another"
    // before "target", not "other" after "exile"), as well as plain
    // "target X" — the "other"/"another" qualifiers are recognized but not
    // enforced (same simplification already made elsewhere for wording
    // this engine can't fully model, e.g. counterspell qualifiers). A
    // leading "up to two"/"two" (real multi-target, Angel of the Ruins/
    // Sylvan Reclamation/Protector of the Wastes's own "exile up to two
    // target artifacts and/or enchantments") sets targetCount — checked as
    // its own group rather than folded into the generic "up to \w+" swallow
    // this used to have, since that never captured a real count at all.
    // Character class includes a hyphen (a hyphenated qualifier like
    // "target non-Angel creature") and a slash ("artifacts and/or
    // enchantments" — without it the match failed outright, since a bare
    // "/" isn't a word/space/quote/hyphen character).
    if ((m = clause.match(/exile (?:up to (\w+) |(two|three) )?(?:other |another )?target ([\w\s',/-]+?)(?: that| unless| with|$)/))) {
      const targetCount = parseAmount(m[1] || m[2] || 'one');
      steps.push({
        kind: 'exile',
        targeting: describeTargetKind('target ' + m[3]),
        ...(targetCount > 1 ? { targetCount, minTargets: m[1] ? 0 : targetCount } : {}),
        resolve: (game, ctx) => game.applyExileEffect(ctx),
      });
      continue;
    }

    // Accepts a leading "up to two"/"two" count (Horses of the Bruinen,
    // Calamitous Tide, Hoverguard Sweepers's ETB, and many similar bounce
    // spells' "return up to two target creatures to their owners' hands")
    // — a real multi-target step (targetCount), plus the plural "owners'
    // hands" phrasing those cards use alongside the existing singular
    // "its/their owner's hand".
    if ((m = clause.match(/return (?:up to (\w+) |(two|three) )?target ([\w\s',-]+?) to (?:its owner'?s|their owner'?s|their owners'?) hands?/))) {
      const targetCount = parseAmount(m[1] || m[2] || 'one');
      steps.push({
        kind: 'bounce',
        targeting: describeTargetKind('target ' + m[3]),
        ...(targetCount > 1 ? { targetCount, minTargets: m[1] ? 0 : targetCount } : {}),
        resolve: (game, ctx) => game.applyBounceEffect(ctx),
      });
      continue;
    }

    // "Regrowth" effect: return a card from a graveyard to hand (Eternal
    // Witness, Regrowth itself, etc.) — a different zone/shape from the
    // battlefield-to-hand bounce above. Which card isn't a target this
    // engine's UI can prompt for (it's a graveyard choice, not a
    // permanent/player), so — same simplification already used for edict's
    // "weakest creature" auto-pick — it always grabs the graveyard's
    // highest-cost qualifying card. Accepts an optional type restriction
    // ("target instant or sorcery card" — Archaeomancer; "target creature
    // card", ...) ahead of the bare "card", defaulting to any nonland card
    // when no restriction is given.
    if ((m = clause.match(/return target (?:([\w\s]+?) )?card from (?:your|a|target player's) graveyard to (?:your|its owner's|their owner's) hand/))) {
      const typeWords = m[1] ? m[1].trim().toLowerCase().split(/\s+or\s+/) : null;
      steps.push({
        kind: 'regrowth',
        targeting: 'none',
        resolve: (game, ctx) => game.applyRegrowthEffect(ctx, typeWords),
      });
      continue;
    }

    // "Return it to your hand unless target opponent pays N life" (Athreos,
    // God of Passage's own dies trigger) — "it" is ctx.diedCard (the
    // creature that just died, threaded from triggerDies), and the "unless
    // ... pays" tax is a real choice this engine doesn't model as an AI
    // decision, so — same "may" simplification used everywhere else — the
    // opponent never actually pays, and the creature always comes back.
    if (/^return it to (?:your|their) hand unless target opponent pays \d+ life$/.test(clause)) {
      steps.push({
        kind: 'regrowth',
        targeting: 'none',
        resolve: (game, ctx) => game.applyReturnDiedCardToHandEffect(ctx),
      });
      continue;
    }

    if ((m = clause.match(/(target (?:player|opponent)|each opponent|each other player) sacrifices? a creature/))) {
      // Same auto-resolve as the discard clause above: "target opponent" is
      // forced in a 2-player game, only "target player" is a real choice.
      // "Each other player" (Grave Pact, Dictate of Erebos) means the same
      // thing as "each opponent" in this engine's always-2-player games.
      const autoOpponent = m[1] === 'each opponent' || m[1] === 'target opponent' || m[1] === 'each other player';
      steps.push({
        kind: 'edict',
        targeting: autoOpponent ? 'none' : 'player',
        resolve: (game, ctx) => game.applyEdictEffect(
          autoOpponent ? { ...ctx, target: { type: 'player', id: game.opponentOf(ctx.controllerId).id } } : ctx,
        ),
      });
      continue;
    }

    // "Create X Treasure tokens, where X is the number of artifacts and
    // enchantments your opponents control" (Dockside Extortionist, and
    // similar dynamic-count token makers) — checked before the fixed-amount
    // pattern below since "x" isn't a number word it understands.
    if ((m = clause.match(/^create x treasure tokens?,? where x is the number of ([\w\s]+?) (your opponents?|you) control/))) {
      const typeWords = m[1].split(/\s+and\s+/).map(w => w.trim().replace(/s$/, '').toLowerCase());
      const isOpponent = /opponent/.test(m[2]);
      steps.push({
        kind: 'treasureToken',
        targeting: 'none',
        resolve: (game, ctx) => {
          const countPlayer = isOpponent ? game.opponentOf(ctx.controllerId) : game.getPlayer(ctx.controllerId);
          const count = countPlayer.battlefield.filter(p => {
            const tl = p.card.typeLine.toLowerCase();
            return typeWords.some(t => tl.includes(t));
          }).length;
          game.applyTreasureTokenEffect(ctx, count);
        },
      });
      continue;
    }

    // "Create that many Treasure tokens" (Old Gnawbone's own "whenever a
    // creature you control deals combat damage to a player" trigger) —
    // "that many" is ctx.combatDamageAmount (see game.js's
    // triggerCombatDamageToPlayer), same dynamic-amount convention used
    // elsewhere for combat-damage payoffs. Checked before the fixed-amount
    // Treasure pattern below since "that many" isn't a parseAmount token.
    if (/^create that many treasure tokens?$/.test(clause)) {
      steps.push({
        kind: 'treasureToken',
        targeting: 'none',
        resolve: (game, ctx) => game.applyTreasureTokenEffect(ctx, ctx.combatDamageAmount || 0),
      });
      continue;
    }

    // Treasure tokens (Ragavan, Goldspan Dragon, countless others) — a
    // non-creature artifact token, so it needs its own shape from the P/T
    // creature-token pattern below. The token itself gets a real, usable
    // "{T}, Sacrifice: Add one mana of any color" ability via
    // interpretNonTapAbilities, same as any other permanent's oracle text.
    if ((m = clause.match(/create (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (tapped )?treasure tokens?/))) {
      const amount = parseAmount(m[1]);
      const tapped = !!m[2];
      steps.push({
        kind: 'treasureToken',
        amount,
        targeting: 'none',
        resolve: (game, ctx) => game.applyTreasureTokenEffect(ctx, amount, { tapped }),
      });
      continue;
    }

    // "Investigate" (Thraben Inspector, and the whole Clue-making keyword
    // action) — shorthand for "create a Clue token", spelled out in its own
    // reminder text.
    if (/^investigate$/.test(clause)) {
      steps.push({
        kind: 'clueToken',
        targeting: 'none',
        resolve: (game, ctx) => game.applyClueTokenEffect(ctx, 1),
      });
      continue;
    }

    // "Create a Clue token" / "create N Clue tokens" (spelled out directly,
    // rather than via the Investigate keyword action above).
    if ((m = clause.match(/create (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) clue tokens?/))) {
      const amount = parseAmount(m[1]);
      steps.push({
        kind: 'clueToken',
        amount,
        targeting: 'none',
        resolve: (game, ctx) => game.applyClueTokenEffect(ctx, amount),
      });
      continue;
    }

    // "Create a Food token" / "create N Food tokens".
    if ((m = clause.match(/create (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) food tokens?/))) {
      const amount = parseAmount(m[1]);
      steps.push({
        kind: 'foodToken',
        amount,
        targeting: 'none',
        resolve: (game, ctx) => game.applyFoodTokenEffect(ctx, amount),
      });
      continue;
    }

    // "Scry N" — a safe, rules-legal no-op simplification: this engine has
    // no evaluation heuristic for "is the top card worth keeping or
    // bottoming", so it always resolves as if every look chose to keep the
    // card on top (a real, always-legal choice for scry), rather than
    // guessing at library reordering. Recognized so the ability isn't
    // silently flagged unsupported; genuinely no library state changes.
    if ((m = clause.match(/^scry (\d+|a|an|one|two|three)$/))) {
      const amount = parseAmount(m[1]);
      steps.push({
        kind: 'scry',
        targeting: 'none',
        resolve: (game, ctx) => game.log(`${ctx.card.name} scries ${amount}.`),
      });
      continue;
    }

    // "If you control seven or more Plains, you may return target creature
    // card from your graveyard to the battlefield" (Emeria, the Sky Ruin)
    // — a conditional upkeep trigger combined with the same "no real which-
    // card UI" reanimation simplification as Karmic Guide/Sun Titan.
    if (/^if you control seven or more plains,? (?:you may )?return target creature card from your graveyard to the battlefield$/.test(clause)) {
      steps.push({
        kind: 'reanimate',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          const plainsCount = controller.battlefield.filter(p => (p.card.typeLine || '').toLowerCase().includes('plains')).length;
          if (plainsCount >= 7) game.applyReanimateFromOwnGraveyardEffect(ctx, { typeWord: 'creature' });
        },
      });
      continue;
    }

    // Return of the Wildspeaker's two modes: a dynamic draw sized by the
    // single highest power among a type-EXCLUDED creature set ("non-Human"),
    // and the pump equivalent — a different shape from every other mass
    // pump/draw pattern here, which all filter FOR a type rather than
    // excluding one.
    if ((m = clause.match(/^draw cards equal to the greatest power among non-(\w+) creatures you control$/))) {
      const excludedType = m[1];
      steps.push({
        kind: 'draw',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          const qualifying = controller.battlefield.filter(p => game.isCreature(p.card) && !(p.card.typeLine || '').toLowerCase().includes(excludedType));
          const maxPower = qualifying.reduce((max, p) => Math.max(max, game.effectivePower(p)), 0);
          game.applyDrawEffect(ctx, maxPower);
        },
      });
      continue;
    }

    // Same "greatest power" draw as Return of the Wildspeaker above, but
    // with no type exclusion at all (Rishkar's Expertise's first mode-like
    // clause — its own second sentence, "cast a spell with mana value 5 or
    // less for free", isn't modeled).
    if (/^draw cards equal to the greatest power among creatures you control$/.test(clause)) {
      steps.push({
        kind: 'draw',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          const maxPower = controller.battlefield.filter(p => game.isCreature(p.card)).reduce((max, p) => Math.max(max, game.effectivePower(p)), 0);
          game.applyDrawEffect(ctx, maxPower);
        },
      });
      continue;
    }
    if ((m = clause.match(/^non-(\w+) creatures you control get ([+-]\d+)\/([+-]\d+) until end of turn$/))) {
      const excludedType = m[1];
      const power = parseInt(m[2], 10), toughness = parseInt(m[3], 10);
      steps.push({
        kind: 'pump',
        targeting: 'none',
        resolve: (game, ctx) => {
          const controller = game.getPlayer(ctx.controllerId);
          for (const perm of controller.battlefield) {
            if (game.isCreature(perm.card) && !(perm.card.typeLine || '').toLowerCase().includes(excludedType)) perm.tempBuffs.push({ power, toughness });
          }
        },
      });
      continue;
    }

    // "Create a 2/2 white Cat creature token for each Equipment attached to
    // Kemba" (Kemba, Kha Regent, and similar self-attachment-count token
    // makers) — checked before the fixed-amount pattern below, whose "a"
    // would otherwise be parsed as a literal amount of 1 and silently
    // ignore the "for each ..." qualifier entirely. Card's own name is
    // already normalized to "this creature" by interpretPhaseTriggers.
    if ((m = clause.match(/^create an? (\d+)\/(\d+) ([\w\s]+?) creature tokens? for each ([\w\s]+?) attached to this (?:creature|permanent)$/))) {
      const power = parseInt(m[1], 10), toughness = parseInt(m[2], 10);
      const typeDesc = m[3].trim();
      const attachedTypeWord = m[4].trim().replace(/s$/, '').toLowerCase();
      steps.push({
        kind: 'token',
        power, toughness,
        targeting: 'none',
        resolve: (game, ctx) => {
          const count = game.countAttachedMatching(ctx.sourcePerm, attachedTypeWord);
          game.applyTokenEffect(ctx, count, power, toughness, typeDesc);
        },
      });
      continue;
    }

    // "Create a 1/1 colorless Thopter artifact creature token with flying
    // for each +1/+1 counter on this creature" (Hangarback Walker's own
    // dies trigger) — same "for each ..." dynamic-count shape as the
    // attached-permanent-count pattern just above, checked before the
    // fixed-amount pattern below for the same reason. The dying creature's
    // OWN perm object (ctx.sourcePerm) still has its real counters intact
    // when a dies trigger resolves — nothing clears them, it's just been
    // removed from the battlefield array by this point.
    if ((m = clause.match(/^create an? (\d+)\/(\d+) ([\w\s]+?) creature tokens?(?: with ([\w\s,]+))? for each \+1\/\+1 counter on (?:this creature|it)$/))) {
      const power = parseInt(m[1], 10), toughness = parseInt(m[2], 10);
      const typeDesc = m[3].trim();
      const keywordText = m[4] || null;
      steps.push({
        kind: 'token',
        power, toughness,
        targeting: 'none',
        resolve: (game, ctx) => {
          const count = ctx.sourcePerm?.counters?.['+1/+1'] || 0;
          if (count > 0) game.applyTokenEffect(ctx, count, power, toughness, typeDesc, keywordText);
        },
      });
      continue;
    }

    // Accepts an optional trailing "with flying"/"with haste"/etc. keyword
    // grant (Goblin Rabblemaster's own "1/1 red Goblin creature token with
    // haste", and the same template on plenty of other token generators —
    // Spectral Procession's "1/1 white Spirit creature token with flying")
    // — without this, the keyword was silently dropped: the clause still
    // matched and created the token, just as a vanilla creature, with no
    // "isn't modeled" log line to reveal the loss.
    if ((m = clause.match(/create (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (\d+)\/(\d+) ([\w\s]+?) creature tokens?(?: with ([\w\s,]+))?/))) {
      const amount = parseAmount(m[1]);
      const power = parseInt(m[2], 10), toughness = parseInt(m[3], 10);
      const typeDesc = m[4].trim();
      const keywordText = m[5] || null;
      steps.push({
        kind: 'token',
        amount, power, toughness,
        targeting: 'none',
        resolve: (game, ctx) => game.applyTokenEffect(ctx, amount, power, toughness, typeDesc, keywordText),
      });
      continue;
    }

    // Accepts a leading "up to two"/"two" count (Tamiyo, Field
    // Researcher's "-2: Tap up to two target nonland permanents", Scroll of
    // Isildur's Saga chapter II) — a real multi-target step (targetCount),
    // same as the counter-addition pattern above.
    if ((m = clause.match(/tap (?:up to (\w+) |(two|three) )?target ([\w\s',-]+?)(?: that| unless| with|$)/))) {
      const targetCount = parseAmount(m[1] || m[2] || 'one');
      steps.push({
        kind: 'tap',
        targeting: describeTargetKind('target ' + m[3]),
        ...(targetCount > 1 ? { targetCount, minTargets: m[1] ? 0 : targetCount } : {}),
        resolve: (game, ctx) => game.applyTapEffect(ctx, true),
      });
      continue;
    }

    if ((m = clause.match(/untap (?:up to (\w+) |(two|three) )?target ([\w\s',-]+?)(?: that| unless| with|$)/))) {
      const targetCount = parseAmount(m[1] || m[2] || 'one');
      steps.push({
        kind: 'untap',
        targeting: describeTargetKind('target ' + m[3]),
        ...(targetCount > 1 ? { targetCount, minTargets: m[1] ? 0 : targetCount } : {}),
        resolve: (game, ctx) => game.applyTapEffect(ctx, false),
      });
      continue;
    }

    // Self-referencing untap, e.g. "untap this creature" (Nettle Sentinel's
    // "whenever you cast a green spell, untap this creature", and similar
    // cast-trigger payoffs) — same self-target pattern as the pump/counter
    // clauses above, via ctx.sourcePerm. Also covers "untap this artifact"
    // (Grinding Station's own any-artifact-ETB trigger).
    if (/^untap this (?:creature|permanent|artifact|enchantment|land)$/.test(clause)) {
      steps.push({
        kind: 'untap',
        targeting: 'none',
        resolve: (game, ctx) => game.applyTapEffect({ ...ctx, target: { type: 'permanent', id: ctx.sourcePerm?.id } }, false),
      });
      continue;
    }

    // "Add {W} or {U}" (shocklands, checklands, painlands, battle lands,
    // and effectively every other dual land) — a REAL choice between two or
    // more specific colors, not the same shape as "Add {W}{U}" (both at
    // once) just below. Matching only the plain-symbols regex here would
    // silently grab just the first listed color every time and ignore the
    // "or ..." entirely — exactly the bug that made every dual land always
    // produce only its first color. Checked first so it wins over the
    // plain-multi-symbol regex below, which would otherwise match just the
    // leading "{W}" and stop there.
    if ((m = clause.match(/^add (\{[wubrgc]\}(?:,?\s*(?:or|and\/or)\s*\{[wubrgc]\})+)/i))) {
      const options = (m[1].toUpperCase().match(/\{[WUBRGC]\}/g) || []).map(s => MANA_SYMBOL_COLOR[s.slice(1, -1)]);
      steps.push({
        kind: 'mana',
        options,
        targeting: 'none',
        resolve: (game, ctx) => game.applyManaEffect(ctx, game.pickAnyColorChoice(ctx, options)),
      });
      continue;
    }

    // "Add {G} for each Elf you control" (Priest of Titania, Elvish
    // Archdruid, and the whole "mana dork tribal payoff" template) — the
    // amount depends on live board state, so it's counted at resolve time
    // rather than here. Checked BEFORE the fixed-symbol pattern below, which
    // would otherwise match just the leading "{G}" and silently ignore the
    // "for each ..." qualifier, producing exactly 1 mana instead of the
    // dynamic amount.
    if ((m = clause.match(/^add \{([wubrgc])\} for each ([\w\s]+?)(?: on the battlefield| you control)$/i))) {
      const color = MANA_SYMBOL_COLOR[m[1].toUpperCase()];
      const typeWord = m[2].trim().replace(/s$/, '').toLowerCase();
      const onlyYours = / you control$/i.test(clause);
      steps.push({
        kind: 'mana',
        colors: [color],
        targeting: 'none',
        resolve: (game, ctx) => game.applyDynamicManaEffect(ctx, color, typeWord, onlyYours),
      });
      continue;
    }

    // One or more explicit mana symbols in a row (Sol Ring's "Add {C}{C}",
    // a Karoo/bounce land's "Add {B}{R}" — both colors together, no choice
    // — "Add {R}{R}{R}", ...). Matching only the FIRST symbol here would
    // silently drop the rest — exactly the bug that made Sol Ring produce 1
    // mana instead of 2, quietly forcing the auto-tapper to tap an extra
    // land to make up the shortfall.
    if ((m = clause.match(/^add ((?:\{[wubrgc]\})+)/i))) {
      const colors = (m[1].toUpperCase().match(/\{[WUBRGC]\}/g) || []).map(s => MANA_SYMBOL_COLOR[s.slice(1, -1)]);
      steps.push({
        kind: 'mana',
        colors,
        targeting: 'none',
        resolve: (game, ctx) => { for (const c of colors) game.applyManaEffect(ctx, c); },
      });
      continue;
    }

    // "Add one/two/three mana of any [one] color" — the color-choice
    // equivalent of the above (a Treasure only ever makes one of these, but
    // some cards make more at once).
    if ((m = clause.match(/^add (a|an|one|two|three) mana of any(?: one)? color/i))) {
      const amount = parseAmount(m[1]);
      steps.push({
        kind: 'mana',
        amount,
        targeting: 'none',
        resolve: (game, ctx) => { for (let i = 0; i < amount; i++) game.applyManaEffect(ctx, game.pickAnyColorChoice(ctx)); },
      });
      continue;
    }
  }

  if (steps.length === 0) {
    steps.push({
      kind: 'unsupported',
      targeting: 'none',
      resolve: (game, ctx) => {
        game.log(`${ctx.card.name}'s effect isn't modeled in detail yet — it resolves with no game effect.`);
      },
    });
  }

  return steps;
}

// True if a set of effect steps amounts to "the regex interpreter didn't
// actually recognize anything here" — either no steps at all, or nothing but
// the interpretEffectText's own unsupported placeholder. Shared by all three
// interpret* functions below (and reused by the AI pre-analysis step in
// server/analyzeDeck.mjs) so "should this fall back to AI?" is answered the
// same way everywhere.
export function isFullyUnsupported(steps) {
  return steps.length === 0 || steps.every(s => s.kind === 'unsupported');
}

// Returns a descriptor of what targets (if any) this effect needs, plus a
// resolve() function that applies the effect once targets are chosen.
// `game` is passed in at resolve time so effects can touch live state.
// Detects modal spells ("Choose one —" / "Choose two —" text, one bullet
// per mode) and splits each bullet into its own effect steps. Returns null
// for a non-modal card. The caller (game.js) has the player/AI pick which
// mode(s) to use BEFORE casting — see castSpell's modeIndexes — since
// different modes can need entirely different targets, which has to be
// known before target collection starts, not after.
export function getSpellModes(card) {
  const text = card.oracleText || '';
  const header = text.match(/^choose (one|two|up to two|any number)(?: or both)?\s*—/im);
  if (!header) return null;
  const countWord = header[1].toLowerCase();
  const count = countWord === 'two' ? 2 : 1;
  const upTo = countWord.startsWith('up to') || countWord === 'any number';
  const modes = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('•'))
    .map(l => {
      const label = l.replace(/^•\s*/, '').trim();
      return { label, steps: interpretEffectText(label.toLowerCase()) };
    });
  return modes.length ? { count, upTo, modes } : null;
}

// modeIndexes selects which mode(s) of a modal spell to resolve (required
// for modal cards — see getSpellModes; ignored for non-modal ones).
export function interpretSpell(card, modeIndexes = null) {
  const modal = getSpellModes(card);
  if (modal) {
    const indexes = (modeIndexes && modeIndexes.length) ? modeIndexes : [0];
    return indexes.flatMap(i => modal.modes[i]?.steps || []);
  }
  const steps = interpretEffectText((card.oracleText || '').toLowerCase());
  if (isFullyUnsupported(steps)) {
    const aiSteps = getAISpellEffect(card);
    if (aiSteps) return aiSteps;
  }
  return steps;
}

// Scans a permanent's oracle text for "when(ever) ~ enters the battlefield,
// EFFECT" lines that trigger off the permanent itself (not off other
// permanents entering, which isn't modeled), and returns their effect steps.
export function interpretPermanentTriggers(card) {
  // Self-name normalization (Danitha, Benalia's Hope's own "...attached to
  // Danitha", and any other ETB effect that refers to itself by name in
  // the EFFECT BODY rather than just the trigger condition) — same
  // substitution every other self-referencing trigger interpreter in this
  // file already does before matching. Purely additive: a clause that
  // matched before still matches (nothing here already depended on the
  // card's own literal name surviving), and self-named effect bodies that
  // previously never matched anything now can.
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    // Accepts both older ("~ enters the battlefield, ...") and current
    // ("~ enters, ...") templating — Wizards dropped "the battlefield" from
    // ETB reminder text in 2023-era sets, and most modern cards use it —
    // plus the combined "enters or attacks" (Grave Titan) or "enters or
    // becomes monstrous" (Protector of the Wastes) condition; the
    // "attacks"/"becomes monstrous" half of either is separately
    // recognized by interpretAttackTriggers/interpretMonstrousTriggers
    // below, so a card like that fires on both events. Also accepts
    // "AS ~ enters, ..." (Herald's Horn's own "As this artifact enters,
    // choose a creature type.") — technically a replacement-effect-shaped
    // choice rather than a real triggered ability in the comprehensive
    // rules, but functionally the same "do this the moment it enters"
    // dispatch point for this engine's purposes.
    const m = line.match(/^(?:as|when(?:ever)?)\s+(.+?)\s+enters(?: the battlefield)?(?:\s+or\s+(?:attacks|becomes monstrous))?,\s*(.+)$/);
    if (!m) continue;
    if (/\banother\b/.test(m[1])) continue; // triggers off other permanents entering — not modeled
    steps.push(...interpretEffectText(m[2]));
  }
  if (isFullyUnsupported(steps)) {
    const aiSteps = getAIETBSteps(card);
    if (aiSteps) return aiSteps;
  }
  return steps;
}

// Returns an Equipment's "Equip {cost}" mana cost string (e.g. "{1}",
// "{2}"), or null if this card has no equip ability. A qualifier before the
// cost (rare, e.g. "Equip legendary creature {1}") is recognized but not
// enforced as a targeting restriction — same simplification this engine
// already makes for other target-restriction wording elsewhere.
export function interpretEquipCost(card) {
  const lines = (card.oracleText || '').split('\n').map(s => s.trim());
  for (const line of lines) {
    const m = line.match(/^equip(?:\s+[a-z\s]+?)?\s*(\{[^}]+\}(?:\{[^}]+\})*)$/i);
    if (m) return m[1];
  }
  return null;
}

// Scans a permanent's oracle text for any activated ability whose cost
// includes {T} — "{T}: EFFECT", "{T}, Sacrifice ~:", a fetchland's "{T}, Pay
// 1 life, Sacrifice ~:", or a mana cost listed BEFORE the tap symbol like
// Icy Manipulator's "{1}, {T}: ..." or a painland's "{1}, {T}: Add {B}{R}"
// — {T} can appear anywhere in the cost, not just first. Returns each as its
// own set of steps, with any real mana cost validated the same way
// interpretNonTapAbilities does (see isPayableManaSymbol) so an unrecognized
// symbol never becomes a silently-free cost — see activateTapAbility for
// where sacrifice/life-payment/mana are all actually charged.
export function interpretTapAbilities(card) {
  const lines = (card.oracleText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const abilities = [];
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (!m) continue;
    const costText = m[1];
    if (!/\{T\}/i.test(costText)) continue; // not a tap ability at all — interpretNonTapAbilities' territory
    const lowerCost = costText.toLowerCase();
    const sacrificeCost = /sacrifice/.test(lowerCost);
    const payLifeMatch = lowerCost.match(/pay (\d+) life/);
    const payLife = payLifeMatch ? parseInt(payLifeMatch[1], 10) : 0;
    const bracketed = costText.match(/\{[^}]+\}/g) || [];
    const manaCost = bracketed.filter(sym => sym.toUpperCase() !== '{T}' && isPayableManaSymbol(sym)).join('');
    const effectText = m[2];
    const steps = interpretEffectText(effectText.toLowerCase());
    abilities.push({ effectText, steps, isManaAbility: steps.some(s => s.kind === 'mana'), sacrificeCost, payLife, manaCost });
  }
  if (abilities.length === 0 || abilities.every(a => isFullyUnsupported(a.steps))) {
    const aiAbilities = getAITapAbilities(card);
    if (aiAbilities) return aiAbilities;
  }
  return abilities;
}

// Scans a planeswalker's oracle text for its loyalty abilities — "+1:
// EFFECT", "−2: EFFECT", "0: EFFECT" — a similar cost:effect line shape to
// the tap/non-tap ability interpreters below, but keyed on a loyalty
// change rather than tapping or paying mana. Scryfall's own printed minus
// sign is U+2212 (MINUS SIGN), not a plain hyphen, hence the character
// class rather than a literal "-". Only ever called on planeswalker
// permanents (see game.js's getLoyaltyAbilities), so there's no risk of
// misreading some other card's unrelated "N:" text as a loyalty cost.
export function interpretLoyaltyAbilities(card) {
  const lines = (card.oracleText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const abilities = [];
  for (const line of lines) {
    const m = line.match(/^([+−-]?\d+):\s*(.+)$/);
    if (!m) continue;
    const costText = m[1];
    const cost = /^[−-]/.test(costText) ? -parseInt(costText.slice(1), 10) : parseInt(costText.replace('+', ''), 10);
    const effectText = m[2];
    const steps = interpretEffectText(effectText.toLowerCase());
    abilities.push({ cost, effectText, steps });
  }
  return abilities;
}

// Scans a permanent's oracle text for activated abilities whose cost does
// NOT include {T} — "Sacrifice a creature: EFFECT" (Carrion Feeder),
// "{B}, Sacrifice a creature: EFFECT" (Attrition), or a flat mana cost with
// no tap at all ("{4}: EFFECT", Slimefoot). A meaningfully different
// activation shape from interpretTapAbilities: the source doesn't tap (so
// it stays usable even while attacking or already tapped), and a
// "sacrifice" cost needs a creature actually chosen and sacrificed rather
// than just a tapped flag flipped — see game.js's activateNonTapAbility.
export function interpretNonTapAbilities(card) {
  const lines = (card.oracleText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const abilities = [];
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (!m) continue;
    const costText = m[1].trim();
    if (/\{T\}/i.test(costText)) continue; // interpretTapAbilities' territory
    // Every {...} symbol actually extracted as a mana cost must be
    // something the mana system can charge (a number, X, C, a color pip,
    // or hybrid) — NOT e.g. a bare "{E}" (energy). parseManaCost silently
    // charges 0 for a symbol it doesn't recognize, so treating one as a
    // real mana cost would create a completely free, infinitely-repeatable
    // ability (this is exactly how a "Pay {E}{E}: ..." cost once caused a
    // real infinite-loop bug). Payable and non-payable symbols can appear
    // on the same line as a sacrifice cost (Attrition: "{B}, Sacrifice a
    // creature:"), so this filters rather than rejecting the whole line.
    const bracketed = costText.match(/\{[^}]+\}/g) || [];
    const payableSymbols = bracketed.filter(isPayableManaSymbol);
    const sacMatch = costText.match(/sacrifice (another creature|a creature|this creature|~)/i);
    // "Remove N [name] counters from this creature/permanent/it" (Thallid's
    // "Remove three spore counters from this creature: Create a Saproling",
    // and the same shape on any counter-accumulating threshold ability) — a
    // cost paid from the permanent's own counters, not mana or a sacrifice.
    const removeCountersMatch = costText.match(/remove (\d+|a|an|one|two|three|four|five) ([a-z]+) counters? from (?:this (?:creature|permanent)|it)/i);
    const manaCost = payableSymbols.join('');
    if (!manaCost && !sacMatch && !removeCountersMatch) continue; // doesn't look like a cost we recognize at all
    const effectText = m[2];
    const steps = interpretEffectText(effectText.toLowerCase());
    let sacrifice = null;
    if (sacMatch) sacrifice = /another/i.test(sacMatch[1]) ? 'other' : (/this|~/i.test(sacMatch[1]) ? 'self' : 'any');
    let removeCounters = null;
    if (removeCountersMatch) removeCounters = { amount: parseAmount(removeCountersMatch[1]), counterType: removeCountersMatch[2].toLowerCase() };
    abilities.push({ effectText, steps, isManaAbility: steps.some(s => s.kind === 'mana'), manaCost, sacrifice, removeCounters });
  }
  if (abilities.length === 0 || abilities.every(a => isFullyUnsupported(a.steps))) {
    const aiAbilities = getAINonTapAbilities(card);
    if (aiAbilities) return aiAbilities;
  }
  return abilities;
}

// Scans a CARD's (not a battlefield permanent's) oracle text for an ability
// activatable from the graveyard — "{cost}: Return this card from your
// graveyard to the battlefield[, tapped]." (Reassembling Skeleton and
// similar recursive threats). Mana cost validated the same way
// interpretNonTapAbilities does (see isPayableManaSymbol). Dispatched from
// game.js's graveyard-ability methods, which only ever check cards actually
// sitting in a player's graveyard — a card that ALSO happens to be on the
// battlefield already never reaches this (its graveyard copy is a distinct
// object).
export function interpretGraveyardAbilities(card) {
  const lines = (card.oracleText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const abilities = [];
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*return this card from your graveyard to the battlefield( tapped)?\.?$/i);
    if (!m) continue;
    const costText = m[1].trim();
    const bracketed = costText.match(/\{[^}]+\}/g) || [];
    const manaCost = bracketed.filter(isPayableManaSymbol).join('');
    if (!manaCost) continue;
    const sorcerySpeedOnly = /activate (?:this ability )?only as a sorcery/i.test(card.oracleText || '');
    abilities.push({ manaCost, tapped: !!m[2], sorcerySpeedOnly });
  }
  return abilities;
}

// Scans a permanent's oracle text for "whenever you cast a(n) [type] spell,
// EFFECT" triggers — e.g. "Whenever you cast a noncreature spell, put a
// +1/+0 counter on this creature." Unlike ETB triggers, these fire off an
// event happening elsewhere (a spell being cast, by anyone controlled by the
// same player), so game.js dispatches them explicitly from castSpell()
// rather than from a permanent entering. Effects here are expected to
// reference "this creature"/"this permanent" (self), which interpretEffectText
// already resolves via ctx.sourcePerm — see its "this creature gets ..." and
// "... on this creature" clauses above.
export function interpretCastTriggers(card) {
  // Self-name normalization (Edgar Markov's own "if Edgar is in the command
  // zone or on the battlefield, ..." condition, folded below) — same as the
  // tribal-ETB/sacrifice/phase/dies interpreters.
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const triggers = [];
  for (const line of lines) {
    // Accepts the "Eminence — " ability-word prefix (Edgar Markov, and the
    // whole Eminence mechanic — see game.js's triggerCastSpell, which is
    // the only place that knows whether to also check a commander sitting
    // in the command zone) the same way Landfall/Constellation are
    // accepted elsewhere, and "another" as an equivalent article to "a"/
    // "an" (Edgar's own "whenever you cast another Vampire spell"; no need
    // to specially exclude the source spell itself for this engine's
    // purposes). Character class includes commas so a multi-type list
    // (Sram, Senior Edificer's "an Aura, Equipment, or Vehicle spell")
    // doesn't silently fail to match at all — same comma-in-a-list bug
    // class fixed elsewhere for multi-type targeting (Bedevil).
    const m = line.match(/^(?:eminence\s*—\s*)?whenever you cast (?:a |an |another )?([\w\s,]*?)\s*spell,\s*(.+)$/);
    if (!m) continue;
    const eminence = /^eminence\s*—/.test(line);
    // "If this creature is in the command zone or on the battlefield,
    // EFFECT" — this condition IS the Eminence mechanic itself, already
    // enforced by which zones triggerCastSpell actually checks, so it's
    // just stripped here rather than parsed as a real conditional.
    const effectText = m[2].replace(/^if this creature is in the command zone or on the battlefield,\s*/, '');
    triggers.push({ filter: describeSpellFilter(m[1].trim()), eminence, steps: interpretEffectText(effectText) });
  }
  const allUnsupported = triggers.length === 0 || triggers.every(t => isFullyUnsupported(t.steps));
  if (allUnsupported) {
    const aiTriggers = getAICastTriggers(card);
    if (aiTriggers) return aiTriggers;
  }
  return triggers;
}

const SPELL_FILTER_COLORS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const SPELL_FILTER_KNOWN_TYPES = ['aura', 'equipment', 'vehicle', 'artifact', 'creature', 'enchantment', 'instant', 'sorcery'];

function describeSpellFilter(text) {
  if (!text) return null; // any spell
  // A comma/"or"-separated multi-type list (Sram, Senior Edificer's "an
  // Aura, Equipment, or Vehicle spell") — checked BEFORE the single-type
  // checks below, since e.g. "artifact, creature, or enchantment" would
  // otherwise get wrongly narrowed to JUST "creature" by the substring
  // check further down (it appears in the list, but isn't the whole
  // restriction). typeAny: matches if the cast card's type line contains
  // ANY of the listed subtypes/types.
  if (/,| or /.test(text)) {
    const words = text.split(/,|\bor\b/).map(w => w.trim()).filter(Boolean);
    const known = words.filter(w => SPELL_FILTER_KNOWN_TYPES.includes(w));
    if (known.length > 1) return `typeAny:${known.join('|')}`;
  }
  if (text.includes('noncreature')) return 'noncreature';
  if (text.includes('instant or sorcery')) return 'instantOrSorcery';
  if (text.includes('instant')) return 'instant';
  if (text.includes('sorcery')) return 'sorcery';
  if (text.includes('artifact')) return 'artifact';
  if (text.includes('enchantment')) return 'enchantment';
  if (text.includes('creature')) return 'creature';
  // "Whenever you cast a green spell" (Nettle Sentinel, and plenty of other
  // mono-color payoffs) — without this, describeSpellFilter fell through to
  // null ("any spell"), the same overtriggering bug already fixed for
  // "enchantment"/"artifact" spells.
  for (const [word, letter] of Object.entries(SPELL_FILTER_COLORS)) {
    if (text.includes(word)) return `color:${letter}`;
  }
  // Creature-type / tribal filter (Edgar Markov's "Vampire spell", and any
  // other "whenever you cast a [Type] spell" tribal payoff) — checked LAST
  // as the most permissive fallback, and only for a single bare word (a
  // multi-word leftover is more likely a phrase this doesn't understand
  // than a real creature type, so it stays "any spell" rather than
  // fabricating a bogus subtype filter).
  if (/^[a-z]+$/.test(text)) return `subtype:${text}`;
  return null;
}

// Classifies the "who does this trigger care about" qualifier shared by
// "dies" and "attacks" triggers — e.g. "this creature", "another creature
// you control", "a creature an opponent controls". Returned as one of:
// 'selfOnly', 'anyAny' (no restriction — includes self and any controller,
// e.g. Blood Artist's "this creature or another creature"), 'anyOwn'
// (same controller, includes self), 'otherOwn' (same controller, excludes
// self), 'opponent' (a different controller than the watcher's),
// 'attachedCreature' ("enchanted creature"/"equipped creature" — Ordeal of
// Heliod, and the same template on plenty of other Auras/Equipment; without
// this it fell through to 'anyAny' and fired for ANY creature attacking,
// not just the one actually enchanted/equipped). The dispatcher in game.js
// (ownerScopeMatches, plus a special case in triggerAttacks for
// 'attachedCreature' specifically) interprets these against whichever event
// actually happened.
function classifyOwnerScope(qualifier) {
  const q = qualifier.trim();
  if (/\b(?:enchanted|equipped) creature\b/.test(q)) return 'attachedCreature';
  // "this Aura"/"this artifact"/"this enchantment" (Rancor's own "when
  // this Aura is put into a graveyard..." self-bounce, and similar) are the
  // same self-reference as "this creature"/"this permanent" — just a more
  // specific type name. Missing these used to fall through to 'anyAny' and
  // treat the trigger as firing on literally any permanent's death.
  const mentionsThis = /\bthis (?:creature|permanent|aura|artifact|enchantment|equipment)\b/.test(q);
  const mentionsAnother = /\banother\b/.test(q);
  if (mentionsThis && !mentionsAnother) return 'selfOnly';
  if (/opponent/.test(q)) return 'opponent';
  // "you own" (Athreos, God of Passage's "another creature you own dies") is
  // treated the same as "you control" — this engine has no control-stealing
  // mechanic (see README's Known limitations), so ownerId and controllerId
  // always coincide in practice, making the two qualifiers equivalent here.
  if (/you (?:control|own)/.test(q)) return (mentionsAnother && !mentionsThis) ? 'otherOwn' : 'anyOwn';
  return 'anyAny'; // no controller restriction at all — e.g. "this creature or another creature", or a bare "a creature"
}

// What permanent TYPE a dies-trigger's qualifier restricts to (Disciple of
// the Vault only cares about artifacts dying, Blood Artist only creatures,
// ...) — a separate axis from classifyOwnerScope's controller-relationship.
// Needed because triggerDies now fires for every permanent type dying, not
// just creatures (see game.js's movePermanentToGraveyard), so something has
// to keep a creature-only trigger from also firing when an unrelated land
// or enchantment dies.
function classifyDyingType(qualifier) {
  const q = qualifier.toLowerCase();
  if (/\bartifact\b/.test(q)) return 'artifact';
  if (/\bcreature\b/.test(q)) return 'creature';
  if (/\benchantment\b/.test(q)) return 'enchantment';
  if (/\bplaneswalker\b/.test(q)) return 'planeswalker';
  if (/\bland\b/.test(q)) return 'land';
  if (/\bpermanent\b/.test(q)) return 'any'; // "this permanent", "a permanent" — no real restriction
  // A creature-type SUBTYPE restriction not covered by any broad category
  // above (Slimefoot, the Stowaway's "whenever a Saproling you control
  // dies", and any other tribally-restricted dies trigger) — without this,
  // "saproling"/"vampire"/etc. fell through to 'any' and fired on literally
  // every permanent's death, not just the named creature type's (the same
  // overtriggering bug class already fixed for cast-trigger color/subtype
  // filters). Extracts the bare noun and checks the dying permanent's own
  // type line for it directly.
  const noun = q.replace(/\b(?:this|another|an?|you control|opponents? control)\b/g, '').trim().replace(/s$/, '');
  if (noun && /^[a-z-]+$/.test(noun)) return `subtype:${noun}`;
  return 'any'; // a bare unqualified reference this couldn't parse at all
}

// Scans a permanent's oracle text for "when(ever) ~ dies, EFFECT" triggers
// (Blood Artist, Grave Pact, Meren's recursion engine, etc.) — a
// fundamentally common "aristocrats" pattern with no prior dispatch point
// in this engine at all before this. Also accepts the older "is put into a
// graveyard from the battlefield" wording (Disciple of the Vault predates
// the 2018 templating unification that renamed this to "dies" for every
// permanent type, not just creatures). Dispatched from game.js's
// movePermanentToGraveyard via triggerDies().
export function interpretDiesTriggers(card) {
  // Some dies triggers self-reference by printed name instead of "this
  // creature" (Yahenni, Undying Partisan's own "put a +1/+1 counter on
  // Yahenni") — same normalization as the tribal-ETB/sacrifice/phase
  // interpreters above.
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const triggers = [];
  for (const line of lines) {
    const m = line.match(/^when(?:ever)?\s+(.+?)\s+(?:dies|is put into a graveyard from the battlefield),\s*(.+)$/);
    if (!m) continue;
    triggers.push({ scope: classifyOwnerScope(m[1]), dyingType: classifyDyingType(m[1]), steps: interpretEffectText(m[2]) });
  }
  const allUnsupported = triggers.length === 0 || triggers.every(t => isFullyUnsupported(t.steps));
  if (allUnsupported) {
    const aiTriggers = getAIDiesTriggers(card);
    if (aiTriggers) return aiTriggers.map(t => ({ dyingType: 'any', ...t }));
  }
  return triggers;
}

// Scans a permanent's oracle text for "when(ever) ~ attacks, EFFECT"
// triggers (Goblin Guide) — also matches the common "enters or attacks"
// combined-condition wording (Grave Titan), so that half of the trigger is
// recognized here too (its "enters" half is separately recognized by
// interpretPermanentTriggers, which accepts the same "or attacks" suffix).
// Dispatched from game.js's declareAttackers via triggerAttacks().
export function interpretAttackTriggers(card) {
  // Self-name normalization (Aurelia, the Warleader's own "Whenever
  // Aurelia attacks...") — same as every other trigger interpreter above.
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const triggers = [];
  for (const line of lines) {
    // Accepts an optional "for the first/second/etc. time each turn"
    // qualifier AFTER "attacks" and before the comma (Aurelia's own
    // trigger) — without this the whole line failed to match at all, since
    // the regex previously required "attacks," immediately adjacent with
    // nothing in between. The qualifier itself isn't enforced (same
    // simplification made elsewhere for wording this engine can't fully
    // track, like "the first time" counters) — it just stops the line from
    // being silently unrecognized.
    const m = line.match(/^when(?:ever)?\s+(.+?)\s+(?:enters(?: the battlefield)?\s+or\s+)?attacks(?: for the \w+ time each turn)?,\s*(.+)$/);
    if (!m) continue;
    triggers.push({ scope: classifyOwnerScope(m[1]), steps: interpretEffectText(m[2]) });
  }
  const allUnsupported = triggers.length === 0 || triggers.every(t => isFullyUnsupported(t.steps));
  if (allUnsupported) {
    const aiTriggers = getAIAttackTriggers(card);
    if (aiTriggers) return aiTriggers;
  }
  return triggers;
}

// "When this creature enters or becomes monstrous, EFFECT" (Protector of
// the Wastes) — same mirrored-recognition idea as interpretAttackTriggers
// above for "enters or attacks": interpretPermanentTriggers's own trigger
// regex just needs to accept the compound condition syntactically (see its
// own comment), while THIS function independently recognizes the
// "becomes monstrous" half and turns it into steps, dispatched from
// game.js's applyMonstrosityEffect via triggerMonstrous (not from a fixed
// per-turn phase — this fires the moment Monstrosity is actually
// activated, a genuinely separate event from the STATIC "as long as
// monstrous" condition effectiveKeywords already handles elsewhere).
export function interpretMonstrousTriggers(card) {
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^when(?:ever)?\s+(.+?)\s+(?:enters(?: the battlefield)?\s+or\s+)?becomes monstrous,\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[2]));
  }
  return steps;
}

// Scans a permanent's oracle text for "when(ever) ~ deals combat damage to
// a player, EFFECT" (Ragavan's whole plan, plus lots of similar aggressive
// value creatures) — almost always self-referential ("this creature" or the
// card's own name), so classifyOwnerScope handles it the same way the dies/
// attacks triggers above do. Dispatched from game.js's dealCombatDamageWave
// via triggerCombatDamageToPlayer().
export function interpretCombatDamageTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const triggers = [];
  // Nightveil Specter's own shape: the triggered ability itself only says
  // "that player exiles the top card of their library" (a single, otherwise
  // bare sentence, since "You may play lands and cast spells from among
  // cards exiled with this creature" is a SEPARATE static-ability line, not
  // part of the trigger's own text) — so the actual play PERMISSION has to
  // be detected across the two lines rather than within one trigger's own
  // text, unlike every other multi-sentence combo in interpretEffectText.
  // Modeled as the same exile-and-play mechanism Ragavan uses, but with no
  // "until end of turn"-style expiration at all — a documented
  // simplification (real rules end the permission once this creature
  // itself leaves the battlefield; this engine just leaves already-exiled
  // cards playable for the rest of the game instead of tracking that).
  const hasPersistentExilePlayPermission = lines.some(l => /you may play lands and cast spells from among cards exiled with (?:this creature|~)/.test(l));
  for (const line of lines) {
    const m = line.match(/^when(?:ever)?\s+(.+?)\s+deals combat damage to a player,\s*(.+)$/);
    if (!m) continue;
    let steps = interpretEffectText(m[2]);
    if (hasPersistentExilePlayPermission && /^that player exiles the top card of (?:their|your) library\.?$/.test(m[2].trim())) {
      steps = [{
        kind: 'exileAndPlay',
        targeting: 'none',
        resolve: (game, ctx) => game.applyExileAndPlayEffect(ctx, { fromOpponent: true, persistent: true }),
      }];
    }
    triggers.push({ scope: classifyOwnerScope(m[1]), steps });
  }
  const allUnsupported = triggers.length === 0 || triggers.every(t => isFullyUnsupported(t.steps));
  if (allUnsupported) {
    const aiTriggers = getAICombatDamageTriggers(card);
    if (aiTriggers) return aiTriggers;
  }
  return triggers;
}

// "At the beginning of your upkeep/end step, EFFECT" — also accepts "each
// upkeep"/"each end step" wording, but (a safe simplification) only ever
// fires it during the permanent's own controller's step, not an
// opponent's, so a card worded that way just fires less often than the
// real card rather than at the wrong time or for the wrong player.
// Dispatched from game.js's runStepEntryActions via triggerPhase().
function interpretPhaseTriggers(card, phraseWord, aiFallbackFn) {
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(new RegExp(`^at the beginning of (?:your|each) ${phraseWord},\\s*(.+)$`));
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  if (isFullyUnsupported(steps)) {
    const aiSteps = aiFallbackFn(card);
    if (aiSteps) return aiSteps;
  }
  return steps;
}

export function interpretUpkeepTriggers(card) {
  return interpretPhaseTriggers(card, 'upkeep', getAIUpkeepTriggers);
}

// "At the beginning of enchanted player's upkeep, EFFECT" (Curse of the
// Pierced Heart, and the "Enchant player" Curse cycle generally) — a
// DIFFERENT upkeep event from interpretUpkeepTriggers above, which fires
// on the AURA'S CONTROLLER's own upkeep: this instead fires on whichever
// player the Curse is attached to, almost always someone else's turn.
// Dispatched from game.js's triggerEnchantedPlayerUpkeep.
export function interpretEnchantedPlayerUpkeepTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^at the beginning of enchanted player'?s upkeep,\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

// "Whenever enchanted player is attacked, EFFECT. Each opponent attacking
// that player does the same." (Curse of Opulence, Curse of Vitality,
// Curse of Bounty, and the same cycle) — fires once per combat when the
// enchanted player is attacked. The "each opponent... does the same" half
// is a multiplayer-only nuance (a strictly 2-player engine only ever has
// one possible attacker, already covered by the base clause resolving for
// the Curse's own controller) — acknowledged, not modeled separately; the
// lazy capture below just stops at the first period, leaving that trailing
// sentence (worded differently card-to-card — "does the same" vs. its own
// spelled-out repeat) unconsumed rather than needing to match it exactly.
// Dispatched from game.js's declareAttackers.
export function interpretEnchantedPlayerAttackedTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^whenever enchanted player is attacked,\s*(.+?)\./);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

export function interpretEndStepTriggers(card) {
  return interpretPhaseTriggers(card, 'end step', getAIEndStepTriggers);
}

// "At the beginning of combat on your turn, EFFECT" (Goblin Rabblemaster,
// and similar) — a differently-worded trigger point from the upkeep/end-
// step template above ("combat on your turn" rather than "your combat"),
// so it gets its own small interpreter rather than reusing
// interpretPhaseTriggers. Dispatched from game.js's runStepEntryActions on
// entering the 'beginCombat' step. No AI-cache fallback wired (same as
// interpretDrawTriggers below — the offline cache has no "beginning of
// combat" event shape to match against).
export function interpretBeginCombatTriggers(card) {
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^at the beginning of combat on your turn,\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

// "Whenever you attack, EFFECT" (Ranger Class's own level-2 ability, and
// similar) — a PLAYER-level trigger, genuinely different from
// interpretAttackTriggers' "whenever [this creature] attacks" shape: it
// fires exactly ONCE per combat the moment any attackers are declared,
// regardless of how many, rather than once per individual attacking
// creature. Dispatched from game.js's declareAttackers, once, after
// attackers are declared (not per-creature like triggerAttacks).
export function interpretWhenYouAttackTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^whenever you attack,\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

// "At the beginning of your draw step, if this artifact is tapped, it
// deals 1 damage to you." (Mana Vault, Grim Monolith, and similar
// fast-mana artifacts) — a genuinely new trigger dispatch point (there was
// previously no draw-step hook at all, only upkeep/end-step). No
// AI-cache fallback wired (same as interpretBeginCombatTriggers above —
// the offline cache has no "draw step" event shape to match against).
export function interpretDrawStepTriggers(card) {
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^at the beginning of (?:your|each) draw step,\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

// Three more self-referential trigger shapes, each dispatched from a
// specific game.js action rather than through the dies/attacks-style
// owner-scope machinery (all of these only ever mean "MY controller did X"
// or "something happened TO me specifically" — no cross-controller scope to
// classify). No AI-cache fallback wired for these (the offline cache has no
// "draw"/"counter placed"/"becomes target" event shape to match against
// anyway) — an unrecognized card here just resolves as a no-op, same as
// everywhere else in this engine.

// "Whenever you draw a card, EFFECT" (Fathom Mage and similar). Dispatched
// from game.js's drawCard via triggerDrawCard() — never for the silent
// opening-hand draw, which isn't a real "draw" event under the rules.
export function interpretDrawTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^when(?:ever)? you draws? a card,\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

// "Whenever a counter is put on this creature/permanent, EFFECT" — a
// triggered payoff for counters landing on THIS SPECIFIC permanent (not a
// static doubler like Hardened Scales, which isn't a trigger at all).
// Dispatched from game.js's counter-adding methods via
// triggerCounterAdded().
export function interpretCounterAddedTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^when(?:ever)? (?:a|one or more) counters? (?:is|are) put on this (?:creature|permanent),\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

// The Ward keyword's own cost — "Ward {2}" (a mana cost) or "Ward—Pay 2
// life" (a life cost), the tax an OPPONENT must pay when targeting this
// permanent with a spell, or have that spell countered (see game.js's
// checkWardAndMaybeCounter). Scryfall's own oracle_text for a keyword
// ability usually omits its reminder text, so this line is typically just
// the bare "Ward {N}"/"Ward—Pay N life", not the full "(Whenever this
// creature becomes the target...)" sentence. Returns null if the card has
// no Ward line at all, or its cost is some rarer shape (e.g. "Ward—Sacrifice
// a creature") this doesn't try to parse.
// "Kicker {2}{G}" — an optional additional cost paid AT CAST TIME that a
// later ETB trigger can key off ("if it was kicked, ..." — see game.js's
// castSpell `kicked` parameter and the resulting permanent's own
// `wasKicked` flag). Returns the kicker cost string (e.g. "{2}{G}"), or
// null if the card has no Kicker at all. Doesn't handle a card with
// multiple DIFFERENT kicker costs (rare) — just the first one found.
export function getKickerCost(card) {
  const m = (card.oracleText || '').match(/kicker\s+((?:\{[^}]+\})+)/i);
  return m ? m[1] : null;
}

// "Flashback {2}{R}" — an alternative cost to cast this card from the
// GRAVEYARD instead of the hand (see game.js's castFromGraveyard). Returns
// the flashback cost string, or null if the card has no Flashback at all.
export function getFlashbackCost(card) {
  const m = (card.oracleText || '').match(/flashback\s+((?:\{[^}]+\})+)/i);
  return m ? m[1] : null;
}

// "Escape—{3}{G}{U}, Exile five other cards from your graveyard." — another
// alternative cast-from-graveyard cost (Uro, Titan of Nature's Wrath; Kroxa,
// Titan of Death's Hunger), this time with a real additional cost (exiling
// N OTHER graveyard cards) alongside the mana. Returns
// { manaCost, exileCount }, or null if the card has no Escape line.
// "Ninjutsu {1}{U}" or "Commander ninjutsu {U}{B}" (Yuriko, the Tiger's
// Shadow's own variant, which also allows casting from the command zone —
// that half isn't modeled, see game.js's activateNinjutsu) — a special
// action usable during the declare-blockers step, not a normal activated
// ability on the battlefield or a spell on the stack. Returns the mana
// cost string, or null if the card has no Ninjutsu at all.
export function getNinjutsuCost(card) {
  const m = (card.oracleText || '').match(/(?:commander )?ninjutsu\s+((?:\{[^}]+\})+)/i);
  return m ? m[1] : null;
}

export function getEscapeCost(card) {
  const m = (card.oracleText || '').match(/escape\s*[—-]\s*((?:\{[^}]+\})+),\s*exile (\w+) other cards? from your graveyard\.?/i);
  if (!m) return null;
  return { manaCost: m[1], exileCount: parseAmount(m[2]) };
}

// "This creature enters with X +1/+1 counters on it" (Hangarback Walker's
// own X-based count) or "...with four +1/+1 counters on it" (Kalonian
// Hydra's fixed one) — a replacement of how the permanent enters, not a
// "when ~ enters" trigger (a genuinely different construction — no
// "when"/"whenever" at all), so it isn't picked up by
// interpretPermanentTriggers at all; game.js's resolveTop checks this
// directly and applies the counters BEFORE the state-based-action check
// that follows (Hangarback Walker's own printed 0/0 base stats need those
// counters in place to survive at all if X > 0). Returns { isX: true } or
// { amount: N }, or null if the card has no such line.
export function getEntersWithCounterCount(card) {
  const m = (card.oracleText || '').match(/this creature enters with (x|a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) \+1\/\+1 counters? on it/i);
  if (!m) return null;
  const token = m[1].toLowerCase();
  return token === 'x' ? { isX: true } : { amount: parseAmount(token) };
}

export function getWardCost(card) {
  const lines = (card.oracleText || '').split('\n').map(s => s.trim());
  for (const line of lines) {
    const m = line.match(/^ward\s*[—-]?\s*(.+)$/i);
    if (!m) continue;
    const rest = m[1].trim();
    const lifeMatch = rest.match(/pay (\d+) life/i);
    if (lifeMatch) return { life: parseInt(lifeMatch[1], 10) };
    const manaCost = (rest.match(/\{[^}]+\}/g) || []).join('');
    if (manaCost) return { manaCost };
    return null;
  }
  return null;
}

// "As an additional cost to cast this spell, pay X life." (Toxic Deluge,
// and similar) — X here is a value chosen INDEPENDENTLY of the spell's own
// mana cost (Toxic Deluge's own cost, {2}{B}, has no {X} in it at all), so
// it needs its own detection separate from parseManaCost's own `.x` count.
// Used by game.js's castSpell to charge life instead of (or alongside) the
// usual mana payment, and by play.js/ai.js to know a card needs an X
// choice even though its printed mana cost doesn't mention one.
export function hasLifePaymentXCost(card) {
  return /as an additional cost to cast this spell,? pay x life/i.test(card.oracleText || '');
}

// "Whenever this creature/permanent becomes the target of a spell, EFFECT."
// Dispatched from game.js's castSpell/castCommander via
// triggerBecomesTarget() for each permanent target a newly-cast spell has.
export function interpretBecomesTargetTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^when(?:ever)? this (?:creature|permanent) becomes the target of a spell,\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

// "Whenever a Dinosaur you control enters, EFFECT" (Forerunner of the
// Empire, and the same common "tribal ETB" shape on lots of other
// tribal-deck payoffs) — self-referential to the WATCHER's own controller.
// Also accepts the "Constellation — " ability-word prefix (Setessan
// Champion, and the whole Theros enchantment-matters mechanic) the same way
// interpretLandfallTriggers accepts "Landfall — ", the self-inclusive "this
// creature or another [Type] you control enters" phrasing (Eidolon of
// Blossoms), and the bare "another [Type] you control enters" phrasing
// (Marwyn, the Nurturer's "whenever another Elf you control enters") — the
// last of these is EXCLUSIVE of the watcher's own ETB (Marwyn shouldn't
// trigger off her own arrival), unlike every other wording here, hence the
// separate excludesSelf flag threaded through to game.js's triggerTribalEtb
// dispatch, which is the only place that knows whether the watcher IS the
// permanent that just entered. Uses "an?" rather than a literal "a " so
// vowel-led type words ("an enchantment", "an artifact") actually match —
// "a " alone silently missed every one of those. Also normalizes the card's
// own name in the effect text to "this creature" first (Marwyn's own "put a
// +1/+1 counter on Marwyn" — see replaceSelfName), since a name-only
// self-reference wouldn't otherwise resolve to anything. Excludes "land"
// specifically, since "a land you control enters" is Landfall's own
// distinct wording/dispatch point (interpretLandfallTriggers below), not a
// creature type — without this exclusion both would fire for the same
// line. Dispatched from game.js's triggerTribalEtb(), piggybacked onto the
// same "a permanent entered" moment as ordinary ETB triggers.
export function interpretTribalEtbTriggers(card) {
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    // Accepts an optional "with KEYWORD" qualifier between "you control"
    // and "enters" (Dragon Tempest's own "a creature you control WITH
    // FLYING enters") — without it, this line failed to match at all (not
    // just losing the keyword filter), since "you control" was previously
    // required to sit directly against "enters" with nothing between them.
    // Enforced by triggerTribalEtb checking the entering permanent's
    // effective keywords, not just its type line.
    const m = line.match(/^(?:constellation\s*—\s*)?when(?:ever)?\s+(this creature or another|another|an?)\s+([\w\s]+?) you control(?: with ([\w\s]+?))? enters(?: the battlefield)?,\s*(?:you may )?(.+)$/);
    if (!m || m[2].trim() === 'land') continue;
    results.push({ typeWord: m[2].trim(), keywordFilter: m[3] ? m[3].trim() : null, excludesSelf: m[1] === 'another', steps: interpretEffectText(m[4]) });
  }
  return results;
}

// "Whenever an artifact enters, you may untap this artifact." (Grinding
// Station) — unlike interpretTribalEtbTriggers just above, there's no "you
// control" qualifier at all, so this watches literally ANY player's
// matching permanent entering. Dispatched from game.js's triggerAnyEtb,
// which (also unlike triggerTribalEtb) scans every player's battlefield
// for a watcher, not just the entering permanent's own controller's.
// Explicitly excludes any qualifier that DOES say "you control" — that
// shape is interpretTribalEtbTriggers' own territory (a card can't be
// handled by both without double-firing on the watcher's own permanents
// entering).
export function interpretAnyEtbTriggers(card) {
  const lines = replaceSelfName(card, card.oracleText || '', 'this creature').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    const m = line.match(/^when(?:ever)? an? ([\w\s]+?) enters(?: the battlefield)?,\s*(?:you may )?(.+)$/);
    if (!m || m[1].trim() === 'land' || /you control/.test(m[1])) continue;
    results.push({ typeWord: m[1].trim(), steps: interpretEffectText(m[2]) });
  }
  return results;
}

// "Landfall — Whenever a land you control enters, EFFECT" (Hedron Crab and
// the whole landfall mechanic) — self-referential to the WATCHER's own
// controller (only fires when THEIR OWN land enters). Strips the optional
// "Landfall — " ability-word prefix modern oracle text keeps, which — being
// at the very start of the line — would otherwise break every other
// "whenever ~ enters" regex's `^when` anchor and make landfall cards
// silently invisible (not even flagged as "unsupported", just never
// looked at). Dispatched from game.js's triggerLandfall() wherever a land
// actually enters the battlefield (playing one, or any fetch effect).
// Returns one entry per matching line: { scope, steps }. scope is 'opponent'
// for Sire of Stagnation's own "whenever a land AN OPPONENT CONTROLS
// enters" wording, 'own' for the overwhelmingly more common "a land you
// control enters" (or the unqualified "a land enters", read the same way —
// real landfall cards always mean their own lands unless they say
// "opponent"). Returning per-line entries (rather than one flat steps
// array, as before) lets a card mix both scopes correctly, though no real
// card does that today.
export function interpretLandfallTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^(?:landfall\s*—\s*)?when(?:ever)? a land(?: (you control|an opponent controls))? enters(?: the battlefield)?(?: under your control)?,\s*(.+)$/);
    if (!m) continue;
    entries.push({ scope: m[1] === 'an opponent controls' ? 'opponent' : 'own', steps: interpretEffectText(m[2]) });
  }
  return entries;
}

// "When this [enchantment/permanent] leaves the battlefield, EFFECT"
// (Oblivion Ring, Journey to Nowhere, ...) — self-only, dispatched from
// game.js's triggerLeavesBattlefield() wherever a permanent actually leaves
// (graveyard, exile, bounce).
export function interpretLeavesTriggers(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^when(?:ever)? this (?:enchantment|permanent) leaves the battlefield,\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Some real cards word a self-referencing effect using their own printed
// name instead of "this creature"/"this permanent" (Korvold's "put a
// +1/+1 counter on Korvold", Marwyn's "put a +1/+1 counter on Marwyn") —
// and oracle text commonly self-references using just the short name
// before a comma, not the full legendary title — so both forms are
// normalized to `replacement` here, the same substitution a player makes
// mentally when reading their own card. Shared by every trigger interpreter
// that needs this (sacrifice, tribal-ETB, ...).
function replaceSelfName(card, text, replacement) {
  const shortName = card.name.split(',')[0].trim();
  const namePattern = new RegExp(`\\b(?:${escapeRegExp(card.name)}|${escapeRegExp(shortName)})\\b`, 'gi');
  return text.replace(namePattern, replacement);
}

// "Whenever you sacrifice a permanent/creature/artifact, EFFECT" (Korvold,
// Fae-Cursed King's payoff, Blood Artist-adjacent aristocrats payoffs, ...).
// Dispatched from game.js's movePermanentToGraveyard (only when it's
// actually called with { sacrifice: true }) via triggerSacrifice(). Some
// real cards word their own self-referencing effect using their own name
// instead of "this permanent" (Korvold's "put a +1/+1 counter on Korvold")
// — and real oracle text commonly self-references using just the short form
// before the comma ("Korvold", not "Korvold, Fae-Cursed King") — so both
// forms of the card's own name are normalized to "this permanent" first,
// the same substitution real players make mentally when reading their own
// card.
export function interpretSacrificeTriggers(card) {
  const lines = replaceSelfName(card, card.oracleText || '', 'this permanent').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^when(?:ever)? you sacrifice (?:a|another) (?:permanent|creature|artifact|land),\s*(.+)$/);
    if (!m) continue;
    steps.push(...interpretEffectText(m[1]));
  }
  return steps;
}

const ROMAN_VALUES = { I: 1, V: 5, X: 10 };

function romanToInt(roman) {
  const s = roman.toUpperCase();
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = ROMAN_VALUES[s[i]] || 0;
    const next = ROMAN_VALUES[s[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

// Scans a Saga's oracle text for its chapter abilities ("I — Effect",
// "II — Effect", ..., or a chapter shared across numbers like "I, II —
// Effect"). The lore-counter bookkeeping and sacrifice-after-final-chapter
// rule live in game.js's advanceSaga/advanceSagas — this just turns the
// oracle text into { numbers: [1], steps }-shaped chapters the same way
// every other interpret* function turns text into steps.
export function interpretSagaChapters(card) {
  const lines = (card.oracleText || '').toLowerCase().split('\n').map(s => s.trim()).filter(Boolean);
  const chapters = [];
  for (const line of lines) {
    const m = line.match(/^([ivx]+(?:,\s*[ivx]+)*)\s*[—-]\s*(.+)$/);
    if (!m) continue;
    const numbers = m[1].split(',').map(part => romanToInt(part.trim()));
    chapters.push({ numbers, steps: interpretEffectText(m[2]) });
  }
  return chapters;
}

// Parses a Class enchantment's oracle text into its per-level structure
// (Alchemist's Talent, Ranger Class, Wizard Class, ...). Level 1 is
// whatever text comes before the first "{cost}: Level N" line (that line
// ITSELF is metadata — the activation cost — not printed effect text of
// its own); each subsequent "{cost}: Level N" line both costs mana to
// level up (see game.js's levelUpClass) and marks the start of that
// level's own granted text, which stays active alongside every earlier
// level's once reached (a Class at level 3 has levels 1, 2, AND 3's text
// all active — see game.js's recomputeClassEffectiveOracleText, which
// concatenates every level up to the current one). The reminder line
// "(Gain the next level as a sorcery to add its ability.)" is dropped.
// A "When this Class becomes level N, EFFECT" sentence (Wizard Class's
// own level-2 draw) is a ONE-TIME trigger fired exactly at the moment of
// reaching that level, not a standing effect — pulled out into its own
// pre-interpreted `becomesLevelSteps` here rather than left in
// `standingText`, where every other dispatch point would otherwise see it
// forever afterward with no real re-trigger event to fire it on.
// Returns [] for a non-Class card.
export function parseClassLevels(card) {
  if (!/\bclass\b/i.test(card.typeLine || '')) return [];
  const lines = (card.oracleText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const raw = [{ level: 1, cost: null, lines: [] }];
  for (const line of lines) {
    if (/^\(.*\)$/.test(line)) continue;
    const m = line.match(/^((?:\{[^}]+\})+):\s*level (\d+)$/i);
    if (m) {
      raw.push({ level: parseInt(m[2], 10), cost: m[1], lines: [] });
      continue;
    }
    raw[raw.length - 1].lines.push(line);
  }
  return raw.map(l => {
    const text = l.lines.join('\n');
    const becomesMatch = text.match(/when this class becomes level \d+,\s*([^.\n]+)\.?/i);
    const becomesLevelSteps = becomesMatch ? interpretEffectText(becomesMatch[1]) : [];
    const standingText = text.replace(/when this class becomes level \d+,[^.\n]*\.?/gi, '').trim();
    return { level: l.level, cost: l.cost, standingText, becomesLevelSteps };
  });
}

function describeTargetKind(phrase) {
  // Modern "any target" templating (and the older "creature or player"
  // wording it replaced) both include planeswalkers and battles in real
  // rules text — this engine doesn't distinguish old vs. new templating at
  // all, so both collapse to the same 'creatureOrPlayer' kind, which is now
  // planeswalker-inclusive too (see game.js's canBeTargetedBy callers).
  if (phrase.includes('creature or player') || phrase.includes('any target')) return 'creatureOrPlayer';
  // A compound target across more than one permanent type (Bedevil's
  // "artifact, creature, or planeswalker", Vindicate-style "artifact,
  // creature, or land", ...) — narrowing this to whichever single type
  // keyword happens to appear first (e.g. "creature") would make the other
  // named types simply unselectable. Same simplification already used
  // elsewhere for restrictions the engine recognizes but doesn't fully
  // enforce: falls back to the broadest 'permanent' kind so every type the
  // card actually mentions is a legal target, even though it also
  // over-permits types it didn't name.
  const typeKeywords = ['artifact', 'creature', 'enchantment', 'land', 'planeswalker'];
  if (typeKeywords.filter(t => phrase.includes(t)).length > 1) return 'permanent';
  if (phrase.includes('creature')) return 'creature';
  // Bare "target planeswalker" (Bedevil-style compounds are already caught
  // above) — previously fell through to the 'creatureOrPlayer' default,
  // which wrongly let it hit a plain creature too.
  if (phrase.includes('planeswalker')) return 'planeswalker';
  if (phrase.includes('player')) return 'player';
  if (phrase.includes('permanent')) return 'permanent';
  return 'creatureOrPlayer';
}
