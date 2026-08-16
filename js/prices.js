import { GOODS, LABOR_DISUTILITY, PROFESSIONS, goodConsumptionEffect, needMarginalUtility } from './constants.js';
import { getAffinity, world } from './state.js';

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
  const unwrap = e => (typeof e === 'object' ? e.price : e);
  // The Market's posted price history is public — every NPC sees the same
  // record, so there's no need to blend in a separate personal memory of
  // prices the way the old peer-to-peer market required. (npc.memory.
  // priceHistory is still populated, kept for future info-access mechanics
  // — e.g. literacy or distance from the Market gating who gets timely
  // price news — but it currently just mirrors the public record.)
  const all = world.market.goods[good]?.priceHistory ?? [];

  const seasonal = all.filter(e => (typeof e === 'object' ? e.season : null) === targetSeason);
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
  const dayOfYear = (world.day + daysAhead) % 360;
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
  const g = GOODS[good];
  if (g.perishRate >= 0.5) return 0; // too perishable to warehouse profitably
  if (g.perishRate === 0 && g.nutrition === 0) return 0; // tools: handled separately

  const currentP = expectedPrice(npc, good);

  // Find the highest-price season the NPC knows about
  let bestSeasonPrice = currentP;
  let bestDays = 0;
  for (const season of SEASON_ORDER) {
    if (season === world.season) continue;
    const forecast = expectedSeasonalPrice(npc, good, season);
    if (forecast > bestSeasonPrice) {
      bestSeasonPrice = forecast;
      // Rough days until middle of that season
      const targetIdx = SEASON_ORDER.indexOf(season);
      const currentIdx = SEASON_ORDER.indexOf(world.season);
      const seasonsAway = ((targetIdx - currentIdx + 4) % 4);
      bestDays = seasonsAway * 90 + 45; // midpoint of that season
    }
  }

  if (bestDays === 0) return 0; // no better season found

  const survivalRate  = Math.pow(1 - g.perishRate, bestDays);
  const futureValue   = bestSeasonPrice * survivalRate;
  const discRate      = discountRate(npc);
  const discountFactor = Math.pow(1 - discRate, bestDays);
  const presentValue  = futureValue * discountFactor;

  return presentValue - currentP;
}

