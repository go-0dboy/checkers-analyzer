/**
 * @module main
 * Точка входа и оркестратор. Склеивает слои:
 *   engine (правила) · board (отрисовка/ввод) · history (дерево/нотация) ·
 *   pdn (чтение/запись) · storage (файлы/настройки) · themes/toast/export (UI-утилиты).
 *
 * main.js НЕ содержит правил и НЕ рисует сам — он держит режимы (analyze/setup),
 * мутабельное состояние UI (выбор, подсказки, незавершённая серия взятий, теги),
 * синхронизирует панели и маршрутизирует действия меню/клавиатуры.
 *
 * Режимы:
 *   analyze — разбор партии: доска + плашки + нотация + афиша метаданных;
 *   setup   — расстановка: доска-холст + палитра фигур + FEN-плашка + паспорт тегов.
 */

import {
  WHITE, BLACK, opposite,
  initialState, createState, cloneState,
  getLegalMoves, getMovesForPiece, getJumpSteps,
  getGameStatus, hasMandatoryCapture,
  colorOf, isKingPiece, pieceChar, moveToString, isDarkSquare,
  sepForGameType, setCaptureSep, stateToFEN, SIZE, rankOf,
} from './engine.js';
import { BoardUI } from './board.js';
import { GameHistory } from './history.js';
import { parsePDN, generatePDN, formatDate, detectResult } from './pdn.js';
import {
  pickAndReadFile, downloadText, copyTextToClipboard, readTextFromClipboard,
  suggestFilename, loadPrefs, savePrefs,
} from './storage.js';
import { THEME_IDS, BOARD_IDS, bindThemePickers, updateThemeMenu, updateBoardMenu, closeThemeMenu, closeBoardMenu } from './themes.js';
import { showToast } from './toast.js';
import { saveSetupSVG } from './export.js';

const $ = (sel) => document.querySelector(sel);

const boardUI = new BoardUI({
  boardEl: $('#board'),
  frameEl: $('#board-frame'),
  coords: {
    top:    document.querySelector('[data-coords="files-top"]'),
    bottom: document.querySelector('[data-coords="files-bottom"]'),
    left:   document.querySelector('[data-coords="ranks-left"]'),
    right:  document.querySelector('[data-coords="ranks-right"]'),
  },
});

const history = new GameHistory({ container: $('#movelist') });

/* ── мутабельное состояние UI ────────────────────────────────────── */
let mode = 'analyze';          // 'analyze' | 'setup'
let selected = null;           // индекс выбранной фигуры (для тихих ходов)
let activeHints = null;        // подсветки ходов выбранной фигуры
let pending = null;            // незавершённая серия взятий (пошаговый ввод)
let gameHeaders = {};          // теги PDN текущей партии
let pendingSave = null;        // канал сохранения: 'file' | 'clip'
let headersSnapshot = null;    // снимок тегов на входе в расстановку (для «Отмены»)

let setupBoard = null;         // доска-холст расстановки
let setupTurn = WHITE;         // очередь хода в расстановке
let activeTool = 'w';          // активный инструмент палитры

