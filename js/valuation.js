import { LABOR_DISUTILITY, PROFESSIONS, SEASONAL_GRAIN, buildingProductivity, hasWorkableAsset } from './constants.js';
import { world } from './state.js';
import { expectedPrice, lambda, marketAsk } from './prices.js';
import { effectiveSkill } from './death.js';

// ─────────────────────────────────────────────
// WORK SESSION VALUATION
// ─────────────────────────────────────────────

// Net utility of committing to one full work session (6 hrs).
// Accounts for revenue, input costs (buying if necessary), energy,
// and labour disutility. This is the true incentive signal:
//   high output price  → high EV → NPC works more
//   high input price   → low EV  → NPC works less or switches profession
//   high lambda        → high EV → desperate NPC works even at low wages
//   low lambda         → low EV  → comfortable NPC takes leisure instead
// Compute EV of one work session for a given profId, given this NPC's state.
// A trailing average of recent midPrice history, NOT today's snapshot.
// Used specifically for profSessionEV's REVENUE projection (see below) —
// a profession switch is a long-term commitment (year-long tenure lock),
// so it should be evaluated against a price TREND, not whatever the spot
// price happens to read on the one day the decision is made. Input costs
// still use marketAsk (the real price paid right now) unchanged — that
// asymmetry is deliberate: you pay today's real price for materials, but
// shouldn't assume today's possibly-transient output price holds for a
// whole session's worth of future work. Verified via harness: even after
// fixing the false-homelessness construction bug, a purely transient
// ~10-day market-settling wood price blip (unrelated to any real,
// sustained demand) was still enough to push farmer count from 24 to 9
// within 40 days, because profSessionEV compared today's spot wood price
// against grain's, with nothing to distinguish a blip from a trend.
export function smoothedExpectedPrice(npc, good, days = 10) {
  const hist = world.market.goods[good]?.priceHistory;
  if (!hist || hist.length === 0) return expectedPrice(npc, good);
  const recent = hist.slice(-days);
  return recent.reduce((s, h) => s + h.price, 0) / recent.length;
}

export function profSessionEV(npc, profId, ignoreAssetGate) {
  const prof = PROFESSIONS[profId];
  if (!prof) return -Infinity;
  if (!ignoreAssetGate && !hasWorkableAsset(npc, profId)) return -Infinity;
  if (npc.energy < 20) return -Infinity;

  const lam      = lambda(npc);
  const skill    = effectiveSkill(npc, profId);
  const capMod   = prof.capitalGood ? (1 + Math.log1p(npc.inventory.tools ?? 0) * 0.2) : 1;
  const buildMod = buildingProductivity(profId);
  const seasonal = profId === 'farmer' ? (SEASONAL_GRAIN[world.season] || 1) : 1;
  const ENERGY_SHADOW = 0.05;

  let revenue = 0;
  for (const [g, qty] of Object.entries(prof.outputs)) {
    revenue += qty * skill * capMod * buildMod * seasonal * smoothedExpectedPrice(npc, g);
  }

  let inputCashCost = 0;
  for (const [g, qty] of Object.entries(prof.inputs)) {
    const shortfall = Math.max(0, qty - (npc.inventory[g] ?? 0));
    // A downstream trade cannot turn a high output price into real output
    // when its missing input is absent from the market. This is especially
    // important to recovery: otherwise a bread shortage makes a new mill
    // look profitable even after the village has run out of grain.
    if (shortfall > 0 && (world.market.goods[g]?.stock ?? 0) + 0.01 < shortfall) return -Infinity;
    inputCashCost += shortfall * marketAsk(g);
  }

  if (inputCashCost > npc.savings + 0.01) return -Infinity;

  const netCoins = revenue - inputCashCost;
  return netCoins * lam - 25 * ENERGY_SHADOW - LABOR_DISUTILITY * 6;
}

// workSessionEV: returns { ev, profId } for the best available work today.
// Tries the NPC's primary profession first. If that's blocked (inputs
// unaffordable), falls back to no-input professions (farmer, woodcutter).
// A broke miller doesn't rest — they help with the harvest until they can
// afford grain again. The NPC keeps their profession identity; this is
// casual day-labour, not a switch.
