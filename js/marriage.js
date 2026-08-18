import { ACTIVITY_SOCIAL_CAP, CHILDHOOD_DAYS, DOG_YEAR_DAYS, GOODS, GRID_ANCHOR, GRID_CELL, MATERIAL_COMFORT_CAP, NEEDS, familyChannelTarget, familyTargetFromComposition, generateChildName, needMarginalUtility } from './constants.js';
import { rng } from './rng.js';
import { bumpAffinity, getAffinity, logEvent, seedKinshipAffinity, world } from './state.js';
import { makeNPC } from './npc.js';

// ─────────────────────────────────────────────
// MARRIAGE & CHILDBIRTH
// ─────────────────────────────────────────────
//
// Both are modeled as scored, schedulable ACTIONS ('seek_marriage',
// 'seek_child') competing for time in the same single-pass scoring as
// everything else — not a silent background process — so an NPC who's
// too busy surviving a food crisis can genuinely never get around to
// either, exactly like any other discretionary action.
//
// Family stays deliberately "light": spouses and children don't get a
// joint household optimizer (see the design discussion) — each adult
// NPC still runs its own independent scoreAction/schedule. What's shared
// is bookkeeping (spouseId, childIds, the familyChannel needs math) and,
// for marriage specifically, a matching step (mutual consent can't be
// decided by one side's score alone).
//
// Both include an explicit, tunable EXOGENOUS bonus (MARRIAGE_DRIVE_BONUS /
// CHILDBIRTH_DRIVE_BONUS) representing the innate human pull toward
// pair-bonding/reproduction that isn't reducible to the modeled need
// satisfaction alone — same architectural pattern as HABIT_CONTINUITY_BONUS
// (one visible, uniformly-applied knob), not a per-NPC special case. If
// people end up marrying/having children even while starving, that's a
// sign this bonus is overpowering the real economics and needs tuning
// down, not a sign the underlying needs math is wrong — the same
// diagnostic discipline applied to habit continuity and re-scoring loops.

export const MARRIAGE_DRIVE_BONUS   = 3;
export const MARRIAGE_CASH_COST     = 20;  // wedding cost, split between the couple
export const CHILDBIRTH_DRIVE_BONUS = 2;
export const CHILDBIRTH_MATERIAL_COST = 15; // midwife/supplies, split between parents — real coin cost, deducted in attemptChildbirth
// Flat utility cost of the burden of pregnancy/newborn care, on the same
// scale as the comfort/social/meaning utility gains above. Deliberately
// NOT lambda*CHILDBIRTH_MATERIAL_COST — lambda is calibrated against
// food (weight 100), so converting a 15-coin cost through it produces a
// number an order of magnitude larger than anything comfort/social/
// meaning (weight 15-25) can ever offset, making childbirth score
// negative unconditionally regardless of how much a couple wants a
// child. Verified via harness: lambda~6.7 in a typical run -> cost~101
// against a gain of ~6 — see the same mismatch class as considerHouseConstruction's
// original EV-comparison attempt.
export const CHILDBIRTH_UTILITY_COST = 3;
export const CHILD_FOOD_COST_PER_DAY  = 0.4; // roughly a child's share of an adult's daily bread target
export const MAX_CHILDREN_PER_COUPLE = 5;   // familyChannelTarget's diminishing returns already discourage more than a few; this is just a hard backstop
// Was `Math.round(CHILDHOOD_DAYS * 0.4)` (CHILDHOOD_DAYS === 150, from
// constants.js) — inlined as a literal instead of importing CHILDHOOD_DAYS
// here, since constants.js transitively imports this file (via npc.js) and
// referencing CHILDHOOD_DAYS at this module's top level would read it
// before constants.js's own top-level body has run.
// A family can reconsider after a little over one dog-year. Compute this at
// decision time (rather than module initialization) because this module
// participates in the NPC/constants import cycle.
export function minimumBirthSpacingDays() {
  return DOG_YEAR_DAYS * 1.2;
}
export const CHILDBIRTH_MAX_AGE_DOGYEARS = 8; // past this, seek_child is no longer offered at all
export const STARVATION_DEATH_DAYS = 25; // consecutive days at/below NEEDS.food.starvationFloor before death — a real cliff, not just a scoring penalty

