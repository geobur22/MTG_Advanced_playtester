import { Game } from './game.js';
import { parseManaCost } from './mana.js';
import { loadAICache } from './aiAdapter.js';
import { showPrompt, showAlert, showConfirm } from './dialogs.js';
import { renderManaCost } from './manaSymbols.js';

const DECK_STORAGE_KEY = 'proxyTableDecks';
const HUMAN_ID = 'p0';
const AI_ID = 'p1';
const DEFAULT_WATCH_THINK_DELAY_MS = 250;

let watchMode = false;
let watchThinkDelayMs = DEFAULT_WATCH_THINK_DELAY_MS;
let commanderMode = false;
let game = null;
// How far into game.logLines the error-toast scanner has already looked
// (see scanLogForErrors below) — reset whenever a new Game instance
// starts, since logLines itself starts over from empty.
let lastScannedLogIndex = 0;
let unseenErrorCount = 0;
// Kept around (not just read once at boot) so "Play again" can start a
// fresh game with the exact same decks without a page reload — no need to
// re-fetch Scryfall data or re-run AI analysis. Card objects are never
// mutated in place (only the per-permanent wrapper state is), so reusing
// the same arrays across multiple Game instances is safe.
let loadedDecks = null; // { deckA, deckB, commanderA, commanderB }
let ui = {
  targeting: null,       // { card, kinds, collected: [] }
  attackSelection: new Set(),
  attackTargets: {},      // { [attackerId]: planeswalkerPermId } — omitted entries default to attacking the opponent player
  blockMap: [],           // { blockerId, attackerId }
  armedBlocker: null,
  mulliganBottomSelection: new Set(),
  abilityChoice: null,    // { perm, activatableIndexes } — permanent with 2+ activatable abilities, awaiting a pick
  equipChoice: null,      // { equipPermId } — Equipment armed, awaiting a click on a creature you control
  ninjutsuChoice: null,   // { ninjaInstanceId } — Ninja armed, awaiting a click on one of your own unblocked attackers
  graveyardView: null,    // playerId whose graveyard panel is open, or null
  cardDetail: null,       // permanent id whose full-detail view is open, or null
};

// ---------- element refs ----------

const el = (id) => document.getElementById(id);
const tooltip = el('card-tooltip');

// ---------- watch-mode speed slider ----------
// A persistent element outside #action-buttons (which renderActionBar wipes
// and rebuilds on every game change) so dragging it isn't interrupted by the
// constant re-renders watch mode produces as the bots play. Slider position
// is "speed" (right = faster), inverted from the actual think-delay ms.

const WATCH_SPEED_SLIDER_MAX = 1500;
const watchSpeedRow = el('watch-speed-row');
const watchSpeedSlider = el('watch-speed-slider');
const watchSpeedLabel = el('watch-speed-label');

function updateWatchSpeedLabel(delayMs) {
  watchSpeedLabel.textContent = delayMs <= 0 ? 'Fastest' : `${delayMs}ms`;
}

watchSpeedSlider.addEventListener('input', () => {
  const delayMs = WATCH_SPEED_SLIDER_MAX - Number(watchSpeedSlider.value);
  watchThinkDelayMs = delayMs;
  if (game) game.aiThinkDelayMs = delayMs;
  updateWatchSpeedLabel(delayMs);
});

// ---------- undo ----------
// A single-level undo: refreshed to the CURRENT state every time it's the
// human's turn to decide something and nothing is already mid-flight (no
// in-progress targeting/ability/equip choice) — so it always holds "the
// state right before whatever the human does next," never "before their
// last N actions." See render()'s refreshUndoSnapshot() call for where this
// gets updated, always AFTER the action bar/buttons already reflect the
// OLD snapshot's availability.

const undoButton = el('undo-button');
let lastUndoSnapshot = null;

function refreshUndoSnapshot() {
  const humansTurn = !watchMode && !game.gameOver &&
    (game.priorityPlayer.id === HUMAN_ID || game.pendingRequest?.playerId === HUMAN_ID);
  if (humansTurn && !ui.targeting && !ui.abilityChoice && !ui.equipChoice && !ui.ninjutsuChoice) {
    lastUndoSnapshot = game.snapshot();
  }
}

undoButton.addEventListener('click', () => {
  if (!lastUndoSnapshot || watchMode) return;
  game.restore(lastUndoSnapshot);
  lastUndoSnapshot = null;
  ui.targeting = null;
  ui.abilityChoice = null;
  ui.equipChoice = null;
  ui.ninjutsuChoice = null;
  render();
});

// ---------- boot ----------

(async function boot() {
  const raw = sessionStorage.getItem(DECK_STORAGE_KEY);
  if (!raw) {
    window.location.href = 'index.html';
    return;
  }
  sessionStorage.removeItem(DECK_STORAGE_KEY);
  const { deckA, deckB, watchMode: wm, watchSpeedMs, commanderMode: cm, commanderA, commanderB } = JSON.parse(raw);
  watchMode = !!wm;
  if (typeof watchSpeedMs === 'number' && !Number.isNaN(watchSpeedMs)) watchThinkDelayMs = watchSpeedMs;
  commanderMode = !!cm;
  loadedDecks = { deckA, deckB, commanderA, commanderB };
  await loadAICache();
  startGame(deckA, deckB, commanderA, commanderB);
})();

// ---------- card hover tooltip ----------

function attachHoverTooltip(target, card) {
  target.addEventListener('mouseenter', (e) => showTooltip(card, e));
  target.addEventListener('mousemove', positionTooltip);
  target.addEventListener('mouseleave', hideTooltip);
}

function showTooltip(card, e) {
  tooltip.innerHTML = '';

  const name = document.createElement('div');
  name.className = 'tooltip-name';
  const nameText = document.createElement('span');
  nameText.textContent = card.name;
  name.appendChild(nameText);
  if (card.manaCost) {
    const cost = document.createElement('span');
    cost.className = 'tooltip-cost';
    cost.appendChild(renderManaCost(card.manaCost));
    name.appendChild(cost);
  }
  tooltip.appendChild(name);

  const type = document.createElement('div');
  type.className = 'tooltip-type';
  type.textContent = card.typeLine;
  tooltip.appendChild(type);

  if (card.oracleText) {
    const text = document.createElement('div');
    text.className = 'tooltip-text';
    text.textContent = card.oracleText;
    tooltip.appendChild(text);
  }

  if (card.power != null && card.toughness != null) {
    const pt = document.createElement('div');
    pt.className = 'tooltip-pt';
    pt.textContent = `${card.power}/${card.toughness}`;
    tooltip.appendChild(pt);
  }

  tooltip.hidden = false;
  positionTooltip(e);
}

function positionTooltip(e) {
  if (tooltip.hidden) return;
  const pad = 18;
  tooltip.style.left = `${e.clientX + pad}px`;
  tooltip.style.top = `${e.clientY + pad}px`;
  requestAnimationFrame(() => {
    if (tooltip.hidden) return;
    const rect = tooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) tooltip.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) tooltip.style.top = `${window.innerHeight - rect.height - 8}px`;
  });
}

function hideTooltip() {
  tooltip.hidden = true;
}

// ---------- game lifecycle ----------

function startGame(deckA, deckB, commanderA, commanderB) {
  ui = { targeting: null, attackSelection: new Set(), attackTargets: {}, blockMap: [], armedBlocker: null, mulliganBottomSelection: new Set(), abilityChoice: null, equipChoice: null, ninjutsuChoice: null, graveyardView: null, cardDetail: null };
  lastUndoSnapshot = null; // a snapshot from a previous game instance would be meaningless here
  lastScannedLogIndex = 0; // the new Game's own logLines starts over from empty
  unseenErrorCount = 0;
  updateLogErrorBadge();
  game = new Game({
    deckA, deckB,
    nameA: watchMode ? 'Deck A' : 'You',
    nameB: watchMode ? 'Deck B' : 'Opponent',
    aiControlsA: watchMode,
    aiControlsB: true,
    aiThinkDelayMs: watchMode ? watchThinkDelayMs : 0,
    commanderMode, commanderA, commanderB,
  });
  game.onChange(render);
  el('gameover-overlay').hidden = true;
  watchSpeedRow.hidden = !watchMode;
  if (watchMode) {
    watchSpeedSlider.value = String(WATCH_SPEED_SLIDER_MAX - watchThinkDelayMs);
    updateWatchSpeedLabel(watchThinkDelayMs);
  }
  render();
}

