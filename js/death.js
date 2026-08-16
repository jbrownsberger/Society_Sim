import { clamp } from './utils.js';
import { BUFFER_STOCK_EFFECTS, DOG_YEAR_DAYS, NEEDS, PRESTIGE_HELP_GAIN, PROFESSIONS, WORK_SESSION_HOURS, findStructureByAssetId, housingQuality, recordStructureTransfer, shouldKeepForConsumption } from './constants.js';
import { getAffinity, logEvent, world } from './state.js';
import { expectedPrice, lambda, marketAsk, speculativeCarryValue } from './prices.js';
import { profSessionEV } from './valuation.js';
import { planAssetSaleActions, planChurchVisit, planConstructionAction, planMarketVisit, planTinkerAction } from './actions.js';
import { CHILDBIRTH_DRIVE_BONUS, CHILDBIRTH_MATERIAL_COST, CHILDBIRTH_MAX_AGE_DOGYEARS, CHILDBIRTH_UTILITY_COST, MARRIAGE_DRIVE_BONUS, MAX_CHILDREN_PER_COUPLE, MIN_BIRTH_SPACING_DAYS, STARVATION_DEATH_DAYS, childbirthUtilityGain, marriageUtilityGain } from './marriage.js';
import { executeSchedule } from './execution.js';
import { householdFoodUnits } from './needs.js';

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
  const kids = [];
  for (const other of world.npcs.values()) {
    if (other.id !== npc.id && other.parentIds && other.parentIds.includes(npc.id)) kids.push(other);
  }
  return kids;
}

