import { clamp } from './utils.js';
import { GOODS, PROFESSIONS } from './constants.js';
import { rng } from './rng.js';
import { PRICE_ADJUST_RATE, PRICE_ELASTICITY, world } from './state.js';
import { marketAsk } from './prices.js';
import { effectiveSkill, getBufferTarget } from './death.js';

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
  const g = world.market.goods[good];
  const base = GOODS[good].baseValue;
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
  const scarcityBoost = g.unmetDemand / Math.max(1, g.targetStock);
  const rawDev = (stock - g.targetStock) / g.targetStock - scarcityBoost;
  const dev = clamp(rawDev, -3, 5);
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
  const g = world.market.goods[good];
  const rawTarget = priceForStock(good, g.stock);
  g.midPrice = g.midPrice * (1 - TRADE_PRICE_IMPACT) + rawTarget * TRADE_PRICE_IMPACT;
  g.bidPrice = g.midPrice * (1 - g.spread / 2);
  g.askPrice = g.midPrice * (1 + g.spread / 2);
}

export function updateMarketPrices() {
  for (const good of Object.keys(GOODS)) {
    const g = world.market.goods[good];
    const targetMid = priceForStock(good, g.stock);

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
  const attendees = [...world.npcs.values()]
    .map(npc => ({ npc, visit: npc.schedule.find(a => a.id === 'market') }))
    .filter(({ visit }) => visit);

  world.market.visitorsToday = attendees.map(({ npc, visit }) => ({ npc, duration: visit.duration }));

  // Randomize trade order each day so no NPC has a systematic first-mover
  // advantage over the Market's limited stock/cash.
  const npcOrder = attendees.map(({ npc }) => npc);
  for (let i = npcOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng.float(0, i + 1));
    [npcOrder[i], npcOrder[j]] = [npcOrder[j], npcOrder[i]];
  }

  for (const npc of npcOrder) {
    for (const good of Object.keys(GOODS)) {
      const g = world.market.goods[good];
      const have    = npc.inventory[good] ?? 0;
      const target  = getBufferTarget(npc, good);
      const surplus = have - target;
      const deficit = target - have;

      // ── SELL to the Market (npc → Market, at the bid) ──────────────
      if (surplus > 0.1) {
        // Cost-based floor: an NPC won't dump goods below what it cost to
        // make them. If the Market's bid is under floor, the NPC just
        // holds the surplus instead of selling at a loss.
        const prof = PROFESSIONS[npc.profession];
        let costFloor = GOODS[good].baseValue * 0.4;
        if (prof && prof.outputs[good] && Object.keys(prof.inputs).length > 0) {
          let inputCostPerSession = 0;
          for (const [ig, iq] of Object.entries(prof.inputs)) {
            inputCostPerSession += iq * marketAsk(ig);
          }
          const outputPerSession = prof.outputs[good]
            * effectiveSkill(npc, npc.profession)
            * (prof.capitalGood ? (1 + Math.log1p(npc.inventory.tools ?? 0) * 0.2) : 1);
          if (outputPerSession > 0) costFloor = (inputCostPerSession / outputPerSession) * 1.15;
        }

        if (g.bidPrice >= costFloor) {
          const capacityRoom = Math.max(0, g.capacity - g.stock);
          const cashRoom     = g.cash / Math.max(g.bidPrice, 0.01);
          const qty = Math.min(surplus, have, capacityRoom, cashRoom);
          if (qty > 0.05) {
            const revenue = qty * g.bidPrice;
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
        const SAVINGS_RESERVE = 5;
        const spendableSavings = npc.needs.food < 0.2
          ? npc.savings
          : Math.max(0, npc.savings - SAVINGS_RESERVE);
        if (spendableSavings < 0.5) continue;

        const affordableQty = spendableSavings / Math.max(g.askPrice, 0.01);
        const stockRoom = Math.max(0, g.stock);
        const qty = Math.min(deficit, affordableQty, stockRoom);
        if (qty > 0.05) {
          const cost = qty * g.askPrice;
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