/* ── утилиты ─────────────────────────────────────────────────────── */
const plural = (n, [one, few, many]) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escPre = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const isReal = (v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '?';

function countPieces(state, color) {
  let men = 0, kings = 0;
  for (const p of state.board) if (p && colorOf(p) === color) (isKingPiece(p) ? kings++ : men++);
  return { men, kings };
}
function lostPieces(rootState, state, color) {
  const r = countPieces(rootState, color), c = countPieces(state, color);
  const total = Math.max(0, (r.men + r.kings) - (c.men + c.kings));
  const kings = Math.min(total, Math.max(0, r.kings - c.kings));
  return { total, kings };
}

/* ── центральный цикл синхронизации ──────────────────────────────── */
history.onChange = () => { selected = null; activeHints = null; pending = null; sync(); };

function sync() {
  applyModeVisibility();
  if (mode === 'setup') { syncSetup(); return; }
  const state = history.currentState;
  const status = getGameStatus(state);
  selected = null; activeHints = null; pending = null;
  renderAnalyze(history.lastMove);
  syncNav();
  syncPlayerBars();
  $('#board').classList.toggle('game-over', status.over);
}

function renderAnalyze(lastMove = history.lastMove) {
  const state = history.currentState;
  const status = getGameStatus(state);
  const legal = status.over ? [] : getLegalMoves(state);
  boardUI.render(state, { lastMove, selected, hints: activeHints, movable: new Set(legal.map((m) => m.from)) });
}

function syncNav() {
  const inSetup = mode === 'setup';
  $('#btn-start').disabled = inSetup || !history.canBack;
  $('#btn-prev').disabled  = inSetup || !history.canBack;
  $('#btn-next').disabled  = inSetup || !history.canForward;
  $('#btn-end').disabled   = inSetup || !history.canForward;
  const cbtn = $('#btn-comment');
  if (cbtn) cbtn.disabled = inSetup || history.current === history.root;
}

/** Видимость панелей по режиму. */
function applyModeVisibility() {
  const setup = mode === 'setup';
  $('#setup-panel').hidden      = !setup;
  $('#setup-meta-panel').hidden = !setup;
  $('#meta-panel').hidden       = setup;
  $('#notation-panel').hidden   = setup;
  $('#player-top').hidden       = setup;
  $('#player-bottom').hidden    = setup;
  $('#controls').hidden         = setup;
}

/* ── плашки игроков ──────────────────────────────────────────────── */
function syncPlayerBars() {
  const inSetup = mode === 'setup';
  const state = inSetup ? { board: setupBoard, turn: setupTurn, plies: 0 } : history.currentState;
  const rootState = history.root.state;
  const status = inSetup ? { over: false, winner: null, reason: null } : getGameStatus(state);
  const mustCapture = !inSetup && !status.over && hasMandatoryCapture(state);
  const topColor = boardUI.flipped ? WHITE : BLACK, botColor = opposite(topColor);
  configureBar($('#player-top'), topColor, state, rootState, { over: status.over, winner: status.winner, reason: status.reason, active: !inSetup && !status.over && state.turn === topColor, mustCapture: mustCapture && state.turn === topColor });
  configureBar($('#player-bottom'), botColor, state, rootState, { over: status.over, winner: status.winner, reason: status.reason, active: !inSetup && !status.over && state.turn === botColor, mustCapture: mustCapture && state.turn === botColor });
}

function configureBar(barEl, color, state, rootState, ctx) {
  barEl.querySelector('.player-disc').className = 'player-disc ' + (color === WHITE ? 'disc-white' : 'disc-black');
  barEl.querySelector('.player-name').textContent = color === WHITE ? 'Белые' : 'Чёрные';
  const { men, kings } = countPieces(state, color);
  barEl.querySelector('.player-meta').textContent = `${men} ${plural(men, ['шашка', 'шашки', 'шашек'])} · ${kings} ${plural(kings, ['дамка', 'дамки', 'дамок'])}`;
  const eaten = lostPieces(rootState, state, opposite(color));
  const tray = barEl.querySelector('.captured-tray');
  tray.replaceChildren();
  for (let i = 0; i < eaten.total; i++) {
    const disc = document.createElement('span');
    disc.className = 'tray-disc ' + (opposite(color) === WHITE ? 'disc-white' : 'disc-black') + (i < eaten.kings ? ' king' : '');
    tray.appendChild(disc);
  }
  barEl.classList.toggle('active', !!ctx.active);
  barEl.classList.toggle('winner', ctx.over && ctx.winner === color);
  const cap = barEl.querySelector('.player-capture');
  if (cap) cap.hidden = !ctx.mustCapture;
  const res = barEl.querySelector('.player-result');
  if (res) {
    let txt = '';
    if (ctx.over) { if (ctx.winner === color) txt = 'Победа'; else if (ctx.winner === null) txt = 'Ничья'; }
    res.hidden = !txt; res.textContent = txt;
    res.className = 'player-result' + (txt === 'Победа' ? ' win' : txt === 'Ничья' ? ' draw' : '');
    res.title = ctx.over && ctx.reason ? ctx.reason : '';
  }
}

/* ── ввод на доске ───────────────────────────────────────────────── */
boardUI.on('squareclick', ({ sq }) => { if (mode === 'setup') { paintSetup(sq); return; } handleSquareClick(sq); });
boardUI.on('dragdrop', ({ from, to }) => { if (mode === 'setup') return; handleDragDrop(from, to); });

function handleSquareClick(sq) {
  const state = history.currentState;
  if (getGameStatus(state).over) return;
  if (pending) {
    const step = pending.nextSteps.find((s) => s.to === sq);
    if (step) { performJumpStep(step); return; }
    if (sq === pending.current) { renderPending(); return; }
    return;
  }
  if (selected !== null) {
    const moves = getMovesForPiece(state, selected).filter((m) => m.to === sq);
    if (moves.length) { commitMove(pickMove(moves)); return; }
  }
  const piece = state.board[sq];
  if (piece && colorOf(piece) === state.turn) {
    const pieceMoves = getMovesForPiece(state, sq);
    if (pieceMoves.length) { if (pieceMoves[0].isCapture) startCaptureSequence(sq); else selectQuiet(sq, pieceMoves); return; }
  }
  selected = null; activeHints = null; renderAnalyze();
}

function handleDragDrop(from, to) {
  if (pending) {
    if (from === pending.current) { const step = pending.nextSteps.find((s) => s.to === to); if (step) { performJumpStep(step); return; } }
    renderPending(); return;
  }
  const state = history.currentState;
  const moves = getMovesForPiece(state, from).filter((m) => m.to === to);
  if (moves.length) commitMove(pickMove(moves));
  else { selected = null; activeHints = null; renderAnalyze(); }
}

function selectQuiet(sq, moves) { selected = sq; activeHints = moves.map((m) => ({ to: m.to, isCapture: false })); renderAnalyze(); }

/** Старт пошаговой серии взятий: allowedMoves — серии, разрешённые локальным правилом. */
function startCaptureSequence(sq) {
  const state = history.currentState;
  const series = getMovesForPiece(state, sq).filter((m) => m.isCapture);
  pending = { origin: sq, current: sq, path: [sq], captures: [], king: isKingPiece(state.board[sq]), midState: cloneState(state), allowedMoves: series, nextSteps: [] };
  pending.nextSteps = computeNextSteps();
  selected = null; activeHints = null; renderPending();
}

/** Следующие посадки: берём «сырые» прыжки и оставляем согласованные с разрешёнными сериями. */
function computeNextSteps() {
  const k = pending.path.length;
  const allowedTo = new Set();
  for (const m of pending.allowedMoves) {
    if (m.path.length <= k) continue;
    let ok = true;
    for (let i = 0; i < k; i++) if (m.path[i] !== pending.path[i]) { ok = false; break; }
    if (ok) allowedTo.add(m.path[k]);
  }
  const raw = getJumpSteps(pending.midState, pending.current, pending.captures, pending.king);
  return raw.filter((s) => allowedTo.has(s.to));
}

function performJumpStep(step) {
  const color = pending.midState.turn;
  const next = cloneState(pending.midState);
  next.board[pending.current] = null;
  next.board[step.to] = pieceChar(color, step.king);
  pending.midState = next; pending.current = step.to;
  pending.path.push(step.to); pending.captures.push(step.captured); pending.king = step.king;
  pending.nextSteps = computeNextSteps();
  if (pending.nextSteps.length) renderPending(); else finalizeCapture();
}

function finalizeCapture() {
  const state = history.currentState;
  const key = pending.path.join(',');
  const move = getLegalMoves(state).find((m) => m.path.join(',') === key) ?? {
    from: pending.origin, to: pending.current, path: [...pending.path], captures: [...pending.captures], king: pending.king, isCapture: true,
  };
  pending = null; commitMove(move);
}

const pickMove = (moves) => moves[0];
function commitMove(move) { selected = null; activeHints = null; history.addMove(move); }

function renderPending() {
  const display = cloneState(pending.midState);
  for (const c of pending.captures) display.board[c] = null;
  const last = pending.path.length > 1 ? { from: pending.path[pending.path.length - 2], to: pending.current } : history.lastMove;
  boardUI.render(display, { lastMove: last, selected: pending.current, hints: pending.nextSteps.map((s) => ({ to: s.to, isCapture: true })), movable: new Set([pending.current]) });
}

/* ── расстановка позиции ─────────────────────────────────────────── */
function enterSetup() {
  mode = 'setup';
  setupBoard = history.currentState.board.slice();
  setupTurn = history.currentState.turn;
  boardUI.setSetupMode(true);
  headersSnapshot = { ...gameHeaders };
  fillSetupMetaFields();
  sync();
}
function exitSetup() { mode = 'analyze'; boardUI.setSetupMode(false); sync(); syncMetaPanel(); }
function syncSetup() { renderSetupBoard(); renderSetupMetaPreview(); $('#board').classList.remove('game-over'); }
function renderSetupBoard() { boardUI.render({ board: setupBoard, turn: setupTurn, plies: 0 }, {}); updateSetupFen(); }

/** Живая FEN-плашка под палитрой фигур. */
function updateSetupFen() {
  const el = $('#setup-fen-text');
  if (!el || !setupBoard) return;
  const fen = stateToFEN({ board: setupBoard, turn: setupTurn, plies: 0 });
  el.textContent = fen; el.title = fen;
  const bar = $('#setup-fen-bar');
  if (bar) { bar.classList.add('bump'); clearTimeout(bar._bumpT); bar._bumpT = setTimeout(() => bar.classList.remove('bump'), 220); }
}

/** Покраска клетки холста. Простая на последней горизонтали → дамка (корректность). */
function paintSetup(sq) {
  if (!isDarkSquare(sq)) return; // светлые клетки недоступны
  let tool = activeTool;
  if (tool === 'w' && rankOf(sq) === SIZE - 1) tool = 'W';
  else if (tool === 'b' && rankOf(sq) === 0) tool = 'B';
  setupBoard[sq] = tool === 'erase' ? null : tool;
  syncSetup();
}

document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTool = btn.dataset.tool;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b === btn));
  });
});
document.querySelectorAll('[data-turn-choice]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setupTurn = btn.dataset.turnChoice;
    document.querySelectorAll('[data-turn-choice]').forEach((b) => b.classList.toggle('active', b === btn));
    syncSetup();
  });
});
$('#btn-setup-clear').addEventListener('click', () => { setupBoard = new Array(64).fill(null); syncSetup(); });
$('#btn-setup-initial').addEventListener('click', () => { setupBoard = initialState().board.slice(); syncSetup(); });
$('#btn-setup-svg').addEventListener('click', saveSetupSVG);
$('#btn-setup-cancel').addEventListener('click', () => { gameHeaders = headersSnapshot ? { ...headersSnapshot } : {}; exitSetup(); });
$('#btn-setup-apply').addEventListener('click', () => {
  const hasWhite = setupBoard.some((p) => p && colorOf(p) === WHITE);
  const hasBlack = setupBoard.some((p) => p && colorOf(p) === BLACK);
  if (!hasWhite || !hasBlack) { showToast('На доске нужны шашки обоих цветов', 'error'); return; }
  collectSetupMetaFields();
  history.reset(createState(setupBoard, setupTurn));
  exitSetup();
  showToast(`Позиция применена — ход ${setupTurn === WHITE ? 'белых' : 'чёрных'}`);
});

