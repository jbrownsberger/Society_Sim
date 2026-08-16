import { PROFESSIONS, SEASONAL_GRAIN, buildingProductivity, emergencyReplanNeeded } from './constants.js';
import { bumpAffinity, getAffinity, world } from './state.js';
import { expectedPrice, scoreAction } from './prices.js';
import { bestWageOffer } from './labor.js';
import { workSessionEV } from './construction.js';
import { TINKER_SKILL_CEILING } from './actions.js';
import { effectiveSkill, getAvailableActions } from './death.js';
import { executeSchedule } from './execution.js';
import { satisfyNeeds } from './needs.js';

// ─────────────────────────────────────────────
// DAILY SCHEDULE BUILDER — TWO-PASS
// ─────────────────────────────────────────────
//
// Pass 1: Decide whether (and how many times) to work.
//   workSessionEV gives the net utility of one full work session,
//   including the cost of buying any missing inputs. If positive,
//   the NPC commits to working. A second session is added only if
//   the first leaves enough energy and time, and EV is still positive.
//   Input purchases required by committed work sessions are scheduled
//   at market price (no productive shadow price — that value already
//   appears in the work EV). This eliminates the double-count that
//   caused buy-inputs to crowd out work.
//
// Pass 2: Fill remaining time by scoring all other actions
//   (sell surplus, buy food/wood, rest, socialise) purely on
//   consumption/leisure value. No productive shadow prices here.
//
// Incentive sensitivity:
//   • High output price  → workSessionEV rises → more work sessions
//   • Low output price   → workSessionEV falls → NPC rests / socialises
//   • High savings + fed → lambda low → leisure scores higher relative
//     to work → voluntary shorter workday
//   • Starvation / broke → lambda high → even marginal work is worth it

// ─────────────────────────────────────────────
// WEEKLY PLANNER
// ─────────────────────────────────────────────
//
// Scheduling over scoring: each NPC commits to a 7-day schedule at once
// (matching a real household's weekly rhythm — you don't re-decide "should
// I go to work" from first principles every single morning), rather than
// building one day at a time from a stateless daily snapshot. The
// exception is a genuine crisis: any need breaching its starvationFloor
// (see emergencyReplanNeeded) tears up the rest of the week and replans
// immediately, rather than waiting for the next scheduled planning day.
//
// Each simulated day is built by a genuine SINGLE PASS (buildDayCandidates
// + allocateDay): every candidate action — work, hired labor, market,
// church, asset sale/delist, tinker, rest, socialize — is scored exactly
// once from one snapshot of state via the same scoreAction used
// throughout this file, sorted once, and allocated in one linear walk.
// Nothing gets re-scored after an earlier pick changes the state within a
// day. This was a deliberate choice over an iterative re-scoring loop:
// with re-scoring, small flat need bonuses (like socializing) could get
// picked repeatedly and compound into a free substitute for real
// consumption or productive work, which masked rather than exposed any
// underlying mistuning. With a single pass, if rest or socializing
// outscores work, that's a direct, visible signal that something in the
// value chain — energy shadow price, labor disutility, output prices,
// lambda — is genuinely out of tune, not an artifact of the scheduling
// algorithm itself.
//
// getAvailableActions and scoreAction remain the only two places that
// know about specific actions/needs; the planner itself never changes
// when a new need or action is added.
//
// Because real execution (executeSchedule, runMarketExchange, satisfyNeeds,
// collectTithes, etc.) is untouched and still runs once per REAL day
// against the REAL npc and REAL market, planning ahead is purely a
// forecast: it runs against a lightweight cloned NPC state so speculative
// "what happens if I do X, then Y" reasoning never touches live state
// until that day actually arrives.

export const PLANNING_HORIZON_DAYS = 7;
export const DAILY_HOURS = 14;

// How much of a score boost repeating last cycle's choice for this same
// day-slot gets (see buildDayCandidates' habit-continuity block below).
// 0.20 means a habitual choice needs to be beaten by more than ~20% to
// get displaced — enough to damp weekly thrashing between near-tied
// options without ever overriding a genuinely better opportunity or a
// real emergency.
export const HABIT_CONTINUITY_BONUS = 0.20;

// A minimal, mutable stand-in for an NPC used only for forward simulation
// during planning. Shares the exact field shape real NPCs have, so every

