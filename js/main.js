import { world } from './state.js';
import { initWorld } from './npc.js';
import { initBank } from './auctions.js';
import { tickDay } from './simulation.js';
import { shadowDeliberateAll } from './scheduleBdi.js';
import { canvas, drawScene, initCanvas } from './render.js';
import { selection, updateUI } from './ui.js';

// ─────────────────────────────────────────
// INIT — run once, after every module has finished loading, so all the
// cyclic imports (world/npc/auctions all reference each other) are fully
// resolved before anything reads them. See initWorld()/initBank() for why
// this can't just happen at module-load time the way it did in the
// original single-file version.
// ─────────────────────────────────────────
initBank();
initWorld();
initCanvas();

// ─────────────────────────────────────────
// GAME LOOP
// ─────────────────────────────────────────

export let simTickMs = 0; // paused
export let accumulator = 0;
export let lastTime = 0;

document.getElementById('btn-pause').onclick = function() {
  simTickMs = 0;
  document.querySelectorAll('.controls button').forEach(b=>b.classList.remove('active'));
  this.classList.add('active');
};
document.getElementById('btn-1x').onclick = function() {
  simTickMs = 600;
  document.querySelectorAll('.controls button').forEach(b=>b.classList.remove('active'));
  this.classList.add('active');
};
document.getElementById('btn-5x').onclick = function() {
  simTickMs = 120;
  document.querySelectorAll('.controls button').forEach(b=>b.classList.remove('active'));
  this.classList.add('active');
};
document.getElementById('btn-20x').onclick = function() {
  simTickMs = 30;
  document.querySelectorAll('.controls button').forEach(b=>b.classList.remove('active'));
  this.classList.add('active');
};

export function gameLoop(ts) {
  const dt = ts - lastTime;
  lastTime = ts;

  if (simTickMs > 0) {
    accumulator += dt;
    let ticks = 0;
    while (accumulator >= simTickMs && ticks < 10) {
      tickDay();
      shadowDeliberateAll();
      accumulator -= simTickMs;
      ticks++;
    }
  }

  drawScene(accumulator / (simTickMs||600));

  if (world.day % 1 === 0) updateUI(); // update every day

  requestAnimationFrame(gameLoop);
}

// Canvas click to select NPCs or buildings
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  let closest = null, closestDist = 20;
  for (const npc of world.npcs.values()) {
    const d = Math.hypot(npc.x - mx, npc.y - my);
    if (d < closestDist) { closestDist = d; closest = npc.id; }
  }

  if (closest !== null) {
    selection.npc = closest;
    selection.structure = null;
    updateUI();
    switchToInspector();
    return;
  }

  // No NPC hit — check structures (simple radius test around each
  // building's pixel center; good enough at this footprint scale).
  let closestS = null, closestSDist = 18;
  for (const s of world.structures.values()) {
    const d = Math.hypot(s.x - mx, s.y - my);
    if (d < closestSDist) { closestSDist = d; closestS = s.id; }
  }
  if (closestS !== null) {
    selection.structure = closestS;
    selection.npc = null;
    updateUI();
    switchToInspector();
  }
});

// Helpers
// Initial UI draw and start loop
updateUI();
requestAnimationFrame(gameLoop);
// ── Tab switching ────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + target).classList.add('active');
  });
});

export function switchToInspector() {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="inspector"]').classList.add('active');
  document.getElementById('tab-inspector').classList.add('active');
}
