import { clamp } from './utils.js';
import { rng } from './rng.js';
import { world } from './state.js';
import { makeNPC } from './npc.js';
import { profSessionEV } from './valuation.js';
import { getAvailableActions } from './death.js';
import { satisfyNeeds } from './needs.js';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

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
export function countAssetsOfType(type) {
  let n = 0;
  for (const a of world.assets.values()) if (a.type === type) n++;
  return n;
}
export function countNpcsInProfession(profId) {
  let n = 0;
  for (const npc of world.npcs.values()) if (npc.profession === profId) n++;
  return n;
}

export let nextAssetId = 0;
export function makeAsset(type, ownerId) {
  const def = ASSET_TYPES[type];
  const id = nextAssetId++;
  return {
    id, type, ownerId,
    quality: def.baseQuality,
    transferable: def.transferable,
    capacity: 2,            // max simultaneous workers (owner + hired) — used from Stage 2 (labor market) onward
    employedLaborIds: [],   // hired NPC ids currently working this asset — populated from Stage 2 onward
    forSale: false,
    starvingStreak: 0,      // consecutive days the owner has been starving while holding this specific asset
    createdDay: world.day,
  };
}

// ─────────────────────────────────────────────
// STRUCTURES — the positional/visual counterpart to an asset
// ─────────────────────────────────────────────
//
// world.assets stays the sole economic authority (stock, ownerId, workers)
// and the sim runs identically headless with world.structures never
// touched. A structure is purely "where is this asset, and what's its
// build/ownership history" — nothing here feeds back into scoring.
//
// One structure per asset INSTANCE (not per type) — every mill, forge,
// house etc. gets its own tile, so multiple mills really do show as
// multiple buildings. assetId links a structure back to its economic
// record; for houses that link is still to a (non-productive) asset,
// see ASSET_TYPES.house, so ownership/inheritance code can treat every
// owned thing — productive or not — uniformly.

export const GRID_CELL = 22;           // px per tile
export const GRID_ANCHOR = { gx: 18, gy: 14 }; // town-center tile, spiral search starts here
export const FOOTPRINTS = {
  market: 2, well: 1, mill: 2, forge: 2, workshop: 2, church: 2,
  farm: 2, house: 1,
};

export function gridKey(gx, gy) { return gx + ',' + gy; }

// Expanding ring search outward from the anchor for the first tile (or
// block of tiles, for footprint>1) not already occupied. Deterministic
// and simple — fine at hamlet scale; a fancier packing can replace this
// later without touching anything that reads world.structures.
export function findFreeGridSpot(footprint, anchorGx = GRID_ANCHOR.gx, anchorGy = GRID_ANCHOR.gy) {
  const occupied = world.gridOccupied; // Set of "gx,gy" keys
  const fits = (gx, gy) => {
    for (let dx = 0; dx < footprint; dx++)
      for (let dy = 0; dy < footprint; dy++)
        if (occupied.has(gridKey(gx + dx, gy + dy))) return false;
    return true;
  };
  for (let radius = 0; radius < 40; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only
        const gx = anchorGx + dx, gy = anchorGy + dy;
        if (fits(gx, gy)) return { gx, gy };
      }
    }
  }
  return { gx: anchorGx, gy: anchorGy }; // fallback: overlap rather than fail
}

export function occupyGrid(gx, gy, footprint) {
  for (let dx = 0; dx < footprint; dx++)
    for (let dy = 0; dy < footprint; dy++)
      world.gridOccupied.add(gridKey(gx + dx, gy + dy));
}

export let nextStructureId = 0;
export function allocStructureId() { return nextStructureId++; }
export function createStructure(type, ownerId, assetId, anchor) {
  const footprint = FOOTPRINTS[type] ?? 1;
  const { gx, gy } = anchor
    ? findFreeGridSpot(footprint, anchor.gx, anchor.gy)
    : findFreeGridSpot(footprint);
  occupyGrid(gx, gy, footprint);
  const structure = {
    id: allocStructureId(), type, assetId, ownerId,
    gx, gy, footprint,
    x: gx * GRID_CELL, y: gy * GRID_CELL, // pixel position, cached for the renderer
    label: ASSET_TYPES[type]?.name ?? type,
    history: [{ day: world.day, event: 'built', ownerId }],
  };
  world.structures.set(structure.id, structure);
  return structure;
}

