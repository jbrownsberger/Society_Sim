import { NEEDS, PROFESSIONS, SEASONAL_GRAIN, WORK_SESSION_HOURS, buildingProductivity, emergencyReplanNeeded, needMarginalUtility } from './constants.js';
import { world } from './state.js';
import { workSessionEV } from './construction.js';
import { satisfyNeeds } from './needs.js';
import { effectiveSkill } from './death.js';
import { bdiHiredLaborAction, bdiPlane2Actions } from './bdiAgent.js';
import { scoreAction } from './prices.js';
import { planMarketVisit } from './actions.js';

export const SCHEDULE_CATEGORIES = ['work', 'market', 'rest', 'leisure'];
export const SCHEDULE_N_PAIRS = 2;
export const SCHEDULE_SMALL_STEPS = [2, 6];
export const SCHEDULE_CRISIS_STEPS = [10, 20];
export const SCHEDULE_REFINEMENT_MARGIN = 0.02;
export const DEFAULT_SHADOW_SCHEDULE = { work: 40, market: 15, rest: 25, leisure: 20 };
export const DAILY_HOURS = 16;
export const PLANNING_HORIZON_DAYS = 7;
export const BDI_ADOPTION_FRACTION = 1;

// Projection effects belong to the BDI rollout, not the retired calendar
// scheduler. They are deliberately local and side-effect free: market and
// relationship changes are only made when a real intention executes.
function applyProjectionEffects(sim, action) {
  // A wage worker receives the wage, not the employer's output; similarly,
  // the employer supplies the inputs. Execution already applies those goods
  // to the employer. Projecting them into the worker's inventory made the
  // hill-climber believe a mill hand had acquired bread directly, so it
  // could rationally cut market time even though the live household had no
  // bread at all.
  const employerOwnsProduction = action.id === 'hired-labor';
  if (!employerOwnsProduction) {
    let fillRatio = 1;
    for (const [good, quantity] of Object.entries(action.goodsConsumed ?? {})) {
      if (quantity > 0) fillRatio = Math.min(fillRatio, (sim.inventory[good] ?? 0) / quantity);
    }
    fillRatio = Math.max(0, Math.min(1, fillRatio));
    for (const [good, quantity] of Object.entries(action.goodsConsumed ?? {})) {
      sim.inventory[good] = Math.max(0, (sim.inventory[good] ?? 0) - quantity * fillRatio);
    }
    for (const [good, quantity] of Object.entries(action.goodsProduced ?? {})) {
      sim.inventory[good] = (sim.inventory[good] ?? 0) + quantity * fillRatio;
    }
  }
  sim.savings += action.moneyEarned ?? 0;
  sim.savings -= action.moneyCost ?? 0;
  sim.energy = Math.max(0, sim.energy - (action.energyCost ?? 0));
  sim.energy = Math.min(100, sim.energy + (action.energyRestored ?? 0));
  for (const [need, amount] of Object.entries(action.needEffects ?? {})) {
    sim.needs[need] = Math.min(1, (sim.needs[need] ?? 0) + amount);
  }
}

function cloneNpcForPlanning(npc) {
  return {
    ...npc,
    needs: { ...npc.needs },
    inventory: { ...npc.inventory },
    skills: { ...npc.skills },
    constructionProject: npc.constructionProject ? { ...npc.constructionProject } : null,
    schedule: [],
  };
}

export function scheduleWorkMarginalValue(npc) {
  const { ev } = workSessionEV(npc);
  return isFinite(ev) ? ev / WORK_SESSION_HOURS : -Infinity;
}

export function scheduleMarketMarginalValue(npc) {
  const visit = planMarketVisit(npc);
  return visit ? scoreAction(visit, npc) : 0;
}

export function scheduleRestMarginalValue(npc) {
  const energyGap = (100 - npc.energy) / 100;
  return energyGap * 12 * 0.05;
}

export function scheduleLeisureMarginalValue(npc) {
  const muSocial = needMarginalUtility(npc, 'social');
  const muMeaning = needMarginalUtility(npc, 'meaning');
  return (muSocial * 0.03 + muMeaning * 0.025) / 2;
}