/* ── паспорт тегов в расстановке ─────────────────────────────────── */
const SAVE_FIELDS = [['event', 'Event'], ['site', 'Site'], ['white', 'White'], ['black', 'Black'], ['date', 'Date'], ['round', 'Round']];
const smVal = (name) => $(`#sm-f-${name}`).value.trim();
const setSmVal = (name, v) => { $(`#sm-f-${name}`).value = v ?? ''; };

function fillSetupMetaFields() {
  for (const [name, key] of SAVE_FIELDS) {
    let v = gameHeaders[key];
    if (!v || v === '?') v = key === 'Date' ? formatDate() : '';
    setSmVal(name, v === '?' ? '' : v);
  }
  const sel = $('#sm-f-result');
  const r = gameHeaders.Result || '*';
  sel.value = [...sel.options].some((o) => o.value === r) ? r : '*';
}
function collectSetupMetaFields() {
  for (const [name, key] of SAVE_FIELDS) gameHeaders[key] = smVal(name) || '?';
  gameHeaders.Result = $('#sm-f-result').value || '*';
}
function renderSetupMetaPreview() {
  const pre = $('#sm-preview');
  if (!pre) return;
  const lines = []; let filled = 0;
  for (const [name, key] of SAVE_FIELDS) { const v = smVal(name); if (v && v !== '?') { lines.push(`[${key} "${escPre(v)}"]`); filled++; } }
  const res = $('#sm-f-result').value || '*';
  lines.push(`[Result "${escPre(res)}"]`); if (res !== '*') filled++;
  if (setupBoard) {
    const fen = stateToFEN({ board: setupBoard, turn: setupTurn, plies: 0 });
    if (fen !== stateToFEN(initialState())) { lines.push(`[SetUp "1"]`); lines.push(`[FEN "${escPre(fen)}"]`); }
  }
  pre.innerHTML = lines.length ? escPre(lines.join('\n')) : '<span class="pv-empty">Теги не заполнены — в файле будут значения «?».</span>';
  const cnt = $('#sm-count'); if (cnt) cnt.textContent = `${filled} / 7`;
  pre.classList.add('bump'); clearTimeout(pre._bumpT); pre._bumpT = setTimeout(() => pre.classList.remove('bump'), 220);
}
['event', 'site', 'white', 'black', 'date', 'round'].forEach((name) => {
  $(`#sm-f-${name}`)?.addEventListener('input', () => { collectSetupMetaFields(); renderSetupMetaPreview(); });
});
$('#sm-f-result')?.addEventListener('change', () => { collectSetupMetaFields(); renderSetupMetaPreview(); });