el('play-again-button').addEventListener('click', () => {
  // Same decks, fresh shuffle — restarts in place, no reload/re-fetch needed.
  const { deckA, deckB, commanderA, commanderB } = loadedDecks;
  startGame(deckA, deckB, commanderA, commanderB);
});

el('new-deck-button').addEventListener('click', () => {
  window.location.href = 'index.html';
});

// ---------- log panel ----------

el('log-toggle').addEventListener('click', () => {
  const panel = el('log-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderLog();
  // Opening the log panel counts as "the player has seen these" even if
  // they don't scroll all the way up to the exact lines that triggered a
  // toast — same "opening it clears the count" convention as a chat
  // unread badge.
  if (!panel.hidden && unseenErrorCount > 0) {
    unseenErrorCount = 0;
    updateLogErrorBadge();
  }
});

function updateLogErrorBadge() {
  const badge = el('log-error-badge');
  if (unseenErrorCount > 0) {
    badge.hidden = false;
    badge.textContent = unseenErrorCount > 9 ? '9+' : String(unseenErrorCount);
  } else {
    badge.hidden = true;
  }
}

// Log lines worth actively surfacing to the player, not just leaving in
// the collapsed log panel for them to happen to notice: a real gap in the
// effect interpreter (an "isn't modeled" line — the same signal
// scripts/runAudit.mjs looks for in bulk), or one of the engine's own
// defensive circuit breakers tripping (the AI action-safety-cap, or a
// death-trigger cascade depth cap) — both of those are real, previously-
// seen bug shapes (an ability wrongly treated as free letting a bot loop
// forever; a runaway trigger chain), not just flavor. Deliberately
// excludes "no legal target(s)" lines — a spell fizzling because its only
// target died in response is normal play, not a bug.
const ERROR_LOG_PATTERNS = [
  /isn't modeled in detail yet/i,
  /hit the action safety cap/i,
  /cascade got \d+ deep/i,
];

function showErrorToast(message, kind = 'Log') {
  const container = el('error-toast-container');
  const toast = document.createElement('div');
  toast.className = 'error-toast';
  const kindEl = document.createElement('span');
  kindEl.className = 'error-toast-kind';
  kindEl.textContent = kind;
  toast.appendChild(kindEl);
  toast.appendChild(document.createTextNode(message));
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 7000);
}

// Scans whatever's been appended to game.logLines since the last render
// for anything ERROR_LOG_PATTERNS recognizes, toasting each one exactly
// once (lastScannedLogIndex only ever moves forward) — called from
// render(), so this runs on every real game-state change, including ones
// that happen unattended during "Watch AI vs AI".
function scanLogForErrors() {
  if (!game) return;
  for (let i = lastScannedLogIndex; i < game.logLines.length; i++) {
    const line = game.logLines[i];
    if (ERROR_LOG_PATTERNS.some(p => p.test(line))) {
      showErrorToast(line);
      unseenErrorCount++;
    }
  }
  lastScannedLogIndex = game.logLines.length;
  updateLogErrorBadge();
}

// A genuine thrown JS error (a real bug, not a modeled-in-the-log
// situation) would otherwise just freeze the game silently — nothing in
// this engine's own log would ever mention it. Caught globally so the
// player at least knows SOMETHING went wrong instead of staring at an
// unresponsive board with no explanation, especially important during an
// unattended "Watch AI vs AI" game.
window.addEventListener('error', (e) => {
  showErrorToast(e.message || 'Unexpected error', 'Error');
  unseenErrorCount++;
  updateLogErrorBadge();
});
window.addEventListener('unhandledrejection', (e) => {
  showErrorToast(e.reason?.message || String(e.reason) || 'Unexpected error', 'Error');
  unseenErrorCount++;
  updateLogErrorBadge();
});

function renderLog() {
  const container = el('log-lines');
  container.innerHTML = '';
  for (const line of game.logLines.slice(-120)) {
    const div = document.createElement('div');
    div.textContent = line;
    if (ERROR_LOG_PATTERNS.some(p => p.test(line))) div.classList.add('log-error-line');
    container.appendChild(div);
  }
  container.scrollTop = container.scrollHeight;
}

// Shows a player's graveyard (opened via the "N in graveyard" stat in
// either player-bar) as a simple card list, with an "Activate" button under
// any card the human can actually use from there right now (Reassembling
// Skeleton-style recursion) — the only graveyard interaction this engine
// supports; everything else is just for looking.
function renderGraveyardView() {
  const panel = el('graveyard-panel');
  if (!ui.graveyardView) { panel.hidden = true; return; }
  const player = game.getPlayer(ui.graveyardView);
  if (!player) { panel.hidden = true; return; }
  panel.hidden = false;
  el('graveyard-panel-title').textContent = `${player.name}'s graveyard (${player.graveyard.length})`;

  const container = el('graveyard-panel-cards');
  container.innerHTML = '';
  for (const card of player.graveyard) {
    const div = document.createElement('div');
    div.className = 'card graveyard-card';
    div.appendChild(cardVisual(card));
    attachHoverTooltip(div, card);
    if (player.id === HUMAN_ID && !watchMode && game.canActivateGraveyardAbility(HUMAN_ID, card.instanceId)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-button primary graveyard-activate-button';
      btn.textContent = 'Activate';
      btn.addEventListener('click', () => game.activateGraveyardAbility(HUMAN_ID, card.instanceId));
      div.appendChild(btn);
    }
    // Flashback and Escape — casting straight out of the graveyard on an
    // alternative cost (see game.js's castFromGraveyard).
    if (player.id === HUMAN_ID && !watchMode) {
      const flashbackCost = game.getFlashbackCost(card);
      if (flashbackCost && game.canCastFromGraveyard(HUMAN_ID, card.instanceId, { viaEscape: false })) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'action-button primary graveyard-activate-button';
        btn.textContent = `Flashback ${flashbackCost}`;
        btn.addEventListener('click', () => handleGraveyardCastClick(card, { viaEscape: false }));
        div.appendChild(btn);
      }
      const escapeCost = game.getEscapeCost(card);
      if (escapeCost && game.canCastFromGraveyard(HUMAN_ID, card.instanceId, { viaEscape: true })) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'action-button primary graveyard-activate-button';
        btn.textContent = `Escape ${escapeCost.manaCost} (exile ${escapeCost.exileCount})`;
        btn.addEventListener('click', () => handleGraveyardCastClick(card, { viaEscape: true }));
        div.appendChild(btn);
      }
    }
    container.appendChild(div);
  }
}

// Casting a card out of the graveyard via Flashback or Escape (see
// renderGraveyardView above) — the same modal/targeting flow
// handleHandCardClick uses, finishing through game.castFromGraveyard.
// Neither mechanic here supports an {X} cost or Kicker on top (no real
// card combines them), so unlike handleHandCardClick there's no X/kicker
// prompt to add.
async function handleGraveyardCastClick(card, { viaEscape }) {
  if (game.gameOver || watchMode) return;
  if (ui.abilityChoice || ui.equipChoice || ui.ninjutsuChoice || ui.targeting || game.pendingRequest) return;
  if (!game.canCastFromGraveyard(HUMAN_ID, card.instanceId, { viaEscape })) return;

  const modal = game.getSpellModes(card);
  let modeIndexes = null;
  if (modal) {
    modeIndexes = await chooseModes(card, modal);
    if (modeIndexes === null) return;
  }

  const kinds = game.getRequiredTargetKinds(card, modeIndexes);
  if (kinds.length === 0) {
    game.castFromGraveyard(HUMAN_ID, card.instanceId, { modeIndexes, viaEscape });
    render();
    return;
  }

  ui.targeting = { card, kinds, collected: [], xValue: 0, modeIndexes, fromGraveyard: { cardInstanceId: card.instanceId, viaEscape } };
  render();
}

el('graveyard-panel-close').addEventListener('click', () => { ui.graveyardView = null; render(); });

