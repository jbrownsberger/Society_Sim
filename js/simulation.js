import { rng } from './rng.js';
import { TIME_USE_WINDOW, tickRelationDecay, world } from './state.js';
import { postWageOffers } from './labor.js';
import { updateAssetDistressStreaks } from './actions.js';
import { resolveHelpRequests, runMarriageMarket, tickChildren } from './marriage.js';
import { tickAgingAndDeaths } from './death.js';
import { applyBdiDayIfEnabled, shadowDeliberateAll } from './scheduleBdi.js';
import { executeSchedule } from './execution.js';
import { satisfyNeeds } from './needs.js';
import { runMarketExchange, updateMarketPrices } from './market.js';
import { updateMemory } from './memory.js';
import { bdiReconsiderHousing, bdiReconsiderProfession } from './bdiAgent.js';
import { adaptMarketStockTargets, collectTithes, decayPerishables, distributeMarketDividends, tickCapital } from './capital.js';
import { AUCTION_PERIOD_DAYS, distributeBankInterest, distributeChurchAlms, runAssetAuctions, serviceDebts } from './auctions.js';

// ─────────────────────────────────────────────
// MAIN SIMULATION TICK
// ─────────────────────────────────────────────

// Defensive self-healing check: verifies every NPC's primaryAsset
// actually points at an asset THEY own. This is a safety net against the
// exact corruption class just fixed (a thrown exception inside a
// hypothetical profession/asset swap leaving primaryAsset pointing at
// someone else's asset) — even with the try/finally fixes in place, this
// catches any already-corrupted state from a prior run/save, and guards
// against any similar swap-and-restore pattern added in the future that
// might reintroduce the same bug. Self-heals by clearing the stale
// pointer rather than crashing or silently propagating bad state.
export function healStaleAssetPointers() {
  for (const npc of world.npcs.values()) {
    if (npc.primaryAsset === null || npc.primaryAsset === undefined) continue;
    const asset = world.assets.get(npc.primaryAsset);
    if (!asset || asset.ownerId !== npc.id) {
      npc.primaryAsset = null; // will surface as idle/asset-less until a new asset is assigned
    }
  }
}

export function recordTimeUse() {
  const dayTotals = {};
  for (const npc of world.npcs.values()) {
    const byAction = {};
    for (const action of npc.schedule) {
      byAction[action.id] = (byAction[action.id] || 0) + action.duration;
      dayTotals[action.id] = (dayTotals[action.id] || 0) + action.duration;
    }
    npc.timeUseHistory.push({ day: world.day, byAction });
    if (npc.timeUseHistory.length > TIME_USE_WINDOW) npc.timeUseHistory.shift();
  }
  world.timeUseHistory.push({ day: world.day, byAction: dayTotals });
  if (world.timeUseHistory.length > TIME_USE_WINDOW) world.timeUseHistory.shift();
}

export function tickDay() {
  world.day++;
  const seasonIdx = Math.floor((world.day % 360) / 90);
  world.season = ['spring','summer','autumn','winter'][seasonIdx];

  healStaleAssetPointers();
  postWageOffers();
  // BDI deliberation is the only path that forms a daily plan. It first
  // revises the rolling intention from current beliefs, then turns that
  // intention into today's bounded set of executable actions.
  shadowDeliberateAll();
  for (const npc of world.npcs.values()) { applyBdiDayIfEnabled(npc); npc._seekingMarriageToday = false; }
  recordTimeUse();
  // NPCs work first, accumulating output. Then the Market re-prices off
  // yesterday's stock and trades with each NPC individually — no peer-to-
  // peer matching, no auction. All money flows happen inside
  // runMarketExchange (executeSchedule only moves goods for work actions)
  // so conservation still holds.
  for (const npc of world.npcs.values()) executeSchedule(npc);
  updateMarketPrices();
  runMarketExchange();
  adaptMarketStockTargets();
  distributeMarketDividends();
  collectTithes();
  distributeChurchAlms();
  if (world.day % AUCTION_PERIOD_DAYS === 0) runAssetAuctions();
  serviceDebts();
  distributeBankInterest();
  for (const npc of world.npcs.values()) satisfyNeeds(npc);
  tickRelationDecay();
  tickAgingAndDeaths();
  for (const npc of world.npcs.values()) updateAssetDistressStreaks(npc);
  // Construction now advances inside executeSchedule (see completeConstruction),
  // triggered by actually executing 'build' schedule actions rather than
  // a separate daily calendar pass.
  for (const npc of world.npcs.values()) updateMemory(npc);

  // Shuffle order before considering switches — maxSwitchesPerDay() caps
  // how many go through today, and without shuffling, whoever happens
  // first in iteration order would always win any contention.
  world.switchesToday = 0;
  const switchOrder = [...world.npcs.values()];
  for (let i = switchOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng.float(0, i + 1));
    [switchOrder[i], switchOrder[j]] = [switchOrder[j], switchOrder[i]];
  }
  for (const npc of switchOrder) bdiReconsiderProfession(npc);
  for (const npc of world.npcs.values()) bdiReconsiderHousing(npc);
  runMarriageMarket();
  resolveHelpRequests();
  tickChildren();

  for (const npc of world.npcs.values()) tickCapital(npc);
  decayPerishables();

  // NOTE: NPC destX/destY/currentAction are no longer set here. Once
  // today's schedule is finalized above, the purely-visual sub-day
  // clock in movement.js (driven every animation frame from
  // drawScene(dayFraction) in render.js) walks npc.schedule itself to
  // decide where each NPC should currently be drawn walking toward.
  // That split is deliberate: this function has already fully resolved
  // every economic consequence of today's schedule by this point
  // (executeSchedule ran earlier in this same tick), so the animation
  // system is free to consume npc.schedule at its own pace — even
  // "periodically" per the requirement that the visual layer reflect
  // the simulation without being load-bearing for it.
}