/* ── афиша метаданных в анализе ──────────────────────────────────── */
const META_ICONS = {
  event: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  site:  '<path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/>',
  date:  '<rect x="4" y="5" width="16" height="16" rx="2.5"/><path d="M4 9h16M8 3v4M16 3v4"/>',
  round: '<path d="M9 4 7 20M17 4l-2 16M5 9h15M4 15h15"/>',
  tag:   '<path d="M3.5 12.5 11 5a2 2 0 0 1 1.4-.6H19a1.5 1.5 0 0 1 1.5 1.5v6.6a2 2 0 0 1-.6 1.4l-7.5 7.5a2 2 0 0 1-2.8 0l-6.1-6.1a2 2 0 0 1 0-2.8Z"/><circle cx="16" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
};
const svgIco = (key) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${META_ICONS[key]}</svg>`;

function parseResult(r) {
  if (!isReal(r)) return { white: false, black: false, draw: false, live: false };
  if (r === '1-0' || r === '2-0') return { white: true, black: false, draw: false, live: false };
  if (r === '0-1' || r === '0-2') return { white: false, black: true, draw: false, live: false };
  if (r === '1/2-1/2' || r === '1-1') return { white: false, black: false, draw: true, live: false };
  return { white: false, black: false, draw: false, live: true };
}
function syncMetaPanel() {
  const body = $('#meta-body'); if (!body) return;
  const h = gameHeaders || {};
  const white = h.White, black = h.Black, result = h.Result;
  const pr = parseResult(result);
  const hasMatch = isReal(white) || isReal(black) || (isReal(result) && result !== '*');
  const tags = [];
  if (isReal(h.Event)) tags.push(['event', h.Event]);
  if (isReal(h.Site))  tags.push(['site',  h.Site]);
  if (isReal(h.Date))  tags.push(['date',  h.Date]);
  if (isReal(h.Round)) tags.push(['round', h.Round]);
  if (!hasMatch && tags.length === 0) {
    body.innerHTML = `<div class="meta-empty">${svgIco('tag')}<span>Метаданные партии появятся<br>после загрузки или сохранения PDN</span></div>`;
    return;
  }
  let html = '';
  if (hasMatch) {
    const wName = isReal(white) ? esc(white) : '—', bName = isReal(black) ? esc(black) : '—';
    const wCls = 'meta-player' + (pr.white ? ' win' : pr.black ? ' lose' : ''), bCls = 'meta-player' + (pr.black ? ' win' : pr.white ? ' lose' : '');
    const wNameCls = 'pname' + (isReal(white) ? '' : ' empty-name'), bNameCls = 'pname' + (isReal(black) ? '' : ' empty-name');
    let score = '';
    if (isReal(result)) { const sCls = 'meta-score' + (pr.draw ? ' draw' : pr.live ? ' live' : ''); score = `<span class="${sCls}">${esc(result)}</span>`; }
    html += `<div class="meta-match"><div class="meta-players">` +
      `<div class="${wCls}"><span class="meta-disc disc-white"></span><span class="${wNameCls}" title="${esc(white || '')}">${wName}</span></div>` +
      `<div class="${bCls}"><span class="meta-disc disc-black"></span><span class="${bNameCls}" title="${esc(black || '')}">${bName}</span></div>` +
      `</div>${score}</div>`;
  }
  if (tags.length) {
    const chips = tags.map(([k, v]) => `<span class="meta-chip" title="${esc(v)}">${svgIco(k)}<span class="chip-val">${esc(v)}</span></span>`).join('');
    html += `<div class="meta-tags${hasMatch ? ' after-match' : ''}">${chips}</div>`;
  }
  body.innerHTML = html;
}

/* ── модалки: загрузка PDN / редактор тегов / комментарий ────────── */
const modal = $('#pdn-modal'), pdnText = $('#pdn-text');
function openPasteModal(prefill = '') {
  $('#pdn-modal-title').textContent = 'Загрузка PDN';
  pdnText.readOnly = false; pdnText.value = prefill; $('#pdn-apply').textContent = 'Загрузить';
  modal.classList.remove('closing'); modal.hidden = false;
  setTimeout(() => pdnText.focus(), 80);
}
function closeModal() {
  if (modal.hidden || modal.classList.contains('closing')) return;
  modal.classList.add('closing');
  setTimeout(() => { modal.classList.remove('closing'); modal.hidden = true; }, 170);
}
modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); });
$('#pdn-apply').addEventListener('click', () => { try { loadPDNText(pdnText.value); closeModal(); } catch (err) { showToast(err.message, 'error', 4200); } });

const saveModal = $('#save-modal');
const saveVal = (name) => $(`#save-f-${name}`).value.trim();
const setSaveVal = (name, v) => { $(`#save-f-${name}`).value = v ?? ''; };
function fillSaveFields() {
  for (const [name, key] of SAVE_FIELDS) { let v = gameHeaders[key]; if (!v || v === '?') v = key === 'Date' ? formatDate() : ''; setSaveVal(name, v === '?' ? '' : v); }
  const r = gameHeaders.Result || detectResult(history) || '*';
  const sel = $('#save-f-result'); sel.value = [...sel.options].some((o) => o.value === r) ? r : '*';
}
function collectSaveFields() { for (const [name, key] of SAVE_FIELDS) gameHeaders[key] = saveVal(name) || '?'; gameHeaders.Result = $('#save-f-result').value || '*'; }
function openSaveModal() {
  fillSaveFields();
  $('#save-title-text').textContent = pendingSave === 'clip' ? 'Сохранить PDN — в буфер обмена' : 'Сохранить PDN — в файл';
  saveModal.classList.remove('closing'); saveModal.hidden = false;
  setTimeout(() => $('#save-f-white').focus(), 80);
}
function closeSaveModal() {
  if (saveModal.hidden || saveModal.classList.contains('closing')) return;
  saveModal.classList.add('closing');
  setTimeout(() => { saveModal.classList.remove('closing'); saveModal.hidden = true; pendingSave = null; }, 170);
}
async function applySave() {
  collectSaveFields(); syncMetaPanel();
  const pdn = currentPDN(), channel = pendingSave;
  closeSaveModal();
  if (channel === 'file') { downloadText(suggestFilename(gameHeaders), pdn); showToast('Файл PDN сохранён'); }
  else { try { await copyTextToClipboard(pdn); showToast('PDN скопирован в буфер обмена'); } catch (err) { showToast(err.message, 'error'); } }
}
saveModal.addEventListener('click', (e) => { if (e.target === saveModal || e.target.closest('[data-close]')) closeSaveModal(); });
$('#save-apply').addEventListener('click', applySave);

