/**
 * @module ai
 * Локальный движок русских шашек — версия с обучаемой оценкой.
 * Оценка = фиксированная часть (материал, эндшпильные знания) + Σ W[k]·признак[k].
 * Веса W обучаются на партиях библиотеки / в самоигре (train-worker.js).
 * Поиск: PVS + TT + killer + history + LMR + futility + quiescence +
 *        тактические расширения + расширение единственного ответа + повторы +
 *        правило тихих ходов + постоянный кеш окончаний (≤5 фигур) +
 *        итеративное углубление с полным бюджетом времени.
 * Знания: книга (+20) и авто-книга по очковости баз — мягкий приор рекомендаций.
 */
import {
  WHITE, BLACK, getLegalMoves, makeMove, getGameStatus,
  colorOf, isKingPiece, isManPiece, fileOf, rankOf, moveToString, stateToFEN,
} from './engine.js';
import { tbKey, tbValueToScore } from './tb.js';

const MAN = 100, KING = 330, MATE = 100000, QDEPTH = 4, QUIET_DRAW = 30, TT_MAX = 300000, EG_MAX = 300000;
let nodes = 0, deadline = 0;
const tt = new Map();
const hist = new Map();
let killers = [];
const pathMap = new Map();
const egCache = new Map();

const sq = (f, r) => r * 8 + f;
const centerish = (i) => { const f = fileOf(i), r = rankOf(i); return f >= 2 && f <= 5 && r >= 2 && r <= 5; };
const longDiag = (i) => fileOf(i) === rankOf(i) || fileOf(i) + rankOf(i) === 7;
const inB = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;

/* ── таблицы ценности полей (теория русских шашек) ── */
const GOLD_W = new Set([sq(3, 3), sq(5, 3), sq(2, 4), sq(4, 4)]);
const CENTER_W = new Set([sq(2, 2), sq(4, 2), sq(3, 1), sq(5, 1)]);
const GOLD_B = new Set([sq(3, 4), sq(5, 4), sq(2, 3), sq(4, 3)]);
const CENTER_B = new Set([sq(2, 5), sq(4, 5), sq(3, 6), sq(5, 6)]);
const BACKWARD_W = new Set([sq(0, 0), sq(7, 1)]);
const BACKWARD_B = new Set([sq(7, 7), sq(0, 6)]);

let TB = null;
export function setTablebase(map) { TB = map; }

/* ── обучаемые веса оценки ──
   Значения по умолчанию дают поведение, идентичное прежней evaluate().
   При обучении меняются только позиционные признаки; материал (MAN/KING) остаётся фиксированным. */
export const WEIGHT_DEFAULTS = {
  adv: 3, gold: 12, center: 6, edge: -6, backward: -3,
  support: 4, isolated: -6, column: 4, bridge: 3, kol: 8, outpost: 6,
  passedEarly: 5, passedLate: 12, mobility: 2, development: 2,
  frozen: 6,    // связанные/запертые шашки соперника — хорошо
  mobDiff: 1,   // перевес по мобильности (цугцванг-прокси) — хорошо
};

let W = { ...WEIGHT_DEFAULTS };
export function setWeights(w) { W = { ...WEIGHT_DEFAULTS, ...(w || {}) }; }
export function getWeights() { return { ...W }; }

let boardRef = null;
function friendlyAt(f, r, color) { return inB(f, r) && boardRef[r * 8 + f] && colorOf(boardRef[r * 8 + f]) === color; }
function pieceCount(state) { let t = 0; for (const p of state.board) if (p) t++; return t; }

function passedMan(state, i, w) {
  const f = fileOf(i), r = rankOf(i), step = w ? 1 : -1, enemy = w ? BLACK : WHITE;
  for (const df of [-1, 1]) {
    let nf = f + df, nr = r + step;
    while (inB(nf, nr)) {
      const p = state.board[nr * 8 + nf];
      if (p && colorOf(p) === enemy && isManPiece(p)) return false;
      nf += df; nr += step;
    }
  }
  return true;
}

