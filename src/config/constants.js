export const GOODS = {
  grain:   { name:'Grain',        baseValue:6,  nutrition:0.15, comfortValue:0, perishRate:0.02,  color:'#c8a84b' }, // baseValue raised 3->6: grain was priced BELOW wood (4) despite being the food chain's foundational input (4 grain -> 12 bread @ baseValue 8). At the old value, farming looked worse than woodcutting even in calm/no-scarcity conditions, so farmers defected to woodcutting BEFORE any real grain shortage could push the price up to correct it — by the time scarcity pricing kicked in, farmer population had already collapsed past recovery. Verified via harness: with the old value, farmer count hit 0 by day 140 and the village went extinct by ~day 120 once the (separate, now-fixed) free-bread-production bug stopped masking the shortage.
  bread:   { name:'Bread',        baseValue:8,  nutrition:0.5, comfortValue:0, perishRate:0.15,  color:'#c47a3a' },
  wood:    { name:'Wood',         baseValue:4,  nutrition:0,   comfortValue:0, perishRate:0,     color:'#7a5a3a' },
  tools:   { name:'Tools',        baseValue:20, nutrition:0,   comfortValue:0, perishRate:0.003, color:'#808080' },
  luxury:  { name:'Fine Goods',   baseValue:15, nutrition:0,   comfortValue:0.5, perishRate:0.02, color:'#a5478b' },
};

// ─────────────────────────────────────────────
// ASSETS — ownable productive property
// ─────────────────────────────────────────────
//
// Replaces the old village-wide `requires: 'forge'` boolean gate with real,
// ownable, transferable (or non-transferable) property. An NPC can only
// work a profession that needs an asset if they personally own (and are
// actively operating) one, or are hired as labor by someone who does
// (hired labor arrives in a later stage).
//
// Two asset "families":
//   PHYSICAL  — farm, mill, forge, workshop. Transferable: can be sold,
//               inherited, auctioned, built by a Builder. Depreciates
//               slowly with use, improves slightly with investment
//               (future hook — not implemented yet in Stage 1).
//   SKILL     — toolmaking, milling, artisanry. NOT transferable — can
//               only be acquired by an NPC personally, currently still
//               via the existing trainingDays ramp, with a labor-market
//               learning path coming in a later stage.
//
// Every profession that needs a physical asset also needs the matching
// skill (npc.skills[profId]) to operate it at full efficiency — an owner
// with no skill can still hold title (and, later, hire a skilled laborer
// to run it), but personally working an asset they have no skill in
// produces at the same steep penalty effectiveSkill() already applies.

export const ASSET_TYPES = {
  farm:     { name:'Farm',     profession:'farmer',    transferable:true,  baseQuality:1.0, buildCost:{wood:8},           buildDays:15 },
  mill:     { name:'Mill',     profession:'miller',    transferable:true,  baseQuality:1.0, buildCost:{wood:20},          buildDays:25 },
  forge:    { name:'Forge',    profession:'toolmaker', transferable:true,  baseQuality:1.0, buildCost:{wood:25},          buildDays:25 },
  workshop: { name:'Workshop', profession:'artisan',   transferable:true,  baseQuality:1.0, buildCost:{wood:20,grain:10}, buildDays:20 },
  house:    { name:'House',    profession:null,        transferable:true,  baseQuality:1.0, buildCost:{wood:15},          buildDays:12 },
};

// Types that are the physical seat of a profession (used to find "which
// asset type does profession X need" without house — which has no
// profession — accidentally matching anything).
export const PRODUCTIVE_ASSET_TYPES = Object.keys(ASSET_TYPES).filter(t => ASSET_TYPES[t].profession);

// A hard ceiling on how many farms can ever exist — the deliberate,
// physical food-supply cap that makes population growth self-limiting.
// Arable land is finite; this is that fact, expressed as a number instead
// of an ever-elastic supply of new farms chasing demand. Tuned loosely to
// the starting village size — worth revisiting once population dynamics
// (marriage/children) are actually running and you can see where real
// pressure emerges.
export const MAX_FARMS = 14;