export function findStructureByAssetId(assetId) {
  for (const s of world.structures.values()) if (s.assetId === assetId) return s;
  return null;
}
export function findStructureByType(type) {
  for (const s of world.structures.values()) if (s.type === type) return s;
  return null;
}

export function recordStructureTransfer(structure, fromId, toId, event = 'sold') {
  if (!structure) return;
  structure.ownerId = toId;
  structure.history.push({ day: world.day, event, fromId, toId });
}

// Creates BOTH the economic asset and its paired structure in one call —
// the only place either should ever be created, so they can't drift out
// of sync the way world.buildings/world.assets did before this refactor.
// `anchor` optionally biases placement (e.g. a house near its owner's
// existing home) — omit for "nearest free spot to town center."
export function createOwnedAsset(type, ownerId, anchor) {
  const asset = makeAsset(type, ownerId);
  world.assets.set(asset.id, asset);
  const structure = createStructure(type, ownerId, asset.id, anchor);
  return { asset, structure };
}

// Seed starting assets matching the existing profDist, so every asset-
// gated profession (farmer, miller, toolmaker, artisan) has a backing
// asset from day one, AND every NPC gets a starting house (shelter is
// required for full rest — see housingQuality()). Woodcutting needs no
// productive asset (commons resource), but still gets a house.
export function seedAssets() {
  for (const npc of world.npcs.values()) {
    const prof = npc.profession;
    const assetType = PRODUCTIVE_ASSET_TYPES.find(t => ASSET_TYPES[t].profession === prof);
    if (assetType) {
      const { asset, structure } = createOwnedAsset(assetType, npc.id);
      npc.ownedAssets.push(asset.id);
      npc.primaryAsset = asset.id;
    }

    const { asset: house, structure: houseStructure } = createOwnedAsset('house', npc.id);
    npc.ownedAssets.push(house.id);
    npc.primaryHouse = house.id;
    // Anchor the NPC's homeX/homeY (used all over movement/rendering) to
    // where their house actually got placed, instead of the old random
    // scatter point.
    npc.homeX = houseStructure.x;
    npc.homeY = houseStructure.y;
  }
}

// Returns true if this NPC can currently work `profId` — either the
// profession needs no physical asset (woodcutter), or the NPC personally
// owns an asset of the matching type and has it set as their primary
// (i.e., the one they operate themselves, vs. one they merely hold title
// to and staff with hired labor — see Stage 2).
export function hasWorkableAsset(npc, profId) {
  const assetType = Object.keys(ASSET_TYPES).find(t => ASSET_TYPES[t].profession === profId);
  if (!assetType) return true;
  if (npc.primaryAsset === null || npc.primaryAsset === undefined) return false;
  const asset = world.assets.get(npc.primaryAsset);
  return !!asset && asset.type === assetType && asset.ownerId === npc.id;
}

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

export function buildingProductivity(profId) {
  const req = PROFESSIONS[profId]?.requires;
  return req ? (BUILDING_PRODUCTIVITY[req] ?? 1.0) : 1.0;
}

// ─────────────────────────────────────────────
// PRESTIGE — standing in the village.
// ─────────────────────────────────────────────
// A profession's inherent status, independent of how well any individual
// NPC happens to be doing at it — skilled/gated trades (miller, toolmaker,
// artisan, all requiring a building and real training investment) read as
// higher-status than subsistence trades (farmer, woodcutter), matching
// the ask. This is a flat per-profession constant, not derived from
// current wages, so it doesn't double-count with the wealth term below.
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

export function prestigeTarget(npc) {
  const professionPart = PROFESSION_PRESTIGE[npc.profession] ?? 0;
  const wealthPart = Math.min(PRESTIGE_WEALTH_CAP, Math.log1p(Math.max(0, npc.savings)) * PRESTIGE_WEALTH_LOG_SCALE);
  const assetPart  = Math.min(PRESTIGE_ASSET_CAP, (npc.ownedAssets?.length ?? 0) * PRESTIGE_PER_ASSET);
  return clamp(professionPart + wealthPart + assetPart, 0, 1);
}

