import { ASSET_TYPES, PROFESSIONS, findStructureByType } from './constants.js';
import { rng } from './rng.js';
import { world } from './state.js';
import { selection } from './ui.js';

// ─────────────────────────────────────────────
// RENDERING
// ─────────────────────────────────────────────

export const canvas = document.getElementById('world-canvas');
export const ctx    = canvas.getContext('2d');

export function resizeCanvas() {
  const sidebar = document.querySelector('.sidebar');
  canvas.width  = window.innerWidth - sidebar.offsetWidth;
  canvas.height = window.innerHeight - document.querySelector('header').offsetHeight;
}
export function initCanvas() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

export const ACTION_COLORS = {
  work:        '#8B6914',
  buy_grain:   '#1464A0',
  buy_bread:   '#1464A0',
  sell_grain:  '#145A8B',
  sell_bread:  '#145A8B',
  sell_wood:   '#145A8B',
  sell_tools:  '#145A8B',
  rest:        '#2E7D32',
  socialize:   '#7B1FA2',
  church:      '#C9A227',
  hired_labor: '#D4780A', // distinct burnt-orange: working someone else's asset, not your own trade
  building:    '#5A3E9E', // distinct violet-blue: mid-construction on a brand-new asset
  idle:        '#9E9E9E',
};

export function getActionColor(npcOrActionId) {
  // Accepts either a raw action id (legacy call sites) or the full npc
  // object — an in-progress construction project takes visual priority
  // over whatever the NPC's schedule says today, since "building a mill"
  // is the more informative, longer-running state a player would want to
  // see at a glance.
  const npc = (npcOrActionId && typeof npcOrActionId === 'object') ? npcOrActionId : null;
  const actionId = npc ? npc.currentAction : npcOrActionId;
  if (npc && npc.constructionProject)  return ACTION_COLORS.building;
  if (actionId === 'hired-labor')      return ACTION_COLORS.hired_labor;
  if (actionId?.startsWith('work'))    return ACTION_COLORS.work;
  if (actionId === 'market')           return ACTION_COLORS.buy_grain;
  if (actionId === 'church')           return ACTION_COLORS.church;
  if (actionId === 'socialize')        return ACTION_COLORS.socialize;
  if (actionId === 'rest')             return ACTION_COLORS.rest;
  return ACTION_COLORS.idle;
}

