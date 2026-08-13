import { NEEDS, MATERIAL_COMFORT_CAP, ACTIVITY_SOCIAL_CAP, FAMILY_CHANNEL_SPOUSE_BONUS, FAMILY_CHANNEL_PER_CHILD, FAMILY_MEANING_RATE } from '../config/constants.js';

export const childContribution = 1 - Math.pow(1 - FAMILY_CHANNEL_PER_CHILD, numChildren);
  export const spouseContribution = hasSpouse ? FAMILY_CHANNEL_SPOUSE_BONUS : 0;
  return clamp(spouseContribution + (1 - spouseContribution) * childContribution, 0, 1);
}
export function familyChannelTarget(npc) {
  export const hasSpouse = npc.spouseId != null && world.npcs.has(npc.spouseId);
  export const n = npc.childIds ? npc.childIds.length : 0;
  return familyTargetFromComposition(hasSpouse, n);
}

// Marginal utility of one more unit of `need`, right now, for this NPC.
// Same formula for every need — diminishing returns via 1/(1+level) — plus
// a cliff multiplier once a need with a starvationFloor drops below it.
// The cliff is deliberately bounded (max ~4x) rather than unbounded, so a
// crisis reorders priorities decisively without blowing up the overall
// magnitude of utility/lambda the rest of the economy is calibrated
// around.
// Does this NPC currently have a roof over their head? Required for full
// rest satisfaction — a homeless NPC can still rest (there's always
// somewhere to lie down), but recovers less energy and gets less of the
// comfort/social/meaning trickle than someone resting in their own house.
// Deliberately NOT zero at 0 shelter: total collapse of rest would make
// homelessness a death spiral (can't rest -> can't work -> can't afford
// a house) rather than the hardship it should read as.
export const HOMELESS_REST_PENALTY = 0.45; // fraction of full rest value while unhoused
export function housingQuality(npc) {
  if (npc.primaryHouse != null) {
    export const house = world.assets.get(npc.primaryHouse);
    if (house && house.ownerId === npc.id) return 1.0;
  }
  // Married and living in a spouse's house (see marryCouple, which nulls
  // out the moved-in partner's own primaryHouse once consolidated into
  // one household) — still sheltered, just not the owner of record.
  if (npc.spouseId != null) {
    export const spouse = world.npcs.get(npc.spouseId);
    if (spouse && spouse.primaryHouse != null) {
      export const house = world.assets.get(spouse.primaryHouse);
      if (house && house.ownerId === spouse.id) return 1.0;
    }
  }
  return HOMELESS_REST_PENALTY;
}

export function needMarginalUtility(npc, need) {
  export const cfg = NEEDS[need];
  if (!cfg) return 0;
  export const level = npc.needs[need] ?? 0;
  export let mu = cfg.weight / (1 + level);
  if (cfg.starvationFloor > 0 && level < cfg.starvationFloor) {
    export const severity = (cfg.starvationFloor - level) / cfg.starvationFloor; // 0..1
    mu *= 1 + severity * 3; // up to ~4x at the very bottom
  }
  return mu;
}

// Any need whose starvationFloor is currently breached demands an
// immediate replan rather than waiting for the NPC's next scheduled
// planning day (see buildSchedule) — the generalized escape hatch.
export function emergencyReplanNeeded(npc) {
  for (const [need, cfg] of Object.entries(NEEDS)) {
    if (cfg.starvationFloor > 0 && (npc.needs[need] ?? 0) < cfg.starvationFloor) return true;
  }
  // A pending help request directed at ME won't otherwise be considered
  // until my next regular weekly planning day — which can be longer than
  // HELP_REQUEST_EXPIRY_DAYS (3 days). Verified via harness trace: 'help'
  // actions that scored as the clear #1 choice (up to 300+ utility/hr vs.
  // ~1 for rest) were still expiring unresolved because the target's
  // schedule had already been locked in before the request even existed.
  // Same escape-hatch pattern as the critical-need check above.
  if (world.helpRequests.some(r => r.targetId === npc.id && !r.resolved)) return true;
  return false;
}