// ─────────────────────────────────────────────
// NEEDS REGISTRY — the single place a need's identity lives.
// ─────────────────────────────────────────────
// Every need is the same shape: a [0,1] level, a weight (how much it
// matters), a decay rate (entropy — needs fade if not tended), and two
// flags that drive the versatility this whole decision system is built
// around:
//   starvationFloor — if >0, this need has a real survival cliff. Falling
//     below it (a) makes its marginal utility spike sharply (see
//     needMarginalUtility below) so relieving it dominates any competing
//     use of the same resource, and (b) triggers an out-of-cycle
//     emergency replan mid-week (see emergencyReplanNeeded), instead of
//     waiting for the NPC's next scheduled planning day.
//   critical — if true, this need's own consumption goods (e.g. bread for
//     food) always keep a fixed daily-intake reserve, no matter how
//     "satisfied" the need currently reads — you eat on a schedule, not
//     only when hungry. If false, this need is discretionary: goods that
//     satisfy it (e.g. fine goods for comfort) are only reserved for
//     personal consumption when doing so is actually worth more than
//     selling them for cash — see shouldKeepForConsumption. This is what
//     lets a starving artisan correctly choose to sell fine goods for
//     food money instead of self-comforting while starving, without any
//     hardcoded "if food is urgent, override comfort" rule anywhere.
// Adding a new need (e.g. "status") means adding one entry here. Nothing
// else in shadowPriceGood, scoreAction, lambda, or the planner needs to
// change for the new need to be correctly weighed against every existing
// one.
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
export const OLD_AGE_MIN_DOGYEARS = 10; // each NPC's actual lifespan is sampled once (see makeNPC) between these two, so deaths spread out naturally instead of everyone dying in the same week
export const OLD_AGE_MAX_DOGYEARS = 12;

// How much of full comfort/social/meaning a household currently provides,
// from 0 (single, childless) approaching 1 (married with several kids).
// Purely a function of composition — the day-to-day channel trackers
// (npc.familyChannel) converge toward this smoothly rather than jumping,
// so gaining/losing a spouse or child reads as a real transition, not an
// instant snap.
export function familyTargetFromComposition(hasSpouse, numChildren) {
  const childContribution = 1 - Math.pow(1 - FAMILY_CHANNEL_PER_CHILD, numChildren);
  const spouseContribution = hasSpouse ? FAMILY_CHANNEL_SPOUSE_BONUS : 0;
  return clamp(spouseContribution + (1 - spouseContribution) * childContribution, 0, 1);
}
export function familyChannelTarget(npc) {
  const hasSpouse = npc.spouseId != null && world.npcs.has(npc.spouseId);
  const n = npc.childIds ? npc.childIds.length : 0;
  return familyTargetFromComposition(hasSpouse, n);
}

// Marginal utility of one more unit of `need`, right now, for this NPC.
// Same formula for every need — diminishing returns via 1/(1+level) — plus
// a cliff multiplier once a need with a starvationFloor drops below it.
// The cliff is deliberately bounded (max ~4x) rather than unbounded, so a
// crisis reorders priorities decisively without blowing up the overall
// magnitude of utility/lambda the rest of the economy is calibrated
// around.
// Does this NPC currently have a roof over their head? Required for full
// rest satisfaction — a homeless NPC can still rest (there's always
// somewhere to lie down), but recovers less energy and gets less of the
// comfort/social/meaning trickle than someone resting in their own house.
// Deliberately NOT zero at 0 shelter: total collapse of rest would make
// homelessness a death spiral (can't rest -> can't work -> can't afford
// a house) rather than the hardship it should read as.
export const HOMELESS_REST_PENALTY = 0.45; // fraction of full rest value while unhoused
export function housingQuality(npc) {
  if (npc.primaryHouse != null) {
    const house = world.assets.get(npc.primaryHouse);
    if (house && house.ownerId === npc.id) return 1.0;
  }
  // Married and living in a spouse's house (see marryCouple, which nulls
  // out the moved-in partner's own primaryHouse once consolidated into
  // one household) — still sheltered, just not the owner of record.
  if (npc.spouseId != null) {
    const spouse = world.npcs.get(npc.spouseId);
    if (spouse && spouse.primaryHouse != null) {
      const house = world.assets.get(spouse.primaryHouse);
      if (house && house.ownerId === spouse.id) return 1.0;
    }
  }
  return HOMELESS_REST_PENALTY;
}