// existing helper (lambda, shadowPriceGood, profSessionEV, planMarketVisit,
// etc.) works on it completely unmodified — versatility via duck-typing,
// not a parallel API.
export function cloneNpcForPlanning(npc) {
  return {
    id: npc.id, name: npc.name, profession: npc.profession,
    trainingProfession: npc.trainingProfession, trainingDaysLeft: npc.trainingDaysLeft,
    ownedAssets: npc.ownedAssets.slice(), primaryAsset: npc.primaryAsset, primaryHouse: npc.primaryHouse,
    spouseId: npc.spouseId, childIds: npc.childIds.slice(), lastChildbirthDay: npc.lastChildbirthDay,
    age: npc.age,
    energy: npc.energy, savings: npc.savings, capital: npc.capital,
    inventory: { ...npc.inventory },
    needs: { ...npc.needs },
    traits: npc.traits,
    skills: { ...npc.skills },
    memory: npc.memory, // read-only during planning; never written here
    relations: npc.relations, // read-only during planning (see getAffinity/ask_help/help candidate generation) — never mutated via bumpAffinity during lookahead, only at real executeSchedule time, so sharing the live Map is safe and avoids a per-clone copy of a structure that can be large.
    // Without this, planConstructionAction(sim) always sees !proj and
    // returns null — 'build' would never even become a candidate during
    // real weekly planning, no matter how well it scores. Found exactly
    // this way: scoring 'build' directly against the real NPC showed it
    // winning decisively (score far above every other candidate), but
    // real construction progress stayed at 0 for hundreds of days,
    // because the actual planning pass never ran against a clone that
    // had this field at all.
    constructionProject: npc.constructionProject ? { ...npc.constructionProject } : null,
    schedule: [], scheduleIdx: 0, currentAction: 'idle',
  };
}

// Approximates one action's effect on a simulated (cloned) NPC, so the
// NEXT simulated day plans against a realistically progressed state. This
// mirrors what executeSchedule does for real, minus anything that mutates
// shared/global state (market prices, asset ownership, church cash) — those
// only happen for real, once, on the day they actually occur.
export function applySimEffects(sim, action) {
  if (action.goodsConsumed) {
    for (const [g, q] of Object.entries(action.goodsConsumed)) {
      sim.inventory[g] = Math.max(0, (sim.inventory[g] ?? 0) - q);
    }
  }
  if (action.goodsProduced) {
    for (const [g, q] of Object.entries(action.goodsProduced)) {
      sim.inventory[g] = (sim.inventory[g] ?? 0) + q;
    }
  }
  if (action.id === 'hired-labor' && action.wage) sim.savings += action.wage;
  if (action.moneyEarned) sim.savings += action.moneyEarned;
  if (action.moneyCost)   sim.savings -= action.moneyCost;
  if (action.energyCost)     sim.energy = Math.max(0, sim.energy - action.energyCost);
  if (action.energyRestored) sim.energy = Math.min(100, sim.energy + action.energyRestored);
  if (action.needEffects) {
    for (const [need, amount] of Object.entries(action.needEffects)) {
      sim.needs[need] = Math.min(1, (sim.needs[need] ?? 0) + amount);
    }
  }
  if (action.id === 'tinker' && action.profId) {
    const current = sim.skills[action.profId] ?? 0;
    if (current < TINKER_SKILL_CEILING) {
      sim.skills[action.profId] = Math.min(TINKER_SKILL_CEILING, current + action._skillGainFrac);
    }
  }
  if (action.id === 'build' && sim.constructionProject) {
    // Mirrors the real completion check in executeSchedule (see
    // completeConstruction) but only for the SIMULATED clone's bookkeeping
    // — completing a project for real (creating the asset, assigning
    // ownership/profession) only ever happens once, on the real day it
    // actually occurs, in executeSchedule. Here we just need
    // hoursRemaining to be accurate for days 2-7 of the same weekly plan,
    // so a project doesn't look perpetually fresh to every day of the
    // week it's being worked on.
    sim.constructionProject.laborHoursDone += action.duration;
    if (sim.constructionProject.laborHoursDone >= sim.constructionProject.laborHoursNeeded - 0.01) {
      sim.constructionProject = null;
    }
  }
}

