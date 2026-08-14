/**
 * @module tb
 * Эндшпильные базы v2 — бинарный формат, memory-safe.
 * Файл .bin (на каждое k): заголовок 32Б + директория составов (12Б each) +
 * тело (Uint16: статус<<10|дистанция) по составам (wm,wk,bm,bk).
 * Память: расчёт — один состав одновременно; чтение — LRU-кеш составов
 * (≤64 МБ), вся таблица в память не загружается.
 */
import { getLegalMoves, makeMove, colorOf, isKingPiece, isManPiece, isDarkSquare, rankOf } from './engine.js';

const WHITE = 'w', BLACK = 'b';
const ST_INV = 0, ST_WIN = 1, ST_LOSS = 2, ST_DRAW = 3;
const HDR = 32, DIRE = 12, MAGIC = 0x52544232;

const d2b = [], b2d = new Array(64).fill(-1);
for (let i = 0; i < 64; i++) if (isDarkSquare(i)) { b2b_push(i); }
function b2b_push(i) { b2d[i] = d2b.length; d2b.push(i); }

const C = [];
for (let n = 0; n <= 32; n++) { C[n] = new Array(33).fill(0); C[n][0] = 1; for (let r = 1; r <= n; r++) C[n][r] = C[n - 1][r - 1] + C[n - 1][r]; }
const combRank = (c) => { let r = 0; for (let i = 0; i < c.length; i++) r += C[c[i]][i + 1]; return r; };
function unrankIn(rank, n, pool) {
  const res = []; let r = rank, need = n;
  for (let i = 0; i < pool.length && need > 0; i++) {
    const rem = pool.length - 1 - i;
    const without = need <= rem ? C[rem][need] : 0;
    if (r < without) { res.push(pool[i]); need--; } else r -= without;
  }
  return res;
}
const minus = (pool, set) => pool.filter((x) => !set.has(x));
const typeOf = (p) => isKingPiece(p) ? (colorOf(p) === WHITE ? 1 : 3) : (colorOf(p) === WHITE ? 0 : 2);

