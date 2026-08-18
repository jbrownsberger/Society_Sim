import { ASSET_TYPES, MAX_FARMS, NEEDS, PRODUCTIVE_ASSET_TYPES, PROFESSIONS, SEASONAL_GRAIN, buildingProductivity, countAssetsOfType, countNpcsInProfession, hasWorkableAsset, housingQuality } from './constants.js';
import { getAffinity, world } from './state.js';
import { expectedPrice, lambda } from './prices.js';
import { computeConstructionEV, startConstruction } from './construction.js';
import { planAssetSaleActions, planChurchVisit, planConstructionAction, planTinkerAction } from './actions.js';
import { CHILDBIRTH_DRIVE_BONUS, CHILDBIRTH_MATERIAL_COST, CHILDBIRTH_MAX_AGE_DOGYEARS, CHILDBIRTH_UTILITY_COST, MARRIAGE_DRIVE_BONUS, MAX_CHILDREN_PER_COUPLE, childbirthUtilityGain, marriageUtilityGain, minimumBirthSpacingDays } from './marriage.js';
import { DOG_YEAR_DAYS } from './constants.js';
import { bestWageOffer } from './labor.js';
import { YEAR_LENGTH } from './npc.js';
import { STARVATION_MIN_TENURE, STARVING_FOOD_THRESHOLD, SWITCH_PAYBACK_HORIZON, maxSwitchesPerDay, planProfessionSwitch } from './memory.js';
import { effectiveSkill } from './death.js';

/** Beliefs only — not a live argmax. */
export function believedTradeValue(npc, profId) {
  return npc.memory?.ev?.[profId] ?? -999;
}

export function bdiReconsiderProfession(npc) {
  const isStarving = npc.needs.food < STARVING_FOOD_THRESHOLD;
  const minTenure = isStarving ? STARVATION_MIN_TENURE : YEAR_LENGTH;
  if (world.switchesToday >= maxSwitchesPerDay()) return;

  const current = npc.profession;
  const currentBelief = believedTradeValue(npc, current);

  let vacant = null;
  for (const profId of Object.keys(PROFESSIONS)) {
    if (profId === current) continue;
    // An inherited or auctioned asset may be owned but not currently set as
    // this NPC's primary asset. In a vacant essential trade, restoring that
    // existing productive capacity is a valid BDI intention; requiring it
    // to already be primary made an all-woodcutter collapse irreversible.
    const ownedMatchingAsset = npc.ownedAssets
      .map(id => world.assets.get(id))
      .find(asset => asset && !asset.forSale && ASSET_TYPES[asset.type].profession === profId);
    if (countNpcsInProfession(profId) === 0 && ownedMatchingAsset) {
      if (!vacant || believedTradeValue(npc, profId) > believedTradeValue(npc, vacant)) vacant = profId;
    }
  }

  if (vacant) {
    adoptProfession(npc, vacant);
    return;
  }

  if (!isStarving && npc.memory.daysSinceSwitch < minTenure) return;
  if (!isStarving && npc.trainingDaysLeft > 0) return;

  if (!npc.constructionProject) {
    let bestBuild = null;
    for (const assetType of PRODUCTIVE_ASSET_TYPES) {
      const profId = ASSET_TYPES[assetType].profession;
      if (profId === current) continue;
      if (assetType === 'farm' && countAssetsOfType('farm') >= MAX_FARMS) continue;
      const cev = computeConstructionEV(npc, profId);
      if (!bestBuild || cev > bestBuild.value) bestBuild = { assetType, value: cev };
    }
    const margin = 2 + (1 - npc.traits.riskTolerance) * 6;
    if (bestBuild && bestBuild.value - currentBelief > margin) {
      if (startConstruction(npc, bestBuild.assetType)) {
        npc.memory.daysSinceSwitch = 0;
        world.switchesToday++;
      }
      return;
    }
  }

  const margin = 2 + (1 - npc.traits.riskTolerance) * 6;
  let bestTrade = null;
  for (const profId of Object.keys(PROFESSIONS)) {
    if (profId === current) continue;
    if (!hasWorkableAsset(npc, profId)) continue;
    const belief = believedTradeValue(npc, profId);
    const plan = planProfessionSwitch(npc, profId);
    const rampLoss = belief * 0.35 * plan.trainingDays;
    const adjusted = belief - (plan.totalCost * lambda(npc) + rampLoss) / SWITCH_PAYBACK_HORIZON;
    if (npc.savings < plan.totalCost) continue;
    if (!bestTrade || adjusted > bestTrade.adjusted) bestTrade = { profId, plan, adjusted };
  }
  if (bestTrade && bestTrade.adjusted - currentBelief > margin) {
    adoptProfession(npc, bestTrade.profId, bestTrade.plan);
  }
}