// ─────────────────────────────────────────────
// SINGLE-PASS DAY SCHEDULER
// ─────────────────────────────────────────────
//
// One candidate list, scored once, sorted once, allocated in one linear
// walk. No action gets re-scored after an earlier pick changes the state,
// and no action type is hand-exempted from anything. This matters for two
// reasons:
//   1. It's the honest test of the utility model. If rest ever outscores
//      productive work in the sorted list, that's a real signal that
//      something in the value chain (energy shadow price, labor
//      disutility, output prices, lambda) is out of tune — not an
//      artifact of an iterative loop compounding small bonuses. An
//      iterative re-scoring loop can hide that kind of miscalibration
//      behind its own dynamics; a single pass can't.
//   2. Work now competes on EXACTLY the same footing as everything else:
//      it's just another candidate built from goodsProduced/goodsConsumed/
//      energyCost/isLabor and scored by the same scoreAction used for
//      market visits, church, rest, everything. Previously work's value
//      was computed by a separate function (profSessionEV) using raw
//      market prices for its inputs/outputs, while every other action
//      priced goods through shadowPriceGood (which also reflects
//      use-value, not just sale price). That inconsistency is gone.
export function buildDayCandidates(npc, priorDayActions = []) {
  const WORK_DURATION = 6;
  const candidates = [];

  // ── Self-employment work block(s) ────────────────────────────────────
  // workSessionEV still decides WHICH profession to work as today
  // (primary, or a no-input fallback if primary's inputs are unaffordable)
  // — that sub-choice isn't part of the time-allocation question this
  // scheduler answers, it's a separate "what am I capable of doing right
  // now" lookup, same role as bestWageOffer() below.
  const { ev, workAs } = workSessionEV(npc);
  if (workAs && isFinite(ev)) {
    const workProf = PROFESSIONS[workAs];
    const skill    = effectiveSkill(npc, workAs);
    const capMod   = workProf.capitalGood ? (1 + Math.log1p(npc.inventory.tools ?? 0) * 0.2) : 1;
    const buildMod = buildingProductivity(workAs);
    const seasonal = workAs === 'farmer' ? (SEASONAL_GRAIN[world.season] || 1) : 1;
    const workLabel = workAs === npc.profession ? `Work (${workProf.name})` : `Casual labour (${workProf.name})`;

    // Up to two blocks/day, exactly as before. Both are scored ONCE from
    // the current snapshot — block 2 simply assumes the fatigue a first
    // block would already have cost (npc.energy - 25), which is a
    // legitimate part of scoring it upfront, not a re-score triggered by
    // block 1 actually being picked. requires/group let the single
    // allocation pass below enforce "block 2 only after block 1" and
    // "self-work and hired-labor can't both happen the same day" with
    // simple bookkeeping instead of sequential re-evaluation.
    const blockDefs = [
      { energyBefore: npc.energy,      group: 'primary-labor',   requires: null },
      { energyBefore: npc.energy - 25, group: 'primary-labor-2', requires: 'primary-labor' },
    ];
    for (const b of blockDefs) {
      if (b.energyBefore < 30) continue;
      const energyMod = b.energyBefore / 100;
      const goodsConsumed = {}, goodsProduced = {};
      let inputsOk = true;
      for (const [g, qty] of Object.entries(workProf.inputs)) {
        goodsConsumed[g] = qty;
        // Block 2 must be able to afford a SECOND round of inputs, net of
        // what block 1 would already have drawn from inventory.
        if (b.requires) {
          const haveAfterFirst = Math.max(0, (npc.inventory[g] ?? 0) - qty);
          if (haveAfterFirst < qty && npc.savings < expectedPrice(npc, g) * qty) { inputsOk = false; break; }
        }
      }
      if (!inputsOk) continue;
      for (const [g, qty] of Object.entries(workProf.outputs)) {
        goodsProduced[g] = qty * skill * capMod * buildMod * energyMod * seasonal;
      }
      const action = {
        id: 'work', label: workLabel, duration: WORK_DURATION, isLabor: true,
        energyCost: 25, goodsProduced, goodsConsumed,
        _group: b.group, _requires: b.requires,
      };
      candidates.push({ ...action, score: scoreAction(action, npc) });
    }
  }

  // ── Hired labor ───────────────────────────────────────────────────────
  // Occupies the same time slot as self-employment block 1 (same
  // 'primary-labor' group), so the allocator's group exclusion — not a
  // hand-written if/else comparison — decides which one wins, purely by
  // score. Goods produced accrue to the EMPLOYER (see executeSchedule),
  // so only the wage is scored here, not the goods.
  const wageOffer = bestWageOffer(npc);
  if (wageOffer) {
    const employer = world.npcs.get(wageOffer.employerId);
    const laborProf = PROFESSIONS[wageOffer.profId];
    const skill = effectiveSkill(npc, wageOffer.profId);
    const buildMod = buildingProductivity(wageOffer.profId);
    const seasonal = wageOffer.profId === 'farmer' ? (SEASONAL_GRAIN[world.season] || 1) : 1;
    const energyMod = npc.energy / 100;
    const goodsProduced = {};
    for (const [g, qty] of Object.entries(laborProf.outputs)) {
      goodsProduced[g] = qty * skill * buildMod * energyMod * seasonal;
    }
    // Inputs are the EMPLOYER's to supply (they own the output) — see
    // executeSchedule, which gates/scales this by the employer's actual
    // inventory the same way self-employed work is now gated. Previously
    // hired-labor output had NO input handling at all: an employer could
    // hire a miller and receive full bread output with zero grain ever
    // deducted from anywhere — a pure conservation violation, worse than
    // the self-employed version of the same bug.
    const goodsConsumed = {};
    for (const [g, qty] of Object.entries(laborProf.inputs)) {
      goodsConsumed[g] = qty;
    }
    const action = {
      id: 'hired-labor', label: `Hired labor (${laborProf.name}${employer ? ' for ' + employer.name : ''})`,
      duration: WORK_DURATION, isLabor: true, energyCost: 25,
      wage: wageOffer.wage, employerId: wageOffer.employerId, assetId: wageOffer.assetId,
      moneyEarned: wageOffer.wage, goodsConsumed,
      _group: 'primary-labor', _requires: null, _wageOfferRef: wageOffer,
    };
    // Score without goodsProduced (this NPC never receives them) but keep
    // it on the stored action so execution can still credit the employer.
    const scoringAction = { ...action };
    delete scoringAction.goodsProduced;
    candidates.push({ ...action, goodsProduced, score: scoreAction(scoringAction, npc) });
  }

  // ── Everything else: market, church, asset sale/delist, tinker, build,
  // rest, socialize ── unchanged, already generic via getAvailableActions.
  for (const a of getAvailableActions(npc)) {
    candidates.push({ ...a, score: scoreAction(a, npc) });
  }

  // ── Habit continuity ────────────────────────────────────────────────
  // Real people don't re-derive their whole week from first principles
  // every planning cycle — they adjust marginal habits and keep most of
  // their routine steady. A modest proportional boost for repeating
  // whatever this NPC did in the SAME day-of-week slot last cycle acts as
  // a switching cost: strong enough to prevent thrashing between two
  // near-equally-scored alternatives purely from small week-to-week
  // price/need noise, but a genuinely better opportunity — or a real
  // emergency, which forces an immediate out-of-cycle replan anyway (see
  // emergencyReplanNeeded) — still clears it easily. Multiplicative
  // rather than additive so it scales sensibly across the huge range of
  // magnitudes different action types score at (a market trip
  // liquidating a big surplus can score 100x a rest action) without
  // needing a separately-tuned constant per action type. It also does
  // nothing harmful to a habit that's gone bad: multiplying an
  // already-negative score by (1 + bonus) makes it MORE negative,
  // correctly abandoning a habit the world has genuinely turned against
  // rather than clinging to it.
  if (priorDayActions.length > 0) {
    const priorKeys = new Set(priorDayActions.map(a => a.id + '|' + (a._group || '')));
    for (const c of candidates) {
      const key = c.id + '|' + (c._group || '');
      if (priorKeys.has(key)) c.score *= (1 + HABIT_CONTINUITY_BONUS);
    }
  }

  return candidates;
}

