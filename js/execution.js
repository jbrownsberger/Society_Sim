import { clamp } from './utils.js';
import { ASSET_TYPES } from './constants.js';
import { bumpAffinity, logEvent, world } from './state.js';
import { completeConstruction } from './construction.js';
import { TINKER_SKILL_CEILING } from './actions.js';
import { attemptChildbirth } from './marriage.js';
import { applyBdiDayIfEnabled } from './scheduleBdi.js';

export function executeSchedule(npc) {
  applyBdiDayIfEnabled(npc);

  for (const action of npc.schedule) {
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

    if (action.id === 'list-asset-sale') {
      const asset = world.assets.get(action.assetId);
      if (asset && asset.ownerId === npc.id) {
        asset.forSale = true;
        if (npc.primaryAsset === asset.id) {
          logEvent(`${npc.name}, struggling, listed their ${ASSET_TYPES[asset.type].name.toLowerCase()} for sale as a last resort (still working it while it's on the market).`, [npc.id]);
        }
      }
    }

    if (action.id === 'delist-asset-sale') {
      const asset = world.assets.get(action.assetId);
      if (asset && asset.ownerId === npc.id) {
        asset.forSale = false;
        asset.auctionAttempts = 0;
        logEvent(`${npc.name} took their ${ASSET_TYPES[asset.type].name.toLowerCase()} off the market.`, [npc.id]);
      }
    }

    if (action.id === 'build' && npc.constructionProject) {
      npc.constructionProject.laborHoursDone += action.duration;
      if (npc.constructionProject.laborHoursDone >= npc.constructionProject.laborHoursNeeded - 0.01) {
        completeConstruction(npc);
      }
    }

    if (action.id === 'tinker' && action.profId) {
      const current = npc.skills[action.profId] ?? 0;
      if (current < TINKER_SKILL_CEILING) {
        npc.skills[action.profId] = Math.min(TINKER_SKILL_CEILING, current + action._skillGainFrac);
      }
    }

    if (action.id === 'seek_marriage') {
      npc._seekingMarriageToday = true;
    }

    if (action.id === 'seek_child') {
      attemptChildbirth(npc);
    }

    if (action.id === 'ask_help') {
      world.helpRequests.push({
        requesterId: npc.id, targetId: action.targetId,
        amount: action.requestedAmount, day: world.day, resolved: false,
      });
    }

    if (action.id === 'help' && action.requestId && !action.requestId.resolved) {
      const req = action.requestId;
      const requester = world.npcs.get(req.requesterId);
      if (requester) {
        const actualAmount = Math.min(req.amount, Math.max(0, npc.savings));
        if (actualAmount > 0.1) {
          npc.savings -= actualAmount;
          requester.savings += actualAmount;
          bumpAffinity(requester, npc.id, 0.15);
          bumpAffinity(npc, req.requesterId, 0.04);
          logEvent(`${npc.name} helped ${requester.name} in their time of need.`, [npc.id, requester.id]);
        }
      }
      req.resolved = true;
    }

    if (action.energyCost)     npc.energy = Math.max(0, npc.energy - action.energyCost);
    if (action.energyRestored) npc.energy = Math.min(100, npc.energy + action.energyRestored);
    if (action.needEffects) {
      for (const [need, amount] of Object.entries(action.needEffects)) {
        if (need === 'comfort') { npc.materialComfort = Math.min(1, (npc.materialComfort ?? 0) + amount); continue; }
        if (need === 'social')  { npc.activitySocial  = Math.min(1, (npc.activitySocial  ?? 0) + amount); continue; }
        npc.needs[need] = Math.min(1, (npc.needs[need]??0) + amount);
      }
    }
  }
}