// Shelter is a strategic intention too.  Keeping this assessment here makes
// construction originate in the same belief/desire layer as profession and
// daily activity choices, rather than in a second calendar-era side pass.
export function bdiReconsiderHousing(npc) {
  if (housingQuality(npc) === 1.0 || npc.constructionProject) return;
  const cost = Object.entries(ASSET_TYPES.house.buildCost)
    .reduce((sum, [good, quantity]) => sum + quantity * expectedPrice(npc, good), 0);
  const shelterNeed = 1 - housingQuality(npc);
  const canCommit = npc.savings > cost * 1.5;
  if (shelterNeed > 0 && canCommit) startConstruction(npc, 'house');
}

function adoptProfession(npc, bestAlt, plan) {
  if (!plan) plan = planProfessionSwitch(npc, bestAlt);
  if (plan.totalCost > 0 && npc.savings < plan.totalCost) return;

  npc.savings -= plan.materialsCost;
  world.market.goods.tools.cash += plan.materialsCost;
  if (plan.trainingCost > 0 && plan.payees.length > 0) {
    const share = plan.trainingCost / plan.payees.length;
    for (const payee of plan.payees) payee.savings += share;
    npc.savings -= plan.trainingCost;
  }

  const hist = world.professionHistory[npc.profession] ?? (world.professionHistory[npc.profession] = []);
  hist.unshift(npc.id);
  if (hist.length > 3) hist.pop();

  npc.profession = bestAlt;
  npc.trainingProfession = bestAlt;
  npc.trainingDaysLeft = plan.trainingDays;
  npc.memory.daysSinceSwitch = 0;
  world.switchesToday++;

  const newProfNeedsAsset = Object.keys(ASSET_TYPES).some(t => ASSET_TYPES[t].profession === bestAlt);
  if (!newProfNeedsAsset) {
    npc.primaryAsset = null;
  } else {
    const matchingAsset = npc.ownedAssets
      .map(id => world.assets.get(id))
      .find(a => a && ASSET_TYPES[a.type].profession === bestAlt);
    npc.primaryAsset = matchingAsset ? matchingAsset.id : null;
    if (matchingAsset) matchingAsset.idleSinceDay = undefined;
  }
}

export function bdiHiredLaborAction(npc) {
  // Hired work is still physical work. Match workSessionEV's feasibility
  // rule so an exhausted NPC rests instead of occupying a paid slot and
  // delivering effectively zero output through the energy multiplier.
  if (npc.energy < 20) return null;
  const offer = bestWageOffer(npc);
  if (!offer) return null;
  const employer = world.npcs.get(offer.employerId);
  const laborProf = PROFESSIONS[offer.profId];
  if (!laborProf) return null;
  // This is the employer's production session. The worker earns only the
  // wage, but execution credits these goods (and charges these inputs) to
  // the employer. Without this payload, BDI hires consumed a work day while
  // producing nothing — particularly destructive for milling.
  const skill = effectiveSkill(npc, offer.profId);
  const buildingMod = buildingProductivity(offer.profId);
  const seasonal = offer.profId === 'farmer' ? (SEASONAL_GRAIN[world.season] || 1) : 1;
  const energyMod = npc.energy / 100;
  const goodsProduced = {};
  const goodsConsumed = {};
  for (const [good, quantity] of Object.entries(laborProf.outputs)) {
    goodsProduced[good] = quantity * skill * buildingMod * seasonal * energyMod;
  }
  for (const [good, quantity] of Object.entries(laborProf.inputs)) {
    goodsConsumed[good] = quantity;
  }
  return {
    id: 'hired-labor',
    label: `Hired labor (${laborProf.name}${employer ? ' for ' + employer.name : ''})`,
    duration: 6,
    isLabor: true,
    energyCost: 25,
    wage: offer.wage,
    moneyEarned: offer.wage,
    goodsProduced,
    goodsConsumed,
    employerId: offer.employerId,
    assetId: offer.assetId,
    _wageOfferRef: offer,
  };
}

