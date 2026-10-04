import { buildDeckFromText } from './deck.js';
import { fetchCardsByName } from './scryfall.js';
import { PRESET_DECKS } from './presets.js';
import { loadSavedDecks, saveDeck } from './deckLibrary.js';
import { showPrompt, showConfirm, showAlert } from './dialogs.js';

const DEFAULT_OPPONENT_DECK = `
18 Mountain
4 Monastery Swiftspear
4 Goblin Guide
4 Lightning Bolt
4 Shock
4 Lava Spike
4 Fireblast
4 Rift Bolt
4 Skewer the Critics
4 Wild Slash
4 Kumano Faces Kakkazan
2 Chandra's Pyrohelix
`.trim();

// Key both decks are stashed under for play.html to pick up after we
// navigate there. sessionStorage (not localStorage) so a stale deck from a
// previous tab/session never leaks into a fresh one.
const DECK_STORAGE_KEY = 'proxyTableDecks';

const el = (id) => document.getElementById(id);
const setupCard = el('setup-card');
const analyzeCard = el('analyze-card');
const analyzeStatus = el('analyze-status');
const analyzeBarFill = el('analyze-bar-fill');
const deckInput = el('deck-input');
const opponentDeckInput = el('opponent-deck-input');
const startButton = el('start-button');
const watchButton = el('watch-button');
const setupError = el('setup-error');
const commanderToggle = el('commander-toggle');
const commanderFields = el('commander-fields');
const commanderInput = el('commander-input');
const opponentCommanderFields = el('opponent-commander-fields');
const opponentCommanderInput = el('opponent-commander-input');

commanderToggle.addEventListener('change', () => {
  commanderFields.hidden = !commanderToggle.checked;
  opponentCommanderFields.hidden = !commanderToggle.checked;
});

startButton.addEventListener('click', () => runSetup({ watchMode: false }));
watchButton.addEventListener('click', () => runSetup({ watchMode: true }));

// ---------- deck library (presets + user-saved decks) ----------

const SLOTS = {
  mine: { select: el('mine-deck-select'), saveButton: el('mine-save-button'), textarea: deckInput, commanderInput },
  theirs: { select: el('theirs-deck-select'), saveButton: el('theirs-save-button'), textarea: opponentDeckInput, commanderInput: opponentCommanderInput },
};

function populateDeckSelects() {
  const saved = loadSavedDecks();
  for (const slot of Object.values(SLOTS)) {
    const previousValue = slot.select.value;
    slot.select.innerHTML = '<option value="">— Load a preset or saved deck —</option>';

    const presetGroup = document.createElement('optgroup');
    presetGroup.label = 'Presets';
    for (const deck of PRESET_DECKS) {
      const opt = document.createElement('option');
      opt.value = deck.id;
      opt.textContent = deck.name;
      presetGroup.appendChild(opt);
    }
    slot.select.appendChild(presetGroup);

    if (saved.length) {
      const savedGroup = document.createElement('optgroup');
      savedGroup.label = 'Your saved decks';
      for (const deck of saved) {
        const opt = document.createElement('option');
        opt.value = deck.id;
        opt.textContent = deck.name;
        savedGroup.appendChild(opt);
      }
      slot.select.appendChild(savedGroup);
    }

    if ([...slot.select.options].some(o => o.value === previousValue)) slot.select.value = previousValue;
  }
}

function findDeckById(id) {
  return PRESET_DECKS.find(d => d.id === id) || loadSavedDecks().find(d => d.id === id) || null;
}

