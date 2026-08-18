import { ASSET_TYPES, GOODS, HOMELESS_REST_PENALTY, LABOR_DISUTILITY, PROFESSIONS, housingQuality, needMarginalUtility } from './constants.js';
import { world } from './state.js';
import { discountRate, expectedPrice, lambda, marketAsk, marketBid, shadowPriceGood } from './prices.js';
import { profSessionEV } from './valuation.js';
import { startConstruction } from './construction.js';
import { getBufferTarget } from './death.js';
import { STARVING_FOOD_THRESHOLD } from './memory.js';

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

function isInputForOwnedAsset(npc, good) {
  return npc.ownedAssets.some(assetId => {
    const asset = world.assets.get(assetId);
    const profId = asset && ASSET_TYPES[asset.type]?.profession;
    return profId && (PROFESSIONS[profId]?.inputs?.[good] ?? 0) > 0;
  });
}

export function planMarketVisit(npc) {
  const lam = lambda(npc);
  let sellQty = 0, buyQty = 0, sellRevenue = 0, buyCost = 0;
  const goodsProduced = {}; // goods the NPC would acquire — scored, not executed here
  const goodsConsumed = {}; // goods the NPC would sell away — scored, not executed here

  const SAVINGS_RESERVE = 5;
  for (const good of Object.keys(GOODS)) {
    const have    = npc.inventory[good] ?? 0;
    const target  = getBufferTarget(npc, good);
    const surplus = Math.max(0, have - target);
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
  const candidates = [];
  for (const good of Object.keys(GOODS)) {
    const have    = npc.inventory[good] ?? 0;
    const target  = getBufferTarget(npc, good);
    const deficit = Math.max(0, target - have);
    if (deficit <= 0.1) continue;
    const perUnitValue = shadowPriceGood(npc, good);
    const askPrice = Math.max(marketAsk(good), 0.01);
    const isFood = GOODS[good].nutrition > 0;
    const isProductionInput = isInputForOwnedAsset(npc, good);
    // Food is not a discretionary investment.  The live exchange already
    // buys an attendee's food deficit whenever they can pay; allowing the
    // BDI forecast to reject that same purchase created a false plan where
    // a hungry household with cash and stocked shelves scheduled no market
    // visit at all. Other goods still need to clear their shadow value.
    if (!isFood && !isProductionInput && perUnitValue <= askPrice * lam) continue;
    const stockAvailable = Math.max(0, world.market.goods[good]?.stock ?? 0);
    if (stockAvailable < 0.1) continue; // nothing to buy regardless of money
    candidates.push({ good, deficit, askPrice, stockAvailable, isFood, isProductionInput, valuePerCoin: perUnitValue / askPrice });
  }
  // Match the real exchange's survival-first ordering: food is purchased
  // before an optional capital or comfort good can consume the budget.
  candidates.sort((a, b) =>
    Number(b.isFood) - Number(a.isFood) ||
    (GOODS[b.good].nutrition ?? 0) - (GOODS[a.good].nutrition ?? 0) ||
    Number(b.isProductionInput) - Number(a.isProductionInput) ||
    b.valuePerCoin - a.valuePerCoin
  );

  const spendableSavings = npc.needs.food < 0.2
    ? npc.savings
    : Math.max(0, npc.savings - SAVINGS_RESERVE);
  let budget = spendableSavings + sellRevenue; // same-visit sale proceeds are spendable too

  for (const c of candidates) {
    if (budget < 0.5) break;
    const affordableQty = budget / c.askPrice;
    const qty = Math.min(c.deficit, c.stockAvailable, affordableQty);
    if (qty <= 0.05) continue;
    const cost = qty * c.askPrice;
    buyQty += qty;
    buyCost += cost;
    budget -= cost;
    goodsProduced[c.good] = qty;
  }

  const totalQty = sellQty + buyQty;
  let duration = totalQty > 0.1 ? MARKET_BASE_TIME + totalQty * MARKET_PER_UNIT_TIME : 0;

  // Haggling: is lingering longer worth it at the going dividend rate?
  const dividendUtilPerHour = (world.market.lastDividendPerVisitHour ?? 0) * lam;
  const marketCostPerHour   = MARKET_DISUTILITY_PER_HOUR + MARKET_ENERGY_PER_HOUR * 0.05;
  const haggleWorthwhile    = dividendUtilPerHour > marketCostPerHour;

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
export const TITHE_RATE = 0.02;  // a recurring voluntary contribution, not a confiscatory levy
export const TITHE_CAP  = 5;

export function planChurchVisit(npc) {
  const tithe = Math.min(Math.max(0, npc.savings) * TITHE_RATE, TITHE_CAP);
  const devotionalValue = needMarginalUtility(npc, 'meaning') * 0.6
    + needMarginalUtility(npc, 'social') * 0.08;
  // Giving is a social/meaningful act in itself: the donor still bears a
  // portion of the opportunity cost, but does not experience a voluntary
  // tithe as a purely instrumental loss. Hunger and acute discomfort take
  // precedence over worship, so this is not a scripted escape from crisis.
  const solidarityValue = tithe * lambda(npc) * 0.75;
  const foodPressure = Math.max(0, 0.35 - npc.needs.food) / 0.35;
  const comfortPressure = Math.max(0, 0.2 - npc.needs.comfort) / 0.2;
  const hardshipPenalty = devotionalValue * (foodPressure * 2 + comfortPressure);
  return {
    id: 'church', label: 'Attend Church',
    duration: CHURCH_DURATION,
    energyCost: CHURCH_ENERGY,
    needEffects: { meaning: 0.35, social: 0.08 },
    moneyCost: tithe,
    _scoreOverride: devotionalValue + solidarityValue - tithe * lambda(npc) - hardshipPenalty,
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
  const def = ASSET_TYPES[asset.type];
  if (!def) return 0;
  const profId = def.profession;
  // Steady-state EV assumes full skill — mirrors computeProfessionEV's
  // hypothetical-swap trick, since we want "what would this be worth to
  // a competent operator," not this NPC's own (possibly zero) skill.
  // Also temporarily swaps asset.ownerId to npc.id: hasWorkableAsset()
  // (called inside profSessionEV) requires ownership match, and this NPC
  // may not actually own the asset yet (e.g. a seller valuing an asset
  // they're about to list still owns it — fine — but this same function
  // is also called for OTHER npcs during auctions/comparisons, where it
  // must reflect "if I owned and fully mastered this," not fail silently.
  const savedProf = npc.profession, savedSkill = npc.skills[profId], savedPrimary = npc.primaryAsset, savedOwner = asset.ownerId;
  let dailyEV;
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
  const discRate = discountRate(npc);
  const pv = dailyEV * (1 - Math.pow(1 - discRate, ASSET_VALUE_HORIZON)) / discRate;
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
  const asset = world.assets.get(npc.primaryAsset);
  if (!asset || asset.ownerId !== npc.id) return;
  const isStarving = npc.needs.food < STARVING_FOOD_THRESHOLD;
  asset.starvingStreak = isStarving ? (asset.starvingStreak + 1) : 0;
}

// Returns the primary asset as a distress-sale candidate ONLY once the
// owner has been starving long enough, per the asymmetric thresholds
// above. Returns null otherwise (primary assets are never freely listed
// the way idle ones are — this is the sole path to selling one's
// livelihood asset).
export function getDistressPrimaryAsset(npc) {
  if (npc.primaryAsset === null || npc.primaryAsset === undefined) return null;
  const asset = world.assets.get(npc.primaryAsset);
  if (!asset || asset.forSale) return null;
  const isLastAsset = npc.ownedAssets.length <= 1;
  const threshold = isLastAsset ? DISTRESS_STARVING_DAYS_LAST_ASSET : DISTRESS_STARVING_DAYS_SURPLUS;
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
  const actions = [];
  const lam = lambda(npc);

  for (const asset of getIdleAssets(npc)) {
    const sellValue = estimateAssetValue(npc, asset);
    const holdValue = assetHoldValue(npc, asset);
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
  const distressAsset = getDistressPrimaryAsset(npc);
  if (distressAsset) {
    const sellValue = estimateAssetValue(npc, distressAsset);
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
    const primary = world.assets.get(npc.primaryAsset);
    if (primary && primary.forSale && primary.ownerId === npc.id) {
      const recovered = primary.starvingStreak <= DISTRESS_STARVING_DAYS_SURPLUS * 0.3;
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
  const candidates = npc.ownedAssets
    .map(id => world.assets.get(id))
    .filter(a => a)
    .map(a => ({ asset: a, profId: ASSET_TYPES[a.type].profession }))
    .filter(({ profId }) => (npc.skills[profId] ?? 0) < TINKER_SKILL_CEILING);

  if (candidates.length === 0) return null;
  // Tinker on whichever candidate profession currently has the best EV
  // ceiling — an NPC with both an idle mill and an idle forge picks
  // whichever a competent operator would find more profitable, using the
  // same steady-state hypothetical swap as estimateAssetValue.
  let best = null, bestEV = -Infinity;
  for (const c of candidates) {
    // Hypothetically swap profession, skill, AND primaryAsset so
    // hasWorkableAsset() (called inside profSessionEV) correctly sees this
    // NPC as operating the candidate asset — otherwise the gate always
    // fails since primaryAsset wouldn't actually point at it yet.
    const savedProf = npc.profession, savedSkill = npc.skills[c.profId], savedPrimary = npc.primaryAsset;
    let ev;
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

  const currentSkill = npc.skills[best.profId] ?? 0;
  const discRate = discountRate(npc);
  // Present value of the skill gained today: it raises future daily EV by
  // a small increment for the rest of an assumed working horizon, same
  // discounting machinery as estimateAssetValue.
  const skillGainFrac = TINKER_LEARNING_RATE * (1 - currentSkill / TINKER_SKILL_CEILING);
  const dailyEVGain = bestEV * skillGainFrac;
  const pv = dailyEVGain * (1 - Math.pow(1 - discRate, ASSET_VALUE_HORIZON)) / discRate;

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
  const gap = 1 - HOMELESS_REST_PENALTY;
  const muComfort = needMarginalUtility(npc, 'comfort');
  const muSocial  = needMarginalUtility(npc, 'social');
  const muMeaning = needMarginalUtility(npc, 'meaning');
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
  const def = ASSET_TYPES.house;
  let buildCostValue = 0;
  for (const [g, qty] of Object.entries(def.buildCost)) buildCostValue += qty * expectedPrice(npc, g);
  if (npc.savings > buildCostValue * 1.5) startConstruction(npc, 'house');
}

export function planConstructionAction(npc) {
  const proj = npc.constructionProject;
  if (!proj) return null;
  const hoursRemaining = proj.laborHoursNeeded - proj.laborHoursDone;
  if (hoursRemaining <= 0.01) return null;

  const def = ASSET_TYPES[proj.assetType];
  const profId = def.profession;
  const sessionHours = Math.min(6, hoursRemaining);
  const energyCost = 25 * (sessionHours / 6);

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
    const urgency = (1 - housingQuality(npc)) * HOUSE_CONSTRUCTION_URGENCY_SCALE;
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
  const savedProf = npc.profession;
  let workingEV;
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
  const discRate = discountRate(npc);
  const pv = Math.max(0, workingEV) * (1 - Math.pow(1 - discRate, ASSET_VALUE_HORIZON)) / discRate;

  // Spread that value evenly across every hour of labor the project
  // needs — the 400th hour of building a mill isn't worth less than the
  // 1st, they're equally necessary to ever reach completion.
  const perHourUtility = pv / proj.laborHoursNeeded;

  return {
    id: 'build', label: `Build ${def.name}`,
    duration: sessionHours,
    isLabor: true,
    energyCost,
    _constructionHours: sessionHours,
    _scoreOverride: perHourUtility * sessionHours - energyCost * 0.05 - LABOR_DISUTILITY * sessionHours,
  };
}
