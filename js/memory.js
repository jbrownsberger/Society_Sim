import { ASSET_TYPES, GOODS, MAX_FARMS, PRODUCTIVE_ASSET_TYPES, PROFESSIONS, countAssetsOfType, countNpcsInProfession, hasWorkableAsset } from './constants.js';
import { adjustSavings, logEvent, world } from './state.js';
import { YEAR_LENGTH } from './npc.js';
import { lambda } from './prices.js';
import { profSessionEV } from './valuation.js';
import { computeConstructionEV, startConstruction } from './construction.js';
import { getIdleAssets } from './actions.js';

// ─────────────────────────────────────────────
// MEMORY & PROFESSION SWITCHING
// ─────────────────────────────────────────────

export function updateMemory(npc) {
  npc.memory.daysSinceSwitch++;
  if (npc.trainingDaysLeft > 0) {
    npc.trainingDaysLeft--;
    if (npc.trainingDaysLeft <= 0) npc.trainingProfession = null;
  }

  // Update personal price history (entries are {price, season} objects).
  // Window extended to 20 so NPCs can accumulate at least one full season
  // of observations for seasonal forecasting.
  for (const good of Object.keys(GOODS)) {
    const hist = world.market.goods[good].priceHistory;
    if (hist.length > 0) {
      npc.memory.priceHistory[good].push(hist[hist.length-1]);
      if (npc.memory.priceHistory[good].length > 20) npc.memory.priceHistory[good].shift();
    }
  }

  // Update smoothed EV for each profession
  const alpha = 0.15;
  for (const profId of Object.keys(PROFESSIONS)) {
    const observed = computeProfessionEV(npc, profId);
    npc.memory.ev[profId] = alpha * observed + (1-alpha) * (npc.memory.ev[profId]??0);
  }
}

export function computeProfessionEV(npc, profId) {
  const prof = PROFESSIONS[profId];
  if (!hasWorkableAsset(npc, profId)) return -999;

  // Use profSessionEV directly (not workSessionEV, which might fall back
  // to a different profession). We want the EV of THIS profId specifically.
  const savedProf = npc.profession;
  let ev;
  try {
    npc.profession = profId;
    ev = profSessionEV(npc, profId);
  } finally {
    npc.profession = savedProf; // FIX: same try/finally guarantee
  }

  if (!isFinite(ev)) return -50;
  return ev;
}

export const SWITCH_PAYBACK_HORIZON = 60; // days over which switching costs are amortized in the decision

// Works out what switching to profId would actually cost this NPC right
// now: materials, a training fee (and to whom), and how long the ramp is.
export function planProfessionSwitch(npc, profId) {
  const prof = PROFESSIONS[profId];
  const materialsCost = prof.materialsCost ?? 0;

  const currentPractitioners = [...world.npcs.values()].filter(n => n.id !== npc.id && n.profession === profId);
  let payees = currentPractitioners;
  if (payees.length === 0) {
    const history = world.professionHistory[profId] ?? [];
    payees = history.map(id => world.npcs.get(id)).filter(n => n && n.id !== npc.id);
  }
  // No one has ever worked this trade (or the only people who have are
  // unavailable) — there's no one to apprentice under, so no training fee.
  const trainingCost = payees.length > 0 ? (prof.trainingCost ?? 0) : 0;

  return { materialsCost, trainingCost, totalCost: materialsCost + trainingCost, trainingDays: prof.trainingDays ?? 0, payees };
}



export const STARVING_FOOD_THRESHOLD = 0.15; // matches the existing starvation energy-penalty threshold
export const STARVATION_MIN_TENURE = 45;     // starving NPCs can still switch much faster than a year,
                                       // but not instantly — prevents the starvation exemption
                                       // from becoming a second, larger-scale herding loophole
// Village-wide daily switch throttle now scales with population instead of
// being a flat 1. A 16-NPC village and a 200-NPC village shouldn't be held
// to the exact same absolute pace — the cap is meant to limit what FRACTION
// of the village can reallocate on a single day, not an arbitrary constant.
// One switch per ~24 residents keeps the same relative throttle strength
// the original design had at 16 NPCs (where 1/day was already a strong cap).
export function maxSwitchesPerDay() {
  return Math.max(1, Math.round(world.npcs.size / 24));
}

