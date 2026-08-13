import { world } from '../core/world.js';
import { GOODS, NEEDS, PROFESSIONS } from '../config/constants.js';
import { needMarginalUtility, goodConsumptionEffect, shouldKeepForConsumption, bufferStockRatio } from '../core/needs.js';
import { hasWorkableAsset, buildingProductivity } from '../core/assets.js';
import { effectiveSkill } from '../simulation/actions.js';

// ─────────────────────────────────────────────
// SHADOW PRICE SYSTEM  ← the core decision math
// ─────────────────────────────────────────────

// The Market posts its prices openly — there's no need for NPCs to
// estimate a price from noisy trade history anymore. expectedPrice()
// returns the Market's current midpoint, used everywhere valuation needs
// a single blended number (shadow pricing, EV estimates, forecasting).
// Where an NPC is about to actually transact, use marketAsk()/marketBid()
// instead — those are the real prices they'll pay or receive.
export function expectedPrice(npc, good) {
  return world.market.goods[good]?.midPrice ?? GOODS[good].baseValue;
}

// What an NPC actually pays to buy one unit from the Market right now.
export function marketAsk(good) {
  return world.market.goods[good]?.askPrice ?? GOODS[good].baseValue;
}

// What an NPC actually receives selling one unit to the Market right now.
export function marketBid(good) {
  return world.market.goods[good]?.bidPrice ?? GOODS[good].baseValue;
}

// ── Seasonal price forecast ────────────────────────────────────────────────
// Returns the NPC's best estimate of what `good` will cost in `targetSeason`,
// based purely on their observed price history. No hardcoded calendar.
//
// Epistemically honest: an NPC who hasn't observed a full year has sparse or
// no data for seasons they haven't lived through yet, and falls back to the
// current expected price (no forecast premium). This means year-1 NPCs under-
// warehouse slightly — they learn to warehouse better after surviving winter.
export function expectedSeasonalPrice(npc, good, targetSeason) {
  export const unwrap = e => (typeof e === 'object' ? e.price : e);
  // The Market's posted price history is public — every NPC sees the same
  // record, so there's no need to blend in a separate personal memory of
  // prices the way the old peer-to-peer market required. (npc.memory.
  // priceHistory is still populated, kept for future info-access mechanics
  // — e.g. literacy or distance from the Market gating who gets timely
  // price news — but it currently just mirrors the public record.)
  export const all = world.market.goods[good]?.priceHistory ?? [];

  export const seasonal = all.filter(e => (typeof e === 'object' ? e.season : null) === targetSeason);
  if (seasonal.length < 3) {
    // Insufficient seasonal data — fall back to current expectation.
    // The NPC has no basis to forecast a premium yet.
    return expectedPrice(npc, good);
  }
  // Simple average of observed prices in the target season.
  return seasonal.reduce((s, e) => s + unwrap(e), 0) / seasonal.length;
}

// ── Seasons in order, used to determine what season is N days ahead ────────
export const SEASON_ORDER = ['spring', 'summer', 'autumn', 'winter'];

export function seasonNDaysAhead(daysAhead) {
  export const dayOfYear = (world.day + daysAhead) % 360;
  return SEASON_ORDER[Math.floor(dayOfYear / 90)];
}

// ── Speculative carry value ────────────────────────────────────────────────
// Net present value of holding one additional unit of a storable good for
// resale, accounting for perish losses and time discounting.
//
//   carryValue = expectedFuturePrice × survivalRate^daysToSell - currentPrice
//
// If positive, holding an extra unit is worth more than selling today.
// The NPC's buffer target is implicitly the quantity where marginal carry
// value equals zero — implemented by having runMarketExchange sell above buffer
// and buy below it, with the buffer set to the carry-positive quantity.
//
// daysToSell: rough estimate of how long until the NPC expects to sell.
// We use the midpoint of the expected high-price season (90 days away at most).
export function speculativeCarryValue(npc, good) {
  export const g = GOODS[good];
  if (g.perishRate >= 0.5) return 0; // too perishable to warehouse profitably
  if (g.perishRate === 0 && g.nutrition === 0) return 0; // tools: handled separately

  export const currentP = expectedPrice(npc, good);

  // Find the highest-price season the NPC knows about
  export let bestSeasonPrice = currentP;
  export let bestDays = 0;
  for (const season of SEASON_ORDER) {
    if (season === world.season) continue;
    export const forecast = expectedSeasonalPrice(npc, good, season);
    if (forecast > bestSeasonPrice) {
      bestSeasonPrice = forecast;
      // Rough days until middle of that season
      export const targetIdx = SEASON_ORDER.indexOf(season);
      export const currentIdx = SEASON_ORDER.indexOf(world.season);
      export const seasonsAway = ((targetIdx - currentIdx + 4) % 4);
      bestDays = seasonsAway * 90 + 45; // midpoint of that season
    }
  }

  if (bestDays === 0) return 0; // no better season found

  export const survivalRate  = Math.pow(1 - g.perishRate, bestDays);
  export const futureValue   = bestSeasonPrice * survivalRate;
  export const discRate      = discountRate(npc);
  export const discountFactor = Math.pow(1 - discRate, bestDays);
  export const presentValue  = futureValue * discountFactor;

  return presentValue - currentP;
}

