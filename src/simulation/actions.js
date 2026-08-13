import { world } from '../core/world.js';
import { GOODS, ASSET_TYPES, PROFESSIONS, BUILDING_PRODUCTIVITY } from '../config/constants.js';
import { shadowPriceGood } from '../economy/shadowPrices.js';
import { hasWorkableAsset, findStructureByAssetId, createStructure, createOwnedAsset, findFreeGridSpot, occupyGrid, buildingProductivity } from '../core/assets.js';
import { shouldKeepForConsumption, housingQuality } from '../core/needs.js';

export function scoreAction(action, npc) {
  export const lam = lambda(npc);

  // Some actions (asset sale listing, tinkering) carry their own
  // pre-computed NPV-based utility rather than decomposing into the
  // generic need/goods/money terms below — those actions set
  // _scoreOverride at construction time (see planAssetSaleActions,
  // planTinkerAction) since their value comes from a discounted future
  // payoff, not an immediate need/goods/money flow this function tracks.
  if (typeof action._scoreOverride === 'number') {
    return action._scoreOverride / action.duration;
  }

  export let score = 0;

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
    export const { npcId, moneyGift } = action.affinityTarget;
    export const target = world.npcs.get(npcId);
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
  export const ENERGY_SHADOW = 0.05;
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


  export const assetType = Object.keys(ASSET_TYPES).find(t => ASSET_TYPES[t].profession === profId);
  if (!assetType) return -999;
  export const def = ASSET_TYPES[assetType];

  // Value of working the asset once built — same math as computeProfessionEV,
  // just without the ownership gate (we're pricing the HYPOTHETICAL asset).
  export const savedProf = npc.profession;
  export let workingEV;
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
  export const lam = lambda(npc);
  export let buildCostValue = 0;
  for (const [g, qty] of Object.entries(def.buildCost)) {
    buildCostValue += qty * expectedPrice(npc, g);
  }
  export const amortizedCostPerSession = buildCostValue / SWITCH_PAYBACK_HORIZON;
  // Waiting buildDays before any payoff — a real opportunity cost, modeled
  // as a flat delay discount proportional to how long the build takes.
  export const delayDiscount = Math.max(0.3, 1 - def.buildDays / 120);

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
  export const existingInTrade = [...world.npcs.values()].filter(n =>
    n.profession === profId || (n.constructionProject && n.constructionProject.assetType === assetType)
  ).length;
  export const congestionDiscount = 1 / (1 + existingInTrade * existingInTrade * 0.15);

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
  export const def = ASSET_TYPES[assetType];
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
    export const have = npc.inventory[g] ?? 0;
    export const shortfall = Math.max(0, qty - have);
    if (shortfall > 0) {
      export const g_market = world.market.goods[g];
      export const cost = shortfall * g_market.askPrice;
      if (npc.savings < cost) return false;
      if (g_market.stock < shortfall) return false; // Market doesn't physically have enough either
    }
  }
  for (const [g, qty] of Object.entries(def.buildCost)) {
    export const have = npc.inventory[g] ?? 0;
    export const shortfall = Math.max(0, qty - have);
    if (shortfall > 0) {
      export const g_market = world.market.goods[g];
      export const cost = shortfall * g_market.askPrice;
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
  export const { assetType } = npc.constructionProject;
  export const { asset } = createOwnedAsset(assetType, npc.id, { gx: Math.round(npc.homeX / GRID_CELL), gy: Math.round(npc.homeY / GRID_CELL) });
  npc.ownedAssets.push(asset.id);
  export const profId = ASSET_TYPES[assetType].profession;
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
    export const s = findStructureByAssetId(asset.id);
    if (s) { npc.homeX = s.x; npc.homeY = s.y; }
  }
  logEvent(`${npc.name} completes construction of a new ${ASSET_TYPES[assetType].name.toLowerCase()}.`, [npc.id]);
  npc.constructionProject = null;
}



export function workSessionEV(npc) {
  // Try primary profession first
  export const primaryEV = profSessionEV(npc, npc.profession);
  if (isFinite(primaryEV)) return { ev: primaryEV, workAs: npc.profession };

  // Primary blocked — try fallback no-input professions
  export const fallbacks = Object.keys(PROFESSIONS).filter(pid => {
    export const p = PROFESSIONS[pid];
    return pid !== npc.profession &&
           Object.keys(p.inputs).length === 0 &&
           hasWorkableAsset(npc, pid);
  });

  export let bestEV = -Infinity, bestProf = null;
  for (const pid of fallbacks) {
    export const ev = profSessionEV(npc, pid);
    if (ev > bestEV) { bestEV = ev; bestProf = pid; }
  }

  if (bestProf && bestEV > -Infinity) return { ev: bestEV, workAs: bestProf };
  return { ev: -Infinity, workAs: null };
}

// ─────────────────────────────────────────────
// ACTION LIBRARY
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// MARKET VISIT PLANNING
// ─────────────────────────────────────────────
//
// Going to market is now a scheduled action, same tier as work/rest/
// socialize: it costs time and energy, and NPCs weigh it against
// everything else competing for their day. There are two distinct reasons
// to go:
//   1. To actually trade — realize the buy/sell gains the NPC already
//      wants (same deficit/surplus math the old always-on exchange used).
//      Duration scales with how much there is to trade: a quick errand
//      for one loaf of bread costs little time; hauling a season's
//      surplus grain to sell takes longer.
//   2. To haggle/linger purely for the dividend — the Market shares its
//      profits with whoever's actually there, weighted by time spent.
//      An NPC with nothing urgent to trade might still stop by (or an
//      NPC who came to trade might stay longer) if the going dividend
//      rate makes it worthwhile.
// An NPC who skips market entirely that day simply doesn't trade: no
// buying, no selling, surplus goods sit in inventory, deficits go unmet.
export const MARKET_BASE_TIME     = 1;    // walking there + minimal exchange, if there's anything to trade
export const MARKET_PER_UNIT_TIME = 0.08; // extra hours per unit bought/sold (haggling over quantity)
export const MARKET_MAX_HAGGLE    = 3;    // cap on purely dividend-seeking extra time
export const MARKET_ENERGY_PER_HOUR = 2;  // lighter than manual labor
export const MARKET_DISUTILITY_PER_HOUR = 1; // ditto — standing around is tiring, not backbreaking

