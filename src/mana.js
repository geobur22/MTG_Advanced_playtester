const COLORS = ['W', 'U', 'B', 'R', 'G'];

// Parses a mana cost string like "{2}{R}{R}" or "{X}{W/U}" into
// { generic, colors: {W,U,B,R,G}, hybrid: [[opts]], x }
export function parseManaCost(cost) {
  const result = { generic: 0, colors: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, hybrid: [], x: 0 };
  if (!cost) return result;
  const symbols = cost.match(/\{[^}]+\}/g) || [];
  for (const sym of symbols) {
    const inner = sym.slice(1, -1);
    if (inner === 'X') { result.x += 1; continue; }
    if (/^\d+$/.test(inner)) { result.generic += parseInt(inner, 10); continue; }
    if (inner === 'C') { result.colors.C += 1; continue; }
    if (COLORS.includes(inner)) { result.colors[inner] += 1; continue; }
    if (inner.includes('/')) { result.hybrid.push(inner.split('/')); continue; }
  }
  return result;
}

export function manaCostLabel(cost) {
  return cost || '{0}';
}

export function totalCmc(parsed) {
  const colorTotal = Object.values(parsed.colors).reduce((a, b) => a + b, 0);
  return parsed.generic + colorTotal + parsed.hybrid.length + parsed.x;
}

// Given untapped lands (permanents), a parsed cost, and an optional floating
// mana pool ({W,U,B,R,G,C} counts, e.g. from activated mana abilities),
// decides how to pay it — spending pool mana before tapping any land, then
// tapping lands for whatever's left. Returns { lands: [permanent,...],
// poolUsed: {W,U,B,R,G,C} } or null if it can't be paid.
export function planManaPayment(untappedLands, parsedCost, xValue = 0, pool = null) {
  const remaining = { ...parsedCost.colors };
  // parsedCost.x counts how many {X} SYMBOLS appear in the cost (Hangarback
  // Walker's own "{X}{X}" parses to x:2) — a double (or triple) X cost
  // charges xValue once for EACH occurrence, not just once total. Every
  // single-X card (the overwhelming majority) has x:1, so this is a no-op
  // multiplication for them; it only changes behavior for a genuinely
  // multi-X cost, which no caller was separately accounting for.
  let genericNeeded = parsedCost.generic + xValue * (parsedCost.x || 0);
  const hybridNeeded = parsedCost.hybrid.slice();

  const poolRemaining = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...(pool || {}) };
  const poolUsed = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

  const available = untappedLands.map(land => ({
    land,
    produces: (land.card.producedMana || []).filter(c => c !== 'C' || true),
  }));

  const used = new Set();

  function takeFromPool(color) {
    if (poolRemaining[color] > 0) { poolRemaining[color]--; poolUsed[color]++; return true; }
    return false;
  }

  function takeForColor(color) {
    if (takeFromPool(color)) return true;
    const candidate = available.find(a => !used.has(a.land.id) && a.produces.includes(color));
    if (candidate) { used.add(candidate.land.id); return true; }
    return false;
  }

  for (const color of COLORS.concat('C')) {
    while (remaining[color] > 0) {
      if (!takeForColor(color)) return null;
      remaining[color]--;
    }
  }

  for (const opts of hybridNeeded) {
    let paid = false;
    for (const color of opts) {
      if (takeForColor(color)) { paid = true; break; }
    }
    if (!paid) return null;
  }

  while (genericNeeded > 0) {
    const anyPoolColor = Object.keys(poolRemaining).find(c => poolRemaining[c] > 0);
    if (anyPoolColor) { takeFromPool(anyPoolColor); genericNeeded--; continue; }
    const candidate = available.find(a => !used.has(a.land.id));
    if (!candidate) return null;
    used.add(candidate.land.id);
    genericNeeded--;
  }

  return { lands: available.filter(a => used.has(a.land.id)).map(a => a.land), poolUsed };
}
