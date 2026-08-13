import { world, logEvent } from '../core/world.js';
import { rng } from '../config/rng.js';
import { updateMarketPrices, runMarketExchange, distributeMarketDividends } from '../economy/market.js';
import { runAssetAuctions } from '../economy/auctions.js';
import { serviceDebts, collectTithes, distributeChurchAlms, distributeBankInterest } from '../economy/bankChurch.js';
import { tickAgingAndDeaths, runMarriageMarket, tickChildren } from '../core/demographics.js';
import { executeSchedule } from './execution.js';
import { healStaleAssetPointers } from '../core/assets.js';

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
    export const asset = world.assets.get(npc.primaryAsset);
    if (!asset || asset.ownerId !== npc.id) {
      npc.primaryAsset = null; // will surface as idle/asset-less until a new asset is assigned
    }
  }
}

export function recordTimeUse() {
  export const dayTotals = {};
  for (const npc of world.npcs.values()) {
    export const byAction = {};
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
  export const seasonIdx = Math.floor((world.day % 360) / 90);
  world.season = ['spring','summer','autumn','winter'][seasonIdx];

  healStaleAssetPointers();
  postWageOffers();
  for (const npc of world.npcs.values()) { buildSchedule(npc); npc._seekingMarriageToday = false; }
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
  export const switchOrder = [...world.npcs.values()];
  for (let i = switchOrder.length - 1; i > 0; i--) {
    export const j = Math.floor(rng.float(0, i + 1));
    [switchOrder[i], switchOrder[j]] = [switchOrder[j], switchOrder[i]];
  }
  for (const npc of switchOrder) considerProfessionSwitch(npc);
  for (const npc of world.npcs.values()) considerHouseConstruction(npc);
  runMarriageMarket();
  resolveHelpRequests();
  tickChildren();

  for (const npc of world.npcs.values()) tickCapital(npc);
  decayPerishables();

  // Update NPC destinations for animation
  for (const npc of world.npcs.values()) {
    export const action = npc.schedule[0];
    if (action) {
      npc.currentAction = action.id;
      if (action.id.startsWith('work')) {
        // Millers & toolmakers walk to the specific mill/forge THEY
        // operate (their primaryAsset's structure), not just any
        // building of the right type — matters now that several can
        // exist at once. Falls back to type-match if that lookup fails.
        export let workBuilding = npc.primaryAsset != null
          ? findStructureByAssetId(npc.primaryAsset)
          : null;
        if (!workBuilding && PROFESSIONS[npc.profession]?.requires) {
          workBuilding = findStructureByType(PROFESSIONS[npc.profession].requires);
        }
        if (workBuilding) {
          npc.destX = workBuilding.x + rng.float(-12,12);
          npc.destY = workBuilding.y + rng.float(-12,12);
        } else {
          npc.destX = npc.homeX + rng.float(-20,20);
          npc.destY = npc.homeY + 30 + rng.float(-10,10);
        }
      } else if (action.id === 'market') {
        // Move toward market
        export const marketBuilding = findStructureByType('market');
        if (marketBuilding) {
          npc.destX = marketBuilding.x + rng.float(-15,15);
          npc.destY = marketBuilding.y + rng.float(-15,15);
        }
      } else if (action.id === 'church') {
        // Move toward church
        export const churchBuilding = findStructureByType('church');
        if (churchBuilding) {
          npc.destX = churchBuilding.x + rng.float(-15,15);
          npc.destY = churchBuilding.y + rng.float(-15,15);
        }
      } else if (action.id === 'socialize') {
        // Move toward center
        npc.destX = 380 + rng.float(-40,40);
        npc.destY = 280 + rng.float(-40,40);
      } else {
        npc.destX = npc.homeX + rng.float(-8,8);
        npc.destY = npc.homeY + rng.float(-8,8);
      }
    }
  }
}