export function considerProfessionSwitch(npc) {
  // A trade is a year-long commitment, not a 20-day whim — apprenticeship,
  // tools, and a client base all take time to build, and abandoning that
  // the moment a better number flashes by defeats the point of having
  // switching costs at all. The one exception is genuine starvation: an
  // NPC actually going hungry isn't weighing career opportunity, they're
  // trying to survive, so the lock-in doesn't apply to them.
  // Starvation used to waive the tenure lock entirely (minTenure = 0),
  // which was fine at 16 NPCs but became a loophole at larger populations:
  // more simultaneous hunger meant more NPCs switching through this
  // bypass in the same window, reproducing exactly the same herding
  // cascade the yearly lock was designed to prevent — just rerouted
  // through the "emergency" path instead of the normal one. A starving
  // NPC still gets to jump the queue much faster than a year, but not
  // instantly, which keeps the correction real without making it a mass
  // stampede.
  const isStarving = npc.needs.food < STARVING_FOOD_THRESHOLD;
  const minTenure = isStarving ? STARVATION_MIN_TENURE : YEAR_LENGTH;

  // Village-wide daily cap: even a starving NPC or a very long-tenured one
  // still has to wait their turn if others already switched today. This is
  // the direct fix for the herding cascade — no single day can pull more
  // than a couple of people into (or out of) the same trade at once,
  // giving prices and supply chains real time to adjust between waves.
  if (world.switchesToday >= maxSwitchesPerDay()) return;

  const currentEV = npc.memory.ev[npc.profession] ?? 0;
  let bestAlt = null, bestEV = -Infinity;

  for (const [profId, ev] of Object.entries(npc.memory.ev)) {
    if (profId === npc.profession) continue;
    if (ev > bestEV) { bestEV = ev; bestAlt = profId; }
  }

  // A profession with ZERO current practitioners is a structural
  // emergency, not a career-opportunity whim — e.g. every miller has
  // died, so grain piles up unprocessed while bread runs out for
  // everyone, and nothing else in the sim can fix that except someone
  // stepping in. The year-long tenure lock (and the training-in-progress
  // gate) exists to prevent whimsical trade-hopping; it was never meant
  // to leave a vital supply-chain link permanently vacant just because
  // the person who could fill it switched jobs 40 days ago. The
  // village-wide daily cap above still applies, so this can't turn into
  // a stampede — at most a couple of people can respond to any given
  // vacancy on the same day.
  const bestAltIsVacant = bestAlt && countNpcsInProfession(bestAlt) === 0;

  if (!bestAltIsVacant) {
    if (npc.memory.daysSinceSwitch < minTenure) return;
    if (npc.trainingDaysLeft > 0) return; // still learning the current trade
  }

  // Also consider BUILDING a new asset from scratch — the only way an
  // asset-gated profession (miller, toolmaker, artisan) can ever attract
  // new entrants when every existing asset already has an owner. Without
  // this, real scarcity (e.g. bread) has no way to pull new capacity into
  // existence; it just caps out at however many mills happen to exist.
  let bestConstructAlt = null, bestConstructEV = -Infinity;
  for (const assetType of PRODUCTIVE_ASSET_TYPES) {
    const profId = ASSET_TYPES[assetType].profession;
    if (profId === npc.profession) continue;
    // Farm cap: a real, physical ceiling on food production capacity, not
    // just a soft price signal — this is what gives the village an actual
    // food-based population ceiling rather than an ever-expanding supply
    // of farms chasing an ever-growing population.
    if (assetType === 'farm' && countAssetsOfType('farm') >= MAX_FARMS) continue;
    const cev = computeConstructionEV(npc, profId);
    if (cev > bestConstructEV) { bestConstructEV = cev; bestConstructAlt = assetType; }
  }

  const constructionIsBest = bestConstructAlt && bestConstructEV > bestEV;
  if (constructionIsBest) {
    const threshold = 2 + (1 - npc.traits.riskTolerance) * 6;
    if (bestConstructEV - currentEV > threshold && !npc.constructionProject) {
      if (startConstruction(npc, bestConstructAlt)) {
        npc.memory.daysSinceSwitch = 0; // treat starting a build as a commitment, same lock-in spirit as switching
        world.switchesToday++;
      }
    }
    return; // don't also fall through to an ordinary instant-switch this same call
  }

  if (!bestAlt) return;

  const plan = planProfessionSwitch(npc, bestAlt);

  // Factor the real cost of switching into the decision itself, not just
  // into whether they can afford it. Two components, both converted to
  // the same per-session utility units as bestEV/currentEV so they can be
  // compared directly:
  //   - the upfront cash (materials + training), valued via this NPC's
  //     own shadow price of money (lambda) — the same conversion used
  //     everywhere else in this codebase to compare money against utility.
  //   - the ramp-up period itself: a linear 30%→100% climb over
  //     trainingDays sessions means an average shortfall of 35% of full
  //     output the whole way through, so that's 35% of bestEV, lost, for
  //     trainingDays sessions.
  // Both get amortized over a payback horizon so a great long-run EV isn't
  // blocked forever by short-run setup costs, but isn't free to ignore either.
  const avgRampDeficit = 0.35;
  const rampLoss = bestEV * avgRampDeficit * plan.trainingDays;
  const amortizedCost = (plan.totalCost * lambda(npc) + rampLoss) / SWITCH_PAYBACK_HORIZON;
  const adjustedBestEV = bestEV - amortizedCost;

  const threshold = 2 + (1 - npc.traits.riskTolerance) * 6;
  if (adjustedBestEV - currentEV <= threshold) return;

  // Still have to actually have the upfront cash on hand — this is what
  // throttles a whole village from switching into the same hot trade on
  // the same day, since only the currently-wealthy can afford entry.
  if (npc.savings < plan.totalCost) return;

  adjustSavings(npc, -plan.materialsCost, 'profession_switch');
  world.market.goods.tools.cash += plan.materialsCost; // bought equipment/materials through the Market

  if (plan.trainingCost > 0 && plan.payees.length > 0) {
    const share = plan.trainingCost / plan.payees.length;
    for (const payee of plan.payees) adjustSavings(payee, share, 'training_fee');
    adjustSavings(npc, -plan.trainingCost, 'profession_switch');
  }

  // Record the leaver so whoever switches into this trade next still has
  // someone to pay, even once every current practitioner has moved on.
  const hist = world.professionHistory[npc.profession] ?? (world.professionHistory[npc.profession] = []);
  hist.unshift(npc.id);
  if (hist.length > 3) hist.pop();

  const costNote = plan.totalCost > 0.01
    ? ` (${plan.totalCost.toFixed(0)}¢: ${plan.materialsCost.toFixed(0)}¢ materials${plan.trainingCost > 0 ? ', ' + plan.trainingCost.toFixed(0) + '¢ training' : ''})`
    : ' (self-taught)';
  logEvent(`${npc.name} left ${PROFESSIONS[npc.profession].name} to become a ${PROFESSIONS[bestAlt].name}${costNote}.`, [npc.id]);

  npc.profession = bestAlt;
  npc.trainingProfession = bestAlt;
  npc.trainingDaysLeft = plan.trainingDays;
  npc.memory.daysSinceSwitch = 0;
  world.switchesToday++;

  // CRITICAL: if the OLD profession required an asset, npc.primaryAsset
  // still points at it — but it's no longer being worked. Without clearing
  // this, getIdleAssets() (which explicitly excludes a.id === primaryAsset)
  // permanently treats a now-unworked asset as "not idle," so it can never
  // be listed for sale or staffed by hired labor. This was the root cause
  // of a slow village-wide collapse: NPCs kept switching away from asset
  // professions into woodcutting, but their farms/mills/forges silently
  // vanished from circulation instead of becoming available to someone
  // who'd actually use them.
  const newProfNeedsAsset = Object.keys(ASSET_TYPES).some(t => ASSET_TYPES[t].profession === bestAlt);
  if (!newProfNeedsAsset) {
    npc.primaryAsset = null; // now genuinely idle — will surface in getIdleAssets()
  } else {
    // Switching INTO another asset-gated profession — only valid if they
    // already own a matching asset (hasWorkableAsset gated this decision
    // via computeProfessionEV), so re-point primaryAsset at THAT asset.
    const matchingAsset = npc.ownedAssets
      .map(id => world.assets.get(id))
      .find(a => a && ASSET_TYPES[a.type].profession === bestAlt);
    npc.primaryAsset = matchingAsset ? matchingAsset.id : null;
    if (matchingAsset) matchingAsset.idleSinceDay = undefined; // now primary again, not idle
  }
}