export function scheduleAnalyticValues(npc) {
  return {
    work: scheduleWorkMarginalValue(npc),
    market: scheduleMarketMarginalValue(npc),
    rest: scheduleRestMarginalValue(npc),
    leisure: scheduleLeisureMarginalValue(npc),
  };
}

export function scheduleAnalyticPrefilter(schedule, mv, nPairs = SCHEDULE_N_PAIRS) {
  const ranked = [...SCHEDULE_CATEGORIES].sort((a, b) => mv[a] - mv[b]);
  const donors = ranked.slice(0, nPairs);
  const receivers = ranked.slice(-nPairs).reverse();
  const pairs = new Set();
  for (const d of donors) {
    for (const r of receivers) {
      if (d !== r && schedule[d] > 2) pairs.add(JSON.stringify([d, r]));
    }
  }
  return [...pairs].map(p => JSON.parse(p));
}

export function buildShadowDayActions(sim, weekSchedule, dayFraction, dayWorkHours) {
  const actions = [];
  const marketHours = weekSchedule.market * dayFraction;
  const restHours = weekSchedule.rest * dayFraction;
  const leisureHours = weekSchedule.leisure * dayFraction;

  let selfWork = null;
  if (dayWorkHours > 0.1) {
    const { workAs } = workSessionEV(sim);
    if (workAs) {
      const prof = PROFESSIONS[workAs];
      const skill = effectiveSkill(sim, workAs);
      const capitalMod = prof.capitalGood
        ? 1 + Math.log1p(sim.inventory.tools ?? 0) * 0.2
        : 1;
      const workplaceMod = buildingProductivity(workAs);
      const seasonalMod = workAs === 'farmer' ? (SEASONAL_GRAIN[world.season] || 1) : 1;
      const energyMod = sim.energy / 100;
      const goodsProduced = {};
      const goodsConsumed = {};
      for (const [g, qty] of Object.entries(prof.outputs)) {
        goodsProduced[g] = qty * skill * capitalMod * workplaceMod * seasonalMod * energyMod
          * (dayWorkHours / prof.laborHours);
      }
      for (const [g, qty] of Object.entries(prof.inputs)) {
        goodsConsumed[g] = qty * (dayWorkHours / prof.laborHours);
      }
      selfWork = {
        id: 'work',
        duration: dayWorkHours,
        energyCost: 25 * (dayWorkHours / 6),
        goodsProduced,
        goodsConsumed,
        isLabor: true,
      };
    }
  }
  const hire = bdiHiredLaborAction(sim);
  if (hire && dayWorkHours > 0.1) {
    const fraction = dayWorkHours / hire.duration;
    const scaledHire = {
      ...hire,
      duration: dayWorkHours,
      energyCost: hire.energyCost * fraction,
      wage: hire.wage * fraction,
      moneyEarned: hire.moneyEarned * fraction,
      goodsProduced: Object.fromEntries(Object.entries(hire.goodsProduced).map(([g, q]) => [g, q * fraction])),
      goodsConsumed: Object.fromEntries(Object.entries(hire.goodsConsumed).map(([g, q]) => [g, q * fraction])),
    };
    // Owning an asset is not a ban on selling labor. A worker compares the
    // wage against the value of operating their own asset; employer output
    // is deliberately omitted from the worker's score.
    const hireForWorker = { ...scaledHire };
    delete hireForWorker.goodsProduced;
    delete hireForWorker.goodsConsumed;
    if (!selfWork || scoreAction(hireForWorker, sim) > scoreAction(selfWork, sim)) {
      actions.push(scaledHire);
    } else {
      actions.push(selfWork);
    }
  } else if (selfWork) {
    actions.push(selfWork);
  }
  if (marketHours > 0.1) {
    // Trading settles once per visit in the live market. Reuse the same
    // planner here, so the rollout values the real multi-good cart rather
    // than inventing a linear "hours buy bread" payoff.
    const visit = planMarketVisit(sim);
    if (visit) actions.push({ ...visit, duration: marketHours });
  }
  if (restHours > 0.1) {
    actions.push({
      id: 'rest',
      duration: restHours,
      energyRestored: restHours * 12,
      needEffects: { comfort: restHours * 0.005 },
    });
  }
  if (leisureHours > 0.1) {
    actions.push({
      id: 'leisure',
      duration: leisureHours,
      needEffects: { social: leisureHours * 0.012, meaning: leisureHours * 0.01 },
    });
  }
  return actions;
}

