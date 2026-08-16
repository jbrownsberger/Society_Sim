import { clamp } from './utils.js';
import { GOODS, createOwnedAsset, createStructure, makeAsset, seedAssets } from './constants.js';
import { resolveHelpRequests, spawnChild, tickChildren } from './marriage.js';
import { BANK_INITIAL_RESERVE, distributeBankInterest, serviceDebts } from './auctions.js';

// ─────────────────────────────────────────────
// WORLD STATE
// ─────────────────────────────────────────────

// ── The Market institution ───────────────────────────────────────────────
// Replaces the old double-auction (buyOrders/sellOrders matched peer-to-
// peer) with a single counterparty: the Market itself. NPCs never trade
// with each other directly. The Market posts a bid (what it pays sellers)
// and an ask (what it charges buyers) for every good, and those posted
// prices move based on the Market's own inventory relative to a target
// stock level — the classic inventory-based market-maker model. Glut
// (stock above target) pushes prices down; scarcity (stock below target)
// pushes prices up. The gap between bid and ask (the spread) is the
// institution's own margin — future gameplay can expose this as taxable
// revenue, a thing the player can subsidize, corner, or regulate.
//
// The Market also has finite storage capacity (can refuse to buy more of
// a glutted good) and a finite cash reserve (can run low on coin and be
// unable to pay sellers). Neither constraint is calibrated to bind often
// in Phase 1 — they exist so later institutional-power mechanics have
// something real to grab onto (recapitalize the Market, expand the
// granary, etc.), not to create scarcity puzzles right now.
// POPULATION is the single source of truth for starting village size.
// Everything below derives from it (spawn count, market stock targets,
// etc.), so changing this one number doesn't require hunting down
// hardcoded values elsewhere. Defined early since world's market init
// now depends on it too.
export const POPULATION = 48;
// DAILY_CONSUMPTION_PER_CAPITA: real per-capita daily demand for each
// good, derived directly from the actual consumption logic elsewhere in
// the code (not guessed):
//   grain — up to 2 units/day per NPC as a food fallback (satisfyNeeds'
//     foodTarget=2), though most of that is normally bread; grain is
//     also a work INPUT for millers (4/day) and artisans (2/day), so we
//     budget generously since it's both food and industrial input.
//   bread — the primary food good; foodTarget=2 units/day at full
//     nutrition (0.5), so ~2 units/day/capita covers a fully-fed diet.
//   wood — satisfyNeeds burns 0.5/day baseline, 1.0/day in winter
//     (worst case used here), plus it's a work input for toolmakers
//     (2/day) and artisans (3/day) — budgeted for the residential burn
//     rate, since industrial demand is a much smaller number of
//     asset-owners, not the whole population.
//   tools — a capital good bought occasionally, not consumed daily;
//     budgeted low per-capita since only asset-owning workers actually
//     need to hold any.
//   luxury — a comfort-need good, occasional purchase, budgeted low.
// TARGET_STOCK_BUFFER: the market keeps this many days' worth of
// village-wide consumption in reserve, so ordinary daily demand swings
// don't push stock anywhere near zero (which is what was driving both
// chronic stockouts AND the price volatility that comes from stock
// hovering near the danger zone).
export const DAILY_CONSUMPTION_PER_CAPITA = {
  grain: 1.0, bread: 2.0, wood: 0.6, tools: 0.15, luxury: 0.2,
};
export const TARGET_STOCK_BUFFER = 2; // days of full village-wide demand held in reserve

export function buildMarketGoods(population) {
  const mk = (good, spread) => {
    const targetStock = DAILY_CONSUMPTION_PER_CAPITA[good] * population * TARGET_STOCK_BUFFER;
    const capacity = targetStock * 3.5; // headroom above target, same ratio the old flat values used
    return makeMarketGood(GOODS[good].baseValue, targetStock, capacity, spread);
  };
  return {
    grain:  mk('grain',  0.14),
    bread:  mk('bread',  0.16),
    wood:   mk('wood',   0.18),
    tools:  mk('tools',  0.22),
    luxury: mk('luxury', 0.25),
  };
}

