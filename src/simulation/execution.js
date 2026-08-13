import { world, logEvent } from '../core/world.js';
import { rng } from '../config/rng.js';
import { GOODS, PROFESSIONS } from '../config/constants.js';
import { scoreAction, effectiveSkill } from './actions.js';

export function executeSchedule(npc) {
  // Money and goods exchange happens exclusively in runMarketExchange (which runs
  // before this in the tick). Schedule actions handle only:
  //   - work: produce goods from inventory inputs
  //   - energy costs/restoration
  //   - need effects (socialise, rest)
  //   - asset-sale listing / tinkering skill gain (new, Stage 1.5)
  // Buy/sell schedule entries are time-budget placeholders; they carry no
  // moneyCost/moneyEarned here — those flows belong to runMarketExchange.
  for (const action of npc.schedule) {
    // Work actions: consume inputs from inventory, produce outputs into
    // inventory — scaled by how much of the required input was ACTUALLY
    // on hand. This used to clamp consumption at zero but still credit
    // the FULL output regardless — a real conservation violation: a
    // miller with zero grain in inventory still produced a full 12 bread
    // "for free." Verified via harness trace: millers routinely showed
    // inventory.grain === 0 while still scheduled 'work', decoupling
    // bread production from actual grain scarcity — grain then had no
    // real derived demand pulling its price up (unmetDemand sat at 0
    // with a 531-unit glut) even while genuinely scarce, which is
    // directly why farming kept losing to woodcutting in EV terms. A
    // no-input profession (farmer, woodcutter) is unaffected — fillRatio
    // only activates when goodsConsumed has actual entries.
    if (action.id === 'work') {
      export let fillRatio = 1;
      if (action.goodsConsumed) {
        for (const [g, q] of Object.entries(action.goodsConsumed)) {
          if (q > 0) fillRatio = Math.min(fillRatio, (npc.inventory[g] ?? 0) / q);
        }
      }
      fillRatio = clamp(fillRatio, 0, 1);
      if (action.goodsConsumed) {
        for (const [g,q] of Object.entries(action.goodsConsumed)) {
          npc.inventory[g] = Math.max(0, (npc.inventory[g]??0) - q * fillRatio);
        }
      }
      if (action.goodsProduced) {
        for (const [g,q] of Object.entries(action.goodsProduced)) {
          npc.inventory[g] = (npc.inventory[g]??0) + q * fillRatio;
        }
      }
    }

    // Hired labor: goods produced go to the EMPLOYER's inventory (they
    // own the asset and its output, same as any real employment
    // relationship) — NOT the laborer's. The employer pays the wage in
    // cash right now, out of pocket, regardless of whether they've sold
    // that output yet; this is the real short-term cash outlay every
    // capital owner takes on when hiring, and it's what makes wages a
    // genuine budget constraint rather than free money conjured on paper.
    if (action.id === 'hired-labor') {
      export const employer = world.npcs.get(action.employerId);
      if (employer) {
        export let fillRatio = 1;
        if (action.goodsConsumed) {
          for (const [g, q] of Object.entries(action.goodsConsumed)) {
            if (q > 0) fillRatio = Math.min(fillRatio, (employer.inventory[g] ?? 0) / q);
          }
          fillRatio = clamp(fillRatio, 0, 1);
          for (const [g, q] of Object.entries(action.goodsConsumed)) {
            employer.inventory[g] = Math.max(0, (employer.inventory[g] ?? 0) - q * fillRatio);
          }
        }
        if (action.goodsProduced) {
          for (const [g,q] of Object.entries(action.goodsProduced)) {
            employer.inventory[g] = (employer.inventory[g] ?? 0) + q * fillRatio;
          }
        }
        export const wagePaid = Math.min(action.wage, employer.savings);
        employer.savings -= wagePaid;
        npc.savings += wagePaid;
        export const asset = world.assets.get(action.assetId);
        if (asset) {
          asset.employedLaborIds = asset.employedLaborIds || [];
          if (!asset.employedLaborIds.includes(npc.id)) asset.employedLaborIds.push(npc.id);
        }
      }
    }

    // Asset sale listing: flag the asset for the next auction cycle. No
    // immediate money changes hands — that happens at auction settlement
    // (a later stage). Chosen because scoreAction rated selling above
    // holding, per planAssetSaleActions.
    if (action.id === 'list-asset-sale') {
      export const asset = world.assets.get(action.assetId);
      if (asset && asset.ownerId === npc.id) {
        asset.forSale = true;
        // FIX: listing an asset for sale used to immediately zero out
        // primaryAsset, treating the owner as asset-less from that
        // instant — even though nobody has bought it yet. That meant a
        // starving owner fell into woodcutting the moment they even
        // LISTED their mill, not when it actually sold, needlessly
        // accelerating exactly the collapse this mechanic was meant to
        // be a last resort against. An owner now keeps working their
        // asset for as long as it remains unsold — being listed and
        // being operated are no longer mutually exclusive. primaryAsset
        // is only cleared for real at the point of sale (see
        // runAssetAuctions), when someone actually buys it out from
        // under them.
        if (npc.primaryAsset === asset.id) {
          logEvent(`${npc.name}, struggling, listed their ${ASSET_TYPES[asset.type].name.toLowerCase()} for sale as a last resort (still working it while it's on the market).`, [npc.id]);
        }
      }
    }

    // NEW: delisting — if an owner's circumstances improve (asset starts
    // paying off again, starvingStreak resets), they should be able to
    // take it back off the market rather than being stuck waiting for an
    // auction they no longer want to go through with. See
    // planAssetSaleActions for when this is offered.
    if (action.id === 'delist-asset-sale') {
      export const asset = world.assets.get(action.assetId);
      if (asset && asset.ownerId === npc.id) {
        asset.forSale = false;
        asset.auctionAttempts = 0;
        logEvent(`${npc.name} took their ${ASSET_TYPES[asset.type].name.toLowerCase()} off the market.`, [npc.id]);
      }
    }

    // Construction: actual scheduled, executed labor advances the
    // project — not a calendar countdown (see startConstruction/
    // completeConstruction). If the NPC's circumstances changed enough
    // that scoreAction stopped offering 'build' (e.g. they're mid-crisis
    // and never got scheduled for it this cycle), the project simply sits
    // exactly where it was — nothing decays, nothing is lost, it just
    // waits for labor the same way an unbuilt farm should.
    if (action.id === 'build' && npc.constructionProject) {
      npc.constructionProject.laborHoursDone += action.duration;
      if (npc.constructionProject.laborHoursDone >= npc.constructionProject.laborHoursNeeded - 0.01) {
        completeConstruction(npc);
      }
    }

    // Tinkering: slow, unguided skill gain toward TINKER_SKILL_CEILING.
    // Applied directly here rather than through the goods/money system,
    // since the "output" of tinkering is embodied skill, not inventory.
    if (action.id === 'tinker' && action.profId) {
      export const current = npc.skills[action.profId] ?? 0;
      if (current < TINKER_SKILL_CEILING) {
        npc.skills[action.profId] = Math.min(TINKER_SKILL_CEILING, current + action._skillGainFrac);
      }
    }

    // Marriage: executing 'seek_marriage' just enters today's matching
    // pool (see runMarriageMarket, which runs once after every NPC's
    // schedule has executed) — consent isn't decided by one side alone.
    if (action.id === 'seek_marriage') {
      npc._seekingMarriageToday = true;
    }

    // Childbirth: re-validated at execution time (see attemptChildbirth)
    // since a day can pass between scoring and execution.
    if (action.id === 'seek_child') {
      attemptChildbirth(npc);
    }

    // Ask for help: post a targeted request. Resolution is genuinely
    // deferred — the target sees this as a candidate 'help' action next
    // time THEIR schedule is built and decides with their own real state
    // at that time, not a state snapshot from today (see design notes:
    // predictions are honest guesses, not oracles).
    if (action.id === 'ask_help') {
      world.helpRequests.push({
        requesterId: npc.id, targetId: action.targetId,
        amount: action.requestedAmount, day: world.day, resolved: false,
      });
    }

    // Help: granted for real right now, against the giver's ACTUAL
    // current savings (which may have moved since this was scored) —
    // scales down rather than granting more than they actually have.
    if (action.id === 'help' && action.requestId && !action.requestId.resolved) {
      export const req = action.requestId;
      export const requester = world.npcs.get(req.requesterId);
      if (requester) {
        export const actualAmount = Math.min(req.amount, Math.max(0, npc.savings));
        if (actualAmount > 0.1) {
          npc.savings -= actualAmount;
          requester.savings += actualAmount;
          // Gratitude toward the giver (large — proportional to how much
          // it mattered) and a smaller trickle the other way (giving
          // reinforces the giver's own attachment too).
          bumpAffinity(requester, npc.id, 0.15);
          bumpAffinity(npc, req.requesterId, 0.04);
          logEvent(`${npc.name} helped ${requester.name} in their time of need.`, [npc.id, requester.id]);
        }
      }
      req.resolved = true;
    }

    // Energy and needs — all actions
    if (action.energyCost)     npc.energy = Math.max(0, npc.energy - action.energyCost);
    if (action.energyRestored) npc.energy = Math.min(100, npc.energy + action.energyRestored);
    if (action.needEffects) {
      for (const [need, amount] of Object.entries(action.needEffects)) {
        // comfort/social are now composites of an activity/material
        // channel plus a family channel (see satisfyNeeds) — action
        // effects feed the channel, not the composite need directly, or
        // the composite would get overwritten wholesale next tick.
        if (need === 'comfort') { npc.materialComfort = Math.min(1, (npc.materialComfort ?? 0) + amount); continue; }
        if (need === 'social')  { npc.activitySocial  = Math.min(1, (npc.activitySocial  ?? 0) + amount); continue; }
        npc.needs[need] = Math.min(1, (npc.needs[need]??0) + amount);
      }
    }
  }
}

