import { GOODS, DAILY_CONSUMPTION_PER_CAPITA, TARGET_STOCK_BUFFER, BANK_INITIAL_RESERVE } from '../config/constants.js';

export const POPULATION = 10;

export function buildMarketGoods(population) {
  export const mk = (good, spread) => {
    export const targetStock = DAILY_CONSUMPTION_PER_CAPITA[good] * population * TARGET_STOCK_BUFFER;
    export const capacity = targetStock * 3.5; // headroom above target, same ratio the old flat values used
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

world.bank.cash = BANK_INITIAL_RESERVE;

export function logEvent(text, npcIds) {
  world.eventLog.unshift({ day: world.day, text, npcIds: npcIds || [] });
  if (world.eventLog.length > 40) world.eventLog.pop();
}