export function makeMarketGood(baseValue, targetStock, capacity, spread) {
  return {
    stock: targetStock,
    targetStock,
    targetStockMin: targetStock * 0.4,      // adaptive floor
    // Adaptive ceiling capped at 2x base (was 4x). At 4x, a good with
    // chronic real shortage (see bread, whose target ratcheted up via
    // repeated shortageStreak triggers) could balloon to a buffer far
    // beyond any real village's storage horizon — bread's target hit 768
    // units for a ~30-person village, over a YEAR of consumption. Filling
    // that buffer took so long that by the time it was "full" and price
    // crashed back to baseline (killing the milling incentive), the
    // underlying grain shortage hadn't actually stabilized — creating a
    // boom-bust cycle where production collapsed right as the next
    // shortage was about to hit. A tighter ceiling means price recovers
    // to a shortage signal faster and holds it longer relative to actual
    // production capacity, instead of one enormous slow-building buffer
    // that masks the recurring underlying imbalance for months at a time.
    targetStockMax: targetStock * 2,        // adaptive ceiling
    capacityRatio: capacity / targetStock,  // capacity always scales with target
    capacity,
    // Fully capitalized from day one. Previously this equaled the dividend
    // reserve threshold in distributeMarketDividends() exactly (also ×4),
    // so the Market started with zero "excess" and had to slowly claw its
    // way past its own floor via trade spread before a single dividend
    // ever paid out — a slow, compounding drain on villager savings over
    // thousands of days. Starting well above reserve means dividends can
    // flow from day one instead of needing a long one-way accumulation
    // period first.
    cash: targetStock * baseValue * 8,
    midPrice: baseValue,
    bidPrice: baseValue * (1 - spread/2),
    askPrice: baseValue * (1 + spread/2),
    spread,
    priceHistory: [],       // {price, season} — the Market's own posted midPrice over time
    unmetSupply: 0,         // NPCs who wanted to sell but Market wouldn't/couldn't buy
    unmetDemand: 0,         // NPCs who wanted to buy but Market wouldn't/couldn't sell
    shortageStreak: 0,      // consecutive days with real unmet demand
    glutStreak: 0,          // consecutive days with real unmet supply
  };
}

export const PRICE_ELASTICITY = 0.6;   // how hard price reacts to a stock deviation
export const PRICE_ADJUST_RATE = 0.15; // daily smoothing toward the target price

// TIME_USE_WINDOW: how many days of village-wide time-use history to
// retain for charting — enough to see recent trends without unbounded
// memory growth over a long run.
export const TIME_USE_WINDOW = 60;

export const world = {
  day: 0,
  season: 'spring',
  npcs: new Map(),
  assets: new Map(),   // assetId -> asset record (see makeAsset / seedAssets above)
  timeUseHistory: [],  // [{ day, byAction: { work: hrs, rest: hrs, ... } }, ...] village-wide daily totals
  market: {
    // FIX: targetStock is now derived directly from actual per-capita
    // daily consumption × population × a buffer multiplier, rather than
    // hand-tuned flat numbers (which were sized for the original 16-NPC
    // village and never rescaled — confirmed causing tools to be out of
    // stock 136/180 days, 76% of the time, once population tripled).
    // DAILY_CONSUMPTION_PER_CAPITA below documents exactly how each
    // number was derived from satisfyNeeds()/production inputs, so this
    // stays correct if population changes again OR if per-capita
    // consumption itself is retuned later — it's a real economic
    // quantity now, not a guess.
    goods: buildMarketGoods(POPULATION),
    // Dividend tracking — see distributeMarketDividends().
    visitorsToday: [],          // {npc, duration} for today's market-goers
    dividendPoolToday: 0,       // coins distributed today
    dividendCarry: 0,           // undistributed dividend pool rolled forward to the next visit day (fix: previously discarded, a silent money sink)
    lastDividendPerVisitHour: 0, // smoothed EMA, public — how NPCs estimate haggling value
  },
  structures: new Map(),   // id -> structure record (see createStructure/createOwnedAsset above)
  gridOccupied: new Set(), // "gx,gy" keys currently occupied by some structure's footprint
  children: new Map(),     // id -> dependent child record (see spawnChild/tickChildren) — not full NPCs
  totalBirths: 0, totalDeaths: 0, // cumulative, for demographics
  deathsByCause: { starvation: 0, oldAge: 0 },
  eventLog: [],
  helpRequests: [], // { requesterId, targetId, amount, day } — targeted, not broadcast; consumed same-day by resolveHelpRequests
  switchesToday: 0,
  church: {
    cash: 0,                        // accumulated tithes awaiting redistribution
  },
  bank: {
    // Capitalized like the Market (see makeMarketGood's comment on why
    // starting well-funded matters): a bank with zero reserve on day one
    // couldn't fund a single loan until it had somehow already collected
    // interest from loans it was never able to issue. BANK_INITIAL_RESERVE
    // is defined with the other bank constants further down, near
    // issueDebt/serviceDebts, so its sizing rationale lives next to the
    // loan mechanics it's sized for.
    cash: 0, // set to BANK_INITIAL_RESERVE right after this object literal, see below
    loansOutstanding: 0,   // sum of all NPCs' debt.remaining — informational, recomputed each serviceDebts()
    interestPaidToday: 0,  // last distributeBankInterest() payout — informational, for the UI
  },
  professionHistory: {},            // profId -> [npcId,...] most recent practitioners, for training-fee payees
};