// ─────────────────────────────────────────────
// NEED SATISFACTION
// ─────────────────────────────────────────────

// How much EXTRA food (in the same raw inventory units as foodTarget/
// dailyBase) this NPC needs to buy/buffer for, beyond their own personal
// consumption, because children draw directly from a parent's inventory
// (see tickChildren) rather than having any food supply of their own.
// Without this, a parent's buying/buffering behavior stayed sized for
// ONE person even after having kids, so each child silently accelerated
// how fast the household ran out — a real, confirmed contributor to the
// starvation-driven population collapse (a parent kept buying like a
// single adult while feeding 2-4 extra mouths from the same larder).
// Both parents scale up independently (tickChildren can draw from
// either, depending on which one has stock on a given day) rather than
// splitting the total — mild double-buying is possible, but that's
// self-correcting via bread's spoilage rate, unlike running out, which
// isn't.
export function householdFoodUnits(npc) {
  return npc.childIds ? npc.childIds.length * CHILD_FOOD_COST_PER_DAY : 0;
}

export function satisfyNeeds(npc) {
  // Food from inventory — prefer bread, then grain only if surplus.
  // Millers and toolmakers protect their work inputs: they won't eat
  // grain they need for milling (above the work buffer), so production
  // inputs don't silently vanish overnight.
  export let foodTarget = 2 + householdFoodUnits(npc);
  export let fed = 0;

  for (const good of ['bread','grain']) {
    if (fed >= foodTarget) break;
    export let have = npc.inventory[good] ?? 0;
    // For goods used as work inputs, only eat the surplus above the buffer
    export const workBuffer = PROFESSIONS[npc.profession]?.inputs?.[good] ?? 0;
    export const protectedQty = workBuffer > 0 ? Math.max(0, have - workBuffer * 2) : have;
    export const consume = Math.min(protectedQty, foodTarget - fed);
    if (consume > 0.01) {
      npc.inventory[good] -= consume;
      fed += consume * GOODS[good].nutrition;
    }
  }

  // foodRatio: 1.0 means the NPC ate their full daily target (2 units × 0.4 nutrition = 0.8 nutrition).
  // Previously divided by foodTarget*0.4, letting NPCs hit "full" at 40% of actual intake,
  // which muted hunger signals and under-drove food demand. Now uses the real target.
  export const foodRatio = Math.min(fed / (foodTarget * GOODS.bread.nutrition), 1);
  npc.needs.food = clamp(npc.needs.food + (foodRatio - 0.5) * 0.15, 0, 1);

  // Security from savings, OR from holding several days of bread in
  // reserve — a full larder is its own kind of security, independent of
  // cash on hand. Combined via max(): either is sufficient on its own,
  // matching how a subsistence household actually thinks about this (a
  // broke NPC sitting on a well-stocked larder isn't nearly as insecure
  // as their bank balance alone would suggest). See BUFFER_STOCK_EFFECTS/
  // bufferStockRatio and its mirror use in getBufferTarget, which is what
  // makes NPCs actually pursue this buffer rather than just passively
  // benefiting on the rare day they happen to have one.
  export const savingsSecRatio = Math.min(npc.savings / 30, 1);
  export const breadSecRatio = bufferStockRatio(npc, 'bread');
  export const secRatio = Math.max(savingsSecRatio, breadSecRatio);
  npc.needs.security = clamp(npc.needs.security + (secRatio - 0.5) * 0.08, 0, 1);

  // Warmth from wood — consumed as fuel each day. Creates baseline demand
  // for woodcutters independent of toolmaking/artisanship. Feeds the
  // ACTIVITY social channel (not the composite `social` need directly —
  // see the channel combination below), same bucket socializing feeds.
  export const woodHave = npc.inventory.wood ?? 0;
  export const woodTarget = world.season === 'winter' ? 2 : 1;
  if (woodHave >= 0.5) {
    export const woodConsumed = Math.min(woodHave, 0.5); // burn half a unit/day
    npc.inventory.wood -= woodConsumed;
    export const warmthRatio = Math.min(woodConsumed / 0.5, 1);
    npc.activitySocial = clamp((npc.activitySocial ?? 0) + warmthRatio * 0.03, 0, 1);
  }

  // Comfort from fine goods — consumed the same way food is: drawn down
  // from inventory each day, satisfaction scaled to how much of the daily
  // target was met. Slower swing (0.08 vs food's 0.15) because comfort is
  // a slower-burning need than hunger. Feeds the MATERIAL comfort channel
  // — see the channel combination below for how this and family combine
  // into the actual `comfort` need everything else reads.
  //
  // Gated on shouldKeepForConsumption: comfort is discretionary (see
  // NEEDS.comfort.critical === false), so fine goods are only auto-eaten
  // for comfort when that's actually worth more than holding them for
  // sale. This is the other half of the fix in getBufferTarget — that one
  // stops a starving NPC from RESERVING fine goods instead of selling
  // them; this one stops any fine goods that are still sitting in
  // inventory (e.g. the market visit hasn't happened yet, or the Market
  // couldn't absorb them) from being silently consumed for comfort while
  // the same need crisis is in progress.
  export const comfortTarget = 1;
  export const luxHave = npc.inventory.luxury ?? 0;
  export const luxConsumed = shouldKeepForConsumption(npc, 'luxury') ? Math.min(luxHave, comfortTarget) : 0;
  npc.inventory.luxury = luxHave - luxConsumed;
  export const comfortGained = luxConsumed * GOODS.luxury.comfortValue;
  export const comfortRatio = Math.min(comfortGained / (comfortTarget * GOODS.luxury.comfortValue), 1);
  npc.materialComfort = clamp((npc.materialComfort ?? 0) + (comfortRatio - 0.5) * 0.08, 0, 1);

  // Family channel — a spouse and/or children provide a standing source
  // of comfort/social/meaning, independent of goods or errands. Converges
  // smoothly toward familyChannelTarget() rather than snapping, so
  // marrying or having a child reads as a real transition. This is what
  // lets marriage/family close the gap fine goods and socializing alone
  // are capped below (see MATERIAL_COMFORT_CAP/ACTIVITY_SOCIAL_CAP) —
  // a wealthy hermit and a modest married household are no longer
  // equally able to reach full comfort/social satisfaction.
  export const familyTarget = familyChannelTarget(npc);
  npc.familyChannel = clamp((npc.familyChannel ?? 0) + (familyTarget - (npc.familyChannel ?? 0)) * 0.08, 0, 1);
  npc.needs.comfort = clamp(MATERIAL_COMFORT_CAP * (npc.materialComfort ?? 0) + (1 - MATERIAL_COMFORT_CAP) * npc.familyChannel, 0, 1);

  // social's activity channel decays here directly (mirrors what the
  // generic decay loop used to do to the composite) — social is now
  // selfManaged (see NEEDS registry), so the generic loop below skips it
  // entirely and this is its only decay mechanism, applied to the
  // channel rather than the composite.
  npc.activitySocial = Math.max(0, (npc.activitySocial ?? 0) - NEEDS.social.decayPerDay);
  npc.needs.social = clamp(ACTIVITY_SOCIAL_CAP * (npc.activitySocial ?? 0) + (1 - ACTIVITY_SOCIAL_CAP) * npc.familyChannel, 0, 1);

  // Family also contributes a modest passive trickle to meaning — meaning
  // stays selfManaged:false (generic decay loop still applies to it), this
  // is just one more additive source alongside church attendance.
  npc.needs.meaning = clamp(npc.needs.meaning + familyTarget * FAMILY_MEANING_RATE, 0, 1);

  // Prestige converges toward prestigeTarget() rather than snapping —
  // same smoothing pattern as familyChannel — so a sudden windfall or
  // asset loss reads as a gradual shift in standing, not an instant jump.
  npc.needs.prestige = clamp(npc.needs.prestige + (prestigeTarget(npc) - npc.needs.prestige) * PRESTIGE_CONVERGENCE_RATE, 0, 1);

  // Natural decay for needs that DON'T already have a complete update
  // above (see NEEDS.selfManaged) — generic over the registry, so a
  // newly added need only needs one entry there, not a new line here.
  // food/security/comfort/social are skipped: their formulas above
  // already are their complete update, decay included, and
  // double-applying decay here was silently making a bad day cost ~3x
  // what a good day earned back (verified via day-by-day tracing:
  // +0.035/day on a fully-fed day vs -0.115/day on a food-less day, when
  // the intended symmetric swing was ±0.075) — a major, hard-to-notice
  // contributor to how easily NPCs fell into and got stuck in chronic
  // near-starvation.
  for (const [need, cfg] of Object.entries(NEEDS)) {
    if (cfg.selfManaged) continue;
    npc.needs[need] = Math.max(0, (npc.needs[need] ?? 0) - cfg.decayPerDay);
  }

  // Energy restoration from rest
  export const restTime = npc.schedule.filter(a=>a.id==='rest').reduce((s,a)=>s+a.duration,0);
  npc.energy = Math.min(100, npc.energy + restTime * 5);
  if (npc.needs.food < 0.15) npc.energy = Math.max(0, npc.energy - 8); // starvation
}


  npc.memory.daysSinceSwitch++;
  if (npc.trainingDaysLeft > 0) {
    npc.trainingDaysLeft--;
    if (npc.trainingDaysLeft <= 0) npc.trainingProfession = null;
  }

  // Update personal price history (entries are {price, season} objects).
  // Window extended to 20 so NPCs can accumulate at least one full season
  // of observations for seasonal forecasting.
  for (const good of Object.keys(GOODS)) {
    export const hist = world.market.goods[good].priceHistory;
    if (hist.length > 0) {
      npc.memory.priceHistory[good].push(hist[hist.length-1]);
      if (npc.memory.priceHistory[good].length > 20) npc.memory.priceHistory[good].shift();
    }
  }

  // Update smoothed EV for each profession
  export const alpha = 0.15;
  for (const profId of Object.keys(PROFESSIONS)) {
    export const observed = computeProfessionEV(npc, profId);
    npc.memory.ev[profId] = alpha * observed + (1-alpha) * (npc.memory.ev[profId]??0);
  }
}

