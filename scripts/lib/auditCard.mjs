// Cross-references a full AI interpretation of a card (every trigger,
// activated ability, static ability, and spell effect it actually has, per
// oracle text — not just the ones the regex engine happens to recognize)
// against what game.js actually dispatches and effects.js actually
// implements, so we can tell "this card has an ability" apart from "the
// engine does anything with it."
//
// Three outcomes per ability:
//   - "not-dispatched": the engine has no code path that even looks at this
//     kind of trigger/ability (e.g. a "dies" or "attacks" trigger, a
//     non-{T}/non-Equip activated cost, any static/replacement effect).
//   - "unsupported": the engine DOES look at it (right event/cost shape),
//     but the effect itself doesn't resolve into a real game action.
//   - "implemented": recognized and produces a real effect.
//
// Reuses the actual engine functions (not a reimplementation) so this stays
// accurate as effects.js grows — a pattern added there is automatically
// picked up here as "implemented" without touching this file.

import {
  interpretPermanentTriggers, interpretCastTriggers, interpretTapAbilities,
  interpretEquipCost, getSpellModes, interpretSpell, isFullyUnsupported,
  interpretDiesTriggers, interpretAttackTriggers, interpretCombatDamageTriggers,
  interpretUpkeepTriggers, interpretEndStepTriggers, interpretNonTapAbilities,
} from '../../src/effects.js';

const DISPATCHED_TRIGGER_EVENT = {
  entersBattlefield: (card) => interpretPermanentTriggers(card),
  cast: (card) => interpretCastTriggers(card).flatMap(t => t.steps),
  dies: (card) => interpretDiesTriggers(card).flatMap(t => t.steps),
  attacks: (card) => interpretAttackTriggers(card).flatMap(t => t.steps),
  combatDamageToPlayer: (card) => interpretCombatDamageTriggers(card).flatMap(t => t.steps),
  upkeep: (card) => interpretUpkeepTriggers(card),
  endStep: (card) => interpretEndStepTriggers(card),
};

function classifyTriggerDispatch(eventName) {
  const e = eventName || '';
  if (e === 'entersBattlefield') return 'entersBattlefield';
  if (/cast/i.test(e)) return 'cast';
  if (/deals? combat damage/i.test(e)) return 'combatDamageToPlayer';
  if (/\bdies\b/i.test(e)) return 'dies';
  if (/attack/i.test(e)) return 'attacks';
  if (/upkeep/i.test(e)) return 'upkeep';
  if (/end ?step/i.test(e)) return 'endStep';
  return null;
}

export function auditCardAbilities(card, aiEntry) {
  const findings = [];

  for (const trig of aiEntry.triggers || []) {
    const dispatchKind = classifyTriggerDispatch(trig.event);
    if (!dispatchKind) {
      findings.push({
        type: 'trigger', label: trig.event, text: trig.effect?.details || trig.effect?.kind,
        status: 'not-dispatched',
        reason: `event "${trig.event}" isn't one of the trigger types the engine dispatches (entersBattlefield, cast, dies, attacks, combat damage to a player, upkeep, end step)`,
      });
      continue;
    }
    const steps = DISPATCHED_TRIGGER_EVENT[dispatchKind](card);
    const unsupported = isFullyUnsupported(steps);
    findings.push({
      type: 'trigger', label: trig.event, text: trig.effect?.details || trig.effect?.kind,
      status: unsupported ? 'unsupported' : 'implemented',
      reason: unsupported ? 'the trigger type is dispatched, but this specific effect has no real implementation' : null,
    });
  }

  for (const ab of aiEntry.activatedAbilities || []) {
    const hasTap = /\{T\}/i.test(ab.cost || '');
    const looksLikeEquip = /^equip/i.test(ab.cost || '');
    const looksLikeNonTap = !hasTap && !looksLikeEquip &&
      (/sacrifice/i.test(ab.cost || '') || /^(\{[^}]+\}\s*,?\s*)+$/.test((ab.cost || '').trim()));
    if (!hasTap && !looksLikeEquip && !looksLikeNonTap) {
      findings.push({
        type: 'activatedAbility', label: ab.cost, text: ab.effect?.details || ab.effect?.kind,
        status: 'not-dispatched',
        reason: `cost "${ab.cost}" isn't a {T} ability, an Equip cost, a flat mana cost, or a sacrifice cost — no activation path exists for it`,
      });
      continue;
    }
    if (looksLikeEquip) {
      const cost = interpretEquipCost(card);
      findings.push({
        type: 'activatedAbility', label: ab.cost, text: 'attach to a creature you control',
        status: cost ? 'implemented' : 'unsupported',
        reason: cost ? null : 'looked like an Equip cost but the regex on the card\'s own oracle text didn\'t parse it',
      });
      continue;
    }
    const abilities = looksLikeNonTap ? interpretNonTapAbilities(card) : interpretTapAbilities(card);
    const unsupported = abilities.length === 0 || abilities.every(a => isFullyUnsupported(a.steps));
    findings.push({
      type: 'activatedAbility', label: ab.cost, text: ab.effect?.details || ab.effect?.kind,
      status: unsupported ? 'unsupported' : 'implemented',
      reason: unsupported ? `has a ${looksLikeNonTap ? 'non-{T}' : '{T}'} cost the engine recognizes, but the effect has no real implementation` : null,
    });
  }

  for (const stat of aiEntry.staticAbilities || []) {
    findings.push({
      type: 'staticAbility', label: null, text: stat, status: 'not-dispatched',
      reason: 'static/replacement effects from the AI interpretation are never consulted by the engine — only regex-matched anthem/keyword-grant wording on the card\'s own oracle text is',
    });
  }

  if (aiEntry.spellEffect && aiEntry.spellEffect.kind !== 'none') {
    const modal = getSpellModes(card);
    const steps = modal ? modal.modes.flatMap(m => m.steps) : interpretSpell(card);
    const unsupported = isFullyUnsupported(steps);
    findings.push({
      type: 'spellEffect', label: null, text: aiEntry.spellEffect.details || aiEntry.spellEffect.kind,
      status: unsupported ? 'unsupported' : 'implemented',
      reason: unsupported ? 'casting this does something per its oracle text, but the engine resolves it as a no-op' : null,
    });
  }

  return findings;
}
