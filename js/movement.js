import { PROFESSIONS, findStructureByAssetId, findStructureByType } from './constants.js';
import { world } from './state.js';

// ─────────────────────────────────────────────
// SUB-DAY MOVEMENT (VISUAL LAYER ONLY)
// ─────────────────────────────────────────────
//
// This module reads state (npc.schedule, world.structures) that the
// economic simulation has already fully computed and resolved for the
// day — buildSchedule()/executeSchedule() in scheduler.js/execution.js
// run schedule actions to completion in one shot inside tickDay(),
// independent of anything in here. This file exists purely to decide,
// frame by frame, which building an NPC should currently be *drawn*
// walking toward, so the game loop's existing position-lerp in
// render.js has something more interesting to glide between than one
// destination per day.
//
// Hard rule: nothing in this file may write to any field the economic
// simulation reads back (inventory, savings, needs, energy, skills,
// relations, primaryAsset, etc.) — only the visual fields destX/destY/
// currentAction, plus a private _moveActionRef bookkeeping field this
// module owns exclusively (see updateScheduleMovement below) and no
// other file reads or writes. If this whole module were deleted and
// never called, tickDay() would produce byte-identical economic
// results; the village would just stop visibly walking between
// buildings.
//
// Also deliberately uses its own Math.random()-based jitter rather than
// the shared seeded `rng` from rng.js — that stream feeds the actual
// simulation's determinism, and drawing extra numbers from it once per
// frame (an unpredictable, framerate-dependent count) would silently
// desync the sim's random sequence from a headless/heedless run. Visual
// jitter doesn't need to be seeded or reproducible, so it gets its own
// source.

function jitter(range) {
  return (Math.random() * 2 - 1) * range;
}

const HOME_JITTER = 8;
const BUILD_JITTER = 12;
const MARKET_JITTER = 15;
const CHURCH_JITTER = 15;
const SOCIAL_JITTER = 40;
const TOWN_CENTER = { x: 380, y: 280 }; // matches the socialize spot simulation.js used previously

// Resolves the (x, y) an NPC should be walking toward for a single
// schedule action. Pure function of already-known state — no side
// effects, no economic reads/writes.
export function resolveActionDestination(npc, action) {
  if (!action) return { x: npc.homeX, y: npc.homeY };

  if (action.id === 'work' || action.id === 'hired-labor') {
    let workBuilding = null;
    if (action.id === 'hired-labor' && action.assetId != null) {
      workBuilding = findStructureByAssetId(action.assetId);
    } else if (npc.primaryAsset != null) {
      workBuilding = findStructureByAssetId(npc.primaryAsset);
    }
    if (!workBuilding && PROFESSIONS[npc.profession]?.requires) {
      workBuilding = findStructureByType(PROFESSIONS[npc.profession].requires);
    }
    if (workBuilding) {
      return { x: workBuilding.x + jitter(BUILD_JITTER), y: workBuilding.y + jitter(BUILD_JITTER) };
    }
    return { x: npc.homeX + jitter(20), y: npc.homeY + 30 + jitter(10) };
  }

  if (action.id === 'market') {
    const marketBuilding = findStructureByType('market');
    if (marketBuilding) {
      return { x: marketBuilding.x + jitter(MARKET_JITTER), y: marketBuilding.y + jitter(MARKET_JITTER) };
    }
  }

  if (action.id === 'church') {
    const churchBuilding = findStructureByType('church');
    if (churchBuilding) {
      return { x: churchBuilding.x + jitter(CHURCH_JITTER), y: churchBuilding.y + jitter(CHURCH_JITTER) };
    }
  }

  if (action.id === 'socialize') {
    return { x: TOWN_CENTER.x + jitter(SOCIAL_JITTER), y: TOWN_CENTER.y + jitter(SOCIAL_JITTER) };
  }

  // rest, tinker, build (no structure exists yet mid-construction),
  // seek_marriage, seek_child, ask_help, help, list/delist-asset-sale,
  // and anything unrecognized all default to "at home" — matches the
  // fallback the old single-shot destination code used.
  return { x: npc.homeX + jitter(HOME_JITTER), y: npc.homeY + jitter(HOME_JITTER) };
}

// Walks the cumulative duration of npc.schedule to find which action
// slot a given point in the day (dayFraction, 0..1) falls in. Schedule
// durations are in hours and sum to the day's total scheduled hours
// (see allocateDay in scheduler.js) — dayFraction=0 is the start of the
// first slot, dayFraction=1 is the end of the last.
function scheduleActionAt(npc, dayFraction) {
  const schedule = npc.schedule;
  if (!schedule || schedule.length === 0) return null;
  let total = 0;
  for (const a of schedule) total += a.duration || 0;
  if (total <= 0) return schedule[0];

  const targetHours = Math.max(0, Math.min(1, dayFraction)) * total;
  let cum = 0;
  for (const action of schedule) {
    cum += action.duration || 0;
    if (targetHours <= cum) return action;
  }
  return schedule[schedule.length - 1];
}

// Called once per animation frame (from drawScene). dayFraction is how
// far real time has progressed through the current sim-day, as already
// computed by the game loop's accumulator/simTickMs ratio — the same
// value that used to be passed into drawScene and ignored. Only
// touches destX/destY/currentAction; picks a fresh jittered spot only
// when the NPC actually crosses into a new schedule slot.
//
// Change-detection deliberately does NOT compare against
// npc.currentAction: both scheduler.js (buildSchedule) and
// scheduleBdi.js (planWeek) set npc.currentAction = schedule[0].id the
// moment they build the day's schedule, inside tickDay() — i.e. before
// this function ever runs for that day. Comparing against
// currentAction would see it already matching schedule[0].id and wrongly
// conclude "no change", so the very first slot of every day would keep
// whatever destX/destY was left over from the END of the previous day
// (commonly wherever the NPC's last action happened to be — church,
// most visibly) instead of walking to today's first destination.
// Comparing by the schedule ACTION OBJECT's identity instead sidesteps
// this entirely: buildSchedule/planWeek construct a brand-new array of
// action objects every day, so day 1's identity is never day 2's, even
// when both happen to be a 'work' action — guaranteeing a fresh
// destination gets picked the moment a new day's first slot is reached,
// regardless of what currentAction was already set to.
export function updateScheduleMovement(dayFraction) {
  for (const npc of world.npcs.values()) {
    const action = scheduleActionAt(npc, dayFraction);
    if (!action) continue;
    if (npc._moveActionRef !== action) {
      npc._moveActionRef = action;
      npc.currentAction = action.id;
      const { x, y } = resolveActionDestination(npc, action);
      npc.destX = x;
      npc.destY = y;
    }
  }
}