// Single choke point for world.eventLog writes. `npcIds` tags which
// NPC(s) this event concerns (e.g. [buyerId, sellerId], [npc.id]) so the
// inspector can filter the global log down to "events involving this
// NPC" (see drawInspector) without every call site having to know about
// that filtering — same "one place, everything downstream benefits"
// pattern as scoreAction/NEEDS. Pass [] (or omit) for village-wide
// institutional events with no specific NPC subject.
export function logEvent(text, npcIds) {
  world.eventLog.unshift({ day: world.day, text, npcIds: npcIds || [] });
  if (world.eventLog.length > 40) world.eventLog.pop();
}

// ─────────────────────────────────────────────
// RELATIONS — devotion (+) / odium (-) between specific NPCs.
// ─────────────────────────────────────────────
// Asymmetric by design: A's record of B is independent of B's record of
// A (unrequited loyalty, one-sided grudges are real things). Lazily
// created on first contact rather than pre-seeded for the whole village.
export const RELATION_DECAY_BASE = 0.01; // per-day pull toward neutral (0)
// familiarity gates decay: a well-known relationship (spouse, longtime
// trade partner) is sticky; a barely-known contact drifts back to
// indifference quickly if not reinforced. decayRate = BASE * (1 - familiarity*0.9)
// so familiarity=1 relationships decay at 10% of the base rate.

export function getRelation(npc, targetId) {
  return npc.relations.get(targetId) || null;
}

export function getAffinity(npc, targetId) {
  return npc.relations.get(targetId)?.affinity ?? 0;
}

// The single write-path for any relationship change. `delta` is signed
// (+devotion, -odium). Familiarity ticks up a little on every event
// (contact itself builds familiarity, independent of whether the event
// was good or bad) and eases toward 1 with repeated contact, uses
// diminishing returns so a single dramatic event can't instantly
// manufacture a decades-deep bond.
export function bumpAffinity(npc, targetId, delta) {
  if (targetId === npc.id) return; // no self-relations
  let rec = npc.relations.get(targetId);
  if (!rec) {
    rec = { affinity: 0, familiarity: 0, lastEventDay: world.day };
    npc.relations.set(targetId, rec);
  }
  rec.affinity = clamp(rec.affinity + delta, -1, 1);
  rec.familiarity = clamp(rec.familiarity + (1 - rec.familiarity) * 0.15, 0, 1);
  rec.lastEventDay = world.day;
}

// Called once/day per NPC (see tickRelationDecay) — pulls every known
// relation gently back toward neutral, slower the more familiar it is.
export function decayRelations(npc) {
  for (const rec of npc.relations.values()) {
    const decayRate = RELATION_DECAY_BASE * (1 - rec.familiarity * 0.9);
    rec.affinity *= (1 - decayRate);
  }
}

export function tickRelationDecay() {
  for (const npc of world.npcs.values()) decayRelations(npc);
}

// Kinship seeding: parent/child and spousal bonds start with a floor of
// mutual affinity rather than the usual blank slate — this reuses the
// lineage/spouse data the inheritance and marriage systems already
// track, rather than inventing new bookkeeping. Structural bonds like
// this are also exempted from ever decaying below the floor (see the
// floor re-application in tickRelationDecay callers where relevant).
export const KINSHIP_AFFINITY_FLOOR = 0.5;
export function seedKinshipAffinity(aId, bId) {
  const a = world.npcs.get(aId), b = world.npcs.get(bId);
  if (!a || !b) return;
  for (const [x, y] of [[a, bId], [b, aId]]) {
    let rec = x.relations.get(y);
    if (!rec) { rec = { affinity: 0, familiarity: 0.3, lastEventDay: world.day }; x.relations.set(y, rec); }
    rec.affinity = Math.max(rec.affinity, KINSHIP_AFFINITY_FLOOR);
    rec.familiarity = Math.max(rec.familiarity, 0.3);
  }
}