// Full-detail view for a single permanent: its image/type/oracle text, plus
// a real "Activate" button for every ability it has — tap-costed, non-tap
// (which otherwise has no human-facing activation path at all), and Equip
// — instead of only ever being able to reach whichever single ability a
// quick click on the card itself would guess at. Opened via the small 🔍
// button on every permanent tile (see renderPermanentCard).
function renderCardDetail() {
  const panel = el('card-detail-panel');
  if (!ui.cardDetail) { panel.hidden = true; return; }
  const perm = game.findPermanent(ui.cardDetail);
  if (!perm) { ui.cardDetail = null; panel.hidden = true; return; }
  panel.hidden = false;

  const card = perm.card;
  el('card-detail-title').textContent = card.name;

  const visual = el('card-detail-visual');
  visual.innerHTML = '';
  const visualCard = document.createElement('div');
  visualCard.className = 'card';
  visualCard.appendChild(cardVisual(card, perm));
  visual.appendChild(visualCard);

  el('card-detail-type').textContent = card.typeLine;
  el('card-detail-text').textContent = card.oracleText || '(no rules text)';

  const abilitiesEl = el('card-detail-abilities');
  abilitiesEl.innerHTML = '';

  const isMine = perm.controllerId === HUMAN_ID && !watchMode;

  const tapAbilities = game.getTapAbilities(perm);
  tapAbilities.forEach((ability, i) => {
    const canActivate = isMine && game.canActivateTapAbility(HUMAN_ID, perm.id, i);
    addAbilityRow(abilitiesEl, ability.effectText, canActivate, () => {
      ui.cardDetail = null;
      activateAbilityAtIndex(perm, i);
    });
  });

  const nonTapAbilities = game.getNonTapAbilities(perm);
  nonTapAbilities.forEach((ability, i) => {
    const canActivate = isMine && game.canActivateNonTapAbility(HUMAN_ID, perm.id, i);
    addAbilityRow(abilitiesEl, ability.effectText, canActivate, () => {
      ui.cardDetail = null;
      activateNonTapAbilityAtIndex(perm, i);
    });
  });

  const loyaltyAbilities = game.getLoyaltyAbilities(perm);
  loyaltyAbilities.forEach((ability, i) => {
    const canActivate = isMine && game.canActivateLoyaltyAbility(HUMAN_ID, perm.id, i);
    const sign = ability.cost >= 0 ? '+' : '';
    addAbilityRow(abilitiesEl, `${sign}${ability.cost}: ${ability.effectText}`, canActivate, () => {
      ui.cardDetail = null;
      activateLoyaltyAbilityAtIndex(perm, i);
    });
  });

  const equipCost = game.getEquipCost(perm);
  if (equipCost) {
    const canEquip = isMine && game.canActivateEquip(HUMAN_ID, perm.id) && game.affordabilityForEquip(HUMAN_ID, perm);
    addAbilityRow(abilitiesEl, `Equip ${equipCost}`, canEquip, () => {
      ui.cardDetail = null;
      ui.equipChoice = { equipPermId: perm.id };
      render();
    });
  }

  // Class enchantments (Alchemist's Talent, Ranger Class, ...) — a "Level
  // up" row for the NEXT level only (matches real rules: you can't skip a
  // level), re-derived fresh from the card's own untouched original text
  // every render since perm.card.oracleText itself has already been
  // rewritten to the current cumulative view (see game.js's
  // recomputeClassEffectiveOracleText).
  if (perm.classOriginalOracleText) {
    const levels = game.getClassLevels(perm);
    const nextLevel = levels.find(l => l.level === perm.classLevel + 1);
    if (nextLevel) {
      const canLevelUp = isMine && game.canLevelUpClass(HUMAN_ID, perm.id);
      addAbilityRow(abilitiesEl, `${nextLevel.cost}: Level ${nextLevel.level}`, canLevelUp, () => {
        ui.cardDetail = null;
        game.levelUpClass(HUMAN_ID, perm.id);
      });
    }
  }

  if (abilitiesEl.children.length === 0) {
    const none = document.createElement('div');
    none.className = 'card-detail-ability-text';
    none.textContent = 'No activatable abilities.';
    abilitiesEl.appendChild(none);
  }
}

function addAbilityRow(container, label, canActivate, onActivate) {
  const row = document.createElement('div');
  row.className = 'card-detail-ability-row';
  const text = document.createElement('div');
  text.className = 'card-detail-ability-text';
  text.textContent = label;
  row.appendChild(text);
  if (canActivate) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-button primary';
    btn.textContent = 'Activate';
    btn.addEventListener('click', onActivate);
    row.appendChild(btn);
  }
  container.appendChild(row);
}

el('card-detail-close').addEventListener('click', () => { ui.cardDetail = null; render(); });

// ---------- rendering ----------

function render() {
  if (!game) return;
  scanLogForErrors();
  const human = game.getPlayer(HUMAN_ID);
  const ai = game.getPlayer(AI_ID);

  renderPlayerBar(el('opponent-bar'), ai, true);
  renderPlayerBar(el('player-bar'), human, false);
  renderCommandZone(el('opponent-command-zone'), ai, true);
  renderCommandZone(el('player-command-zone'), human, false);
  renderBattlefield(el('opponent-battlefield'), ai, true);
  renderBattlefield(el('player-battlefield'), human, false);
  renderStack();
  renderHand(human);
  renderActionBar();
  renderTargetingBanner();
  if (!el('log-panel').hidden) renderLog();
  renderGraveyardView();
  renderCardDetail();

  undoButton.hidden = watchMode;
  undoButton.disabled = !lastUndoSnapshot;
  refreshUndoSnapshot();

  if (game.gameOver) {
    el('gameover-overlay').hidden = false;
    const won = game.winner === HUMAN_ID;
    el('gameover-text').textContent = won ? 'You win!' : 'You lose.';
  }
}

function renderPlayerBar(container, player, isOpponent) {
  container.classList.toggle('is-priority', !!game && game.priorityPlayer.id === player.id && !game.gameOver);
  container.innerHTML = '';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = player.name;
  container.appendChild(name);

  const life = document.createElement('span');
  life.className = 'life' + (player.life <= 5 ? ' low' : '');
  life.textContent = `${player.life} life`;
  life.dataset.playerTarget = player.id;
  container.appendChild(life);

  const handStat = document.createElement('span');
  handStat.className = 'stat';
  handStat.textContent = isOpponent ? `${player.hand.length} cards in hand` : `${player.hand.length} in hand`;
  container.appendChild(handStat);

  const libStat = document.createElement('span');
  libStat.className = 'stat';
  libStat.textContent = `${player.library.length} in library`;
  container.appendChild(libStat);

  const gyStat = document.createElement('span');
  gyStat.className = 'stat';
  gyStat.textContent = `${player.graveyard.length} in graveyard`;
  if (player.graveyard.length > 0) {
    gyStat.classList.add('clickable-stat');
    gyStat.addEventListener('click', () => { ui.graveyardView = player.id; render(); });
  }
  container.appendChild(gyStat);

  const poolColors = Object.entries(player.manaPool).filter(([, n]) => n > 0);
  if (poolColors.length > 0) {
    const pool = document.createElement('span');
    pool.className = 'mana-pool';
    pool.textContent = 'Pool: ' + poolColors.map(([c, n]) => `${n}${c}`).join(' ');
    container.appendChild(pool);
  }

  if (game.commanderMode && player.commanderDamageTaken > 0) {
    const cmdDmg = document.createElement('span');
    cmdDmg.className = 'commander-damage';
    cmdDmg.textContent = `${player.commanderDamageTaken}/21 commander dmg`;
    container.appendChild(cmdDmg);
  }

  if (isTargetablePlayer(player.id)) {
    life.classList.add('targetable-player');
    life.addEventListener('click', () => handleTargetPick({ type: 'player', id: player.id }));
  }
}

// The command zone: shows a player's commander while it's sitting there
// (not currently on the battlefield), clickable like a hand card for the
// human to cast — same targeting flow castSpell uses, just sourced from the
// zone via castCommander instead. Hidden entirely outside Commander games,
// and once the commander is out on the battlefield it just renders as a
// normal permanent, so the zone itself shows nothing for it then.
function renderCommandZone(container, player, isOpponent) {
  if (!game.commanderMode || !player.commander) { container.hidden = true; return; }
  container.hidden = false;
  container.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'command-zone-label';
  label.textContent = 'Command zone';
  container.appendChild(label);

  if (!player.commanderZone) {
    const note = document.createElement('span');
    note.className = 'stat';
    note.textContent = `${player.commander.name} is on the battlefield`;
    container.appendChild(note);
    return;
  }

  const div = document.createElement('div');
  div.className = 'card';
  const tax = game.commanderTax(player);
  const castable = !isOpponent && game.canCastCommander(HUMAN_ID) && game.affordabilityForCommander(HUMAN_ID) && !ui.targeting && !ui.abilityChoice && !watchMode;
  if (!isOpponent && !castable) div.classList.add('uncastable');
  div.appendChild(cardVisual(player.commander));
  if (tax > 0) {
    const badge = document.createElement('div');
    badge.className = 'commander-tax-badge';
    badge.textContent = `+{${tax}}`;
    badge.title = `Commander tax: {${tax}} extra, from ${player.commanderCastCount} previous cast(s) from the command zone`;
    div.appendChild(badge);
  }
  attachHoverTooltip(div, player.commander);
  if (!isOpponent) div.addEventListener('click', handleCommandZoneClick);
  container.appendChild(div);
}