// Shadow price of a unit of a good in utility terms.
// This is the consumption/resale value only — productive value of inputs
// is handled separately in workSessionEV and flows through Pass 1 of the
// scheduler. Keeping these separate eliminates the double-count that caused
// "buy grain" to crowd out work itself.
export function shadowPriceGood(npc, good) {
  export const g = GOODS[good];
  export const lam = lambda(npc);
  export const marketPrice = expectedPrice(npc, good);
  export const prof = PROFESSIONS[npc.profession];

  // Speculative carry: if future expected price exceeds current price (net of
  // perish losses and time discounting), holding an extra unit is worth more
  // than selling today. This is what drives seasonal warehousing without any
  // hardcoded calendar schedule. A summer NPC values grain at its expected
  // winter resale price, not today's cheap summer price -- automatically.
  // Only applied when the NPC has savings headroom to actually warehouse.
  export const carry = speculativeCarryValue(npc, good);
  export const SAVINGS_RESERVE = 5;
  export const canSpeculate = npc.savings > SAVINGS_RESERVE * 3;
  export const sellNow   = marketPrice * lam;
  export const sellLater = canSpeculate ? (marketPrice + carry) * lam : 0;

  // ── Capital goods: value from future productivity boost ───────────────
  if (good === 'tools') {
    if (!prof?.capitalGood || prof.capitalGood !== 'tools') return Math.max(sellNow, sellLater);
    export const currentBoost     = 1 + Math.log1p(npc.inventory.tools ?? 0) * 0.2;
    export const newBoost         = 1 + Math.log1p((npc.inventory.tools ?? 0) + 1) * 0.2;
    export const productivityGain = newBoost - currentBoost;
    export const outputGood       = Object.keys(prof.outputs)[0];
    export const dailyGain        = prof.outputs[outputGood] * productivityGain * expectedPrice(npc, outputGood) * lam;
    export const discRate         = discountRate(npc);
    export const pv = dailyGain * (1 - Math.pow(1 - discRate, 120)) / discRate;
    return Math.max(pv, sellNow, sellLater);
  }

  // ── Any good that satisfies a need when consumed (food, comfort, or
  // whatever future need/good gets registered) ──────────────────────────
  // This single generic branch replaces what used to be separate,
  // near-duplicate "food goods" and "comfort goods" branches. Value is the
  // highest of: using it, selling now, or holding for a better season.
  // needMarginalUtility already spikes once the relevant need crosses its
  // own starvationFloor, and — for CRITICAL needs like food — that spike
  // also drives lambda up (see lambda() below), which raises sellNow for
  // every OTHER discretionary good at the same time. That's what makes a
  // starving artisan correctly prefer selling fine goods over self-
  // comforting: no hardcoded "if food urgent, override comfort" branch is
  // needed here anymore — it falls out of the same shadow-price math every
  // other good uses.
  export const effect = goodConsumptionEffect(good);
  if (effect) {
    export const useValue = needMarginalUtility(npc, effect.need) * effect.amount;
    return Math.max(useValue, sellNow, sellLater);
  }

  // ── Default: monetary resale value, plus carry for non-perishable storables ──
  // Wood has zero perishRate so carry value can be substantial in summer.
  return Math.max(sellNow, sellLater);
}

