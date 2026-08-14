/**
 * @module train-worker
 * Обучение весов оценки: на партиях библиотеки (перцептрон по парам ходов)
 * и в самоигре (усиление ходов победителя).
 */
import { getLegalMoves, makeMove, initialState, getGameStatus } from './engine.js';
import { phiWhite, WEIGHT_DEFAULTS, analyze } from './ai.js';

let W = { ...WEIGHT_DEFAULTS }, stop = false;
const tick = () => new Promise((r) => setTimeout(r, 0));
const clampW = (v) => Math.max(-40, Math.min(40, v));
const dot = (A) => { let s = 0; for (const k in W) s += W[k] * (A[k] || 0); return s; };
function nameToIdxLocal(s) {
  s = String(s || '').trim().toLowerCase();
  const f = s.charCodeAt(0) - 97, r = parseInt(s[1], 10) - 1;
  return (f >= 0 && f <= 7 && r >= 0 && r <= 7) ? r * 8 + f : -1;
}
function update(state, good, bad, eta) {
  const sign = state.turn === 'w' ? 1 : -1;
  const Ag = phiWhite(makeMove(state, good)), Ab = phiWhite(makeMove(state, bad));
  if (sign * dot(Ag) > sign * dot(Ab) + 20) return 0;
  for (const k in W) { const d = (Ag[k] || 0) - (Ab[k] || 0); if (d) W[k] = clampW(W[k] + eta * sign * d); }
  return 1;
}

/** Пары «лучший хуже» из топ-N ходов движка; обновляем веса, если мелкая оценка их не разделяет. */
function trainFromLines(state, lines, eta) {
  if (!lines || lines.length < 2) return 0;
  const sign = state.turn === 'w' ? 1 : -1;
  let ups = 0;
  const best = lines[0];
  // Порог снижен с 40 до 12 с.п. — учится даже на небольших различиях
  for (let k = 1; k < lines.length; k++) {
    const worse = lines[k];
    const gap = sign * (best.scoreWhite - worse.scoreWhite);
    if (gap > 12) ups += update(state, best.move, worse.move, eta);
  }
  return ups;
}

async function trainOnGame(g, eta) {
  let state = initialState(), ups = 0;
  for (let i = 0; i < g.moves.length; i++) {
    const sq = g.moves[i].toLowerCase().split(/[x:×-]/);
    const from = nameToIdxLocal(sq[0]), to = nameToIdxLocal(sq[sq.length - 1]);
    const moves = getLegalMoves(state);
    const good = moves.find((m) => m.from === from && m.to === to);
    if (!good) break;
    // Учимся на КАЖДОМ тихом ходе (было через 2) и берём топ-6 вместо топ-4
    if (moves.length > 1 && i >= 2 && !good.isCapture) {
      try {
        const r = analyze(state, { depth: 10, timeMs: 300, lines: 10});
        ups += trainFromLines(state, r.lines, eta);
      } catch (err) { console.warn('[train] analyze error in learn:', err); }
    }
    state = makeMove(state, good);
  }
  return ups;
}

async function selfPlay(n, eta) {
  let ups = 0;
  for (let g = 0; g < n; g++) {
    if (stop) break;
    const rec = []; let state = initialState(), winner = null;
    for (let ply = 0; ply < 100; ply++) {
      const st = getGameStatus(state);
      if (st.over) { winner = st.winner; break; }
      let mv = null;
      try {
        const r = analyze(state, { depth: 3, timeMs: 60, lines: 2 });
        // безопасный выбор хода: проверяем длину lines перед индексацией
        if (r.lines && r.lines.length > 0) {
          const idx = (r.lines.length > 1 && Math.random() < 0.2) ? 1 : 0;
          mv = r.lines[idx].move;
        }
      } catch (err) {
        console.warn('[train] analyze error:', err);
      }
      // фолбэк: если analyze не вернул ход, берём первый легальный
      if (!mv) {
        const moves = getLegalMoves(state);
        if (!moves.length) break;
        mv = moves[0];
      }
      rec.push({ board: state.board.slice(), turn: state.turn, move: mv });
      state = makeMove(state, mv);
    }
    if (winner) for (const r of rec) {
      if (r.turn !== winner) continue;   // тюним позиции победителя
      const st = { board: r.board, turn: r.turn, plies: 0 };
      try {
        const lines = analyze(st, { depth: 5, timeMs: 100, lines: 4 }).lines;
        ups += trainFromLines(st, lines, eta * 0.5);
      } catch (err) { console.warn('[train] analyze error in self:', err); }
    }
        
    self.postMessage({ progress: (g + 1) / n, phase: 'самоигра' });
    await tick();
  }
  return ups;
}
self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.cmd === 'pause') { stop = true; return; }
  stop = false;
  W = { ...WEIGHT_DEFAULTS, ...(d.weights || {}) };
  try {
    if (d.cmd === 'learn') {
      let ups = 0;
      for (let i = 0; i < d.games.length; i++) {
        if (stop) break;
        ups += await trainOnGame(d.games[i], d.eta || 0.02);
        if (i % 20 === 0) { self.postMessage({ progress: i / d.games.length, phase: 'обучение' }); await tick(); }
      }
      self.postMessage({ weights: { ...W }, done: true, ups });
    }
    if (d.cmd === 'self') {
      self.postMessage({ progress: 0, phase: 'самоигра' });
      const ups = await selfPlay(d.n || 6, d.eta || 0.01);
      self.postMessage({ weights: { ...W }, done: true, ups });
    }
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
self.postMessage({ ready: true });