export const GRID_CELL = 22;           // px per tile
export const GRID_ANCHOR = { gx: 18, gy: 14 }; // town-center tile, spiral search starts here
export const FOOTPRINTS = {
  market: 2, well: 1, mill: 2, forge: 2, workshop: 2, church: 2,
  farm: 2, house: 1,
};


export const PROFESSIONS = {
  farmer:     { name:'Farmer',     outputs:{grain:8},  inputs:{},          requires:null,      capitalGood:'tools', laborHours:8, materialsCost:3,  trainingCost:0,  trainingDays:5  }, // output 5->8: worked backward from the target — a 48-person village needs ~96 bread/day (2/person), which needs ~32 grain/day (4 grain -> 12 bread via milling). If 1/4 of total village hours go to farming (half the time of half the people — 72 of 288 daily village-hours at pop 48), that's 72/6=12 sessions/day. At the OLD output of 5 grain/session that's 60 grain/day (already ~2x need on paper), but per-hour revenue was too thin to make farming competitive against a specialized miller's capital-boosted margin — see profSessionEV. At 8 grain/session, the same 12 sessions produce 96 grain/day (3x need) AND farming's per-hour revenue rises proportionally, directly narrowing the gap against milling in the EV comparison that was driving the specialist trap.
  woodcutter: { name:'Woodcutter', outputs:{wood:4},   inputs:{},          requires:null,      capitalGood:'tools', laborHours:8, materialsCost:3,  trainingCost:0,  trainingDays:5  },
  miller:     { name:'Miller',     outputs:{bread:12}, inputs:{grain:4},   requires:'mill',    capitalGood:null,    laborHours:7, materialsCost:10, trainingCost:15, trainingDays:20 }, // output doubled 6->12: mills were structurally undersized relative to village-wide bread demand
  toolmaker:  { name:'Toolmaker',  outputs:{tools:0.5},inputs:{wood:2},    requires:'forge',   capitalGood:null,    laborHours:8, materialsCost:15, trainingCost:20, trainingDays:25 },
  artisan:    { name:'Artisan',    outputs:{luxury:4}, inputs:{grain:2,wood:3}, requires:'workshop', capitalGood:null, laborHours:7, materialsCost:15, trainingCost:25, trainingDays:25 },
};
// Switching used to be one flat coin cost, deducted and gone. Now it's
// three separate, more legible things:
//   materialsCost — tools/setup, paid to the Market (buys into its tools
//     cash pool — a real purchase, not a sink)
//   trainingCost  — paid to whoever currently practices (or most recently
//     practiced) the target trade, split evenly. A wealth transfer, not a
//     sink — masters get paid by their apprentices. If literally nobody
//     has ever practiced it, there's no one to pay and this is waived
//     (you're the pioneer).
//   trainingDays  — after switching, output ramps up from 30% to 100% of
//     the NPC's innate skill over this many days (see effectiveSkill()).
//     This is a real, felt cost during the transition, and it's the one
//     considerProfessionSwitch has to actually reason about, not just pay.
// Miller and artisan outputs were originally tuned 1:1-ish with their raw
// inputs (3 bread per 2 grain; 1 luxury per 1 grain + 2 wood). That reads
// fine on paper but breaks in practice: at typical skill (0.2–0.6 for a
// newly-learned trade), a session nets LESS than the producer's own daily
// consumption buffer for that good (2 bread/day, 1 luxury/day) — meaning
// a lone miller or artisan can't even feed/comfort themselves from their
// own work, let alone leave anything over to sell. Farmers/woodcutters
// never hit this because their output-per-session already runs 3-6x their
// own buffer target. Scaling miller/artisan output up (same input ratio
// for miller, a richer ratio for artisan reflecting skilled value-add)
// gives them the same kind of surplus headroom.

// Player-tunable productivity multiplier per building type. 1.0 = baseline
// (no change from stock behavior). Applied as a straight multiplier on a
// worker's output alongside their skill and capital-good bonus — see
// buildingProductivity() below and its call sites in profSessionEV() and
// buildSchedule(). Exposed live in the Infrastructure panel via sliders.
export const BUILDING_PRODUCTIVITY = {
  mill: 1.0,
  forge: 1.0,
  workshop: 1.0,
};


