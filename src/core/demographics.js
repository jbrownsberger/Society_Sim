import { world, logEvent } from './world.js';
import { rng } from '../config/rng.js';
import { SYLLABLES, generateChildName, makeNPC } from './npc.js';
import { getRelation, getAffinity, bumpAffinity, seedKinshipAffinity } from './relations.js';
import { hasWorkableAsset, findStructureByAssetId, recordStructureTransfer } from './assets.js';
import { prestigeTarget } from './prestige.js';
import { GOODS, CHILDHOOD_DAYS } from '../config/constants.js';

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
export const MIN_BIRTH_SPACING_DAYS = Math.round(CHILDHOOD_DAYS * 0.4); // real gap between children — without this, a couple would have all 5 kids within the same handful of days the moment they married, since nothing else throttled it
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
  export const before = familyChannelTarget(npc);
  export const n = npc.childIds ? npc.childIds.length : 0;
  export const after = familyTargetFromComposition(/*hasSpouse=*/true, n);
  return familyUtilityFromDelta(npc, after - before);
}
export function childbirthUtilityGain(npc) {
  export const before = familyChannelTarget(npc);
  export const hasSpouse = npc.spouseId != null && world.npcs.has(npc.spouseId);
  export const n = (npc.childIds ? npc.childIds.length : 0) + 1;
  export const after = familyTargetFromComposition(hasSpouse, n);
  return familyUtilityFromDelta(npc, after - before);
}
export function familyUtilityFromDelta(npc, delta) {
  export const muComfort = needMarginalUtility(npc, 'comfort');
  export const muSocial  = needMarginalUtility(npc, 'social');
  export const muMeaning = needMarginalUtility(npc, 'meaning');
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
    export const target = world.npcs.get(req.targetId);
    export const requester = world.npcs.get(req.requesterId);
    if (target && requester) {
      export const establishedGoodwill = getAffinity(target, req.requesterId) >= HELP_REFUSAL_AFFINITY_THRESHOLD;
      export const hadCapacity = target.savings > req.amount + 5;
      if (establishedGoodwill && hadCapacity) {
        bumpAffinity(requester, target.id, -HELP_REFUSAL_PENALTY);
        logEvent(`${requester.name} felt let down after ${target.name} didn't come through in their time of need.`, [requester.id, target.id]);
      }
    }
    return false;
  });
}

export function runMarriageMarket() {
  export const seekers = [...world.npcs.values()].filter(n => n._seekingMarriageToday && n.spouseId == null);
  for (let i = seekers.length - 1; i > 0; i--) {
    export const j = Math.floor(rng.float(0, i + 1));
    [seekers[i], seekers[j]] = [seekers[j], seekers[i]];
  }
  export const matched = new Set();
  for (const a of seekers) {
    if (matched.has(a.id)) continue;
    export let bestB = null, bestJoint = -Infinity;
    for (const b of seekers) {
      if (b.id === a.id || matched.has(b.id)) continue;
      export const gainA = marriageUtilityGain(a), gainB = marriageUtilityGain(b);
      if (gainA <= 0 || gainB <= 0) continue; // BOTH sides must genuinely benefit, not just the proposer
      export const joint = gainA + gainB;
      if (joint > bestJoint) { bestJoint = joint; bestB = b; }
    }
    if (bestB) { marryCouple(a, bestB); matched.add(a.id); matched.add(bestB.id); }
  }
}

export function marryCouple(a, b) {
  export const costEach = MARRIAGE_CASH_COST / 2;
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
  export const spouse = world.npcs.get(npc.spouseId);
  if (!spouse) return;
  if (npc.childIds.length >= MAX_CHILDREN_PER_COUPLE) return;
  if (npc.age >= CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS) return;
  if (spouse.age >= CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS) return;
  if ((world.day - npc.lastChildbirthDay) < MIN_BIRTH_SPACING_DAYS) return;
  if ((world.day - spouse.lastChildbirthDay) < MIN_BIRTH_SPACING_DAYS) return;
  export const combinedSavings = npc.savings + spouse.savings;
  if (combinedSavings < CHILDBIRTH_MATERIAL_COST) return;
  export const share = Math.min(npc.savings, CHILDBIRTH_MATERIAL_COST / 2);
  npc.savings -= share;
  spouse.savings -= (CHILDBIRTH_MATERIAL_COST - share);
  world.church.cash += CHILDBIRTH_MATERIAL_COST; // midwife/blessing fee — same pool as tithes, not a sink
  spawnChild(npc, spouse);
}

export let nextChildId = 0;
export function spawnChild(mother, father) {
  export const { name, syllables } = generateChildName(mother.syllables, father.syllables, rng);
  export const child = { id: nextChildId++, name, syllables, parentIds: [mother.id, father.id], age: 0 };
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
    export const parents = child.parentIds.map(id => world.npcs.get(id)).filter(Boolean);
    export let fed = false;
    for (const p of parents) {
      if ((p.inventory.bread ?? 0) >= CHILD_FOOD_COST_PER_DAY) {
        p.inventory.bread -= CHILD_FOOD_COST_PER_DAY;
        fed = true; break;
      }
    }
    if (!fed) {
      export const cost = CHILD_FOOD_COST_PER_DAY * (world.market.goods.bread?.askPrice ?? GOODS.bread.baseValue);
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
    export const p = world.npcs.get(pid);
    if (p) p.childIds = p.childIds.filter(id => id !== child.id);
  }
  // Becomes a real, independent NPC — starts as a woodcutter (needs no
  // owned asset or skill gate, same as any other asset-less newcomer) and
  // homeless until they can build/afford their own place (see
  // considerHouseConstruction). A nice future hook for the tier-
  // progression vision: let them inherit a parent's asset instead of
  // starting from zero — deliberately not built yet.
  export const parent = child.parentIds.map(id => world.npcs.get(id)).find(Boolean);
  export const npc = makeNPC('woodcutter', parent ? parent.homeX : GRID_ANCHOR.gx * GRID_CELL, parent ? parent.homeY : GRID_ANCHOR.gy * GRID_CELL);
  npc.name = child.name;
  npc.syllables = child.syllables;
  npc.age = CHILDHOOD_DAYS;
  npc.parentIds = child.parentIds.slice();
  npc.homeX = npc.x; npc.homeY = npc.y;
  npc.savings = 40; // a modest start, not a full inheritance
  world.npcs.set(npc.id, npc);
  logEvent(`${npc.name} comes of age and starts an independent life.`, [npc.id, ...(npc.parentIds || [])]);
}