export function needMarginalUtility(npc, need) {
  const cfg = NEEDS[need];
  if (!cfg) return 0;
  const level = npc.needs[need] ?? 0;
  let mu = cfg.weight / (1 + level);
  if (cfg.starvationFloor > 0 && level < cfg.starvationFloor) {
    const severity = (cfg.starvationFloor - level) / cfg.starvationFloor; // 0..1
    mu *= 1 + severity * 3; // up to ~4x at the very bottom
  }
  return mu;
}

// Any need whose starvationFloor is currently breached demands an
// immediate replan rather than waiting for the NPC's next scheduled
// planning day (see buildSchedule) — the generalized escape hatch.
export function emergencyReplanNeeded(npc) {
  for (const [need, cfg] of Object.entries(NEEDS)) {
    if (cfg.starvationFloor > 0 && (npc.needs[need] ?? 0) < cfg.starvationFloor) return true;
  }
  // A pending help request directed at ME won't otherwise be considered
  // until my next regular weekly planning day — which can be longer than
  // HELP_REQUEST_EXPIRY_DAYS (3 days). Verified via harness trace: 'help'
  // actions that scored as the clear #1 choice (up to 300+ utility/hr vs.
  // ~1 for rest) were still expiring unresolved because the target's
  // schedule had already been locked in before the request even existed.
  // Same escape-hatch pattern as the critical-need check above.
  if (world.helpRequests.some(r => r.targetId === npc.id && !r.resolved)) return true;
  return false;
}

// Which need (if any) does consuming one unit of `good` satisfy, and by
// how much? Derived entirely from GOODS' own nutrition/comfortValue
// fields — a new consumable good or a new need it satisfies is one edit
// to GOODS/this map, not a new branch in shadowPriceGood or getBufferTarget.
export function goodConsumptionEffect(good) {
  const g = GOODS[good];
  if (!g) return null;
  if (g.nutrition > 0)    return { need: 'food',    amount: g.nutrition };
  if (g.comfortValue > 0) return { need: 'comfort', amount: g.comfortValue };
  return null;
}

// Is it worth keeping one more unit of `good` for personal consumption
// today, vs. selling it? Critical needs (food) always get their fixed
// daily intake reserve — see NEEDS.critical and getBufferTarget.
//
// For a DISCRETIONARY good (comfort, and any future non-critical need),
// the default is also to keep the reserve — comfort goods are meant to be
// enjoyed, not perpetually monetized. Comparing raw useValue against
// sellNow (price * lambda) directly doesn't work as an every-day gate:
// lambda's typical magnitude is dominated by food's much larger weight
// even when the NPC is perfectly well-fed, so that comparison would
// almost always favor selling regardless of actual hunger — silently
// collapsing the entire comfort-goods economy rather than fixing the
// starving-artisan case it was meant to target.
//
// So the reserve is only released when a CRITICAL need is genuinely in
// its own starvation-floor crisis right now — the direct generalization
// of the old single-purpose "if food is urgent, sell fine goods instead"
// override, except keyed off the NEEDS registry (any critical need, not
// just food) instead of a hardcoded threshold on one specific need.
export function shouldKeepForConsumption(npc, good) {
  const effect = goodConsumptionEffect(good);
  if (!effect) return true;
  if (NEEDS[effect.need].critical) return true;

  for (const [need, cfg] of Object.entries(NEEDS)) {
    if (cfg.critical && cfg.starvationFloor > 0 && (npc.needs[need] ?? 0) < cfg.starvationFloor) {
      return false; // a critical need is in crisis — sell for cash instead of self-consuming
    }
  }
  return true;
}

