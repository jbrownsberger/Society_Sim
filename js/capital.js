import { GOODS } from './constants.js';
import { logEvent, world } from './state.js';
import { TITHE_CAP, TITHE_RATE } from './actions.js';

// ─────────────────────────────────────────────
// CAPITAL & PERISHABLES
// ─────────────────────────────────────────────

export function tickCapital(npc) {
  // Capital is now just npc.inventory.tools — bought from toolmakers at
  // market price, decays via decayPerishables. No phantom money sink.
  // Keep npc.capital in sync for the UI display only.
  npc.capital = npc.inventory.tools ?? 0;
}

export function decayPerishables() {
  for (const npc of world.npcs.values()) {
    for (const [good, rate] of Object.entries(GOODS).map(([g,d])=>[g,d.perishRate])) {
      if (rate > 0 && npc.inventory[good] > 0) {
        npc.inventory[good] *= (1 - rate);
      }
    }
  }
}



// The Market learns its own scale from experience: if a good keeps running
// out (repeated unmet demand), that's a granary that's too small for how
// this village actually consumes — the target stock (and capacity, which
// tracks it proportionally) grows to match. If a good keeps piling up
// unsold (repeated unmet supply — a glut the Market won't absorb), the
// target shrinks back down. Either way this is gradual: one bad day
// doesn't resize a warehouse, a week-plus of a consistent pattern does.
export const STREAK_THRESHOLD = 7;   // consecutive days of real pressure before adapting
export const ADAPT_STEP = 0.12;      // proportional resize per adaptation event

export function adaptMarketStockTargets() {
  for (const good of Object.keys(GOODS)) {
    const g = world.market.goods[good];
    // "Real" pressure — small numerical noise near zero shouldn't count.
    const shortage = g.unmetDemand > 0.5;
    const glut     = g.unmetSupply > 0.5;

    g.shortageStreak = shortage ? g.shortageStreak + 1 : 0;
    g.glutStreak     = glut     ? g.glutStreak + 1     : 0;

    if (g.shortageStreak >= STREAK_THRESHOLD) {
      g.targetStock = Math.min(g.targetStockMax, g.targetStock * (1 + ADAPT_STEP));
      g.capacity    = g.targetStock * g.capacityRatio;
      g.shortageStreak = 0;
      logEvent(`The Market expands its ${GOODS[good].name.toLowerCase()} storage — demand has outstripped supply for weeks.`);
    } else if (g.glutStreak >= STREAK_THRESHOLD) {
      g.targetStock = Math.max(g.targetStockMin, g.targetStock * (1 - ADAPT_STEP));
      g.capacity    = g.targetStock * g.capacityRatio;
      g.glutStreak = 0;
    }
  }
}

// The Market's profit — the bid/ask spread it keeps on every trade — has
// nowhere to go by default, and testing showed that's a real problem: it
// silently vacuums money out of the village with no return path. This
// function shares it back out. Each good's cash pool above its own
// operating reserve (targetStock × baseValue × 4 — the same formula used
// to seed it) gives up a fraction each day; the combined pool is split
// among today's market-goers in proportion to time spent there. Nobody
// visiting means the pool just keeps accumulating for whenever someone
// finally does — an incentive that compounds the longer it's ignored.
export const DIVIDEND_SHARE_RATE = 0.2; // fraction of each good's excess-above-reserve shared per day

export function distributeMarketDividends() {
  // Start from any pool left over from a day nobody visited the Market —
  // previously this was silently discarded, which was a real money sink:
  // coins were already deducted from each good's cash reserve above, so
  // failing to hand them to anyone destroyed them outright rather than
  // merely delaying payment. Now it's carried forward until someone visits.
  let pool = world.market.dividendCarry || 0;
  for (const good of Object.keys(GOODS)) {
    const g = world.market.goods[good];
    const reserve = g.targetStock * GOODS[good].baseValue * 4;
    const excess = Math.max(0, g.cash - reserve);
    const share = excess * DIVIDEND_SHARE_RATE;
    g.cash -= share;
    pool += share;
  }

  const visitors = world.market.visitorsToday;
  const totalHours = visitors.reduce((s, v) => s + v.duration, 0);
  world.market.dividendPoolToday = pool;

  if (pool > 0.01 && totalHours > 0.01) {
    for (const { npc, duration } of visitors) {
      const share = pool * (duration / totalHours);
      npc.savings += share;
      npc.lastDividend = share;
    }
    const perHour = pool / totalHours;
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

export function collectTithes() {
  for (const npc of world.npcs.values()) {
    const visit = npc.schedule.find(a => a.id === 'church');
    if (!visit) continue;
    const tithe = Math.min(Math.max(0, npc.savings) * TITHE_RATE, TITHE_CAP);
    if (tithe > 0.01) {
      npc.savings -= tithe;
      world.church.cash += tithe;
    }
  }
}
