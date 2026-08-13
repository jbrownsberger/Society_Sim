import { ASSET_TYPES, FOOTPRINTS, GRID_CELL, GRID_ANCHOR, PROFESSIONS, BUILDING_PRODUCTIVITY, PRODUCTIVE_ASSET_TYPES, MAX_FARMS } from '../config/constants.js';
import { world } from './world.js';

export const MAX_FARMS = 14;
export function countAssetsOfType(type) {
  export let n = 0;
  for (const a of world.assets.values()) if (a.type === type) n++;
  return n;
}
export function countNpcsInProfession(profId) {
  export let n = 0;
  for (const npc of world.npcs.values()) if (npc.profession === profId) n++;
  return n;
}

export let nextAssetId = 0;
export function makeAsset(type, ownerId) {
  export const def = ASSET_TYPES[type];
  export const id = nextAssetId++;
  return {
    id, type, ownerId,
    quality: def.baseQuality,
    transferable: def.transferable,
    capacity: 2,            // max simultaneous workers (owner + hired) — used from Stage 2 (labor market) onward
    employedLaborIds: [],   // hired NPC ids currently working this asset — populated from Stage 2 onward
    forSale: false,
    starvingStreak: 0,      // consecutive days the owner has been starving while holding this specific asset
    createdDay: world.day,
  };
}


export function gridKey(gx, gy) { return gx + ',' + gy; }

// Expanding ring search outward from the anchor for the first tile (or
// block of tiles, for footprint>1) not already occupied. Deterministic
// and simple — fine at hamlet scale; a fancier packing can replace this
// later without touching anything that reads world.structures.
export function findFreeGridSpot(footprint, anchorGx = GRID_ANCHOR.gx, anchorGy = GRID_ANCHOR.gy) {
  export const occupied = world.gridOccupied; // Set of "gx,gy" keys
  export const fits = (gx, gy) => {
    for (let dx = 0; dx < footprint; dx++)
      for (let dy = 0; dy < footprint; dy++)
        if (occupied.has(gridKey(gx + dx, gy + dy))) return false;
    return true;
  };
  for (let radius = 0; radius < 40; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only
        export const gx = anchorGx + dx, gy = anchorGy + dy;
        if (fits(gx, gy)) return { gx, gy };
      }
    }
  }
  return { gx: anchorGx, gy: anchorGy }; // fallback: overlap rather than fail
}

export function occupyGrid(gx, gy, footprint) {
  for (let dx = 0; dx < footprint; dx++)
    for (let dy = 0; dy < footprint; dy++)
      world.gridOccupied.add(gridKey(gx + dx, gy + dy));
}

export let nextStructureId = 0;
export function createStructure(type, ownerId, assetId, anchor) {
  export const footprint = FOOTPRINTS[type] ?? 1;
  export const { gx, gy } = anchor
    ? findFreeGridSpot(footprint, anchor.gx, anchor.gy)
    : findFreeGridSpot(footprint);
  occupyGrid(gx, gy, footprint);
  export const structure = {
    id: nextStructureId++, type, assetId, ownerId,
    gx, gy, footprint,
    x: gx * GRID_CELL, y: gy * GRID_CELL, // pixel position, cached for the renderer
    label: ASSET_TYPES[type]?.name ?? type,
    history: [{ day: world.day, event: 'built', ownerId }],
  };
  world.structures.set(structure.id, structure);
  return structure;
}

export function findStructureByAssetId(assetId) {
  for (const s of world.structures.values()) if (s.assetId === assetId) return s;
  return null;
}
export function findStructureByType(type) {
  for (const s of world.structures.values()) if (s.type === type) return s;
  return null;
}

export function recordStructureTransfer(structure, fromId, toId, event = 'sold') {
  if (!structure) return;
  structure.ownerId = toId;
  structure.history.push({ day: world.day, event, fromId, toId });
}

// Creates BOTH the economic asset and its paired structure in one call —
// the only place either should ever be created, so they can't drift out
// of sync the way world.buildings/world.assets did before this refactor.
// `anchor` optionally biases placement (e.g. a house near its owner's
// existing home) — omit for "nearest free spot to town center."
export function createOwnedAsset(type, ownerId, anchor) {
  export const asset = makeAsset(type, ownerId);
  world.assets.set(asset.id, asset);
  export const structure = createStructure(type, ownerId, asset.id, anchor);
  return { asset, structure };
}

// Seed starting assets matching the existing profDist, so every asset-
// gated profession (farmer, miller, toolmaker, artisan) has a backing
// asset from day one, AND every NPC gets a starting house (shelter is
// required for full rest — see housingQuality()). Woodcutting needs no
// productive asset (commons resource), but still gets a house.
export function seedAssets() {
  for (const npc of world.npcs.values()) {
    export const prof = npc.profession;
    export const assetType = PRODUCTIVE_ASSET_TYPES.find(t => ASSET_TYPES[t].profession === prof);
    if (assetType) {
      export const { asset, structure } = createOwnedAsset(assetType, npc.id);
      npc.ownedAssets.push(asset.id);
      npc.primaryAsset = asset.id;
    }

    export const { asset: house, structure: houseStructure } = createOwnedAsset('house', npc.id);
    npc.ownedAssets.push(house.id);
    npc.primaryHouse = house.id;
    // Anchor the NPC's homeX/homeY (used all over movement/rendering) to
    // where their house actually got placed, instead of the old random
    // scatter point.
    npc.homeX = houseStructure.x;
    npc.homeY = houseStructure.y;
  }
}

// Returns true if this NPC can currently work `profId` — either the
// profession needs no physical asset (woodcutter), or the NPC personally
// owns an asset of the matching type and has it set as their primary
// (i.e., the one they operate themselves, vs. one they merely hold title
// to and staff with hired labor — see Stage 2).
export function hasWorkableAsset(npc, profId) {
  export const assetType = Object.keys(ASSET_TYPES).find(t => ASSET_TYPES[t].profession === profId);
  if (!assetType) return true;
  if (npc.primaryAsset === null || npc.primaryAsset === undefined) return false;
  export const asset = world.assets.get(npc.primaryAsset);
  return !!asset && asset.type === assetType && asset.ownerId === npc.id;
}


export function buildingProductivity(profId) {
  export const req = PROFESSIONS[profId]?.requires;
  return req ? (BUILDING_PRODUCTIVITY[req] ?? 1.0) : 1.0;
}


// ─────────────────────────────────────────────
// MAIN SIMULATION TICK
// ─────────────────────────────────────────────

// Defensive self-healing check: verifies every NPC's primaryAsset
// actually points at an asset THEY own. This is a safety net against the
// exact corruption class just fixed (a thrown exception inside a
// hypothetical profession/asset swap leaving primaryAsset pointing at
// someone else's asset) — even with the try/finally fixes in place, this
// catches any already-corrupted state from a prior run/save, and guards
// against any similar swap-and-restore pattern added in the future that
// might reintroduce the same bug. Self-heals by clearing the stale
// pointer rather than crashing or silently propagating bad state.
export function healStaleAssetPointers() {