// Renders a player's battlefield as two stacked rows — everything else on
// top, lands on their own row underneath — so lands consistently sit at the
// bottom regardless of how many permanents wrap per row.
function renderBattlefield(container, player, isOpponent) {
  container.innerHTML = '';
  const visible = player.battlefield.filter(perm => !perm.attachedTo); // Auras/equipment are drawn on their host card, not separately
  const groups = groupPermanentsForDisplay(visible);
  const nonLandGroups = groups.filter(g => !game.isLand(g[0].card));
  const landGroups = groups.filter(g => game.isLand(g[0].card));

  const nonLandRow = document.createElement('div');
  nonLandRow.className = 'battlefield-row';
  for (const group of nonLandGroups) nonLandRow.appendChild(renderPermanentCard(group, isOpponent));
  container.appendChild(nonLandRow);

  if (landGroups.length > 0) {
    const landRow = document.createElement('div');
    landRow.className = 'battlefield-row battlefield-lands';
    for (const group of landGroups) landRow.appendChild(renderPermanentCard(group, isOpponent));
    container.appendChild(landRow);
  }
}

// Whether identical permanents may be visually compressed into one tile
// right now. Disabled during attacker/blocker declaration, since each
// creature there needs to stay individually clickable.
function isCombatDeclareStep() {
  return game.pendingRequest?.type === 'declareAttackers' || game.pendingRequest?.type === 'declareBlockers';
}

function permGroupKey(perm) {
  const card = perm.card;
  if (game.isLand(card)) return `land:${card.name}:${perm.tapped}`;
  // Two otherwise-identical creatures shouldn't merge into one tile if only
  // one of them has an aura/equipment attached (e.g. Pacifism, which
  // doesn't change power/toughness) — that would hide which one it's on.
  const attachedSignature = getAttachedPermanents(perm).map(ap => ap.card.name).sort().join(',');
  const counterSignature = Object.entries(perm.counters || {}).filter(([, n]) => n).sort().join(',');
  if (game.isCreature(card) && !isCombatDeclareStep()) {
    const p = game.effectivePower(perm), t = game.effectiveToughness(perm);
    return `creature:${card.name}:${perm.tapped}:${perm.summoningSick}:${perm.damage}:${p}:${t}:${!!perm.attacking}:${!!perm.blocking}:${attachedSignature}:${counterSignature}`;
  }
  // Any other permanent (Treasures and similar tokens, duplicate artifacts/
  // enchantments) — identical unattached copies stack into one tile with a
  // count badge too, same as lands/creatures, instead of each getting its
  // own separate card (a whole hand of Treasures used to eat a lot of room).
  return `other:${card.name}:${perm.tapped}:${attachedSignature}:${counterSignature}`;
}

// Groups permanents that are currently interchangeable (same basic land, or
// same creature in the same state) so they render as one tile with a count
// badge instead of many identical cards.
function groupPermanentsForDisplay(perms) {
  const map = new Map();
  for (const perm of perms) {
    const key = permGroupKey(perm);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(perm);
  }
  return [...map.values()];
}

// Auras/Equipment can be attached by either player (an opponent's Pacifism
// on your creature, say), so this checks both battlefields rather than just
// the one currently being rendered.
function getAttachedPermanents(hostPerm) {
  const attached = [];
  for (const pl of game.players) {
    for (const perm of pl.battlefield) {
      if (perm.attachedTo === hostPerm.id) attached.push(perm);
    }
  }
  return attached;
}

function attachedTypeIcon(card) {
  const t = card.typeLine.toLowerCase();
  if (t.includes('aura')) return '✦';
  if (t.includes('equipment')) return '⚙';
  return '🔗';
}

function renderPermanentCard(group, isOpponent) {
  const rep = group[0];
  const card = rep.card;
  const div = document.createElement('div');
  div.className = 'card';
  const isBlocking = rep.blocking != null || ui.blockMap.some(b => group.some(p => b.blockerId === p.id));
  if (rep.tapped) div.classList.add('tapped');
  if (rep.attacking) div.classList.add('attacking');
  if (isBlocking) div.classList.add('blocking');
  if (group.some(p => ui.attackSelection.has(p.id))) div.classList.add('selected');
  if (group.some(p => ui.armedBlocker === p.id)) div.classList.add('selected');
  const isLegalEquipTarget = ui.equipChoice && !isOpponent && game.isCreature(rep.card);
  const isLegalNinjutsuTarget = ui.ninjutsuChoice && !isOpponent && rep.attacking && rep.blockedBy.length === 0;
  if (isLegalPermanentTarget(rep) || isLegalCombatTarget(rep) || isLegalEquipTarget || isLegalNinjutsuTarget) div.classList.add('legal-target');

  div.appendChild(cardVisual(card, rep));

  if (group.length > 1) {
    const badge = document.createElement('div');
    badge.className = 'card-count';
    badge.textContent = `×${group.length}`;
    div.appendChild(badge);
  }

  if (isBlocking) {
    const check = document.createElement('div');
    check.className = 'card-blocking-check';
    check.textContent = '✓';
    check.title = 'Blocking';
    div.appendChild(check);
  }

  if (rep.attacking) {
    const check = document.createElement('div');
    check.className = 'card-attacking-check';
    check.textContent = '✓';
    // Once actually declared, rep.attackTarget says what it's attacking;
    // before that (still just selected, not yet confirmed), ui.attackTargets
    // reflects the same pending choice — either way, name the planeswalker
    // being attacked instead of the default "Attacking" when relevant.
    const pwId = rep.attackTarget?.type === 'planeswalker' ? rep.attackTarget.id : ui.attackTargets[rep.id];
    const pw = pwId ? game.findPermanent(pwId) : null;
    check.title = pw ? `Attacking ${pw.card.name}` : 'Attacking';
    div.appendChild(check);
  } else if (ui.attackSelection.has(rep.id)) {
    // Selected but not yet confirmed (declareAttackers hasn't run) — same
    // idea as the checkmark above, shown while still choosing.
    const pwId = ui.attackTargets[rep.id];
    const pw = pwId ? game.findPermanent(pwId) : null;
    if (pw) {
      const check = document.createElement('div');
      check.className = 'card-attacking-check';
      check.textContent = '✓';
      check.title = `Will attack ${pw.card.name}`;
      div.appendChild(check);
    }
  }

  if (!isOpponent) {
    const abilities = game.getTapAbilities(rep);
    const activatableIndexes = abilities.map((_, i) => i).filter(i => game.canActivateTapAbility(HUMAN_ID, rep.id, i));
    if (activatableIndexes.length > 0) {
      const badge = document.createElement('div');
      badge.className = 'card-ability-badge';
      badge.textContent = '↻';
      badge.title = activatableIndexes.length > 1
        ? `${activatableIndexes.length} abilities available`
        : abilities[activatableIndexes[0]].effectText;
      div.appendChild(badge);
    }
    if (game.getEquipCost(rep) && game.canActivateEquip(HUMAN_ID, rep.id) && game.affordabilityForEquip(HUMAN_ID, rep)) {
      const equipBadge = document.createElement('div');
      equipBadge.className = 'card-ability-badge';
      equipBadge.textContent = '⚔';
      equipBadge.title = `Equip ${game.getEquipCost(rep)}`;
      div.appendChild(equipBadge);
    }
  }

  // Object counters (lore, +1/+1, -1/-1, ...) weren't shown anywhere before
  // — +1/+1 counters were only visible indirectly through the P/T they'd
  // already bumped, and Sagas' lore counters (tracking chapter progress)
  // weren't visible at all.
  const counterEntries = Object.entries(rep.counters || {}).filter(([, n]) => n);
  if (counterEntries.length > 0) {
    const counterBadge = document.createElement('div');
    counterBadge.className = 'card-counters-badge';
    counterBadge.textContent = counterEntries.map(([type, n]) => `${type} ${n}`).join(', ');
    div.appendChild(counterBadge);
  }

  // Auras/Equipment currently attached to this permanent are never drawn as
  // their own battlefield tile (see renderBattlefield's `attachedTo` filter)
  // — they'd otherwise vanish from the UI entirely once attached. A small
  // chip per attachment (hoverable for the attached card's own tooltip)
  // keeps them visible on their host instead.
  const attached = getAttachedPermanents(rep);
  if (attached.length > 0) {
    const row = document.createElement('div');
    row.className = 'card-attached-row';
    for (const ap of attached) {
      const chip = document.createElement('div');
      chip.className = 'card-attached-chip';
      chip.textContent = attachedTypeIcon(ap.card);
      attachHoverTooltip(chip, ap.card);
      row.appendChild(chip);
    }
    div.appendChild(row);
  }

  // A full-detail view (image, oracle text, and a button per activatable
  // ability — tap-costed, non-tap, and Equip alike) for cards with more
  // going on than a single quick-activate click can show, e.g. Kenrith, the
  // Returned King's four differently-costed abilities, only one of which
  // could ever be reached by clicking the card itself.
  const detailButton = document.createElement('button');
  detailButton.type = 'button';
  detailButton.className = 'card-detail-button';
  detailButton.textContent = '🔍';
  detailButton.title = 'View full card & abilities';
  detailButton.addEventListener('click', (e) => {
    e.stopPropagation();
    ui.cardDetail = rep.id;
    render();
  });
  div.appendChild(detailButton);

  attachHoverTooltip(div, card);
  div.addEventListener('click', () => handlePermanentClick(rep, isOpponent));
  return div;
}