// Some goods ease a need just by being held in reserve, independent of
// being consumed — a full larder eases anxiety about tomorrow before any
// of it is actually eaten. This is a STOCK effect (how many days' worth
// you have banked), distinct from goodConsumptionEffect's FLOW effect
// (what satisfies a need when you use one unit right now). Amount is
// expressed in "days of daily intake" so it composes with the same
// foodTarget/nutrition math satisfyNeeds already uses for the food need
// itself, rather than needing its own separate unit system. Adding
// another good/need pair here (e.g. stored wood easing security through a
// hard winter) is one line, same versatility principle as NEEDS/
// goodConsumptionEffect.
export const BUFFER_STOCK_EFFECTS = {
  // daysForFullBenefit tested at 5 first: with ~48 NPCs simultaneously
  // chasing a 10-unit buffer of bread (which perishes at 15%/day), demand
  // overwhelmed supply and drove a village-wide price spiral (bread
  // roughly tripled, savings collapsed faster than the buffer effect
  // stabilized security) -- a classic "individually rational hoarding
  // becomes collectively self-defeating" dynamic. 2 days (4 units) still
  // gives the security benefit real weight without triggering that
  // spiral in testing; worth revisiting if the target profession mix or
  // bread supply changes.
  bread: { need: 'security', daysForFullBenefit: 2 },
};

// What fraction (0..1) of the "full benefit" buffer size does this NPC
// currently hold for `good`? Used both to actually grant the stock-based
// need benefit (satisfyNeeds) and to size how much of that buffer the NPC
// tries to keep on hand (getBufferTarget) — one number driving both the
// felt benefit and the purchasing target that pursues it.
export function bufferStockRatio(npc, good) {
  const cfg = BUFFER_STOCK_EFFECTS[good];
  if (!cfg) return 0;
  const dailyTarget = 2 * GOODS[good].nutrition; // matches satisfyNeeds' daily food-intake target
  if (dailyTarget <= 0) return 0;
  const daysOnHand = ((npc.inventory[good] ?? 0) * GOODS[good].nutrition) / dailyTarget;
  return Math.min(daysOnHand / cfg.daysForFullBenefit, 1);
}

export const SEASONAL_GRAIN = { spring:2.0, summer:2.0, autumn:2.0, winter:2.0 };
export const LABOR_DISUTILITY = 4;
export const WORK_SESSION_HOURS = 6; // mirrors buildDayCandidates' local WORK_DURATION — used by getAvailableActions (a different function/scope) for opportunity-cost calculations, e.g. help's forgone-labor term below.
// NAMES is intentionally a name-GENERATOR, not a fixed list. A fixed
// array works for a static population of 16, but breaks the moment
// anyone is born, immigrates, or otherwise joins after setup — you'd
// run out of names. generateName() combines a first + last syllable
// pool deterministically off the seeded RNG, so it scales to any future
// population size and stays reproducible run-to-run.
// NAMES: two-syllable combinations from a shared pool, deterministic off
// the seeded RNG. Founders get two random syllables. Children inherit —
// their name is a random combination of two of their four PARENTAL
// syllables (two from each parent), not a fresh random draw — so family
// names visibly echo across generations (a child might get one syllable
// from each parent, or both from one), without ever needing a fixed
// surname field.
export const SYLLABLES = ['al','bram','cor','dun','ed','fenn','gun','hal','ing','jor',
                    'kel','lor','mar','nor','os','rag','sig','thal','ul','wyn',
                    'ber','col','dag','ew','fri','gund','helm','iv','ric','len',
                    'mag','nora','rid','sten','thor','vald','wren','yor','frey','holt'];

export function combineSyllables(s1, s2) {
  return s1.charAt(0).toUpperCase() + s1.slice(1) + s2;
}

// Founders (no parents) — two random syllables from the shared pool.
export function generateName(rng) {
  const s1 = rng.pick(SYLLABLES);
  let s2 = rng.pick(SYLLABLES);
  while (s2 === s1) s2 = rng.pick(SYLLABLES); // avoid degenerate self-combos like "Alal"
  return { name: combineSyllables(s1, s2), syllables: [s1, s2] };
}

// Children — two of the four syllables drawn from BOTH parents' names
// (2 each), picked at random without replacement. This is the actual
// mechanism requested: no fresh random draw from the full pool, just
// recombination of what the parents already carry.
export function generateChildName(motherSyllables, fatherSyllables, rng) {
  const pool = [...(motherSyllables || SYLLABLES.slice(0,2)), ...(fatherSyllables || SYLLABLES.slice(0,2))];
  const i = rng.int(0, pool.length - 1);
  let j = rng.int(0, pool.length - 1);
  while (j === i) j = rng.int(0, pool.length - 1);
  return { name: combineSyllables(pool[i], pool[j]), syllables: [pool[i], pool[j]] };
}
