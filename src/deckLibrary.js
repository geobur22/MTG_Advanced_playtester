// User-named saved decks, persisted in this browser's localStorage (not
// sessionStorage — these should survive closing the tab, unlike the
// in-flight deck handoff to play.html). Separate from the built-in presets
// in presets.js, which are code, not user data.

const STORAGE_KEY = 'proxyTableSavedDecks';

export function loadSavedDecks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeSavedDecks(decks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
  } catch {
    // Storage full or unavailable (private browsing, etc.) — the save
    // silently doesn't persist rather than breaking the setup flow.
  }
}

// Saves under `name`, overwriting any existing saved deck with that exact
// name (so re-saving the same name is an update, not a duplicate).
export function saveDeck(name, deckText, commanderName = '') {
  const decks = loadSavedDecks().filter(d => d.name !== name);
  decks.push({ id: `saved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, deckText, commanderName });
  writeSavedDecks(decks);
  return decks;
}

export function deleteSavedDeck(id) {
  writeSavedDecks(loadSavedDecks().filter(d => d.id !== id));
}
