import { ACTIVITY_SOCIAL_CAP, ASSET_TYPES, DOG_YEAR_DAYS, FOOTPRINTS, GOODS, GRID_CELL, LABOR_DISUTILITY, MATERIAL_COMFORT_CAP, NEEDS, OLD_AGE_MAX_DOGYEARS, OLD_AGE_MIN_DOGYEARS, PROFESSIONS, allocStructureId, familyChannelTarget, findFreeGridSpot, generateName, housingQuality, occupyGrid, seedAssets } from './constants.js';
import { rng } from './rng.js';
import { POPULATION, world } from './state.js';
import { graduateChild } from './marriage.js';
import { killNPC, tickAgingAndDeaths } from './death.js';
import { issueDebt, serviceDebts } from './auctions.js';

// ─────────────────────────────────────────────
// NPC FACTORY
// ─────────────────────────────────────────────

// nextNpcId is a persistent counter (not just population.length) so that
// IDs stay unique forever even after future emigration/death removes
// NPCs from world.npcs — a future birth/immigration event just calls
// makeNPC(nextNpcId++, ...) and there's never a collision or reuse.


export const YEAR_LENGTH = 360;              // 4×90-day seasons — matches the season cycle elsewhere
                                       // moved up here (was previously defined much later in the
                                       // file) because makeNPC() now needs it at NPC-creation time
                                       // for the initial daysSinceSwitch spread.

export let nextNpcId = 0;

