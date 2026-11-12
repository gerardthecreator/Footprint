/* ============================================================================
   SCRIPT.JS — Footprint BTCUSDT · Order Flow Pro
   Motor de datos y cálculos. No conoce el DOM. Expone window.FP para que app.js
   consuma snapshots ya calculados.

   Correcciones aplicadas:
   - instantDelta ahora acepta windowMs (permite 1000ms y 250ms separados)
   - Snapshot expone instantDelta (1s) y instantDeltaShort (250ms)
   - computePressure calcula las 3 capas + agotamiento
   - detectEvents marca eventos significativos para la timeline
   ============================================================================ */

(function(){
"use strict";

/* ============================================================================
   1. CONFIGURACIÓN
   ============================================================================ */
const CONFIG = {
  SYMBOL:              "BTCUSDT",
  WINDOW_MIN:          40,
  ROWS:                25,
  BUCKETS:             [5, 10, 20, 50, 70, 100],
  MIN_USD_OPTIONS:     [5000, 10000, 25000, 50000, 100000, 250000],
  THRESHOLD:           300,
  MIN_SIDE_USD:        25000,
  STACKED_N:           3,
  WEAK_BASE_USD:       5000,
  ABSORPTION_WINDOW_MS: 3000,
  RECENT_POC_MS:       90 * 1000,
  REFRESH_LIVE:        350,
  PAGE_LIMIT:          1000,
  PAD_MS:              5 * 60 * 1000,
  STEP_SMALL_S:        15,
  STEP_BIG_S:          60,
  PLAY_STEP_S:         5,
  SPEEDS:              [0.5, 1, 2, 4, 8],
  LISTING_MS:          Date.UTC(2017, 7, 17),
  WS_BASES:            ["wss://stream.binance.com:9443", "wss://data-stream.binance.vision"],
  REST_BASES:          ["https://api.binance.com", "https://data-api.binance.vision", "https://api-gcp.binance.com"],
  MAX_STORE_TRADES:    300000,
  VIBRATE_MS:          120
};

/* ============================================================================
   2. ESTADO GLOBAL
   ============================================================================ */
const state = {
  mode:        "live",
  bucket:      20,
  imbMode:     "diagonal",
  threshold:   CONFIG.THRESHOLD,
  minUSD:      CONFIG.MIN_SIDE_USD,
  paused:      false,
  heatmap:     true,
  bars:        true,
  thermo:      true,
  sound:       false,
  theme:       "dark",

  histCursor:  Date.now(),
  histFrozen:  true,
  histPlaying: false,
  histSpeed:   2,
  histLastTick: 0
};

const store = new Map();       // id → trade
let sortedCache = null;        // array ordenado por T
let sortedTimes = null;        // array de T para binaria

const coverage = { intervals: [] }; // [{s, e}]

let restBaseIdx = 0;
let restNote = "";

/* ============================================================================
   3. HELPERS DE TIEMPO
   ============================================================================ */
function nowMs(){ return Date.now(); }

function pad2(n){ return String(n).padStart(2, "0"); }

function msToLocal(ms){
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ============================================================================
   4. TRADE STORE
   ============================================================================ */
function storeAdd(trade){
  if (store.has(trade.a)) return false;
  store.set(trade.a, trade);
  sortedCache = null;
  sortedTimes = null;
  return true;
}

function storeAddMany(trades){
  let changed = false;
  for (const t of trades) if (storeAdd(t)) changed = true;
  return changed;
}

function storePrune(cutoffMs){
  let changed = false;
  for (const [id, t] of store){
    if (t.T < cutoffMs){ store.delete(id); changed = true; }
  }
  if (changed){ sortedCache = null; sortedTimes = null; }
  if (store.size > CONFIG.MAX_STORE_TRADES){
    const sorted = Array.from(store.values()).sort((a, b) => a.T - b.T);
    const drop = sorted.slice(0, store.size - CONFIG.MAX_STORE_TRADES);
    for (const t of drop) store.delete(t.a);
    sortedCache = null;
    sortedTimes = null;
  }
}

function storeEnsureSorted(){
  if (sortedCache) return;
  const arr = Array.from(store.values());
  arr.sort((a, b) => a.T !== b.T ? a.T - b.T : a.a - b.a);
  sortedCache = arr;
  sortedTimes = arr.map(t => t.T);
}

function storeWindow(startMs, endMs){
  storeEnsureSorted();
  const times = sortedTimes;
  if (!times.length) return [];
  let lo = 0, hi = times.length;
  while (lo < hi){ const m = (lo + hi) >> 1; if (times[m] < startMs) lo = m + 1; else hi = m; }
  const i0 = lo;
  lo = 0; hi = times.length;
  while (lo < hi){ const m = (lo + hi) >> 1; if (times[m] <= endMs) lo = m + 1; else hi = m; }
  return sortedCache.slice(i0, lo);
}

/* ============================================================================
   5. COBERTURA
   ============================================================================ */
function coverageAdd(s, e){
  coverage.intervals.push([s, e]);
  coverage.intervals.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s2, e2] of coverage.intervals){
    if (out.length && s2 <= out[out.length - 1][1] + 1){
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], e2);
    } else {
      out.push([s2, e2]);
    }
  }
  coverage.intervals = out;
}