function cardVisual(card, perm = null) {
  const wrap = document.createDocumentFragment();
  const frag = document.createElement('div');
  frag.style.display = 'contents';

  if (card.image) {
    const img = document.createElement('img');
    img.className = 'card-image';
    img.src = card.image;
    img.alt = card.name;
    frag.appendChild(img);
  }
  const nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = card.name;
  frag.appendChild(nameEl);

  const typeEl = document.createElement('div');
  typeEl.className = 'card-type';
  typeEl.textContent = card.typeLine;
  frag.appendChild(typeEl);

  if (card.manaCost) {
    const cost = document.createElement('div');
    cost.className = 'card-cost';
    cost.appendChild(renderManaCost(card.manaCost));
    frag.appendChild(cost);
  }

  if (card.power != null && card.toughness != null) {
    const pt = document.createElement('div');
    pt.className = 'card-pt';
    if (perm) {
      const p = game.effectivePower(perm), t = game.effectiveToughness(perm);
      pt.textContent = `${p}/${t}`;
      if (perm.damage > 0) pt.classList.add('card-damage');
    } else {
      pt.textContent = `${card.power}/${card.toughness}`;
    }
    frag.appendChild(pt);
  }

  wrap.appendChild(frag);
  return wrap;
}

function renderHand(human) {
  const container = el('player-hand');
  container.innerHTML = '';
  for (const card of human.hand) {
    const div = document.createElement('div');
    div.className = 'card hand-card';
    const inMulliganBottom = game.pendingRequest?.type === 'mulliganBottom';
    if (!inMulliganBottom && !isHandCardPlayable(card)) div.classList.add('uncastable');
    if (ui.targeting && ui.targeting.card.instanceId === card.instanceId) div.classList.add('selected');
    if (inMulliganBottom && ui.mulliganBottomSelection.has(card.instanceId)) div.classList.add('selected');
    div.appendChild(cardVisual(card));
    attachHoverTooltip(div, card);
    div.addEventListener('click', () => handleHandCardClick(card));
    container.appendChild(div);
  }
  // Cards exiled with a temporary "you may play this" permission (Ragavan,
  // Nimble Pilferer; Nightveil Specter) — this engine has no separate
  // exile-zone panel, so they're shown in the same hand strip, tagged with
  // how many of the player's own turns remain before the permission expires
  // (see game.js's doCleanup).
  for (const entry of human.exiledPlayable) {
    const div = document.createElement('div');
    div.className = 'card hand-card exiled-playable-card';
    const playable = !game.gameOver && !watchMode && !ui.targeting && !ui.abilityChoice && !ui.equipChoice && !ui.ninjutsuChoice &&
      !game.pendingRequest && game.canPlayFromExile(HUMAN_ID, entry.id);
    if (!playable) div.classList.add('uncastable');
    div.appendChild(cardVisual(entry.card));
    attachHoverTooltip(div, entry.card);
    const badge = document.createElement('div');
    badge.className = 'exiled-badge';
    badge.textContent = `Exiled — ${entry.remainingOwnTurns} of your turn${entry.remainingOwnTurns === 1 ? '' : 's'} left`;
    div.appendChild(badge);
    div.addEventListener('click', () => handleExiledCardClick(entry));
    container.appendChild(div);
  }
}

// Playing/casting a card out of exile (see renderHand above) — the same
// modal/X/targeting flow handleHandCardClick uses for a hand card, just
// sourced from exiledPlayable and finishing through game.playCardFromExile
// instead of game.castSpell. Kicker and "pay X life" additional costs
// aren't offered here (a documented simplification, same as the AI's own
// exile-play loop in ai.js) — narrow enough overlap with Ragavan/Nightveil
// Specter's own exiled cards that it wasn't worth the extra prompts.
async function handleExiledCardClick(entry) {
  if (game.gameOver || watchMode) return;
  if (ui.abilityChoice || ui.equipChoice || ui.ninjutsuChoice || ui.targeting || game.pendingRequest) return;
  const card = entry.card;
  if (!game.canPlayFromExile(HUMAN_ID, entry.id)) return;

  if (game.isLand(card)) {
    game.playCardFromExile(HUMAN_ID, entry.id);
    return;
  }

  const modal = game.getSpellModes(card);
  let modeIndexes = null;
  if (modal) {
    modeIndexes = await chooseModes(card, modal);
    if (modeIndexes === null) return;
  }

  const kinds = game.getRequiredTargetKinds(card, modeIndexes);
  let xValue = 0;
  const parsed = parseManaCost(card.manaCost);
  if (parsed.x > 0) {
    const input = await showPrompt(`${card.name} has {X} in its cost. Choose a value for X:`, '0');
    if (input === null) return;
    xValue = Math.max(0, parseInt(input, 10) || 0);
  }

  if (kinds.length === 0) {
    game.playCardFromExile(HUMAN_ID, entry.id, { xValue, modeIndexes });
    return;
  }

  ui.targeting = { card, kinds, collected: [], xValue, modeIndexes, fromExile: entry.id };
  render();
}

function isHandCardPlayable(card) {
  if (game.gameOver || watchMode || ui.targeting || ui.abilityChoice || ui.equipChoice || ui.ninjutsuChoice) return false;
  if (game.pendingRequest?.type === 'mulligan' || game.pendingRequest?.type === 'mulliganBottom') return false;
  // Ninjutsu window: a Ninja is "playable" here in the sense of being
  // clickable (see handleHandCardClick's own check), even though it isn't
  // actually being CAST — canCastSpell below would say no during combat.
  if (game.step === 'declareBlockers' && !game.pendingRequest && game.active.id === HUMAN_ID && game.getNinjutsuCost(card)) {
    return game.getPlayer(HUMAN_ID).battlefield.some(perm => perm.attacking && perm.blockedBy.length === 0);
  }
  if (game.isLand(card)) return game.canPlayLand(HUMAN_ID);
  if (!game.canCastSpell(HUMAN_ID, card)) return false;
  return game.affordability(HUMAN_ID, card);
}

function renderStack() {
  const container = el('stack-list');
  container.innerHTML = '';
  for (const item of [...game.stack].reverse()) {
    const div = document.createElement('div');
    div.className = 'stack-item';
    const controller = game.getPlayer(item.controllerId);
    div.textContent = `${item.card.name} (${controller.name})`;
    attachHoverTooltip(div, item.card);
    if (isLegalStackTarget(item)) {
      div.classList.add('legal-target');
      div.addEventListener('click', () => handleTargetPick({ type: 'stack', id: item.id }));
    }
    container.appendChild(div);
  }
}

function isLegalStackTarget(item) {
  if (currentTargetKind() !== 'stackSpell') return false;
  return !item.isPermanentSpell && !item.isAura;
}