for (const [slotName, slot] of Object.entries(SLOTS)) {
  slot.select.addEventListener('change', () => {
    const deck = findDeckById(slot.select.value);
    if (!deck) return;
    slot.textarea.value = deck.deckText;
    slot.commanderInput.value = deck.commanderName || '';
    if (deck.commanderName && !commanderToggle.checked) {
      commanderToggle.checked = true;
      commanderToggle.dispatchEvent(new Event('change'));
    }
  });

  slot.saveButton.addEventListener('click', async () => {
    const text = slot.textarea.value.trim();
    if (!text) { await showAlert('Nothing to save — paste a decklist first.'); return; }
    const defaultName = slotName === 'mine' ? 'My deck' : "Opponent's deck";
    const name = await showPrompt('Name this deck:', defaultName);
    if (!name || !name.trim()) return;
    saveDeck(name.trim(), text, commanderToggle.checked ? slot.commanderInput.value.trim() : '');
    populateDeckSelects();
    slot.select.value = loadSavedDecks().find(d => d.name === name.trim())?.id || '';
  });
}

populateDeckSelects();

// Shared by "Shuffle up & start" and "Watch AI vs AI" — both need the same
// decklist parsing/validation/analysis, differing only in whether seat A
// ends up human-controlled or, for watch mode, also a bot.
async function runSetup({ watchMode }) {
  setupError.hidden = true;
  const text = deckInput.value.trim();
  if (!text) { showSetupError('Paste a decklist first.'); return; }

  const commanderMode = commanderToggle.checked;
  const commanderNameA = commanderInput.value.trim();
  let commanderNameB = opponentCommanderInput.value.trim();
  if (commanderMode && !commanderNameA) { showSetupError('Name your commander (or turn off Commander format).'); return; }

  setButtonsBusy(true);
  try {
    let oppText = opponentDeckInput.value.trim();
    if (commanderMode && !oppText && !commanderNameB) {
      // Both left blank in Commander mode — the bot needs an actual
      // Commander deck (a real commander + a deck built for it), not the
      // generic constructed default, or it'd end up "playing" Commander
      // format with no commander at all.
      const commanderPresets = PRESET_DECKS.filter(p => p.commanderName);
      const pick = commanderPresets[Math.floor(Math.random() * commanderPresets.length)];
      oppText = pick.deckText;
      commanderNameB = pick.commanderName;
    } else if (commanderMode && oppText && !commanderNameB) {
      showSetupError("Name the opponent's commander too (or leave both the opponent decklist and commander blank to let the bot pick its own Commander deck).");
      setButtonsBusy(false);
      return;
    }
    oppText = oppText || DEFAULT_OPPONENT_DECK;
    const [mine, theirs, commanderA, commanderB] = await Promise.all([
      buildDeckFromText(text),
      buildDeckFromText(oppText),
      commanderMode ? fetchOneCard(commanderNameA) : null,
      commanderMode && commanderNameB ? fetchOneCard(commanderNameB) : null,
    ]);

    const recommendedSize = commanderMode ? 99 : 40;
    if (mine.deck.length < recommendedSize) {
      const proceed = await showConfirm(`Your deck has ${mine.deck.length} card(s) (not counting your commander), which is under the usual ${recommendedSize}-card minimum. Start anyway?`);
      if (!proceed) { setButtonsBusy(false); return; }
    }
    if (mine.unresolved.length) {
      const proceed = await showConfirm(`These cards weren't found and will be skipped:\n${mine.unresolved.join(', ')}\n\nContinue anyway?`);
      if (!proceed) { setButtonsBusy(false); return; }
    }
    if (commanderMode && commanderA) {
      const { duplicates, colorViolations } = checkCommanderLegality(mine.deck, commanderA);
      if (duplicates.length) {
        const proceed = await showConfirm(`Your deck breaks the Commander singleton rule — these cards appear more than once:\n${duplicates.join(', ')}\n\nContinue anyway?`);
        if (!proceed) { setButtonsBusy(false); return; }
      }
      if (colorViolations.length) {
        const proceed = await showConfirm(`These cards are outside ${commanderA.name}'s color identity:\n${colorViolations.join(', ')}\n\nContinue anyway?`);
        if (!proceed) { setButtonsBusy(false); return; }
      }
    }

    const cardsToAnalyze = [...mine.deck, ...theirs.deck];
    if (commanderA) cardsToAnalyze.push(commanderA);
    if (commanderB) cardsToAnalyze.push(commanderB);
    await analyzeDeck(cardsToAnalyze);

    sessionStorage.setItem(DECK_STORAGE_KEY, JSON.stringify({
      deckA: mine.deck, deckB: theirs.deck, watchMode,
      commanderMode, commanderA: commanderA || null, commanderB: commanderB || null,
    }));
    window.location.href = 'play.html';
  } catch (err) {
    showSetupError(err.message || 'Something went wrong loading that decklist.');
    setButtonsBusy(false);
  }
}

