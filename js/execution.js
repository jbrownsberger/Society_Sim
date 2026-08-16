import { clamp } from './utils.js';
import { ASSET_TYPES } from './constants.js';
import { bumpAffinity, logEvent, world } from './state.js';
import { completeConstruction } from './construction.js';
import { TINKER_SKILL_CEILING } from './actions.js';
import { attemptChildbirth } from './marriage.js';

// ─────────────────────────────────────────────
// ACTION EXECUTION
// ─────────────────────────────────────────────

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
      let fillRatio = 1;
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
      const employer = world.npcs.get(action.employerId);
      if (employer) {
        let fillRatio = 1;
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
        const wagePaid = Math.min(action.wage, employer.savings);
        employer.savings -= wagePaid;
        npc.savings += wagePaid;
        const asset = world.assets.get(action.assetId);
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
      const asset = world.assets.get(action.assetId);
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
      const asset = world.assets.get(action.assetId);
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
      const current = npc.skills[action.profId] ?? 0;
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
      const req = action.requestId;
      const requester = world.npcs.get(req.requesterId);
      if (requester) {
        const actualAmount = Math.min(req.amount, Math.max(0, npc.savings));
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

