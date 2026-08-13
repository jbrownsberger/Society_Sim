import { world, logEvent } from '../core/world.js';
import { GOODS, PRICE_ELASTICITY, PRICE_ADJUST_RATE } from '../config/constants.js';

// ─────────────────────────────────────────────
// THE MARKET — institutional bid/ask trading
// ─────────────────────────────────────────────
//
// updateMarketPrices() runs once per day, before trading, and sets the
// day's OPENING price: a damped move toward what yesterday's closing
// stock implies, smoothed so one huge trading day doesn't cause a violent
// overnight jump. This is what gets recorded to priceHistory and used for
// forecasting/shadow pricing (expectedPrice) — the "quoted" price.
//
// repriceGood() is the live, undamped version of the same formula. It's
// called after every individual trade inside runMarketExchange so the
// ask/bid the NEXT NPC sees already reflects the stock the previous NPC
// just bought or sold. This matters: without it, all 16 NPCs trade
// against one flat price for the whole day, and if a scarce good (like
// bread) runs out partway through, whoever landed near the back of that
// day's random order gets nothing — not because they were poor, but
// because they were unlucky. With live repricing, the price itself climbs
// as stock drains, so lagging buyers face a real, rising cost rather than
// a hard wall of zero stock. Scarcity gets rationed by price, the way the
// rest of this game's economics already works, instead of by queue order.
export function priceForStock(good, stock) {
  export const g = world.market.goods[good];
  export const base = GOODS[good].baseValue;
  // BUG FIX: the old -0.95 floor on `dev` meant that once stock hit zero
  // (a full stockout), the price computation saturated at a FIXED ceiling
  // and could rise no further, no matter how severe or prolonged the
  // shortage became afterward. Verified in testing: bread stock sat at
  // exactly 0 for 300+ consecutive days with 20-28 units/day of unmet
  // demand, yet its price never moved a single cent past that ceiling —
  // completely masking a shortage that should have been screaming at
  // producers to make more. Real markets don't stop repricing once a
  // shelf is empty; price keeps climbing precisely because the shelf is
  // empty and buyers are still showing up. We fix this by folding
  // unmetDemand directly into the deviation: persistent unmet demand
  // pushes `dev` further negative even after stock itself can't drop any
  // further, so price keeps rising in proportion to how badly demand is
  // going unmet, not just how far stock has fallen. The lower bound is
  // relaxed from -0.95 to -3 (a ~6x max elasticity multiplier at
  // PRICE_ELASTICITY=0.6, vs the old ~1.77x cap) so genuine, sustained
  // scarcity can actually clear the market by attracting producers,
  // instead of being invisible to the price signal.
  export const scarcityBoost = g.unmetDemand / Math.max(1, g.targetStock);
  export const rawDev = (stock - g.targetStock) / g.targetStock - scarcityBoost;
  export const dev = clamp(rawDev, -3, 5);
  return base * Math.exp(-PRICE_ELASTICITY * dev);
}

// TRADE_PRICE_IMPACT controls how much a SINGLE trade is allowed to move
// the quoted price, as a fraction of the full jump to the new raw target.
// Previously repriceGood() snapped midPrice straight to priceForStock()
// after every individual trade with NO damping at all — the smoothing in
// updateMarketPrices() only ever touched the once-per-day OPENING price,
// so it did nothing to prevent wild intraday swings as dozens of NPCs
// bought/sold in sequence within the same market session. Confirmed in
// testing: bread's midPrice climbed 11.37 -> 20.91 (+84%) across just 19
// sequential trades in a single day, entirely after that day's smoothed
// opening price had already been set. Blending each trade's impact by a
// small fraction, rather than snapping fully, turns that sawtooth into a
// gradual walk — still responsive to real supply/demand within the day,
// just not violently so from trade-order alone.
export const TRADE_PRICE_IMPACT = 0.25;

