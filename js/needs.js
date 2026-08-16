import { clamp } from './utils.js';
import { ACTIVITY_SOCIAL_CAP, FAMILY_MEANING_RATE, GOODS, MATERIAL_COMFORT_CAP, NEEDS, PRESTIGE_CONVERGENCE_RATE, PROFESSIONS, bufferStockRatio, familyChannelTarget, prestigeTarget, shouldKeepForConsumption } from './constants.js';
import { world } from './state.js';
import { CHILD_FOOD_COST_PER_DAY } from './marriage.js';

// ─────────────────────────────────────────────
// NEED SATISFACTION
// ─────────────────────────────────────────────

// How much EXTRA food (in the same raw inventory units as foodTarget/
// dailyBase) this NPC needs to buy/buffer for, beyond their own personal
// consumption, because children draw directly from a parent's inventory
// (see tickChildren) rather than having any food supply of their own.
// Without this, a parent's buying/buffering behavior stayed sized for
// ONE person even after having kids, so each child silently accelerated
// how fast the household ran out — a real, confirmed contributor to the
// starvation-driven population collapse (a parent kept buying like a
// single adult while feeding 2-4 extra mouths from the same larder).
// Both parents scale up independently (tickChildren can draw from
// either, depending on which one has stock on a given day) rather than
// splitting the total — mild double-buying is possible, but that's
// self-correcting via bread's spoilage rate, unlike running out, which
// isn't.
export function householdFoodUnits(npc) {
  return npc.childIds ? npc.childIds.length * CHILD_FOOD_COST_PER_DAY : 0;
}