const commentModal = $('#comment-modal'), commentText = $('#comment-text');
let commentTarget = null;
history.onEditComment = ({ node, phase, index }) => openCommentModal(node, phase, index);
function openCommentModal(node, phase, index) {
  if (!node || node === history.root) return;
  const arr = phase === 'before' ? node.commentsBefore : node.commentsAfter;
  commentTarget = { node, phase, index };
  commentText.value = (index != null && arr[index] != null) ? arr[index] : '';
  $('#comment-title-text').textContent = (index != null ? 'Редактировать комментарий' : 'Новый комментарий') + ' · ' + (phase === 'before' ? 'до ' : 'после ') + moveToString(node.move);
  $('#comment-delete').hidden = !(index != null && arr[index] != null);
  commentModal.classList.remove('closing'); commentModal.hidden = false;
  setTimeout(() => commentText.focus(), 80);
}
function closeCommentModal() {
  if (commentModal.hidden || commentModal.classList.contains('closing')) return;
  commentModal.classList.add('closing');
  setTimeout(() => { commentModal.classList.remove('closing'); commentModal.hidden = true; commentTarget = null; }, 170);
}
function applyComment() {
  if (!commentTarget) { closeCommentModal(); return; }
  const { node, phase, index } = commentTarget;
  const arr = phase === 'before' ? node.commentsBefore : node.commentsAfter;
  const val = commentText.value;
  if (val.trim() === '') { if (index != null) arr.splice(index, 1); }
  else if (index != null) arr[index] = val;
  else arr.push(val);
  closeCommentModal(); history.render();
}
function deleteComment() {
  if (!commentTarget || commentTarget.index == null) { closeCommentModal(); return; }
  const { node, phase, index } = commentTarget;
  (phase === 'before' ? node.commentsBefore : node.commentsAfter).splice(index, 1);
  closeCommentModal(); history.render();
}
commentModal.addEventListener('click', (e) => { if (e.target === commentModal || e.target.closest('[data-close]')) closeCommentModal(); });
$('#comment-apply').addEventListener('click', applyComment);
$('#comment-delete').addEventListener('click', deleteComment);
$('#btn-comment').addEventListener('click', () => { if (history.current === history.root) return; openCommentModal(history.current, 'after', null); });