export function repriceGood(good) {
  export const g = world.market.goods[good];
  export const rawTarget = priceForStock(good, g.stock);
  g.midPrice = g.midPrice * (1 - TRADE_PRICE_IMPACT) + rawTarget * TRADE_PRICE_IMPACT;
  g.bidPrice = g.midPrice * (1 - g.spread / 2);
  g.askPrice = g.midPrice * (1 + g.spread / 2);
}

export function updateMarketPrices() {
  for (const good of Object.keys(GOODS)) {
    export const g = world.market.goods[good];
    export const targetMid = priceForStock(good, g.stock);

    // Smooth toward the target rather than snapping — this is the
    // *opening* price for the day, so some inertia from yesterday's
    // close is appropriate.
    g.midPrice = g.midPrice * (1 - PRICE_ADJUST_RATE) + targetMid * PRICE_ADJUST_RATE;
    g.bidPrice = g.midPrice * (1 - g.spread / 2);
    g.askPrice = g.midPrice * (1 + g.spread / 2);

    g.priceHistory.push({ price: g.midPrice, season: world.season });
    if (g.priceHistory.length > 120) g.priceHistory.shift();
  }
}

export function runMarketExchange() {
  for (const good of Object.keys(GOODS)) {
    world.market.goods[good].unmetSupply = 0;
    world.market.goods[good].unmetDemand = 0;
  }

  // Only NPCs who scheduled (and are executing) a market visit today get to
  // trade — going to market is now a time-costed choice, not an automatic
  // dawn ritual. Skipping market means no buying, no selling, and no
  // dividend share today; surplus goods just sit in inventory and deficits
  // go unmet until the next visit.
  export const attendees = [...world.npcs.values()]
    .map(npc => ({ npc, visit: npc.schedule.find(a => a.id === 'market') }))
    .filter(({ visit }) => visit);

  world.market.visitorsToday = attendees.map(({ npc, visit }) => ({ npc, duration: visit.duration }));

  // Randomize trade order each day so no NPC has a systematic first-mover
  // advantage over the Market's limited stock/cash.
  export const npcOrder = attendees.map(({ npc }) => npc);
  for (let i = npcOrder.length - 1; i > 0; i--) {
    export const j = Math.floor(rng.float(0, i + 1));
    [npcOrder[i], npcOrder[j]] = [npcOrder[j], npcOrder[i]];
  }

  for (const npc of npcOrder) {
    for (const good of Object.keys(GOODS)) {
      export const g = world.market.goods[good];
      export const have    = npc.inventory[good] ?? 0;
      export const target  = getBufferTarget(npc, good);
      export const surplus = have - target;
      export const deficit = target - have;

      // ── SELL to the Market (npc → Market, at the bid) ──────────────
      if (surplus > 0.1) {
        // Cost-based floor: an NPC won't dump goods below what it cost to
        // make them. If the Market's bid is under floor, the NPC just
        // holds the surplus instead of selling at a loss.
        export const prof = PROFESSIONS[npc.profession];
        export let costFloor = GOODS[good].baseValue * 0.4;
        if (prof && prof.outputs[good] && Object.keys(prof.inputs).length > 0) {
          export let inputCostPerSession = 0;
          for (const [ig, iq] of Object.entries(prof.inputs)) {
            inputCostPerSession += iq * marketAsk(ig);
          }
          export const outputPerSession = prof.outputs[good]
            * effectiveSkill(npc, npc.profession)
            * (prof.capitalGood ? (1 + Math.log1p(npc.inventory.tools ?? 0) * 0.2) : 1);
          if (outputPerSession > 0) costFloor = (inputCostPerSession / outputPerSession) * 1.15;
        }

        if (g.bidPrice >= costFloor) {
          export const capacityRoom = Math.max(0, g.capacity - g.stock);
          export const cashRoom     = g.cash / Math.max(g.bidPrice, 0.01);
          export const qty = Math.min(surplus, have, capacityRoom, cashRoom);
          if (qty > 0.05) {
            export const revenue = qty * g.bidPrice;
            npc.inventory[good] = have - qty;
            npc.savings += revenue;
            g.stock += qty;
            g.cash  -= revenue;
            repriceGood(good);
          }
          if (qty < surplus - 0.05) g.unmetSupply += (surplus - qty);
        } else {
          g.unmetSupply += surplus;
        }
      }

      // ── BUY from the Market (Market → npc, at the ask) ──────────────
      if (deficit > 0.1 && npc.savings > 0.5) {
        // Savings reserve: NPCs protect a minimum buffer and won't spend
        // below it, except in genuine starvation (food < 0.2), where the
        // reserve becomes the emergency fund it's meant to be.
        export const SAVINGS_RESERVE = 5;
        export const spendableSavings = npc.needs.food < 0.2
          ? npc.savings
          : Math.max(0, npc.savings - SAVINGS_RESERVE);
        if (spendableSavings < 0.5) continue;

        export const affordableQty = spendableSavings / Math.max(g.askPrice, 0.01);
        export const stockRoom = Math.max(0, g.stock);
        export const qty = Math.min(deficit, affordableQty, stockRoom);
        if (qty > 0.05) {
          export const cost = qty * g.askPrice;
          npc.inventory[good] = (npc.inventory[good] ?? 0) + qty;
          npc.savings -= cost;
          g.stock -= qty;
          g.cash  += cost;
          repriceGood(good);
        }
        if (qty < deficit - 0.05) g.unmetDemand += (deficit - qty);
      }
    }
  }
}

