# MTG Advanced Playtester

A browser-based Magic: The Gathering game you can play against a bot, using any decklist you paste in. Card data (rules text, mana cost, power/toughness, images) comes live from the free [Scryfall API](https://scryfall.com/docs/api), so most real cards just work.

Built this to actually playtest decks against a reasonable opponent without needing a second person or a paid MTGO sub. It's not Forge or MTGO — there's no full rules engine, just a regex-based interpreter for common oracle-text patterns (damage, counters, triggers, keywords, etc.) with an optional AI fallback for cards it doesn't recognize. Anything genuinely unmodeled just no-ops cleanly and logs it rather than breaking the game.

## Running it

```bash
node server.mjs
```

Then open `http://localhost:8000`. Plain static hosting (`python3 -m http.server`, Netlify, GitHub Pages, etc.) also works for just playing — you only need `server.mjs` for the optional AI card-interpretation step below.

## Playing

Paste a decklist (`4 Lightning Bolt` format, one per line) on the setup screen, optionally paste an opponent deck too (or leave it blank for a built-in preset), and hit **Shuffle up & start**. Click lands/spells to play them, click targets when prompted, use the action bar for combat and passing priority. Check **Commander format** for a 1v1 Commander duel instead (40 life, command zone, commander damage).

There's also a **Watch AI vs AI** mode if you just want to see how a deck's plan plays out without piloting it yourself.

## AI-assisted card interpretation (optional)

Set `XAI_API_KEY` (from [console.x.ai](https://console.x.ai)) before running `server.mjs` and it'll use an AI model to interpret cards the regex patterns miss, automatically, the moment you submit a decklist. Without a key, unrecognized cards just resolve as a no-op — same as always, just dumber.

## Testing without a browser

```bash
node scripts/simulate.mjs scripts/decks/mono-red-aggro.txt scripts/decks/gruul-ramp.txt 10
node scripts/findGaps.mjs
```

`simulate.mjs` plays full bot-vs-bot games headlessly and flags crashes/stalls/unmodeled cards. `findGaps.mjs` runs every preset deck against every other one and dumps a deduped report of everything the interpreter couldn't handle — the quickest way to find what's worth adding next. `runAudit.mjs` does a deeper AI-cross-referenced version of the same thing.

## What works / what doesn't

Turn structure, priority, the stack, combat (first strike, trample, deathtouch, flying, menace, etc.), most triggered and activated abilities, Commander format, modal spells, equipment, planeswalkers, and a decent chunk of the interpreter's own pattern library for common spell/trigger shapes — covers a lot of constructed and Commander staples out of the box.

Not modeled: 4-player multiplayer, Vehicles/Crew, transforming/adventure/split cards (only the front face works), and delayed triggers that fire on some future event rather than at resolution. These are real architecture gaps, not small missing patterns — see the comments in `src/effects.js`/`src/game.js` if you want to dig in.
