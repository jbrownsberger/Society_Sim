import { world } from './core/world.js';
import { seedAssets } from './core/assets.js';
import { spawnInitialNPCs } from './core/npc.js';
import { tickDay } from './simulation/engine.js';
import { drawScene, resizeCanvas } from './ui/renderer.js';
import { updateUI, selectedNPC, selectedStructure, setSelectedNPC, setSelectedStructure, drawInspector } from './ui/ui.js';

// Global game loop state
let simTickMs = 0; // 0 = paused
let accumulator = 0;
let lastTime = 0;

// Canvas setup
const canvas = document.getElementById('world-canvas');
window.addEventListener('resize', () => {
  resizeCanvas();
  drawScene();
});

// Seed world
seedAssets();
spawnInitialNPCs();
resizeCanvas();

// Initial draw
drawScene();
updateUI();

// Speed Controls
const btnPause = document.getElementById('btn-pause');
const btn1x = document.getElementById('btn-1x');
const btn5x = document.getElementById('btn-5x');
const btn20x = document.getElementById('btn-20x');

function setSpeed(ms, activeBtn) {
  simTickMs = ms;
  [btnPause, btn1x, btn5x, btn20x].forEach(b => b.classList.remove('active'));
  activeBtn.classList.add('active');
}

btnPause.addEventListener('click', () => setSpeed(0, btnPause));
btn1x.addEventListener('click', () => setSpeed(1000, btn1x));
btn5x.addEventListener('click', () => setSpeed(200, btn5x));
btn20x.addEventListener('click', () => setSpeed(50, btn20x));

// Game loop
function gameLoop(timestamp) {
  if (!lastTime) lastTime = timestamp;
  const dt = timestamp - lastTime;
  lastTime = timestamp;

  if (simTickMs > 0) {
    accumulator += dt;
    while (accumulator >= simTickMs) {
      tickDay();
      accumulator -= simTickMs;
    }
    drawScene();
    updateUI();
  }

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);

// Canvas click selection
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  let foundNPC = null;
  for (const npc of world.npcs.values()) {
    const dx = clickX - npc.x;
    const dy = clickY - npc.y;
    if (dx * dx + dy * dy < 16 * 16) {
      foundNPC = npc;
      break;
    }
  }

  if (foundNPC) {
    setSelectedNPC(foundNPC);
    setSelectedStructure(null);
    drawInspector();
    return;
  }

  let foundStruct = null;
  for (const s of world.structures.values()) {
    const sx = s.gx * 22;
    const sy = s.gy * 22;
    const sw = (s.footprint?.w || 1) * 22;
    const sh = (s.footprint?.h || 1) * 22;
    if (clickX >= sx && clickX <= sx + sw && clickY >= sy && clickY <= sy + sh) {
      foundStruct = s;
      break;
    }
  }

  if (foundStruct) {
    setSelectedStructure(foundStruct);
    setSelectedNPC(null);
    drawInspector();
    return;
  }

  setSelectedNPC(null);
  setSelectedStructure(null);
  drawInspector();
});
