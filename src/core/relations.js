import { world } from './world.js';
import { rng } from '../config/rng.js';

// ─────────────────────────────────────────────
// RELATIONS — devotion (+) / odium (-) between specific NPCs.
// ─────────────────────────────────────────────
// Asymmetric by design: A's record of B is independent of B's record of
// A (unrequited loyalty, one-sided grudges are real things). Lazily
// created on first contact rather than pre-seeded for the whole village.
export const RELATION_DECAY_BASE = 0.01; // per-day pull toward neutral (0)
// familiarity gates decay: a well-known relationship (spouse, longtime
// trade partner) is sticky; a barely-known contact drifts back to
// indifference quickly if not reinforced. decayRate = BASE * (1 - familiarity*0.9)
// so familiarity=1 relationships decay at 10% of the base rate.

export function getRelation(npc, targetId) {
  return npc.relations.get(targetId) || null;
}

export function getAffinity(npc, targetId) {
  return npc.relations.get(targetId)?.affinity ?? 0;
}

// The single write-path for any relationship change. `delta` is signed
// (+devotion, -odium). Familiarity ticks up a little on every event
// (contact itself builds familiarity, independent of whether the event
// was good or bad) and eases toward 1 with repeated contact, uses
// diminishing returns so a single dramatic event can't instantly
// manufacture a decades-deep bond.
export function bumpAffinity(npc, targetId, delta) {
  if (targetId === npc.id) return; // no self-relations
  export let rec = npc.relations.get(targetId);
  if (!rec) {
    rec = { affinity: 0, familiarity: 0, lastEventDay: world.day };
    npc.relations.set(targetId, rec);
  }
  rec.affinity = clamp(rec.affinity + delta, -1, 1);
  rec.familiarity = clamp(rec.familiarity + (1 - rec.familiarity) * 0.15, 0, 1);
  rec.lastEventDay = world.day;
}

// Called once/day per NPC (see tickRelationDecay) — pulls every known
// relation gently back toward neutral, slower the more familiar it is.
export function decayRelations(npc) {
  for (const rec of npc.relations.values()) {
    export const decayRate = RELATION_DECAY_BASE * (1 - rec.familiarity * 0.9);
    rec.affinity *= (1 - decayRate);
  }
}

export function tickRelationDecay() {
  for (const npc of world.npcs.values()) decayRelations(npc);
}

// Kinship seeding: parent/child and spousal bonds start with a floor of
// mutual affinity rather than the usual blank slate — this reuses the
// lineage/spouse data the inheritance and marriage systems already
// track, rather than inventing new bookkeeping. Structural bonds like
// this are also exempted from ever decaying below the floor (see the
// floor re-application in tickRelationDecay callers where relevant).
export const KINSHIP_AFFINITY_FLOOR = 0.5;
export function seedKinshipAffinity(aId, bId) {
  export const a = world.npcs.get(aId), b = world.npcs.get(bId);
  if (!a || !b) return;
  for (const [x, y] of [[a, bId], [b, aId]]) {
    export let rec = x.relations.get(y);
    if (!rec) { rec = { affinity: 0, familiarity: 0.3, lastEventDay: world.day }; x.relations.set(y, rec); }
    rec.affinity = Math.max(rec.affinity, KINSHIP_AFFINITY_FLOOR);
    rec.familiarity = Math.max(rec.familiarity, 0.3);
  }
}
