// Built-in ready-to-play decks — shown in the deck-library dropdown on the
// setup screen alongside anything the user has saved themselves. Kept as
// plain data (not fetched from the server) so this still works if the game
// is ever hosted as static files with no server.mjs behind it.
//
// Every deck in ../scripts/decks/ is included here verbatim (same source
// this project's own bot-vs-bot testing/audit tooling uses), so picking any
// of them and hitting "Watch AI vs AI" reproduces a known-good, already-
// tested matchup — including the deliberately-non-singleton "AI stress-
// test" decks used to exercise as many different effect shapes as possible.
// Korvold and Edgar Markov below have no scripts/decks/ file of their own
// (UI-only presets) and are kept as-is.

export const PRESET_DECKS = [
  {
    id: 'preset-deck-boros-equipment',
    name: "Boros Equipment",
    commanderName: "",
    deckText: `
9 Plains
9 Mountain
2 Sacred Foundry
4 Elite Vanguard
4 Kor Skyfisher
4 Bonesplitter
4 Lightning Greaves
4 Sword of Fire and Ice
4 Rancor
4 Pacifism
4 Lightning Bolt
4 Journey to Nowhere
4 Boros Charm
`.trim(),
  },
  {
    id: 'preset-deck-commander-ai-heavy',
    name: "Commander: AI Stress-Test Deck (Meren, Multiples Allowed)",
    commanderName: "Meren of Clan Nel Toth",
    deckText: `
10 Swamp
10 Forest
2 Overgrown Tomb
2 Woodland Cemetery
4 Blood Artist
4 Zulaport Cutthroat
4 Carrion Feeder
4 Reassembling Skeleton
4 Grave Pact
4 Attrition
4 Woe Strider
4 Eternal Witness
4 Massacre Wurm
4 Mikaeus, the Unhallowed
4 Sign in Blood
4 Nature's Lore
`.trim(),
  },
  {
    id: 'preset-deck-commander-boros',
    name: "Commander: Aurelia, the Warleader (Boros)",
    commanderName: "Aurelia, the Warleader",
    deckText: `
15 Plains
15 Mountain
1 Sacred Foundry
1 Command Tower
1 Clifftop Retreat
1 Battlefield Forge
1 Sunbaked Canyon
1 Inspiring Vantage
1 Sol Ring
1 Arcane Signet
1 Boros Signet
1 Mind Stone
1 Swords to Plowshares
1 Path to Exile
1 Lightning Bolt
1 Chaos Warp
1 Fateful Absence
1 Council's Judgment
1 Wear // Tear
1 Prismatic Ending
1 Thrill of Possibility
1 Wild Guess
1 Faithless Looting
1 Light Up the Stage
1 Aggravated Assault
1 Relentless Assault
1 Combat Celebrant
1 World at War
1 Seize the Day
1 Waves of Aggression
1 Zealous Conscripts
1 Kor Skyfisher
1 Elite Vanguard
1 Restoration Angel
1 Goblin Rabblemaster
1 Hero of Bladehold
1 Wojek Halberdiers
1 Boros Elite
1 Firebrand Archer
1 Krenko, Mob Boss
1 Purphoros, God of the Forge
1 Impact Tremors
1 Legion Loyalist
1 Adanto Vanguard
1 Steel Hellkite
1 Reckless Fireweaver
1 Skyknight Legionnaire
1 Monastery Swiftspear
1 Goblin Guide
1 Hellrider
1 Anax, Hardened in the Forge
1 Aurelia's Fury
1 Brash Taunter
1 Chandra's Ignition
1 Gideon, Ally of Zendikar
1 Fervent Champion
1 Bloodmark Mentor
1 Fireblade Charger
1 Kari Zev, Skyship Raider
1 Neheb, the Eternal
1 Etali, Primal Storm
1 Blasphemous Act
1 Wheel of Fortune
1 Elspeth, Sun's Champion
1 Godo, Bandit Warlord
1 Kiki-Jiki, Mirror Breaker
1 Boros Charm
1 Rally the Peasants
1 Assemble the Legion
1 Skullclamp
1 Battle Cry
`.trim(),
  },
  {
    id: 'preset-deck-commander-brago-blink',
    name: "Commander: Brago, King Eternal (Brago Blink)",
    commanderName: "Brago, King Eternal",
    deckText: `
15 Plains
15 Island
1 Hallowed Fountain
1 Command Tower
1 Irrigated Farmland
1 Prairie Stream
1 Fabled Passage
1 Evolving Wilds
1 Terramorphic Expanse
1 Path of Ancestry
1 Azorius Signet
1 Talisman of Progress
1 Mind Stone
1 Sol Ring
1 Arcane Signet
1 Restoration Angel
1 Mulldrifter
1 Flickerwisp
1 Fiend Hunter
1 Momentary Blink
1 Whitemane Lion
1 Wall of Omens
1 Solemn Simulacrum
1 Mistmeadow Witch
1 Sun Titan
1 Reveillark
1 Karmic Guide
1 Sea Gate Oracle
1 Deadeye Navigator
1 Palinchron
1 Peregrine Drake
1 Cloudblazer
1 Gilded Drake
1 Ghostly Flicker
1 Displace
1 Conjurer's Closet
1 Ephemerate
1 Angel of Serenity
1 Aetherling
1 Elite Guardmage
1 Duplicant
1 Faith's Reward
1 Detention Sphere
1 Oblivion Ring
1 Journey to Nowhere
1 Banisher Priest
1 Mistmeadow Skulk
1 Cyclonic Rift
1 Rhystic Study
1 Mystic Remora
1 Blade Splicer
1 Swords to Plowshares
1 Path to Exile
1 Counterspell
1 Negate
1 Fact or Fiction
1 Brainstorm
1 Consider
1 Opt
1 Man-o'-War
1 Venser, Shaper Savant
1 Latch Seeker
1 Felidar Guardian
1 Yorion, Sky Nomad
1 Archaeomancer
1 Mnemonic Wall
1 Silverwing Squadron
1 Wall of Denial
1 Trouble in Pairs
1 Preordain
1 Ghostly Prison
`.trim(),
  },
  {
    id: 'preset-deck-commander-counters',
    name: "Counters Matter (Golgari, Constructed)",
    commanderName: "",
    deckText: `
10 Forest
10 Island
2 Breeding Pool
4 Hardened Scales
4 Kalonian Hydra
4 Evolution Sage
4 Contentious Plan
4 Tezzeret's Gambit
4 Fathom Mage
4 Managorger Hydra
4 Winding Constrictor
4 Longtusk Cub
4 Rampant Growth
4 Sign in Blood
4 Elvish Mystic
`.trim(),
  },
  {
    id: 'preset-deck-commander-gishath-dinosaurs',
    name: "Commander: Gishath, Sun's Avatar (Gishath Dinosaurs)",
    commanderName: "Gishath, Sun's Avatar",
    deckText: `
7 Mountain
7 Forest
8 Plains
1 Sacred Foundry
1 Temple Garden
1 Stomping Ground
1 Command Tower
1 Temple of Triumph
1 Rugged Highlands
1 Sunpetal Grove
1 Fabled Passage
1 Evolving Wilds
1 Terramorphic Expanse
1 Path of Ancestry
1 Ranging Raptors
1 Thrashing Brontodon
1 Carnage Tyrant
1 Polyraptor
1 Regisaur Alpha
1 Ripjaw Raptor
1 Silverclad Ferocidons
1 Forerunner of the Empire
1 Otepec Huntmaster
1 Kinjalli's Caller
1 Etali, Primal Storm
1 Wayward Swordtooth
1 Sol Ring
1 Arcane Signet
1 Rampant Growth
1 Cultivate
1 Lightning Bolt
1 Beast Within
1 Swords to Plowshares
1 Craterhoof Behemoth
1 Territorial Allosaurus
1 Ghalta, Primal Hunger
1 Bellowing Aegisaur
1 Frenzied Raptor
1 Sun-Crowned Hunters
1 Colossal Dreadmaw
1 Charging Monstrosaur
1 Kinjalli's Sunwing
1 Commune with Dinosaurs
1 Savage Stomp
1 Deathgorge Scavenger
1 Farseek
1 Nature's Lore
1 Skyshroud Claim
1 Wayfarer's Bauble
1 Solemn Simulacrum
1 Chaos Warp
1 Path to Exile
1 Sword of the Animist
1 Zetalpa, Primal Dawn
1 Verdant Sun's Avatar
1 Shifting Ceratops
1 Steel Leaf Champion
1 Questing Beast
1 Aggressive Mammoth
1 Ranger's Guile
1 Selesnya Signet
1 Boros Signet
1 Gruul Signet
1 Herd Baloth
1 End-Raze Forerunners
1 Return to Nature
1 Loxodon Warhammer
1 Basilisk Collar
1 Wilt-Leaf Liege
1 Trostani, Selesnya's Voice
1 Rhythm of the Wild
1 Mirari's Wake
1 Sunbird's Invocation
1 Beastmaster Ascension
1 Rishkar's Expertise
1 Return of the Wildspeaker
1 Elemental Bond
1 Garruk's Uprising
1 Thunderfoot Baloth
1 Vanquisher's Banner
`.trim(),
  },
  {
    id: 'preset-deck-commander-golgari',
    name: "Commander: Slimefoot, the Stowaway (Golgari)",
    commanderName: "Slimefoot, the Stowaway",
    deckText: `
15 Swamp
15 Forest
1 Overgrown Tomb
1 Command Tower
1 Woodland Cemetery
1 Blooming Marsh
1 Nurturing Peatland
1 Fabled Passage
1 Sol Ring
1 Arcane Signet
1 Golgari Signet
1 Nature's Lore
1 Farseek
1 Cultivate
1 Doom Blade
1 Go for the Throat
1 Putrefy
1 Beast Within
1 Feed the Swarm
1 Fatal Push
1 Sign in Blood
1 Night's Whisper
1 Read the Bones
1 Grim Haruspex
1 Fecundity
1 Thallid
1 Spore Frog
1 Fungal Sprouting
1 Thallid Omnivore
1 Verdant Force
1 Woodfall Primus
1 Reclamation Sage
1 Eternal Witness
1 Meren of Clan Nel Toth
1 The Meathook Massacre
1 Woe Strider
1 Viscera Seer
1 Carrion Feeder
1 Bastion of Remembrance
1 Blood Artist
1 Zulaport Cutthroat
1 Midnight Reaper
1 Grave Pact
1 Dictate of Erebos
1 Craterhoof Behemoth
1 Massacre Wurm
1 Grave Titan
1 Solemn Simulacrum
1 Perilous Forays
1 Splendid Reclamation
1 Golgari Grave-Troll
1 Stinkweed Imp
1 Deathrite Shaman
1 Skullclamp
1 Diabolic Tutor
1 Attrition
1 Bone Splinters
1 Village Rites
1 Vindictive Vampire
1 Syr Konrad, the Grim
1 Ashnod's Altar
1 Phyrexian Altar
1 Cauldron Familiar
1 Witch's Oven
1 Trail of Crumbs
1 Yavimaya Elder
1 Nissa, Vastwood Seer
1 Ramunap Excavator
1 Life from the Loam
1 Jarad, Golgari Lich Lord
1 Fauna Shaman
`.trim(),
  },
  {
    id: 'preset-deck-commander-kemba-voltron',
    name: "Commander: Kemba, Kha Regent (Kemba Voltron)",
    commanderName: "Kemba, Kha Regent",
    deckText: `
28 Plains
1 Command Tower
1 Secluded Steppe
1 Emeria, the Sky Ruin
1 Flagstones of Trokair
1 Path of Ancestry
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Bonesplitter
1 Sword of the Animist
1 Bloodforged Battle-Axe
1 Skullclamp
1 Colossus Hammer
1 Grafted Wargear
1 Loxodon Warhammer
1 Whispersilk Cloak
1 Puresteel Paladin
1 Stoneforge Mystic
1 Kor Duelist
1 Leonin Shikari
1 Sram, Senior Edificer
1 Cathars' Crusade
1 Danitha Capashen, Paragon
1 Kemba's Skyguard
1 Swiftfoot Boots
1 Lightning Greaves
1 Batterskull
1 Sword of Fire and Ice
1 Sword of Feast and Famine
1 Umezawa's Jitte
1 Argentum Armor
1 Godsend
1 Shadowspear
1 Darksteel Plate
1 Sigarda's Aid
1 Danitha, Benalia's Hope
1 Steelshaper's Gift
1 Balan, Wandering Knight
1 Restoration Specialist
1 Bygone Bishop
1 Stoneforge Masterwork
1 Auriok Windwalker
1 Solemn Simulacrum
1 Wayfarer's Bauble
1 Thraben Inspector
1 Elite Vanguard
1 Kor Skyfisher
1 Kytheon, Hero of Akros
1 Adanto Vanguard
1 Palace Jailer
1 Fiend Hunter
1 Restoration Angel
1 Wall of Omens
1 Selfless Spirit
1 Angel of Invention
1 Serra Avenger
1 Serra Angel
1 Baneslayer Angel
1 Sublime Archangel
1 Heliod, God of the Sun
1 Heliod, Sun-Crowned
1 Ranger of Eos
1 Recruiter of the Guard
1 Weathered Wayfarer
1 Land Tax
1 Smothering Tithe
1 Swords to Plowshares
1 Path to Exile
1 Fateful Absence
1 Prismatic Ending
1 Winds of Abandon
`.trim(),
  },
  {
    id: 'preset-deck-commander-marwyn-elves',
    name: "Commander: Marwyn, the Nurturer (Marwyn Elves)",
    commanderName: "Marwyn, the Nurturer",
    deckText: `
32 Forest
1 Command Tower
1 Nykthos, Shrine to Nyx
1 Boseiju, Who Endures
1 Path of Ancestry
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Priest of Titania
1 Elvish Archdruid
1 Llanowar Elves
1 Elvish Mystic
1 Beast Whisperer
1 Elvish Visionary
1 Wirewood Symbiote
1 Timberwatch Elf
1 Elvish Promenade
1 Craterhoof Behemoth
1 Elven Bow
1 Genesis Wave
1 Rishkar, Peema Renegade
1 Wren's Run Vanquisher
1 Joraga Warcaller
1 Immaculate Magistrate
1 Nettle Sentinel
1 Heritage Druid
1 Fyndhorn Elves
1 Boreal Druid
1 Wood Elves
1 Sylvan Ranger
1 Skyshroud Poacher
1 Elvish Guidance
1 Wirewood Channeler
1 Elvish Vanguard
1 Elvish Champion
1 Lys Alana Huntmaster
1 Elvish Branchbender
1 Elvish Farmer
1 Devoted Druid
1 Rofellos, Llanowar Emissary
1 Multani, Yavimaya's Avatar
1 Overrun
1 Beastmaster Ascension
1 Return of the Wildspeaker
1 Elemental Bond
1 Vanquisher's Banner
1 Nature's Lore
1 Rampant Growth
1 Cultivate
1 Kodama's Reach
1 Sakura-Tribe Elder
1 Yavimaya Elder
1 Eternal Witness
1 Regrowth
1 Beast Within
1 Reclamation Sage
1 Acidic Slime
1 Nissa's Pilgrimage
1 Migration Path
1 Circuitous Route
1 Colossal Majesty
1 Soul's Majesty
1 Hunter's Insight
1 Shamanic Revelation
1 Harmonize
1 Explosive Vegetation
1 Ranger's Path
1 Tempt with Discovery
`.trim(),
  },
  {
    id: 'preset-deck-commander-muldrotha-graveyard',
    name: "Commander: Muldrotha, the Gravetide (Muldrotha Graveyard)",
    commanderName: "Muldrotha, the Gravetide",
    deckText: `
9 Forest
9 Island
9 Swamp
1 Watery Grave
1 Overgrown Tomb
1 Breeding Pool
1 Command Tower
1 Woodland Cemetery
1 Drowned Catacomb
1 Fabled Passage
1 Evolving Wilds
1 Terramorphic Expanse
1 Path of Ancestry
1 Eternal Witness
1 Reclamation Sage
1 Acidic Slime
1 Mulldrifter
1 Nightveil Specter
1 Sakura-Tribe Elder
1 Solemn Simulacrum
1 Sol Ring
1 Arcane Signet
1 Cultivate
1 Rampant Growth
1 Sign in Blood
1 Night's Whisper
1 Beast Within
1 Putrefy
1 Doom Blade
1 Tasigur, the Golden Fang
1 Meren of Clan Nel Toth
1 Golgari Grave-Troll
1 Life from the Loam
1 Grim Haruspex
1 Deathrite Shaman
1 Splendid Reclamation
1 Ramunap Excavator
1 Perpetual Timepiece
1 Palace Siege
1 Underrealm Lich
1 Yavimaya Elder
1 Grim Flayer
1 Vessel of Nascency
1 Satyr Wayfinder
1 Stitcher's Supplier
1 Prized Amalgam
1 Prophetic Prism
1 Golgari Signet
1 Dimir Signet
1 Simic Signet
1 Command Beacon
1 Coffin Queen
1 Sidisi, Undead Vizier
1 Tatyova, Benthic Druid
1 Uro, Titan of Nature's Wrath
1 Beast Whisperer
1 Mulch
1 Grisly Salvage
1 Traverse the Ulvenwald
1 Vampiric Tutor
1 Demonic Tutor
1 Toxic Deluge
1 Cyclonic Rift
1 Bane of Progress
1 Sultai Charm
1 Baleful Strix
1 Sakashima's Student
1 Regrowth
1 Nature's Spiral
1 Elixir of Immortality
1 Fauna Shaman
1 World Shaper
1 Zulaport Cutthroat
1 Blood Artist
1 Grave Titan
`.trim(),
  },
  {
    id: 'preset-deck-commander-phenax-mill',
    name: "Commander: Phenax, God of Deception (Phenax Mill)",
    commanderName: "Phenax, God of Deception",
    deckText: `
12 Island
12 Swamp
1 Watery Grave
1 Command Tower
1 Drowned Catacomb
1 Choked Estuary
1 Fetid Pools
1 Polluted Delta
1 Fabled Passage
1 Evolving Wilds
1 Terramorphic Expanse
1 Path of Ancestry
1 Bruvac the Grandiloquent
1 Fraying Sanity
1 Mesmeric Orb
1 Traumatize
1 Mind Grind
1 Tome Scour
1 Glimpse the Unthinkable
1 Hedron Crab
1 Sphinx's Tutelage
1 Nemesis of Reason
1 Sol Ring
1 Arcane Signet
1 Doom Blade
1 Go for the Throat
1 Sign in Blood
1 Night's Whisper
1 Fleet Swallower
1 Psychic Corrosion
1 Maddening Cacophony
1 Ruin Crab
1 Tasha's Hideous Laughter
1 Jace's Erasure
1 Duskmantle Guildmage
1 Consuming Aberration
1 Increasing Confusion
1 Grinding Station
1 Startled Awake
1 Archive Trap
1 Visions of Beyond
1 Merfolk Secretkeeper
1 Dimir Signet
1 Talisman of Dominance
1 Thought Vessel
1 Rhystic Study
1 Mystic Remora
1 Toxic Deluge
1 Damnation
1 Cyclonic Rift
1 Baleful Mastery
1 Counterspell
1 Negate
1 Fact or Fiction
1 Chart a Course
1 Consider
1 Opt
1 Brainstorm
1 Vampiric Tutor
1 Demonic Tutor
1 Notion Thief
1 Windfall
1 Peer into the Abyss
1 Whispering Madness
1 Reality Shift
1 Baleful Strix
1 Ophiomancer
1 Nighthowler
1 Diluvian Primordial
1 Sepulchral Primordial
1 Fblthp, the Lost
1 Sea Gate Restoration
1 Compulsive Research
1 Thought Scour
1 Perilous Research
1 Dinrova Horror
1 Sire of Stagnation
`.trim(),
  },
  {
    id: 'preset-deck-commander-sythis-enchantress',
    name: "Commander: Sythis, Harvest's Hand (Sythis Enchantress)",
    commanderName: "Sythis, Harvest's Hand",
    deckText: `
14 Forest
14 Plains
1 Temple Garden
1 Command Tower
1 Sunpetal Grove
1 Fabled Passage
1 Evolving Wilds
1 Terramorphic Expanse
1 Path of Ancestry
1 Selesnya Signet
1 Talisman of Unity
1 Mind Stone
1 Sol Ring
1 Arcane Signet
1 Utopia Sprawl
1 Wild Growth
1 Farseek
1 Cultivate
1 Setessan Champion
1 Argothian Enchantress
1 Eidolon of Blossoms
1 Enchantress's Presence
1 Sterling Grove
1 Pacifism
1 Arrest
1 Rancor
1 Ethereal Armor
1 Ordeal of Heliod
1 Sigil of the Empty Throne
1 Wild Beastmaster
1 Karametra's Blessing
1 Ajani's Presence
1 Solemn Simulacrum
1 Three Dreams
1 Wilderness Reclamation
1 Season of Growth
1 Keeper of Fables
1 Kor Spiritdancer
1 Archon of Sun's Grace
1 Destiny Spinner
1 Alseid of Life's Bounty
1 Karametra, God of Harvests
1 Elemental Bond
1 Overrun
1 Beastmaster Ascension
1 Return of the Wildspeaker
1 Rishkar's Expertise
1 Skullclamp
1 Path to Exile
1 Swords to Plowshares
1 Farhaven Elf
1 Sun Titan
1 Congregation at Dawn
1 Idyllic Tutor
1 Aura Shards
1 Weathered Wayfarer
1 Wayfarer's Bauble
1 Trostani, Selesnya's Voice
1 Sigarda, Host of Herons
1 Angelic Renewal
1 Heliod, Sun-Crowned
1 Voice of Resurgence
1 Restoration Angel
1 Wall of Omens
1 Loxodon Warhammer
1 Basilisk Collar
1 Smothering Tithe
1 Land Tax
1 Mirari's Wake
1 Selfless Spirit
1 Nyx-Fleece Ram
1 Blossoming Sands
1 Open the Armory
`.trim(),
  },
  {
    id: 'preset-deck-commander-teysa-aristocrats',
    name: "Commander: Teysa Karlov (Teysa Aristocrats)",
    commanderName: "Teysa Karlov",
    deckText: `
12 Plains
12 Swamp
1 Godless Shrine
1 Command Tower
1 Caves of Koilos
1 Vault of the Archangel
1 Fabled Passage
1 Evolving Wilds
1 Terramorphic Expanse
1 Path of Ancestry
1 Sol Ring
1 Arcane Signet
1 Orzhov Signet
1 Talisman of Hierarchy
1 Mind Stone
1 Blood Artist
1 Zulaport Cutthroat
1 Cruel Celebrant
1 Viscera Seer
1 Carrion Feeder
1 Yahenni, Undying Partisan
1 Bastion of Remembrance
1 Elas il-Kor, Sadistic Pilgrim
1 Vindictive Vampire
1 Falkenrath Noble
1 Syr Konrad, the Grim
1 Midnight Reaper
1 Woe Strider
1 Doomed Dissenter
1 Priest of Forgotten Gods
1 Solemn Simulacrum
1 Reassembling Skeleton
1 Grave Pact
1 Dictate of Erebos
1 Village Rites
1 Bone Splinters
1 Diabolic Tutor
1 Fatal Push
1 Ayara, First of Locthwain
1 Butcher of Malakir
1 Cliffhaven Vampire
1 Vindicate
1 Utter End
1 Anguished Unmaking
1 Blood Bairn
1 Corpse Knight
1 Marionette Master
1 Revel in Riches
1 Ministrant of Obligation
1 Orzhov Advokist
1 Twilight Prophet
1 Athreos, God of Passage
1 Sheoldred, the Apocalypse
1 Toxic Deluge
1 Damnation
1 Vona, Butcher of Magan
1 Sanguine Bond
1 Exquisite Blood
1 Debt to the Deathless
1 Aetherflux Reservoir
1 Bloodghast
1 Vito, Thorn of the Dusk Rose
1 Costly Plunder
1 Bake into a Pie
1 Bishop of Wings
1 Karlov of the Ghost Council
1 Divine Visitation
1 High Market
1 Phyrexian Tower
1 Ashnod's Altar
1 Attrition
1 Grave Titan
1 Massacre Wurm
1 Righteous Cause
1 Suture Priest
1 Well of Lost Dreams
1 Skullclamp
`.trim(),
  },
  {
    id: 'preset-deck-commander-ur-dragon',
    name: "Commander: The Ur-Dragon (Ur Dragon)",
    commanderName: "The Ur-Dragon",
    deckText: `
6 Plains
6 Island
6 Swamp
6 Mountain
6 Forest
1 Command Tower
1 City of Brass
1 Mana Confluence
1 Reflecting Pool
1 Exotic Orchard
1 Path of Ancestry
1 Sol Ring
1 Arcane Signet
1 Chromatic Lantern
1 Coalition Relic
1 Fellwar Stone
1 Scion of the Ur-Dragon
1 Dragonlord Atarka
1 Dragonlord Dromoka
1 Dragonlord Kolaghan
1 Dragonlord Ojutai
1 Dragonlord Silumgar
1 Utvara Hellkite
1 Bladewing the Risen
1 Karrthus, Tyrant of Jund
1 Scourge of Valkas
1 Dragon Broodmother
1 Dragon Tempest
1 Terror of the Peaks
1 Verix Bladewing
1 Hellkite Tyrant
1 Skithiryx, the Blight Dragon
1 Balefire Dragon
1 Dromoka, the Eternal
1 Kilnmouth Dragon
1 Thunderbreak Regent
1 Glorybringer
1 Moonveil Dragon
1 Savage Ventmaw
1 Herald's Horn
1 Miirym, Sentinel Wyrm
1 Beacon of Destruction
1 Cyclonic Rift
1 Swords to Plowshares
1 Path to Exile
1 Chaos Warp
1 Vindicate
1 Cultivate
1 Farseek
1 Rampant Growth
1 Sign in Blood
1 Night's Whisper
1 Dragonstorm
1 Dragon's Hoard
1 Crux of Fate
1 Dragon Mage
1 Dragon Egg
1 Bathe in Dragonfire
1 Frost Breath
1 Belbe's Portal
1 Etali, Primal Storm
1 Scourge of the Throne
1 Furnace Whelp
1 Chromium, the Mutable
1 Arcades, the Strategist
1 Palladia-Mors, the Ruiner
1 Rimescale Dragon
1 Shivan Dragon
1 Old Gnawbone
1 Malfegor
1 Steel Hellkite
1 Dragonlord's Servant
1 Fist of Suns
1 Urza's Incubator
`.trim(),
  },
  {
    id: 'preset-deck-commander-urza-artifacts',
    name: "Commander: Urza, Lord High Artificer (Urza Artifacts)",
    commanderName: "Urza, Lord High Artificer",
    deckText: `
33 Island
1 Command Tower
1 Seat of the Synod
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Thran Dynamo
1 Grim Monolith
1 Mana Vault
1 Chromatic Lantern
1 Etherium Sculptor
1 Foundry Inspector
1 Master Transmuter
1 Metalworker
1 Palladium Myr
1 Solemn Simulacrum
1 Wurmcoil Engine
1 Myr Battlesphere
1 Steel Hellkite
1 Duplicant
1 Sharuum the Hegemon
1 Vedalken Archmage
1 Trinket Mage
1 Trophy Mage
1 Fabricate
1 Mystic Forge
1 Whir of Invention
1 Reshape
1 Tinker
1 Padeem, Consul of Innovation
1 Emry, Lurker of the Loch
1 Thought Monitor
1 Ornithopter
1 Memnite
1 Signal Pest
1 Pili-Pala
1 Grand Architect
1 Darksteel Ingot
1 Everflowing Chalice
1 Coalition Relic
1 Prophetic Prism
1 Consecrated Sphinx
1 Blightsteel Colossus
1 Kozilek, Butcher of Truth
1 Platinum Angel
1 Myr Enforcer
1 Walking Ballista
1 Hangarback Walker
1 Rings of Brighthearth
1 Basalt Monolith
1 Voltaic Key
1 Aetherflux Reservoir
1 Kuldotha Forgemaster
1 Academy Manufactor
1 Static Orb
1 Cyclonic Rift
1 Counterspell
1 Brainstorm
1 Consider
1 Opt
1 Reality Shift
1 Mystic Confluence
1 Frantic Search
1 Merchant Scroll
1 Anticipate
1 Fblthp, the Lost
1 Curiosity
`.trim(),
  },
  {
    id: 'preset-deck-dimir-control',
    name: "Dimir Control",
    commanderName: "",
    deckText: `
9 Island
9 Swamp
2 Watery Grave
4 Counterspell
4 Negate
4 Doom Blade
4 Go for the Throat
4 Sign in Blood
4 Tragic Slip
4 Divination
4 Nightveil Specter
4 Murderous Redcap
4 Grave Titan
`.trim(),
  },
  {
    id: 'preset-deck-gruul-ramp',
    name: "Gruul Ramp",
    commanderName: "",
    deckText: `
9 Forest
7 Mountain
4 Rampant Growth
4 Nature's Lore
4 Cultivate
4 Kodama's Reach
4 Farseek
4 Llanowar Elves
4 Elvish Mystic
4 Craterhoof Behemoth
4 Terra Stomper
4 Prized Unicorn
2 Colossal Dreadmaw
`.trim(),
  },
  {
    id: 'preset-deck-izzet-spells',
    name: "Izzet Spells",
    commanderName: "",
    deckText: `
9 Island
9 Mountain
2 Steam Vents
4 Monastery Swiftspear
4 Young Pyromancer
4 Lightning Bolt
4 Shock
4 Opt
4 Brainstorm
4 Fireblast
4 Wild Slash
4 Reckless Charge
4 Guttersnipe
`.trim(),
  },
  {
    id: 'preset-deck-mono-red-aggro',
    name: "Mono Red Aggro",
    commanderName: "",
    deckText: `
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
`.trim(),
  },
  {
    id: 'preset-deck-selesnya-tokens',
    name: "Selesnya Tokens",
    commanderName: "",
    deckText: `
9 Plains
9 Forest
2 Temple Garden
4 Raise the Alarm
4 Elite Vanguard
4 Doomed Traveler
4 Intangible Virtue
4 Glorious Anthem
4 Trumpet Blast
4 Midnight Haunting
4 Attended Knight
4 Rootborn Defenses
4 Ajani's Pridemate
`.trim(),
  },
  {
    id: 'preset-deck-smaug-treasures',
    name: "Commander: Smaug the Magnificent (Rakdos Treasures)",
    commanderName: "Smaug the Magnificent",
    deckText: `
1 Academy Manufactor
1 Alchemist's Talent
1 Arcane Signet
1 Bedevil
1 Blasphemous Act
1 Blinkmoth Urn
1 Blood Crypt
1 Bojuka Bog
1 Bolt Bend
1 Chain Lightning
1 Champion's Helm
1 Coin of Mastery
1 Comet Storm
1 Command Tower
1 Crackle with Power
1 Crime Novelist
1 Cut of the Profits
1 Cut Propulsion
1 Dark Fortress
1 Dark Ritual
1 Dawnsire, Sunstar Dreadnought
1 Deadly Dispute
1 Diabolic Tutor
1 Disciple of the Vault
1 Dizzying Gaze
1 Dragon's Fire
1 Dragonskull Summit
1 Electrodominance
1 Exsanguinate
1 Fiendlash
1 Fiery Emancipation
1 Foreboding Ruins
1 Geothermal Bog
1 Goldspan Dragon
1 Haunted Ridge
1 Hellkite Tyrant
1 Inferno of the Star Mounts
1 Ingenious Artillerist
1 Into the Maw of Hell
1 Jet Medallion
1 Juri, Master of the Revue
1 Kalain, Reclusive Painter
1 Khaaaaaaaaaaaannn!
1 Kiku's Shadow
1 Lightning Bolt
1 Magda, Brazen Outlaw
1 Manaform Hellkite
1 March of Wretched Sorrow
1 Mayhem Devil
1 Mirkwood Bats
1 Mishra's Command
1 Mountain
1 Mountain
1 Mountain
1 Mountain
1 Mountain
1 Mountain
1 Mountain
1 Mountain
1 Mountain
1 Mountain
1 Nadier's Nightblade
1 Overmaster
1 Pain for All
1 Pariah's Shield
1 Pestilence
1 Phyrexian Arena
1 Professional Face-Breaker
1 Rain of Riches
1 Rakdos Carnarium
1 Rakdos Signet
1 Reanimate
1 Reckless Fireweaver
1 Reliquary Tower
1 Return the Favor
1 Revel in Riches
1 Rile
1 Rogue's Passage
1 Ruby Medallion
1 Self-Destruct
1 Shadowblood Ridge
1 Shatterskull Smashing // Shatterskull, the Hammer Pass
1 Simulacrum
1 Smaug the Magnificent
1 Smoldering Marsh
1 Sol Ring
1 Star of Extinction
1 Stonesplitter Bolt
1 Strip Mine
1 Sulfurous Springs
1 Swamp
1 Swamp
1 Swamp
1 Swamp
1 Swamp
1 Swamp
1 Swamp
1 Swiftfoot Boots
1 Tainted Peak
1 Temple of the False God
1 Terminate
1 The Rollercrusher Ride
1 The Sackville-Bagginses
1 Thought Vessel
1 Torch the Witness
1 Valakut, the Molten Pinnacle
1 Volcano Hellion
1 Wasteland
1 Wrathful Red Dragon
1 Xorn
`.trim(),
  },
  {
    id: 'preset-deck-standard-ai-heavy',
    name: "Standard: AI Stress-Test Deck (Multiples Allowed)",
    commanderName: "",
    deckText: `
6 Mountain
6 Island
6 Swamp
6 Plains
3 Ragavan, Nimble Pilferer
3 Fable of the Mirror-Breaker
3 Ledger Shredder
3 Bonecrusher Giant
3 Solitude
3 Murktide Regent
3 Expressive Iteration
3 Esper Sentinel
3 Orcish Bowmasters
3 The Meathook Massacre
3 Reckoner Bankbuster
3 Goldspan Dragon
`.trim(),
  },

  {
    id: 'preset-commander-korvold',
    name: 'Commander: Korvold, Fae-Cursed King (Jund Treasures)',
    commanderName: 'Korvold, Fae-Cursed King',
    deckText: `
9 Forest
9 Mountain
9 Swamp
1 Blood Crypt
1 Stomping Ground
1 Overgrown Tomb
1 Command Tower
1 Fabled Passage
1 Evolving Wilds
1 Terramorphic Expanse
1 Path of Ancestry
1 Karplusan Forest
1 Rakdos Carnarium
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Lightning Greaves
1 Revel in Riches
1 Dockside Extortionist
1 Goldspan Dragon
1 Professional Face-Breaker
1 Reckless Fireweaver
1 Mayhem Devil
1 Pitiless Plunderer
1 Wayward Swordtooth
1 Skullclamp
1 Deadly Dispute
1 Village Rites
1 Reanimate
1 Terminate
1 Beast Within
1 Feed the Swarm
1 Putrefy
1 Doom Blade
1 Chaos Warp
1 Fatal Push
1 Bone Splinters
1 Attrition
1 Cultivate
1 Kodama's Reach
1 Rampant Growth
1 Sign in Blood
1 Read the Bones
1 Night's Whisper
1 Diabolic Tutor
1 Eternal Witness
1 Craterhoof Behemoth
1 Grave Titan
1 Massacre Wurm
1 Bloodgift Demon
1 Bone Shards
1 Fauna Shaman
1 Ravenous Chupacabra
1 Blood Artist
1 Zulaport Cutthroat
1 Solemn Simulacrum
1 Ashnod's Altar
1 Phyrexian Altar
1 Viscera Seer
1 Carrion Feeder
1 Bastion of Remembrance
1 Cauldron Familiar
1 Witch's Oven
1 Woe Strider
1 Yavimaya Elder
1 Fecundity
1 Burnished Hart
1 Trail of Crumbs
1 Grim Haruspex
1 Vindictive Vampire
1 Syr Konrad, the Grim
1 Midnight Reaper
1 Grave Pact
1 Dictate of Erebos
1 Nihil Spellbomb
`.trim(),
  },
  {
    id: 'preset-commander-edgar-markov',
    name: 'Commander: Edgar Markov (Mardu Vampires)',
    commanderName: 'Edgar Markov',
    deckText: `
7 Plains
7 Swamp
6 Mountain
1 Blood Crypt
1 Sacred Foundry
1 Godless Shrine
1 Command Tower
1 Nomad Outpost
1 Bloodstained Mire
1 Marsh Flats
1 Arid Mesa
1 Caves of Koilos
1 Battlefield Forge
1 Sulfurous Springs
1 Fabled Passage
1 Evolving Wilds
1 Terramorphic Expanse
1 Path of Ancestry
1 Clifftop Retreat
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Lightning Greaves
1 Anointed Procession
1 Bloodline Keeper
1 Captivating Vampire
1 Vampire Nocturnus
1 Kalitas, Traitor of Ghet
1 Stromkirk Captain
1 Bloodhall Priest
1 Indulgent Tormentor
1 Champion of Dusk
1 Swords to Plowshares
1 Path to Exile
1 Lightning Bolt
1 Terminate
1 Anguished Unmaking
1 Utter End
1 Chaos Warp
1 Fatal Push
1 Bone Splinters
1 Feed the Swarm
1 Skullclamp
1 Bitterblossom
1 Sign in Blood
1 Night's Whisper
1 Diabolic Tutor
1 Cathars' Crusade
1 Impact Tremors
1 Purphoros, God of the Forge
1 Gifted Aetherborn
1 Sanguine Bond
1 Exquisite Blood
1 Cordial Vampire
1 Vampire Interloper
1 Drana, Liberator of Malakir
1 Olivia Voldaren
1 Vampire Nighthawk
1 Stromkirk Noble
1 Butcher of Malakir
1 Vona, Butcher of Magan
1 Malakir Bloodwitch
1 Elenda, the Dusk Rose
1 Legion Lieutenant
1 Metallic Mimic
1 Adaptive Automaton
1 Sanctum Seeker
1 Vein Ripper
1 Yahenni, Undying Partisan
1 Priest of Forgotten Gods
1 Viscera Seer
1 Zulaport Cutthroat
1 Blood Artist
1 Cruel Celebrant
1 Bastion of Remembrance
1 Village Rites
1 Vindictive Vampire
1 Syr Konrad, the Grim
1 Midnight Reaper
1 Grave Pact
1 Dictate of Erebos
1 Solemn Simulacrum
`.trim(),
  },
  {
    id: 'preset-deck-stress-test-unmodeled',
    name: 'AI Stress Test: Unmodeled Effects (WUBR)',
    commanderName: '',
    deckText: `
6 Plains
6 Island
6 Swamp
6 Mountain
1 Smuggler's Copter
1 Delver of Secrets
1 Fire // Ice
1 Ancestral Vision
1 Treasure Cruise
1 Hidden Strings
1 Elderfang Ritualist
1 Slogurk, the Overslime
1 Bloodthirsty Adversary
1 Gray Merchant of Asphodel
1 Palace Sentinels
1 Frogmite
1 Firebolt
1 Shimmer Myr
1 Ruthless Ripper
1 Hopeful Eidolon
1 Bituminous Blast
1 Fiery Temper
1 Willbender
1 Sea-Dasher Octopus
1 Basilica Screecher
1 Fiendslayer Paladin
1 Grapeshot
1 Rift Bolt
1 Ragavan, Nimble Pilferer
1 Solitude
1 Orcish Bowmasters
1 The Meathook Massacre
1 Reckoner Bankbuster
1 Esper Sentinel
1 Ledger Shredder
1 Bonecrusher Giant
1 Fable of the Mirror-Breaker
1 Expressive Iteration
1 Murktide Regent
1 Goldspan Dragon
`.trim(),
  },
];