export function makeNPC(prof, x, y) {
  const id = nextNpcId++;
  const { name, syllables } = generateName(rng);
  return {
    id, name, syllables, profession: prof,
    trainingProfession: null,   // set when switching; matches profId while ramping up
    trainingDaysLeft: 0,
    ownedAssets: [],   // asset ids this NPC holds title to (see ASSET_TYPES / seedAssets)
    // Sparse map of npcId -> { affinity: -1..1, familiarity: 0..1,
    // lastEventDay }. Lazily populated on first contact event (see
    // bumpAffinity) rather than pre-seeded for the whole village — memory
    // stays proportional to actual social contact, not population^2.
    relations: new Map(),
    primaryAsset: null, // which owned asset (if any) this NPC personally operates
    primaryHouse: null, // which owned asset (type:'house') this NPC lives in — see housingQuality()
    spouseId: null,       // married NPC's id, or null
    childIds: [],         // ids into world.children — dependents this NPC is a parent of
    parentIds: [],        // this NPC's own parents' ids, if they grew up in this sim (see graduateChild) — empty for founding villagers. Kept after growing up specifically so killNPC can find living adult children as heirs.
    lastChildbirthDay: -Infinity, // enforces the demographic birth interval between children
    age: 0,               // in days — overridden explicitly at both entry points (spawnNPC for the starting village, graduateChild for maturing children), since 0 would wrongly mean "just born" for a founding adult
    naturalLifespanDays: rng.float(OLD_AGE_MIN_DOGYEARS, OLD_AGE_MAX_DOGYEARS) * DOG_YEAR_DAYS, // sampled once per NPC so deaths spread out rather than clustering
    starvingDays: 0,      // consecutive days at/below NEEDS.food.starvationFloor — see tickAgingAndDeaths
    materialComfort: 0.3, // comfort channel from fine goods (see MATERIAL_COMFORT_CAP)
    activitySocial: 0.3,  // social channel from socializing/warmth (see ACTIVITY_SOCIAL_CAP)
    familyChannel: 0,     // comfort/social/meaning channel from marriage/children (see familyChannelTarget)
    debts: [],         // Bank-financed installment loans from auction purchases (see issueDebt/serviceDebts)
    x, y, destX: x, destY: y, moving: false,
    energy: 80 + rng.float(0,20),
    savings: rng.float(60, 150), // raised again: the (20,55) range left most
    financeLog: [], // rolling recent income/expenditure history — see adjustSavings() in state.js
    // NPCs one bad week from the SAVINGS_RESERVE floor, unable to afford
    // work inputs or switching costs. A deeper cash buffer gives the
    // village room to actually respond to price signals instead of being
    // liquidity-constrained into paralysis.
                                  // chronic underbidding during winter price spikes
    capital: rng.float(0, 4),
    inventory: { grain: rng.float(2,4), bread: rng.float(0,2), wood: rng.float(1,3), tools: rng.float(0,1), luxury: 0 },
    needs: { food: rng.float(0.4,0.8), security: rng.float(0.3,0.7), comfort: rng.float(0.2,0.5), social: rng.float(0.3,0.7), meaning: rng.float(0.2,0.6), prestige: rng.float(0.05,0.3) },
    traits: {
      riskTolerance: rng.float(0.2, 0.9),
      ambition:      rng.float(0.1, 0.9),
      sociability:   rng.float(0.2, 0.9),
      piety:         rng.float(0.1, 0.8),
    },
    skills: {
      farmer:     rng.float(0.5,1.3),
      woodcutter: rng.float(0.4,1.2),
      miller:     rng.float(0.2,0.6),
      toolmaker:  rng.float(0.2,0.6),
      artisan:    rng.float(0.2,0.6),
      // Founders start as ESTABLISHED practitioners of their assigned
      // profession, not novices — the low ranges above are correct for
      // someone switching INTO a skilled trade mid-game (who ramps up
      // via trainingDaysLeft/effectiveSkill's ramp), but wrong for a
      // founding villager who's supposedly already been working this job
      // for years. Verified via harness trace: with the old uniform low
      // range, an average founding miller produced only ~40% of nominal
      // bread output (skill ~0.2-0.6), which — combined with grain's
      // correctly-high opportunity cost via shadowPriceGood — made
      // milling a genuinely bad trade for a brand-new miller, so nearly
      // the whole founding cohort of millers rationally chose to
      // "tinker" (build skill, no inputs needed) instead of ever
      // actually milling. Since every founding miller started at the
      // same low skill simultaneously, village-wide bread production
      // stayed near zero for the exact early window it was needed most,
      // triggering a cascading famine well before any of the other
      // (real, but secondary) issues in this chain even mattered.
      [prof]: rng.float(0.85, 1.3),
    },
    // Time-use tracking: rolling history of how many hours per day this
    // NPC spent on each schedule-action category. Populated once per day
    // in buildSchedule() (see TIME_USE_WINDOW). Powers both the
    // individual inspector breakdown and feeds into the village-wide
    // aggregate in world.timeUseHistory.
    timeUseHistory: [],
    memory: {
      priceHistory: { grain:[], bread:[], wood:[], tools:[], luxury:[] },
      ev: { farmer:5, woodcutter:5,
        miller: (GOODS.bread.baseValue*PROFESSIONS.miller.outputs.bread - GOODS.grain.baseValue*PROFESSIONS.miller.inputs.grain) / PROFESSIONS.miller.laborHours - LABOR_DISUTILITY,
        toolmaker: (GOODS.tools.baseValue*PROFESSIONS.toolmaker.outputs.tools - GOODS.wood.baseValue*PROFESSIONS.toolmaker.inputs.wood) / PROFESSIONS.toolmaker.laborHours - LABOR_DISUTILITY,
        artisan: (GOODS.luxury.baseValue*PROFESSIONS.artisan.outputs.luxury - GOODS.grain.baseValue*PROFESSIONS.artisan.inputs.grain - GOODS.wood.baseValue*PROFESSIONS.artisan.inputs.wood) / PROFESSIONS.artisan.laborHours - LABOR_DISUTILITY },
      daysSinceSwitch: rng.int(0, YEAR_LENGTH), // full-year spread so starting village
      // desynchronizes switch-eligibility immediately, instead of the old
      // 0-40 range which meant an unrealistic fraction of the village
      // became simultaneously switch-eligible in the very first weeks.
      // Candidacy tracking: an NPC only switches when a single alternative has
      // been the best-EV option for SWITCH_CANDIDACY_DAYS consecutive days.
      // If the leading candidate changes, the count resets. This prevents
      // seasonal noise (winter making farming look bad for 90 days) from
      // triggering a switch — the same profession has to win every single day
      // of the observation window.
      switchCandidate: null,   // profId of current leading alternative
      switchCandidacyDays: 0,  // consecutive days that candidate has led
    },
    schedule: [],
    currentAction: 'idle',
    homeX: x, homeY: y,
    // Weekly planning state (see planWeek/buildSchedule). planOffset
    // spreads each NPC's replanning day across the week (id % 7) so the
    // whole village doesn't recompute its schedule in lockstep every 7
    // days — same herding-avoidance idea as the profession-switch stagger.
    weekPlan: [],
    weekPlanDay: 0,
    planOffset: id % PLANNING_HORIZON_DAYS_FALLBACK,
  };
}
// PLANNING_HORIZON_DAYS is defined later in the file (with the rest of the
// weekly planner) but makeNPC runs before that point in load order, so a
// same-valued fallback constant is used here for the modulo above.
export const PLANNING_HORIZON_DAYS_FALLBACK = 7;



