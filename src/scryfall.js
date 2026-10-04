// Card data layer. Talks to the public Scryfall API (https://scryfall.com/docs/api)
// and normalizes results into the shape the game engine expects.

const CACHE = new Map(); // name (lowercased) -> normalized card

// Exported so other Scryfall-querying scripts (e.g. seed-staples.mjs, which
// hits /cards/search rather than /cards/collection) can reuse the exact same
// normalization instead of re-implementing double-faced-card handling.
export function normalize(raw) {
  // Double-faced cards store power/toughness/oracle text on card_faces.
  const face = raw.card_faces && raw.card_faces.length ? raw.card_faces[0] : raw;
  return {
    id: raw.id,
    name: raw.name,
    manaCost: face.mana_cost || raw.mana_cost || '',
    cmc: raw.cmc || 0,
    typeLine: raw.type_line || '',
    oracleText: face.oracle_text || raw.oracle_text || '',
    power: face.power ?? raw.power ?? null,
    toughness: face.toughness ?? raw.toughness ?? null,
    colors: raw.colors || face.colors || [],
    colorIdentity: raw.color_identity || [],
    keywords: (raw.keywords || []).map(k => k.toLowerCase()),
    loyalty: raw.loyalty ?? face.loyalty ?? null,
    producedMana: raw.produced_mana || null,
    image: (raw.image_uris && raw.image_uris.normal) ||
           (face.image_uris && face.image_uris.normal) || null,
  };
}

// Scryfall's /cards/collection endpoint matches the "name" identifier
// exactly, but double-faced/split/adventure cards are only indexed by each
// individual face name there, never by their combined "Front // Back"
// display name. Send the front face's name instead so these still resolve;
// the response's raw.name (the full combined name) is what gets cached, so
// callers can keep looking cards up by the combined name as usual.
function lookupIdentifier(name) {
  const slash = name.indexOf(' // ');
  return slash === -1 ? name : name.slice(0, slash);
}

// Fetches many cards by exact name in as few requests as possible using
// Scryfall's /cards/collection batch endpoint (max 75 identifiers per call).
export async function fetchCardsByName(names) {
  const uniqueNames = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  const toFetch = uniqueNames.filter(n => !CACHE.has(n.toLowerCase()));

  const chunks = [];
  for (let i = 0; i < toFetch.length; i += 75) chunks.push(toFetch.slice(i, i + 75));

  const notFound = [];

  for (const chunk of chunks) {
    const identifierToName = new Map(chunk.map(name => [lookupIdentifier(name), name]));
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      // Accept and User-Agent are required by Scryfall's API. Browsers send
      // both automatically (and forbid scripts from setting User-Agent
      // themselves, so this line is a no-op there); Node's fetch doesn't
      // send either by default, so this also lets this module run outside
      // the browser (e.g. from a Node script, not just from setup.js).
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'mtg-game' },
      body: JSON.stringify({ identifiers: chunk.map(name => ({ name: lookupIdentifier(name) })) }),
    });
    if (!res.ok) throw new Error(`Scryfall request failed (${res.status})`);
    const data = await res.json();
    for (const raw of data.data) {
      const card = normalize(raw);
      CACHE.set(raw.name.toLowerCase(), card);
      // A double-faced card requested by its front face alone (e.g. "Kumano
      // Faces Kakkazan", the common way to write a decklist) comes back with
      // raw.name set to the full combined "Front // Back" name — caching
      // only under that would leave the original request unresolved, since
      // the later lookup below is keyed by what was actually asked for.
      // lookupIdentifier(raw.name) reconstructs the identifier Scryfall was
      // sent, so this also cache-hits when the request already used the
      // combined name (a no-op re-set in that case).
      const requestedName = identifierToName.get(lookupIdentifier(raw.name));
      if (requestedName) CACHE.set(requestedName.toLowerCase(), card);
    }
    for (const nf of data.not_found || []) {
      notFound.push(identifierToName.get(nf.name) || nf.name);
    }
  }

  const result = new Map();
  for (const name of uniqueNames) {
    const card = CACHE.get(name.toLowerCase());
    if (card) result.set(name, card);
  }
  return { cards: result, notFound };
}

export function getCached(name) {
  return CACHE.get(name.toLowerCase()) || null;
}