/* ── загрузка/сохранение PDN ─────────────────────────────────────── */
function loadPDNText(text) {
  const parsed = parsePDN(text);
  gameHeaders = {};
  for (const key of ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'GameType']) if (parsed.headers[key]) gameHeaders[key] = parsed.headers[key];
  history.loadFromTree(parsed.rootState, parsed.tree);
  history.toEnd(); syncMetaPanel();

  const skipped = parsed.skipped || [];
  if (skipped.length) {
    const sample = skipped.slice(0, 5).map((s) => s.raw).join(', ');
    showToast(`Загружено с предупреждением: пропущено недопустимых ходов: ${skipped.length} (${sample}${skipped.length > 5 ? ', …' : ''}) — проверьте файл`, 'error', 8000);
  } else {
    showToast(parsed.result ? `Партия загружена · результат ${parsed.result}` : 'Партия загружена');
  }
}
function currentPDN() { return generatePDN(history, gameHeaders); }

/* ── меню и команды ──────────────────────────────────────────────── */
function closeAllSubmenus() { document.querySelectorAll('.menu-group.open').forEach((g) => g.classList.remove('open')); }
function closeDrawer() { $('#main-menu').classList.remove('open'); $('#menu-toggle').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); }

$('#menu-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('#main-menu').classList.toggle('open');
  $('#menu-toggle').classList.toggle('open', open);
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
  closeThemeMenu(); closeBoardMenu();
});
document.querySelectorAll('[data-toggle]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const group = btn.closest('.menu-group');
    const wasOpen = group.classList.contains('open');
    closeAllSubmenus();
    if (!wasOpen) group.classList.add('open');
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-group')) closeAllSubmenus();
  if (!e.target.closest('#main-menu') && !e.target.closest('#menu-toggle')) closeDrawer();
});