export function scheduleProjectWeek(candidateSchedule, npc) {
  const sim = cloneNpcForPlanning(npc);
  let totalUtil = 0;
  let starvedAnyDay = false;
  const totalHours = Object.values(candidateSchedule).reduce((a, b) => a + b, 0) || 1;

  for (let d = 0; d < PLANNING_HORIZON_DAYS; d++) {
    const dayFraction = DAILY_HOURS / totalHours;
    let dayWorkHours = candidateSchedule.work * dayFraction;
    if (sim.constructionProject) {
      const hoursRemaining = sim.constructionProject.laborHoursNeeded - sim.constructionProject.laborHoursDone;
      const claimed = Math.min(6, hoursRemaining, dayWorkHours);
      dayWorkHours -= claimed;
      sim.constructionProject.laborHoursDone += claimed;
      if (sim.constructionProject.laborHoursDone >= sim.constructionProject.laborHoursNeeded - 0.01) {
        sim.constructionProject = null;
      }
    }
    const dayActions = buildShadowDayActions(sim, candidateSchedule, dayFraction, dayWorkHours);
    for (const action of dayActions) applyProjectionEffects(sim, action);
    satisfyNeeds(sim);
    if (sim.needs.food < NEEDS.food.starvationFloor) starvedAnyDay = true;
    for (const [need, cfg] of Object.entries(NEEDS)) {
      // needMarginalUtility is a derivative used for pricing. Maximizing it
      // rewards deprivation. Its integral is a wellbeing utility: higher
      // satisfaction produces higher value, with diminishing returns.
      totalUtil += cfg.weight * Math.log1p(sim.needs[need] ?? 0);
    }
  }
  if (starvedAnyDay) totalUtil -= 800;
  return { value: totalUtil, starvedAnyDay };
}

export function scheduleGenerateCandidates(schedule, mv, crisis) {
  const deltas = crisis ? SCHEDULE_CRISIS_STEPS : SCHEDULE_SMALL_STEPS;
  const pairs = scheduleAnalyticPrefilter(schedule, mv);
  const candidates = [];
  for (const [donor, receiver] of pairs) {
    for (const step of deltas) {
      if (schedule[donor] >= step) {
        const s = { ...schedule };
        s[donor] -= step;
        s[receiver] += step;
        candidates.push(s);
      }
    }
  }
  if (crisis) {
    for (const step of deltas) {
      const avail = Math.min(schedule.leisure, step) + Math.min(schedule.rest, step);
      if (avail >= step) {
        const s = { ...schedule };
        const takeLeisure = Math.min(s.leisure, step / 2);
        const takeRest = Math.min(s.rest, step - takeLeisure);
        s.leisure -= takeLeisure;
        s.rest -= takeRest;
        s.work += step / 2;
        s.market += step - step / 2;
        candidates.push(s);
      }
    }
  }
  return candidates;
}

export function todaysBdiActions(npc) {
  if (!npc.shadowSchedule) npc.shadowSchedule = { ...DEFAULT_SHADOW_SCHEDULE };
  const totalHours = Object.values(npc.shadowSchedule).reduce((a, b) => a + b, 0) || 1;
  const dayFraction = DAILY_HOURS / totalHours;
  let dayWorkHours = npc.shadowSchedule.work * dayFraction;
  if (npc.constructionProject) {
    const hoursRemaining = npc.constructionProject.laborHoursNeeded - npc.constructionProject.laborHoursDone;
    dayWorkHours -= Math.min(6, hoursRemaining, dayWorkHours);
  }
  return buildShadowDayActions(npc, npc.shadowSchedule, dayFraction, dayWorkHours);
}

