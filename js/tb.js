/**
 * @module tb
 * Эндшпильные базы русских шашек: индексация позиций с k фигурами и
 * решатель прямым распространением (WIN/LOSS/DRAW + дистанция).
 * Значение v = статус*1000 + дистанция (1=выигрыш хода, 2=проигрыш, 3=ничья).
 */
import { getLegalMoves, makeMove, colorOf, isKingPiece, isDarkSquare, rankOf } from './engine.js';

const WHITE = 'w', BLACK = 'b';
const d2b = [], b2d = new Array(64).fill(-1);
for (let i = 0; i < 64; i++) if (isDarkSquare(i)) { b2d[i] = d2b.length; d2b.push(i); }
const C = []; for (let n = 0; n <= 32; n++) { C[n] = new Array(33).fill(0); C[n][0] = 1; for (let r = 1; r <= n; r++) C[n][r] = C[n - 1][r - 1] + C[n - 1][r]; }
const combRank = (c) => { let r = 0; for (let i = 0; i < c.length; i++) r += C[c[i]][i + 1]; return r; };
function combUnrank(rank, k) { const res = []; let x = 32; for (let i = k; i >= 1; i--) { while (x > 0 && C[x][i] > rank) x--; res.push(x); rank -= C[x][i]; x--; } return res.reverse(); }
const charOf = (t) => t === 0 ? 'w' : t === 1 ? 'W' : t === 2 ? 'b' : 'B';
const typeOf = (p) => isKingPiece(p) ? (colorOf(p) === WHITE ? 1 : 3) : (colorOf(p) === WHITE ? 0 : 2);

export function tbKey(state) {
  const parts = [];
  for (let i = 0; i < 64; i++) { const p = state.board[i]; if (p) parts.push(b2d[i] + ':' + typeOf(p)); }
  parts.sort((a, b) => (+a.slice(0, a.indexOf(':'))) - (+b.slice(0, b.indexOf(':'))));
  return state.turn + '|' + parts.join(',');
}
function encodeState(state, k) {
  const comb = [], types = [];
  for (let i = 0; i < 64; i++) { const p = state.board[i]; if (!p) continue; comb.push(b2d[i]); types.push(typeOf(p)); }
  if (comb.length !== k) return -1;
  let tm = 0; for (let i = 0; i < k; i++) tm = tm * 4 + types[i];
  return (combRank(comb) * (1 << (2 * k)) + tm) * 2 + (state.turn === WHITE ? 0 : 1);
}
function decodeIndex(idx, k) {
  const turn = (idx & 1) ? BLACK : WHITE;
  const t = idx >> 1, mod = 1 << (2 * k), tm = t % mod, cr = (t - tm) / mod;
  const comb = combUnrank(cr, k), board = new Array(64).fill(null);
  let x = tm; const types = new Array(k);
  for (let i = k - 1; i >= 0; i--) { types[i] = x & 3; x >>= 2; }
  for (let i = 0; i < k; i++) board[d2b[comb[i]]] = charOf(types[i]);
  return { board, turn, plies: 0 };
}
function validState(st) {
  let w = 0, b = 0;
  for (let i = 0; i < 64; i++) { const p = st.board[i]; if (!p) continue;
    if (!isKingPiece(p)) { const r = rankOf(i); if (colorOf(p) === WHITE) { if (r === 7) return false; w++; } else { if (r === 0) return false; b++; } }
    else colorOf(p) === WHITE ? w++ : b++; }
  return w > 0 && b > 0;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
export function tbValueToScore(v) { const s = Math.floor(v / 1000), d = v % 1000; if (s === 1) return 100000 - d; if (s === 2) return -(100000 - d); return 0; }

export class TBSolver {
  constructor(k, probe) { this.k = k; this.probe = probe; }
  async run(hooks = {}) {
    const k = this.k, S = C[32][k] * (1 << (2 * k)) * 2;
    const status = new Uint8Array(S), dist = new Uint16Array(S), rem = new Uint32Array(S);
    const succ = new Array(S), preds = new Array(S), queue = [];
    for (let idx = 0; idx < S; idx++) {                       // ── сбор графа ──
      if (idx % 40000 === 0) { hooks.onProgress?.(0.5 * idx / S, 'построение'); if (hooks.stop?.()) return null; await tick(); }
      const st = decodeIndex(idx, k);
      if (!validState(st)) { status[idx] = 4; continue; }
      const moves = getLegalMoves(st);
      if (!moves.length) { status[idx] = 2; queue.push(idx); continue; }
      const s = []; let remC = 0, win = false, wd = 0;
      for (const m of moves) {
        const ns = makeMove(st, m);
        let cnt = 0; for (const p of ns.board) if (p) cnt++;
        if (cnt < k) {
          const ev = this.probe(tbKey(ns));
          if (ev == null) { remC++; }
          else { const es = Math.floor(ev / 1000), ed = ev % 1000;
            if (es === 2) { win = true; wd = ed + 1; } else remC++; }
        } else { s.push(encodeState(ns, k)); remC++; }
      }
      succ[idx] = s; rem[idx] = remC;
      if (win) { status[idx] = 1; dist[idx] = wd; queue.push(idx); }
    }
    for (let p = 0; p < S; p++) { const s = succ[p]; if (!s) continue; for (const j of s) (preds[j] ??= []).push(p); }
    let qi = 0;                                               // ── распространение ──
    while (qi < queue.length) {
      const idx = queue[qi++];
      if (qi % 40000 === 0) { hooks.onProgress?.(0.5 + 0.4 * qi / S, 'распространение'); if (hooks.stop?.()) return null; await tick(); }
      const v = status[idx], d = dist[idx], pr = preds[idx];
      if (!pr) continue;
      for (const p of pr) {
        if (status[p]) continue;
        if (v === 2) { status[p] = 1; dist[p] = d + 1; queue.push(p); }
        else if (--rem[p] === 0) { status[p] = 2; dist[p] = d + 1; queue.push(p); }
      }
    }
    const flush = (arr) => hooks.onChunk?.(arr);             // ── сериализация чанками ──
    let buf = [];
    for (let idx = 0; idx < S; idx++) {
      if (status[idx] === 4) continue;
      if (!status[idx]) status[idx] = 3;
      buf.push([tbKey(decodeIndex(idx, k)), status[idx] * 1000 + Math.min(dist[idx], 999)]);
      if (buf.length >= 100000) { flush(buf); buf = []; await tick(); if (hooks.stop?.()) return null; }
    }
    if (buf.length) flush(buf);
    hooks.onProgress?.(1, 'готово');
    return true;
  }
}