// Which need (if any) does consuming one unit of `good` satisfy, and by
// how much? Derived entirely from GOODS' own nutrition/comfortValue
// fields — a new consumable good or a new need it satisfies is one edit
// to GOODS/this map, not a new branch in shadowPriceGood or getBufferTarget.
export function goodConsumptionEffect(good) {
  export const g = GOODS[good];
  if (!g) return null;
  if (g.nutrition > 0)    return { need: 'food',    amount: g.nutrition };
  if (g.comfortValue > 0) return { need: 'comfort', amount: g.comfortValue };
  return null;
}

// Is it worth keeping one more unit of `good` for personal consumption
// today, vs. selling it? Critical needs (food) always get their fixed
// daily intake reserve — see NEEDS.critical and getBufferTarget.
//
// For a DISCRETIONARY good (comfort, and any future non-critical need),
// the default is also to keep the reserve — comfort goods are meant to be
// enjoyed, not perpetually monetized. Comparing raw useValue against
// sellNow (price * lambda) directly doesn't work as an every-day gate:
// lambda's typical magnitude is dominated by food's much larger weight
// even when the NPC is perfectly well-fed, so that comparison would
// almost always favor selling regardless of actual hunger — silently
// collapsing the entire comfort-goods economy rather than fixing the
// starving-artisan case it was meant to target.
//
// So the reserve is only released when a CRITICAL need is genuinely in
// its own starvation-floor crisis right now — the direct generalization
// of the old single-purpose "if food is urgent, sell fine goods instead"
// override, except keyed off the NEEDS registry (any critical need, not
// just food) instead of a hardcoded threshold on one specific need.
export function shouldKeepForConsumption(npc, good) {
  export const effect = goodConsumptionEffect(good);
  if (!effect) return true;
  if (NEEDS[effect.need].critical) return true;

  for (const [need, cfg] of Object.entries(NEEDS)) {
    if (cfg.critical && cfg.starvationFloor > 0 && (npc.needs[need] ?? 0) < cfg.starvationFloor) {
      return false; // a critical need is in crisis — sell for cash instead of self-consuming
    }
  }
  return true;
}

// Some goods ease a need just by being held in reserve, independent of
// being consumed — a full larder eases anxiety about tomorrow before any
// of it is actually eaten. This is a STOCK effect (how many days' worth
// you have banked), distinct from goodConsumptionEffect's FLOW effect
// (what satisfies a need when you use one unit right now). Amount is
// expressed in "days of daily intake" so it composes with the same
// foodTarget/nutrition math satisfyNeeds already uses for the food need
// itself, rather than needing its own separate unit system. Adding
// another good/need pair here (e.g. stored wood easing security through a
// hard winter) is one line, same versatility principle as NEEDS/
// goodConsumptionEffect.
export const BUFFER_STOCK_EFFECTS = {
  // daysForFullBenefit tested at 5 first: with ~48 NPCs simultaneously
  // chasing a 10-unit buffer of bread (which perishes at 15%/day), demand
  // overwhelmed supply and drove a village-wide price spiral (bread
  // roughly tripled, savings collapsed faster than the buffer effect
  // stabilized security) -- a classic "individually rational hoarding
  // becomes collectively self-defeating" dynamic. 2 days (4 units) still
  // gives the security benefit real weight without triggering that
  // spiral in testing; worth revisiting if the target profession mix or
  // bread supply changes.
  bread: { need: 'security', daysForFullBenefit: 2 },
};

// What fraction (0..1) of the "full benefit" buffer size does this NPC
// currently hold for `good`? Used both to actually grant the stock-based
// need benefit (satisfyNeeds) and to size how much of that buffer the NPC
// tries to keep on hand (getBufferTarget) — one number driving both the
// felt benefit and the purchasing target that pursues it.
export function bufferStockRatio(npc, good) {
  export const cfg = BUFFER_STOCK_EFFECTS[good];
  if (!cfg) return 0;
  export const dailyTarget = 2 * GOODS[good].nutrition; // matches satisfyNeeds' daily food-intake target
  if (dailyTarget <= 0) return 0;
  export const daysOnHand = ((npc.inventory[good] ?? 0) * GOODS[good].nutrition) / dailyTarget;
  return Math.min(daysOnHand / cfg.daysForFullBenefit, 1);
}

export const SEASONAL_GRAIN = { spring:2.0, summer:2.0, autumn:2.0, winter:2.0 };
export const LABOR_DISUTILITY = 4;
