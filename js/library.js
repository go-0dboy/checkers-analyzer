/**
 * @module library
 * База партий (data/games.json) + использование в анализе + админ-инструмент.
 * Хранение: файл в проекте + черновик в localStorage. Импорт только линейных
 * сыгранных партий (без комментариев/ветвлений). Поиск по FEN текущей позиции.
 * НОВОЕ: клик по ходу в «Библиотеке» = сыграть его на доске.
 */
import { WHITE, BLACK, stateToFEN, getLegalMoves, nameToIdx } from './engine.js';
import { parsePDNBatch } from './pdn.js';
import { downloadText } from './storage.js';
import { showToast } from './toast.js';

const DB_URL = 'data/games.json';
const DRAFT_KEY = 'ru-checkers-analyzer:db-draft';
const ADMIN_KEY = 'ru-checkers-analyzer:admin';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const year = (d) => String(d || '').slice(0, 4);

let games = [], fileGames = [], index = new Map();
let adminMode = false, winsOnly = true, historyRef = null;

export function initLibraryUI({ history }) {
  historyRef = history;
  const q = new URLSearchParams(location.search);
  try {
    if (q.get('admin') === '1') localStorage.setItem(ADMIN_KEY, '1');
    if (q.get('admin') === '0') localStorage.removeItem(ADMIN_KEY);
    adminMode = localStorage.getItem(ADMIN_KEY) === '1';
  } catch { adminMode = false; }
  if (adminMode) $('#menu-db')?.removeAttribute('hidden');

  wireAdmin();
  $('#lib-filter')?.addEventListener('change', (e) => { winsOnly = e.target.checked; renderLibrary(); });

  // Клик по ходу в библиотеке = сыграть его на доске.
  $('#library-body')?.addEventListener('click', (e) => {
    const el = e.target.closest('.lib-move');
    if (!el) return;
    playLibraryMove((el.dataset.move || el.textContent).trim());
  });

  loadDB().then(() => {
    if (adminMode) renderAdmin();
    document.addEventListener('app:sync', () => renderLibrary());
    renderLibrary();
  });
}

/** Разбирает строку хода и проводит его через историю (как обычный ход). */
function playLibraryMove(moveStr) {
  if (!historyRef || !moveStr) return;
  const state = historyRef.currentState;
  const squares = moveStr.toLowerCase().split(/[x:×-]/);
  if (squares.length < 2) return;
  const from = nameToIdx(squares[0]);
  const to = nameToIdx(squares[squares.length - 1]);
  const path = squares.map(nameToIdx);
  const candidates = getLegalMoves(state).filter((m) => m.from === from && m.to === to);
  if (!candidates.length) { showToast('Этот ход недоступен в текущей позиции', 'error'); return; }
  const move = candidates.find((m) => m.path.length === path.length && m.path.every((s, i) => s === path[i])) || candidates[0];
  historyRef.addMove(move); // триггерит onChange → sync → доска/нотация/плашки
}

function classify(side, result) {
  const w = result === '1-0' || result === '2-0';
  const b = result === '0-1' || result === '0-2';
  if (result === '1/2-1/2' || result === '1-1' || result === '0-0') return 'd';
  return ((side === WHITE && w) || (side === BLACK && b)) ? 'w' : 'l';
}
const orderRes = (side, r) => ({ w: 0, d: 1, l: 2 }[classify(side, r)]);

async function loadDB() {
  let base = [];
  try {
    const r = await fetch(DB_URL, { cache: 'no-store' });
    if (r.ok) base = (await r.json()).games || [];
  } catch { /* файла может не быть */ }
  fileGames = base;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { }
  games = (draft && Array.isArray(draft.games)) ? draft.games : base;
  buildIndex();
}

function buildIndex() {
  index = new Map();
  games.forEach((g, gi) => (g.plies || []).forEach((p, pi) => {
    const a = index.get(p.fen) || []; a.push({ g: gi, p: pi }); index.set(p.fen, a);
  }));
}
const saveDraft = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ games })); } catch { } };