async function runAction(action) {
  switch (action) {
    case 'analyze': if (mode === 'setup') exitSetup(); history.toEnd(); break;
    case 'setup': enterSetup(); break;
    case 'load-file': {
      let text;
      try { text = await pickAndReadFile($('#file-input')); } catch (err) { showToast(err.message, 'error'); break; }
      if (text === null) break;
      try { loadPDNText(text); } catch (err) { showToast(err.message, 'error', 4200); openPasteModal(text); }
      break;
    }
    case 'load-clip': {
      let text;
      try { text = await readTextFromClipboard(); } catch { showToast('Нет доступа к буферу — вставьте PDN вручную', 'error', 3600); openPasteModal(); break; }
      try { loadPDNText(text); } catch (err) { showToast(err.message, 'error', 4200); openPasteModal(text); }
      break;
    }
    case 'save-file': pendingSave = 'file'; openSaveModal(); break;
    case 'save-clip': pendingSave = 'clip'; openSaveModal(); break;
    case 'new-game':
      if (mode === 'setup') { mode = 'analyze'; boardUI.setSetupMode(false); }
      gameHeaders = {}; setCaptureSep(':'); history.reset(initialState()); syncMetaPanel();
      showToast('Новая партия — ход белых'); break;
  }
}
document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => { closeAllSubmenus(); closeDrawer(); runAction(btn.dataset.action); });
});