// Utility gain (in the same need-marginal-utility units scoreAction
// already uses everywhere) from moving familyChannelTarget from its
// current value to what it WOULD be with one more spouse (marriage) or
// child (childbirth). Treats the gain as if it fully materializes today
// — an approximation (the real channel converges gradually, see
// satisfyNeeds), same spirit as computeConstructionEV pricing a
// hypothetical finished asset instead of modeling the ramp-up in detail.
export function marriageUtilityGain(npc) {
  const before = familyChannelTarget(npc);
  const n = npc.childIds ? npc.childIds.length : 0;
  const after = familyTargetFromComposition(/*hasSpouse=*/true, n);
  return familyUtilityFromDelta(npc, after - before);
}
export function childbirthUtilityGain(npc) {
  const before = familyChannelTarget(npc);
  const hasSpouse = npc.spouseId != null && world.npcs.has(npc.spouseId);
  const n = (npc.childIds ? npc.childIds.length : 0) + 1;
  const after = familyTargetFromComposition(hasSpouse, n);
  return familyUtilityFromDelta(npc, after - before);
}
export function familyUtilityFromDelta(npc, delta) {
  const muComfort = needMarginalUtility(npc, 'comfort');
  const muSocial  = needMarginalUtility(npc, 'social');
  const muMeaning = needMarginalUtility(npc, 'meaning');
  return delta * ((1 - MATERIAL_COMFORT_CAP) * muComfort + (1 - ACTIVITY_SOCIAL_CAP) * muSocial + muMeaning);
}

// Called once per day (see tickDay) against whoever executed 'seek_marriage'
// TODAY (npc._seekingMarriageToday) — a standing "I'm looking" status is
// re-earned each day by the action actually winning its slot, not a
// permanent flag, consistent with nothing else in this scheduler
// fossilizing a past decision either.
export const HELP_REQUEST_EXPIRY_DAYS = 3;
// Only counts as refusal (a real social penalty) if the target already
// had SOME established goodwill toward the requester and visibly had the
// means to help — a stranger not noticing, or someone genuinely too poor
// to spare it, isn't betrayal. This guards against every unmet request
// diluting the signal into "everyone dinged for everything" (see design
// discussion) — refusal should mean someone who should have helped chose
// not to.
export const HELP_REFUSAL_AFFINITY_THRESHOLD = 0.15;
export const HELP_REFUSAL_PENALTY = 0.12;

// Cleans up the request queue daily: drops anything already resolved
// (granted at execution time — see executeSchedule), and for anything
// that expired unresolved, checks whether it reads as a real refusal
// before dropping it. Only the REQUESTER's view of the target moves here
// — the target's own affinity is untouched, since declining (or simply
// never getting around to it) isn't itself an action that should change
// how the target feels about the requester.
export function resolveHelpRequests() {
  world.helpRequests = world.helpRequests.filter(req => {
    if (req.resolved) return false;
    if (world.day - req.day < HELP_REQUEST_EXPIRY_DAYS) return true;
    const target = world.npcs.get(req.targetId);
    const requester = world.npcs.get(req.requesterId);
    if (target && requester) {
      const establishedGoodwill = getAffinity(target, req.requesterId) >= HELP_REFUSAL_AFFINITY_THRESHOLD;
      const hadCapacity = target.savings > req.amount + 5;
      if (establishedGoodwill && hadCapacity) {
        bumpAffinity(requester, target.id, -HELP_REFUSAL_PENALTY);
        logEvent(`${requester.name} felt let down after ${target.name} didn't come through in their time of need.`, [requester.id, target.id]);
      }
    }
    return false;
  });
}

export function runMarriageMarket() {
  const seekers = [...world.npcs.values()].filter(n => n._seekingMarriageToday && n.spouseId == null);
  for (let i = seekers.length - 1; i > 0; i--) {
    const j = Math.floor(rng.float(0, i + 1));
    [seekers[i], seekers[j]] = [seekers[j], seekers[i]];
  }
  const matched = new Set();
  for (const a of seekers) {
    if (matched.has(a.id)) continue;
    let bestB = null, bestJoint = -Infinity;
    for (const b of seekers) {
      if (b.id === a.id || matched.has(b.id)) continue;
      const gainA = marriageUtilityGain(a), gainB = marriageUtilityGain(b);
      if (gainA <= 0 || gainB <= 0) continue; // BOTH sides must genuinely benefit, not just the proposer
      const joint = gainA + gainB;
      if (joint > bestJoint) { bestJoint = joint; bestB = b; }
    }
    if (bestB) { marryCouple(a, bestB); matched.add(a.id); matched.add(bestB.id); }
  }
}

export function marryCouple(a, b) {
  const costEach = MARRIAGE_CASH_COST / 2;
  a.savings = Math.max(0, a.savings - costEach);
  b.savings = Math.max(0, b.savings - costEach);
  world.church.cash += costEach * 2; // wedding fee — same redistribution pool as tithes, not a sink
  a.spouseId = b.id;
  b.spouseId = a.id;
  // Consolidate into one household home. Whichever spouse has a house
  // keeps it as the marital home; the other's own house (if any) becomes
  // a genuine spare asset — no longer their primaryHouse, so it now
  // correctly surfaces as sellable via the existing idle-asset-sale path
  // (see getIdleAssets) instead of being permanently protected as "lived
  // in." housingQuality() falls back to a spouse's house automatically,
  // so the moved-in partner stays fully sheltered either way.
  if (a.primaryHouse != null) {
    b.homeX = a.homeX; b.homeY = a.homeY; b.primaryHouse = null;
  } else if (b.primaryHouse != null) {
    a.homeX = b.homeX; a.homeY = b.homeY; a.primaryHouse = null;
  }
  logEvent(`${a.name} and ${b.name} are married.`, [a.id, b.id]);
  seedKinshipAffinity(a.id, b.id);
}