function renderLibrary() {
  const body = $('#library-body'); if (!body || !historyRef) return;
  const st = historyRef.currentState, fen = stateToFEN(st), side = st.turn;
  let rows = (index.get(fen) || []).map((e) => ({ g: games[e.g], p: e.p }));
  const cnt = $('#library-count'); if (cnt) cnt.textContent = String(rows.length);
  if (winsOnly) rows = rows.filter((r) => classify(side, r.g.result) === 'w');

  const groups = new Map();
  for (const r of rows) {
    const mv = r.g.plies[r.p].m;
    const g = groups.get(mv) || { mv, rows: [], w: 0, d: 0, l: 0 };
    const c = classify(side, r.g.result);
    if (c === 'w') g.w++; else if (c === 'd') g.d++; else g.l++;
    g.rows.push(r); groups.set(mv, g);
  }
  const arr = [...groups.values()].sort((a, b) => (b.w - a.w) || (b.rows.length - a.rows.length));
  if (!arr.length) {
    body.innerHTML = `<div class="lib-empty">В базе нет ходов из этой позиции${winsOnly ? ' (фильтр: только победы текущего цвета)' : ''}</div>`;
    return;
  }
  let html = '';
  for (const g of arr) {
    const best = g.rows.slice().sort((a, b) => orderRes(side, a.g.result) - orderRes(side, b.g.result))[0];
    const cont = best.g.plies.slice(best.p, best.p + 8).map((x) => x.m).join(' ');
    html += `<div class="lib-group">
      <div class="lib-head"><span class="lib-move" data-move="${esc(g.mv)}" title="Сыграть этот ход">${esc(g.mv)}</span><span class="lib-stat">${g.rows.length} · ${g.w}–${g.d}–${g.l}</span></div>
      <div class="lib-line">${esc(cont)}</div>
      <div class="lib-meta">${esc(best.g.white)} — ${esc(best.g.black)} · ${esc(best.g.event)} ${esc(year(best.g.date))} · ${esc(best.g.result)}</div>
    </div>`;
  }
  body.innerHTML = html;
}

/* ── админ: наполнение базы ── */
function validateAndAddBatch(text) {
  const parsed = parsePDNBatch(text);
  let added = 0, skipped = 0; const errors = [];
  for (const game of parsed) {
    if (game.error) { skipped++; errors.push(game.error); continue; }
    const line = []; let n = game.tree[0];
    while (n) { line.push(n); n = n.children[0]; }
    if (!line.length) { skipped++; continue; }
    const plies = line.map((n) => ({ m: moveStr(n), fen: stateToFEN(n.before) }));
    const h = game.headers;
    const sig = [h.White, h.Black, h.Date, h.Event, game.result, plies.map((p) => p.m).join(' ')].join('|');
    if (games.some((g) => g.sig === sig)) { skipped++; continue; }
    const id = games.reduce((m, g) => Math.max(m, g.id || 0), 0) + 1;
    games.push({ id, sig, event: h.Event || '?', site: h.Site || '?', date: h.Date || '?', round: h.Round || '?', white: h.White || '?', black: h.Black || '?', result: game.result, gameType: h.GameType || '25', plies });
    added++;
  }
  buildIndex(); saveDraft(); renderAdmin(); renderLibrary();
  if (added && !skipped) showToast(`Загружено партий: ${added}`);
  else if (added) showToast(`Загружено: ${added}, пропущено: ${skipped}`, 'error', 5000);
  else showToast(`Пропущено партий: ${skipped}. ${errors.slice(0, 2).join('; ')}`, 'error', 6000);
}
// строка хода узла с разделителем ':' (русские) — согласовано с moveToString
function moveStr(n) {
  const sep = n.move.isCapture ? ':' : '-';
  return n.move.path.map((i) => 'abcdefgh'[i % 8] + (Math.floor(i / 8) + 1)).join(sep);
}

function renderAdmin() {
  const c = $('#db-count'); if (c) c.textContent = String(games.length);
  const list = $('#db-list'); if (!list) return;
  if (!games.length) { list.innerHTML = '<div class="lib-empty">База пуста</div>'; return; }
  list.innerHTML = games.map((g) =>
    `<div class="db-row"><span class="db-name">${esc(g.white)} — ${esc(g.black)} · ${esc(g.event)} ${esc(year(g.date))} · ${esc(g.result)}</span><button class="db-del" data-del="${g.id}" title="Удалить">✕</button></div>`).join('');
}

function wireAdmin() {
  $('#menu-db')?.addEventListener('click', () => { $('#db-modal').hidden = false; renderAdmin(); });
  $('#db-modal')?.addEventListener('click', (e) => { if (e.target.id === 'db-modal' || e.target.closest('[data-close]')) $('#db-modal').hidden = true; });
  $('#db-add-file')?.addEventListener('click', () => $('#db-file-input').click());
  $('#db-file-input')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { validateAndAddBatch(await f.text()); } catch (err) { showToast(err.message, 'error', 4200); }
    e.target.value = '';
  });
  $('#db-add-text')?.addEventListener('click', () => {
    const t = $('#db-paste').value;
    try { validateAndAddBatch(t); $('#db-paste').value = ''; } catch (err) { showToast(err.message, 'error', 4200); }
  });
  $('#db-export')?.addEventListener('click', () => { downloadText('games.json', JSON.stringify({ version: 1, games }, null, 1), 'application/json'); showToast('games.json выгружен — положите его в data/'); });
  $('#db-reset')?.addEventListener('click', () => { try { localStorage.removeItem(DRAFT_KEY); } catch { } games = fileGames.slice(); buildIndex(); renderAdmin(); renderLibrary(); showToast('Черновик сброшен к файлу'); });
  $('#db-list')?.addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]'); if (!d) return;
    games = games.filter((g) => g.id !== Number(d.dataset.del));
    buildIndex(); saveDraft(); renderAdmin(); renderLibrary();
  });
}