export function planMarketVisit(npc) {

  export const lam = lambda(npc);
  export let sellQty = 0, buyQty = 0, sellRevenue = 0, buyCost = 0;
  export const goodsProduced = {}; // goods the NPC would acquire — scored, not executed here
  export const goodsConsumed = {}; // goods the NPC would sell away — scored, not executed here

  export const SAVINGS_RESERVE = 5;
  for (const good of Object.keys(GOODS)) {
    export const have    = npc.inventory[good] ?? 0;
    export const target  = getBufferTarget(npc, good);
    export const surplus = Math.max(0, have - target);
    if (surplus > 0.1) {
      sellQty += surplus;
      sellRevenue += surplus * marketBid(good);
      goodsConsumed[good] = surplus;
    }
  }

  // ── BUY side ──────────────────────────────────────────────────────────
  // Two real bugs used to live here, both invisible until you were
  // actually poor AND desperate at the same time (verified via harness:
  // Ulric, savings=$110, food=0.00 — should have been an easy bread buy):
  //
  // 1. All-or-nothing per good: the old code required clearing cost on
  //    the FULL buffer target (survival minimum + discretionary security/
  //    speculative padding all bundled together) before buying ANY of it.
  //    Mathematically that's equivalent to a per-unit test (both sides
  //    scale linearly with deficit), so it wasn't wrong about whether
  //    bread was worth buying — but it meant "worth buying at all" and
  //    "buy the entire padded target" were forced to be the same
  //    decision. A target inflated by security buffer could tip a
  //    genuinely-worth-buying-SOME bread deficit into a fails-to-clear
  //    verdict, when 1 unit — the actual survival-critical amount —
  //    would have cleared easily.
  // 2. No stock or shared-budget awareness: this function planned
  //    purchases with zero knowledge of what the Market actually had on
  //    the shelf or how many OTHER goods it was simultaneously planning
  //    to buy. Ulric's plan promised 2.8 units of bread — the Market had
  //    zero in stock, so execution silently delivered nothing — while
  //    happily allocating the *entire* $110 to a discretionary tools
  //    purchase that, alone, cleared its own cost. Nothing here was
  //    stopping a starving NPC from spending their whole reserve on
  //    tools; food just lost by having no goods to actually claim.
  //
  // Fix: figure out which deficits are worth buying at all (unchanged
  // per-unit-equivalent test), then allocate a SINGLE shared budget
  // across all of them greedily, richest marginal-value-per-coin first,
  // capped by both Market stock and remaining budget. This is the same
  // logic runMarketExchange already uses per-good at execution time
  // (Math.min(deficit, affordableQty, stockRoom)) — planning now mirrors
  // it instead of promising a fantasy cart.
  export const candidates = [];
  for (const good of Object.keys(GOODS)) {
    export const have    = npc.inventory[good] ?? 0;
    export const target  = getBufferTarget(npc, good);
    export const deficit = Math.max(0, target - have);
    if (deficit <= 0.1) continue;
    export const perUnitValue = shadowPriceGood(npc, good);
    export const askPrice = Math.max(marketAsk(good), 0.01);
    if (perUnitValue <= askPrice * lam) continue; // not worth buying at any quantity
    export const stockAvailable = Math.max(0, world.market.goods[good]?.stock ?? 0);
    if (stockAvailable < 0.1) continue; // nothing to buy regardless of money
    candidates.push({ good, deficit, askPrice, stockAvailable, valuePerCoin: perUnitValue / askPrice });
  }
  candidates.sort((a, b) => b.valuePerCoin - a.valuePerCoin);

  export const spendableSavings = npc.needs.food < 0.2
    ? npc.savings
    : Math.max(0, npc.savings - SAVINGS_RESERVE);
  export let budget = spendableSavings + sellRevenue; // same-visit sale proceeds are spendable too

  for (const c of candidates) {
    if (budget < 0.5) break;
    export const affordableQty = budget / c.askPrice;
    export const qty = Math.min(c.deficit, c.stockAvailable, affordableQty);
    if (qty <= 0.05) continue;
    export const cost = qty * c.askPrice;
    buyQty += qty;
    buyCost += cost;
    budget -= cost;
    goodsProduced[c.good] = qty;
  }

  export const totalQty = sellQty + buyQty;
  export let duration = totalQty > 0.1 ? MARKET_BASE_TIME + totalQty * MARKET_PER_UNIT_TIME : 0;

  // Haggling: is lingering longer worth it at the going dividend rate?
  export const dividendUtilPerHour = (world.market.lastDividendPerVisitHour ?? 0) * lam;
  export const marketCostPerHour   = MARKET_DISUTILITY_PER_HOUR + MARKET_ENERGY_PER_HOUR * 0.05;
  export const haggleWorthwhile    = dividendUtilPerHour > marketCostPerHour;

  if (duration < 0.1 && !haggleWorthwhile) return null; // nothing to do at market today
  if (duration < 0.1) duration = MARKET_BASE_TIME;       // still have to walk there to haggle
  if (haggleWorthwhile) duration += MARKET_MAX_HAGGLE;

  return {
    id: 'market', label: 'Go to Market',
    duration,
    energyCost: duration * MARKET_ENERGY_PER_HOUR,
    disutility: duration * MARKET_DISUTILITY_PER_HOUR,
    needEffects: { social: Math.min(0.1, 0.03 * duration) }, // the agora is a social space too
    goodsProduced, goodsConsumed, isSale: true,
    moneyEarned: sellRevenue, moneyCost: buyCost,
  };
}

// ─────────────────────────────────────────────
// CHURCH VISIT PLANNING
// ─────────────────────────────────────────────
//
// The Church is modeled the same way as the Market: an institution with
// its own state, visited via a scheduled action that competes for time
// against work/market/rest/socialize. Two flows, kept separate:
//   - Tithes IN, from attendees, scaled to wealth (a fraction of savings,
//     capped) — the rich give more, the poor give near nothing, and
//     everyone is still welcome regardless of what they can afford.
//   - Alms OUT, to the neediest in the village generally (not gated on
//     attendance — see distributeChurchAlms). Charity reaches people who
//     may not be able to spare the time to attend, same as it would in
//     the world this game is modeling.
// Meaning is deliberately hard to satisfy any other way right now (see
// the rebalanced rest/socialize below) — church attendance is the
// dominant source, by design.
export const CHURCH_DURATION = 2;
export const CHURCH_ENERGY   = 3;
export const TITHE_RATE = 0.06;  // fraction of savings tithed per visit
export const TITHE_CAP  = 15;    // ceiling so a single very rich NPC can't be taxed absurdly in one sitting

