import { ASSET_TYPES, GRID_CELL, PROFESSIONS, createOwnedAsset, findStructureByAssetId, hasWorkableAsset } from './constants.js';
import { logEvent, world } from './state.js';
import { expectedPrice, lambda } from './prices.js';
import { profSessionEV } from './valuation.js';
import { repriceGood } from './market.js';
import { SWITCH_PAYBACK_HORIZON } from './memory.js';

// ─────────────────────────────────────────────
// ASSET CONSTRUCTION — building a NEW asset from scratch
// ─────────────────────────────────────────────
//
// Previously, asset-gated professions (miller, toolmaker, artisan) were
// completely invisible to considerProfessionSwitch for anyone who didn't
// already own the required asset — hasWorkableAsset returned false, so
// computeProfessionEV short-circuited to -999 regardless of how scarce or
// valuable that profession's output was. The ONLY path in was inheriting
// or winning an existing asset at auction, which has nothing to do with
// village-wide demand. This is the fix: a real, financeable construction
// project any NPC can start, so genuine scarcity (e.g., bread) can pull
// new capacity into existence instead of being capped by however many
// mills happen to already exist.

// Estimate the EV of "build this asset, then work it" — used so
// considerProfessionSwitch can compare "start building a mill" against
// staying in a current trade, on the same per-session utility footing as
// every other option.
export function computeConstructionEV(npc, profId) {
  const assetType = Object.keys(ASSET_TYPES).find(t => ASSET_TYPES[t].profession === profId);
  if (!assetType) return -999;
  const def = ASSET_TYPES[assetType];

  // Value of working the asset once built — same math as computeProfessionEV,
  // just without the ownership gate (we're pricing the HYPOTHETICAL asset).
  const savedProf = npc.profession;
  let workingEV;
  try {
    npc.profession = profId;
    workingEV = profSessionEV(npc, profId, /*ignoreAssetGate=*/true);
  } finally {
    // FIX: same try/finally guarantee, applied for consistency even
    // though this swap only touches `profession` (not primaryAsset) —
    // still worth protecting against leaving an NPC's profession field
    // stuck on a hypothetical value if profSessionEV throws.
    npc.profession = savedProf;
  }
  if (!isFinite(workingEV) || workingEV <= 0) return -999;

  // Discount for the wait (buildDays with zero income from this asset)
  // and amortize the build cost over a payback horizon, same spirit as
  // planProfessionSwitch's existing cost-amortization logic.
  const lam = lambda(npc);
  let buildCostValue = 0;
  for (const [g, qty] of Object.entries(def.buildCost)) {
    buildCostValue += qty * expectedPrice(npc, g);
  }
  const amortizedCostPerSession = buildCostValue / SWITCH_PAYBACK_HORIZON;
  // Waiting buildDays before any payoff — a real opportunity cost, modeled
  // as a flat delay discount proportional to how long the build takes.
  const delayDiscount = Math.max(0.3, 1 - def.buildDays / 120);

  // CONGESTION / SATURATION DISCOUNT — the missing piece that caused a
  // severe overshoot in testing (12 of 16 villagers became millers within
  // 200 days after mills were made attractive). Each individual NPC's EV
  // estimate is based on TODAY's price, smoothed slowly (memory alpha =
  // 0.15) — but many NPCs can each independently decide "become a miller"
  // in parallel before that smoothing ever catches up to reflect how many
  // others just made the same call. A rational, forward-looking villager
  // anticipates this: if N people already work (or are already building
  // toward) this exact trade, the market for its output is already well
  // on its way to being saturated by the time THIS build completes
  // (buildDays from now), so the realistic payoff is lower than today's
  // price implies. This discount grows with existing + in-progress
  // headcount in the target trade, strongly enough to make each
  // additional entrant progressively less attractive — mimicking real
  // diminishing returns to entering a crowding trade.
  const existingInTrade = [...world.npcs.values()].filter(n =>
    n.profession === profId || (n.constructionProject && n.constructionProject.assetType === assetType)
  ).length;
  const congestionDiscount = 1 / (1 + existingInTrade * existingInTrade * 0.15);

  return workingEV * delayDiscount * congestionDiscount - amortizedCostPerSession * lam;
}

// Kick off construction: pay the build cost (from savings, buying inputs
// at the market ask same as any purchase — a real cash outlay, not free),
// and set up the labor-hours ledger construction now actually requires
// (see planConstructionAction/executeSchedule) — buildDays is treated as
// "days of one dedicated work session" (CONSTRUCTION_HOURS_PER_DAY hours
// each), converted once here into a total hour count. The NPC keeps
// working their CURRENT trade while building — construction is a
// background project competing for time like anything else, not a
// full-time abandonment of their livelihood (you don't quit your job the
// day you decide to build a mill; you work on it on the side, and it
// takes exactly as long as the labor you actually put into it takes).
export const CONSTRUCTION_HOURS_PER_DAY = 6; // one work-session's worth of dedicated labor per buildDays "day"