/** true, если у простой шашки цвета w на i нет ни тихого хода, ни взятия (связана/заперта). */
function hasAnyMove(state, i, w) {
  const f = fileOf(i), r = rankOf(i), dir = w ? 1 : -1, me = w ? WHITE : BLACK;
  for (const df of [-1, 1]) {                       // тихие ходы вперёд
    const nf = f + df, nr = r + dir;
    if (inB(nf, nr) && !state.board[nr * 8 + nf]) return true;
  }
  for (const [df, dr] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {   // взятия во все стороны
    const nf = f + df, nr = r + dr, bf = f + 2 * df, br = r + 2 * dr;
    if (!inB(nf, nr) || !inB(bf, br)) continue;
    const p = state.board[nr * 8 + nf];
    if (p && colorOf(p) !== me && !state.board[br * 8 + bf]) return true;
  }
  return false;
}

function materialSide(state) {
  let s = 0;
  for (const p of state.board) if (p) { const v = isKingPiece(p) ? KING : MAN; s += colorOf(p) === WHITE ? v : -v; }
  return (state.turn === WHITE ? 1 : -1) * s;
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

/** Вычисляет агрегаты признаков и фиксированную часть оценки. */
function computeAggs(state) {
  boardRef = state.board;
  let fixed = 0, total = 0, wMen = 0, bMen = 0, wK = 0, bK = 0, matW = 0;
  const A = {
    adv: 0, gold: 0, center: 0, edge: 0, backward: 0,
    support: 0, isolated: 0, column: 0, bridge: 0, kol: 0, outpost: 0,
    passedEarly: 0, passedLate: 0, mobility: 0, development: 0, 
    frozen: 0, mobDiff: 0,
  };
  for (let i = 0; i < 64; i++) {
    const p = state.board[i]; if (!p) continue; total++;
    const f = fileOf(i), r = rankOf(i), w = colorOf(p) === WHITE, adv = w ? r : 7 - r;
    const sgn = w ? 1 : -1, col = w ? WHITE : BLACK;
    if (isKingPiece(p)) {
      w ? wK++ : bK++;
      matW += w ? KING : -KING;
      fixed += sgn * (KING + (centerish(i) ? 10 : 0) + (longDiag(i) ? 12 : 0) + (total <= 8 ? 40 : 0));
    } else {
      w ? wMen++ : bMen++;
      matW += w ? MAN : -MAN;
      fixed += sgn * MAN;
      A.adv += sgn * adv;
      if (w ? GOLD_W.has(i) : GOLD_B.has(i)) A.gold += sgn;
      else if (w ? CENTER_W.has(i) : CENTER_B.has(i)) A.center += sgn;
      if (f === 0 || f === 7) A.edge += sgn;
      if ((w ? BACKWARD_W.has(i) : BACKWARD_B.has(i)) && total > 16) A.backward += sgn;
      const bd = w ? -1 : 1;
      const sup = friendlyAt(f - 1, r + bd, col) || friendlyAt(f + 1, r + bd, col);
      const anyNb = sup || friendlyAt(f - 1, r - bd, col) || friendlyAt(f + 1, r - bd, col);
      if (sup) A.support += sgn; else if (!anyNb) A.isolated += sgn;
      const dir = w ? 1 : -1;
      if (friendlyAt(f + 1, r + dir, col) && friendlyAt(f + 2, r + 2 * dir, col)) A.column += sgn;
      if (total > 16 && (w ? (i === 0 || i === 9) : (i === 63 || i === 62))) A.bridge += sgn;
      if ((w && (i === 34 || i === 37) && sup) || (!w && (i === 26 || i === 29) && sup)) A.kol += sgn;
      if (centerish(i) && adv >= 4) A.outpost += sgn;
      if (total <= 12 && passedMan(state, i, w)) {
        if (total <= 8) A.passedLate += sgn; else A.passedEarly += sgn;
      }
      if (!hasAnyMove(state, i, w)) A.frozen += w ? -1 : 1;  // своя запертая — плохо, чужая — хорошо    }
  }
  const totalMen = wMen + bMen;
  if (matW > 0) fixed += totalMen * 3; else if (matW < 0) fixed -= totalMen * 3;

  const mobSide = getLegalMoves(state).length;
  A.mobility = (state.turn === WHITE ? 1 : -1) * mobSide;
  if (total <= 16) {
    const other = state.turn === WHITE ? BLACK : WHITE;
    const mobOther = getLegalMoves({ ...state, turn: other }).length;
    const mobW = state.turn === WHITE ? mobSide : mobOther;
    const mobB = state.turn === WHITE ? mobOther : mobSide;
    A.mobDiff = mobW - mobB;   // у кого больше ходов, тот реже попадает в цугцванг
  }
    
  A.mobility = (state.turn === WHITE ? 1 : -1) * getLegalMoves(state).length;
  if (total > 18) {
    let dev = 0;
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (p && !isKingPiece(p)) {
        const r = rankOf(i);
        if (colorOf(p) === WHITE) dev += r >= 2 ? 1 : 0; else dev -= r <= 5 ? 1 : 0;
      }
    }
    A.development = dev;
  }
  return { A, fixed, total, totalMen, matW, wK, bK, wMen, bMen };
}}

/** Вектор признаков с позиции белых — для обучающего воркера. */
export function phiWhite(state) { return computeAggs(state).A; }

/** Оценка с позиции белых. */
export function evaluate(state) {
  const { A, fixed, total, totalMen, matW, wK, bK, wMen, bMen } = computeAggs(state);
  let base = fixed;
  for (const k in W) base += W[k] * (A[k] || 0);
  if (total <= 6 && Math.abs(matW) <= MAN) base = Math.round(base * 0.6);
  if (totalMen === 0) {
    const kd = Math.abs(wK - bK);
    base = Math.sign(base) * Math.min(Math.abs(base), kd >= 2 ? 300 : 60);
  }
  base += endgameKnowledge(total, matW, wMen, bMen, wK, bK);
  return base;
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

function pvs(state, depth, alpha, beta, ply, quiet) {
  nodes++;
  if ((nodes & 127) === 0 && Date.now() > deadline) throw 0;
  if (getGameStatus(state).over) return -(MATE + depth) + materialSide(state) * 0.001;
  if (quiet >= QUIET_DRAW) return 0;
  const key = stateToFEN(state);
  const seen = pathMap.get(key) || 0;
  if (seen >= 1) return 0;
  pathMap.set(key, seen + 1);
  try {
    if (TB) { const tv = TB.get(tbKey(state)); if (tv !== undefined) return tbValueToScore(tv); }
    const total = pieceCount(state);
    if (total <= 5) { const c = egCache.get(key); if (c !== undefined) return c; }
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
    const movesAll = getLegalMoves(state);
    if (movesAll.length === 1 && ply > 0 && depth < 26) depth += 1;
    if (depth <= 0) return qsearch(state, QDEPTH, alpha, beta);
    orderMoves(movesAll, ttMove, ply);
    const a0 = alpha; let best = -Infinity, bestMove = movesAll[0];
    const futility = depth <= 2 && total > 6 && !movesAll[0].isCapture && evalForSide(state) + 150 < alpha;
    let legal = 0;
    for (let i = 0; i < movesAll.length; i++) {
      const m = movesAll[i];
      if (futility && !m.isCapture && i >= 4) continue;
      legal++;
      const piece = state.board[m.from];
      const promotes = m.king && isManPiece(piece);
      const manMoved = !m.isCapture && isManPiece(piece);
      const nq = (m.isCapture || manMoved) ? 0 : quiet + 1;
      const ext = (m.isCapture || promotes) ? 1 : 0;
      let d = depth - 1 + ext;
      if (d > depth) d = depth;
      if (i >= 4 && depth >= 3 && !m.isCapture && !promotes) d -= 1;
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
    if (total <= 5 && depth >= 6) {
      if (egCache.size > EG_MAX) egCache.clear();
      egCache.set(key, best);
    }
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

function knowledgeBonus(m, extra) {
  if (!extra) return 0;
  let b = 0;
  if ((extra.book || []).some((x) => x.from === m.from && x.to === m.to)) b += 20;
  const s = (extra.stats || []).find((x) => x.from === m.from && x.to === m.to);
  if (s && s.total >= 3) {
    const qual = (s.w + 0.5 * s.d) / s.total;
    const pop = Math.log2(1 + s.total);
    const conf = Math.min(1, s.total / 50);
    b += Math.round(pop * qual * 8 * conf);
  }
  return b;
}

export function analyze(state, { depth, maxDepth, timeMs = 1200, lines = 8 } = {}, extra = null) {
  const t0 = Date.now();
  const st = getGameStatus(state);
  if (st.over) return { over: true, winner: st.winner, scoreWhite: st.winner === null ? 0 : (st.winner === WHITE ? 999 : -999), lines: [], depth: 0, nodes: 0 };
  if (tt.size > TT_MAX) tt.clear();
  const total = pieceCount(state);
  const top = Math.min((maxDepth || (depth ? depth + 4 : 12)) + (total <= 6 ? 4 : 0) + (total <= 4 ? 4 : 0), 34);
  const budget = timeMs;
  let res = null, finalDepth = 0, prior = null, totalNodes = 0;
  for (let d = 2; d <= top; d += 2) {
    nodes = 0;
    deadline = Date.now() + Math.max(150, budget - (Date.now() - t0));
    const priorMap = prior ? new Map(prior.map((r) => [r.move.from * 64 + r.move.to, r.score])) : null;
    const out = searchRoot(state, d, extra, priorMap);
    totalNodes += nodes;
    if (!out.aborted && out.res.length) { res = out.res; finalDepth = d; prior = out.res; }
    if (out.aborted || (Date.now() - t0) >= budget) break;
  }
  if (!res) { res = searchRoot(state, 2, extra, null).res; totalNodes += nodes; }
  const toWhite = state.turn === WHITE ? (x) => x : (x) => -x;
  for (const r of res) {
    r.raw = toWhite(r.score);
    if (extra) r.score += knowledgeBonus(r.move, extra);
  }
  res.sort((a, b) => b.score - a.score);
  const L = Math.max(3, lines | 0);
  return {
    over: false,
    scoreWhite: res[0].raw,
    lines: res.slice(0, L).map((r) => ({ san: moveToString(r.move), move: r.move, scoreWhite: r.raw, pv: pvLine(state, r.move, 4) })),
    depth: finalDepth, nodes: totalNodes,
  };
}

export function gradeMove(before, after, { depth = 6, timeMs = 700 } = {}) {
  const opts = { depth, timeMs };
  const b = analyze(before, opts, null);
  const a = analyze(after, opts, null);
  const sB = b.scoreWhite, sA = a.scoreWhite;
  const isMateS = (x) => Math.abs(x) > 90000;
  const moverWin = (x) => before.turn === WHITE ? x > 90000 : x < -90000;
  let loss;
  if (isMateS(sB) || isMateS(sA)) loss = (moverWin(sB) && !moverWin(sA)) ? 400 : 0;
  else loss = before.turn === WHITE ? (sB - sA) : (sA - sB);
  loss = Math.max(0, Math.round(loss));
  const bestSan = b.lines?.[0]?.san || '';
  let label, cls;
  if (loss <= 15) { label = 'сильный ход'; cls = 'good'; }
  else if (loss <= 40) { label = 'нормальный ход'; cls = 'ok'; }
  else if (loss <= 90) { label = 'слабый ход'; cls = 'bad'; }
  else { label = 'зевок'; cls = 'blunder'; }
  return { loss, label, cls, bestSan };
}