export function planChurchVisit(npc) {
  export const tithe = Math.min(Math.max(0, npc.savings) * TITHE_RATE, TITHE_CAP);
  return {
    id: 'church', label: 'Attend Church',
    duration: CHURCH_DURATION,
    energyCost: CHURCH_ENERGY,
    needEffects: { meaning: 0.35, social: 0.08 },
    moneyCost: tithe,
  };
}


// ─────────────────────────────────────────────
// ASSET SALE & SELF-TEACHING ACTIONS
// ─────────────────────────────────────────────
//
// Both actions are scored the same way as every other candidate action in
// getAvailableActions/scoreAction — no special-cased triggers. This means
// they compete honestly against resting, socializing, working, etc., and
// their attractiveness responds correctly once later stages (labor market,
// auctions) supply real numbers for the currently-placeholder terms below.

// Estimated auction value of an asset: naive Stage-1 placeholder using the
// present value of the profession's steady-state daily profit, discounted
// over a fixed horizon. Once Stage 4 (real auctions) exists, actual clearing
// prices should replace this estimate for NPCs who've observed one.
export const ASSET_VALUE_HORIZON = 180; // days of future profit an asset's price roughly reflects
export function estimateAssetValue(npc, asset) {

  export const def = ASSET_TYPES[asset.type];
  if (!def) return 0;
  export const profId = def.profession;
  // Steady-state EV assumes full skill — mirrors computeProfessionEV's
  // hypothetical-swap trick, since we want "what would this be worth to
  // a competent operator," not this NPC's own (possibly zero) skill.
  // Also temporarily swaps asset.ownerId to npc.id: hasWorkableAsset()
  // (called inside profSessionEV) requires ownership match, and this NPC
  // may not actually own the asset yet (e.g. a seller valuing an asset
  // they're about to list still owns it — fine — but this same function
  // is also called for OTHER npcs during auctions/comparisons, where it
  // must reflect "if I owned and fully mastered this," not fail silently.
  export const savedProf = npc.profession, savedSkill = npc.skills[profId], savedPrimary = npc.primaryAsset, savedOwner = asset.ownerId;
  export let dailyEV;
  try {
    npc.profession = profId;
    npc.skills[profId] = 1.0; // hypothetical competent operator
    npc.primaryAsset = asset.id; asset.ownerId = npc.id;
    dailyEV = profSessionEV(npc, profId);
  } finally {
    // FIX: try/finally guarantees this restore ALWAYS runs, even if
    // profSessionEV (or anything it calls) throws. Without this, an
    // exception mid-hypothetical-swap permanently corrupted primaryAsset/
    // ownerId/profession/skills — the actual root cause traced behind the
    // starvation crisis: NPCs ended up with primaryAsset pointing at
    // assets they didn't even own, silently locking them out of real
    // capacity they legitimately held.
    npc.profession = savedProf; npc.skills[profId] = savedSkill; npc.primaryAsset = savedPrimary; asset.ownerId = savedOwner;
  }
  if (!isFinite(dailyEV) || dailyEV <= 0) return def.buildCost ? Object.values(def.buildCost).reduce((s,q)=>s+q,0) * 2 : 10;
  export const discRate = discountRate(npc);
  export const pv = dailyEV * (1 - Math.pow(1 - discRate, ASSET_VALUE_HORIZON)) / discRate;
  return Math.max(pv * asset.quality, 1);
}

// Value of *holding* an idle (unstaffed) asset rather than selling it.
// Zero until the labor market (Stage 2) exists to let an owner hire staff
// and collect rental-style profit from an asset they don't personally work.
// Written as its own function (not inlined) so Stage 2 can replace this one
// spot without touching the scoring logic around it.
export function assetHoldValue(npc, asset) {
  return 0; // placeholder — Stage 2 hire-out income goes here
}

// An NPC freely considers selling any asset that ISN'T their primary
// (currently-worked) one — an asset sitting idle because they've switched
// professions, inherited a spare, or otherwise aren't operating it. This
// pool has NO starvation requirement: shedding a surplus asset is treated
// as an ordinary financial decision.
// A newly-acquired (or newly-idled) asset gets a real grace period before
// its owner will even consider selling it — a genuine villager doesn't
// flip an asset the instant it's not their main trade; they hold onto it
// for a while, hoping to staff it, switch back into it, or pass it to
// family. Without this, EVERY asset that becomes non-primary (via a
// profession switch, or right after being won at auction while the buyer
// still primarily works something else) was instantly re-listable with
// only a flat, easily-outweighed disutility as friction — confirmed via
// testing to produce a uniform, unrealistic churn of 8-21 resales per
// asset over 1000 days across ALL assets, not just a few problem cases.
export const IDLE_ASSET_GRACE_DAYS = 60;

export function getIdleAssets(npc) {
  return npc.ownedAssets
    .map(id => world.assets.get(id))
    .filter(a => {
      if (!a || a.forSale || a.id === npc.primaryAsset || a.id === npc.primaryHouse) return false;
      a.idleSinceDay = a.idleSinceDay ?? world.day;
      return (world.day - a.idleSinceDay) >= IDLE_ASSET_GRACE_DAYS;
    });
}

// ── Distress-sale asymmetry ─────────────────────────────────────────────
// A starving NPC doesn't sell their primary (currently-worked, livelihood)
// asset at the first bad day — "you don't sell the farm as soon as bad
// times hit." But sustained starvation eventually forces the issue. The
// threshold is asymmetric based on how many OTHER assets the NPC still
// has to fall back on:
//   - If this is their ONLY asset, they hold out much longer (it's the
//     difference between wage labor and self-sufficiency).
//   - If they have other assets (or none at all is moot — no primary to
//     sell), a shorter starvation streak is enough, since losing this
//     one asset doesn't mean total ruin.
// starvingStreak lives on the asset record itself (not the NPC) so it
// naturally resets/restarts correctly across ownership changes.
export const DISTRESS_STARVING_DAYS_LAST_ASSET = 35;
export const DISTRESS_STARVING_DAYS_SURPLUS    = 8;

export function updateAssetDistressStreaks(npc) {
  if (npc.primaryAsset === null || npc.primaryAsset === undefined) return;
  export const asset = world.assets.get(npc.primaryAsset);
  if (!asset || asset.ownerId !== npc.id) return;
  export const isStarving = npc.needs.food < STARVING_FOOD_THRESHOLD;
  asset.starvingStreak = isStarving ? (asset.starvingStreak + 1) : 0;
}

