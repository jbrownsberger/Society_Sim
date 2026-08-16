import { NEEDS, PROFESSIONS, WORK_SESSION_HOURS, emergencyReplanNeeded, needMarginalUtility } from './constants.js';
import { world } from './state.js';
import { marketAsk, shadowPriceGood } from './prices.js';
import { workSessionEV } from './construction.js';
import { applySimEffects } from './scheduler.js';
import { satisfyNeeds } from './needs.js';
import { effectiveSkill } from './death.js';

// Stage 1: Plane-1 intention is a weekly hour allocation.
// Live EV allocator still decides the day; this revises npc.shadowSchedule only.
export const SCHEDULE_CATEGORIES = ['work', 'market', 'rest', 'leisure'];
export const SCHEDULE_N_PAIRS = 2;
export const SCHEDULE_SMALL_STEPS = [2, 6];
export const SCHEDULE_CRISIS_STEPS = [10, 20];
export const SCHEDULE_REFINEMENT_MARGIN = 0.02;
export const DEFAULT_SHADOW_SCHEDULE = { work: 40, market: 15, rest: 25, leisure: 20 };
export const DAILY_HOURS = 16;
export const PLANNING_HORIZON_DAYS = 7;

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
  const foodShort = npc.needs.food < 0.6;
  if (!foodShort || npc.savings <= 0) return 0.05;
  const breadPrice = Math.max(marketAsk('bread'), 0.01);
  const breadShadow = shadowPriceGood(npc, 'bread');
  const affordableUnitsPerHour = Math.min(1.5, npc.savings / breadPrice) / 1.5;
  return breadShadow * affordableUnitsPerHour * 0.3;
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

function buildShadowDayActions(sim, weekSchedule, dayFraction, dayWorkHours) {
  const actions = [];
  const marketHours = weekSchedule.market * dayFraction;
  const restHours = weekSchedule.rest * dayFraction;
  const leisureHours = weekSchedule.leisure * dayFraction;

  if (dayWorkHours > 0.1) {
    const { workAs } = workSessionEV(sim);
    if (workAs) {
      const prof = PROFESSIONS[workAs];
      const skill = effectiveSkill(sim, workAs);
      const goodsProduced = {};
      const goodsConsumed = {};
      for (const [g, qty] of Object.entries(prof.outputs)) {
        goodsProduced[g] = qty * skill * (dayWorkHours / prof.laborHours);
      }
      for (const [g, qty] of Object.entries(prof.inputs)) {
        goodsConsumed[g] = qty * (dayWorkHours / prof.laborHours);
      }
      actions.push({
        id: 'work',
        duration: dayWorkHours,
        energyCost: 25 * (dayWorkHours / 6),
        goodsProduced,
        goodsConsumed,
        isLabor: true,
      });
    }
  }
  if (marketHours > 0.1) {
    const breadPrice = Math.max(marketAsk('bread'), 0.01);
    const affordable = Math.floor(sim.savings / breadPrice);
    const bought = Math.min(affordable, Math.floor(marketHours * 1.5));
    actions.push({
      id: 'market',
      duration: marketHours,
      moneyCost: bought * breadPrice,
      goodsProduced: { bread: bought },
      disutility: marketHours * 0.5,
    });
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
    for (const action of dayActions) applySimEffects(sim, action);
    satisfyNeeds(sim);
    if (sim.needs.food < NEEDS.food.starvationFloor) starvedAnyDay = true;
    for (const need of Object.keys(NEEDS)) {
      totalUtil += needMarginalUtility(sim, need) * 0.01;
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

export function shadowDeliberateSchedule(npc) {
  if (!npc.shadowSchedule) {
    npc.shadowSchedule = { ...DEFAULT_SHADOW_SCHEDULE };
  }
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
    beliefs: {
      crisis,
      starvedInRollout: currentProjection.starvedAnyDay,
      marginalValue: mv,
    },
    desires: candidates.length,
    intention: npc.shadowSchedule,
    projection: best.projection,
    liveAction: npc.currentAction,
  };

  if (improvedEnough && best.schedule !== npc.shadowSchedule) {
    console.log(
      `[bdi-shadow] Day ${world.day} ${npc.name}: would revise`,
      npc.shadowSchedule,
      'to',
      best.schedule,
      `(live action: ${npc.currentAction})`
    );
    npc.shadowSchedule = best.schedule;
    npc.bdi.intention = best.schedule;
  }
}

export function shadowDeliberateAll() {
  for (const npc of world.npcs.values()) {
    shadowDeliberateSchedule(npc);
  }
}