$('#btn-start').addEventListener('click', () => history.toStart());
$('#btn-prev').addEventListener('click', () => history.back());
$('#btn-next').addEventListener('click', () => history.forward());
$('#btn-end').addEventListener('click', () => history.toEnd());

function flipBoard() { boardUI.toggleFlip(); savePrefs({ flipped: boardUI.flipped }); syncPlayerBars(); }
$('#btn-flip').addEventListener('click', flipBoard);
$('#btn-new').addEventListener('click', () => { if (!history.isEmpty && !confirm('Начать новую партию? Текущие ходы будут сброшены.')) return; runAction('new-game'); });

window.addEventListener('keydown', (e) => {
  if (!modal.hidden || !saveModal.hidden || !commentModal.hidden) { if (e.key === 'Escape') { closeModal(); closeSaveModal(); closeCommentModal(); } return; }
  if (e.target.closest('textarea, input')) return;
  switch (e.key) {
    case 'ArrowLeft':  e.preventDefault(); history.back();    break;
    case 'ArrowRight': e.preventDefault(); history.forward(); break;
    case 'Home': history.toStart(); break;
    case 'End':  history.toEnd();   break;
    case 'f': case 'F': case 'а': case 'А': flipBoard(); break;
  }
});

/* ── запуск ──────────────────────────────────────────────────────── */
(function boot() {
  let prefs = loadPrefs();
  if (prefs.orientFix !== 2) prefs = savePrefs({ flipped: false, orientFix: 3 }); // одноразовая миграция ориентации
  if (THEME_IDS.includes(prefs.theme)) document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.board = BOARD_IDS.includes(prefs.board) ? prefs.board : 'classic';
  if (prefs.flipped) boardUI.setFlipped(true, false);

  bindThemePickers();   // обработчики пикеров темы/скина
  setCaptureSep(':');
  sync();
  syncMetaPanel();
  updateThemeMenu();
  updateBoardMenu();
})();