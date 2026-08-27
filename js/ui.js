import { ASSET_TYPES, BUILDING_PRODUCTIVITY, DOG_YEAR_DAYS, GOODS, MAX_FARMS, NEEDS, PROFESSIONS, countAssetsOfType, findStructureByAssetId, hasWorkableAsset, housingQuality } from './constants.js';
import { world } from './state.js';
import { expectedPrice, lambda, scoreAction } from './prices.js';
import { CONSTRUCTION_HOURS_PER_DAY, computeConstructionEV } from './construction.js';
import { getAvailableActions } from './death.js';
import { canvas } from './render.js';
import { switchToInspector } from './main.js';

// ─────────────────────────────────────────────
// UI PANELS
// ─────────────────────────────────────────────

export const selection = { npc: null, structure: null };

export function updateUI() {
  document.getElementById('day-display').textContent = world.day;
  document.getElementById('pop-display').textContent = world.npcs.size;

  const seasonEl = document.getElementById('season-display');
  seasonEl.textContent = world.season.charAt(0).toUpperCase() + world.season.slice(1);
  const sColors = { spring:'#5a7a3a', summer:'#8b8b2a', autumn:'#8b5a2a', winter:'#4a6a8a' };
  seasonEl.style.background = sColors[world.season];
  seasonEl.style.color = '#f2e8d5';
  seasonEl.style.padding = '2px 8px';

  // Market grid
  const divStatus = document.getElementById('market-dividend-status');
  const visitCount = world.market.visitorsToday.length;
  divStatus.textContent = visitCount > 0
    ? `${visitCount} at market today · paid out ${world.market.dividendPoolToday.toFixed(0)}¢ · ~${world.market.lastDividendPerVisitHour.toFixed(2)}¢/hr going rate`
    : `Nobody at market today · ~${world.market.lastDividendPerVisitHour.toFixed(2)}¢/hr going rate`;

  const mg = document.getElementById('market-grid');
  mg.innerHTML = '';
  for (const [good, data] of Object.entries(GOODS)) {
    const g = world.market.goods[good];
    const hist = g.priceHistory;
    const price = g.midPrice.toFixed(1);
    const prevEntry = hist.length > 1 ? hist[hist.length-2].price : g.midPrice;
    const trend = g.midPrice > prevEntry ? '▲' : g.midPrice < prevEntry ? '▼' : '–';
    const trendColor = g.midPrice > prevEntry ? '#c0392b' : '#27ae60';
    const unmet = (g.unmetDemand > 0.1 ? `short ${g.unmetDemand.toFixed(1)}` :
                   g.unmetSupply > 0.1 ? `glut ${g.unmetSupply.toFixed(1)}` : 'balanced');
    mg.innerHTML += `
      <div class="market-item">
        <div class="good-name">${data.name}</div>
        <div class="good-price">${price} <span style="color:${trendColor};font-size:0.8rem">${trend}</span></div>
        <div class="good-unmet" title="bid ${g.bidPrice.toFixed(1)} / ask ${g.askPrice.toFixed(1)}">${unmet} · ${g.stock.toFixed(0)}/${g.capacity}</div>
      </div>`;
  }

  // Sparklines
  drawSparklines();

  // NPC list
  const nl = document.getElementById('npc-list');
  nl.innerHTML = '';
  for (const npc of world.npcs.values()) {
    const div = document.createElement('div');
    div.className = 'npc-item' + (selection.npc===npc.id?' selected':'');
    div.onclick = () => { selection.npc = npc.id; selection.structure = null; updateUI(); switchToInspector(); };

    const needsHTML = Object.entries(npc.needs).map(([need,val])=>{
      const colors = { food:'#e74c3c', security:'#f39c12', comfort:'#a5478b', social:'#9b59b6', meaning:'#3498db', prestige:'#c9962c' };
      return `<div class="needs-bar-row">
        <span class="needs-bar-label">${need}</span>
        <div class="needs-bar-bg">
          <div class="needs-bar-fill" style="width:${(val*100).toFixed(0)}%;background:${colors[need]}"></div>
        </div>
        <span style="font-size:0.65rem;color:var(--ink-faded);width:28px;text-align:right">${(val*100).toFixed(0)}%</span>
      </div>`;
    }).join('');

    const spouse = npc.spouseId != null ? world.npcs.get(npc.spouseId) : null;
    const familyLine = spouse ? `💍 ${spouse.name}${npc.childIds.length ? ` · ${npc.childIds.length} kid${npc.childIds.length>1?'s':''}` : ''}` : '';

    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span class="npc-name">${npc.name}</span>
        <span class="npc-prof">${PROFESSIONS[npc.profession]?.name ?? npc.profession}</span>
      </div>
      <div style="font-size:0.72rem;color:var(--ink-faded);margin:2px 0">
        ${npc.currentAction ?? 'idle'} · ⚡${npc.energy.toFixed(0)} · 💰${npc.savings.toFixed(1)}${familyLine ? ' · ' + familyLine : ''}
      </div>
      ${needsHTML}`;
    nl.appendChild(div);
  }

  // Inspector
  if (selection.structure !== null) {
    const s = world.structures.get(selection.structure);
    if (s) drawStructureInspector(s);
  } else if (selection.npc !== null) {
    const npc = world.npcs.get(selection.npc);
    if (npc) drawInspector(npc);
  }

  updateInfraPanel();
  updateTimeUsePanel();
  updateDemographics();

  // Event log
  const logEl = document.getElementById('event-log');
  logEl.innerHTML = world.eventLog.slice(0,12).map(e=>
    `<div class="log-entry"><span class="day-tag">Day ${e.day}</span>${e.text}</div>`
  ).join('');
}

export function updateDemographics() {
  const el = document.getElementById('demographics-status');
  if (!el) return;

  const npcs = [...world.npcs.values()];
  const n = npcs.length;
  const marriedCount = npcs.filter(p => p.spouseId != null).length;
  const householdsWithKids = npcs.filter(p => p.spouseId != null && p.id < p.spouseId && p.childIds.length > 0).length;
  const couples = npcs.filter(p => p.spouseId != null && p.id < p.spouseId).length;
  const totalKids = world.children.size;
  const avgKidsPerCouple = couples > 0
    ? (npcs.reduce((s,p) => s + (p.spouseId != null && p.id < p.spouseId ? p.childIds.length : 0), 0) / couples)
    : 0;
  const homelessCount = npcs.filter(p => housingQuality(p) < 1.0).length;
  const farmCount = countAssetsOfType('farm');

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr auto;gap:2px 8px;font-size:0.78rem">
      <span>Population</span><span>${n}</span>
      <span>Married</span><span>${marriedCount} (${couples} couples)</span>
      <span>Children (dependents)</span><span>${totalKids}</span>
      <span>Couples with kids</span><span>${householdsWithKids} / ${couples}</span>
      <span>Avg kids/couple</span><span>${avgKidsPerCouple.toFixed(1)}</span>
      <span>Homeless</span><span style="${homelessCount>0?'color:#8b3a1a':''}">${homelessCount}</span>
      <span>Farms</span><span>${farmCount} / ${MAX_FARMS} cap</span>
      <span style="grid-column:1/-1;border-top:1px solid #6b4c3b;margin-top:2px;padding-top:2px;font-style:italic;color:var(--ink-faded)">Lifetime</span>
      <span>Total births</span><span>${world.totalBirths}</span>
      <span>Total deaths</span><span>${world.totalDeaths} (${world.deathsByCause.starvation} starvation, ${world.deathsByCause.oldAge} old age)</span>
    </div>`;
}

export function drawSparklines() {
  const sc = document.getElementById('sparkline-canvas');
  const sx = sc.getContext('2d');
  sx.clearRect(0,0,sc.width,sc.height);

  const goods = Object.keys(GOODS);
  const colors = ['#c8a84b','#c47a3a','#7a5a3a','#808080','#a5478b'];
  const rowH = sc.height / goods.length;

  goods.forEach((good,i) => {
    const raw = world.market.goods[good].priceHistory.slice(-50);
    if (raw.length < 2) return;
    const hist = raw.map(e => e.price);

    const y0 = i * rowH + 4;
    const h  = rowH - 8;
    const mn = Math.min(...hist) * 0.9;
    const mx = Math.max(...hist) * 1.1;

    // Label
    sx.fillStyle = '#6b4c3b';
    sx.font = '9px Crimson Pro';
    sx.textAlign = 'left';
    sx.fillText(GOODS[good].name, 2, y0 + h/2 + 4);

    // Line
    sx.beginPath();
    sx.strokeStyle = colors[i];
    sx.lineWidth = 1.5;
    hist.forEach((p,j) => {
      const x = 65 + (j / (hist.length-1)) * (sc.width - 70);
      const y = y0 + h - ((p - mn) / (mx - mn)) * h;
      j===0 ? sx.moveTo(x,y) : sx.lineTo(x,y);
    });
    sx.stroke();

    // Current price
    const last = hist[hist.length-1].toFixed(1);
    sx.fillStyle = colors[i];
    sx.textAlign = 'right';
    sx.fillText(last, sc.width-2, y0+h/2+4);
  });
}

export function drawStructureInspector(s) {
  const el = document.getElementById('inspector');
  if (!el) return;

  const owner = s.ownerId != null ? world.npcs.get(s.ownerId) : null;
  const asset = s.assetId != null ? world.assets.get(s.assetId) : null;

  const workerNames = (asset?.employedLaborIds ?? [])
    .map(id => world.npcs.get(id)?.name).filter(Boolean);

  // For houses specifically: who actually LIVES here, not just who owns
  // it — includes a spouse who moved in (their own primaryHouse was
  // nulled out at marriage, see marryCouple) and any of their children.
  let householdHtml = '';
  if (s.type === 'house' && owner) {
    const residents = [owner];
    if (owner.spouseId != null) {
      const spouse = world.npcs.get(owner.spouseId);
      if (spouse && spouse.primaryHouse == null) residents.push(spouse); // moved in, not a separate homeowner
    }
    const kids = residents.flatMap(r => r.childIds.map(id => world.children.get(id)).filter(Boolean));
    const uniqueKids = [...new Map(kids.map(k => [k.id, k])).values()];
    householdHtml = `<div style="font-size:0.72rem;margin:4px 0">
      <b>Household:</b> ${residents.map(r => r.name).join(' & ')}${uniqueKids.length ? `, ${uniqueKids.map(c=>c.name).join(', ')} (${uniqueKids.length} child${uniqueKids.length>1?'ren':''})` : ''}
    </div>`;
  }

  const historyRows = s.history.slice().reverse().map(h => {
    const label = h.event === 'built' ? 'Built' : h.event === 'sold' ? 'Sold' : h.event;
    const who = h.event === 'built'
      ? (world.npcs.get(h.ownerId)?.name ?? 'the village')
      : `${world.npcs.get(h.fromId)?.name ?? '—'} → ${world.npcs.get(h.toId)?.name ?? '—'}`;
    return `<div style="font-size:0.72rem;display:flex;justify-content:space-between">
      <span>${label} — ${who}</span>
      <span style="color:var(--ink-faded)">Day ${h.day}</span>
    </div>`;
  }).join('');

  const details = ASSET_TYPES[s.type] ? `
    <div style="font-size:0.72rem;color:var(--ink-faded);margin:2px 0">
      Quality: ${(asset?.quality ?? 1).toFixed(2)} ·
      Capacity: ${asset?.capacity ?? 1} ·
      ${asset?.forSale ? '<span style="color:#8b3a1a">Listed for sale</span>' : 'Not for sale'}
    </div>` : '';

  el.innerHTML = `
    <div class="npc-header" style="display:flex;justify-content:space-between;align-items:baseline">
      <span class="npc-name">${s.label}</span>
      <span class="npc-prof">${owner ? 'Owned by ' + owner.name : 'Village institution'}</span>
    </div>
    ${details}
    ${householdHtml}
    ${workerNames.length ? `<div style="font-size:0.72rem;margin:4px 0"><b>Working here:</b> ${workerNames.join(', ')}</div>` : ''}
    <div style="margin-top:8px;padding-top:6px;border-top:1px solid #6b4c3b">
      <div style="font-size:0.7rem;font-style:italic;color:var(--ink-faded);margin-bottom:3px">History</div>
      ${historyRows || '<div style="font-size:0.72rem;color:var(--ink-faded)">No recorded events.</div>'}
    </div>`;
}

export function drawInspector(npc) {
  const el = document.getElementById('inspector');
  const lam = lambda(npc).toFixed(2);

  const invStr = Object.entries(npc.inventory)
    .map(([g,q])=>`${g}: ${q.toFixed(1)}`).join(' · ');

  // Time-use breakdown: average hours/day per action over the NPC's
  // recent history (last TIME_USE_WINDOW days, or fewer early on),
  // rather than just today's single schedule — smooths out day-to-day
  // noise (e.g. one tinkering day) so the shape reflects an actual
  // recent pattern.
  const recentDays = npc.timeUseHistory.slice(-14);
  const avgByAction = {};
  for (const day of recentDays) {
    for (const [id, hrs] of Object.entries(day.byAction)) {
      avgByAction[id] = (avgByAction[id] || 0) + hrs;
    }
  }
  for (const id of Object.keys(avgByAction)) avgByAction[id] /= Math.max(1, recentDays.length);
  const timeUseHtml = renderTimeUseBar(avgByAction);

  const evRows = Object.entries(npc.memory.ev).map(([profId,ev])=>{
    const isCurrent = profId === npc.profession;
    const prof = PROFESSIONS[profId];
    // Build a compact signal string: "bread×3→8.2 grain×2→3.1" etc.
    let signal = '';
    if (prof) {
      const outParts = Object.entries(prof.outputs).map(([g,q])=>
        `${GOODS[g].name}×${q}→${expectedPrice(npc,g).toFixed(1)}`);
      const inParts  = Object.entries(prof.inputs).map(([g,q])=>
        `${GOODS[g].name}×${q}←${expectedPrice(npc,g).toFixed(1)}`);
      signal = [...outParts,...inParts].join(' ');
      if (!hasWorkableAsset(npc, profId)) {
        // Asset-gated and this NPC doesn't own one — show what building
        // one from scratch would be worth, since that's now a real,
        // player-visible option rather than a dead end (⛔ used to be the
        // whole story here; it no longer is).
        const cev = computeConstructionEV(npc, profId);
        signal = cev > -900 ? `🔨 build: ${cev.toFixed(1)}` : '⛔ no asset, not worth building';
      }
    }
    return `<tr class="${isCurrent?'current-prof':''}">
      <td>${PROFESSIONS[profId]?.name}</td>
      <td>${ev.toFixed(1)}</td>
      <td style="font-size:0.65rem;color:var(--ink-faded);font-style:italic">${isCurrent?'◀':''} ${signal}</td>
    </tr>`;
  }).join('');

  // In-progress construction gets its own prominent banner — this is a
  // multi-week commitment the NPC is mid-way through, worth surfacing
  // clearly rather than burying it in the EV table.
  const constructionBanner = npc.constructionProject ? `
    <div style="background:var(--parchment-dark,#e8dcc0);border:1px solid #5A3E9E;border-radius:4px;padding:6px;margin-bottom:6px;font-size:0.75rem">
      🔨 Building a ${ASSET_TYPES[npc.constructionProject.assetType].name.toLowerCase()} —
      ${(npc.constructionProject.laborHoursDone / CONSTRUCTION_HOURS_PER_DAY).toFixed(1)}/${(npc.constructionProject.laborHoursNeeded / CONSTRUCTION_HOURS_PER_DAY).toFixed(0)} labor-days
    </div>` : '';

  // Action scores for today
  const actions = getAvailableActions(npc);
  const scored = actions.map(a=>({...a,score:scoreAction(a,npc)}))
                        .sort((a,b)=>b.score-a.score).slice(0,5);
  const actionRows = scored.map(a=>
    `<tr><td>${a.label}</td><td>${a.score.toFixed(2)}</td></tr>`
  ).join('');

  // Family — spouse, children (with age in days -> nearest "year" at
  // 360 days/year, matching how CHILDHOOD_DAYS is denominated), and
  // current housing status (see housingQuality's spousal fallback).
  const spouse = npc.spouseId != null ? world.npcs.get(npc.spouseId) : null;
  const kids = npc.childIds.map(id => world.children.get(id)).filter(Boolean);
  const housed = housingQuality(npc) >= 1.0;
  const familySection = `
    <div style="font-size:0.75rem;margin-bottom:6px;padding:6px;background:var(--parchment-dark,#e8dcc0);border-radius:4px">
      <div style="font-style:italic;color:var(--ink-faded);margin-bottom:2px">Family</div>
      ${spouse ? `Married to <b>${spouse.name}</b> (${PROFESSIONS[spouse.profession]?.name ?? spouse.profession})` : 'Unmarried'}
      ${kids.length ? `<br>${kids.length} child${kids.length>1?'ren':''}: ${kids.map(c => `${c.name} (age ${(c.age/DOG_YEAR_DAYS).toFixed(1)})`).join(', ')}` : ''}
      <br><span style="${housed?'':'color:#8b3a1a'}">${housed ? '🏠 Housed' : '⛺ Homeless — see housing status'}</span>
    </div>`;

  const needsHTML = Object.entries(npc.needs).map(([need,val])=>{
    const colors = { food:'#e74c3c', security:'#f39c12', comfort:'#a5478b', social:'#9b59b6', meaning:'#3498db', prestige:'#c9962c' };
    const cfg = NEEDS[need];
    const critical = cfg?.critical && cfg.starvationFloor > 0 && val < cfg.starvationFloor;
    return `<div class="needs-bar-row">
      <span class="needs-bar-label">${need}${critical ? ' ⚠️' : ''}</span>
      <div class="needs-bar-bg">
        <div class="needs-bar-fill" style="width:${(val*100).toFixed(0)}%;background:${critical ? '#8b3a1a' : colors[need]}"></div>
      </div>
      <span style="font-size:0.65rem;color:var(--ink-faded);width:28px;text-align:right">${(val*100).toFixed(0)}%</span>
    </div>`;
  }).join('');

  // Events involving this NPC specifically — filtered from the same
  // global world.eventLog everyone else reads (see logEvent), not a
  // separate per-NPC log to maintain. Most recent first, capped so the
  // panel doesn't grow unbounded for a long-lived, event-heavy NPC.
  const npcEvents = world.eventLog.filter(e => e.npcIds && e.npcIds.includes(npc.id)).slice(0, 8);
  const npcEventsHtml = npcEvents.length
    ? npcEvents.map(e => `<div style="margin-bottom:2px"><span style="color:var(--ink-faded)">Day ${e.day}:</span> ${e.text}</div>`).join('')
    : `<div style="color:var(--ink-faded);font-style:italic">Nothing notable yet.</div>`;

  // Recent income & expenditures — built from npc.financeLog, populated
  // by the single adjustSavings() choke point in state.js so every real
  // cash movement (wages, market trades, tithes/alms, construction
  // materials, help given/received, inheritance, etc.) shows up here
  // without this panel needing to know about each source individually.
  const recentFinance = (npc.financeLog || []).slice(0, 12);
  const financeHtml = recentFinance.length
    ? recentFinance.map(f => {
        const positive = f.amount >= 0;
        const color = positive ? '#2e7d32' : '#8b3a1a';
        const label = FINANCE_CATEGORY_LABELS[f.category] || f.category;
        return `<div style="display:flex;justify-content:space-between;font-size:0.72rem;margin-bottom:1px">
          <span><span style="color:var(--ink-faded)">Day ${f.day}:</span> ${label}</span>
          <span style="color:${color}">${positive?'+':''}${f.amount.toFixed(1)}¢</span>
        </div>`;
      }).join('')
    : `<div style="color:var(--ink-faded);font-style:italic;font-size:0.72rem">No transactions yet.</div>`;

  // Relationships — sorted by |affinity|, so both strong devotion and
  // strong odium surface first rather than getting buried under a long
  // tail of near-zero acquaintances. Capped to the top handful for
  // readability; the full sparse map can be much larger for a
  // well-connected old NPC.
  const relRows = [...npc.relations.entries()]
    .sort((a, b) => Math.abs(b[1].affinity) - Math.abs(a[1].affinity))
    .slice(0, 8)
    .map(([id, rec]) => {
      const other = world.npcs.get(id);
      if (!other) return '';
      const color = rec.affinity > 0 ? '#2e7d32' : (rec.affinity < 0 ? '#8b3a1a' : 'var(--ink-faded)');
      const label = rec.affinity > 0.5 ? 'devoted' : rec.affinity > 0.15 ? 'fond' : rec.affinity < -0.5 ? 'hateful' : rec.affinity < -0.15 ? 'resentful' : 'neutral';
      return `<div style="display:flex;justify-content:space-between;font-size:0.72rem;margin-bottom:1px">
        <span>${other.name}</span>
        <span style="color:${color}">${rec.affinity>=0?'+':''}${rec.affinity.toFixed(2)} (${label})</span>
      </div>`;
    }).join('');
  const relationsHtml = relRows || `<div style="color:var(--ink-faded);font-style:italic;font-size:0.72rem">No relationships yet.</div>`;

  // Owned buildings — cross-references world.structures by ownedAssets,
  // same asset ids the inheritance/auction systems already key off.
  const ownedStructures = npc.ownedAssets
    .map(assetId => findStructureByAssetId(assetId))
    .filter(Boolean);
  const ownedHtml = ownedStructures.length
    ? ownedStructures.map(s => `<div style="font-size:0.72rem">${ASSET_TYPES[s.type]?.name ?? s.type}${s.type===npc.primaryHouse?' 🏠':''}</div>`).join('')
    : `<div style="color:var(--ink-faded);font-style:italic;font-size:0.72rem">Owns no buildings.</div>`;

  el.innerHTML = `
    <h2>${npc.name} — ${PROFESSIONS[npc.profession]?.name}${npc.currentAction === 'hired-labor' ? ' (hired out today)' : ''}</h2>
    ${constructionBanner}
    ${familySection}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
      <div style="padding:6px;background:var(--parchment-dark,#e8dcc0);border-radius:4px">
        <div style="font-style:italic;color:var(--ink-faded);font-size:0.7rem;margin-bottom:2px">Relationships</div>
        ${relationsHtml}
      </div>
      <div style="padding:6px;background:var(--parchment-dark,#e8dcc0);border-radius:4px">
        <div style="font-style:italic;color:var(--ink-faded);font-size:0.7rem;margin-bottom:2px">Owned buildings</div>
        ${ownedHtml}
      </div>
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:0.7rem;font-style:italic;color:var(--ink-faded);margin-bottom:2px">Needs</div>
      ${needsHTML}
    </div>
    <div class="inspector-grid">
      <div class="stat-box"><div class="stat-label">Savings</div><div class="stat-value">${npc.savings.toFixed(1)}¢</div></div>
      <div class="stat-box"><div class="stat-label">Capital</div><div class="stat-value">${npc.capital.toFixed(1)}</div></div>
      <div class="stat-box"><div class="stat-label">Energy</div><div class="stat-value">${npc.energy.toFixed(0)}</div></div>
      <div class="stat-box"><div class="stat-label">Age</div><div class="stat-value">${(npc.age/DOG_YEAR_DAYS).toFixed(1)}${npc.starvingDays > 0 ? ` <span style="color:#8b3a1a;font-size:0.65rem">(${npc.starvingDays}d hungry)</span>` : ''}</div></div>
      <div class="stat-box"><div class="stat-label">λ (coin value)</div><div class="stat-value">${lam}</div></div>
    </div>
    <div style="font-size:0.7rem;color:var(--ink-faded);margin-bottom:6px">${invStr}</div>
    <div style="margin-bottom:8px">
      <div style="font-size:0.7rem;font-style:italic;color:var(--ink-faded);margin-bottom:2px">Time use (avg, last 14 days)</div>
      ${timeUseHtml}
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:0.7rem;font-style:italic;color:var(--ink-faded);margin-bottom:2px">Recent income & expenditures</div>
      <div style="max-height:140px;overflow-y:auto">${financeHtml}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      <div>
        <div style="font-size:0.7rem;font-style:italic;color:var(--ink-faded);margin-bottom:2px">Profession EVs</div>
        <table class="ev-table"><thead><tr><th>Profession</th><th>EV/hr</th><th style="font-size:0.65rem">price signals</th></tr></thead><tbody>${evRows}</tbody></table>
      </div>
      <div>
        <div style="font-size:0.7rem;font-style:italic;color:var(--ink-faded);margin-bottom:2px">Top actions today</div>
        <table class="ev-table"><thead><tr><th>Action</th><th>U/hr</th></tr></thead><tbody>${actionRows}</tbody></table>
      </div>
    </div>
    <div style="margin-top:8px">
      <div style="font-size:0.7rem;font-style:italic;color:var(--ink-faded);margin-bottom:2px">Recent events</div>
      <div style="font-size:0.7rem;max-height:140px;overflow-y:auto">${npcEventsHtml}</div>
    </div>`;
}

// ─────────────────────────────────────────────
// BUILD ACTIONS
// ─────────────────────────────────────────────

// REMOVED: the old buildStructure()/btn-build-* system let the PLAYER
// manually insert a mill/forge/workshop by levying the richest NPC's
// savings — a mechanic that predates and directly conflicts with the new
// autonomous construction system, where individual NPCs decide for
// themselves whether building a new asset is worth it (computeConstructionEV)
// and finance it out of their own real goods (startConstruction). Keeping
// both would let a player artificially force capacity into existence
// that has nothing to do with the village's actual economic signals,
// undermining the whole point of the fix. Villagers now build their own
// infrastructure; the player observes and can still tune productivity
// (see the sliders in updateInfraPanel below) but no longer places
// buildings directly. The onclick handlers are removed along with it —
// if the corresponding buttons still exist in the HTML, they're now
// inert; consider removing them from the markup in a future pass.


export function setBuildingProductivity(type, value) {
  BUILDING_PRODUCTIVITY[type] = parseFloat(value);
  const label = document.getElementById('prod-label-' + type);
  if (label) label.textContent = parseFloat(value).toFixed(2) + 'x';
}

export const FINANCE_CATEGORY_LABELS = {
  wages_earned: 'Wages earned', wages_paid: 'Wages paid (as employer)',
  market_sale: 'Sold at market', market_purchase: 'Bought at market',
  market_dividend: 'Market dividend', bank_interest: 'Bank interest',
  tithe: 'Tithe', alms: 'Alms received',
  construction_materials: 'Construction materials',
  asset_purchase: 'Bought asset', asset_sale: 'Sold asset',
  profession_switch: 'Profession switch cost', training_fee: 'Training fee received',
  debt_payment: 'Debt payment', childbirth_cost: 'Childbirth cost',
  child_feeding: 'Fed a child', help_given: 'Helped another villager',
  help_received: 'Received help', inheritance: 'Inheritance',
};

export const TIME_USE_LABELS = {
  work: 'Own trade', 'hired-labor': 'Hired labor', market: 'Market',
  rest: 'Rest', socialize: 'Socialize', tinker: 'Tinkering',
  church: 'Church', 'list-asset-sale': 'Selling asset', 'delist-asset-sale': 'Delisting asset',
};
export const TIME_USE_COLORS = {
  work: '#5a7a3a', 'hired-labor': '#8b5a2a', market: '#c9a227',
  rest: '#7a7a7a', socialize: '#5a478b', tinker: '#2a6a8b',
  church: '#8b2a5a', 'list-asset-sale': '#c0392b', 'delist-asset-sale': '#27ae60',
};

export function renderTimeUseBar(byAction, totalHoursOverride) {
  const total = totalHoursOverride ?? Object.values(byAction).reduce((s,v)=>s+v,0);
  if (total <= 0) return '<div style="font-size:0.7rem;color:var(--ink-faded)">No data yet.</div>';
  const entries = Object.entries(byAction).sort((a,b)=>b[1]-a[1]);
  const segments = entries.map(([id,hrs]) => {
    const pct = (hrs/total*100);
    const color = TIME_USE_COLORS[id] || '#999';
    return `<div style="width:${pct}%;background:${color}" title="${TIME_USE_LABELS[id]||id}: ${hrs.toFixed(1)}h"></div>`;
  }).join('');
  const legend = entries.map(([id,hrs]) => {
    const pct = (hrs/total*100).toFixed(0);
    const color = TIME_USE_COLORS[id] || '#999';
    return `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:8px;font-size:0.68rem;color:var(--ink-faded)">
      <span style="width:8px;height:8px;background:${color};border-radius:2px;display:inline-block"></span>
      ${TIME_USE_LABELS[id]||id} ${pct}%
    </span>`;
  }).join('');
  return `
    <div style="display:flex;height:14px;border-radius:3px;overflow:hidden;margin-bottom:4px">${segments}</div>
    <div>${legend}</div>`;
}

export function updateTimeUsePanel() {
  const el = document.getElementById('time-use-aggregate');
  if (!el) return;
  const latest = world.timeUseHistory[world.timeUseHistory.length - 1];
  if (!latest) { el.innerHTML = '<div style="font-size:0.7rem;color:var(--ink-faded)">No data yet.</div>'; return; }
  el.innerHTML = renderTimeUseBar(latest.byAction);
}

export function updateInfraPanel() {
  const el = document.getElementById('infra-status');
  if (!el) return;
  const all = [
    { type:'farm',     label:'Farm',     unlocks:'Farmer' },
    { type:'mill',     label:'Mill',     unlocks:'Miller' },
    { type:'forge',    label:'Forge',    unlocks:'Toolmaker' },
    { type:'workshop', label:'Workshop', unlocks:'Artisan' },
    { type:'market',   label:'Market',   unlocks:'Trade' },
  ];

  // Villagers now build their own infrastructure autonomously (see
  // startConstruction/completeConstruction) when a profession's price
  // signal makes it worthwhile — this panel is now purely observational:
  // how many of each asset exist, and what's currently under construction
  // village-wide. The player can no longer place buildings directly, but
  // can still tune realized productivity via the sliders below, same as
  // before.
  const assetCounts = {};
  for (const asset of world.assets.values()) {
    assetCounts[asset.type] = (assetCounts[asset.type] || 0) + 1;
  }
  const inProgress = [...world.npcs.values()]
    .filter(n => n.constructionProject)
    .map(n => ({ npc: n, proj: n.constructionProject }));

  const rows = all.map(s => {
    const count = assetCounts[s.type] ?? ([...world.structures.values()].some(b => b.type === s.type) ? 1 : 0);
    const built = count > 0;
    const icon = built ? '✔' : '✘';
    const color = built ? '#5a7a3a' : '#8b3a1a';
    const countNote = s.type !== 'market' ? ` <span style="color:var(--ink-faded)">(${count} in use)</span>` : '';
    const hasSlider = built && BUILDING_PRODUCTIVITY[s.type] !== undefined;
    const slider = hasSlider ? `
      <div style="display:flex;align-items:center;gap:6px;margin:2px 0 8px 0">
        <input type="range" min="0.2" max="2.0" step="0.05"
          value="${BUILDING_PRODUCTIVITY[s.type]}"
          data-productivity-type="${s.type}"
          style="flex:1">
        <span id="prod-label-${s.type}" style="font-size:0.7rem;color:var(--ink-faded);min-width:34px">${BUILDING_PRODUCTIVITY[s.type].toFixed(2)}x</span>
      </div>` : '';
    return `<div style="margin-bottom:3px">
      <div style="display:flex;justify-content:space-between">
        <span><span style="color:${color};font-weight:600">${icon}</span> ${s.label}${countNote}</span>
        <span style="color:var(--ink-faded);font-size:0.7rem">unlocks ${s.unlocks}</span>
      </div>
      ${slider}
    </div>`;
  }).join('');

  const projectRows = inProgress.length > 0 ? `
    <div style="margin-top:8px;padding-top:6px;border-top:1px solid #6b4c3b">
      <div style="font-size:0.7rem;font-style:italic;color:var(--ink-faded);margin-bottom:3px">Under construction</div>
      ${inProgress.map(({npc,proj}) => `
        <div style="font-size:0.72rem;display:flex;justify-content:space-between">
          <span>🔨 ${npc.name} — ${ASSET_TYPES[proj.assetType].name}</span>
          <span style="color:var(--ink-faded)">${(proj.laborHoursDone / CONSTRUCTION_HOURS_PER_DAY).toFixed(1)}/${(proj.laborHoursNeeded / CONSTRUCTION_HOURS_PER_DAY).toFixed(0)}d labor</span>
        </div>`).join('')}
    </div>` : '';

  el.innerHTML = rows + projectRows;
  el.querySelectorAll('[data-productivity-type]').forEach(input => {
    input.addEventListener('input', event => {
      setBuildingProductivity(event.currentTarget.dataset.productivityType, event.currentTarget.value);
    });
  });
}