export function satisfyNeeds(npc) {
  // Food from inventory — prefer bread, then grain only if surplus.
  // Millers and toolmakers protect their work inputs: they won't eat
  // grain they need for milling (above the work buffer), so production
  // inputs don't silently vanish overnight.
  let foodTarget = 2 + householdFoodUnits(npc);
  let fed = 0;

  for (const good of ['bread','grain']) {
    if (fed >= foodTarget) break;
    let have = npc.inventory[good] ?? 0;
    // For goods used as work inputs, only eat the surplus above the buffer
    const workBuffer = PROFESSIONS[npc.profession]?.inputs?.[good] ?? 0;
    const protectedQty = workBuffer > 0 ? Math.max(0, have - workBuffer * 2) : have;
    const consume = Math.min(protectedQty, foodTarget - fed);
    if (consume > 0.01) {
      npc.inventory[good] -= consume;
      fed += consume * GOODS[good].nutrition;
    }
  }

  // foodRatio: 1.0 means the NPC ate their full daily target (2 units × 0.4 nutrition = 0.8 nutrition).
  // Previously divided by foodTarget*0.4, letting NPCs hit "full" at 40% of actual intake,
  // which muted hunger signals and under-drove food demand. Now uses the real target.
  const foodRatio = Math.min(fed / (foodTarget * GOODS.bread.nutrition), 1);
  npc.needs.food = clamp(npc.needs.food + (foodRatio - 0.5) * 0.15, 0, 1);

  // Security from savings, OR from holding several days of bread in
  // reserve — a full larder is its own kind of security, independent of
  // cash on hand. Combined via max(): either is sufficient on its own,
  // matching how a subsistence household actually thinks about this (a
  // broke NPC sitting on a well-stocked larder isn't nearly as insecure
  // as their bank balance alone would suggest). See BUFFER_STOCK_EFFECTS/
  // bufferStockRatio and its mirror use in getBufferTarget, which is what
  // makes NPCs actually pursue this buffer rather than just passively
  // benefiting on the rare day they happen to have one.
  const savingsSecRatio = Math.min(npc.savings / 30, 1);
  const breadSecRatio = bufferStockRatio(npc, 'bread');
  const secRatio = Math.max(savingsSecRatio, breadSecRatio);
  npc.needs.security = clamp(npc.needs.security + (secRatio - 0.5) * 0.08, 0, 1);

  // Warmth from wood — consumed as fuel each day. Creates baseline demand
  // for woodcutters independent of toolmaking/artisanship. Feeds the
  // ACTIVITY social channel (not the composite `social` need directly —
  // see the channel combination below), same bucket socializing feeds.
  const woodHave = npc.inventory.wood ?? 0;
  const woodTarget = world.season === 'winter' ? 2 : 1;
  if (woodHave >= 0.5) {
    const woodConsumed = Math.min(woodHave, 0.5); // burn half a unit/day
    npc.inventory.wood -= woodConsumed;
    const warmthRatio = Math.min(woodConsumed / 0.5, 1);
    npc.activitySocial = clamp((npc.activitySocial ?? 0) + warmthRatio * 0.03, 0, 1);
  }

  // Comfort from fine goods — consumed the same way food is: drawn down
  // from inventory each day, satisfaction scaled to how much of the daily
  // target was met. Slower swing (0.08 vs food's 0.15) because comfort is
  // a slower-burning need than hunger. Feeds the MATERIAL comfort channel
  // — see the channel combination below for how this and family combine
  // into the actual `comfort` need everything else reads.
  //
  // Gated on shouldKeepForConsumption: comfort is discretionary (see
  // NEEDS.comfort.critical === false), so fine goods are only auto-eaten
  // for comfort when that's actually worth more than holding them for
  // sale. This is the other half of the fix in getBufferTarget — that one
  // stops a starving NPC from RESERVING fine goods instead of selling
  // them; this one stops any fine goods that are still sitting in
  // inventory (e.g. the market visit hasn't happened yet, or the Market
  // couldn't absorb them) from being silently consumed for comfort while
  // the same need crisis is in progress.
  const comfortTarget = 1;
  const luxHave = npc.inventory.luxury ?? 0;
  const luxConsumed = shouldKeepForConsumption(npc, 'luxury') ? Math.min(luxHave, comfortTarget) : 0;
  npc.inventory.luxury = luxHave - luxConsumed;
  const comfortGained = luxConsumed * GOODS.luxury.comfortValue;
  const comfortRatio = Math.min(comfortGained / (comfortTarget * GOODS.luxury.comfortValue), 1);
  npc.materialComfort = clamp((npc.materialComfort ?? 0) + (comfortRatio - 0.5) * 0.08, 0, 1);

  // Family channel — a spouse and/or children provide a standing source
  // of comfort/social/meaning, independent of goods or errands. Converges
  // smoothly toward familyChannelTarget() rather than snapping, so
  // marrying or having a child reads as a real transition. This is what
  // lets marriage/family close the gap fine goods and socializing alone
  // are capped below (see MATERIAL_COMFORT_CAP/ACTIVITY_SOCIAL_CAP) —
  // a wealthy hermit and a modest married household are no longer
  // equally able to reach full comfort/social satisfaction.
  const familyTarget = familyChannelTarget(npc);
  npc.familyChannel = clamp((npc.familyChannel ?? 0) + (familyTarget - (npc.familyChannel ?? 0)) * 0.08, 0, 1);
  npc.needs.comfort = clamp(MATERIAL_COMFORT_CAP * (npc.materialComfort ?? 0) + (1 - MATERIAL_COMFORT_CAP) * npc.familyChannel, 0, 1);

  // social's activity channel decays here directly (mirrors what the
  // generic decay loop used to do to the composite) — social is now
  // selfManaged (see NEEDS registry), so the generic loop below skips it
  // entirely and this is its only decay mechanism, applied to the
  // channel rather than the composite.
  npc.activitySocial = Math.max(0, (npc.activitySocial ?? 0) - NEEDS.social.decayPerDay);
  npc.needs.social = clamp(ACTIVITY_SOCIAL_CAP * (npc.activitySocial ?? 0) + (1 - ACTIVITY_SOCIAL_CAP) * npc.familyChannel, 0, 1);

  // Family also contributes a modest passive trickle to meaning — meaning
  // stays selfManaged:false (generic decay loop still applies to it), this
  // is just one more additive source alongside church attendance.
  npc.needs.meaning = clamp(npc.needs.meaning + familyTarget * FAMILY_MEANING_RATE, 0, 1);

  // Prestige converges toward prestigeTarget() rather than snapping —
  // same smoothing pattern as familyChannel — so a sudden windfall or
  // asset loss reads as a gradual shift in standing, not an instant jump.
  npc.needs.prestige = clamp(npc.needs.prestige + (prestigeTarget(npc) - npc.needs.prestige) * PRESTIGE_CONVERGENCE_RATE, 0, 1);

  // Natural decay for needs that DON'T already have a complete update
  // above (see NEEDS.selfManaged) — generic over the registry, so a
  // newly added need only needs one entry there, not a new line here.
  // food/security/comfort/social are skipped: their formulas above
  // already are their complete update, decay included, and
  // double-applying decay here was silently making a bad day cost ~3x
  // what a good day earned back (verified via day-by-day tracing:
  // +0.035/day on a fully-fed day vs -0.115/day on a food-less day, when
  // the intended symmetric swing was ±0.075) — a major, hard-to-notice
  // contributor to how easily NPCs fell into and got stuck in chronic
  // near-starvation.
  for (const [need, cfg] of Object.entries(NEEDS)) {
    if (cfg.selfManaged) continue;
    npc.needs[need] = Math.max(0, (npc.needs[need] ?? 0) - cfg.decayPerDay);
  }

  // Energy restoration from rest
  const restTime = npc.schedule.filter(a=>a.id==='rest').reduce((s,a)=>s+a.duration,0);
  npc.energy = Math.min(100, npc.energy + restTime * 5);
  if (npc.needs.food < 0.15) npc.energy = Math.max(0, npc.energy - 8); // starvation
}

