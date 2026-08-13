/**
 * @module ai
 * Движок русских шашек, уровень 6.
 * Оценка: материал + мобильность + связность/изоляция/запертость + аванпосты +
 *         анти-разменный bias + ничейная шкала + эндшпильные знания +
 *         гашение чисто-дамочных окончаний.
 * Поиск: PVS + TT(границы+TT-ход) + killer + history + LMR + null-move + futility +
 *        quiescence + детектор повторов + ПРАВИЛО НИЧЬЕЙ ПО ТИХИМ ХОДАМ (30) +
 *        итеративное углубление с aspiration + ЭНДШПИЛЬ-ОРАКУЛ (≤4–6 фигур).
 * Знания (extra: book/stats) влияют на порядок ходов в корне.
 */
import { WHITE, getLegalMoves, makeMove, getGameStatus, colorOf, isKingPiece, fileOf, rankOf, moveToString, stateToFEN } from './engine.js';

const MAN = 100, KING = 330, MATE = 100000, QDEPTH = 4, QUIET_DRAW = 30;
let nodes = 0, deadline = 0;
const tt = new Map();
const hist = new Map();
let killers = [];
const pathMap = new Map();

const centerish = (i) => { const f = fileOf(i), r = rankOf(i); return f >= 2 && f <= 5 && r >= 2 && r <= 5; };
const longDiag = (i) => fileOf(i) === rankOf(i) || fileOf(i) + rankOf(i) === 7;
const inB = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
let boardRef = null;
function friendlyAt(f, r, color) { return inB(f, r) && boardRef[r * 8 + f] && colorOf(boardRef[r * 8 + f]) === color; }
function pieceCount(state) { let t = 0; for (const p of state.board) if (p) t++; return t; }

/** Оценка с позиции белых. */
export function evaluate(state) {
  boardRef = state.board;
  let s = 0, total = 0, wMen = 0, bMen = 0, wK = 0, bK = 0, matW = 0;
  for (let i = 0; i < 64; i++) {
    const p = state.board[i]; if (!p) continue; total++;
    const f = fileOf(i), r = rankOf(i), w = colorOf(p) === WHITE, adv = w ? r : 7 - r;
    if (isKingPiece(p)) {
      w ? wK++ : bK++;
      matW += w ? KING : -KING;
      let v = KING + (centerish(i) ? 10 : 0) + (longDiag(i) ? 12 : 0) + (total <= 8 ? 40 : 0);
      s += w ? v : -v;
    } else {
      w ? wMen++ : bMen++;
      matW += w ? MAN : -MAN;
      let v = MAN + adv * 5 + (centerish(i) ? 8 : 0);
      if (total > 10 && adv === 0) v += 4;
      if (total <= 8) v += adv * 2;
      const bd = w ? -1 : 1;
      const sup = friendlyAt(f - 1, r + bd, w ? WHITE : 'b') || friendlyAt(f + 1, r + bd, w ? WHITE : 'b');
      const anyNb = sup || friendlyAt(f - 1, r - bd, w ? WHITE : 'b') || friendlyAt(f + 1, r - bd, w ? WHITE : 'b');
      if (sup) v += 4; else if (!anyNb) v -= 6;
      const fw = w ? 1 : -1;
      if (friendlyAt(f - 1, r + fw, w ? WHITE : 'b') && friendlyAt(f + 1, r + fw, w ? WHITE : 'b')) v -= 6;
      if (centerish(i) && adv >= 4) v += 6;
      s += w ? v : -v;
    }
  }
  const totalMen = wMen + bMen;
  if (matW > 0) s += totalMen * 3; else if (matW < 0) s -= totalMen * 3;
  if (total <= 6 && Math.abs(matW) <= MAN) s = Math.round(s * 0.6);
  // чисто-дамочный эндшпиль: гасим оценку, если нет решающего перевеса по дамка
  if (totalMen === 0) {
    const kd = Math.abs(wK - bK);
    const cap = kd >= 2 ? 300 : 60;
    s = Math.sign(s) * Math.min(Math.abs(s), cap);
  }
  s += endgameKnowledge(total, matW, wMen, bMen, wK, bK);
  const mob = getLegalMoves(state).length;
  s += (state.turn === WHITE ? 1 : -1) * mob * 2;
  return s;
}
function endgameKnowledge(total, matW, wMen, bMen, wK, bK) {
  if (total > 6) return 0;
  let b = 0;
  b += Math.sign(matW) * Math.min(Math.abs(matW), 400) * 0.15;
  if (wK >= 1 && bK === 0 && bMen >= 1 && wMen === 0) b += 120;
  if (bK >= 1 && wK === 0 && wMen >= 1 && bMen === 0) b -= 120;
  if (wK >= 2 && bK === 1 && wMen === 0 && bMen === 0) b += 200;
  if (bK >= 2 && wK === 1 && bMen === 0 && wMen === 0) b -= 200;
  b += (wK - bK) * 15;
  return b;
}
const evalForSide = (state) => (state.turn === WHITE ? 1 : -1) * evaluate(state);