// Executed directly when an NPC's schedule includes 'seek_child' (see
// getAvailableActions) — re-validated here rather than trusting the
// scoring-time check, since a day can pass between when the action was
// scored and when it executes.
export function attemptChildbirth(npc) {
  const spouse = world.npcs.get(npc.spouseId);
  if (!spouse) return;
  if (npc.childIds.length >= MAX_CHILDREN_PER_COUPLE) return;
  if (npc.age >= CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS) return;
  if (spouse.age >= CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS) return;
  if ((world.day - npc.lastChildbirthDay) < minimumBirthSpacingDays()) return;
  if ((world.day - spouse.lastChildbirthDay) < minimumBirthSpacingDays()) return;
  const combinedSavings = npc.savings + spouse.savings;
  if (combinedSavings < CHILDBIRTH_MATERIAL_COST) return;
  const share = Math.min(npc.savings, CHILDBIRTH_MATERIAL_COST / 2);
  npc.savings -= share;
  spouse.savings -= (CHILDBIRTH_MATERIAL_COST - share);
  world.church.cash += CHILDBIRTH_MATERIAL_COST; // midwife/blessing fee — same pool as tithes, not a sink
  spawnChild(npc, spouse);
}

export let nextChildId = 0;
export function spawnChild(mother, father) {
  const { name, syllables } = generateChildName(mother.syllables, father.syllables, rng);
  const child = { id: nextChildId++, name, syllables, parentIds: [mother.id, father.id], age: 0 };
  world.children.set(child.id, child);
  mother.childIds.push(child.id);
  father.childIds.push(child.id);
  mother.lastChildbirthDay = world.day;
  father.lastChildbirthDay = world.day;
  world.totalBirths++;
  logEvent(`${mother.name} and ${father.name} welcome a child, ${child.name}.`, [mother.id, father.id]);
  seedKinshipAffinity(mother.id, child.id);
  seedKinshipAffinity(father.id, child.id);
}

// Ages every child one day, draws their food cost from whichever parent
// can afford it (real goods/cash, same "not a free byproduct" principle
// as every other consumption in this sim), and matures them into a real,
// independent NPC once they clear CHILDHOOD_DAYS.
export function tickChildren() {
  for (const child of [...world.children.values()]) {
    child.age++;
    const parents = child.parentIds.map(id => world.npcs.get(id)).filter(Boolean);
    let fed = false;
    for (const p of parents) {
      if ((p.inventory.bread ?? 0) >= CHILD_FOOD_COST_PER_DAY) {
        p.inventory.bread -= CHILD_FOOD_COST_PER_DAY;
        fed = true; break;
      }
    }
    if (!fed) {
      const cost = CHILD_FOOD_COST_PER_DAY * (world.market.goods.bread?.askPrice ?? GOODS.bread.baseValue);
      for (const p of parents) {
        if (p.savings > cost) {
          p.savings -= cost;
          world.market.goods.bread.cash += cost; // emergency bread purchase — same pattern as every other food buy, not a sink
          fed = true; break;
        }
      }
    }
    // If truly neither parent can afford it, nothing further happens yet
    // — child wellbeing/mortality isn't modeled in this first pass; the
    // hardship shows up entirely through the parents' own strained
    // finances, which is a real but incomplete proxy worth revisiting.

    if (child.age >= CHILDHOOD_DAYS) graduateChild(child);
  }
}

export function graduateChild(child) {
  world.children.delete(child.id);
  for (const pid of child.parentIds) {
    const p = world.npcs.get(pid);
    if (p) p.childIds = p.childIds.filter(id => id !== child.id);
  }
  // Becomes a real, independent NPC — starts as a woodcutter (needs no
  // owned asset or skill gate, same as any other asset-less newcomer) and
  // homeless until they can build/afford their own place (see
  // considerHouseConstruction). A nice future hook for the tier-
  // progression vision: let them inherit a parent's asset instead of
  // starting from zero — deliberately not built yet.
  const parent = child.parentIds.map(id => world.npcs.get(id)).find(Boolean);
  const npc = makeNPC('woodcutter', parent ? parent.homeX : GRID_ANCHOR.gx * GRID_CELL, parent ? parent.homeY : GRID_ANCHOR.gy * GRID_CELL);
  npc.name = child.name;
  npc.syllables = child.syllables;
  npc.age = CHILDHOOD_DAYS;
  npc.parentIds = child.parentIds.slice();
  npc.homeX = npc.x; npc.homeY = npc.y;
  npc.savings = 40; // a modest start, not a full inheritance
  world.npcs.set(npc.id, npc);
  logEvent(`${npc.name} comes of age and starts an independent life.`, [npc.id, ...(npc.parentIds || [])]);
}