// Returns the primary asset as a distress-sale candidate ONLY once the
// owner has been starving long enough, per the asymmetric thresholds
// above. Returns null otherwise (primary assets are never freely listed
// the way idle ones are — this is the sole path to selling one's
// livelihood asset).
export function getDistressPrimaryAsset(npc) {
  if (npc.primaryAsset === null || npc.primaryAsset === undefined) return null;
  export const asset = world.assets.get(npc.primaryAsset);
  if (!asset || asset.forSale) return null;
  export const isLastAsset = npc.ownedAssets.length <= 1;
  export const threshold = isLastAsset ? DISTRESS_STARVING_DAYS_LAST_ASSET : DISTRESS_STARVING_DAYS_SURPLUS;
  return asset.starvingStreak >= threshold ? asset : null;
}

// Adds a "list for sale" action per idle asset. Scored like everything
// else: sellValue (converted through lambda, same convention as every
// other money-flow in scoreAction) vs. holdValue (0 for now). A small
// flat disutility models the friction/reluctance of actually parting with
// property, distinct from pure financial calculation.
export const ASSET_SALE_DISUTILITY = 3;
// A distress sale of one's PRIMARY asset carries much higher disutility
// than shedding a surplus one — this is a last-resort, emotionally costly
// act (loss of livelihood/identity), not a routine portfolio decision.
// It still gets scored, not forced, but the bar is set high on purpose:
// only genuine, sustained desperation (see getDistressPrimaryAsset's
// starvingStreak gate) should make this option even appear.
export const DISTRESS_SALE_DISUTILITY = 15;
// Flat relief value (in coin-equivalent units, same convention as
// everything else scored through lambda) for taking a recovered asset
// back off the market — deliberately small and simple: this isn't a
// financial recalculation, just a thumb on the scale so a recovered NPC
// doesn't leave a listing sitting out of pure inertia once the crisis
// that justified it has passed.
export const DELIST_RELIEF_BONUS = 5;

export function planAssetSaleActions(npc) {
  export const actions = [];
  export const lam = lambda(npc);

  for (const asset of getIdleAssets(npc)) {
    export const sellValue = estimateAssetValue(npc, asset);
    export const holdValue = assetHoldValue(npc, asset);
    actions.push({
      id: 'list-asset-sale', assetId: asset.id,
      label: `List ${ASSET_TYPES[asset.type].name} for sale`,
      duration: 0.5, // a quick errand — post notice, doesn't consume the whole day
      disutility: ASSET_SALE_DISUTILITY,
      // Not paid immediately (that happens at auction settlement) — scored
      // here as the expected value so the *decision* to list weighs
      // correctly against holding, even though listing itself moneyEarned=0.
      needEffects: {},
      _scoreOverride: (sellValue - holdValue) * lam - ASSET_SALE_DISUTILITY,
    });
  }

  // Distress sale of the primary asset — only offered once starvingStreak
  // clears the (asymmetric) threshold in getDistressPrimaryAsset. Valued
  // the same way, but the money from selling now competes directly against
  // the value of the food it can buy — which, for a starving NPC, is
  // enormous (lambda is already very high when npc.needs.food is low, so
  // sellValue * lam naturally dominates once things are dire enough).
  // NOTE: the owner keeps working this asset while it's listed (see the
  // FIX in executeSchedule's list-asset-sale handler) — listing is no
  // longer an immediate abandonment, just a parallel "for sale" flag.
  export const distressAsset = getDistressPrimaryAsset(npc);
  if (distressAsset) {
    export const sellValue = estimateAssetValue(npc, distressAsset);
    actions.push({
      id: 'list-asset-sale', assetId: distressAsset.id,
      label: `Sell ${ASSET_TYPES[distressAsset.type].name} (last resort)`,
      duration: 0.5,
      disutility: DISTRESS_SALE_DISUTILITY,
      needEffects: {},
      _scoreOverride: sellValue * lam - DISTRESS_SALE_DISUTILITY,
    });
  }

  // NEW: delisting. If the primary asset is currently listed but the
  // owner's situation has since improved — starvingStreak has reset well
  // below the distress threshold, meaning the crisis that justified
  // selling has passed — offer the option to pull it off the market
  // before a stranger's bid takes it from them. Scored against continuing
  // to hold it listed: since holding costs nothing extra and removes the
  // (small but real) risk of losing the asset to an auction they no
  // longer want to go through with, this is usually strictly better once
  // things have stabilized, and the scoring reflects that via a flat
  // relief bonus rather than a full financial reappraisal.
  if (npc.primaryAsset !== null && npc.primaryAsset !== undefined) {
    export const primary = world.assets.get(npc.primaryAsset);
    if (primary && primary.forSale && primary.ownerId === npc.id) {
      export const recovered = primary.starvingStreak <= DISTRESS_STARVING_DAYS_SURPLUS * 0.3;
      if (recovered) {
        actions.push({
          id: 'delist-asset-sale', assetId: primary.id,
          label: `Take ${ASSET_TYPES[primary.type].name} off the market`,
          duration: 0.5,
          disutility: 0,
          needEffects: {},
          _scoreOverride: DELIST_RELIEF_BONUS * lam,
        });
      }
    }
  }

  return actions;
}

// ── Self-teaching (tinkering) ──────────────────────────────────────────
// A slow, unguided path to learning an asset-gated skill with no master
// and no training fee. Requires physical access to a matching asset the
// NPC owns (their primaryAsset, or an idle one they could tinker with
// even if it's not their main livelihood). Produces zero marketable
// output — pure skill investment, same NPV-discounting idea as
// speculativeCarryValue and estimateAssetValue above, but the "future
// value" is skill-driven daily profit instead of a stored good's resale
// price.
export const TINKER_HOURS = 2;
export const TINKER_LEARNING_RATE = 0.0025; // ~1/5th the formal apprenticeship's implied daily rate
export const TINKER_SKILL_CEILING = 0.5;    // self-teaching alone caps out well below what a master can impart;
                                       // formal training (trainingDays ramp) is still needed to fully master a trade