function qsearch(state, qd, alpha, beta) {
  nodes++;
  if ((nodes & 127) === 0 && Date.now() > deadline) throw 0;
  const stand = evalForSide(state);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  if (qd <= 0) return alpha;
  const caps = getLegalMoves(state).filter((m) => m.isCapture);
  if (!caps.length) return alpha;
  for (const m of caps) {
    const v = -qsearch(makeMove(state, m), qd - 1, -beta, -alpha);
    if (v > alpha) alpha = v;
    if (alpha >= beta) return beta;
  }
  return alpha;
}

function orderMoves(moves, ttMove, ply) {
  const k = killers[ply] || [];
  for (const m of moves) {
    const key = m.from * 64 + m.to;
    m._s = (m === ttMove ? 1e9 : 0)
      + (m.isCapture ? 1e6 + (m.captures?.length || 0) * 1000 : 0)
      + (k.includes(key) ? 1e5 : 0)
      + (hist.get(key) || 0);
  }
  moves.sort((a, b) => b._s - a._s);
}

/** quiet — полуходы без взятий и ходов шашек; >= QUIET_DRAW → ничья. */
function pvs(state, depth, alpha, beta, ply, quiet) {
  nodes++;
  if ((nodes & 127) === 0 && Date.now() > deadline) throw 0;
  if (getGameStatus(state).over) return -(MATE + depth);
  if (quiet >= QUIET_DRAW) return 0;
  const key = stateToFEN(state);
  const seen = pathMap.get(key) || 0;
  if (seen >= 1) return 0;
  pathMap.set(key, seen + 1);
  try {
    const e = tt.get(key); let ttMove = null;
    if (e) {
      ttMove = e.best;
      if (e.depth >= depth) {
        if (e.flag === 0) return e.score;
        if (e.flag === 1 && e.score > alpha) alpha = e.score;
        if (e.flag === 2 && e.score < beta) beta = e.score;
        if (alpha >= beta) return e.score;
      }
    }
    if (depth <= 0) return qsearch(state, QDEPTH, alpha, beta);
    const total = pieceCount(state);
    const movesAll = getLegalMoves(state);
    const forcedCap = movesAll.length && movesAll[0].isCapture;
    if (depth >= 3 && !forcedCap && total > 6 && ply > 0) {
      const ns = { board: state.board, turn: state.turn === WHITE ? 'b' : 'w', plies: state.plies + 1 };
      const v = -pvs(ns, depth - 3, -beta, -beta + 1, ply + 1, quiet + 1);
      if (v >= beta) return beta;
    }
    orderMoves(movesAll, ttMove, ply);
    const a0 = alpha; let best = -Infinity, bestMove = movesAll[0];
    const futility = depth <= 2 && total > 6 && !forcedCap && evalForSide(state) + 150 < alpha;
    let legal = 0;
    for (let i = 0; i < movesAll.length; i++) {
      const m = movesAll[i];
      if (futility && !m.isCapture && i >= 4) continue;
      legal++;
      const manMoved = !isKingPiece(state.board[m.from]);
      const nq = (m.isCapture || manMoved) ? 0 : quiet + 1;
      let d = depth - 1;
      if (i >= 4 && depth >= 3 && !m.isCapture) d -= 1;
      let v;
      if (legal === 1) v = -pvs(makeMove(state, m), d, -beta, -alpha, ply + 1, nq);
      else {
        v = -pvs(makeMove(state, m), d, -alpha - 1, -alpha, ply + 1, nq);
        if (v > alpha && v < beta) v = -pvs(makeMove(state, m), depth - 1, -beta, -alpha, ply + 1, nq);
      }
      if (v > best) { best = v; bestMove = m; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) {
        if (!m.isCapture) {
          const key2 = m.from * 64 + m.to;
          hist.set(key2, (hist.get(key2) || 0) + depth * depth);
          const kk = (killers[ply] ??= []);
          if (kk[0] !== key2) { kk[1] = kk[0]; kk[0] = key2; }
        }
        break;
      }
    }
    const flag = best <= a0 ? 2 : (best >= beta ? 1 : 0);
    tt.set(key, { depth, score: best, flag, best: bestMove });
    return best;
  } finally {
    pathMap.set(key, (pathMap.get(key) || 1) - 1);
  }
}

function orderRoot(moves, extra, priorMap) {
  const book = new Set((extra?.book || []).map((b) => b.from + '-' + b.to));
  const stat = new Map((extra?.stats || []).map((s) => [s.from + '-' + s.to, s]));
  for (const m of moves) {
    const ab = book.has(m.from + '-' + m.to) ? 1 : 0;
    const as = stat.get(m.from + '-' + m.to);
    const pr = priorMap ? (priorMap.get(m.from * 64 + m.to) ?? -1e8) : 0;
    m._s = pr * 1e2 + ab * 1e7 + (as ? (as.w / as.total) * 1e5 : 0) + (m.isCapture ? 1e3 : 0);
  }
  moves.sort((a, b) => b._s - a._s);
}