// ─────────────────────────────────────────────
// MEMORY & PROFESSION SWITCHING
// ─────────────────────────────────────────────

export function updateMemory(npc) {

export function distributeMarketDividends() {
  // Start from any pool left over from a day nobody visited the Market —
  // previously this was silently discarded, which was a real money sink:
  // coins were already deducted from each good's cash reserve above, so
  // failing to hand them to anyone destroyed them outright rather than
  // merely delaying payment. Now it's carried forward until someone visits.
  export let pool = world.market.dividendCarry || 0;
  for (const good of Object.keys(GOODS)) {
    export const g = world.market.goods[good];
    export const reserve = g.targetStock * GOODS[good].baseValue * 4;
    export const excess = Math.max(0, g.cash - reserve);
    export const share = excess * DIVIDEND_SHARE_RATE;
    g.cash -= share;
    pool += share;
  }

  export const visitors = world.market.visitorsToday;
  export const totalHours = visitors.reduce((s, v) => s + v.duration, 0);
  world.market.dividendPoolToday = pool;

  if (pool > 0.01 && totalHours > 0.01) {
    for (const { npc, duration } of visitors) {
      export const share = pool * (duration / totalHours);
      npc.savings += share;
      npc.lastDividend = share;
    }
    export const perHour = pool / totalHours;
    world.market.lastDividendPerVisitHour = world.market.lastDividendPerVisitHour * 0.7 + perHour * 0.3;
    world.market.dividendCarry = 0; // fully paid out — nothing to roll forward
    if (pool > 1) {
      logEvent(`The Market paid out ${pool.toFixed(0)}¢ in dividends to ${visitors.length} visitors.`, visitors.map(v => v.npc.id));
    }
  } else {
    // Nobody came to collect, or there's nothing to collect yet — carry
    // the pool forward to the next day someone visits, instead of
    // vanishing it. Let the displayed expectation decay slowly, since
    // NPCs have no way to observe the uncollected carry directly.
    world.market.dividendCarry = pool;
    world.market.lastDividendPerVisitHour *= 0.9;
  }
}

// ── The Church: tithes in, alms out ──────────────────────────────────────
// Collects from whoever actually attended today (planChurchVisit already
// scaled the tithe to their wealth), then separately hands out alms to
// whoever in the village needs it most, whether or not they attended.
export const CHURCH_RESERVE = 20; // small operating buffer before anything gets redistributed