function coverageMissing(s, e){
  const gaps = [];
  let cur = s;
  for (const [s2, e2] of coverage.intervals){
    if (e2 < cur) continue;
    if (s2 > cur) gaps.push([cur, Math.min(s2 - 1, e)]);
    cur = Math.max(cur, e2 + 1);
    if (cur > e) break;
  }
  if (cur <= e) gaps.push([cur, e]);
  return gaps.filter(([a, b]) => a <= b);
}

function coverageRatio(startMs, endMs){
  const total = endMs - startMs;
  if (total <= 0) return 1;
  const gaps = coverageMissing(startMs, endMs);
  const missing = gaps.reduce((acc, [a, b]) => acc + (b - a), 0);
  return 1 - missing / total;
}

/* ============================================================================
   6. AGREGACIÓN Y CÁLCULOS
   ============================================================================ */
function aggregate(trades, bucket){
  const buy = new Map(), sell = new Map();
  let tb = 0, ts = 0;
  for (const t of trades){
    const idx = Math.floor(t.p / bucket);
    const v = t.p * t.q;
    if (t.m){ sell.set(idx, (sell.get(idx) || 0) + v); ts += v; }
    else    { buy.set(idx,  (buy.get(idx)  || 0) + v); tb += v; }
  }
  return { buy, sell, tb, ts };
}

function sideImb(num, den, minUSD, threshold){
  if (num <= 0 || num <= den) return ["", false, false];
  if (den <= 0){
    return [num >= minUSD ? "∞" : "∞·", num >= minUSD, false];
  }
  const weakBase = den < CONFIG.WEAK_BASE_USD;
  const pct = (num / den) * 100;
  const alert = pct >= threshold && num >= minUSD && !weakBase;
  const label = weakBase ? "∞·" : Math.min(pct, 99999).toFixed(0) + "%";
  return [label, alert, weakBase];
}

function stackedSet(alerts, lo, hi, n){
  const out = new Set();
  let run = [];
  for (let i = lo; i <= hi; i++){
    if (alerts.get(i)) run.push(i);
    else { if (run.length >= n) run.forEach(x => out.add(x)); run = []; }
  }
  if (run.length >= n) run.forEach(x => out.add(x));
  return out;
}

function detectAbsorption(alertsB, alertsS, buy, sell, bucket, tradesInWindow, cursorMs){
  const absorbedB = new Map();
  const absorbedS = new Map();
  if (tradesInWindow.length < 2) return { absorbedB, absorbedS };

  const recent = tradesInWindow.filter(t => t.T >= cursorMs - CONFIG.ABSORPTION_WINDOW_MS);
  if (!recent.length) return { absorbedB, absorbedS };

  const priceNow = tradesInWindow[tradesInWindow.length - 1].p;
  const priceOld = recent[0].p;
  const moved = Math.abs(priceNow - priceOld) >= bucket;

  if (moved) return { absorbedB, absorbedS };

  for (const [idx, isAlert] of alertsB){
    if (!isAlert) continue;
    const b = buy.get(idx) || 0;
    const s = sell.get(idx) || 0;
    if ((b - s) <= 0) absorbedB.set(idx, true);
  }
  for (const [idx, isAlert] of alertsS){
    if (!isAlert) continue;
    const b = buy.get(idx) || 0;
    const s = sell.get(idx) || 0;
    if ((s - b) <= 0) absorbedS.set(idx, true);
  }
  return { absorbedB, absorbedS };
}