export function applyBdiDayIfEnabled(npc) {
  npc.useBdiSchedule = true;
  // The weekly hill-climber has already committed these basic intentions.
  // Re-scoring them here used to silently drop market visits when a household
  // was hungry (the immediate cash cost beat the action's coarse score), so
  // NPCs accumulated money while starving beside a stocked market.
  const chosen = todaysBdiActions(npc).map(action => ({ ...action }));

  // Strategic/social intentions may displace leisure, but never the planned
  // provisioning, work, or recovery time. This keeps the daily plan within
  // its fixed budget while still allowing construction, family, and aid.
  const leisure = chosen.find(action => action.id === 'leisure');
  const extras = bdiPlane2Actions(npc)
    .map(action => ({ action, value: scoreAction(action, npc) }))
    .filter(({ value }) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b.value - a.value);
  const selectedIds = new Set();

  // An already-started project is a durable intention. It can displace
  // discretionary leisure, but not the schedule's production or recovery.
  const build = extras.find(({ action }) => action.id === 'build');
  if (build && leisure) {
    if (build.action.duration <= leisure.duration + 0.01) {
      leisure.duration -= build.action.duration;
      chosen.push({ ...build.action });
      selectedIds.add('build');
    }
  }

  if (leisure) {
    for (const { action } of extras) {
      if (selectedIds.has(action.id) || action.duration > leisure.duration + 0.01) continue;
      leisure.duration -= action.duration;
      chosen.push({ ...action });
      selectedIds.add(action.id);
    }
    if (leisure.duration < 0.05) chosen.splice(chosen.indexOf(leisure), 1);
  }

  npc.schedule = chosen;
  // Offers clear daily and capacity is finite. Reserve a slot as soon as
  // this BDI plan commits, before later NPCs choose from the same market.
  for (const action of chosen) {
    if (action.id === 'hired-labor' && action._wageOfferRef) {
      action._wageOfferRef.slotsRemaining = Math.max(0, action._wageOfferRef.slotsRemaining - 1);
    }
  }
  npc.bdi = {
    ...(npc.bdi ?? {}),
    intentions: chosen.map(action => ({
      actionId: action.id,
      duration: action.duration,
      expectedUtility: scoreAction(action, npc),
      status: 'committed',
    })),
    deliberatedOnDay: world.day,
  };
  npc.scheduleIdx = 0;
  npc.currentAction = npc.schedule[0]?.id ?? 'idle';
  return true;
}

export function seedBdiAdoption() {
  for (const npc of world.npcs.values()) {
    npc.useBdiSchedule = true;
    if (!npc.shadowSchedule) npc.shadowSchedule = { ...DEFAULT_SHADOW_SCHEDULE };
  }
}

export function shadowDeliberateSchedule(npc) {
  if (!npc.shadowSchedule) npc.shadowSchedule = { ...DEFAULT_SHADOW_SCHEDULE };
  const crisis = emergencyReplanNeeded(npc);
  const planOffset = npc.planOffset ?? (npc.id % PLANNING_HORIZON_DAYS);
  if (!crisis && world.day % PLANNING_HORIZON_DAYS !== planOffset) return;

  const mv = scheduleAnalyticValues(npc);
  const currentProjection = scheduleProjectWeek(npc.shadowSchedule, npc);
  const candidates = scheduleGenerateCandidates(npc.shadowSchedule, mv, crisis);

  let best = { schedule: npc.shadowSchedule, projection: currentProjection };
  for (const cand of candidates) {
    const projection = scheduleProjectWeek(cand, npc);
    if (projection.value > best.projection.value) best = { schedule: cand, projection };
  }

  const improvedEnough = crisis
    ? best.projection.value > currentProjection.value
    : best.projection.value > currentProjection.value * (1 + SCHEDULE_REFINEMENT_MARGIN);

  npc.bdi = {
    beliefs: { crisis, starvedInRollout: currentProjection.starvedAnyDay, marginalValue: mv },
    desires: candidates.length,
    intention: npc.shadowSchedule,
    projection: best.projection,
    liveAction: npc.currentAction,
    useBdiSchedule: true,
  };

  if (improvedEnough && best.schedule !== npc.shadowSchedule) {
    console.log(`[bdi] Day ${world.day} ${npc.name}: revise schedule`, npc.shadowSchedule, 'to', best.schedule);
    npc.shadowSchedule = best.schedule;
    npc.bdi.intention = best.schedule;
  }
}

export function shadowDeliberateAll() {
  for (const npc of world.npcs.values()) shadowDeliberateSchedule(npc);
}
