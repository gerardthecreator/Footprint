/* ============================================================================
   APP.JS — Footprint BTCUSDT · Order Flow Pro
   Capa de presentación. Consume los snapshots de script.js y los pinta en el DOM
   de forma quirúrgica. No calcula métricas de trading, no habla con la red.

   Correcciones aplicadas:
   - Termómetro dual: barra acumulada (6-9m) + barra instantánea (250ms)
   - Rangos visuales separados: maxAcum=400k, maxInst=50k
   - Header Δ1s usa instantDeltaShort (250ms) en lugar de instantDelta (1s)
   - Soporte para termómetro horizontal en móvil (width vs height)
   - Aviso de absorción con vibración
   ============================================================================ */

(function(){
"use strict";

/* ============================================================================
   1. SHORTCUTS Y GUARDIAS
   ============================================================================ */
const FP = window.FP;
if (!FP){
  console.error("[app.js] script.js no cargado. Abortando.");
  return;
}

const { CONFIG, state, store, coverage } = FP;
const $ = sel => document.querySelector(sel);

/* ============================================================================
   2. CACHE DE NODOS DOM
   ============================================================================ */
const ui = {
  // Header — fila 1
  connDot: null, connLabel: null,
  clockLocal: null, clockUtc: null,
  // Header — fila 2
  priceEl: null, pocVolEl: null, pocDeltaEl: null,
  deltaLongEl: null, deltaInstEl: null,
  tradesCountEl: null, volumeEl: null,
  coverage: null, covTxt: null,
  // Header — fila 3
  pillBucket: null, pillBucketVal: null,
  pillImb: null, pillImbVal: null,
  pillMin: null, pillMinVal: null,
  pillThr: null, pillThrVal: null,
  pillHeat: null, pillBars: null, pillThermo: null, pillSound: null,
  // Live
  liveGrid: null, liveEmpty: null, statusLive: null,
  thermoFillLive: null, thermoFillInstLive: null,
  thermoValLive: null, thermoImbLive: null, thermoWarnLive: null,
  // Hist
  histGrid: null, histEmpty: null, histEmptyTxt: null, statusHist: null,
  thermoFillHist: null, thermoFillInstHist: null,
  thermoValHist: null, thermoImbHist: null, thermoWarnHist: null,
  // Hist controls
  dtInput: null, scrub: null, timelineEvents: null,
  btnPlay: null, speedSel: null, btnFreeze: null,
  // Global
  toasts: null
};

/* Cache de filas por modo: idx → {row, cells...} */
const rowCache = {
  live: new Map(),
  hist: new Map()
};

/* Estado de inicialización del grid por modo */
const gridInitialized = { live: false, hist: false };

/* Volumen previo por celda, para flash */
const prevVol = {
  live: new Map(),
  hist: new Map()
};

/* Contadores para vibración y stacked */
let lastStackCount = 0;

/* ============================================================================
   3. FORMATO Y HELPERS
   ============================================================================ */
const fmtUSD = v => {
  if (!v || v <= 0) return "·";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(0);
};

const fmtSigned = v => {
  if (Math.abs(v) < 1) return "0";
  return (v > 0 ? "+" : "-") + fmtUSD(Math.abs(v));
};

const pad2 = n => String(n).padStart(2, "0");

const msToLocal = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const msToUtcShort = ms => {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
};

const msToInputValue = ms => {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};

function toast(msg, kind){
  const t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  t.textContent = msg;
  ui.toasts.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

function vibrate(){
  if (!state.sound) return;
  if (navigator.vibrate) navigator.vibrate(120);
}

const isMobile = () => window.matchMedia("(max-width: 767px)").matches;

/* ============================================================================
   4. CACHE UI
   ============================================================================ */
function cacheUI(){
  ui.connDot = $("#connDot");
  ui.connLabel = $("#connLabel");
  ui.clockLocal = $("#clockLocal");
  ui.clockUtc = $("#clockUtc");

  ui.priceEl = $("#priceEl");
  ui.pocVolEl = $("#pocVolEl");
  ui.pocDeltaEl = $("#pocDeltaEl");
  ui.deltaLongEl = $("#deltaLongEl");
  ui.deltaInstEl = $("#deltaInstEl");
  ui.tradesCountEl = $("#tradesCountEl");
  ui.volumeEl = $("#volumeEl");
  ui.coverage = $("#coverageIndicator");
  ui.covTxt = $("#coverageTxt");

  ui.pillBucket = $("#pillBucket");
  ui.pillBucketVal = $("#pillBucketVal");
  ui.pillImb = $("#pillImb");
  ui.pillImbVal = $("#pillImbVal");
  ui.pillMin = $("#pillMin");
  ui.pillMinVal = $("#pillMinVal");
  ui.pillThr = $("#pillThr");
  ui.pillThrVal = $("#pillThrVal");
  ui.pillHeat = $("#pillHeat");
  ui.pillBars = $("#pillBars");
  ui.pillThermo = $("#pillThermo");
  ui.pillSound = $("#pillSound");

  ui.liveGrid = $("#liveGrid");
  ui.liveEmpty = $("#liveEmpty");
  ui.statusLive = $("#statusLive");
  ui.thermoFillLive = $("#thermoFillLive");
  ui.thermoFillInstLive = $("#thermoFillInstLive");
  ui.thermoValLive = $("#thermoValLive");
  ui.thermoImbLive = $("#thermoImbLive");
  ui.thermoWarnLive = $("#thermoWarnLive");

  ui.histGrid = $("#histGrid");
  ui.histEmpty = $("#histEmpty");
  ui.histEmptyTxt = $("#histEmptyTxt");
  ui.statusHist = $("#statusHist");
  ui.thermoFillHist = $("#thermoFillHist");
  ui.thermoFillInstHist = $("#thermoFillInstHist");
  ui.thermoValHist = $("#thermoValHist");
  ui.thermoImbHist = $("#thermoImbHist");
  ui.thermoWarnHist = $("#thermoWarnHist");

  ui.dtInput = $("#dtInput");
  ui.scrub = $("#scrub");
  ui.timelineEvents = $("#timelineEvents");
  ui.btnPlay = $("#btnPlay");
  ui.speedSel = $("#speedSel");
  ui.btnFreeze = $("#btnFreeze");

  ui.toasts = $("#toasts");
}

/* ============================================================================
   5. RENDERIZADO DE TABLA
   ============================================================================ */
function initGrid(containerId, cacheKey){
  if (gridInitialized[cacheKey]) return;
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  container.appendChild($("#tplHead").content.cloneNode(true));
  gridInitialized[cacheKey] = true;
}

function getRow(cacheKey, idx){
  let entry = rowCache[cacheKey].get(idx);
  if (entry) return entry;

  const row = $("#tplRow").content.firstElementChild.cloneNode(true);
  entry = {
    row,
    imbL:      row.querySelector('[data-k="imbL"]'),
    imbR:      row.querySelector('[data-k="imbR"]'),
    sellLbl:   row.querySelector('[data-k="sellLbl"]'),
    sellBar:   row.querySelector('[data-k="sellBar"]'),
    sellCell:  row.querySelector('[data-k="sell"]'),
    buyLbl:    row.querySelector('[data-k="buyLbl"]'),
    buyBar:    row.querySelector('[data-k="buyBar"]'),
    buyCell:   row.querySelector('[data-k="buy"]'),
    deltaCell: row.querySelector('[data-k="delta"]'),
    deltaLbl:  row.querySelector('[data-k="deltaLbl"]'),
    priceCell: row.querySelector('[data-k="price"]'),
    ratioBuy:  row.querySelector('[data-k="ratioBuy"]'),
    ratioSell: row.querySelector('[data-k="ratioSell"]')
  };
  rowCache[cacheKey].set(idx, entry);
  return entry;
}

function renderFootprint(cacheKey, containerId, snapshot){
  if (!snapshot || !snapshot.trades.length){
    const container = document.getElementById(containerId);
    if (container) container.innerHTML = "";
    gridInitialized[cacheKey] = false;
    for (const [, entry] of rowCache[cacheKey]) entry.row.remove();
    rowCache[cacheKey].clear();
    prevVol[cacheKey].clear();
    return null;
  }

  initGrid(containerId, cacheKey);
  const container = document.getElementById(containerId);

  const {
    bucket, buy, sell, maxVol, lo, hi, center,
    pocVolIdx, pocDeltaIdx, imbB, imbS, alB, alS,
    stB, stS, absB, absS, weakB, weakS
  } = snapshot;

  // Limpiar filas fuera de rango
  for (const [idx, entry] of rowCache[cacheKey]){
    if (idx < lo || idx > hi){
      entry.row.remove();
      rowCache[cacheKey].delete(idx);
    }
  }

  // Reordenar e iterar de arriba a abajo
  let prevSibling = container.querySelector(".row-head");

  for (let idx = hi; idx >= lo; idx--){
    const entry = getRow(cacheKey, idx);

    const nextEl = prevSibling.nextSibling;
    if (entry.row !== nextEl){
      container.insertBefore(entry.row, nextEl);
    }
    prevSibling = entry.row;

    const b = buy.get(idx) || 0;
    const s = sell.get(idx) || 0;
    const d = b - s;

    // Clases de fila
    entry.row.classList.toggle("current", idx === center);
    entry.row.classList.toggle("poc", idx === pocVolIdx);

    // Heatmap por delta
    const intB = state.heatmap ? Math.min(1, b / maxVol) * 0.45 : 0;
    const intS = state.heatmap ? Math.min(1, s / maxVol) * 0.45 : 0;

    // Compra
    entry.buyLbl.textContent = b > 0 ? fmtUSD(b) : "·";
    entry.buyLbl.dataset.zero = b > 0 ? "false" : "true";
    entry.buyCell.classList.toggle("heat", state.heatmap && b > 0);
    entry.buyCell.classList.toggle("absorbed", state.heatmap && d < 0 && b > 0);
    entry.buyCell.style.setProperty("--intensity", intB.toFixed(3));
    entry.buyBar.style.width = state.bars ? (b / maxVol * 100) + "%" : "0";

    // Venta
    entry.sellLbl.textContent = s > 0 ? fmtUSD(s) : "·";
    entry.sellLbl.dataset.zero = s > 0 ? "false" : "true";
    entry.sellCell.classList.toggle("heat", state.heatmap && s > 0);
    entry.sellCell.classList.toggle("absorbed", state.heatmap && d > 0 && s > 0);
    entry.sellCell.style.setProperty("--intensity", intS.toFixed(3));
    entry.sellBar.style.width = state.bars ? (s / maxVol * 100) + "%" : "0";

    // Flash al subir volumen
    const prevB = prevVol[cacheKey].get(idx + "_b");
    const prevS = prevVol[cacheKey].get(idx + "_s");
    if (prevB != null && b > prevB){
      entry.buyCell.classList.remove("flash");
      void entry.buyCell.offsetWidth;
      entry.buyCell.classList.add("flash");
    }
    if (prevS != null && s > prevS){
      entry.sellCell.classList.remove("flash");
      void entry.sellCell.offsetWidth;
      entry.sellCell.classList.add("flash");
    }
    prevVol[cacheKey].set(idx + "_b", b);
    prevVol[cacheKey].set(idx + "_s", s);

    // Delta
    entry.deltaLbl.textContent = fmtSigned(d);
    entry.deltaCell.dataset.dir = d > 0 ? "up" : d < 0 ? "dn" : "zero";

    // Precio
    entry.priceCell.textContent = (idx * bucket).toLocaleString("en-US");

    // Imbalance izquierda (venta)
    const imbLTxt  = imbS.get(idx) || "";
    const imbLAlert = alS.get(idx);
    const imbLStack = stS.has(idx);
    const imbLAbsorb = absS.has(idx);
    const weakL = weakS.get(idx);

    entry.imbL.className = "c c-imb c-imbL";
    let fullL = imbLTxt;
    if (imbLAlert) fullL += imbLStack ? " 🔥" : (imbLAbsorb ? " 🟡" : " 🚨");
    else if (weakL && imbLTxt === "∞·") fullL = "∞·";
    entry.imbL.textContent = fullL;
    if (imbLAlert && imbLStack)        entry.imbL.classList.add("alert-stack");
    else if (imbLAlert && imbLAbsorb)  entry.imbL.classList.add("absorbed");
    else if (imbLAlert)                entry.imbL.classList.add("alert");

    // Imbalance derecha (compra)
    const imbRTxt  = imbB.get(idx) || "";
    const imbRAlert = alB.get(idx);
    const imbRStack = stB.has(idx);
    const imbRAbsorb = absB.has(idx);
    const weakR = weakB.get(idx);

    entry.imbR.className = "c c-imb c-imbR";
    let fullR = imbRTxt;
    if (imbRAlert) fullR += imbRStack ? " 🔥" : (imbRAbsorb ? " 🟡" : " 🚨");
    else if (weakR && imbRTxt === "∞·") fullR = "∞·";
    entry.imbR.textContent = fullR;
    if (imbRAlert && imbRStack)        entry.imbR.classList.add("alert-stack");
    else if (imbRAlert && imbRAbsorb)  entry.imbR.classList.add("absorbed");
    else if (imbRAlert)                entry.imbR.classList.add("alert");

    // Ratio
    const tot = b + s;
    if (tot > 0){
      entry.ratioBuy.style.width = (b / tot * 100) + "%";
      entry.ratioSell.style.width = (s / tot * 100) + "%";
    } else {
      entry.ratioBuy.style.width = "0%";
      entry.ratioSell.style.width = "0%";
    }
  }

  // Limpieza de prevVol fuera de rango
  for (const k of prevVol[cacheKey].keys()){
    const idx = parseInt(k.split("_")[0], 10);
    if (idx < lo || idx > hi) prevVol[cacheKey].delete(k);
  }

  return { pocVolIdx, pocDeltaIdx };
}

/* ============================================================================
   6. RENDERIZADO DE HEADER
   ============================================================================ */
function renderHeader(snapshot, cursorMs){
  if (!snapshot) return;

  ui.clockLocal.textContent = msToLocal(cursorMs);
  ui.clockUtc.textContent = "UTC " + msToUtcShort(cursorMs);

  if (snapshot.lastPrice != null){
    const pStr = "$" + snapshot.lastPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (ui.priceEl.textContent !== pStr) ui.priceEl.textContent = pStr;
  } else {
    ui.priceEl.textContent = "—";
  }

  ui.pocVolEl.textContent = snapshot.pocVolIdx != null
    ? (snapshot.pocVolIdx * snapshot.bucket).toLocaleString("en-US") : "—";
  ui.pocDeltaEl.textContent = snapshot.pocDeltaIdx != null
    ? (snapshot.pocDeltaIdx * snapshot.bucket).toLocaleString("en-US") : "—";

  ui.deltaLongEl.textContent = fmtSigned(snapshot.delta);
  ui.deltaLongEl.className = "metric-value " + (snapshot.delta > 0 ? "up" : snapshot.delta < 0 ? "dn" : "");

  ui.tradesCountEl.textContent = snapshot.trades.length.toLocaleString("en-US");
  ui.volumeEl.textContent = fmtUSD(snapshot.total) + "$";

  // Delta instantáneo corto (250ms) — más reactivo
  const di = snapshot.instantDeltaShort || 0;
  ui.deltaInstEl.textContent = fmtSigned(di);
  ui.deltaInstEl.className = "metric-value " + (di > 0 ? "up" : di < 0 ? "dn" : "");
}

function renderCoverage(ratio){
  let label, key;
  if (ratio >= 0.98)      { label = "completa"; key = "full"; }
  else if (ratio >= 0.6)  { label = "parcial " + Math.round((1 - ratio) * 100) + "%"; key = "partial"; }
  else                    { label = "insuficiente " + Math.round((1 - ratio) * 100) + "%"; key = "low"; }

  ui.coverage.dataset.state = key;
  ui.covTxt.textContent = label;
}

/* ============================================================================
   7. RENDERIZADO DEL TERMÓMETRO (dual + adaptativo móvil)
   ============================================================================ */
function renderThermo(which, snapshot){
  const fillAcum = which === "live" ? ui.thermoFillLive : ui.thermoFillHist;
  const fillInst = which === "live" ? ui.thermoFillInstLive : ui.thermoFillInstHist;
  const valEl    = which === "live" ? ui.thermoValLive  : ui.thermoValHist;
  const imbEl    = which === "live" ? ui.thermoImbLive  : ui.thermoImbHist;
  const warnEl   = which === "live" ? ui.thermoWarnLive : ui.thermoWarnHist;

  if (!fillAcum || !snapshot) return;

  const mobile = isMobile();

  // Rangos visuales SEPARADOS:
  // - Acumulado: ±400k (6-9 min)
  // - Instantáneo: ±50k (250ms) → mucho más sensible
  const maxAcum = 400000;
  const maxInst = 50000;

  // --- Barra acumulada (suave, contexto) ---
  let pctAcum = 50 + (snapshot.delta / maxAcum) * 50;
  pctAcum = Math.max(2, Math.min(98, pctAcum));
  if (mobile){
    fillAcum.style.width = pctAcum + "%";
    fillAcum.style.height = "";
  } else {
    fillAcum.style.height = pctAcum + "%";
    fillAcum.style.width = "";
  }
  fillAcum.parentElement.setAttribute("aria-valuenow", Math.round(pctAcum));

  // --- Barra instantánea (nerviosa, últimos 250ms) ---
  const instShort = snapshot.instantDeltaShort || 0;
  let pctInst = 50 + (instShort / maxInst) * 50;
  pctInst = Math.max(2, Math.min(98, pctInst));
  if (mobile){
    fillInst.style.width = pctInst + "%";
    fillInst.style.height = "";
  } else {
    fillInst.style.height = pctInst + "%";
    fillInst.style.width = "";
  }
  fillInst.parentElement.setAttribute("aria-valuenow", Math.round(pctInst));

  // --- Valores numéricos ---
  if (snapshot.delta > 0){
    valEl.textContent = "+" + fmtUSD(snapshot.delta);
    valEl.style.color = "var(--green)";
  } else if (snapshot.delta < 0){
    valEl.textContent = "-" + fmtUSD(Math.abs(snapshot.delta));
    valEl.style.color = "var(--red)";
  } else {
    valEl.textContent = "0";
    valEl.style.color = "var(--text-dim)";
  }

  // --- Imbalance general ---
  const tot = snapshot.total;
  if (tot > 0){
    const ratio = (snapshot.tb / tot) * 100;
    if (ratio >= 55)      { imbEl.textContent = `C ${ratio.toFixed(0)}%`; imbEl.style.color = "var(--green)"; }
    else if (ratio <= 45) { imbEl.textContent = `V ${(100 - ratio).toFixed(0)}%`; imbEl.style.color = "var(--red)"; }
    else                  { imbEl.textContent = "≈ neutro"; imbEl.style.color = "var(--text-dim)"; }
  } else {
    imbEl.textContent = "—";
  }

  // --- Aviso de absorción (basado en pressure.exhaustion + absB/absS) ---
  const hasAbsMap = (snapshot.absB && snapshot.absB.size > 0) || (snapshot.absS && snapshot.absS.size > 0);
  const hasExhaustion = snapshot.pressure && snapshot.pressure.exhaustion;
  if (hasAbsMap || hasExhaustion){
    warnEl.hidden = false;
    if (state.sound) vibrate();
  } else {
    warnEl.hidden = true;
  }
}

/* ============================================================================
   8. SNAPSHOTS → RENDER
   ============================================================================ */
function renderLiveFrame(){
  if (state.mode !== "live" || state.paused) return;

  const snapshot = FP.getLiveSnapshot();
  if (!snapshot) return;

  ui.liveEmpty.hidden = snapshot.trades.length > 0;

  renderFootprint("live", "liveGrid", snapshot);
  renderHeader(snapshot, snapshot.cursorMs);
  renderCoverage(1);
  renderThermo("live", snapshot);

  const totalStack = (snapshot.stB ? snapshot.stB.size : 0) + (snapshot.stS ? snapshot.stS.size : 0);
  if (totalStack > lastStackCount) vibrate();
  lastStackCount = totalStack;

  const feed = FP.getFeed();
  const age = snapshot.trades.length
    ? ((snapshot.cursorMs - snapshot.trades[snapshot.trades.length - 1].T) / 1000).toFixed(1)
    : "—";

  ui.statusLive.textContent =
    (feed ? feed.getStatus() : "—") +
    " · último trade hace " + age + "s" +
    (FP.getRestNote() ? " · " + FP.getRestNote() : "");

  ui.connDot.className = "dot " + (feed && feed.getStatus() === "EN VIVO" ? "live" : "err");
}

async function renderHistFrame(showLoading){
  if (state.mode !== "hist") return;

  if (showLoading){
    ui.histEmpty.hidden = false;
    ui.histEmptyTxt.textContent = "Cargando…";
  }

  await FP.ensureHistLoaded(state.histCursor, (txt) => {
    ui.histEmpty.hidden = false;
    ui.histEmptyTxt.textContent = txt;
  });

  const snapshot = FP.getHistSnapshot(state.histCursor);
  if (!snapshot) return;

  ui.histEmpty.hidden = snapshot.trades.length > 0;
  if (!snapshot.trades.length){
    ui.histEmptyTxt.textContent = "Sin trades en esta ventana.";
  }

  renderFootprint("hist", "histGrid", snapshot);
  renderHeader(snapshot, state.histCursor);
  renderThermo("hist", snapshot);

  // Cobertura
  const ratio = FP.coverageRatio(
    Math.max(CONFIG.LISTING_MS, state.histCursor - CONFIG.WINDOW_MIN * 60000),
    Math.min(state.histCursor, Date.now())
  );
  renderCoverage(ratio);

  // Scrubber
  const scrub = ui.scrub;
  const oneHourAgo = Math.max(CONFIG.LISTING_MS, state.histCursor - 60 * 60 * 1000);
  scrub.min = oneHourAgo;
  scrub.max = Math.max(state.histCursor, oneHourAgo + 1);
  scrub.value = state.histCursor;

  // Timeline de eventos
  renderTimeline(snapshot, oneHourAgo, state.histCursor);

  // Estado
  const playTxt = state.histFrozen
    ? "⏸ congelado"
    : (state.histPlaying ? `▶ replay ×${CONFIG.SPEEDS[state.histSpeed - 1] || 1}` : "⏸ pausado");

  ui.statusHist.textContent =
    playTxt + ` · ${msToLocal(state.histCursor)}` +
    (FP.getRestNote() ? " · " + FP.getRestNote() : "");

  ui.connDot.className = "dot replay";
  ui.connLabel.textContent = "HISTÓRICO";
}

/* ============================================================================
   9. TIMELINE
   ============================================================================ */
function renderTimeline(snapshot, startMs, endMs){
  const container = ui.timelineEvents;
  if (!container) return;
  container.innerHTML = "";

  const span = endMs - startMs;
  if (span <= 0) return;

  const events = snapshot.events || [];
  const frag = document.createDocumentFragment();

  for (const ev of events){
    if (ev.t < startMs || ev.t > endMs) continue;
    const pct = ((ev.t - startMs) / span) * 100;
    const dot = document.createElement("span");
    dot.className = "tl-dot";
    dot.dataset.type = ev.type;
    dot.style.left = pct + "%";
    frag.appendChild(dot);
  }

  container.appendChild(frag);
}

/* ============================================================================
   10. LOOPS
   ============================================================================ */
let liveRafId = null;
let liveLastDraw = 0;

function liveLoop(){
  if (liveRafId) return;
  liveRafId = requestAnimationFrame(() => {
    liveRafId = null;
    const now = performance.now();
    if (state.mode === "live" && !state.paused && now - liveLastDraw >= CONFIG.REFRESH_LIVE){
      liveLastDraw = now;
      renderLiveFrame();
    }
    liveLoop();
  });
}

let histRafId = null;
function scheduleHistRender(showLoading){
  if (histRafId) return;
  histRafId = requestAnimationFrame(() => {
    histRafId = null;
    renderHistFrame(showLoading);
  });
}

function histReplayLoop(){
  setInterval(() => {
    if (state.mode !== "hist" || !state.histPlaying || state.histFrozen) return;
    const now = Date.now();
    const speed = CONFIG.SPEEDS[state.histSpeed - 1] || 1;
    if (now - state.histLastTick >= 1000 / speed){
      state.histLastTick = now;
      state.histCursor = Math.min(now, state.histCursor + CONFIG.PLAY_STEP_S * 1000);
      if (state.histCursor >= now){
        state.histPlaying = false;
        ui.btnPlay.textContent = "▶";
      }
      scheduleHistRender(false);
    }
  }, 50);
}

/* ============================================================================
   11. ACCIONES
   ============================================================================ */
function invalidateGrids(){
  for (const key of ["live", "hist"]){
    for (const [, entry] of rowCache[key]) entry.row.remove();
    rowCache[key].clear();
    prevVol[key].clear();
    gridInitialized[key] = false;
    const grid = document.getElementById(key === "live" ? "liveGrid" : "histGrid");
    if (grid) grid.innerHTML = "";
  }
}

function updatePillLabels(){
  ui.pillBucketVal.textContent = state.bucket + "$";
  ui.pillImbVal.textContent = state.imbMode === "diagonal" ? "diag" : "nivel";
  ui.pillMinVal.textContent = fmtUSD(state.minUSD);
  ui.pillThrVal.textContent = state.threshold.toFixed(0) + "%";
  ui.pillHeat.setAttribute("aria-pressed", state.heatmap ? "true" : "false");
  ui.pillBars.setAttribute("aria-pressed", state.bars ? "true" : "false");
  ui.pillThermo.setAttribute("aria-pressed", state.thermo ? "true" : "false");
  ui.pillSound.setAttribute("aria-pressed", state.sound ? "true" : "false");
}

function nextBucket(){
  FP.nextBucket();
  invalidateGrids();
  updatePillLabels();
  if (state.mode === "live") renderLiveFrame(); else scheduleHistRender(false);
}

function toggleImb(){
  FP.toggleImb();
  invalidateGrids();
  updatePillLabels();
  if (state.mode === "live") renderLiveFrame(); else scheduleHistRender(false);
}

function nextMin(){
  FP.nextMin();
  invalidateGrids();
  updatePillLabels();
  if (state.mode === "live") renderLiveFrame(); else scheduleHistRender(false);
}

function thrDelta(d){
  FP.thrDelta(d);
  invalidateGrids();
  updatePillLabels();
  if (state.mode === "live") renderLiveFrame(); else scheduleHistRender(false);
}

function togglePauseLive(){
  state.paused = !state.paused;
  if (!state.paused) renderLiveFrame();
}

function histSeek(deltaMs){
  state.histCursor = Math.max(CONFIG.LISTING_MS, Math.min(Date.now(), state.histCursor + deltaMs));
  state.histFrozen = true;
  ui.btnFreeze.setAttribute("aria-pressed", "true");
  ui.btnFreeze.textContent = "⏸ Congelado";
  scheduleHistRender(false);
}

function histSetFrozen(frozen){
  state.histFrozen = frozen;
  ui.btnFreeze.setAttribute("aria-pressed", frozen ? "true" : "false");
  ui.btnFreeze.textContent = frozen ? "⏸ Congelado" : "▶ Replay";
}

function histPlayToggle(){
  if (state.histPlaying){
    state.histPlaying = false;
    ui.btnPlay.textContent = "▶";
  } else {
    state.histPlaying = true;
    state.histFrozen = false;
    histSetFrozen(false);
    ui.btnPlay.textContent = "⏸";
  }
}

function switchMode(mode){
  if (state.mode === mode) return;
  state.mode = mode;
  $("#tabLive").setAttribute("aria-selected", mode === "live" ? "true" : "false");
  $("#tabHist").setAttribute("aria-selected", mode === "hist" ? "true" : "false");
  $("#panelLive").hidden = mode !== "live";
  $("#panelHist").hidden = mode !== "hist";

  if (mode === "live"){
    FP.startLive();
    renderLiveFrame();
  } else {
    state.histCursor = Date.now();
    state.histFrozen = true;
    state.histPlaying = false;
    ui.btnPlay.textContent = "▶";
    ui.dtInput.value = msToInputValue(state.histCursor);
    histSetFrozen(true);
    scheduleHistRender(true);
  }
}

function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  state.theme = theme;
  try { localStorage.setItem("fp-theme", theme); } catch(_){}
}

/* ============================================================================
   12. BINDINGS
   ============================================================================ */
function bindEvents(){
  // Tabs
  $("#tabLive").addEventListener("click", () => switchMode("live"));
  $("#tabHist").addEventListener("click", () => switchMode("hist"));

  // Tema
  $("#btnTheme").addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  });

  // Pills
  ui.pillBucket.addEventListener("click", nextBucket);
  ui.pillImb.addEventListener("click", toggleImb);
  ui.pillMin.addEventListener("click", nextMin);
  ui.pillThr.addEventListener("click", () => thrDelta(50));
  ui.pillHeat.addEventListener("click", () => {
    state.heatmap = !state.heatmap;
    updatePillLabels(); invalidateGrids();
    if (state.mode === "live") renderLiveFrame(); else scheduleHistRender(false);
  });
  ui.pillBars.addEventListener("click", () => {
    state.bars = !state.bars;
    updatePillLabels(); invalidateGrids();
    if (state.mode === "live") renderLiveFrame(); else scheduleHistRender(false);
  });
  ui.pillThermo.addEventListener("click", () => {
    state.thermo = !state.thermo;
    updatePillLabels();
    document.querySelectorAll(".thermo").forEach(el => {
      el.style.display = state.thermo ? "" : "none";
    });
  });
  ui.pillSound.addEventListener("click", () => {
    state.sound = !state.sound;
    updatePillLabels();
  });

  // Live controls
  $("#btnPauseLive").addEventListener("click", togglePauseLive);
  $("#btnClearLive").addEventListener("click", () => {
    store.clear();
    coverage.intervals = [];
    invalidateGrids();
    toast("Memoria limpiada", "ok");
    renderLiveFrame();
  });

  // Hist controls
  $("#btnGo").addEventListener("click", () => {
    const v = ui.dtInput.value;
    if (!v) return;
    const ms = new Date(v).getTime();
    if (isNaN(ms)) return toast("Fecha inválida", "err");
    if (ms > Date.now()) return toast("Esa hora es futura", "err");
    if (ms < CONFIG.LISTING_MS) return toast("Antes del listing", "err");
    state.histCursor = ms;
    histSetFrozen(true);
    scheduleHistRender(true);
  });

  $("#btnNow").addEventListener("click", () => {
    state.histCursor = Date.now();
    ui.dtInput.value = msToInputValue(state.histCursor);
    histSetFrozen(true);
    scheduleHistRender(true);
  });

  ui.btnFreeze.addEventListener("click", () => {
    histSetFrozen(!state.histFrozen);
    if (state.histFrozen){
      state.histPlaying = false;
      ui.btnPlay.textContent = "▶";
    }
  });

  $("#btnBackBig").addEventListener("click", () => histSeek(-CONFIG.STEP_BIG_S * 1000));
  $("#btnBackSmall").addEventListener("click", () => histSeek(-CONFIG.STEP_SMALL_S * 1000));
  $("#btnFwdSmall").addEventListener("click", () => histSeek(CONFIG.STEP_SMALL_S * 1000));
  $("#btnFwdBig").addEventListener("click", () => histSeek(CONFIG.STEP_BIG_S * 1000));
  ui.btnPlay.addEventListener("click", histPlayToggle);
  ui.speedSel.addEventListener("change", e => {
    const i = CONFIG.SPEEDS.indexOf(+e.target.value);
    state.histSpeed = i >= 0 ? i + 1 : 2;
  });

  ui.scrub.addEventListener("input", e => {
    state.histCursor = +e.target.value;
    histSetFrozen(true);
    state.histPlaying = false;
    ui.btnPlay.textContent = "▶";
    scheduleHistRender(false);
  });

  // Botones hist footer
  $("#btnBucketHist").addEventListener("click", nextBucket);
  $("#btnImbHist").addEventListener("click", toggleImb);
  $("#btnMinHist").addEventListener("click", nextMin);

  // Teclado
  document.addEventListener("keydown", e => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    const k = e.key;
    const kl = k.toLowerCase();

    if (kl === "b"){ nextBucket(); e.preventDefault(); return; }
    if (kl === "i"){ toggleImb(); e.preventDefault(); return; }
    if (kl === "m"){ nextMin(); e.preventDefault(); return; }
    if (k === "["){ thrDelta(-50); e.preventDefault(); return; }
    if (k === "]"){ thrDelta(50); e.preventDefault(); return; }
    if (kl === "h"){ ui.pillHeat.click(); e.preventDefault(); return; }
    if (kl === "v"){ ui.pillBars.click(); e.preventDefault(); return; }
    if (kl === "t"){ ui.pillThermo.click(); e.preventDefault(); return; }
    if (kl === "n"){ ui.pillSound.click(); e.preventDefault(); return; }

    if (state.mode === "live"){
      if (kl === "p"){ togglePauseLive(); e.preventDefault(); }
      return;
    }

    if (k === "ArrowLeft"  || kl === "a"){ histSeek(-CONFIG.STEP_SMALL_S * 1000); e.preventDefault(); }
    else if (k === "ArrowRight" || kl === "d"){ histSeek(CONFIG.STEP_SMALL_S * 1000); e.preventDefault(); }
    else if (k === "ArrowDown"  || kl === "s"){ histSeek(-CONFIG.STEP_BIG_S * 1000); e.preventDefault(); }
    else if (k === "ArrowUp"    || kl === "w"){ histSeek(CONFIG.STEP_BIG_S * 1000); e.preventDefault(); }
    else if (k === " "){ histPlayToggle(); e.preventDefault(); }
  });

  // Resize: recalcular orientación del termómetro
  window.addEventListener("resize", () => {
    if (state.mode === "live") renderLiveFrame();
    else if (state.mode === "hist") scheduleHistRender(false);
  });
}

/* ============================================================================
   13. BOOT
   ============================================================================ */
async function boot(){
  cacheUI();
  bindEvents();

  const savedTheme = (() => {
    try { return localStorage.getItem("fp-theme"); } catch(_){ return null; }
  })();
  applyTheme(savedTheme === "light" ? "light" : "dark");
  updatePillLabels();

  liveLoop();
  histReplayLoop();

  await FP.startLive();
  renderLiveFrame();
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();