/**
 * Delta de los últimos `windowMs` ms (por defecto 1000).
 * Ahora acepta ventana variable para calcular 1s y 250ms por separado.
 */
function instantDelta(trades, cursorMs, windowMs){
  if (windowMs == null) windowMs = 1000;
  let d = 0;
  const cutoff = cursorMs - windowMs;
  for (let i = trades.length - 1; i >= 0; i--){
    const t = trades[i];
    if (t.T < cutoff) break;
    const v = t.p * t.q;
    d += t.m ? -v : v;
  }
  return d;
}

function computePOCs(buy, sell){
  let pocVolIdx = null, pocVolVal = -1;
  let pocDeltaIdx = null, pocDeltaVal = -1;
  const allIdx = new Set([...buy.keys(), ...sell.keys()]);
  for (const idx of allIdx){
    const b = buy.get(idx) || 0;
    const s = sell.get(idx) || 0;
    const totalVol = b + s;
    if (totalVol > pocVolVal){ pocVolVal = totalVol; pocVolIdx = idx; }
    const absDelta = Math.abs(b - s);
    if (absDelta > pocDeltaVal){ pocDeltaVal = absDelta; pocDeltaIdx = idx; }
  }
  return { pocVolIdx, pocDeltaIdx };
}

/**
 * Termómetro de Presión Neta (3 capas):
 * - aggressive: delta normalizado de últimos 3s (-1..1)
 * - displacement: cambio de precio normalizado en 10s (-1..1)
 * - exhaustion: agresión fuerte sin desplazamiento
 */
function computePressure(trades, bucket, cursorMs){
  if (!trades.length) return { aggressive: 0, displacement: 0, exhaustion: false };

  const lastPrice = trades[trades.length - 1].p;

  // Capa 1: agresiva (últimos 3s)
  const cutoffAgg = cursorMs - 3000;
  let aggDelta = 0, aggTotal = 0;
  for (let i = trades.length - 1; i >= 0; i--){
    const t = trades[i];
    if (t.T < cutoffAgg) break;
    const v = t.p * t.q;
    aggTotal += v;
    aggDelta += t.m ? -v : v;
  }
  const aggressive = aggTotal > 0 ? Math.max(-1, Math.min(1, aggDelta / aggTotal)) : 0;

  // Capa 2: desplazamiento (últimos 10s)
  const cutoffDisp = cursorMs - 10000;
  let price10 = lastPrice;
  for (let i = trades.length - 1; i >= 0; i--){
    if (trades[i].T < cutoffDisp){ break; }
    price10 = trades[i].p;
  }
  const rawMove = (lastPrice - price10) / bucket;
  const displacement = Math.max(-1, Math.min(1, rawMove / 5));

  // Capa 3: agotamiento
  const exhaustion = Math.abs(aggressive) > 0.3 && Math.abs(displacement) < 0.1;

  return { aggressive, displacement, exhaustion };
}

/**
 * Eventos para la timeline: cada 5s marca si hubo stacked o volumen extremo.
 */
function detectEvents(trades, bucket, startMs, endMs){
  const events = [];
  if (!trades.length) return events;
  const step = 5000;
  for (let t = startMs; t <= endMs; t += step){
    const sub = trades.filter(x => x.T >= t && x.T < t + step);
    if (!sub.length) continue;
    const agg = aggregate(sub, bucket);
    const total = agg.tb + agg.ts;
    if (total > 500000){
      events.push({ t: t + step / 2, type: "volume" });
    }
    const alB = new Map(), alS = new Map();
    for (const [idx, v] of agg.buy){
      const s = agg.sell.get(idx - 1) || 0;
      const [, al] = sideImb(v, s, state.minUSD, state.threshold);
      alB.set(idx, al);
    }
    for (const [idx, v] of agg.sell){
      const b = agg.buy.get(idx + 1) || 0;
      const [, al] = sideImb(v, b, state.minUSD, state.threshold);
      alS.set(idx, al);
    }
    const stB = stackedSet(alB, -Infinity, Infinity, CONFIG.STACKED_N);
    const stS = stackedSet(alS, -Infinity, Infinity, CONFIG.STACKED_N);
    if (stB.size + stS.size >= 3){
      events.push({ t: t + step / 2, type: "stack" });
    }
  }
  return events;
}