/* ── составы и индексация ── */
export function compOf(state) {
  let wm = 0, wk = 0, bm = 0, bk = 0;
  for (const p of state.board) if (p) {
    if (isKingPiece(p)) (colorOf(p) === WHITE ? wk++ : bk++);
    else (colorOf(p) === WHITE ? wm++ : bm++);
  }
  return { wm, wk, bm, bk };
}
export const compKey = (c) => (c.wm & 15) | ((c.wk & 15) << 4) | ((c.bm & 15) << 8) | ((c.bk & 15) << 12);
export function compsForK(k) {
  const out = [];
  for (let wm = 0; wm <= k; wm++) for (let wk = 0; wk <= k - wm; wk++) for (let bm = 0; bm <= k - wm - wk; bm++) {
    const bk = k - wm - wk - bm;
    if (wm + wk === 0 || bm + bk === 0) continue;
    out.push({ wm, wk, bm, bk });
  }
  return out.sort((a, b) => (b.wk + b.bk) - (a.wk + a.bk)); // больше дамок — раньше
}
export function compCount(c) {
  return C[32][c.wm] * C[32 - c.wm][c.wk] * C[32 - c.wm - c.wk][c.bm] * C[32 - c.wm - c.wk - c.bm][c.bk] * 2;
}
function rankIn(comb, pool) { return combRank(comb.map((x) => pool.indexOf(x))); }
export function indexInComp(state, c) {
  const g = { 0: [], 1: [], 2: [], 3: [] };
  for (let i = 0; i < 64; i++) { const p = state.board[i]; if (p) g[typeOf(p)].push(b2d[i]); }
  for (const t in g) g[t].sort((a, b) => a - b);
  let pool = [...Array(32).keys()];
  const r1 = rankIn(g[0], pool); pool = minus(pool, new Set(g[0]));
  const r2 = rankIn(g[1], pool); pool = minus(pool, new Set(g[1]));
  const r3 = rankIn(g[2], pool); pool = minus(pool, new Set(g[2]));
  const r4 = rankIn(g[3], pool);
  const idx = (((r1 * C[32 - c.wm][c.wk] + r2) * C[32 - c.wm - c.wk][c.bm] + r3) * C[32 - c.wm - c.wk - c.bm][c.bk] + r4);
  return idx * 2 + (state.turn === WHITE ? 0 : 1);
}
export function stateAt(c, idx) {
  const turn = (idx & 1) ? BLACK : WHITE;
  let t = (idx - (idx & 1)) / 2;
  const c4 = C[32 - c.wm - c.wk - c.bm][c.bk], c3 = C[32 - c.wm - c.wk][c.bm], c2 = C[32 - c.wm][c.wk];
  const r4 = t % c4; t = (t - r4) / c4;
  const r3 = t % c3; t = (t - r3) / c3;
  const r2 = t % c2; t = (t - r2) / c2;
  const r1 = t;
  let pool = [...Array(32).keys()];
  const wM = unrankIn(r1, c.wm, pool); pool = minus(pool, new Set(wM));
  const wK = unrankIn(r2, c.wk, pool); pool = minus(pool, new Set(wK));
  const bM = unrankIn(r3, c.bm, pool); pool = minus(pool, new Set(bM));
  const bK = unrankIn(r4, c.bk, pool);
  const board = new Array(64).fill(null);
  for (const d of wM) board[d2b[d]] = 'w';
  for (const d of wK) board[d2b[d]] = 'W';
  for (const d of bM) board[d2b[d]] = 'b';
  for (const d of bK) board[d2b[d]] = 'B';
  return { board, turn, plies: 0 };
}
function validState(st) {
  for (let i = 0; i < 64; i++) {
    const p = st.board[i];
    if (p && isManPiece(p)) {
      const r = rankOf(i);
      if ((colorOf(p) === WHITE && r === 7) || (colorOf(p) === BLACK && r === 0)) return false;
    }
  }
  return true;
}
export const pack = (s, d) => ((s & 3) << 10) | (d & 0x3FF);
export const unpackStatus = (v) => (v >> 10) & 3;
export const unpackDist = (v) => v & 0x3FF;
export function tbValueToScore(v) {
  const s = unpackStatus(v), d = unpackDist(v);
  if (s === ST_WIN) return 100000 - d;
  if (s === ST_LOSS) return -(100000 - d);
  return 0;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ═══ решатель одного состава (в памяти — только он) ═══ */
async function solveComp(c, k, probeLower, solved, hooks) {
  const S = compCount(c);
  const values = new Uint16Array(S), rem = new Uint8Array(S), deg = new Uint32Array(S);
  const edgeLists = new Array(S), queue = [];
  for (let idx = 0; idx < S; idx++) {                                   // ── сбор графа ──
    if (idx % 50000 === 0) { hooks.onProgress?.(0.4 * idx / S, `сбор ${c.wm}${c.wk}-${c.bm}${c.bk}`); if (hooks.stop?.()) return null; await tick(); }
    const st = stateAt(c, idx);
    if (!validState(st)) { values[idx] = pack(ST_INV, 0); continue; }
    const moves = getLegalMoves(st);
    if (!moves.length) { values[idx] = pack(ST_LOSS, 0); queue.push(idx); continue; }
    const edges = []; let remC = 0, win = false, wd = 0;
    for (const m of moves) {
      const piece = st.board[m.from];
      const promotes = m.king && isManPiece(piece);
      const ns = makeMove(st, m);
      if (m.isCapture) {
        let opp = 0; for (const p of ns.board) if (p && colorOf(p) !== st.turn) opp++;
        if (opp === 0) { win = true; wd = 1; }                          // соперник без фигур — выигрыш
        else {
          const ev = probeLower(ns);
          if (ev == null) remC++;
          else if (unpackStatus(ev) === ST_LOSS) { win = true; wd = Math.min(999, unpackDist(ev) + 1); }
          else remC++;
        }
      } else if (promotes) {
        const sc = solved.get(compKey(compOf(ns)));
        const ev = sc ? sc.values[indexInComp(ns, sc.comp)] : null;
        if (ev == null) remC++;
        else if (unpackStatus(ev) === ST_LOSS) { win = true; wd = Math.min(999, unpackDist(ev) + 1); }
        else remC++;
      } else { edges.push(indexInComp(ns, c)); remC++; }
    }
    edgeLists[idx] = edges; deg[idx] = edges.length; rem[idx] = remC;
    if (win) { values[idx] = pack(ST_WIN, wd); queue.push(idx); }
  }
  const off = new Uint32Array(S + 1);
  for (let i = 0; i < S; i++) off[i + 1] = off[i] + deg[i];
  const edgesArr = new Uint32Array(off[S]);
  const preds = new Array(S);
  for (let i = 0; i < S; i++) { let p = off[i]; for (const j of (edgeLists[i] || [])) { edgesArr[p++] = j; (preds[j] ??= []).push(i); } }
  let qi = 0;                                                          // ── распространение ──
  while (qi < queue.length) {
    const idx = queue[qi++];
    if (qi % 50000 === 0) { hooks.onProgress?.(0.4 + 0.5 * qi / S, 'распространение'); if (hooks.stop?.()) return null; await tick(); }
    const v = unpackStatus(values[idx]), d = unpackDist(values[idx]);
    const pr = preds[idx]; if (!pr) continue;
    for (const p of pr) {
      if (unpackStatus(values[p])) continue;
      if (v === ST_LOSS) { values[p] = pack(ST_WIN, Math.min(999, d + 1)); queue.push(p); }
      else if (--rem[p] === 0) { values[p] = pack(ST_LOSS, Math.min(999, d + 1)); queue.push(p); }
    }
  }
  for (let idx = 0; idx < S; idx++) if (!unpackStatus(values[idx])) values[idx] = pack(ST_DRAW, 0);
  return { comp: c, values };
}

/* ═══ решатель уровня k: составы по очереди, файл каждые 100k ═══ */
export class TBSolver {
  constructor(k, probeLower) { this.k = k; this.probeLower = probeLower; }
  async run(hooks = {}) {
    const sections = [], solved = new Map();
    let donePos = 0, lastSave = 0;
    for (const c of compsForK(this.k)) {
      if (hooks.stop?.()) return null;
      const res = await solveComp(c, this.k, this.probeLower, solved, hooks);
      if (!res) return null;
      solved.set(compKey(c), res);
      sections.push({ key: compKey(c), count: compCount(c), values: res.values });
      donePos += res.values.length;
      if (donePos - lastSave >= 100000) { lastSave = donePos; await hooks.onSave?.(serialize(this.k, sections)); }
    }
    await hooks.onSave?.(serialize(this.k, sections));
    hooks.onProgress?.(1, 'готово');
    return serialize(this.k, sections);
  }
}

/* ── сериализация в бинарный формат ── */
export function serialize(k, sections) {
  const bodySize = sections.reduce((s, x) => s + x.count * 2, 0);
  const buf = new ArrayBuffer(HDR + sections.length * DIRE + bodySize);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC); dv.setUint8(4, 1); dv.setUint8(5, k);
  dv.setUint16(6, sections.length); dv.setUint32(8, bodySize);
  let off = 0, ptr = HDR + sections.length * DIRE;
  sections.forEach((s, i) => {
    const o = HDR + i * DIRE;
    dv.setUint32(o, s.key); dv.setUint32(o + 4, s.count); dv.setUint32(o + 8, off);
    new Uint8Array(buf, ptr, s.count * 2).set(new Uint8Array(s.values.buffer));
    ptr += s.count * 2; off += s.count * 2;
  });
  return buf;
}