export function killNPC(npc, cause) {
  const spouse = npc.spouseId != null ? world.npcs.get(npc.spouseId) : null;
  const heirs = spouse ? [spouse] : findLivingAdultChildren(npc);

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
      const heir = heirs[i % heirs.length];
      const asset = world.assets.get(assetId);
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
    const share = npc.savings / heirs.length;
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
      const asset = world.assets.get(assetId);
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
  const toKill = [];
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

export function getAvailableActions(npc) {
  const actions = [];
  const prof = PROFESSIONS[npc.profession];

  // Work and hired labor are scored directly in buildDayCandidates, not
  // here — see the WEEKLY PLANNER section above.

  // --- GO TO MARKET (if there's anything to trade or haggle for) ---
  const marketVisit = planMarketVisit(npc);
  if (marketVisit) actions.push(marketVisit);

  // --- ATTEND CHURCH (always available — the poor are welcome too) ---
  actions.push(planChurchVisit(npc));

  // --- LIST IDLE ASSETS FOR SALE (Stage 1.5: scored, not automatic) ---
  actions.push(...planAssetSaleActions(npc));

  // --- TINKER (self-teach an asset-gated skill, slowly, without a master) ---
  const tinkerAction = planTinkerAction(npc);
  if (tinkerAction) actions.push(tinkerAction);

  // --- BUILD (labor toward an in-progress construction project) ---
  const constructionAction = planConstructionAction(npc);
  if (constructionAction) actions.push(constructionAction);

  // --- REST ---
  // A little comfort and meaning trickle in even from resting at home —
  // but nowhere near what fine goods (comfort) or church (meaning)
  // provide. Most of an NPC's rest/comfort/meaning needs should be met
  // through the goods and institutions built for that purpose, not as a
  // free byproduct of doing nothing.
  actions.push({
    id: 'rest', label: 'Rest',
    duration: 2,
    energyRestored: 30 * housingQuality(npc),
    needEffects: { social: 0.02 * housingQuality(npc), comfort: 0.02 * housingQuality(npc), meaning: 0.01 * housingQuality(npc) },
  });

  // --- SOCIALIZE (if energy allows) ---
  if (npc.energy > 40) {
    actions.push({
      id: 'socialize', label: 'Socialize',
      duration: 1.5,
      energyCost: 5,
      needEffects: { social: 0.15 },
    });
  }

  // --- SEEK MARRIAGE (unmarried adults) ---
  // Scoring the ACT of seeking, not an instant marriage — actually
  // pairing off still requires a mutual match (see runMarriageMarket),
  // since one side's high score isn't consent from the other.
  if (npc.spouseId == null) {
    actions.push({
      id: 'seek_marriage', label: 'Seek marriage',
      duration: 1, energyCost: 5,
      needEffects: {},
      _scoreOverride: marriageUtilityGain(npc) + MARRIAGE_DRIVE_BONUS,
    });
  }

  // --- TRY FOR A CHILD (married couples only) ---
  // Only the lower-id partner in a couple ever sees this action, so a
  // married pair can't independently both "decide" the same day and
  // double-spawn — a simplification consistent with family staying a
  // loose, non-jointly-optimized institution for now (see design notes).
  if (npc.spouseId != null && npc.id < npc.spouseId) {
    const spouse = world.npcs.get(npc.spouseId);
    if (spouse && npc.childIds.length < MAX_CHILDREN_PER_COUPLE &&
        npc.energy > 40 && spouse.energy > 40 &&
        npc.needs.food > 0.5 && spouse.needs.food > 0.5 &&
        npc.age < CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS &&
        spouse.age < CHILDBIRTH_MAX_AGE_DOGYEARS * DOG_YEAR_DAYS &&
        (world.day - npc.lastChildbirthDay) >= MIN_BIRTH_SPACING_DAYS &&
        (world.day - spouse.lastChildbirthDay) >= MIN_BIRTH_SPACING_DAYS &&
        (npc.savings + spouse.savings) > CHILDBIRTH_MATERIAL_COST * 3) {
      const gain = childbirthUtilityGain(npc) + childbirthUtilityGain(spouse) + CHILDBIRTH_DRIVE_BONUS;
      actions.push({
        id: 'seek_child', label: 'Try for a child',
        duration: 1, energyCost: 10,
        needEffects: {},
        _scoreOverride: gain - CHILDBIRTH_UTILITY_COST,
      });
    }
  }

  // --- ASK FOR HELP (targeted, not broadcast) ---
  // Only proposed to a top handful of contacts NPC already has SOME
  // positive affinity for — asking a stranger or someone you dislike
  // isn't a real candidate action, so this stays cheap (bounded by each
  // NPC's own sparse relations map, not the village). Gated behind a
  // real distress signal (food<0.3) so this isn't a background option
  // every day, and against already having an unresolved ask out (no
  // spamming every contact at once — see the targeted-not-broadcast
  // design discussion).
  const hasOpenAsk = world.helpRequests.some(r => r.requesterId === npc.id);
  // Gated at NEEDS.food.starvationFloor specifically, not an earlier soft
  // threshold — lambda (see lambda()) only spikes above its baseline
  // (~6-8 for nearly everyone, rich or poor, since foodMU=weight/(1+level)
  // never truly reaches zero) once food crosses the starvationFloor's
  // severity multiplier. Triggering earlier meant requesters were asking
  // before their own desperation was actually reflected in the shared
  // lambda math those asks get judged by — the honest predicted/actual
  // score came out negative even for a genuinely fond contact, not
  // because affinity was too weak but because the ask fired too early to
  // be economically real yet. Verified via harness trace: at food=1.00
  // (fully fed) a target's OWN lambda already sits at 6.84 baseline, so
  // a 0.47-affinity ask netted -87 — the requester wasn't meaningfully
  // more desperate than the person being asked to help them.
  if (npc.needs.food < NEEDS.food.starvationFloor && !hasOpenAsk) {
    const candidates = [...npc.relations.entries()]
      .filter(([, rec]) => rec.affinity > 0)
      .sort((a, b) => b[1].affinity - a[1].affinity)
      .slice(0, 3);
    const amount = 3 * marketAsk('bread'); // a few days' worth — first-pass constant, worth tuning
    for (const [targetId] of candidates) {
      const target = world.npcs.get(targetId);
      if (!target) continue;
      // Predict the target's own answer using the SAME formula their
      // 'help' action will actually be scored with (see scoreAction's
      // affinityTarget term) — an honest guess, not an oracle. Falls out
      // naturally that asking a poor contact predicts badly: their own
      // lambda (cost of parting with money) is high when they have
      // little, without any explicit "don't ask poor people" rule.
      const predictedTargetScore = getAffinity(target, npc.id) * lambda(npc) * amount - lambda(target) * amount;
      const successProb = clamp(0.5 + predictedTargetScore * 0.05, 0.05, 0.95);
      // Prestige cost scales with how large the ask is — asking for a
      // little is a small admission; asking for a lot is a visible one.
      const prestigeCost = clamp(amount / 50, 0.02, 0.15);
      actions.push({
        id: 'ask_help', label: `Ask ${target.name} for help`,
        duration: 1, energyCost: 3,
        needEffects: { prestige: -prestigeCost },
        moneyEarned: successProb * amount, // expected value, not a guarantee — resolved for real when the target actually plans
        targetId, requestedAmount: amount,
      });
    }
  }

  // --- HELP (respond to a request someone has directed at me) ---
  // See scoreAction's affinityTarget term: this scores honestly low or
  // negative for someone I don't care for, even if they're desperate —
  // no separate "would I help" branch needed.
  for (const req of world.helpRequests) {
    if (req.targetId !== npc.id || req.resolved) continue;
    const requester = world.npcs.get(req.requesterId);
    if (!requester) continue;

    // Hard gate: you can't give help once you're the one in real danger.
    // Same starvationFloor threshold used to trigger ask_help in the
    // first place, so the mechanic is symmetric — below the floor an NPC
    // can ask, but can't give. This is a deliberate floor rather than
    // relying purely on the EV competition below: verified via harness
    // that lambda only rises modestly even at food=0 (roughly 2x
    // baseline, not the dramatic multiplier the starvation-cliff
    // marginal-utility formula alone would suggest, once divided through
    // by cheapestFoodPrice) — nowhere near reliably enough to veto a
    // large, affinity-favorable gift on its own. Millers with hundreds or
    // thousands in savings were observed choosing 'help' while at
    // literal food=0.00, not because they were irrational but because
    // giving money doesn't depend on the Market actually having food IN
    // STOCK that day — so during a stockout, 'help' could still score
    // well even though it does nothing to solve the giver's own crisis.
    if (npc.needs.food < NEEDS.food.starvationFloor) continue;

    // Explicit opportunity cost: this hour could have been spent working.
    // Previously 'help' only competed against other actions implicitly
    // via the generic per-hour score comparison, carrying just a token
    // energyCost (3) that didn't reflect labor's real value — cheap
    // enough to look attractive as a time-filler even when the giver
    // should be earning. Now the forgone value of the giver's own best
    // current labor option is subtracted directly and explicitly, using
    // the same profSessionEV the giver's actual work decision is scored
    // with (see WORK_SESSION_HOURS), rather than trusting the implicit
    // competition to weigh it correctly on its own.
    const ownWorkEV = profSessionEV(npc, npc.profession);
    const opportunityCost = (isFinite(ownWorkEV) && ownWorkEV > 0) ? ownWorkEV / WORK_SESSION_HOURS : 0;

    actions.push({
      id: 'help', label: `Help ${requester.name}`,
      duration: 1, energyCost: 3,
      affinityTarget: { npcId: requester.id, moneyGift: req.amount },
      moneyCost: req.amount,
      needEffects: { prestige: PRESTIGE_HELP_GAIN },
      opportunityCost,
      requestId: req, // resolved directly in executeSchedule
    });
  }

  return actions;
}

// buildingAvailable() is retained only as a legacy/utility check for
// whether a *village-wide structure* of a given type physically exists —
// used now purely for animation (where an NPC walks to work) and for
// buildingProductivity()'s lookup, NOT for gating who can practice a
// profession. That gating is now hasWorkableAsset(npc, profId), based on
// personal asset ownership rather than a shared village flag. Keeping the
// PROFESSIONS[profession].requires field alive for these non-gating uses.
export function buildingAvailable(profession) {
  const req = PROFESSIONS[profession]?.requires;
  if (!req) return true;
  for (const s of world.structures.values()) if (s.type === req) return true;
  return false;
}

// Skill an NPC actually produces at right now. Their innate skill roll
// (npc.skills[profId]) is a ceiling, not a guarantee — if they're still
// within the training period for THIS SPECIFIC profession (tracked via
// npc.trainingProfession, separate from npc.profession so the temporary
// profession-swap inside computeProfessionEV's hypothetical checks doesn't
// accidentally trigger the ramp), output is scaled down, climbing linearly
// from 30% to 100% over trainingDays. Hypothetical/steady-state EV checks
// (computeProfessionEV on a profession the NPC doesn't currently hold)
// always see full skill — the ramp only bites for real, current work.
export function effectiveSkill(npc, profId) {
  const base = npc.skills[profId] ?? 0.5;
  if (npc.trainingProfession === profId && npc.trainingDaysLeft > 0) {
    const totalDays = PROFESSIONS[profId]?.trainingDays ?? 0;
    const progress  = totalDays > 0 ? 1 - (npc.trainingDaysLeft / totalDays) : 1;
    const ramp = 0.3 + 0.7 * clamp(progress, 0, 1);
    return base * ramp;
  }
  return base;
}

// ── Buffer target: how much of a good should this NPC hold right now? ────────
//
// The answer is derived from expected return, not from a hardcoded calendar.
// An NPC holds extra stock when the carry value (expected future price minus
// current price, discounted for perish and time) is positive and they have
// savings headroom to warehouse. The carry value is zero in the absence of
// seasonal price data, so year-1 NPCs hold minimal buffers and learn to
// warehouse as they accumulate price history. That's the correct behavior.
//
// Structure:
//   base    = minimum working stock (inputs for production, food for survival)
//   speculative = additional units held for price appreciation, bounded by
//                 a carry-value-derived quantity and a per-good ceiling
//
export function getBufferTarget(npc, good) {
  const prof = npc.profession;
  const SAVINGS_RESERVE = 5;
  const canWarehouse = npc.savings > SAVINGS_RESERVE * 3;
  const carry = canWarehouse ? speculativeCarryValue(npc, good) : 0;

  // How many extra units is it worth holding speculatively?
  // Approximation: hold N units where N × carry × lambda = opportunity cost
  // of the savings tied up. We cap at a per-good ceiling to avoid NPCs
  // warehousing the entire market.
  const lam = lambda(npc);
  // Speculative quantity: proportional to carry value, scaled by savings headroom.
  // Each extra unit costs ~currentPrice in tied-up savings; worth holding while
  // carry * lam > 0. We approximate quantity as: (carry / currentPrice) * headroomFactor.
  const currentP = Math.max(expectedPrice(npc, good), 0.1);
  const headroom = Math.max(0, npc.savings - SAVINGS_RESERVE * 3);
  // Units we can afford to warehouse from free savings
  const affordableUnits = headroom / currentP;
  // Scale by how attractive the carry is (carry/currentP is the return rate)
  const carryReturn = carry / currentP; // e.g. 0.3 = 30% expected return
  // specUnits ramps from 0 (no carry) to a ceiling as carry return improves
  const MAX_SPEC = { grain: 12, bread: 4, wood: 15, tools: 0, luxury: 3 };
  const specUnits = canWarehouse
    ? Math.max(0, Math.min(affordableUnits * carryReturn * 3, MAX_SPEC[good] ?? 0))
    : 0;

  if (good === 'grain') {
    // Working stock: any profession that consumes grain as an input
    // (millers, artisans) keeps a 5-session buffer (was 2) — millers were
    // stopping their own grain purchases as soon as they hit the bare
    // 2-session minimum, which meant they never sustained real market
    // demand for grain even during a genuine village-wide shortage.
    // Since bidValueForAsset/market pricing (see priceForStock) responds
    // to actual unmet demand, a miller who buys just enough for the next
    // two sessions and then stops sends a weak, intermittent price
    // signal — nowhere near what "millers need lots of grain" should
    // look like. A deeper working buffer means millers keep bidding for
    // grain more of the time, which is what correctly bids grain's price
    // up and rewards farmers for producing more of it.
    const grainInput = PROFESSIONS[prof]?.inputs?.grain;
    const base = grainInput ? grainInput * 5 : 1;
    return base + specUnits;
  }

  if (good === 'bread') {
    // Daily intake reserve — always kept, food is a critical need.
    // Scaled by household size (see householdFoodUnits): a parent with
    // children needs a bigger buffer than a single adult, since kids draw
    // from this same inventory (see tickChildren) with no supply of
    // their own.
    const dailyBase = 2 + householdFoodUnits(npc); // 2 units/day at nutrition 0.5 each = the daily target, plus each child's share

    // Extra buffer held for the SECURITY value of a well-stocked larder,
    // independent of hunger itself — see BUFFER_STOCK_EFFECTS and
    // bufferStockRatio (used identically in satisfyNeeds to actually grant
    // the security benefit). securityGap (0 = fully secure, 1 = totally
    // insecure) scales continuously how much of the full
    // daysForFullBenefit buffer the NPC is currently reaching for — same
    // "value tracks how urgently the need is felt" principle as
    // needMarginalUtility, just expressed as a target quantity instead of
    // a per-unit utility. No separate on/off threshold: an NPC who is
    // already secure via savings naturally stops chasing a larger larder,
    // and bread's fast perish rate (15%/day) already taxes over-buying on
    // its own, so this doesn't need an explicit spoilage penalty here.
    const bufferCfg = BUFFER_STOCK_EFFECTS.bread;
    const fullBufferUnits = bufferCfg.daysForFullBenefit * dailyBase;
    const securityGap = 1 - npc.needs.security;
    const securityBufferTarget = fullBufferUnits * securityGap;

    const base = Math.max(dailyBase, securityBufferTarget);
    return base + specUnits;
  }

  if (good === 'wood') {
    // Working stock for bakers and toolmakers; warmth buffer for everyone
    const workBuffer  = PROFESSIONS[prof]?.inputs?.wood ? (PROFESSIONS[prof].inputs.wood * 3) : 0;
    const warmthBuffer = 1;
    const base = Math.max(workBuffer, warmthBuffer);
    return base + specUnits;
  }

  if (good === 'luxury') {
    // Comfort stock: keep ~1 unit on hand to consume day-to-day, same
    // pattern as bread for food -- BUT only when comfort is actually the
    // better use of that unit right now. Comfort is a discretionary need
    // (NEEDS.comfort.critical === false), so shouldKeepForConsumption
    // compares its use-value against selling it, and selling already
    // reflects an elevated lambda when a CRITICAL need like food is in
    // crisis. This is what stops a starving artisan from reserving fine
    // goods for their own comfort instead of selling them for food money
    // — without a special-cased "unless starving" branch here.
    const base = shouldKeepForConsumption(npc, 'luxury') ? 1 : 0;
    return base + specUnits;
  }

  if (good === 'tools') {
    if (PROFESSIONS[prof]?.capitalGood === 'tools') return 2;
    if (prof === 'toolmaker') return 1;
    return 0;
  }

  return 0;
}

