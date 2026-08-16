import { ASSET_TYPES, LABOR_DISUTILITY, PROFESSIONS, SEASONAL_GRAIN, buildingProductivity, hasWorkableAsset } from './constants.js';
import { world } from './state.js';
import { expectedPrice, lambda } from './prices.js';

// ─────────────────────────────────────────────
// LABOR MARKET — hired labor at owned assets
// ─────────────────────────────────────────────
//
// An asset owner with spare capacity (their farm/mill/forge/workshop can
// support more than one worker, per ASSET_TYPES' capacity field) can hire
// someone else to work it. This is the missing piece that lets a
// struggling or absent owner still extract value from an asset instead of
// their only options being "grind it out alone" or "abandon it entirely"
// — directly targeting the one-way collapse into woodcutting observed in
// testing, where asset professions had no recovery path once an owner
// faltered.
//
// Mechanics, kept deliberately simple for a first pass:
//   - Each day, every asset owner with spare capacity posts a wage offer
//     equal to a fraction of the marginal output value an additional
//     worker would generate (owner keeps the surplus as their profit —
//     the classic capital/labor split).
//   - Any NPC without a workable primary asset of their own (today, this
//     is effectively "woodcutters and other unemployed/asset-less NPCs")
//     compares the best available wage offer against their own best
//     self-employment EV (workSessionEV) and takes whichever pays more.
//   - Hired labor produces at the LABORER's own skill level, but goods
//     accrue to the EMPLOYER's inventory (the employer owns the output,
//     same as any real employment relationship) — and the employer pays
//     the wage immediately from savings, whether or not they've sold
//     that output yet (a short-term cash outlay against future revenue,
//     which is exactly what real capital owners do).

export const LABOR_WAGE_SHARE = 0.55; // laborer's cut of marginal output value; owner keeps the rest as profit

// Marginal output value of adding ONE more worker at this asset, using
// the OWNER's context for pricing (expectedPrice etc. are npc-specific
// memory, but using the owner's is a reasonable proxy for "what this
// asset's output is worth to sell").
export function marginalHireValue(owner, asset) {
  const profId = ASSET_TYPES[asset.type].profession;
  const prof = PROFESSIONS[profId];
  if (!prof) return 0;
  // Assume a competent hire (steady-state skill) for the wage-setting
  // calculation — the owner doesn't know the specific hire's skill yet
  // when deciding what to offer.
  const assumedSkill = 0.8;
  const buildMod = buildingProductivity(profId);
  const seasonal = profId === 'farmer' ? (SEASONAL_GRAIN[world.season] || 1) : 1;
  let revenue = 0;
  for (const [g, qty] of Object.entries(prof.outputs)) {
    revenue += qty * assumedSkill * buildMod * seasonal * expectedPrice(owner, g);
  }
  let inputCost = 0;
  for (const [g, qty] of Object.entries(prof.inputs)) {
    inputCost += qty * expectedPrice(owner, g);
  }
  return Math.max(0, revenue - inputCost);
}

// ─────────────────────────────────────────────
// LABOR MARKET — per-profession clearing wage (replaces the old
// "everyone scans the whole village for the single highest wage"
// free-for-all). That original design had two real problems that got
// much worse as population grew: (1) it was O(n) PER LABORER scanning
// the entire market, with zero price dispersion — every job-seeker
// piled toward whichever one or two employers happened to post the
// single highest wage that day, ignoring every other reasonable offer
// in a DIFFERENT profession; (2) unlike every other good in this
// simulation, labor had no real price discovery — employers posted
// take-it-or-leave-it quotes instead of a market-clearing price.
//
// The fix treats labor like any other market good: aggregate demand
// (employers' marginal values, i.e. what they'd pay for one more worker)
// and supply (job-seekers' asking price, i.e. their own best alternative
// use of that time) PER PROFESSION, then clear at the wage where they
// cross. Everyone in the same trade sees the same wage that day — real
// price discovery, not a scramble.
// ─────────────────────────────────────────────