// Shadow price of a unit of a good in utility terms.
// This is the consumption/resale value only — productive value of inputs
// is handled separately in workSessionEV and flows through Pass 1 of the
// scheduler. Keeping these separate eliminates the double-count that caused
// "buy grain" to crowd out work itself.
export function shadowPriceGood(npc, good) {
  const g = GOODS[good];
  const lam = lambda(npc);
  const marketPrice = expectedPrice(npc, good);
  const prof = PROFESSIONS[npc.profession];

  // Speculative carry: if future expected price exceeds current price (net of
  // perish losses and time discounting), holding an extra unit is worth more
  // than selling today. This is what drives seasonal warehousing without any
  // hardcoded calendar schedule. A summer NPC values grain at its expected
  // winter resale price, not today's cheap summer price -- automatically.
  // Only applied when the NPC has savings headroom to actually warehouse.
  const carry = speculativeCarryValue(npc, good);
  const SAVINGS_RESERVE = 5;
  const canSpeculate = npc.savings > SAVINGS_RESERVE * 3;
  const sellNow   = marketPrice * lam;
  const sellLater = canSpeculate ? (marketPrice + carry) * lam : 0;

  // ── Capital goods: value from future productivity boost ───────────────
  if (good === 'tools') {
    if (!prof?.capitalGood || prof.capitalGood !== 'tools') return Math.max(sellNow, sellLater);
    const currentBoost     = 1 + Math.log1p(npc.inventory.tools ?? 0) * 0.2;
    const newBoost         = 1 + Math.log1p((npc.inventory.tools ?? 0) + 1) * 0.2;
    const productivityGain = newBoost - currentBoost;
    const outputGood       = Object.keys(prof.outputs)[0];
    const dailyGain        = prof.outputs[outputGood] * productivityGain * expectedPrice(npc, outputGood) * lam;
    const discRate         = discountRate(npc);
    const pv = dailyGain * (1 - Math.pow(1 - discRate, 120)) / discRate;
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
  const effect = goodConsumptionEffect(good);
  if (effect) {
    const useValue = needMarginalUtility(npc, effect.need) * effect.amount;
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
  const grainFloor = Math.max(marketAsk('grain'), GOODS.grain.baseValue * 0.25);
  const breadFloor = Math.max(marketAsk('bread'), GOODS.bread.baseValue * 0.25);

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
  const grainInStock = (world.market.goods.grain?.stock ?? 0) >= 0.5;
  const breadInStock = (world.market.goods.bread?.stock ?? 0) >= 0.5;
  let cheapestFoodPrice;
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

  const foodMU = needMarginalUtility(npc, 'food');
  let lam = foodMU / cheapestFoodPrice;

  // Via security: savings buffer
  const secMU = needMarginalUtility(npc, 'security');
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
  const lamCap = foodMU / (GOODS.grain.baseValue * 0.25 / GOODS.grain.nutrition);
  return Math.min(Math.max(lam, 0.01), lamCap);
}

// NPC's time preference — higher when desperate
export function discountRate(npc) {
  return 0.005 + (1 - npc.needs.food) * 0.04;
}

// Score an action in utility/hour
export function scoreAction(action, npc) {
  const lam = lambda(npc);

  // Some actions (asset sale listing, tinkering) carry their own
  // pre-computed NPV-based utility rather than decomposing into the
  // generic need/goods/money terms below — those actions set
  // _scoreOverride at construction time (see planAssetSaleActions,
  // planTinkerAction) since their value comes from a discounted future
  // payoff, not an immediate need/goods/money flow this function tracks.
  if (typeof action._scoreOverride === 'number') {
    return action._scoreOverride / action.duration;
  }

  let score = 0;

  // Need satisfaction effects — routed through the single generic
  // needMarginalUtility function so every need (existing or newly added
  // to the NEEDS registry) is weighed the same way, including the
  // starvation-cliff spike for critical needs.
  if (action.needEffects) {
    for (const [need, amount] of Object.entries(action.needEffects)) {
      score += needMarginalUtility(npc, need) * amount;
    }
  }

  // Goods produced
  if (action.goodsProduced) {
    for (const [good, qty] of Object.entries(action.goodsProduced)) {
      score += shadowPriceGood(npc, good) * qty;
    }
  }

  // Goods consumed (cost)
  // For sale actions, skip shadow-price deduction — the revenue is already
  // captured in moneyEarned. Deducting shadow price too would double-penalise
  // selling, especially for millers whose grain has high productive shadow price.
  if (action.goodsConsumed && !action.isSale) {
    for (const [good, qty] of Object.entries(action.goodsConsumed)) {
      score -= shadowPriceGood(npc, good) * qty;
    }
  }

  // Money flows
  if (action.moneyEarned)  score += action.moneyEarned * lam;
  if (action.moneyCost)    score -= action.moneyCost * lam;

  // Effect on a THIRD PARTY, discounted by affinity toward them — the one
  // new term relational mechanics needed. `help` gives money outright
  // (simplest first-pass model — cash is fungible and the recipient can
  // buy whatever they actually need at market themselves, so this
  // doesn't require modeling in-kind good transfer). Valued through the
  // RECIPIENT's own lambda — the same food/security-desperation-aware
  // marginal-utility-of-money function used everywhere else — multiplied
  // by the giver's affinity toward them. Positive affinity makes helping
  // a desperate friend score real value; zero or negative affinity makes
  // it score near-zero or negative even for a friend in genuine need — no
  // separate "would I help this person" branch required, it falls out of
  // this one multiplicative term same as every other action here.
  if (action.affinityTarget) {
    const { npcId, moneyGift } = action.affinityTarget;
    const target = world.npcs.get(npcId);
    if (target) {
      score += getAffinity(npc, npcId) * lambda(target) * moneyGift;
    }
  }

  // Explicit opportunity cost (see 'help' in getAvailableActions) —
  // already in the same utility-scaled units profSessionEV produces, so
  // this is a direct subtraction, not something requiring its own
  // lambda conversion.
  if (action.opportunityCost) score -= action.opportunityCost;

  // Energy cost/restore: fixed utility shadow, NOT tied to lambda.
  // Coupling to lambda causes rest to score infinitely high when prices
  // collapse (lambda → ∞), which locks everyone into permanent rest.
  // A point of energy is worth ~0.05 utility regardless of market prices —
  // calibrated so a well-fed NPC with average wages works ~8 hrs/day.
  const ENERGY_SHADOW = 0.05;
  if (action.energyCost)    score -= action.energyCost    * ENERGY_SHADOW;
  if (action.energyRestored) score += action.energyRestored * ENERGY_SHADOW;

  // Labor disutility
  if (action.isLabor) score -= LABOR_DISUTILITY * action.duration;

  // Generic flat utility cost, pre-scaled by the caller (e.g. duration).
  // Used for activities that cost effort but aren't full manual labor —
  // a market visit is tiring in a different, lighter way than farm work.
  if (action.disutility) score -= action.disutility;

  return score / action.duration; // utility per hour
}