/* ═══ ленивый читатель: LRU-кеш составов, вся таблица не в памяти ═══ */
export class TBReader {
  constructor(blob, cacheBytes = 64 * 1024 * 1024) {
    this.blob = blob; this.cap = cacheBytes; this.used = 0;
    this.cache = new Map(); this.lru = []; this.loading = new Set();
    this.values = null; this.ready = this._init();
  }
  async _init() {
    const hb = await this.blob.slice(0, HDR).arrayBuffer();
    const dv = new DataView(hb);
    if (dv.getUint32(0) !== MAGIC) throw new Error('не RTB2');
    this.k = dv.getUint8(5);
    const n = dv.getUint16(6); this.bodySize = dv.getUint32(8);
    const db = await this.blob.slice(HDR, HDR + n * DIRE).arrayBuffer();
    const d = new DataView(db);
    this.dir = new Map();
    for (let i = 0; i < n; i++) this.dir.set(d.getUint32(i * DIRE), { count: d.getUint32(i * DIRE + 4), offset: d.getUint32(i * DIRE + 8) });
    this.base = HDR + n * DIRE;
  }
  /** Полная загрузка (только для решателя: младшие базы должны отвечать синхронно). */
  async loadAll() {
    await this.ready;
    if (!this.values) { const b = await this.blob.slice(this.base, this.base + this.bodySize).arrayBuffer(); this.values = new Uint16Array(b); }
  }
  /** Синхронный зонд: значение из кеша или null (состав подтянется асинхронно). */
  probe(state) {
    if (!this.dir) return null;
    let n = 0; for (const p of state.board) if (p) n++;
    if (n !== this.k) return null;
    const c = compOf(state), key = compKey(c), sec = this.dir.get(key);
    if (!sec) return null;
    const idx = indexInComp(state, c); if (idx >= sec.count) return null;
    if (this.values) { const v = this.values[(sec.offset >> 1) + idx]; return unpackStatus(v) === ST_INV ? null : v; }
    const arr = this.cache.get(key);
    if (!arr) { this._load(key, sec); return null; }
    const v = arr[idx];
    return unpackStatus(v) === ST_INV ? null : v;
  }
  _load(key, sec) {
    if (this.loading.has(key)) return;
    this.loading.add(key);
    const bytes = sec.count * 2;
    this.blob.slice(this.base + sec.offset, this.base + sec.offset + bytes).arrayBuffer()
      .then((buf) => {
        while (this.used + bytes > this.cap && this.lru.length) {
          const old = this.lru.shift(); const oa = this.cache.get(old);
          if (oa) { this.used -= oa.byteLength; this.cache.delete(old); }
        }
        this.cache.set(key, new Uint16Array(buf)); this.used += bytes; this.lru.push(key);
        this.loading.delete(key);
      })
      .catch(() => this.loading.delete(key));
  }
}
