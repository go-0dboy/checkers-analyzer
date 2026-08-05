/**
 * @module library
 * База партий (data/games.json) + панель «Библиотека» в анализе + админ-инструмент.
 * Поиск по FEN текущей позиции; выводятся ВСЕ найденные группы ходов.
 * Клик по ходу = сыграть его; справа у группы — знак «?», по клику всплывающая
 * подсказка с тегами PDN representative-партии (как в панели «Партия»).
 */
import { nameToIdx, getLegalMoves, stateToFEN } from './engine.js';
import { parsePDNBatch } from './pdn.js';
import { downloadText } from './storage.js';
import { showToast } from './toast.js';

const DB_URL = 'data/games.json';
const DRAFT_KEY = 'ru-checkers-analyzer:db-draft';
const ADMIN_KEY = 'ru-checkers-analyzer:admin';

let games = [], fileGames = [], index = new Map();
let adminMode = false, winsOnly = true, historyRef = null;
let currentList = [];   // representative-партия для каждой отрисованной группы
let tipEl = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const real = (v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '?';

function classify(side, result) {
  const w = result === '1-0' || result === '2-0';
  const b = result === '0-1' || result === '0-2';
  if (result === '1/2-1/2' || result === '1-1' || result === '0-0') return 'd';
  return ((side === 'w' && w) || (side === 'b' && b)) ? 'w' : 'l';
}
const orderRes = (side, r) => ({ w: 0, d: 1, l: 2 }[classify(side, r)]);

export function initLibraryUI({ history }) {
  historyRef = history;
  const q = new URLSearchParams(location.search);
  try {
    if (q.get('admin') === '1') localStorage.setItem(ADMIN_KEY, '1');
    if (q.get('admin') === '0') localStorage.removeItem(ADMIN_KEY);
    adminMode = localStorage.getItem(ADMIN_KEY) === '1';
  } catch { adminMode = false; }
  if (adminMode) document.getElementById('menu-db')?.removeAttribute('hidden');

  wireAdmin();
  document.getElementById('lib-filter')?.addEventListener('change', (e) => { winsOnly = e.target.checked; renderLibrary(); });

  const body = document.getElementById('library-body');
  // клик по ходу = сыграть; клик по «?» = подсказка с тегами
  body?.addEventListener('click', (e) => {
    const h = e.target.closest('.open-help');
    if (h) {
      e.stopPropagation();
      const i = Number(h.dataset.i);
      const g = currentList[i];
      if (!g) return;
      if (tipEl && !tipEl.hidden && tipEl.dataset.for === 'L' + i) { hideTip(); return; }
      showTip(h, gameMetaHTML(g), 'L' + i);
      return;
    }
    const mv = e.target.closest('.lib-move');
    if (mv) playLibraryMove((mv.dataset.move || mv.textContent).trim());
  });
  body?.addEventListener('scroll', hideTip, { passive: true });

  // глобальные закрытия подсказки
  document.addEventListener('click', (e) => { if (tipEl && !tipEl.hidden && !e.target.closest('.open-help')) hideTip(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('resize', hideTip);

  loadDB().then(() => {
    if (adminMode) renderAdmin();
    document.addEventListener('app:sync', () => renderLibrary());
    renderLibrary();
  });
}

async function loadDB() {
  let base = [];
  try {
    const r = await fetch(DB_URL, { cache: 'no-store' });
    if (r.ok) base = (await r.json()).games || [];
  } catch { base = []; }
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

/** Подсказка с тегами PDN партии — в стиле панели «Партия». */
function gameMetaHTML(g) {
  const pr = { white: false, black: false, draw: false };
  if (g.result === '1-0' || g.result === '2-0') pr.white = true;
  else if (g.result === '0-1' || g.result === '0-2') pr.black = true;
  else if (g.result === '1/2-1/2' || g.result === '1-1') pr.draw = true;
  let html = `<div class="meta-match"><div class="meta-players">
    <div class="meta-player${pr.white ? ' win' : pr.black ? ' lose' : ''}"><span class="meta-disc disc-white"></span><span class="pname">${esc(g.white)}</span></div>
    <div class="meta-player${pr.black ? ' win' : pr.white ? ' lose' : ''}"><span class="meta-disc disc-black"></span><span class="pname">${esc(g.black)}</span></div>
  </div><span class="meta-score${pr.draw ? ' draw' : ''}">${esc(g.result || '*')}</span></div>`;
  const chips = [];
  if (real(g.event)) chips.push(g.event);
  if (real(g.site)) chips.push(g.site);
  if (real(g.date)) chips.push(g.date);
  if (real(g.round)) chips.push('Тур ' + g.round);
  if (chips.length) html += `<div class="meta-tags">${chips.map((v) => `<span class="meta-chip"><span class="chip-val">${esc(v)}</span></span>`).join('')}</div>`;
  return html;
}

function renderLibrary() {
  const body = document.getElementById('library-body');
  const cnt = document.getElementById('library-count');
  if (!body) return;
  hideTip();

  const played = [];
  let n = historyRef.current;
  while (n && n.move) { played.unshift(n.move); n = n.parent; }

  currentList = [];
  if (!played.length) {
    if (cnt) cnt.textContent = '0';
    body.innerHTML = '<div class="lib-empty">Сделайте ход — покажу ходы из базы</div>';
    return;
  }

  const fen = stateToFEN(historyRef.currentState);
  const side = historyRef.currentState.turn;
  let rows = (index.get(fen) || []).map((e) => ({ g: games[e.g], p: e.p }));
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

  if (cnt) cnt.textContent = String(arr.length);
  if (!arr.length) {
    body.innerHTML = '<div class="lib-empty">В базе нет ходов из этой позиции</div>';
    return;
  }

  body.innerHTML = arr.map((g, i) => {
    const best = g.rows.slice().sort((a, b) => orderRes(side, a.g.result) - orderRes(side, b.g.result))[0];
    currentList[i] = best.g;
    const seqHtml = best.g.plies.slice(best.p, best.p + 8)
      .map((x, idx) => `<span class="open-mv${idx < played.length ? ' played' : ''}">${esc(x.m)}</span>`).join(' ');
    return `<div class="lib-group">
      <div class="lib-head">
        <span class="lib-move" data-move="${esc(g.mv)}" title="Сыграть этот ход">${esc(g.mv)}</span>
        <span class="lib-head-right">
          <span class="lib-stat">${g.rows.length} · ${g.w}–${g.d}–${g.l}</span>
          <button class="open-help" data-i="${i}" title="Данные партии" aria-label="Данные партии">?</button>
        </span>
      </div>
      <div class="open-line">${seqHtml}</div>
    </div>`;
  }).join('');
}

/** Разбирает строку хода и проводит его через историю. */
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
  historyRef.addMove(move);
}

/* ── всплывающая подсказка ── */
function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'lib-tip';
    tipEl.className = 'open-tip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
    tipEl.addEventListener('click', (e) => e.stopPropagation());
  }
  return tipEl;
}
function hideTip() { if (tipEl) tipEl.hidden = true; }
function showTip(btn, html, key) {
  const tip = ensureTip();
  tip.innerHTML = html;
  tip.dataset.for = key;
  tip.hidden = false;
  const r = btn.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = r.left - tw - 10;
  if (left < 8) left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
  let top = r.top - 4;
  if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;
  if (top < 8) top = 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

/* ── админ: наполнение базы ── */
function moveStr(n) {
  const sep = n.move.isCapture ? ':' : '-';
  return n.move.path.map((i) => 'abcdefgh'[i % 8] + (Math.floor(i / 8) + 1)).join(sep);
}
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
const saveDraft = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ games })); } catch { } };