export function drawScene(alpha) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  // Background — season-tinted grass
  const seasonColors = {
    spring: '#6b8f4a', summer: '#5a7a3a', autumn: '#8a7040', winter: '#8a9090'
  };
  ctx.fillStyle = seasonColors[world.season];
  ctx.fillRect(0,0,W,H);

  // Subtle texture
  ctx.globalAlpha = 0.07;
  for (let i=0;i<W;i+=4) for (let j=0;j<H;j+=4) {
    if (rng.next()<0.3) { ctx.fillStyle='#000'; ctx.fillRect(i,j,2,2); }
  }
  ctx.globalAlpha = 1;

  // Road to market
  ctx.strokeStyle = '#c4a87a';
  ctx.lineWidth = 6;
  ctx.globalAlpha = 0.5;
  const marketS = findStructureByType('market');
  if (marketS) {
    for (const npc of world.npcs.values()) {
      ctx.beginPath();
      ctx.moveTo(npc.homeX, npc.homeY);
      ctx.lineTo(marketS.x, marketS.y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // Buildings — every structure instance, so N mills really draw as N mills
  // "In use today": institutions (no backing asset) always read as active.
  // Houses read as in-use if occupied (owner != null) — a heirless house
  // pending re-auction genuinely IS sitting idle, worth showing as such.
  // Productive buildings (mill, forge, farm, workshop) are in use if the
  // owner is actively working it themselves today OR any hired laborer
  // is currently clocked in there — reuses the same currentAction/
  // employedLaborIds data the structure inspector already surfaces.
  function isStructureInUse(s) {
    const asset = s.assetId != null ? world.assets.get(s.assetId) : null;
    if (!asset) return true;
    if (s.type === 'house') return s.ownerId != null;
    const owner = s.ownerId != null ? world.npcs.get(s.ownerId) : null;
    if (owner && owner.currentAction === 'work' && PROFESSIONS[owner.profession]?.requires === s.type) return true;
    for (const wid of (asset.employedLaborIds ?? [])) {
      const w = world.npcs.get(wid);
      if (w && w.currentAction === 'hired-labor') return true;
    }
    return false;
  }

  // How many PRODUCTIVE (non-house) buildings each owner holds — an
  // owner with 2+ gets a small colored marker on each of their buildings
  // so a land-consolidation pattern (one family quietly buying up every
  // mill in the village) reads visually rather than requiring you to
  // click through every building's inspector to notice.
  const ownerProductiveCounts = new Map();
  for (const s of world.structures.values()) {
    if (s.ownerId != null && s.type !== 'house' && ASSET_TYPES[s.type]) {
      ownerProductiveCounts.set(s.ownerId, (ownerProductiveCounts.get(s.ownerId) || 0) + 1);
    }
  }
  // Deterministic per-owner color via golden-angle hue rotation — same
  // owner always gets the same color across buildings and re-renders,
  // and successive owner ids land far apart in hue so adjacent owners
  // don't get visually-confusable colors.
  function ownerColor(ownerId) {
    const hue = (ownerId * 137.508) % 360;
    return `hsl(${hue}, 70%, 45%)`;
  }

  for (const b of world.structures.values()) {
    ctx.strokeStyle = '#2c1810';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = isStructureInUse(b) ? 1 : 0.4;

    if (b.type === 'market') {
      ctx.fillStyle = '#c4a87a';
      ctx.fillRect(b.x-18,b.y-18,36,32);
      ctx.strokeRect(b.x-18,b.y-18,36,32);
      ctx.beginPath();
      ctx.moveTo(b.x-22,b.y-18); ctx.lineTo(b.x,b.y-32); ctx.lineTo(b.x+22,b.y-18);
      ctx.fillStyle='#8B3A1A'; ctx.fill(); ctx.stroke();

    } else if (b.type === 'mill') {
      // Round tower + sails
      ctx.fillStyle = '#c8b89a';
      ctx.beginPath(); ctx.arc(b.x, b.y, 14, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8B3A1A';
      ctx.beginPath(); ctx.arc(b.x, b.y, 5, 0, Math.PI*2); ctx.fill();
      // Four sails
      ctx.strokeStyle = '#4a3020'; ctx.lineWidth = 2;
      [[0,-18],[0,18],[18,0],[-18,0]].forEach(([dx,dy]) => {
        ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(b.x+dx, b.y+dy); ctx.stroke();
      });

    } else if (b.type === 'forge') {
      ctx.fillStyle = '#807060';
      ctx.fillRect(b.x-12,b.y-14,24,28); ctx.strokeRect(b.x-12,b.y-14,24,28);
      // Chimney with smoke hint
      ctx.fillStyle = '#606050';
      ctx.fillRect(b.x+4,b.y-22,7,10); ctx.strokeRect(b.x+4,b.y-22,7,10);
      ctx.fillStyle = '#8B3A1A';
      ctx.beginPath(); ctx.arc(b.x-2,b.y+2,4,0,Math.PI*2); ctx.fill(); // forge glow

    } else if (b.type === 'house') {
      // Small cottage: body + peaked roof + door
      ctx.fillStyle = '#d9c4a0';
      ctx.fillRect(b.x-9, b.y-6, 18, 14); ctx.strokeRect(b.x-9, b.y-6, 18, 14);
      ctx.beginPath();
      ctx.moveTo(b.x-11, b.y-6); ctx.lineTo(b.x, b.y-16); ctx.lineTo(b.x+11, b.y-6);
      ctx.closePath();
      ctx.fillStyle = '#7a4a2a'; ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#4a3020';
      ctx.fillRect(b.x-2.5, b.y+2, 5, 6);

    } else if (b.type === 'church') {
      // Chapel: body + spire + cross
      ctx.fillStyle = '#e4ddc8';
      ctx.fillRect(b.x-13, b.y-8, 26, 20); ctx.strokeRect(b.x-13, b.y-8, 26, 20);
      ctx.beginPath();
      ctx.moveTo(b.x-15, b.y-8); ctx.lineTo(b.x, b.y-22); ctx.lineTo(b.x+15, b.y-8);
      ctx.closePath();
      ctx.fillStyle = '#5a4a6e'; ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#2c1810'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y-30); ctx.lineTo(b.x, b.y-22);
      ctx.moveTo(b.x-4, b.y-27); ctx.lineTo(b.x+4, b.y-27);
      ctx.stroke();

    } else if (b.type === 'well') {
      ctx.fillStyle = '#8a8a8a';
      ctx.beginPath(); ctx.arc(b.x, b.y, 8, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#4a3020'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(b.x-6,b.y-10); ctx.lineTo(b.x-6,b.y-2);
      ctx.moveTo(b.x+6,b.y-10); ctx.lineTo(b.x+6,b.y-2);
      ctx.moveTo(b.x-8,b.y-10); ctx.lineTo(b.x+8,b.y-10); ctx.stroke();

    } else if (b.type === 'workshop' || b.type === 'farm') {
      ctx.fillStyle = b.type === 'farm' ? '#b8a860' : '#a89880';
      ctx.fillRect(b.x-13, b.y-10, 26, 22); ctx.strokeRect(b.x-13, b.y-10, 26, 22);
      ctx.fillStyle = '#7a6a4a';
      ctx.fillRect(b.x-13, b.y-10, 26, 6); ctx.strokeRect(b.x-13, b.y-10, 26, 6);

    } else {
      ctx.fillStyle = '#9090a0';
      ctx.beginPath(); ctx.arc(b.x,b.y,10,0,Math.PI*2); ctx.fill(); ctx.stroke();
    }

    ctx.globalAlpha = 1; // labels and the owner marker stay fully legible even when the building itself is faded

    if (b.type !== 'house') {
      ctx.fillStyle = '#2c1810';
      ctx.font = '10px Crimson Pro';
      ctx.textAlign = 'center';
      ctx.fillText(b.label, b.x, b.y + (b.type==='mill' ? 26 : 28));
    }

    // Multi-building owner marker (see ownerProductiveCounts above)
    if (b.type !== 'house' && b.ownerId != null && (ownerProductiveCounts.get(b.ownerId) ?? 0) >= 2) {
      ctx.beginPath();
      ctx.arc(b.x + 14, b.y - 14, 4, 0, Math.PI*2);
      ctx.fillStyle = ownerColor(b.ownerId);
      ctx.fill();
      ctx.strokeStyle = '#2c1810'; ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // NPCs — interpolate position
  for (const npc of world.npcs.values()) {
    const x = npc.x + (npc.destX - npc.x) * 0.12;
    const y = npc.y + (npc.destY - npc.y) * 0.12;
    npc.x = x; npc.y = y;

    const color = getActionColor(npc);
    const isSelected = selection.npc === npc.id;

    // Shadow
    ctx.beginPath();
    ctx.ellipse(x, y+6, 5, 3, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.arc(x, y, isSelected ? 8 : 6, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#f2e8d5' : 'rgba(0,0,0,0.4)';
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();

    // Head
    ctx.beginPath();
    ctx.arc(x, y-9, 4, 0, Math.PI*2);
    ctx.fillStyle = '#d4a574';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Hunger indicator
    if (npc.needs.food < 0.2) {
      ctx.beginPath();
      ctx.arc(x+7, y-12, 3, 0, Math.PI*2);
      ctx.fillStyle = '#F44336';
      ctx.fill();
    }

    // Name
    ctx.fillStyle = isSelected ? '#f2e8d5' : 'rgba(44,24,16,0.85)';
    ctx.font = `${isSelected?'bold ':''}10px Crimson Pro`;
    ctx.textAlign = 'center';
    ctx.fillText(npc.name, x, y-16);
  }
}

