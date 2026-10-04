// Renders a mana cost string like "{2}{R}{R}" or "{X}{W/U}" as a row of
// small colored pips (the familiar circular mana symbols) instead of raw
// text like "2RR" — which is what card.manaCost.replace(/[{}]/g, '') used
// to produce everywhere it was shown.

const PIP_BACKGROUND = { W: '#F8F6D8', U: '#0E68AB', B: '#150B00', R: '#D3202A', G: '#00733E', C: '#CAC5C0' };
const PIP_TEXT_COLOR = { W: '#000', U: '#fff', B: '#fff', R: '#fff', G: '#fff', C: '#000' };

function renderManaPip(inner) {
  const upper = inner.toUpperCase();
  const span = document.createElement('span');
  span.className = 'mana-pip';

  if (upper.includes('/')) {
    const parts = upper.split('/');
    if (parts.includes('P')) {
      // Phyrexian mana ({B/P}, ...): pay the color or 2 life.
      const color = parts.find(p => p !== 'P') || 'C';
      span.style.background = PIP_BACKGROUND[color] || PIP_BACKGROUND.C;
      span.style.color = PIP_TEXT_COLOR[color] || '#000';
      span.textContent = 'Φ';
      span.title = `{${inner}}: ${color} or 2 life`;
    } else {
      // Hybrid ({W/U}, {2/B}, ...): split background between both options.
      const [a, b] = parts;
      const colorOf = (p) => PIP_BACKGROUND[p] || PIP_BACKGROUND.C;
      span.style.background = `linear-gradient(135deg, ${colorOf(a)} 50%, ${colorOf(b)} 50%)`;
      span.style.color = '#000';
      span.textContent = '';
      span.title = `{${inner}}: ${a} or ${b}`;
    }
  } else if (PIP_BACKGROUND[upper]) {
    span.style.background = PIP_BACKGROUND[upper];
    span.style.color = PIP_TEXT_COLOR[upper];
    span.textContent = upper;
    span.title = upper;
  } else {
    // Generic number, X/Y/Z, or an unrecognized symbol (energy, ...) — a
    // plain colorless-styled pip with the symbol's own text is still more
    // readable than raw braces.
    span.style.background = PIP_BACKGROUND.C;
    span.style.color = PIP_TEXT_COLOR.C;
    span.textContent = upper;
  }
  return span;
}

// Returns a DocumentFragment of pip spans for a mana cost string, or an
// empty fragment if there's nothing to show (lands, etc.).
export function renderManaCost(cost) {
  const frag = document.createDocumentFragment();
  const symbols = (cost || '').match(/\{[^}]+\}/g) || [];
  for (const sym of symbols) frag.appendChild(renderManaPip(sym.slice(1, -1)));
  return frag;
}