export function planTinkerAction(npc) {
  // Which asset-gated professions does this NPC have physical access to
  // but meaningfully lack skill in? Check owned assets (primary or idle) —
  // you can tinker with any forge you own, not just the one you work.
  export const candidates = npc.ownedAssets
    .map(id => world.assets.get(id))
    .filter(a => a)
    .map(a => ({ asset: a, profId: ASSET_TYPES[a.type].profession }))
    .filter(({ profId }) => (npc.skills[profId] ?? 0) < TINKER_SKILL_CEILING);

  if (candidates.length === 0) return null;
  // Tinker on whichever candidate profession currently has the best EV
  // ceiling — an NPC with both an idle mill and an idle forge picks
  // whichever a competent operator would find more profitable, using the
  // same steady-state hypothetical swap as estimateAssetValue.
  export let best = null, bestEV = -Infinity;
  for (const c of candidates) {
    // Hypothetically swap profession, skill, AND primaryAsset so
    // hasWorkableAsset() (called inside profSessionEV) correctly sees this
    // NPC as operating the candidate asset — otherwise the gate always
    // fails since primaryAsset wouldn't actually point at it yet.
    export const savedProf = npc.profession, savedSkill = npc.skills[c.profId], savedPrimary = npc.primaryAsset;
    export let ev;
    try {
      npc.profession = c.profId; npc.skills[c.profId] = 1.0; npc.primaryAsset = c.asset.id;
      ev = profSessionEV(npc, c.profId);
    } finally {
      // FIX: same try/finally guarantee — a thrown exception here used to
      // leave primaryAsset pointing at a candidate asset this NPC doesn't
      // actually own, for the rest of the simulation.
      npc.profession = savedProf; npc.skills[c.profId] = savedSkill; npc.primaryAsset = savedPrimary;
    }
    if (isFinite(ev) && ev > bestEV) { bestEV = ev; best = c; }
  }
  if (!best || bestEV <= 0) return null;

  export const currentSkill = npc.skills[best.profId] ?? 0;
  export const discRate = discountRate(npc);
  // Present value of the skill gained today: it raises future daily EV by
  // a small increment for the rest of an assumed working horizon, same
  // discounting machinery as estimateAssetValue.
  export const skillGainFrac = TINKER_LEARNING_RATE * (1 - currentSkill / TINKER_SKILL_CEILING);
  export const dailyEVGain = bestEV * skillGainFrac;
  export const pv = dailyEVGain * (1 - Math.pow(1 - discRate, ASSET_VALUE_HORIZON)) / discRate;

  return {
    id: 'tinker', label: `Tinker (${PROFESSIONS[best.profId].name})`, profId: best.profId,
    duration: TINKER_HOURS,
    energyCost: TINKER_HOURS * 3,
    disutility: TINKER_HOURS * 1.5,
    _scoreOverride: pv * lambda(npc) - TINKER_HOURS * 1.5,
    _skillGainFrac: skillGainFrac,
  };
}

// Construction now costs real, scheduled, executed labor, not just a
// calendar countdown after paying the materials (see startConstruction/
// executeSchedule) — a farm doesn't finish itself just because 15 days
// went by; someone has to actually show up and work on it, competing for
// time against everything else in buildDayCandidates like any other
// action. This mirrors planTinkerAction almost exactly: both are cases
// where the "output" is a future capability (a finished building; a
// learned skill) rather than an immediate goods/money flow, so both value
// themselves via a discounted share of the future payoff rather than the
// generic need/goods/money terms in scoreAction.
// Utility value of ONE DAY of full shelter vs the homeless penalty —
// the house equivalent of profSessionEV's income valuation, except the
// "revenue" here is comfort/social/meaning trickle instead of coins.
// Matches the magnitudes rest's needEffects actually produce (see
// getAvailableActions' 'rest' action), scaled by the gap a house closes,
// each valued at ITS need's current marginal utility — same "value
// depends on current need level" principle as every other action.
// Scales housing urgency (1 - housingQuality) into a session score
// commensurate with a normal work session's ~25-utility overhead (energy
// cost + labor disutility) — see planConstructionAction's house branch.
export const HOUSE_CONSTRUCTION_URGENCY_SCALE = 90;

export function housingDailyValue(npc) {
  export const gap = 1 - HOMELESS_REST_PENALTY;
  export const muComfort = needMarginalUtility(npc, 'comfort');
  export const muSocial  = needMarginalUtility(npc, 'social');
  export const muMeaning = needMarginalUtility(npc, 'meaning');
  return gap * (muComfort * 0.02 + muSocial * 0.02 + muMeaning * 0.01);
}

// Should this NPC start building a house? Only relevant when they don't
// already have one (primaryHouse null) — spare/investment houses are a
// separate, purely economic decision already covered by the ordinary
// idle-asset-sale path once houses have a resale market. Deliberately a
// simple affordability gate rather than an EV comparison against
// profession-construction (income-denominated EVs and a house's
// need-utility value aren't on commensurate scales) — going homeless is
// clearly bad, and once affordable there's no real tradeoff to weigh.
export function considerHouseConstruction(npc) {
  // A moved-in spouse has primaryHouse === null by design (marryCouple
  // consolidates the couple into one household — see housingQuality,
  // which already correctly treats this as fully housed, quality 1.0).
  // This gate used to check the raw primaryHouse field directly, which
  // disagreed with that: every moved-in spouse with savings above the
  // affordability threshold was independently starting to build their
  // OWN redundant second house, since nothing here recognized they
  // already lived with their partner. Verified via harness trace: exactly
  // half the starting population (24/48) lost primaryHouse on the very
  // first tick as early marriages resolved, and this gate then read every
  // one of them as homeless — a one-time phantom demand for ~360 wood
  // (24 houses x 15 wood) against a village that could only produce a
  // fraction of that per day. That spike sent wood's price 3-5x above
  // grain's within ~10 days, which was the actual trigger for farmers
  // abandoning farming en masse before any real famine existed yet.
  if (housingQuality(npc) === 1.0) return;
  if (npc.constructionProject) return;
  export const def = ASSET_TYPES.house;
  export let buildCostValue = 0;
  for (const [g, qty] of Object.entries(def.buildCost)) buildCostValue += qty * expectedPrice(npc, g);
  if (npc.savings > buildCostValue * 1.5) startConstruction(npc, 'house');
}