function renderActionBar() {
  const inMulligan = game.pendingRequest?.type === 'mulligan' || game.pendingRequest?.type === 'mulliganBottom';
  el('step-indicator').textContent = inMulligan
    ? 'Opening hand'
    : `Turn ${game.turnNumber} — ${game.active.name}'s ${stepLabel()}`;
  const buttons = el('action-buttons');
  buttons.innerHTML = '';

  if (game.gameOver) return;

  // Spectator mode: both seats are bots, so there's never a real decision
  // for the viewer to make — no buttons, just a label, and clicks on cards
  // are ignored (see the watchMode guards in the click handlers below) so a
  // stray click can't accidentally act on either bot's behalf.
  if (watchMode) {
    const label = document.createElement('div');
    label.className = 'action-button';
    label.textContent = 'Watching…';
    buttons.appendChild(label);
    return;
  }

  if (game.pendingRequest?.type === 'mulligan' && game.pendingRequest.playerId === HUMAN_ID) {
    const n = game.pendingRequest.mulligansTaken;
    buttons.appendChild(makeButton(n === 0 ? 'Keep hand' : `Keep hand (bottom ${n})`, 'primary', () => game.keepHand(HUMAN_ID)));
    buttons.appendChild(makeButton('Mulligan (draw a new 7)', '', () => game.mulligan(HUMAN_ID)));
    return;
  }

  if (game.pendingRequest?.type === 'mulliganBottom' && game.pendingRequest.playerId === HUMAN_ID) {
    const need = game.pendingRequest.count;
    const chosen = ui.mulliganBottomSelection.size;
    buttons.appendChild(makeButton(
      `Put ${need} card(s) on the bottom (${chosen}/${need})`,
      'primary',
      () => {
        game.putOnBottom(HUMAN_ID, [...ui.mulliganBottomSelection]);
        ui.mulliganBottomSelection = new Set();
      },
      chosen !== need,
    ));
    return;
  }

  if (game.pendingRequest?.type === 'declareAttackers' && game.pendingRequest.playerId === HUMAN_ID) {
    buttons.appendChild(makeButton('Attack with selected', 'primary', () => {
      game.declareAttackers(HUMAN_ID, [...ui.attackSelection], ui.attackTargets);
      ui.attackSelection = new Set();
      ui.attackTargets = {};
    }));
    buttons.appendChild(makeButton("Don't attack", '', () => {
      game.declareAttackers(HUMAN_ID, []);
      ui.attackSelection = new Set();
      ui.attackTargets = {};
    }));
    return;
  }

  if (game.pendingRequest?.type === 'declareBlockers' && game.pendingRequest.playerId === HUMAN_ID) {
    buttons.appendChild(makeButton('Confirm blocks', 'primary', () => {
      game.declareBlockers(HUMAN_ID, ui.blockMap);
      ui.blockMap = [];
      ui.armedBlocker = null;
    }));
    buttons.appendChild(makeButton("Don't block", '', () => {
      game.declareBlockers(HUMAN_ID, []);
      ui.blockMap = [];
      ui.armedBlocker = null;
    }));
    return;
  }

  if (ui.abilityChoice) {
    const { perm, activatableIndexes } = ui.abilityChoice;
    const abilities = game.getTapAbilities(perm);
    for (const i of activatableIndexes) {
      buttons.appendChild(makeButton(abilities[i].effectText, 'primary', () => {
        ui.abilityChoice = null;
        activateAbilityAtIndex(perm, i);
      }));
    }
    buttons.appendChild(makeButton('Cancel', 'danger', () => { ui.abilityChoice = null; render(); }));
    return;
  }

  if (ui.equipChoice) {
    buttons.appendChild(makeButton('Cancel', 'danger', () => { ui.equipChoice = null; render(); }));
    return;
  }

  if (ui.ninjutsuChoice) {
    buttons.appendChild(makeButton('Cancel', 'danger', () => { ui.ninjutsuChoice = null; render(); }));
    return;
  }

  if (ui.targeting) {
    buttons.appendChild(makeButton('Cancel', 'danger', () => { ui.targeting = null; render(); }));
    return;
  }

  const canAct = game.priorityPlayer.id === HUMAN_ID;
  const passLabel = game.stack.length > 0 ? 'Pass (let spell resolve)' : 'Pass priority';
  buttons.appendChild(makeButton(passLabel, canAct ? 'primary' : '', () => game.pass(HUMAN_ID), !canAct));
}

function stepLabel() {
  const labels = {
    untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw Step', main1: 'Main Phase',
    beginCombat: 'Begin Combat', declareAttackers: 'Declare Attackers',
    declareBlockers: 'Declare Blockers', combatDamage: 'Combat Damage', endCombat: 'End of Combat',
    main2: 'Second Main Phase', end: 'End Step', cleanup: 'Cleanup',
  };
  return labels[game.step] || game.step;
}