// Allocates one day from a candidate list that's already fully scored —
// sort once, walk once. chosenGroups/_requires handle the only two real
// constraints that survive from the old two-pass split (self-work vs
// hired-labor are mutually exclusive; work block 2 needs block 1 first);
// everything else (market/church/tinker/asset-sale/rest/socialize) is
// naturally one-per-day simply because each appears exactly once in the
// candidate list to begin with — there's no separate "one-shot" rule to
// maintain anymore.
export function allocateDay(candidates, hoursAvailable) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const daySchedule = [];
  const chosenGroups = new Set();
  let timeLeft = hoursAvailable;

  for (const c of sorted) {
    if (timeLeft <= 0.25) break;
    if (c.score < -1 && c.id !== 'rest') continue;
    if (c._group) {
      if (chosenGroups.has(c._group)) continue;
      if (c._requires && !chosenGroups.has(c._requires)) continue;
    }

    const dur = Math.min(c.duration, timeLeft);
    daySchedule.push({ ...c, duration: dur });
    timeLeft -= dur;
    if (c._group) chosenGroups.add(c._group);
    if (dur < c.duration - 0.01) break; // partial slot used — stop rather than fragmenting further
  }

  if (timeLeft > 0.5) {
    daySchedule.push({ id: 'rest', label: 'Rest', duration: timeLeft, energyRestored: timeLeft * 12, needEffects: {} });
  }
  return daySchedule;
}

