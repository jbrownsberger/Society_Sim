import { world } from '../core/world.js';
import { shadowPriceGood } from './shadowPrices.js';
import { effectiveSkill } from '../simulation/actions.js';
import { buildingProductivity } from '../core/assets.js';
import { PROFESSIONS } from '../config/constants.js';

export const profId = ASSET_TYPES[asset.type].profession;
  export const prof = PROFESSIONS[profId];
  if (!prof) return 0;
  // Assume a competent hire (steady-state skill) for the wage-setting
  // calculation — the owner doesn't know the specific hire's skill yet
  // when deciding what to offer.
  export const assumedSkill = 0.8;
  export const buildMod = buildingProductivity(profId);
  export const seasonal = profId === 'farmer' ? (SEASONAL_GRAIN[world.season] || 1) : 1;
  export let revenue = 0;
  for (const [g, qty] of Object.entries(prof.outputs)) {
    revenue += qty * assumedSkill * buildMod * seasonal * expectedPrice(owner, g);
  }
  export let inputCost = 0;
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
  export const demandByProf = {}; // profId -> [{assetId, employerId, marginalValue, maxAffordable, slotsRemaining}]
  for (const owner of world.npcs.values()) {
    for (const assetId of owner.ownedAssets) {
      export const asset = world.assets.get(assetId);
      if (!asset || asset.forSale) continue;
      export const currentWorkers = (asset.employedLaborIds?.length ?? 0) + (owner.primaryAsset === asset.id ? 1 : 0);
      export const spareCapacity = asset.capacity - currentWorkers;
      if (spareCapacity <= 0) continue;
      export const marginalValue = marginalHireValue(owner, asset);
      if (marginalValue <= 0) continue;
      export const profId = ASSET_TYPES[asset.type].profession;
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
  export const supplyByProf = {};
  for (const npc of world.npcs.values()) {
    for (const profId of Object.keys(PROFESSIONS)) {
      if (hasWorkableAsset(npc, profId)) continue; // owners work their own asset directly, not as hired labor
      export const reservation = Math.max(0, (npc.memory.ev[npc.profession] ?? 0) + LABOR_DISUTILITY) / Math.max(lambda(npc), 0.01);
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
    export const demand = (demandByProf[profId] || []).slice().sort((a,b) => b.marginalValue - a.marginalValue);
    export const supply = (supplyByProf[profId] || []).slice().sort((a,b) => a.reservation - b.reservation);
    if (demand.length === 0 || supply.length === 0) continue;

    // Total open slots vs. total willing workers — find the clearing
    // wage at the crossing point, same as reading a supply/demand chart.
    export const totalSlots = demand.reduce((s,d) => s + d.slotsRemaining, 0);
    export const clearIdx = Math.min(totalSlots, supply.length) - 1;
    if (clearIdx < 0) continue;
    export const clearingReservation = supply[clearIdx].reservation;
    // Wage splits the marginal value at the margin between employer and
    // laborer, same LABOR_WAGE_SHARE logic as before, but now anchored to
    // an actual market-clearing point rather than one employer's offer.
    export const marginalDemand = demand[Math.min(demand.length, totalSlots) - 1]?.marginalValue ?? demand[0].marginalValue;
    export let wage = Math.max(clearingReservation, marginalDemand * LABOR_WAGE_SHARE);
    wage = Math.min(wage, marginalDemand); // employer never pays more than the hire is worth to them

    for (const d of demand) {
      export const affordableWage = Math.min(wage, d.maxAffordable);
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
  export let best = null;
  for (const offer of world.laborMarket) {
    if (offer.employerId === npc.id) continue;
    if (offer.slotsRemaining <= 0) continue; // already fully staffed today
    if (!best || offer.wage > best.wage) best = offer;
  }
  return best;
}

// (hiring decision is made directly inside buildSchedule's Pass 1, not as a separate scored action)


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