function renderAdmin() {
  const c = document.getElementById('db-count'); if (c) c.textContent = String(games.length);
  const list = document.getElementById('db-list'); if (!list) return;
  if (!games.length) { list.innerHTML = '<div class="lib-empty">База пуста</div>'; return; }
  list.innerHTML = games.map((g) =>
    `<div class="db-row"><span class="db-name">${esc(g.white)} — ${esc(g.black)} · ${esc(g.event)} ${esc(String(g.date).slice(0, 4))} · ${esc(g.result)}</span><button class="db-del" data-del="${g.id}" title="Удалить">✕</button></div>`).join('');
}

function wireAdmin() {
  document.getElementById('menu-db')?.addEventListener('click', () => { document.getElementById('db-modal').hidden = false; renderAdmin(); });
  document.getElementById('db-modal')?.addEventListener('click', (e) => { if (e.target.id === 'db-modal' || e.target.closest('[data-close]')) document.getElementById('db-modal').hidden = true; });
  document.getElementById('db-add-file')?.addEventListener('click', () => document.getElementById('db-file-input').click());
  document.getElementById('db-file-input')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { validateAndAddBatch(await f.text()); } catch (err) { showToast(err.message, 'error', 4200); }
    e.target.value = '';
  });
  document.getElementById('db-add-text')?.addEventListener('click', () => {
    const t = document.getElementById('db-paste').value;
    try { validateAndAddBatch(t); document.getElementById('db-paste').value = ''; } catch (err) { showToast(err.message, 'error', 4200); }
  });
  document.getElementById('db-export')?.addEventListener('click', () => { downloadText('games.json', JSON.stringify({ version: 1, games }, null, 1), 'application/json'); showToast('games.json выгружен — положите его в data/'); });
  document.getElementById('db-reset')?.addEventListener('click', () => { try { localStorage.removeItem(DRAFT_KEY); } catch { } games = fileGames.slice(); buildIndex(); renderAdmin(); renderLibrary(); showToast('Черновик сброшен к файлу'); });
  document.getElementById('db-list')?.addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]'); if (!d) return;
    games = games.filter((g) => g.id !== Number(d.dataset.del));
    buildIndex(); saveDraft(); renderAdmin(); renderLibrary();
  });
}