// Commander deckbuilding legality (singleton + color identity) — checked
// and warned about, same as the deck-size/unresolved-card checks above, but
// never actually enforced (nothing stops you from proceeding anyway, same
// "recognized but not required" philosophy as everywhere else non-strict in
// this engine).
export function checkCommanderLegality(deck, commander) {
  const isBasicLand = (c) => /\bBasic Land\b/.test(c.typeLine || '');
  const nameCounts = new Map();
  for (const c of deck) {
    if (isBasicLand(c)) continue;
    nameCounts.set(c.name, (nameCounts.get(c.name) || 0) + 1);
  }
  const duplicates = [...nameCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name);

  const commanderIdentity = new Set(commander.colorIdentity || []);
  const colorViolations = [];
  const seen = new Set();
  for (const c of deck) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    if ((c.colorIdentity || []).some(color => !commanderIdentity.has(color))) colorViolations.push(c.name);
  }
  return { duplicates, colorViolations };
}

async function fetchOneCard(name) {
  const { cards, notFound } = await fetchCardsByName([name]);
  if (notFound.length) throw new Error(`Commander not found on Scryfall: "${name}". Check the spelling.`);
  return cards.get(name);
}

function setButtonsBusy(busy) {
  startButton.disabled = busy;
  watchButton.disabled = busy;
  startButton.textContent = busy ? 'Fetching card data…' : 'Shuffle up & start';
}

function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.hidden = false;
  setButtonsBusy(false);
}

// Asks the server to interpret any cards (from either deck) that the
// built-in regex patterns don't already understand, showing live progress.
// Resolves once the server closes the stream — including when the server
// has no AI key configured, in which case it reports itself unavailable
// almost immediately and we just move on with regex-only support.
async function analyzeDeck(allCards) {
  const seen = new Set();
  const cards = [];
  for (const card of allCards) {
    if (!seen.has(card.name)) { seen.add(card.name); cards.push(card); }
  }

  let res;
  try {
    res = await fetch('/api/analyze-deck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards }),
    });
  } catch {
    return; // server unreachable (e.g. static hosting with no /api) — proceed without AI
  }
  if (!res.ok || !res.body) return;

  setupCard.hidden = true;
  analyzeCard.hidden = false;
  analyzeStatus.textContent = 'Checking which cards need extra help…';
  analyzeBarFill.style.width = '0%';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawAnyWork = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      handleAnalyzeMessage(JSON.parse(line));
    }
  }

  function handleAnalyzeMessage(msg) {
    if (msg.type === 'start') {
      sawAnyWork = msg.total > 0;
      analyzeStatus.textContent = msg.total > 0
        ? `Interpreting ${msg.total} new card${msg.total === 1 ? '' : 's'}…`
        : 'All cards already understood — nothing new to analyze.';
    } else if (msg.type === 'progress') {
      analyzeBarFill.style.width = `${Math.round((msg.done / msg.total) * 100)}%`;
      analyzeStatus.textContent = `Interpreted ${msg.done} / ${msg.total} — ${msg.name}`;
    } else if (msg.type === 'unavailable') {
      sawAnyWork = false;
      analyzeStatus.textContent = msg.reason;
    }
    // 'error' and 'done' messages don't need their own UI update; the loop
    // finishing is what matters.
  }

  if (sawAnyWork) {
    analyzeStatus.textContent = 'Done.';
    analyzeBarFill.style.width = '100%';
  }
  // Left showing the analyze screen deliberately — the caller navigates to
  // play.html immediately after this resolves, so switching back to the
  // setup card first would just be a flash.
}