export function computeProfessionEV(npc, profId) {
  export const prof = PROFESSIONS[profId];
  if (!hasWorkableAsset(npc, profId)) return -999;

  // Use profSessionEV directly (not workSessionEV, which might fall back
  // to a different profession). We want the EV of THIS profId specifically.
  export const savedProf = npc.profession;
  export let ev;
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
  export const prof = PROFESSIONS[profId];
  export const materialsCost = prof.materialsCost ?? 0;

  export const currentPractitioners = [...world.npcs.values()].filter(n => n.id !== npc.id && n.profession === profId);
  export let payees = currentPractitioners;
  if (payees.length === 0) {
    export const history = world.professionHistory[profId] ?? [];
    payees = history.map(id => world.npcs.get(id)).filter(n => n && n.id !== npc.id);
  }
  // No one has ever worked this trade (or the only people who have are
  // unavailable) — there's no one to apprentice under, so no training fee.
  export const trainingCost = payees.length > 0 ? (prof.trainingCost ?? 0) : 0;

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
  export const isStarving = npc.needs.food < STARVING_FOOD_THRESHOLD;
  export const minTenure = isStarving ? STARVATION_MIN_TENURE : YEAR_LENGTH;

  // Village-wide daily cap: even a starving NPC or a very long-tenured one
  // still has to wait their turn if others already switched today. This is
  // the direct fix for the herding cascade — no single day can pull more
  // than a couple of people into (or out of) the same trade at once,
  // giving prices and supply chains real time to adjust between waves.
  if (world.switchesToday >= maxSwitchesPerDay()) return;

  export const currentEV = npc.memory.ev[npc.profession] ?? 0;
  export let bestAlt = null, bestEV = -Infinity;

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
  export const bestAltIsVacant = bestAlt && countNpcsInProfession(bestAlt) === 0;

  if (!bestAltIsVacant) {
    if (npc.memory.daysSinceSwitch < minTenure) return;
    if (npc.trainingDaysLeft > 0) return; // still learning the current trade
  }

  // Also consider BUILDING a new asset from scratch — the only way an
  // asset-gated profession (miller, toolmaker, artisan) can ever attract
  // new entrants when every existing asset already has an owner. Without
  // this, real scarcity (e.g. bread) has no way to pull new capacity into
  // existence; it just caps out at however many mills happen to exist.
  export let bestConstructAlt = null, bestConstructEV = -Infinity;
  for (const assetType of PRODUCTIVE_ASSET_TYPES) {
    export const profId = ASSET_TYPES[assetType].profession;
    if (profId === npc.profession) continue;
    // Farm cap: a real, physical ceiling on food production capacity, not
    // just a soft price signal — this is what gives the village an actual
    // food-based population ceiling rather than an ever-expanding supply
    // of farms chasing an ever-growing population.
    if (assetType === 'farm' && countAssetsOfType('farm') >= MAX_FARMS) continue;
    export const cev = computeConstructionEV(npc, profId);
    if (cev > bestConstructEV) { bestConstructEV = cev; bestConstructAlt = assetType; }
  }

  export const constructionIsBest = bestConstructAlt && bestConstructEV > bestEV;
  if (constructionIsBest) {
    export const threshold = 2 + (1 - npc.traits.riskTolerance) * 6;
    if (bestConstructEV - currentEV > threshold && !npc.constructionProject) {
      if (startConstruction(npc, bestConstructAlt)) {
        npc.memory.daysSinceSwitch = 0; // treat starting a build as a commitment, same lock-in spirit as switching
        world.switchesToday++;
      }
    }
    return; // don't also fall through to an ordinary instant-switch this same call
  }

  if (!bestAlt) return;

  export const plan = planProfessionSwitch(npc, bestAlt);

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
  export const avgRampDeficit = 0.35;
  export const rampLoss = bestEV * avgRampDeficit * plan.trainingDays;
  export const amortizedCost = (plan.totalCost * lambda(npc) + rampLoss) / SWITCH_PAYBACK_HORIZON;
  export const adjustedBestEV = bestEV - amortizedCost;

  export const threshold = 2 + (1 - npc.traits.riskTolerance) * 6;
  if (adjustedBestEV - currentEV <= threshold) return;

  // Still have to actually have the upfront cash on hand — this is what
  // throttles a whole village from switching into the same hot trade on
  // the same day, since only the currently-wealthy can afford entry.
  if (npc.savings < plan.totalCost) return;

  npc.savings -= plan.materialsCost;
  world.market.goods.tools.cash += plan.materialsCost; // bought equipment/materials through the Market

  if (plan.trainingCost > 0 && plan.payees.length > 0) {
    export const share = plan.trainingCost / plan.payees.length;
    for (const payee of plan.payees) payee.savings += share;
    npc.savings -= plan.trainingCost;
  }

  // Record the leaver so whoever switches into this trade next still has
  // someone to pay, even once every current practitioner has moved on.
  export const hist = world.professionHistory[npc.profession] ?? (world.professionHistory[npc.profession] = []);
  hist.unshift(npc.id);
  if (hist.length > 3) hist.pop();

  export const costNote = plan.totalCost > 0.01
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
  export const newProfNeedsAsset = Object.keys(ASSET_TYPES).some(t => ASSET_TYPES[t].profession === bestAlt);
  if (!newProfNeedsAsset) {
    npc.primaryAsset = null; // now genuinely idle — will surface in getIdleAssets()
  } else {
    // Switching INTO another asset-gated profession — only valid if they
    // already own a matching asset (hasWorkableAsset gated this decision
    // via computeProfessionEV), so re-point primaryAsset at THAT asset.
    export const matchingAsset = npc.ownedAssets
      .map(id => world.assets.get(id))
      .find(a => a && ASSET_TYPES[a.type].profession === bestAlt);
    npc.primaryAsset = matchingAsset ? matchingAsset.id : null;
    if (matchingAsset) matchingAsset.idleSinceDay = undefined; // now primary again, not idle
  }
}

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
    export const g = world.market.goods[good];
    // "Real" pressure — small numerical noise near zero shouldn't count.
    export const shortage = g.unmetDemand > 0.5;
    export const glut     = g.unmetSupply > 0.5;

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