export function planConstructionAction(npc) {
  export const proj = npc.constructionProject;
  if (!proj) return null;
  export const hoursRemaining = proj.laborHoursNeeded - proj.laborHoursDone;
  if (hoursRemaining <= 0.01) return null;

  export const def = ASSET_TYPES[proj.assetType];
  export const profId = def.profession;
  export const sessionHours = Math.min(6, hoursRemaining);
  export const energyCost = 25 * (sessionHours / 6);

  if (!profId && proj.assetType === 'house') {
    // Houses have no income/profession. Routing their need-derived
    // utility value (housingDailyValue, order ~0.1-1) through the same
    // PV/per-hour-amortization machinery as income-generating professions
    // produced numbers 1-2 orders of magnitude too small to ever clear a
    // single session's fixed energy/labor-disutility cost (~25) — verified
    // via the headless harness: net session score came out negative from
    // hour one, so a "started" house construction project NEVER actually
    // advanced. That's the actual cause of the homelessness problem, not
    // a scheduling issue. Scored directly instead, by shelter urgency
    // (the comfort/social/meaning gap being homeless creates), scaled up
    // to be commensurate with what a normal work session has to clear —
    // a homeless NPC (housingQuality ~0.45) gets urgency ~0.55*90=49.5,
    // comfortably beating the ~25 session overhead.
    export const urgency = (1 - housingQuality(npc)) * HOUSE_CONSTRUCTION_URGENCY_SCALE;
    return {
      id: 'build', label: `Build ${def.name}`,
      duration: sessionHours, isLabor: true, energyCost,
      _constructionHours: sessionHours,
      _scoreOverride: urgency - energyCost * 0.05 - LABOR_DISUTILITY * sessionHours,
    };
  }

  // Value of running the FINISHED asset — same hypothetical-swap
  // technique computeConstructionEV used to decide whether to start this
  // project in the first place.
  export const savedProf = npc.profession;
  export let workingEV;
  try {
    npc.profession = profId;
    workingEV = profSessionEV(npc, profId, /*ignoreAssetGate=*/true);
  } finally {
    npc.profession = savedProf;
  }
  if (!isFinite(workingEV)) workingEV = 0;

  // Discounted present value of that (per-session) income stream once
  // complete — same horizon/discounting machinery as estimateAssetValue
  // and planTinkerAction, so a half-built mill is valued the same
  // principled way as a half-trained skill or an already-owned asset.
  // workingEV is already a utility value (profSessionEV bakes lambda in
  // internally), so pv comes out in utility units directly, no separate
  // multiply-by-lambda step needed here.
  export const discRate = discountRate(npc);
  export const pv = Math.max(0, workingEV) * (1 - Math.pow(1 - discRate, ASSET_VALUE_HORIZON)) / discRate;

  // Spread that value evenly across every hour of labor the project
  // needs — the 400th hour of building a mill isn't worth less than the
  // 1st, they're equally necessary to ever reach completion.
  export const perHourUtility = pv / proj.laborHoursNeeded;

  return {
    id: 'build', label: `Build ${def.name}`,
    duration: sessionHours,
    isLabor: true,
    energyCost,
    _constructionHours: sessionHours,
    _scoreOverride: perHourUtility * sessionHours - energyCost * 0.05 - LABOR_DISUTILITY * sessionHours,
  };
}