export function postWageOffers() {
  // Reset yesterday's hires — still a spot market, re-cleared daily, not
  // standing employment contracts.
  for (const asset of world.assets.values()) asset.employedLaborIds = [];

  // Step 1: collect DEMAND — one entry per (owner, asset) with spare
  // capacity, per profession, each with its own marginal value and
  // affordability cap.
  const demandByProf = {}; // profId -> [{assetId, employerId, marginalValue, maxAffordable, slotsRemaining}]
  for (const owner of world.npcs.values()) {
    for (const assetId of owner.ownedAssets) {
      const asset = world.assets.get(assetId);
      if (!asset || asset.forSale) continue;
      const currentWorkers = (asset.employedLaborIds?.length ?? 0) + (owner.primaryAsset === asset.id ? 1 : 0);
      const spareCapacity = asset.capacity - currentWorkers;
      if (spareCapacity <= 0) continue;
      const marginalValue = marginalHireValue(owner, asset);
      if (marginalValue <= 0) continue;
      const profId = ASSET_TYPES[asset.type].profession;
      (demandByProf[profId] ??= []).push({
        assetId: asset.id, employerId: owner.id, marginalValue,
        maxAffordable: owner.savings, slotsRemaining: spareCapacity,
      });
    }
  }

  // Step 2: collect SUPPLY — every NPC without a workable primary asset
  // in that profession is a potential laborer, asking at least their own
  // best alternative EV (self-employment elsewhere, converted to a
  // per-session wage-equivalent via LABOR_DISUTILITY) — this is their
  // reservation wage, same economic idea as an ask price.
  const supplyByProf = {};
  for (const npc of world.npcs.values()) {
    for (const profId of Object.keys(PROFESSIONS)) {
      if (hasWorkableAsset(npc, profId)) continue; // owners work their own asset directly, not as hired labor
      const reservation = Math.max(0, (npc.memory.ev[npc.profession] ?? 0) + LABOR_DISUTILITY) / Math.max(lambda(npc), 0.01);
      (supplyByProf[profId] ??= []).push({ npcId: npc.id, reservation });
    }
  }

  // Step 3: clear each profession's labor market independently. Sort
  // demand by marginal value (highest willingness-to-pay first) and
  // supply by reservation wage (lowest ask first) — classic supply/
  // demand crossing, same principle as the goods markets' bid/ask, just
  // without persistent inventory.
  world.laborMarket = [];
  for (const profId of Object.keys(PROFESSIONS)) {
    const demand = (demandByProf[profId] || []).slice().sort((a,b) => b.marginalValue - a.marginalValue);
    const supply = (supplyByProf[profId] || []).slice().sort((a,b) => a.reservation - b.reservation);
    if (demand.length === 0 || supply.length === 0) continue;

    // Total open slots vs. total willing workers — find the clearing
    // wage at the crossing point, same as reading a supply/demand chart.
    const totalSlots = demand.reduce((s,d) => s + d.slotsRemaining, 0);
    const clearIdx = Math.min(totalSlots, supply.length) - 1;
    if (clearIdx < 0) continue;
    const clearingReservation = supply[clearIdx].reservation;
    // Wage splits the marginal value at the margin between employer and
    // laborer, same LABOR_WAGE_SHARE logic as before, but now anchored to
    // an actual market-clearing point rather than one employer's offer.
    const marginalDemand = demand[Math.min(demand.length, totalSlots) - 1]?.marginalValue ?? demand[0].marginalValue;
    let wage = Math.max(clearingReservation, marginalDemand * LABOR_WAGE_SHARE);
    wage = Math.min(wage, marginalDemand); // employer never pays more than the hire is worth to them

    for (const d of demand) {
      const affordableWage = Math.min(wage, d.maxAffordable);
      if (affordableWage <= 0.1) continue;
      world.laborMarket.push({
        profId, assetId: d.assetId, employerId: d.employerId,
        wage: affordableWage, slotsRemaining: d.slotsRemaining,
      });
    }
  }
}

// Best wage offer available to a given NPC IN THEIR OWN PROFESSION-
// AGNOSTIC search — still picks the single best offer across all
// professions (an NPC will take whichever paying job is most valuable to
// them personally, e.g. a starving farmer might prefer hired milling
// work over hired farm work if it pays enough more). What changed is
// that wages themselves are now real per-profession clearing prices, not
// one lucky employer's arbitrary quote — so this scan reflects genuine
// price signals instead of noise.
export function bestWageOffer(npc) {
  let best = null;
  for (const offer of world.laborMarket) {
    if (offer.employerId === npc.id) continue;
    if (offer.slotsRemaining <= 0) continue; // already fully staffed today
    if (!best || offer.wage > best.wage) best = offer;
  }
  return best;
}

// (hiring decision is made directly inside buildSchedule's Pass 1, not as a separate scored action)