// Builds a full PLANNING_HORIZON_DAYS-day schedule: one single-pass
// allocation per simulated day, against a cloned, forward-advancing NPC
// state. Only day 0 touches real, live labor-market contention (wage
// slots); every later day forecasts using today's snapshot of prices/
// wages, same convention as every other forecast in this file — actual
// quantities/prices still resolve live, day by day, in executeSchedule/
// runMarketExchange when each day for real arrives.
export function planWeek(npc) {
  const sim = cloneNpcForPlanning(npc);
  const weekPlan = [];
  // Captured once, up front: npc.weekPlan still holds the PRIOR plan at
  // this point (we haven't overwritten it yet) — comparing new-plan day d
  // against old-plan day d is exactly "same slot in the weekly routine,"
  // since replanning happens on a consistent 7-day cadence per NPC in the
  // normal (non-emergency) case. See buildDayCandidates' habit-continuity
  // block for what this is used for.
  const priorWeekPlan = npc.weekPlan || [];

  for (let d = 0; d < PLANNING_HORIZON_DAYS; d++) {
    const candidates = buildDayCandidates(sim, priorWeekPlan[d] || []);
    const daySchedule = allocateDay(candidates, DAILY_HOURS);

    if (d === 0) {
      const hiredEntry = daySchedule.find(a => a.id === 'hired-labor');
      if (hiredEntry && hiredEntry._wageOfferRef) hiredEntry._wageOfferRef.slotsRemaining -= 1;
    }

    for (const entry of daySchedule) applySimEffects(sim, entry);
    weekPlan.push(daySchedule);

    // Advance the simulated NPC through this day's consumption/decay
    // (reuses satisfyNeeds exactly as real execution does) so day d+1 is
    // planned against a realistically progressed NPC, not a frozen
    // snapshot of today.
    sim.schedule = daySchedule;
    satisfyNeeds(sim);
  }

  npc.weekPlan = weekPlan;
}

// Entry point called once per real day per NPC (see tickDay). Decides
// whether a fresh week needs planning — on this NPC's own staggered
// weekly cadence (npc.planOffset spreads the village's planning days out
// across the week instead of everyone replanning in lockstep), or
// immediately on emergency — then hands today's slice of the current plan
// to npc.schedule for execution, unchanged from how execution always
// worked.
export function buildSchedule(npc) {
  const needsReplan =
    !npc.weekPlan || npc.weekPlan.length === 0 ||
    npc.weekPlanDay >= npc.weekPlan.length ||
    (world.day + npc.planOffset) % PLANNING_HORIZON_DAYS === 0 ||
    emergencyReplanNeeded(npc);

  if (needsReplan) {
    planWeek(npc);
    npc.weekPlanDay = 0;
  }

  const dayIdx = Math.min(npc.weekPlanDay, npc.weekPlan.length - 1);
  npc.schedule = npc.weekPlan[dayIdx] ?? [];
  npc.weekPlanDay = dayIdx + 1;
  npc.scheduleIdx = 0;
  npc.currentAction = npc.schedule[0]?.id ?? 'idle';
}