// Marginal utility of money for this NPC right now. This is the single
// bridge between every instrumental resource and terminal need
// satisfaction — every other shadow price ultimately routes through here.
export function lambda(npc) {
  // Use base values as a price floor when computing lambda.
  // Without this, stale near-zero prices cause lambda → ∞,
  // which inflates rest scores and collapses all economic activity.
  //
  // IMPORTANT: floors are anchored to marketAsk (the real price an NPC
  // pays to buy), not expectedPrice/midPrice. Using the mid-price here
  // was a structural bug: it calibrated "the cost of satisfying hunger"
  // below what bread actually costs to buy (ask is always ≥ mid, by
  // definition of the spread), so shadowPriceGood's useValue-vs-askPrice
  // comparison in planMarketVisit failed almost every time, by roughly
  // the spread's width — regardless of the stock-availability fix above.
  // Verified via harness trace: a stock-aware lambda alone made this
  // WORSE (500-day population dropped from 42 to 22) because grain's
  // stale, fictitiously-low mid-price used to accidentally inflate lambda
  // enough to paper over the mid/ask gap; fixing stock-awareness removed
  // that lucky accident and exposed the real defect underneath it.
  export const grainFloor = Math.max(marketAsk('grain'), GOODS.grain.baseValue * 0.25);
  export const breadFloor = Math.max(marketAsk('bread'), GOODS.bread.baseValue * 0.25);

  // Only treat a food good as part of "cheapest available food" if the
  // Market actually has stock of it right now. Previously this always
  // considered grain's price even when grain stock was 0 — a purely
  // theoretical price for food that couldn't actually be bought. That
  // understated the true cost of satisfying hunger whenever the cheap
  // option was out of stock, which in turn made the *real* available
  // option (bread) fail its own cost-clearing test in planMarketVisit by
  // a narrow margin, even for a starving NPC with money in hand — verified
  // via harness trace (Bram: food=0.075, bread in stock, bread shadow
  // value 122.5 vs. required 132.3, entirely because lambda was still
  // discounting against unavailable grain). If NOTHING is in stock, fall
  // back to the old theoretical floor rather than let lambda blow up —
  // a genuine full stockout should read as scarcity (see the stockout
  // finding from the market-visit fix), not an infinite money-value spike.
  export const grainInStock = (world.market.goods.grain?.stock ?? 0) >= 0.5;
  export const breadInStock = (world.market.goods.bread?.stock ?? 0) >= 0.5;
  export let cheapestFoodPrice;
  if (grainInStock || breadInStock) {
    cheapestFoodPrice = Math.min(
      grainInStock ? grainFloor / GOODS.grain.nutrition : Infinity,
      breadInStock ? breadFloor / GOODS.bread.nutrition : Infinity
    );
  } else {
    cheapestFoodPrice = Math.min(
      grainFloor / GOODS.grain.nutrition,
      breadFloor / GOODS.bread.nutrition
    );
  }

  export const foodMU = needMarginalUtility(npc, 'food');
  export let lam = foodMU / cheapestFoodPrice;

  // Via security: savings buffer
  export const secMU = needMarginalUtility(npc, 'security');
  lam += secMU / 30;

  // Hard cap: lambda can't exceed foodMU / (baseValue floor), preventing
  // runaway rest scores when prices temporarily collapse. This stays
  // pinned to the fixed theoretical floor (not the stock-aware
  // cheapestFoodPrice above) deliberately — it's an absolute ceiling
  // independent of current market conditions, so a stockout or price
  // spike can't also loosen the cap that's supposed to contain it. Scales
  // with foodMU itself, so the cap rises proportionally during a food
  // crisis rather than clipping the very spike that's supposed to
  // reorder priorities.
  export const lamCap = foodMU / (GOODS.grain.baseValue * 0.25 / GOODS.grain.nutrition);
  return Math.min(Math.max(lam, 0.01), lamCap);
}

// NPC's time preference — higher when desperate
export function discountRate(npc) {
  return 0.005 + (1 - npc.needs.food) * 0.04;
}

// Score an action in utility/hour
export function scoreAction(action, npc) {

  export const hist = world.market.goods[good]?.priceHistory;
  if (!hist || hist.length === 0) return expectedPrice(npc, good);
  export const recent = hist.slice(-days);
  return recent.reduce((s, h) => s + h.price, 0) / recent.length;
}

export function profSessionEV(npc, profId, ignoreAssetGate) {
  export const prof = PROFESSIONS[profId];
  if (!prof) return -Infinity;
  if (!ignoreAssetGate && !hasWorkableAsset(npc, profId)) return -Infinity;
  if (npc.energy < 20) return -Infinity;

  export const lam      = lambda(npc);
  export const skill    = effectiveSkill(npc, profId);
  export const capMod   = prof.capitalGood ? (1 + Math.log1p(npc.inventory.tools ?? 0) * 0.2) : 1;
  export const buildMod = buildingProductivity(profId);
  export const seasonal = profId === 'farmer' ? (SEASONAL_GRAIN[world.season] || 1) : 1;
  export const ENERGY_SHADOW = 0.05;

  export let revenue = 0;
  for (const [g, qty] of Object.entries(prof.outputs)) {
    revenue += qty * skill * capMod * buildMod * seasonal * smoothedExpectedPrice(npc, g);
  }

  export let inputCashCost = 0;
  for (const [g, qty] of Object.entries(prof.inputs)) {
    export const shortfall = Math.max(0, qty - (npc.inventory[g] ?? 0));
    inputCashCost += shortfall * marketAsk(g);
  }

  if (inputCashCost > npc.savings + 0.01) return -Infinity;

  export const netCoins = revenue - inputCashCost;
  return netCoins * lam - 25 * ENERGY_SHADOW - LABOR_DISUTILITY * 6;
}

// workSessionEV: returns { ev, profId } for the best available work today.
// Tries the NPC's primary profession first. If that's blocked (inputs
// unaffordable), falls back to no-input professions (farmer, woodcutter).
// A broke miller doesn't rest — they help with the harvest until they can
// afford grain again. The NPC keeps their profession identity; this is
// casual day-labour, not a switch.

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