/* ============================================================================
   7. REST
   ============================================================================ */
async function restFetch(params, signal){
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++){
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const base = CONFIG.REST_BASES[restBaseIdx % CONFIG.REST_BASES.length];
      const qs = new URLSearchParams(params).toString();
      const res = await fetch(`${base}/api/v3/aggTrades?${qs}`, { signal });
      if (res.status === 200){
        restNote = "";
        return await res.json();
      }
      if (res.status === 429 || res.status === 418){
        const ra = parseInt(res.headers.get("Retry-After") || "5", 10);
        restNote = `rate-limit ${ra}s`;
        await new Promise(r => setTimeout(r, ra * 1000 + 500));
        continue;
      }
      if (res.status === 451 || res.status >= 500){
        restBaseIdx++;
        restNote = "otro endpoint";
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      throw new Error("HTTP " + res.status);
    } catch (ex){
      if (ex.name === "AbortError") throw ex;
      restNote = "red: " + ex.message;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      if (attempt >= 2) restBaseIdx++;
    }
  }
  throw new Error("reintentos agotados");
}

async function restLoadRange(startMs, endMs, onProgress, signal){
  const out = [];
  let page = await restFetch({
    symbol: CONFIG.SYMBOL, startTime: startMs, endTime: endMs, limit: CONFIG.PAGE_LIMIT
  }, signal);

  while (page && page.length){
    for (const d of page){
      if (d.T > endMs) break;
      out.push({ T: d.T, a: d.a, p: +d.p, q: +d.q, m: !!d.m });
    }
    if (onProgress){
      const frac = (page[page.length - 1].T - startMs) / Math.max(1, endMs - startMs);
      onProgress(Math.min(1, Math.max(0, frac)), out.length);
    }
    if (page.length < CONFIG.PAGE_LIMIT || page[page.length - 1].T >= endMs) break;
    page = await restFetch({
      symbol: CONFIG.SYMBOL, fromId: page[page.length - 1].a + 1, limit: CONFIG.PAGE_LIMIT
    }, signal);
  }
  return out;
}

/* ============================================================================
   8. WEBSOCKET
   ============================================================================ */
class LiveFeed {
  constructor(){
    this.ws = null;
    this.stopped = true;
    this.baseIdx = 0;
    this.backoff = 1;
    this.lastMsg = 0;
    this.lastT = 0;
    this.reconnectTimer = null;
    this.watchdogId = null;
    this.statusText = "desconectado";
  }

  getStatus(){ return this.statusText; }

  url(){
    return CONFIG.WS_BASES[this.baseIdx % CONFIG.WS_BASES.length]
      + "/ws/" + CONFIG.SYMBOL.toLowerCase() + "@aggTrade";
  }

  start(){
    if (!this.stopped) return;
    this.stopped = false;
    this.backoff = 1;
    this.connect();
    if (!this.watchdogId){
      this.watchdogId = setInterval(() => this.watchdog(), 5000);
    }
  }

