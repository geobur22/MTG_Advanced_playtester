// Continuous effects applied in the Comprehensive Rules' layer order
// (CR 613): 4 type-changing, 5 color-changing, 6 ability adding/removing,
// 7b base power/toughness setting. (Layer 1 copy effects are Clone's copiable
// values, layer 2 is controllerId, and 7c/7d — counters, anthems, pumps,
// switching — stay in effectivePower/effectiveToughness.)
//
// Effects come from two places: static abilities in permanents' rules text
// ("All creatures lose all abilities and have base power and toughness 1/1",
// "Enchanted creature is a green Elk creature with base power and toughness
// 3/3") and temporary spell effects stored on the affected permanent
// (perm.layerEffects — Turn to Frog, Merfolk Trickster). Within a layer they
// apply in timestamp order. Per CR 613.6, an effect that already began
// applying in an earlier layer keeps applying even if its source loses its
// abilities partway through (Humility + Opalescence).

const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const CARD_TYPES = ['artifact', 'creature', 'enchantment', 'land', 'planeswalker', 'battle'];
const BASIC_LAND_MANA = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' };
const SINGULAR = (w) => (w === 'plains' ? 'plains' : w.replace(/(ie)s$/, 'y').replace(/(?<!s)s$/, ''));
const cap = (w) => w.split(/\s+/).map(x => x[0].toUpperCase() + x.slice(1)).join(' ');

// ---------- parsing ----------

// Subject of a layer sentence → { match(perm, source, game, ctx), rest } or null.
function parseSubject(text) {
  const S = [
    [/^(?:other creatures|each other creature)\b/, () => ({ type: 'creature', other: true })],
    [/^each other non-aura enchantment you control\b/, () => ({ type: 'enchantment', nonAura: true, other: true, mine: true })],
    [/^each other non-aura enchantment\b/, () => ({ type: 'enchantment', nonAura: true, other: true })],
    [/^each noncreature artifact\b/, () => ({ type: 'artifact', noncreature: true })],
    [/^(?:nonbasic lands|each nonbasic land)\b/, () => ({ type: 'land', nonbasic: true })],
    [/^(?:each land|all lands|lands)\b/, () => ({ type: 'land' })],
    [/^(?:all permanents|each permanent)\b/, () => ({ type: 'any' })],
    [/^creatures your opponents control\b/, () => ({ type: 'creature', opp: true })],
    [/^creatures you control\b/, () => ({ type: 'creature', mine: true })],
    [/^creatures enchanted player controls\b/, () => ({ type: 'creature', enchantedPlayer: true })],
    [/^enchanted (?:creature|permanent|artifact|land)\b/, () => ({ type: 'any', attached: true })],
    [/^(?:each creature|creatures) target player controls\b/, () => ({ type: 'creature', targetPlayer: true })],
    [/^(?:target creature|it)\b/, () => ({ type: 'any', target: true })],
    [/^(?:all creatures|creatures)\b/, () => ({ type: 'creature' })],
  ];
  for (const [re, mk] of S) {
    const m = text.match(re);
    if (m) return { subject: mk(), rest: text.slice(m[0].length).trim() };
  }
  return null;
}