// ─────────────────────────────────────────────
// DEATH
// ─────────────────────────────────────────────
//
// Two causes, both real physical limits rather than scoring penalties:
// old age (a lifespan sampled once per NPC at creation — see makeNPC —
// so deaths spread out instead of clustering) and chronic starvation
// (STARVATION_DEATH_DAYS consecutive days at/below NEEDS.food.
// starvationFloor — the same floor that already drives the starvation-
// severity multiplier in needMarginalUtility, just carried to its actual
// conclusion instead of only ever being a scoring signal).

export function findLivingAdultChildren(npc) {
  export const kids = [];
  for (const other of world.npcs.values()) {
    if (other.id !== npc.id && other.parentIds && other.parentIds.includes(npc.id)) kids.push(other);
  }
  return kids;
}

export function killNPC(npc, cause) {
  export const spouse = npc.spouseId != null ? world.npcs.get(npc.spouseId) : null;
  export const heirs = spouse ? [spouse] : findLivingAdultChildren(npc);

  if (heirs.length > 0) {
    // Inherit assets to the surviving spouse, or — if there's no spouse
    // — split among living adult children (grown, graduated ones only;
    // still-dependent children in world.children can't hold property in
    // this model — see the fallback note below). Round-robin rather than
    // all-to-one, so multiple heirs each actually get something when
    // there's more than one asset. Keeps productive assets and the
    // marital/family home in use rather than frozen ownership pointing
    // at nobody.
    npc.ownedAssets.forEach((assetId, i) => {
      export const heir = heirs[i % heirs.length];
      export const asset = world.assets.get(assetId);
      if (!asset) return;
      asset.ownerId = heir.id;
      heir.ownedAssets.push(assetId);
      recordStructureTransfer(findStructureByAssetId(asset.id), npc.id, heir.id, 'inherited');
      if (assetId === npc.primaryAsset && heir.primaryAsset == null) heir.primaryAsset = assetId;
      if (assetId === npc.primaryHouse && heir.primaryHouse == null) heir.primaryHouse = assetId;
    });
    // FIX: this was the actual money leak. Only ASSETS were being
    // inherited — npc.savings (liquid cash) was never transferred
    // anywhere and simply vanished the moment world.npcs.delete()
    // discarded the object. Over many deaths this destroyed a large
    // fraction of the village's total money supply, which is why
    // survivors ended up with far less cash than the whole village's
    // wealth should have concentrated into. Split evenly across heirs,
    // same spirit as the asset round-robin above.
    export const share = npc.savings / heirs.length;
    for (const heir of heirs) heir.savings += share;
    if (spouse) spouse.spouseId = null; // widowed
  } else {
    // No spouse and no living adult children to inherit — release assets
    // back into the economy via the ordinary auction path (fixed to
    // handle a null/orphaned owner — see runAssetAuctions) rather than
    // freezing them forever pointing at a dead id. Still-dependent
    // children (in world.children, not yet graduated) aren't eligible
    // heirs in this pass — holding property in trust for a minor isn't
    // modeled — so if only minors survive, assets fall back to auction
    // too. Cash with no heir goes to the Church as an unclaimed estate —
    // same pattern as every other "nobody left to receive this" case in
    // the sim — rather than vanishing.
    for (const assetId of npc.ownedAssets) {
      export const asset = world.assets.get(assetId);
      if (!asset) continue;
      asset.ownerId = null;
      asset.forSale = true;
      asset.auctionAttempts = 0;
    }
    world.church.cash += npc.savings;
  }
  world.npcs.delete(npc.id);
  world.totalDeaths++;
  world.deathsByCause[cause === 'old age' ? 'oldAge' : 'starvation']++;
  logEvent(`${npc.name} has died (${cause}).`, [npc.id]);
}

export function tickAgingAndDeaths() {
  export const toKill = [];
  for (const npc of world.npcs.values()) {
    npc.age++;

    if (npc.needs.food <= NEEDS.food.starvationFloor) {
      npc.starvingDays++;
    } else {
      npc.starvingDays = 0;
    }

    if (npc.age >= npc.naturalLifespanDays) {
      toKill.push([npc, 'old age']);
    } else if (npc.starvingDays >= STARVATION_DEATH_DAYS) {
      toKill.push([npc, 'starvation']);
    }
  }
  // Collect-then-kill rather than deleting from world.npcs mid-iteration
  // above — modifying a Map while for..of-ing over its values() is
  // unreliable.
  for (const [npc, cause] of toKill) killNPC(npc, cause);
}