export function bdiPlane2Actions(npc) {
  const actions = [];
  const crisis = npc.needs.food < NEEDS.food.starvationFloor;

  const build = planConstructionAction(npc);
  if (build) {
    // A six-hour construction block could never fit into the BDI plan's
    // discretionary window, so projects were begun but remained at 0%.
    // Commit a smaller daily tranche; the underlying project retains its
    // progress and will complete through repeated intentions.
    const duration = Math.min(3, build.duration);
    const fraction = duration / build.duration;
    actions.push({
      ...build,
      duration,
      energyCost: (build.energyCost ?? 0) * fraction,
      _scoreOverride: typeof build._scoreOverride === 'number'
        ? build._scoreOverride * fraction
        : build._scoreOverride,
    });
  }

  actions.push(...planAssetSaleActions(npc));

  // Church is a durable meaning/community intention. Its own BDI score
  // accounts for the tithe and yields to hunger or acute discomfort.
  actions.push(planChurchVisit(npc));

  if (!crisis) {
    const tinker = planTinkerAction(npc);
    if (tinker) actions.push(tinker);
  }

  if (npc.spouseId == null) {
    actions.push({
      id: 'seek_marriage',
      label: 'Seek marriage',
      duration: 1,
      energyCost: 5,
      needEffects: {},
      _scoreOverride: marriageUtilityGain(npc) + MARRIAGE_DRIVE_BONUS,
    });
  }

  if (npc.spouseId != null && npc.id < npc.spouseId) {
    const spouse = world.npcs.get(npc.spouseId);
    // Couples form a public belief about whether the village can provision
    // another dependent from the market. The Market's normal bread reserve
    // is the reference point, so this is a continuous confidence signal,
    // not a household-stock threshold or a population cap.
    const breadMarket = world.market.goods.bread;
    const foodConfidence = breadMarket
      ? Math.min(1, Math.max(0, breadMarket.stock / Math.max(1, breadMarket.targetStock)))
      : 0;
    if (spouse && npc.childIds.length < MAX_CHILDREN_PER_COUPLE &&
        npc.energy > 40 && spouse.energy > 40 &&
        npc.needs.food > 0.5 && spouse.needs.food > 0.5 &&
        npc.age < CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS &&
        spouse.age < CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS &&
        (world.day - npc.lastChildbirthDay) >= minimumBirthSpacingDays() &&
        (world.day - spouse.lastChildbirthDay) >= minimumBirthSpacingDays() &&
        (npc.savings + spouse.savings) > CHILDBIRTH_MATERIAL_COST * 3) {
      const familyGain = childbirthUtilityGain(npc) + childbirthUtilityGain(spouse) + CHILDBIRTH_DRIVE_BONUS;
      const expectedUtility = familyGain * foodConfidence - CHILDBIRTH_UTILITY_COST;
      if (expectedUtility > 0) {
        actions.push({
          id: 'seek_child',
          label: 'Try for a child',
          duration: 1,
          energyCost: 10,
          needEffects: {},
          _scoreOverride: expectedUtility,
        });
      }
    }
  }

  const hasOpenAsk = world.helpRequests.some(r => r.requesterId === npc.id);
  if (crisis && !hasOpenAsk) {
    const candidates = [...npc.relations.entries()]
      .filter(([, rec]) => rec.affinity > 0)
      .sort((a, b) => b[1].affinity - a[1].affinity)
      .slice(0, 1);
    for (const [targetId] of candidates) {
      const target = world.npcs.get(targetId);
      if (!target) continue;
      actions.push({
        id: 'ask_help',
        label: `Ask ${target.name} for help`,
        duration: 1,
        energyCost: 3,
        // Asking is valuable in proportion to how urgently the requester
        // values money, but it remains uncertain until the target chooses.
        moneyEarned: 20 * 0.5,
        targetId,
        requestedAmount: 20,
      });
    }
  }

  if (!crisis) {
    for (const req of world.helpRequests) {
      if (req.targetId !== npc.id || req.resolved) continue;
      const requester = world.npcs.get(req.requesterId);
      if (!requester) continue;
      if (getAffinity(npc, requester.id) <= 0) continue;
      if (npc.savings < req.amount) continue;
      actions.push({
        id: 'help',
        label: `Help ${requester.name}`,
        duration: 1,
        energyCost: 3,
        moneyCost: req.amount,
        opportunityCost: 0,
        requestId: req,
        affinityTarget: { npcId: requester.id, moneyGift: req.amount },
      });
    }
  }

  return actions;
}