// Parses a type/color description such as "a green Elk creature",
// "a colorless Forest land", "mountains", "an Insect artifact creature".
function parseDescription(desc) {
  const out = { colors: null, cardTypes: [], subtypes: [] };
  const words = desc.replace(/^(?:an?|the)\s+/, '').split(/\s+/).filter(w => w && w !== 'and');
  for (const raw of words) {
    const w = raw.replace(/,$/, '');
    if (COLOR_WORDS[w]) (out.colors ||= []).push(COLOR_WORDS[w]);
    else if (w === 'colorless') out.colors = [];
    else if (CARD_TYPES.includes(SINGULAR(w))) out.cardTypes.push(SINGULAR(w));
    else if (/^[a-z'-]+$/.test(w)) out.subtypes.push(SINGULAR(w));
    else return null;
  }
  return out;
}

// One static sentence (lowercased, reminder text removed) → effect or null.
export function parseLayerSentence(sentence) {
  let text = sentence.trim().replace(/\.$/, '');
  let condition = null, untilEot = false;
  const cond = text.match(/^as long as (.+?), (.+)$/);
  if (cond) { condition = cond[1]; text = cond[2]; }
  if (/^until end of turn, /.test(text)) { untilEot = true; text = text.replace(/^until end of turn, /, ''); }
  if (/ until end of turn$/.test(text)) { untilEot = true; text = text.replace(/ until end of turn$/, ''); }
  const subj = parseSubject(text);
  if (!subj) return null;
  let r = subj.rest;
  const eff = { subject: subj.subject, condition, untilEot };
  let parts = 0;
  while (r.length) {
    r = r.replace(/^(?:,\s*|\s+)?(?:and\s+)?(?:it\s+)?/, '');
    if (!r) break;
    let m;
    if ((m = r.match(/^loses? all (other )?(?:abilities, card types, and creature types|card types and abilities|abilities)/))) {
      eff.loseAll = true;
      if (/card types/.test(m[0])) eff.loseTypes = true;
      r = r.slice(m[0].length); parts++; continue;
    }
    if ((m = r.match(/^(?:has|have) base power and (?:base )?toughness (\d+)\/(\d+)/))) {
      eff.basePT = { power: +m[1], toughness: +m[2] };
      r = r.slice(m[0].length); parts++; continue;
    }
    if ((m = r.match(/^(?:has|have) base power and (?:base )?toughness each equal to (?:its|their) mana value/))) {
      eff.basePT = 'mv';
      r = r.slice(m[0].length); parts++; continue;
    }
    if ((m = r.match(/^(?:is|are|becomes?|become) (?!the )((?:an? )?[a-z' ,-]+?)(?= with | in addition| named |, |$| and (?:has|have|loses?|is|it)\b)/))) {
      const d = parseDescription(m[1]);
      if (!d) return null;
      r = r.slice(m[0].length);
      let additive = false;
      const add = r.match(/^ in addition to (?:its|their) other (?:types|colors and types|land types|creature types|colors)/);
      if (add) { additive = true; r = r.slice(add[0].length); }
      let pm;
      while ((pm = r.match(/^ with (?:base )?power and (?:base )?toughness (?:(\d+)\/(\d+)|each equal to (?:its|their) mana value)|^ with "([^"]+)"|^ named ([a-z' ,-]+?)(?=$|,)/))) {
        if (pm[1]) eff.basePT = { power: +pm[1], toughness: +pm[2] };
        else if (pm[3]) eff.grantText = (eff.grantText ? eff.grantText + '\n' : '') + pm[3];
        else if (pm[4]) eff.name = cap(pm[4]);
        else eff.basePT = 'mv';
        r = r.slice(pm[0].length);
        const add2 = r.match(/^ in addition to (?:its|their) other (?:types|colors and types|land types|creature types|colors)/);
        if (add2) { additive = true; r = r.slice(add2[0].length); }
      }
      eff.desc = { ...d, additive };
      parts++; continue;
    }
    if ((m = r.match(/^(?:has|have) "([^"]+)"/))) {
      eff.grantText = (eff.grantText ? eff.grantText + '\n' : '') + m[1];
      r = r.slice(m[0].length); parts++; continue;
    }
    if ((m = r.match(/^(?:has|have) ([a-z ]+?)(?=,|$| and (?:loses?|is|has|it)\b)/)) && !/base power/.test(m[1])) {
      eff.grantKeywords = [...(eff.grantKeywords || []), ...m[1].split(/\s+and\s+/).map(x => x.trim())];
      r = r.slice(m[0].length); parts++; continue;
    }
    // A trailing non-layer restriction ("... and doesn't untap during its
    // controller's untap step") is handled elsewhere.
    if (parts && /^(?:doesn'?t|can'?t|gets?) /.test(r)) break;
    return null;
  }
  if (!parts) return null;
  // Pure keyword grants are anthems, handled by the anthem code.
  if (!eff.loseAll && !eff.desc && !eff.basePT && !eff.loseTypes) return null;
  return eff;
}

// ---------- applying ----------

function subjectMatches(game, eff, perm, state, source) {
  const s = eff.subject;
  if (s.other && source && source.id === perm.id) return false;
  if (s.attached) return source && source.attachedTo === perm.id;
  if (s.target) return eff._targetIds?.includes(perm.id);
  if (s.targetPlayer) return eff._targetPlayerId === perm.controllerId && /\bcreature\b/i.test(state.typeLine);
  if (s.mine && source && perm.controllerId !== source.controllerId) return false;
  if (s.opp && source && perm.controllerId === source.controllerId) return false;
  if (s.enchantedPlayer && (!source || source.attachedToPlayerId !== perm.controllerId)) return false;
  const tl = state.typeLine.toLowerCase();
  if (s.type !== 'any' && !new RegExp(`\\b${s.type}\\b`).test(tl)) return false;
  if (s.nonAura && /\baura\b/.test(tl)) return false;
  if (s.noncreature && /\bcreature\b/.test(tl)) return false;
  if (s.nonbasic && /\bbasic\b/.test(tl)) return false;
  return true;
}

function splitTypeLine(typeLine) {
  const [left, right = ''] = typeLine.split(/\s+—\s+/);
  const words = left.split(/\s+/).filter(Boolean);
  const supers = words.filter(w => ['Legendary', 'Basic', 'Snow', 'World', 'Token', 'Kindred', 'Tribal'].includes(w));
  const types = words.filter(w => !supers.includes(w));
  return { supers, types, subtypes: right.split(/\s+/).filter(Boolean) };
}
function joinTypeLine({ supers, types, subtypes }) {
  const left = [...supers, ...types].join(' ');
  return subtypes.length ? `${left} — ${subtypes.join(' ')}` : left;
}

function applyTypes(state, desc, loseTypes) {
  const tl = splitTypeLine(state.typeLine);
  const newTypes = desc.cardTypes.map(cap);
  const newSubs = desc.subtypes.map(cap);
  const landSubs = newSubs.filter(s => BASIC_LAND_MANA[s.toLowerCase()]);
  if (desc.additive) {
    for (const t of newTypes) if (!tl.types.includes(t)) tl.types.push(t);
    for (const s of newSubs) if (!tl.subtypes.includes(s)) tl.subtypes.push(s);
    for (const s of landSubs) {
      const L = BASIC_LAND_MANA[s.toLowerCase()];
      if (!state.producedMana.includes(L)) state.producedMana = [...state.producedMana, L];
      state.text += `\n{T}: Add {${L}}.`;
    }
  } else if (newTypes.length || loseTypes) {
    // New card types replace the old ones, and the subtypes with them.
    if (newTypes.length) tl.types = newTypes;
    tl.subtypes = newSubs;
    if (landSubs.length) {
      state.text = landSubs.map(s => `{T}: Add {${BASIC_LAND_MANA[s.toLowerCase()]}}.`).join('\n');
      state.keywords = [];
      state.producedMana = landSubs.map(s => BASIC_LAND_MANA[s.toLowerCase()]);
      state.lostLandAbilities = true;
    } else if (newTypes.includes('Land')) state.producedMana = [];
  } else if (newSubs.length) {
    // Only subtypes named ("Nonbasic lands are Mountains", "is a Treefolk"):
    // they replace the subtypes of that kind; a basic land type also wipes
    // the land's own abilities and grants its mana ability (CR 305.7).
    if (landSubs.length) {
      tl.subtypes = tl.subtypes.filter(s => !/^(?:plains|island|swamp|mountain|forest|desert|gate|locus|lair|cave|sphere|urza's|mine|power-plant|tower|town)$/i.test(s));
      tl.subtypes.push(...newSubs);
      state.text = landSubs.map(s => `{T}: Add {${BASIC_LAND_MANA[s.toLowerCase()]}}.`).join('\n');
      state.keywords = [];
      state.producedMana = landSubs.map(s => BASIC_LAND_MANA[s.toLowerCase()]);
      state.lostLandAbilities = true;
    } else {
      tl.subtypes = newSubs;
    }
  }
  state.typeLine = joinTypeLine(tl);
}

// Runs every layer for all permanents. `base(perm)` is the card before
// layering; returns the layered card per permanent (or the base itself when
// nothing applies).
export function computeLayers(game, perms, base) {
  // Collect effects with their sources and timestamps.
  const effects = [];
  for (const src of perms) {
    const card = base(src);
    const text = (card.oracleText || '').toLowerCase().replace(/\([^()]*\)/g, '');
    if (!/lose|is a|are |base power|is an|becomes?|in addition/.test(text)) continue;
    for (const line of text.split('\n')) {
      for (const sentence of line.split(/(?<=\.)\s+/)) {
        const eff = game.layerSentence(sentence, card);
        if (!eff || eff.subject.target || eff.subject.targetPlayer) continue;
        if (eff.condition) {
          const test = game.parseConditionPublic(eff.condition);
          if (!test || !test(game, { controllerId: src.controllerId, sourcePerm: src, card })) continue;
        }
        effects.push({ ...eff, source: src, timestamp: src.timestamp || 0 });
      }
    }
  }
  for (const perm of perms) for (const le of perm.layerEffects || []) effects.push({ ...le.effect, subject: { type: 'any', target: true }, _targetIds: [perm.id], source: null, timestamp: le.timestamp });
  if (!effects.length) return null;
  effects.sort((a, b) => a.timestamp - b.timestamp);

  const states = new Map();
  for (const perm of perms) {
    const c = base(perm);
    states.set(perm, { typeLine: c.typeLine || '', colors: [...(c.colors || [])], text: c.oracleText || '', keywords: [...(c.keywords || [])], power: c.power, toughness: c.toughness, producedMana: [...(c.producedMana || [])], name: c.name, touched: false, lostAllTs: null, ptSet: false });
  }
  const started = new Set(); // effects that have begun applying (CR 613.6)
  const appliesTo = new Map(); // effect → perms it applies to (locked once started)
  const targetsOf = (eff, layer) => {
    if (appliesTo.has(eff)) return appliesTo.get(eff);
    // An ability removed by an earlier effect never starts.
    if (eff.source && states.get(eff.source)?.lostAllTs != null && states.get(eff.source).lostAllTs < eff.timestamp && !started.has(eff)) return [];
    if (eff.source && states.get(eff.source)?.lostLandAbilities && /\bland\b/i.test(base(eff.source).typeLine || '') && !started.has(eff)) return [];
    const list = perms.filter(p => subjectMatches(game, eff, p, states.get(p), eff.source));
    appliesTo.set(eff, list);
    started.add(eff);
    return list;
  };

  // Layer 4: types. Dependency (CR 613.8): an effect that sets a basic land
  // type (Blood Moon) removes the abilities of the lands it hits, so it goes
  // before any effect those lands generate (Urborg), whatever the timestamps.
  const isLandSetter = (e) => e.desc && !e.desc.additive && e.desc.subtypes.some(s => BASIC_LAND_MANA[s]);
  const layer4 = [...effects.filter(isLandSetter), ...effects.filter(e => !isLandSetter(e))];
  for (const eff of layer4) {
    if (!eff.desc && !eff.loseTypes) continue;
    for (const p of targetsOf(eff, 4)) {
      const st = states.get(p);
      applyTypes(st, eff.desc || { cardTypes: [], subtypes: [], additive: false }, eff.loseTypes);
      if (eff.name) st.name = eff.name;
      st.touched = true;
    }
  }
  // Layer 5: colors.
  for (const eff of effects) {
    if (!eff.desc || eff.desc.colors === null) continue;
    for (const p of targetsOf(eff, 5)) {
      const st = states.get(p);
      st.colors = eff.desc.additive ? [...new Set([...st.colors, ...eff.desc.colors])] : [...eff.desc.colors];
      st.touched = true;
    }
  }
  // Layer 6: abilities.
  for (const eff of effects) {
    if (!eff.loseAll && !eff.grantKeywords && !eff.grantText) continue;
    for (const p of targetsOf(eff, 6)) {
      const st = states.get(p);
      if (eff.loseAll) { st.text = ''; st.keywords = []; st.lostAllTs = eff.timestamp; if (/\bland\b/i.test(st.typeLine) && !eff.grantText) st.producedMana = []; }
      if (eff.grantKeywords) for (const k of eff.grantKeywords) { if (!st.keywords.includes(k)) st.keywords.push(k); st.text = `${k[0].toUpperCase() + k.slice(1)}\n${st.text}`.trim(); }
      if (eff.grantText) {
        st.text = `${st.text}\n${eff.grantText}`.trim();
        const mana = eff.grantText.match(/\{t\}: add \{([wubrgc])\}/i);
        if (mana) st.producedMana = [...new Set([...st.producedMana, mana[1].toUpperCase()])];
        if (/add one mana of any color/i.test(eff.grantText)) st.producedMana = ['W', 'U', 'B', 'R', 'G'];
      }
      st.touched = true;
    }
  }
  // Layer 7b: base power and toughness.
  for (const eff of effects) {
    if (!eff.basePT) continue;
    for (const p of targetsOf(eff, 7)) {
      const st = states.get(p);
      if (eff.basePT === 'mv') { const mv = base(p).cmc || 0; st.power = String(mv); st.toughness = String(mv); }
      else { st.power = String(eff.basePT.power); st.toughness = String(eff.basePT.toughness); }
      st.ptSet = true; st.touched = true;
    }
  }

  const out = new Map();
  for (const perm of perms) {
    const st = states.get(perm);
    if (!st.touched) continue;
    const b = base(perm);
    out.set(perm, { ...b, name: st.name, typeLine: st.typeLine, colors: st.colors, oracleText: st.text, keywords: st.keywords, power: st.power, toughness: st.toughness, producedMana: st.producedMana, _layerOf: b, _lostAllTs: st.lostAllTs, _ptSetByLayer: st.ptSet });
  }
  return out;
}