export function getAvailableActions(npc) {
  export const actions = [];
  export const prof = PROFESSIONS[npc.profession];

  // Work and hired labor are scored directly in buildDayCandidates, not
  // here — see the WEEKLY PLANNER section above.

  // --- GO TO MARKET (if there's anything to trade or haggle for) ---
  export const marketVisit = planMarketVisit(npc);
  if (marketVisit) actions.push(marketVisit);

  // --- ATTEND CHURCH (always available — the poor are welcome too) ---
  actions.push(planChurchVisit(npc));

  // --- LIST IDLE ASSETS FOR SALE (Stage 1.5: scored, not automatic) ---
  actions.push(...planAssetSaleActions(npc));

  // --- TINKER (self-teach an asset-gated skill, slowly, without a master) ---
  export const tinkerAction = planTinkerAction(npc);
  if (tinkerAction) actions.push(tinkerAction);

  // --- BUILD (labor toward an in-progress construction project) ---
  export const constructionAction = planConstructionAction(npc);
  if (constructionAction) actions.push(constructionAction);

  // --- REST ---
  // A little comfort and meaning trickle in even from resting at home —
  // but nowhere near what fine goods (comfort) or church (meaning)
  // provide. Most of an NPC's rest/comfort/meaning needs should be met
  // through the goods and institutions built for that purpose, not as a
  // free byproduct of doing nothing.
  actions.push({
    id: 'rest', label: 'Rest',
    duration: 2,
    energyRestored: 30 * housingQuality(npc),
    needEffects: { social: 0.02 * housingQuality(npc), comfort: 0.02 * housingQuality(npc), meaning: 0.01 * housingQuality(npc) },
  });

  // --- SOCIALIZE (if energy allows) ---
  if (npc.energy > 40) {
    actions.push({
      id: 'socialize', label: 'Socialize',
      duration: 1.5,
      energyCost: 5,
      needEffects: { social: 0.15 },
    });
  }

  // --- SEEK MARRIAGE (unmarried adults) ---
  // Scoring the ACT of seeking, not an instant marriage — actually
  // pairing off still requires a mutual match (see runMarriageMarket),
  // since one side's high score isn't consent from the other.
  if (npc.spouseId == null) {
    actions.push({
      id: 'seek_marriage', label: 'Seek marriage',
      duration: 1, energyCost: 5,
      needEffects: {},
      _scoreOverride: marriageUtilityGain(npc) + MARRIAGE_DRIVE_BONUS,
    });
  }

  // --- TRY FOR A CHILD (married couples only) ---
  // Only the lower-id partner in a couple ever sees this action, so a
  // married pair can't independently both "decide" the same day and
  // double-spawn — a simplification consistent with family staying a
  // loose, non-jointly-optimized institution for now (see design notes).
  if (npc.spouseId != null && npc.id < npc.spouseId) {
    export const spouse = world.npcs.get(npc.spouseId);
    if (spouse && npc.childIds.length < MAX_CHILDREN_PER_COUPLE &&
        npc.energy > 40 && spouse.energy > 40 &&
        npc.needs.food > 0.5 && spouse.needs.food > 0.5 &&
        npc.age < CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS &&
        spouse.age < CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS &&
        (world.day - npc.lastChildbirthDay) >= MIN_BIRTH_SPACING_DAYS &&
        (world.day - spouse.lastChildbirthDay) >= MIN_BIRTH_SPACING_DAYS &&
        (npc.savings + spouse.savings) > CHILDBIRTH_MATERIAL_COST * 3) {
      export const gain = childbirthUtilityGain(npc) + childbirthUtilityGain(spouse) + CHILDBIRTH_DRIVE_BONUS;
      actions.push({
        id: 'seek_child', label: 'Try for a child',
        duration: 1, energyCost: 10,
        needEffects: {},
        _scoreOverride: gain - CHILDBIRTH_UTILITY_COST,
      });
    }
  }

  // --- ASK FOR HELP (targeted, not broadcast) ---
  // Only proposed to a top handful of contacts NPC already has SOME
  // positive affinity for — asking a stranger or someone you dislike
  // isn't a real candidate action, so this stays cheap (bounded by each
  // NPC's own sparse relations map, not the village). Gated behind a
  // real distress signal (food<0.3) so this isn't a background option
  // every day, and against already having an unresolved ask out (no
  // spamming every contact at once — see the targeted-not-broadcast
  // design discussion).
  export const hasOpenAsk = world.helpRequests.some(r => r.requesterId === npc.id);
  // Gated at NEEDS.food.starvationFloor specifically, not an earlier soft
  // threshold — lambda (see lambda()) only spikes above its baseline
  // (~6-8 for nearly everyone, rich or poor, since foodMU=weight/(1+level)
  // never truly reaches zero) once food crosses the starvationFloor's
  // severity multiplier. Triggering earlier meant requesters were asking
  // before their own desperation was actually reflected in the shared
  // lambda math those asks get judged by — the honest predicted/actual
  // score came out negative even for a genuinely fond contact, not
  // because affinity was too weak but because the ask fired too early to
  // be economically real yet. Verified via harness trace: at food=1.00
  // (fully fed) a target's OWN lambda already sits at 6.84 baseline, so
  // a 0.47-affinity ask netted -87 — the requester wasn't meaningfully
  // more desperate than the person being asked to help them.
  if (npc.needs.food < NEEDS.food.starvationFloor && !hasOpenAsk) {
    export const candidates = [...npc.relations.entries()]
      .filter(([, rec]) => rec.affinity > 0)
      .sort((a, b) => b[1].affinity - a[1].affinity)
      .slice(0, 3);
    export const amount = 3 * marketAsk('bread'); // a few days' worth — first-pass constant, worth tuning
    for (const [targetId] of candidates) {
      export const target = world.npcs.get(targetId);
      if (!target) continue;
      // Predict the target's own answer using the SAME formula their
      // 'help' action will actually be scored with (see scoreAction's
      // affinityTarget term) — an honest guess, not an oracle. Falls out
      // naturally that asking a poor contact predicts badly: their own
      // lambda (cost of parting with money) is high when they have
      // little, without any explicit "don't ask poor people" rule.
      export const predictedTargetScore = getAffinity(target, npc.id) * lambda(npc) * amount - lambda(target) * amount;
      export const successProb = clamp(0.5 + predictedTargetScore * 0.05, 0.05, 0.95);
      // Prestige cost scales with how large the ask is — asking for a
      // little is a small admission; asking for a lot is a visible one.
      export const prestigeCost = clamp(amount / 50, 0.02, 0.15);
      actions.push({
        id: 'ask_help', label: `Ask ${target.name} for help`,
        duration: 1, energyCost: 3,
        needEffects: { prestige: -prestigeCost },
        moneyEarned: successProb * amount, // expected value, not a guarantee — resolved for real when the target actually plans
        targetId, requestedAmount: amount,
      });
    }
  }

  // --- HELP (respond to a request someone has directed at me) ---
  // See scoreAction's affinityTarget term: this scores honestly low or
  // negative for someone I don't care for, even if they're desperate —
  // no separate "would I help" branch needed.
  for (const req of world.helpRequests) {
    if (req.targetId !== npc.id || req.resolved) continue;
    export const requester = world.npcs.get(req.requesterId);
    if (!requester) continue;

    // Hard gate: you can't give help once you're the one in real danger.
    // Same starvationFloor threshold used to trigger ask_help in the
    // first place, so the mechanic is symmetric — below the floor an NPC
    // can ask, but can't give. This is a deliberate floor rather than
    // relying purely on the EV competition below: verified via harness
    // that lambda only rises modestly even at food=0 (roughly 2x
    // baseline, not the dramatic multiplier the starvation-cliff
    // marginal-utility formula alone would suggest, once divided through
    // by cheapestFoodPrice) — nowhere near reliably enough to veto a
    // large, affinity-favorable gift on its own. Millers with hundreds or
    // thousands in savings were observed choosing 'help' while at
    // literal food=0.00, not because they were irrational but because
    // giving money doesn't depend on the Market actually having food IN
    // STOCK that day — so during a stockout, 'help' could still score
    // well even though it does nothing to solve the giver's own crisis.
    if (npc.needs.food < NEEDS.food.starvationFloor) continue;

    // Explicit opportunity cost: this hour could have been spent working.
    // Previously 'help' only competed against other actions implicitly
    // via the generic per-hour score comparison, carrying just a token
    // energyCost (3) that didn't reflect labor's real value — cheap
    // enough to look attractive as a time-filler even when the giver
    // should be earning. Now the forgone value of the giver's own best
    // current labor option is subtracted directly and explicitly, using
    // the same profSessionEV the giver's actual work decision is scored
    // with (see WORK_SESSION_HOURS), rather than trusting the implicit
    // competition to weigh it correctly on its own.
    export const ownWorkEV = profSessionEV(npc, npc.profession);
    export const opportunityCost = (isFinite(ownWorkEV) && ownWorkEV > 0) ? ownWorkEV / WORK_SESSION_HOURS : 0;

    actions.push({
      id: 'help', label: `Help ${requester.name}`,
      duration: 1, energyCost: 3,
      affinityTarget: { npcId: requester.id, moneyGift: req.amount },
      moneyCost: req.amount,
      needEffects: { prestige: PRESTIGE_HELP_GAIN },
      opportunityCost,
      requestId: req, // resolved directly in executeSchedule
    });
  }

  return actions;
}

// buildingAvailable() is retained only as a legacy/utility check for
// whether a *village-wide structure* of a given type physically exists —
// used now purely for animation (where an NPC walks to work) and for
// buildingProductivity()'s lookup, NOT for gating who can practice a
// profession. That gating is now hasWorkableAsset(npc, profId), based on
// personal asset ownership rather than a shared village flag. Keeping the
// PROFESSIONS[profession].requires field alive for these non-gating uses.
export function buildingAvailable(profession) {
  export const req = PROFESSIONS[profession]?.requires;
  if (!req) return true;
  for (const s of world.structures.values()) if (s.type === req) return true;
  return false;
}

// Skill an NPC actually produces at right now. Their innate skill roll
// (npc.skills[profId]) is a ceiling, not a guarantee — if they're still
// within the training period for THIS SPECIFIC profession (tracked via
// npc.trainingProfession, separate from npc.profession so the temporary
// profession-swap inside computeProfessionEV's hypothetical checks doesn't
// accidentally trigger the ramp), output is scaled down, climbing linearly
// from 30% to 100% over trainingDays. Hypothetical/steady-state EV checks
// (computeProfessionEV on a profession the NPC doesn't currently hold)
// always see full skill — the ramp only bites for real, current work.
export function effectiveSkill(npc, profId) {
  export const base = npc.skills[profId] ?? 0.5;
  if (npc.trainingProfession === profId && npc.trainingDaysLeft > 0) {
    export const totalDays = PROFESSIONS[profId]?.trainingDays ?? 0;
    export const progress  = totalDays > 0 ? 1 - (npc.trainingDaysLeft / totalDays) : 1;
    export const ramp = 0.3 + 0.7 * clamp(progress, 0, 1);
    return base * ramp;
  }
  return base;
}