function searchRoot(state, depth, extra, priorMap, alpha = -Infinity, beta = Infinity) {
  const a0 = alpha, b0 = beta;
  const moves = getLegalMoves(state);
  orderRoot(moves, extra, priorMap);
  const res = []; let aborted = false, best = -Infinity;
  for (const m of moves) {
    let v;
    try { v = -pvs(makeMove(state, m), depth - 1, -beta, -alpha, 1, 0); }
    catch { aborted = true; v = -evalForSide(makeMove(state, m)); }
    res.push({ move: m, score: v });
    if (!aborted && v > best) best = v;
    if (!aborted && v > alpha) alpha = v;
    if (aborted) break;
  }
  res.sort((a, b) => b.score - a.score);
  return { res, best, aborted, failLow: !aborted && a0 > -Infinity && best <= a0, failHigh: !aborted && b0 < Infinity && best >= b0 };
}

function pvLine(state, first, depth) {
  const pv = [moveToString(first)];
  let cur = makeMove(state, first);
  for (let i = 0; i < 5; i++) {
    if (getGameStatus(cur).over) break;
    deadline = Math.max(deadline, Date.now() + 120);
    const r = searchRoot(cur, Math.max(2, depth - 2), null, null);
    if (!r.res.length) break;
    pv.push(moveToString(r.res[0].move));
    cur = makeMove(cur, r.res[0].move);
  }
  return pv.join(' ');
}

/** Итеративное углубление + aspiration; эндшпиль-оракул при малом числе фигур. */
export function analyze(state, { maxDepth = 10, timeMs = 1200 } = {}, extra = null) {
  const st = getGameStatus(state);
  if (st.over) return { over: true, winner: st.winner, scoreWhite: st.winner === null ? 0 : (st.winner === WHITE ? 999 : -999), lines: [], depth: 0, nodes: 0 };
  tt.clear(); hist.clear(); killers = []; pathMap.clear();
  const total = pieceCount(state);
  const top = Math.min((maxDepth || 10) + (total <= 6 ? 6 : 0) + (total <= 4 ? 6 : 0), 30);
  const budget = timeMs + (total <= 6 ? 500 : 0) + (total <= 4 ? 700 : 0);
  let prev = 0, res = null, finalDepth = 0, prior = null;
  for (let d = 2; d <= top; d += 2) {
    nodes = 0; deadline = Date.now() + budget;
    const priorMap = prior ? new Map(prior.map((r) => [r.move.from * 64 + r.move.to, r.score])) : null;
    let win = 60, out = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      out = searchRoot(state, d, extra, priorMap, prev - win, prev + win);
      if (out.aborted) break;
      if (out.failLow) out = searchRoot(state, d, extra, priorMap, -Infinity, prev + win);
      else if (out.failHigh) out = searchRoot(state, d, extra, priorMap, prev - win, Infinity);
      if (!out.failLow && !out.failHigh) break;
      win *= 4;
    }
    if (out && !out.aborted && out.res.length) { res = out.res; finalDepth = d; prior = out.res; prev = out.best; }
    if (Date.now() > deadline || (out && out.aborted)) break;
  }
  if (!res) res = searchRoot(state, 2, extra, null).res;
  const toWhite = state.turn === WHITE ? (x) => x : (x) => -x;
  return {
    over: false,
    scoreWhite: toWhite(res[0]?.score ?? 0),
    lines: res.slice(0, 3).map((r) => ({ san: moveToString(r.move), move: r.move, scoreWhite: toWhite(r.score), pv: pvLine(state, r.move, 4) })),
    depth: finalDepth, nodes,
  };
}

export function gradeMove(before, after, { depth = 6, timeMs = 700 } = {}) {
  tt.clear(); hist.clear(); killers = []; pathMap.clear(); nodes = 0; deadline = Date.now() + timeMs;
  const b = searchRoot(before, depth, null, null);
  const best = b.res?.[0]?.score ?? 0, bestSan = b.res?.[0] ? moveToString(b.res[0].move) : '';
  tt.clear(); hist.clear(); killers = []; pathMap.clear(); nodes = 0; deadline = Date.now() + timeMs;
  const a = searchRoot(after, depth, null, null);
  const played = -(a.res?.[0]?.score ?? 0);
  const isMate = (s) => Math.abs(s) > 90000;
  let loss;
  if (isMate(best) || isMate(played)) {
    if (isMate(best) && isMate(played) && Math.sign(best) === Math.sign(played)) loss = 0;
    else if (isMate(best) && !isMate(played)) loss = 400;
    else if (!isMate(best) && isMate(played)) loss = 0;
    else loss = Math.sign(best) !== Math.sign(played) ? 400 : 0;
  } else loss = best - played;
  let label, cls;
  if (loss <= 15) { label = 'сильный ход'; cls = 'good'; }
  else if (loss <= 40) { label = 'нормальный ход'; cls = 'ok'; }
  else if (loss <= 90) { label = 'слабый ход'; cls = 'bad'; }
  else { label = 'зевок'; cls = 'blunder'; }
  return { loss, label, cls, bestSan };
}