// buildProfDist(n) generates a starting profession distribution that
// keeps the SAME ratios as the original hand-tuned 16-NPC village
// (37.5% farmer-or-flex, ~19% woodcutter, ~12.5% miller, ~6% toolmaker,
// remainder flex-farmers) but scaled proportionally to any population
// size. This keeps the initial economy shape consistent even as we
// change POPULATION, and is itself a template for how a future
// immigration event could pick a newcomer's starting profession
// (weighted by current village composition/need rather than fixed ratios).
export function buildProfDist(n) {
  // Miller share raised 2/16->4/16 (farmer/woodcutter trimmed to 4/16
  // each to compensate). This is the actual root cause behind the
  // starvation crisis, found by tracing individual switch decisions:
  // every farmer who "defected" to woodcutting did so already at
  // food~0.00-0.14 (using the starvation tenure-lock bypass), not from a
  // rational EV comparison — and bread stock was hitting genuine zero by
  // day 4, with 54-72 units/day of unmet demand, WHILE all 6 starting
  // millers were still on the job. The math never closed: 6 millers x 12
  // bread/session = 72 bread/day maximum possible output, against ~96
  // bread/day needed for 48 people at 2 units/person. No amount of
  // pricing, switching-resistance, or housing fixes can close an actual
  // production-capacity shortfall — the village was structurally
  // guaranteed to starve from day 1 regardless of anything else. The
  // wood-price blip and the farmer exodus were real, but downstream
  // symptoms of this deeper arithmetic problem, not the root cause.
  const ratios = [
    ['farmer',      4/16],
    ['woodcutter',  4/16],
    ['miller',      4/16],
    ['toolmaker',   1/16],
  ];
  const dist = [];
  for (const [prof, ratio] of ratios) {
    const count = Math.round(n * ratio);
    for (let i = 0; i < count; i++) dist.push(prof);
  }
  // Remainder (the old "4 flex" slots) fills out to exactly n, always as
  // flex-farmers, same as the original village.
  while (dist.length < n) dist.push('farmer');
  return dist.slice(0, n);
}

// spawnNPC centralizes NPC creation + placement + world registration into
// one call, so a future birth/immigration event can reuse it directly
// instead of duplicating the angle/radius placement math inline.
export function spawnNPC(prof) {
  const id = nextNpcId; // peek — makeNPC() will actually increment it
  const angle = (id / POPULATION) * Math.PI * 2;
  const r = 220 + rng.float(-40, 40); // widened from 130 to fit 3x the NPCs without overlap
  const x = 380 + Math.cos(angle) * r;
  const y = 280 + Math.sin(angle) * r;
  const npc = makeNPC(prof, x, y);
  npc.homeX = x; npc.homeY = y;
  // Founding villagers start as established young adults, not newborns —
  // spread across a range so old-age deaths (see tickAgingAndDeaths)
  // don't all land in the same narrow window later. Kept well below the
  // 10-12 dog-year lifespan (not 3-8, which left almost no runway before
  // the whole founding generation died of old age at once — verified via
  // harness: population collapsed 48->2 in 800 days, driven mostly by a
  // synchronized old-age die-off, not starvation).
  npc.age = rng.float(1, 5) * DOG_YEAR_DAYS;
  world.npcs.set(npc.id, npc);
  return npc;
}

// buildProfDist(POPULATION) can't run at module top level here: POPULATION
// (from state.js) isn't guaranteed initialized yet given this file's spot
// in the import cycle. Computed lazily inside initWorld() instead.
export let profDist;

// Village institutions (Market, Well, Church) aren't owned by any NPC and
// have no backing economic asset — just a structure record so they show
// up on the map and can be found by type like anything else.
export function createInstitutionStructure(type, label) {
  const footprint = FOOTPRINTS[type] ?? 1;
  const { gx, gy } = findFreeGridSpot(footprint);
  occupyGrid(gx, gy, footprint);
  const structure = {
    id: allocStructureId(), type, assetId: null, ownerId: null,
    gx, gy, footprint, x: gx * GRID_CELL, y: gy * GRID_CELL, label,
    history: [{ day: world.day, event: 'built', ownerId: null }],
  };
  world.structures.set(structure.id, structure);
  return structure;
}
// Runs the actual world/population seeding side effects. Called once from
// main.js after every module has finished loading, so that cyclic imports
// (e.g. this file needing POPULATION from state.js, or BANK_INITIAL_RESERVE
// in auctions.js needing world from state.js) are all fully initialized
// before anything reads them.
export function initWorld() {
  profDist = buildProfDist(POPULATION);
  for (let i = 0; i < POPULATION; i++) {
    spawnNPC(profDist[i]);
  }
  createInstitutionStructure('market', 'Market');
  createInstitutionStructure('well', 'Well');
  createInstitutionStructure('church', 'Church');
  createInstitutionStructure('construction_center', 'Construction Center');
  createInstitutionStructure('agora', 'Agora');

  seedAssets(); // give every asset-gated starting profession its matching farm/mill/forge/workshop, plus a house for everyone
}