function makeButton(text, cls, onClick, disabled = false) {
  const btn = document.createElement('button');
  btn.className = 'action-button' + (cls ? ' ' + cls : '');
  btn.textContent = text;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderTargetingBanner() {
  const banner = el('targeting-banner');
  if (watchMode) { banner.hidden = true; return; }
  if (ui.abilityChoice) {
    banner.hidden = false;
    banner.textContent = `${ui.abilityChoice.perm.card.name} has multiple abilities — pick one below.`;
    return;
  }
  if (ui.equipChoice) {
    banner.hidden = false;
    banner.textContent = 'Click one of your creatures to equip it.';
    return;
  }
  if (ui.targeting) {
    banner.hidden = false;
    const remaining = ui.targeting.kinds.length - ui.targeting.collected.length;
    const kind = ui.targeting.kinds[ui.targeting.collected.length];
    const where = kind === 'stackSpell' ? 'a highlighted spell on the stack' : 'a highlighted card or life total';
    banner.textContent = `Choose a target for ${ui.targeting.card.name} (${remaining} remaining) — click ${where}`;
    return;
  }
  if (game.pendingRequest?.type === 'etbTarget' && game.pendingRequest.playerId === HUMAN_ID) {
    banner.hidden = false;
    const remaining = game.pendingRequest.kinds.length - game.pendingRequest.collected.length;
    const kind = game.pendingRequest.kinds[game.pendingRequest.collected.length];
    const where = kind === 'stackSpell' ? 'a highlighted spell on the stack' : 'a highlighted card or life total';
    banner.textContent = `Choose a target for ${game.pendingRequest.cardName}'s ability (${remaining} remaining) — click ${where}`;
    return;
  }
  if (game.pendingRequest?.type === 'mulligan' && game.pendingRequest.playerId === HUMAN_ID) {
    banner.hidden = false;
    banner.textContent = game.pendingRequest.mulligansTaken === 0
      ? "You're on the play. Keep this 7-card hand, or mulligan to a fresh one?"
      : `New 7-card hand. Keep it (you'll put ${game.pendingRequest.mulligansTaken} card(s) on the bottom), or mulligan again?`;
    return;
  }
  if (game.pendingRequest?.type === 'mulliganBottom' && game.pendingRequest.playerId === HUMAN_ID) {
    banner.hidden = false;
    banner.textContent = `Click ${game.pendingRequest.count} card(s) in your hand to put on the bottom of your library.`;
    return;
  }
  if (game.pendingRequest?.type === 'declareAttackers' && game.pendingRequest.playerId === HUMAN_ID) {
    banner.hidden = false;
    const opponentHasPw = game.opponentOf(HUMAN_ID).battlefield.some(p => game.isPlaneswalker(p.card));
    banner.textContent = opponentHasPw
      ? 'Click your highlighted creatures to select attackers, then optionally click an opponent\'s planeswalker to send them there instead of the player — then press "Attack with selected".'
      : 'Click your highlighted creatures to select attackers, then press "Attack with selected".';
    return;
  }
  if (game.pendingRequest?.type === 'declareBlockers' && game.pendingRequest.playerId === HUMAN_ID) {
    banner.hidden = false;
    banner.textContent = ui.armedBlocker
      ? 'Now click a highlighted attacker to assign this blocker to it.'
      : 'Click one of your highlighted creatures to arm it as a blocker, then click an attacker to assign it.';
    return;
  }
  banner.hidden = true;
}

// ---------- interaction handlers ----------

async function handleHandCardClick(card) {
  if (game.gameOver || watchMode) return;
  if (ui.abilityChoice || ui.equipChoice) return; // must Cancel or pick first

  if (game.pendingRequest?.type === 'mulliganBottom' && game.pendingRequest.playerId === HUMAN_ID) {
    const need = game.pendingRequest.count;
    if (ui.mulliganBottomSelection.has(card.instanceId)) {
      ui.mulliganBottomSelection.delete(card.instanceId);
    } else if (ui.mulliganBottomSelection.size < need) {
      ui.mulliganBottomSelection.add(card.instanceId);
    }
    render();
    return;
  }
  if (game.pendingRequest?.type === 'mulligan') return; // must use the Keep/Mulligan buttons

  if (ui.targeting) return; // ignore hand clicks mid-targeting

  // Ninjutsu window: once blocks are locked in (no more pendingRequest),
  // priority reopens during this engine's own declareBlockers step right
  // where real Ninjutsu is usable — clicking an eligible Ninja in hand
  // arms it, then a following click on one of the human's own unblocked
  // attackers (handlePermanentClick's own ui.ninjutsuChoice branch)
  // actually swaps it in.
  if (game.step === 'declareBlockers' && !game.pendingRequest && game.active.id === HUMAN_ID && game.getNinjutsuCost(card)) {
    const hasUnblockedAttacker = game.getPlayer(HUMAN_ID).battlefield.some(perm => perm.attacking && perm.blockedBy.length === 0);
    if (hasUnblockedAttacker) {
      ui.ninjutsuChoice = { ninjaInstanceId: card.instanceId };
      render();
    }
    return;
  }

  if (game.step === 'declareAttackers' || game.step === 'declareBlockers') return;

  if (game.isLand(card)) {
    if (game.canPlayLand(HUMAN_ID)) game.playLand(HUMAN_ID, card.instanceId);
    return;
  }

  if (!isHandCardPlayable(card)) return;

  const modal = game.getSpellModes(card);
  let modeIndexes = null;
  if (modal) {
    modeIndexes = await chooseModes(card, modal);
    if (modeIndexes === null) return; // cancelled
  }

  const kinds = game.getRequiredTargetKinds(card, modeIndexes);
  let xValue = 0;
  const parsed = parseManaCost(card.manaCost);
  if (parsed.x > 0) {
    const input = await showPrompt(`${card.name} has {X} in its cost. Choose a value for X:`, '0');
    if (input === null) return;
    xValue = Math.max(0, parseInt(input, 10) || 0);
  } else if (game.hasLifePaymentXCost(card)) {
    // A "pay X life" additional cost (Toxic Deluge) isn't part of the
    // printed mana cost at all, so parsed.x is 0 for it — needs its own
    // prompt, capped by how much life is safe to spend.
    const maxX = game.getMaxLifePaymentX(HUMAN_ID);
    const input = await showPrompt(`${card.name} asks you to pay X life as an additional cost (you have enough life to pay up to ${maxX}). Choose a value for X:`, '0');
    if (input === null) return;
    xValue = Math.max(0, Math.min(maxX, parseInt(input, 10) || 0));
  }

  // Kicker (Territorial Allosaurus, ...) is a wholly optional additional
  // cost — ask, and only pay it if the player says yes AND can actually
  // afford the combined cost (castSpell itself refuses the cast rather
  // than silently falling back to unkicked if they can't).
  let kicked = false;
  const kickerCost = game.getKickerCost(card);
  if (kickerCost) {
    kicked = await showConfirm(`${card.name} has Kicker ${kickerCost}. Pay the Kicker cost?`);
  }

  if (kinds.length === 0) {
    game.castSpell(HUMAN_ID, card.instanceId, [], xValue, modeIndexes, kicked);
    return;
  }

  ui.targeting = { card, kinds, collected: [], xValue, modeIndexes, kicked };
  render();
}

// Modal spells ("Choose one —" text) need their mode(s) picked before
// targets are even asked for, since different modes can need different
// targets. Returns the chosen 0-based indexes, or null if the player
// cancelled.
async function chooseModes(card, modal) {
  const list = modal.modes.map((m, i) => `${i + 1}. ${m.label}`).join('\n');
  const countLabel = modal.upTo ? `up to ${modal.count}` : `${modal.count}`;
  const needed = modal.upTo ? 1 : modal.count;
  const promptText = `${card.name} — choose ${countLabel} mode(s):\n${list}\n\nEnter the number(s), comma-separated (e.g. "1" or "1,3"):`;
  while (true) {
    const input = await showPrompt(promptText);
    if (input === null) return null;
    const picked = [...new Set(input.split(',').map(s => parseInt(s.trim(), 10) - 1))].filter(i => i >= 0 && i < modal.modes.length);
    if (picked.length >= needed && picked.length <= modal.count) return picked;
    await showAlert(`Choose ${modal.upTo ? 'up to ' : ''}${modal.count} valid mode number${modal.count > 1 ? 's' : ''}.`);
  }
}

// Casting the commander from the command zone — same shape as casting a
// hand card (see handleHandCardClick above), just sourced from the zone via
// game.castCommander instead of game.castSpell.
async function handleCommandZoneClick() {
  if (game.gameOver || watchMode) return;
  if (ui.abilityChoice || ui.targeting) return;
  if (game.pendingRequest) return;
  if (!game.canCastCommander(HUMAN_ID) || !game.affordabilityForCommander(HUMAN_ID)) return;

  const human = game.getPlayer(HUMAN_ID);
  const card = human.commander;
  const kinds = game.getRequiredTargetKinds(card);
  let xValue = 0;
  const parsed = parseManaCost(card.manaCost);
  if (parsed.x > 0) {
    const input = await showPrompt(`${card.name} has {X} in its cost. Choose a value for X:`, '0');
    if (input === null) return;
    xValue = Math.max(0, parseInt(input, 10) || 0);
  }

  if (kinds.length === 0) {
    game.castCommander(HUMAN_ID, [], xValue);
    return;
  }

  ui.targeting = { source: 'commander', card, kinds, collected: [], xValue };
  render();
}

// A "current target request" can come from casting a spell/activating an
// ability (ui.targeting) or from a queued ETB trigger (game.pendingRequest).
// These helpers look at whichever one is active.
function activeTargetKinds() {
  if (ui.targeting) return ui.targeting.kinds;
  if (game.pendingRequest?.type === 'etbTarget' && game.pendingRequest.playerId === HUMAN_ID) return game.pendingRequest.kinds;
  return null;
}

function activeTargetCollected() {
  if (ui.targeting) return ui.targeting.collected;
  if (game.pendingRequest?.type === 'etbTarget') return game.pendingRequest.collected;
  return [];
}

function currentTargetKind() {
  const kinds = activeTargetKinds();
  return kinds ? kinds[activeTargetCollected().length] : null;
}

function isLegalPermanentTarget(perm) {
  const kind = currentTargetKind();
  if (!kind) return false;
  if (!game.canBeTargetedBy(perm, HUMAN_ID)) return false;
  // A multi-target request ("up to two target creatures") shows up as
  // several consecutive same-kind slots (see game.js's expandTargetKinds) —
  // without this, nothing stops the same permanent from being picked for
  // more than one of those slots.
  if (activeTargetCollected().some(t => t.type === 'permanent' && t.id === perm.id)) return false;
  // An ETB trigger referencing "ANOTHER target creature" (Territorial
  // Allosaurus's own Kicker+Fight payoff) can't legally target the
  // just-entered permanent itself.
  if (game.pendingRequest?.type === 'etbTarget' && game.pendingRequest.sourcePermId === perm.id) return false;
  const isCreature = game.isCreature(perm.card);
  if (kind === 'creature') return isCreature;
  // "Any target"/"creature or player" (see effects.js's describeTargetKind)
  // includes planeswalkers in real modern rules text.
  if (kind === 'creatureOrPlayer') return isCreature || game.isPlaneswalker(perm.card);
  if (kind === 'planeswalker') return game.isPlaneswalker(perm.card);
  if (kind === 'permanent') return true;
  return false;
}

// Highlights which permanents are currently clickable during the human's
// declare-attackers/declare-blockers decisions, since it isn't otherwise
// obvious which creatures can attack/block or which attacker an armed
// blocker can be assigned to.
function isLegalCombatTarget(perm) {
  if (game.pendingRequest?.type === 'declareAttackers' && game.pendingRequest.playerId === HUMAN_ID) {
    if (perm.controllerId === HUMAN_ID) return !perm.tapped && game.canDeclareAsAttacker(perm) && game.isCreature(perm.card);
    // An opponent's planeswalker is a valid click target once at least one
    // attacker is selected (see handlePermanentClick) — reassigns them to
    // attack it instead of the player.
    return game.isPlaneswalker(perm.card) && ui.attackSelection.size > 0;
  }
  if (game.pendingRequest?.type === 'declareBlockers' && game.pendingRequest.playerId === HUMAN_ID) {
    if (perm.controllerId === HUMAN_ID) {
      return !perm.tapped && game.isCreature(perm.card) && !game.effectiveKeywords(perm).has('cantBlock') && !ui.blockMap.some(b => b.blockerId === perm.id);
    }
    if (!ui.armedBlocker || !perm.attacking) return false;
    const attackerKws = game.effectiveKeywords(perm);
    if (attackerKws.has('flying')) {
      const blocker = game.findPermanent(ui.armedBlocker);
      const blockerKws = blocker ? game.effectiveKeywords(blocker) : new Set();
      if (!blockerKws.has('flying') && !blockerKws.has('reach')) return false;
    }
    return true;
  }
  return false;
}

function isTargetablePlayer(playerId) {
  const kind = currentTargetKind();
  return kind === 'player' || kind === 'creatureOrPlayer';
}

function handleTargetPick(target) {
  if (watchMode) return;
  if (ui.targeting) {
    ui.targeting.collected.push(target);
    if (ui.targeting.collected.length >= ui.targeting.kinds.length) {
      const t = ui.targeting;
      ui.targeting = null;
      if (t.source === 'ability') game.activateTapAbility(HUMAN_ID, t.permId, t.abilityIndex, t.collected);
      else if (t.source === 'nonTapAbility') game.activateNonTapAbility(HUMAN_ID, t.permId, t.abilityIndex, t.collected);
      else if (t.source === 'loyaltyAbility') game.activateLoyaltyAbility(HUMAN_ID, t.permId, t.abilityIndex, t.collected);
      else if (t.source === 'commander') game.castCommander(HUMAN_ID, t.collected, t.xValue || 0);
      else if (t.fromExile) game.playCardFromExile(HUMAN_ID, t.fromExile, { targets: t.collected, xValue: t.xValue || 0, modeIndexes: t.modeIndexes || null });
      else if (t.fromGraveyard) game.castFromGraveyard(HUMAN_ID, t.fromGraveyard.cardInstanceId, { targets: t.collected, xValue: t.xValue || 0, modeIndexes: t.modeIndexes || null, viaEscape: t.fromGraveyard.viaEscape });
      else game.castSpell(HUMAN_ID, t.card.instanceId, t.collected, t.xValue || 0, t.modeIndexes || null, t.kicked || false);
    } else {
      render();
    }
    return;
  }
  if (game.pendingRequest?.type === 'etbTarget' && game.pendingRequest.playerId === HUMAN_ID) {
    game.chooseETBTarget(HUMAN_ID, target);
  }
}

// Activates one of a permanent's "{T}: ..." abilities — the only one, if it
// has just one, or otherwise opens a choice menu (rendered in the action
// bar, see renderActionBar's ui.abilityChoice branch) so the player picks
// which one, exactly as they'd pick which spell to cast. Either way the
// chosen ability then goes through the same targeting flow a spell does.
function tryActivateAbility(perm) {
  const abilities = game.getTapAbilities(perm);
  const activatableIndexes = abilities.map((_, i) => i).filter(i => game.canActivateTapAbility(HUMAN_ID, perm.id, i));
  if (activatableIndexes.length === 0) return;
  if (activatableIndexes.length === 1) {
    activateAbilityAtIndex(perm, activatableIndexes[0]);
    return;
  }
  ui.abilityChoice = { perm, activatableIndexes };
  render();
}

function activateAbilityAtIndex(perm, abilityIndex) {
  if (!game.canActivateTapAbility(HUMAN_ID, perm.id, abilityIndex)) return;
  const kinds = game.getRequiredTargetKindsForAbility(perm, abilityIndex);
  if (kinds.length === 0) {
    game.activateTapAbility(HUMAN_ID, perm.id, abilityIndex, []);
    return;
  }
  ui.targeting = { source: 'ability', card: perm.card, kinds, collected: [], permId: perm.id, abilityIndex };
  render();
}

// Non-tap abilities (a flat mana cost, or "Sacrifice a creature", no {T}
// involved) had no human-facing activation path at all before this — only
// the AI could use them. Only ever reached through the card-detail panel
// (see renderCardDetail), since there's no quick-activate click gesture for
// these the way a single tap ability gets.
function activateNonTapAbilityAtIndex(perm, abilityIndex) {
  if (!game.canActivateNonTapAbility(HUMAN_ID, perm.id, abilityIndex)) return;
  const kinds = game.getRequiredTargetKindsForNonTapAbility(perm, abilityIndex);
  if (kinds.length === 0) {
    game.activateNonTapAbility(HUMAN_ID, perm.id, abilityIndex, []);
    return;
  }
  ui.targeting = { source: 'nonTapAbility', card: perm.card, kinds, collected: [], permId: perm.id, abilityIndex };
  render();
}

// Planeswalker loyalty abilities — same card-detail-panel-only reachability
// as non-tap abilities above (a planeswalker usually has 2-3 to choose
// from, so there's no single-click quick-activate the way one lone tap
// ability gets).
function activateLoyaltyAbilityAtIndex(perm, abilityIndex) {
  if (!game.canActivateLoyaltyAbility(HUMAN_ID, perm.id, abilityIndex)) return;
  const kinds = game.getRequiredTargetKindsForLoyaltyAbility(perm, abilityIndex);
  if (kinds.length === 0) {
    game.activateLoyaltyAbility(HUMAN_ID, perm.id, abilityIndex, []);
    return;
  }
  ui.targeting = { source: 'loyaltyAbility', card: perm.card, kinds, collected: [], permId: perm.id, abilityIndex };
  render();
}

function handlePermanentClick(perm, isOpponentPermanent) {
  if (game.gameOver || watchMode) return;
  if (ui.abilityChoice) return; // must Cancel or pick an ability first

  if (ui.equipChoice) {
    if (!isOpponentPermanent && game.isCreature(perm.card)) {
      const { equipPermId } = ui.equipChoice;
      ui.equipChoice = null;
      game.activateEquip(HUMAN_ID, equipPermId, perm.id);
    }
    return;
  }

  if (ui.ninjutsuChoice) {
    if (!isOpponentPermanent && perm.attacking && perm.blockedBy.length === 0) {
      const { ninjaInstanceId } = ui.ninjutsuChoice;
      ui.ninjutsuChoice = null;
      game.activateNinjutsu(HUMAN_ID, ninjaInstanceId, perm.id);
    }
    return;
  }

  if (activeTargetKinds()) {
    if (isLegalPermanentTarget(perm)) handleTargetPick({ type: 'permanent', id: perm.id });
    return;
  }

  if (game.pendingRequest?.type === 'declareAttackers' && game.pendingRequest.playerId === HUMAN_ID) {
    if (!isOpponentPermanent) {
      if (perm.tapped || !game.canDeclareAsAttacker(perm) || !game.isCreature(perm.card)) return;
      if (ui.attackSelection.has(perm.id)) {
        ui.attackSelection.delete(perm.id);
        delete ui.attackTargets[perm.id];
      } else {
        ui.attackSelection.add(perm.id);
      }
      render();
      return;
    }
    // Clicking an opponent's planeswalker assigns every currently-selected
    // attacker to it (toggling back to the default player-attack if
    // they're already all assigned there) — pick your attackers first,
    // then click the planeswalker you want them to hit.
    if (game.isPlaneswalker(perm.card) && ui.attackSelection.size > 0) {
      const allAlreadyOnThis = [...ui.attackSelection].every(id => ui.attackTargets[id] === perm.id);
      for (const id of ui.attackSelection) {
        if (allAlreadyOnThis) delete ui.attackTargets[id];
        else ui.attackTargets[id] = perm.id;
      }
      render();
      return;
    }
    return;
  }

  if (game.pendingRequest?.type === 'declareBlockers' && game.pendingRequest.playerId === HUMAN_ID) {
    if (!isOpponentPermanent) {
      // selecting/arming one of my own creatures as a blocker
      if (perm.tapped || !game.isCreature(perm.card) || game.effectiveKeywords(perm).has('cantBlock')) return;
      const already = ui.blockMap.find(b => b.blockerId === perm.id);
      if (already) {
        ui.blockMap = ui.blockMap.filter(b => b.blockerId !== perm.id);
        ui.armedBlocker = null;
      } else {
        ui.armedBlocker = ui.armedBlocker === perm.id ? null : perm.id;
      }
      render();
      return;
    } else {
      // assigning the armed blocker to this attacker
      if (!perm.attacking || !ui.armedBlocker) return;
      ui.blockMap = ui.blockMap.filter(b => b.blockerId !== ui.armedBlocker);
      ui.blockMap.push({ blockerId: ui.armedBlocker, attackerId: perm.id });
      ui.armedBlocker = null;
      render();
      return;
    }
  }

  if (!isOpponentPermanent && !game.pendingRequest) {
    if (game.getEquipCost(perm) && game.canActivateEquip(HUMAN_ID, perm.id) && game.affordabilityForEquip(HUMAN_ID, perm)) {
      ui.equipChoice = { equipPermId: perm.id };
      render();
      return;
    }
    tryActivateAbility(perm);
  }
}