export const PROFESSION_PRESTIGE = {
  woodcutter: 0.05,
  farmer:     0.10,
  miller:     0.20,
  toolmaker:  0.28,
  artisan:    0.35,
};
// Diminishing-returns wealth contribution (log, not linear — the 10th
// coin matters far more to standing than the 1000th) and a small bonus
// per owned productive asset/building (ownership of capital reads as
// status independent of the cash sitting in savings). Both capped so
// prestige stays a bounded [0,1] need like everything else, and reuse
// npc.ownedAssets (already tracked at the NPC level) rather than scanning
// world.assets.
export const PRESTIGE_WEALTH_LOG_SCALE = 0.045;
export const PRESTIGE_WEALTH_CAP       = 0.40;
export const PRESTIGE_PER_ASSET        = 0.07;
export const PRESTIGE_ASSET_CAP        = 0.25;
// How fast the composite need actually chases this target — deliberately
// slower than familyChannel's 0.08/day (see NEEDS.prestige comment):
// reputation should visibly lag a windfall or a bad turn, not snap to it.
export const PRESTIGE_CONVERGENCE_RATE = 0.035;
// Granting help is itself a (smaller, separate) prestige event — visible
// generosity reads as status, same instinct as patronage/noblesse oblige.
// Kept as its own tunable constant rather than folded into prestigeTarget
// so the two effects (standing wealth/profession vs. an act of giving)
// can be isolated and tuned independently.
export const PRESTIGE_HELP_GAIN = 0.03;


export const NEEDS = {
  // selfManaged: true means this need already gets a COMPLETE update
  // elsewhere in satisfyNeeds -- a ratio-centered-on-0.5 formula like
  // `food += (foodRatio - 0.5) * 0.15` that bakes its own decay AND gain
  // into one expression (ratio=0 -> lose half the swing, ratio=1 -> gain
  // half the swing). decayPerDay for these is descriptive documentation
  // of that baked-in rate, not a second deduction to separately apply --
  // the generic decay loop below skips them entirely. social and meaning
  // have no such self-contained formula (social's wood-warmth block only
  // ever ADDS, never subtracts; meaning has no other update in
  // satisfyNeeds at all), so decayPerDay is their ONLY decay mechanism
  // and the generic loop is what actually applies it.
  food:     { weight:100, decayPerDay:0.04,  starvationFloor:0.15, critical:true,  selfManaged:true  },
  security: { weight:40,  decayPerDay:0.01,  starvationFloor:0,    critical:true,  selfManaged:true  },
  comfort:  { weight:25,  decayPerDay:0.015, starvationFloor:0,    critical:false, selfManaged:true  },
  // social flipped to selfManaged: it now gets one complete daily update
  // (activity channel + family channel, combined and decayed below in
  // satisfyNeeds) instead of a raw accumulator + generic decay. Leaving
  // it selfManaged:false while ALSO giving it a complete formula would
  // double-decay it — exactly the food-decay bug class from before.
  social:   { weight:15,  decayPerDay:0.02,  starvationFloor:0,    critical:false, selfManaged:true  },
  // Bumped 8->20: meaning was structurally the least-weighted need by a
  // wide margin, making it nearly irrelevant to any decision. With family
  // now feeding it a real trickle (see familyChannelTarget), it's worth
  // it actually mattering in the scoring.
  meaning:  { weight:20,  decayPerDay:0.01,  starvationFloor:0,    critical:false, selfManaged:false },
  // Prestige: standing in the village, from wealth, owned productive
  // assets, and the skill tier of one's profession. selfManaged:true —
  // it has one complete convergence-toward-target update in satisfyNeeds
  // (see prestigeTarget), same pattern as comfort/family. Deliberately a
  // SLOW convergence (see PRESTIGE_CONVERGENCE_RATE) — a windfall
  // shouldn't instantly buy status; reputation lags wealth. Non-critical:
  // low prestige is a social discomfort, not a survival cliff.
  prestige: { weight:18,  decayPerDay:0,     starvationFloor:0,    critical:false, selfManaged:true  },
};