export function startConstruction(npc, assetType) {
  const def = ASSET_TYPES[assetType];
  // Build costs are REAL GOODS (wood, grain), not cash — consuming actual
  // physical materials, not a money payment. This matters for two
  // reasons: (1) it's what buildCost was always denominated in, and
  // treating it as a cash-equivalent deduction was quietly creating a
  // money leak (goods vanish from the economy's physical stock, but no
  // corresponding cash ever left the money supply to reflect that); and
  // (2) real, physical scarcity — not just savings — now naturally caps
  // how many construction projects the village can sustain at once, since
  // buying enough wood to build a mill also has to compete with everyone
  // else who wants wood for the same reason.
  // First check total affordability/availability before committing any
  // partial purchases (all-or-nothing: a half-built mill from goods you
  // couldn't fully afford isn't a real state we want to allow).
  for (const [g, qty] of Object.entries(def.buildCost)) {
    const have = npc.inventory[g] ?? 0;
    const shortfall = Math.max(0, qty - have);
    if (shortfall > 0) {
      const g_market = world.market.goods[g];
      const cost = shortfall * g_market.askPrice;
      if (npc.savings < cost) return false;
      if (g_market.stock < shortfall) return false; // Market doesn't physically have enough either
    }
  }
  for (const [g, qty] of Object.entries(def.buildCost)) {
    const have = npc.inventory[g] ?? 0;
    const shortfall = Math.max(0, qty - have);
    if (shortfall > 0) {
      const g_market = world.market.goods[g];
      const cost = shortfall * g_market.askPrice;
      npc.savings -= cost;
      g_market.cash += cost;
      g_market.stock -= shortfall;
      npc.inventory[g] = have + shortfall;
      repriceGood(g);
    }
  }
  for (const [g, qty] of Object.entries(def.buildCost)) {
    npc.inventory[g] = Math.max(0, (npc.inventory[g] ?? 0) - qty);
  }
  npc.constructionProject = {
    assetType,
    laborHoursNeeded: def.buildDays * CONSTRUCTION_HOURS_PER_DAY,
    laborHoursDone: 0,
  };
  logEvent(`${npc.name} begins building a new ${def.name.toLowerCase()}.`, [npc.id]);
  return true;
}

// Called from executeSchedule when a 'build' action actually gets worked
// (not on a calendar timer) — hands the NPC a brand-new asset they own
// outright once enough real labor has gone in, on top of the materials
// already paid at startConstruction.
export function completeConstruction(npc) {
  const { assetType } = npc.constructionProject;
  const { asset } = createOwnedAsset(assetType, npc.id, { gx: Math.round(npc.homeX / GRID_CELL), gy: Math.round(npc.homeY / GRID_CELL) });
  npc.ownedAssets.push(asset.id);
  const profId = ASSET_TYPES[assetType].profession;
  if (profId) {
    if (npc.primaryAsset === null || npc.primaryAsset === undefined) {
      npc.primaryAsset = asset.id;
      npc.profession = profId;
      npc.trainingDaysLeft = PROFESSIONS[profId].trainingDays ?? 0;
    }
  } else if (assetType === 'house' && npc.primaryHouse == null) {
    // First house this NPC has ever completed (as opposed to inheriting
    // or already having one from seedAssets) — move in.
    npc.primaryHouse = asset.id;
    const s = findStructureByAssetId(asset.id);
    if (s) { npc.homeX = s.x; npc.homeY = s.y; }
  }
  logEvent(`${npc.name} completes construction of a new ${ASSET_TYPES[assetType].name.toLowerCase()}.`, [npc.id]);
  npc.constructionProject = null;
}



export function workSessionEV(npc) {
  // Try primary profession first
  const primaryEV = profSessionEV(npc, npc.profession);
  if (isFinite(primaryEV)) return { ev: primaryEV, workAs: npc.profession };

  // Primary blocked — try fallback no-input professions
  const fallbacks = Object.keys(PROFESSIONS).filter(pid => {
    const p = PROFESSIONS[pid];
    return pid !== npc.profession &&
           Object.keys(p.inputs).length === 0 &&
           hasWorkableAsset(npc, pid);
  });

  let bestEV = -Infinity, bestProf = null;
  for (const pid of fallbacks) {
    const ev = profSessionEV(npc, pid);
    if (ev > bestEV) { bestEV = ev; bestProf = pid; }
  }

  if (bestProf && bestEV > -Infinity) return { ev: bestEV, workAs: bestProf };
  return { ev: -Infinity, workAs: null };
}

