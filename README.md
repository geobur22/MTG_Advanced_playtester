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

Clicking a permanent that can do more than one thing (a tap ability and an equip, a planeswalker with several loyalty abilities, Kenrith's five non-tap abilities, etc.) now pops up a choice menu instead of guessing which one you meant — same for a dual/multicolor land's mana ability, which offers one button per color instead of auto-picking for you.

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

Keyword coverage is being worked through against the Comprehensive Rules' full keyword list (702.x). Added so far: Cycling (including landcycling/typecycling), Buyback, Exalted, Unearth, Bloodthirst, Fabricate, Scavenge, Outlast, Protection, Fear, Intimidate, Landwalk, Convoke, Improvise, Delve, Affinity, Undaunted, Suspend, Miracle, Entwine, Transmute, Bushido, Afflict, Renown, Mentor, Training, Afterlife, Decayed, Compleated (plus Phyrexian mana in general, which can now be paid with 2 life), Infect (with an actual 10-poison loss), Wither, Toxic, Annihilator, Battle Cry, Dethrone, Melee, Exploit, Evolve, Ravenous, Riot, Unleash, Ingest, Enlist, Frenzy, Provoke, Shadow, Horsemanship, Flanking, and Rampage. Alternative costs work too — Dash, Blitz, Evoke, Emerge, Spectacle, Prowl, Surge, Freerunning, and Prototype — and show up as extra buttons when you click the card. Cards can be cast from the graveyard and exile the ways the rules allow — Flashback, Escape, Jump-start, Retrace, Mayhem, Rebound, Madness, Foretell, Plot, and Warp — and Embalm, Eternalize, Encore, Dredge, and Recover work too. Storm, Gravestorm, Cascade, Ripple, Split Second, Cipher, Epic, and Demonstrate are in as well, plus counter and upkeep keywords like Modular, Sunburst, Vanishing, Fading, Cumulative Upkeep, Amplify, Devour, Tribute, Champion, Hideaway, Soulshift, Forecast, Reinforce, Boast, Exhaust, and Read Ahead. The monarch, Ascend (the city's blessing), Extort, Amass, Changeling, Overload, Soulbond, Umbra Armor, Absorb, Fortify, For Mirrodin!, Transfigure, and Aura Swap work too, as do face-down cards (Morph, Megamorph, Disguise, Manifest, Cloak), Mutate, and Phasing. Recent-set mechanics are in too: Web-slinging, Sneak, Firebending, Job Select, Mobilize, Paradigm, Power-up, Tiered, Teamwork, Increment, Harmonize, speed/Max Speed, Storied, and Infinity Stone harnessing. Leveler creatures (Level Up), Persist, Bestow, Graft, Haunt, Skulk, and Splice onto Arcane work as well. Ability words are understood too: conditions like Threshold, Morbid, Raid, Revolt, Metalcraft, Delirium, Spell Mastery, Ferocious, Coven, and Descend (including "... instead if ..." upgrades and "as long as ..." bonuses), counts like Domain, Converge, and Chroma, triggers like Enrage, Inspired, Battalion, Valiant, Survival, and Flurry, hand abilities (Channel, Bloodrush), Renew, and the voting cards. Infinite loops follow the real rules: a loop of mandatory triggers (Polyraptor + Marauding Raptor) ends the game in a draw, and a loop with an optional step stops after 100 repetitions. Permanents that only sometimes count as creatures work properly: Vehicles (Crew), Mounts (Saddle), Spacecraft (Station), Reconfigure Equipment, Living Weapon, Awaken, Impending, Living Metal, and the Theros Gods' devotion check. Double-faced, split, and adventure cards are fully supported: transforming (including day/night werewolves, Disturb, Craft, and More Than Meets the Eye), modal double-faced cards (either face, including land backs), split cards with Fuse and Aftermath, and Adventures. In Commander, you can play two partner commanders (type them as "Name + Name"), and any deck can have a companion that you bring into your hand for {3}. Optional costs paid while casting work too: Kicker, Escalate, Spree, Replicate, Conspire, Casualty, Squad, Offspring, Bargain, and Gift (plus Backup on entry). Static evasion like "this creature can't be blocked" (and its "except by..." variants) is also read now — it used to be ignored entirely. Whenever a card gives you a real choice — cast it or cycle/suspend/transmute it, Fabricate's counters or Servos, a miracle — you get buttons for it.

That pass also turned up two AI bugs worth knowing about. The AI was tapping every land at the start of each main phase whether it spent the mana or not, so unspent mana evaporated and its lands sat tapped through its second main phase and your whole turn — it could never actually hold up a counterspell. It casts noticeably more spells per game now. It also never used a non-mana `{T}` ability at all (Icy Manipulator, fetchlands, Food, etc.), which it now does. Later passes fixed it sacrificing every Treasure at the start of each main phase whether or not it needed the mana, and "destroy target artifact"-style removal that could only ever hit creatures. Dead tokens also used to stay in graveyards (where they could be reanimated); they now cease to exist like they should. A final sweep found Prowess never triggered and Defender wasn't enforced (walls could attack); both work now.

The second pass fixed a few more real bugs along the way: Menace was never actually enforced; tribal lords like Lord of Atlantis did nothing while Elvish Archdruid pumped every creature instead of just Elves; "target player or planeswalker" spells (Lava Spike, Boros Charm) couldn't target a player at all; counterspells could only ever hit instants and sorceries (a plain Counterspell couldn't counter a creature); and cards with no mana cost, like Ancestral Vision, could be cast for free.

Not modeled: 4-player multiplayer, Vehicles/Crew, transforming/adventure/split cards (only the front face works), and delayed triggers that fire on some future event rather than at resolution. These are real architecture gaps, not small missing patterns — see the comments in `src/effects.js`/`src/game.js` if you want to dig in.

The AI knows better than to loop pointlessly on a break-even combo (Basalt Monolith's own tap-for-3/pay-3-to-untap, say) — fixed after `findGaps.mjs` caught it tripping the action safety cap instead of ever doing anything useful with its turn.