// Fine goods alone cap OUT at these fractions of full comfort/social —
// the remainder can only be closed by family (marriage/children). This is
// what makes marriage an economic necessity, not just a nice-to-have: a
// wealthy hermit and a modest married household are no longer both able
// to reach full comfort/social satisfaction through their own channel
// alone. Each need is modeled as two independently-tracked channels
// (see npc.materialComfort/activitySocial + npc.familyChannel, combined
// in satisfyNeeds) rather than one scalar, so the cap falls naturally out
// of a weighted sum instead of a hard ceiling bolted onto scoring.
export const MATERIAL_COMFORT_CAP = 0.55; // fine goods can fill up to 55% of comfort on their own
export const ACTIVITY_SOCIAL_CAP  = 0.55; // socializing can fill up to 55% of social on their own
// How strongly family status closes the remaining gap. A spouse alone
// gets partway there; each child closes more of what's left, with
// diminishing per-child returns (same diminishing-marginal-utility
// principle as everywhere else) — a first child changes a household's
// social/comfort life far more than a fourth one does.
export const FAMILY_CHANNEL_SPOUSE_BONUS = 0.55;
export const FAMILY_CHANNEL_PER_CHILD    = 0.18;
export const FAMILY_MEANING_RATE = 0.02; // daily meaning trickle, scaled by familyChannelTarget()

// Moved up from the marriage/childbirth section below: makeNPC (called
// during initial world seeding, well before that section of the file
// runs) needs these to set every NPC's lifespan at creation.
export const CHILDHOOD_DAYS = 150; // "dog years" for now — 3 (fast) years at 50 days/year, so multi-generational dynamics are actually observable in a normal test run. Trivial to dial back up to a realistic childhood once the mechanics are validated.
export const DOG_YEAR_DAYS = CHILDHOOD_DAYS / 3; // for age display — a child "turns 1" every DOG_YEAR_DAYS days

export const DAILY_CONSUMPTION_PER_CAPITA = {
  grain: 1.0, bread: 2.0, wood: 0.6, tools: 0.15, luxury: 0.2,
};
export const TARGET_STOCK_BUFFER = 2; // days of full village-wide demand held in reserve


export const PRICE_ELASTICITY = 0.6;   // how hard price reacts to a stock deviation
export const PRICE_ADJUST_RATE = 0.15; // daily smoothing toward the target price

// TIME_USE_WINDOW: how many days of village-wide time-use history to
// retain for charting — enough to see recent trends without unbounded
// memory growth over a long run.
export const TIME_USE_WINDOW = 60;

export const AUCTION_PERIOD_DAYS = 30;
export const AUCTION_MIN_RESERVE_FRACTION = 0.3; // a bid below 30% of the seller's own valuation doesn't clear

export const DOWN_PAYMENT_FRACTION = 0.35;   // buyer must have at least this much of their bid in cash now
export const DEBT_TERM_DAYS        = 240;    // remaining balance amortized over ~8 months
export const DEBT_INTEREST_DAILY   = 0.0006; // mild carrying cost — keeps credit from being strictly free money

// Sized the same way the Market's cash pools are (see makeMarketGood): a
// bank that starts near its own reserve floor can't fund a single loan
// until it's somehow already collected interest from loans it was never
// able to issue. POPULATION * 250 gives the Bank enough capacity to fund
// several simultaneous asset-financing deals (bids can run into the
// thousands for the wealthiest bidders) without immediately hitting its
// own liquidity ceiling — tune alongside DOWN_PAYMENT_FRACTION if the
// Bank is chronically illiquid or chronically overflowing in testing.
export const BANK_INITIAL_RESERVE = POPULATION * 250;
world.bank.cash = BANK_INITIAL_RESERVE;
export const BANK_RESERVE = BANK_INITIAL_RESERVE * 0.5; // floor kept before any interest is paid out
export const BANK_PAYOUT_RATE = 0.05; // fraction of excess-above-reserve paid out per day — smoothed, not dumped all at once