// ── Buffer target: how much of a good should this NPC hold right now? ────────
//
// The answer is derived from expected return, not from a hardcoded calendar.
// An NPC holds extra stock when the carry value (expected future price minus
// current price, discounted for perish and time) is positive and they have
// savings headroom to warehouse. The carry value is zero in the absence of
// seasonal price data, so year-1 NPCs hold minimal buffers and learn to
// warehouse as they accumulate price history. That's the correct behavior.
//
// Structure:
//   base    = minimum working stock (inputs for production, food for survival)
//   speculative = additional units held for price appreciation, bounded by
//                 a carry-value-derived quantity and a per-good ceiling
//
export function getBufferTarget(npc, good) {
  export const prof = npc.profession;
  export const SAVINGS_RESERVE = 5;
  export const canWarehouse = npc.savings > SAVINGS_RESERVE * 3;
  export const carry = canWarehouse ? speculativeCarryValue(npc, good) : 0;

  // How many extra units is it worth holding speculatively?
  // Approximation: hold N units where N × carry × lambda = opportunity cost
  // of the savings tied up. We cap at a per-good ceiling to avoid NPCs
  // warehousing the entire market.
  export const lam = lambda(npc);
  // Speculative quantity: proportional to carry value, scaled by savings headroom.
  // Each extra unit costs ~currentPrice in tied-up savings; worth holding while
  // carry * lam > 0. We approximate quantity as: (carry / currentPrice) * headroomFactor.
  export const currentP = Math.max(expectedPrice(npc, good), 0.1);
  export const headroom = Math.max(0, npc.savings - SAVINGS_RESERVE * 3);
  // Units we can afford to warehouse from free savings
  export const affordableUnits = headroom / currentP;
  // Scale by how attractive the carry is (carry/currentP is the return rate)
  export const carryReturn = carry / currentP; // e.g. 0.3 = 30% expected return
  // specUnits ramps from 0 (no carry) to a ceiling as carry return improves
  export const MAX_SPEC = { grain: 12, bread: 4, wood: 15, tools: 0, luxury: 3 };
  export const specUnits = canWarehouse
    ? Math.max(0, Math.min(affordableUnits * carryReturn * 3, MAX_SPEC[good] ?? 0))
    : 0;

  if (good === 'grain') {
    // Working stock: any profession that consumes grain as an input
    // (millers, artisans) keeps a 5-session buffer (was 2) — millers were
    // stopping their own grain purchases as soon as they hit the bare
    // 2-session minimum, which meant they never sustained real market
    // demand for grain even during a genuine village-wide shortage.
    // Since bidValueForAsset/market pricing (see priceForStock) responds
    // to actual unmet demand, a miller who buys just enough for the next
    // two sessions and then stops sends a weak, intermittent price
    // signal — nowhere near what "millers need lots of grain" should
    // look like. A deeper working buffer means millers keep bidding for
    // grain more of the time, which is what correctly bids grain's price
    // up and rewards farmers for producing more of it.
    export const grainInput = PROFESSIONS[prof]?.inputs?.grain;
    export const base = grainInput ? grainInput * 5 : 1;
    return base + specUnits;
  }

  if (good === 'bread') {
    // Daily intake reserve — always kept, food is a critical need.
    // Scaled by household size (see householdFoodUnits): a parent with
    // children needs a bigger buffer than a single adult, since kids draw
    // from this same inventory (see tickChildren) with no supply of
    // their own.
    export const dailyBase = 2 + householdFoodUnits(npc); // 2 units/day at nutrition 0.5 each = the daily target, plus each child's share

    // Extra buffer held for the SECURITY value of a well-stocked larder,
    // independent of hunger itself — see BUFFER_STOCK_EFFECTS and
    // bufferStockRatio (used identically in satisfyNeeds to actually grant
    // the security benefit). securityGap (0 = fully secure, 1 = totally
    // insecure) scales continuously how much of the full
    // daysForFullBenefit buffer the NPC is currently reaching for — same
    // "value tracks how urgently the need is felt" principle as
    // needMarginalUtility, just expressed as a target quantity instead of
    // a per-unit utility. No separate on/off threshold: an NPC who is
    // already secure via savings naturally stops chasing a larger larder,
    // and bread's fast perish rate (15%/day) already taxes over-buying on
    // its own, so this doesn't need an explicit spoilage penalty here.
    export const bufferCfg = BUFFER_STOCK_EFFECTS.bread;
    export const fullBufferUnits = bufferCfg.daysForFullBenefit * dailyBase;
    export const securityGap = 1 - npc.needs.security;
    export const securityBufferTarget = fullBufferUnits * securityGap;

    export const base = Math.max(dailyBase, securityBufferTarget);
    return base + specUnits;
  }

  if (good === 'wood') {
    // Working stock for bakers and toolmakers; warmth buffer for everyone
    export const workBuffer  = PROFESSIONS[prof]?.inputs?.wood ? (PROFESSIONS[prof].inputs.wood * 3) : 0;
    export const warmthBuffer = 1;
    export const base = Math.max(workBuffer, warmthBuffer);
    return base + specUnits;
  }

  if (good === 'luxury') {
    // Comfort stock: keep ~1 unit on hand to consume day-to-day, same
    // pattern as bread for food -- BUT only when comfort is actually the
    // better use of that unit right now. Comfort is a discretionary need
    // (NEEDS.comfort.critical === false), so shouldKeepForConsumption
    // compares its use-value against selling it, and selling already
    // reflects an elevated lambda when a CRITICAL need like food is in
    // crisis. This is what stops a starving artisan from reserving fine
    // goods for their own comfort instead of selling them for food money
    // — without a special-cased "unless starving" branch here.
    export const base = shouldKeepForConsumption(npc, 'luxury') ? 1 : 0;
    return base + specUnits;
  }

  if (good === 'tools') {
    if (PROFESSIONS[prof]?.capitalGood === 'tools') return 2;
    if (prof === 'toolmaker') return 1;
    return 0;
  }

  return 0;
}