  connect(){
    if (this.stopped) return;
    this.gapFill();

    try {
      this.ws = new WebSocket(this.url());
      this.ws.onopen = () => {
        this.setStatus("EN VIVO");
        this.lastMsg = Date.now();
      };
      this.ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.e === "aggTrade"){
            const trade = { T: d.T, a: d.a, p: +d.p, q: +d.q, m: !!d.m };
            storeAdd(trade);
            this.lastMsg = Date.now();
            if (trade.T > this.lastT) this.lastT = trade.T;
            this.setStatus("EN VIVO");
          } else if (d.e === "serverShutdown"){
            this.setStatus("mantenimiento · reconectando");
            try { this.ws.close(); } catch(_){}
          }
        } catch(_){}
      };
      this.ws.onerror = () => this.setStatus("ws error");
      this.ws.onclose = () => {
        if (this.stopped) return;
        this.setStatus("desconectado · reconectando…");
        this.scheduleReconnect();
      };
    } catch (ex) {
      this.setStatus("ws: " + ex.message);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect(){
    if (this.reconnectTimer) return;
    this.baseIdx++;
    const wait = this.backoff * 1000;
    this.setStatus(`reconectando en ${this.backoff}s…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, 15);
      this.connect();
    }, wait);
  }

  async gapFill(){
    if (!this.lastT) return;
    const now = Date.now();
    if (now - this.lastT < 1500) return;
    this.setStatus("rellenando hueco…");
    try {
      const gap = await restLoadRange(this.lastT + 1, now);
      storeAddMany(gap);
      if (gap.length) this.lastT = Math.max(this.lastT, gap[gap.length - 1].T);
    } catch(_){}
  }

  watchdog(){
    if (this.stopped) return;
    if (!this.lastMsg) return;
    if (Date.now() - this.lastMsg > 20000 && this.ws){
      this.setStatus("sin datos >20s · reconectando");
      try { this.ws.close(); } catch(_){}
    }
  }

  setStatus(txt){ this.statusText = txt; }

  stop(){
    this.stopped = true;
    if (this.reconnectTimer){ clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.watchdogId){ clearInterval(this.watchdogId); this.watchdogId = null; }
    try { if (this.ws) this.ws.close(); } catch(_){}
    this.setStatus("desconectado");
  }
}

const feed = new LiveFeed();

/* ============================================================================
   9. SNAPSHOTS
   ============================================================================ */
function buildSnapshot(trades, cursorMs, isLive){
  if (!trades.length) return {
    trades: [],
    cursorMs,
    bucket: state.bucket,
    tb: 0, ts: 0, total: 0, delta: 0,
    instantDelta: 0,
    instantDeltaShort: 0,
    pressure: { aggressive: 0, displacement: 0, exhaustion: false },
    buy: new Map(), sell: new Map(),
    imbB: new Map(), imbS: new Map(),
    alB: new Map(), alS: new Map(),
    absB: new Map(), absS: new Map(),
    weakB: new Map(), weakS: new Map(),
    stB: new Set(), stS: new Set(),
    maxVol: 1, lo: 0, hi: 0, center: 0,
    pocVolIdx: null, pocDeltaIdx: null,
    lastPrice: null,
    events: []
  };

  const { buy, sell, tb, ts } = aggregate(trades, state.bucket);
  const total = tb + ts;
  const delta = tb - ts;
  const lastPrice = trades[trades.length - 1].p;
  const center = Math.floor(lastPrice / state.bucket);
  const half = Math.floor(CONFIG.ROWS / 2);
  const hi = center + half;
  const lo = center - half;

  const { pocVolIdx, pocDeltaIdx } = computePOCs(buy, sell);

  let maxVol = 1;
  for (let i = lo; i <= hi; i++){
    const v = Math.max(buy.get(i) || 0, sell.get(i) || 0);
    if (v > maxVol) maxVol = v;
  }

  const imbB = new Map(), imbS = new Map();
  const alB = new Map(), alS = new Map();
  const weakB = new Map(), weakS = new Map();

  for (let idx = lo - 1; idx <= hi + 1; idx++){
    const b = buy.get(idx) || 0;
    const s = sell.get(idx) || 0;
    let denB, denS;
    if (state.imbMode === "diagonal"){
      denB = sell.get(idx - 1) || 0;
      denS = buy.get(idx + 1) || 0;
    } else {
      denB = s; denS = b;
    }
    const [lblB, alrB, weak] = sideImb(b, denB, state.minUSD, state.threshold);
    imbB.set(idx, lblB); alB.set(idx, alrB); weakB.set(idx, weak);

    const [lblS, alrS, weakS_] = sideImb(s, denS, state.minUSD, state.threshold);
    imbS.set(idx, lblS); alS.set(idx, alrS); weakS.set(idx, weakS_);
  }

  const stB = stackedSet(alB, lo, hi, CONFIG.STACKED_N);
  const stS = stackedSet(alS, lo, hi, CONFIG.STACKED_N);

  const { absorbedB, absorbedS } = isLive
    ? detectAbsorption(alB, alS, buy, sell, state.bucket, trades, cursorMs)
    : { absorbedB: new Map(), absorbedS: new Map() };

  const dInst = instantDelta(trades, cursorMs, 1000);
  const dInstShort = instantDelta(trades, cursorMs, 250);
  const pressure = computePressure(trades, state.bucket, cursorMs);

  return {
    trades, cursorMs, bucket: state.bucket,
    tb, ts, total, delta,
    instantDelta: dInst,
    instantDeltaShort: dInstShort,
    pressure,
    buy, sell,
    imbB, imbS, alB, alS,
    absB: absorbedB, absS: absorbedS,
    weakB, weakS,
    stB, stS,
    maxVol, lo, hi, center,
    pocVolIdx, pocDeltaIdx,
    lastPrice,
    events: []
  };
}

function getLiveSnapshot(){
  const now = nowMs();
  const start = now - CONFIG.WINDOW_MIN * 60 * 1000;
  storePrune(start - 2000);
  const trades = storeWindow(start, now);
  return buildSnapshot(trades, now, true);
}

function getHistSnapshot(cursorMs){
  const start = cursorMs - CONFIG.WINDOW_MIN * 60 * 1000;
  const trades = storeWindow(start, cursorMs);
  const snap = buildSnapshot(trades, cursorMs, false);
  snap.events = detectEvents(trades, state.bucket, start, cursorMs);
  return snap;
}

/* ============================================================================
   10. CARGA HISTÓRICA
   ============================================================================ */
let histAbort = null;

async function ensureHistLoaded(cursorMs, onProgress){
  const now = Date.now();
  const start = Math.max(CONFIG.LISTING_MS, cursorMs - CONFIG.WINDOW_MIN * 60 * 1000);
  const end = Math.min(cursorMs, now);
  if (start > end) return;

  const gaps = coverageMissing(start, end);
  if (!gaps.length) return;

  if (histAbort) histAbort.abort();
  histAbort = new AbortController();

  for (const [gs, ge] of gaps){
    const s2 = Math.max(CONFIG.LISTING_MS, gs - CONFIG.PAD_MS);
    const e2 = Math.min(now, ge + CONFIG.PAD_MS);
    try {
      const data = await restLoadRange(s2, e2, (frac, count) => {
        if (onProgress) onProgress(`Cargando ${msToLocal(s2)} → ${msToLocal(e2)} … ${(frac*100).toFixed(0)}% (${count.toLocaleString("en-US")})`);
      }, histAbort.signal);
      storeAddMany(data);
      coverageAdd(s2, e2);
    } catch (ex){
      if (ex.name !== "AbortError"){
        restNote = "hist: " + ex.message;
      }
    }
  }
}

/* ============================================================================
   11. ORQUESTADOR LIVE
   ============================================================================ */
let liveStarted = false;

async function startLive(){
  if (liveStarted) return;
  liveStarted = true;
  feed.start();
  try {
    const now = Date.now();
    const data = await restLoadRange(now - CONFIG.WINDOW_MIN * 60 * 1000, now);
    storeAddMany(data);
  } catch (ex){
    restNote = "inicial: " + ex.message;
  }
}

/* ============================================================================
   12. API PÚBLICA
   ============================================================================ */
function nextBucket(){
  const i = CONFIG.BUCKETS.indexOf(state.bucket);
  state.bucket = CONFIG.BUCKETS[(i + 1) % CONFIG.BUCKETS.length];
}

function toggleImb(){
  state.imbMode = state.imbMode === "diagonal" ? "nivel" : "diagonal";
}

function nextMin(){
  const i = CONFIG.MIN_USD_OPTIONS.indexOf(state.minUSD);
  state.minUSD = CONFIG.MIN_USD_OPTIONS[(i + 1) % CONFIG.MIN_USD_OPTIONS.length];
}

function thrDelta(d){
  state.threshold = Math.max(100, Math.min(2000, state.threshold + d));
}

function getRestNote(){ return restNote; }
function getFeed(){ return feed; }

window.FP = {
  CONFIG,
  state,
  store,
  coverage,
  nextBucket, toggleImb, nextMin, thrDelta,
  getLiveSnapshot,
  getHistSnapshot,
  ensureHistLoaded,
  coverageRatio,
  startLive,
  getRestNote,
  getFeed,
  aggregate,
  sideImb,
  stackedSet,
  detectAbsorption,
  instantDelta,
  computePOCs,
  computePressure,
  detectEvents
};

})();