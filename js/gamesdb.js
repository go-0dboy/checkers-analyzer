/**
 * @module gamesdb
 * Панель «База партий». База данных = объект {name, bases:[{id,name,games:[]}]}.
 * Рабочая копия — в IndexedDB (kv 'gamesdb'); файловый handle (File System Access)
 * хранится в kv 'gamesdb-handle' и при включённой настройке gdbAutosave база
 * дописывается в файл при каждом изменении (с запросом разрешения).
 * Команды: новая/открыть/сохранить базу, создать/переименовать/удалить базу,
 * поиск, сортировка, добавить партию (через диалог тегов — канал 'gdb' в main),
 * удалить партию, клик по карточке — загрузить партию в анализатор.
 */
import { idbGet, idbPut } from './idb.js';
import { downloadText, pickAndReadFile, loadPrefs } from './storage.js';
import { showToast } from './toast.js';

let historyRef = null, loadPdnRef = null;
let db = null, fileHandle = null;
let currentBaseId = null, selectedId = null;
let searchStr = '', sortMode = 'date';
const SORT_NEXT = { date: 'white', white: 'result', result: 'date' };
const SORT_TITLE = { date: 'Сортировка: по дате', white: 'Сортировка: по игроку', result: 'Сортировка: по результату' };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const real = (v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '?';
const safeName = (s) => (s || 'database').replace(/[^\wа-яёА-ЯЁ -]/g, '').trim().replace(/\s+/g, '_') || 'database';
const serializeDb = () => JSON.stringify({ app: 'ru-checkers-analyzer', kind: 'gamesdb', version: 1, name: db.name, bases: db.bases }, null, 1);

export function initGamesDBUI({ history, loadPdn }) {
  historyRef = history; loadPdnRef = loadPdn;
  // ВАЖНО: сначала handle и рабочая копия, ТОЛЬКО потом wire+render (иначе db null)
  Promise.resolve()
    .then(restoreHandle)
    .then(loadWorking)
    .then(() => { wire(); refreshUI(); })
    .catch((e) => console.warn('gamesdb init:', e));
}

/* ── файловый handle и автосохранение ── */
async function restoreHandle() {
  try { const rec = await idbGet('kv', 'gamesdb-handle'); fileHandle = rec?.value || null; }
  catch { fileHandle = null; }
}
async function setFileHandle(h) {
  fileHandle = h;
  try { await idbPut('kv', { key: 'gamesdb-handle', value: h }); } catch { }
}
async function ensurePermission(h) {
  if (!h?.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (!h.requestPermission) return false;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}
async function writeToHandle(h, text) {
  const w = await h.createWritable();
  await w.write(text); await w.close();
}
let autosaveTimer = null;
function scheduleAutosave() {
  if (!loadPrefs().gdbAutosave || !fileHandle) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    try {
      if (!(await ensurePermission(fileHandle))) return;
      await writeToHandle(fileHandle, serializeDb());
    } catch (e) { console.warn('gamesdb autosave:', e); }
  }, 500);
}

/* ── состояние ── */
async function loadWorking() {
  const rec = await idbGet('kv', 'gamesdb').catch(() => null);
  db = normalizeDb(rec?.value);
  if (!rec) await idbPut('kv', { key: 'gamesdb', value: db });
  if (!db.bases.some((b) => b.id === currentBaseId)) currentBaseId = db.bases[0]?.id ?? null;
}
function normalizeDb(raw) {
  if (raw && Array.isArray(raw.bases)) {
    return {
      name: raw.name || 'База данных',
      bases: raw.bases.map((b, i) => ({ id: b.id ?? i + 1, name: b.name || `База ${i + 1}`, games: Array.isArray(b.games) ? b.games : [] })),
    };
  }
  if (raw && Array.isArray(raw.games)) return { name: raw.name || 'База данных', bases: [{ id: 1, name: 'Импортированные партии', games: raw.games }] };
  return { name: 'Моя база данных', bases: [{ id: 1, name: 'Мои партии', games: [] }] };
}
async function persist() { await idbPut('kv', { key: 'gamesdb', value: db }); scheduleAutosave(); }
const curBase = () => db?.bases.find((b) => b.id === currentBaseId) || null;

function refreshUI() {
  if (!db) return;
  const nameEl = $('#gdb-db-name');
  if (nameEl) nameEl.textContent = db.name || '';
  renderBaseSelect(); renderList();
}
function renderBaseSelect() {
  const sel = $('#gdb-base'); if (!sel || !db) return;
  sel.innerHTML = db.bases.map((b) => `<option value="${b.id}" ${b.id === currentBaseId ? 'selected' : ''}>${esc(b.name)} (${b.games.length})</option>`).join('');
}
function renderList() {
  const list = $('#gdb-list'); if (!list) return;
  const base = curBase(); const games = base ? base.games : [];
  const q = searchStr.trim().toLowerCase();
  let arr = games.slice();
  if (q) arr = arr.filter((g) => [g.white, g.black, g.event, g.site].some((v) => real(v) && v.toLowerCase().includes(q)));
  arr.sort((a, b) => {
    if (sortMode === 'white') return String(a.white).localeCompare(String(b.white), 'ru');
    if (sortMode === 'result') return String(a.result).localeCompare(String(b.result));
    return (b.date || '').localeCompare(a.date || '');
  });
  if (!arr.length) { list.innerHTML = '<div class="lib-empty">В базе пока пусто — добавьте партию или откройте файл базы</div>'; return; }
  list.innerHTML = arr.map((g) => `
    <div class="gdb-card${g.id === selectedId ? ' sel' : ''}" data-id="${g.id}" title="Открыть партию в анализаторе">
      <div class="gdb-line1"><span class="gdb-names">${esc(g.white)} — ${esc(g.black)}</span><span class="gdb-res">${esc(g.result || '*')}</span></div>
      <div class="gdb-line2">${[g.event, g.date].filter(real).map(esc).join(' · ') || '—'}</div>
    </div>`).join('');
}

/** Сохранение текущей партии в базу с переданными (отредактированными) тегами. */
export async function addCurrentToDb(headers, pdn) {
  if (!db) await loadWorking();
  const base = curBase(); if (!base) { showToast('Сначала создайте базу', 'error'); return; }
  const nextId = base.games.reduce((m, g) => Math.max(m, g.id || 0), 0) + 1;
  const rec = {
    id: nextId,
    white: headers.White || '?', black: headers.Black || '?', event: headers.Event || '?', site: headers.Site || '?',
    date: headers.Date || '?', round: headers.Round || '?', result: headers.Result || '*',
    pdn, createdAt: Date.now(),
  };
  if (selectedId) {
    const sel = base.games.find((g) => g.id === selectedId);
    if (sel && confirm(`Перезаписать выбранную партию\n«${sel.white} — ${sel.black}»?\n\nОК — перезаписать, Отмена — добавить как новую.`)) {
      rec.id = sel.id; rec.createdAt = sel.createdAt || Date.now();
      base.games = base.games.map((g) => (g.id === sel.id ? rec : g));
      showToast('Партия перезаписана');
    } else { base.games.push(rec); showToast('Партия добавлена как новая'); }
  } else { base.games.push(rec); showToast('Партия добавлена в базу'); }
  await persist(); renderBaseSelect(); renderList();
}

function wire() {
  /* файл базы данных */
  $('#gdb-new-db')?.addEventListener('click', async () => {
    if (!confirm('Создать новую пустую базу данных?\nТекущая будет закрыта (её файл на диске не изменяется).')) return;
    db = { name: 'Новая база данных', bases: [{ id: 1, name: 'Мои партии', games: [] }] };
    currentBaseId = 1; selectedId = null;
    await persist(); refreshUI();
    showToast('Создана новая база данных — сохраните её в файл');
  });
  $('#gdb-open-db')?.addEventListener('click', async () => {
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'База данных партий', accept: { 'application/json': ['.json'] } }] });
        const file = await h.getFile();
        applyDbText(await file.text());
        await setFileHandle(h);
        return;
      } catch (e) { if (e?.name === 'AbortError') return; }
    }
    let text;
    try { text = await pickAndReadFile($('#gdb-db-file'), '.json'); } catch (e) { showToast(e.message, 'error'); return; }
    if (text == null) return;
    applyDbText(text);
  });
  $('#gdb-save-db')?.addEventListener('click', async () => {
    if (!db) return;
    const text = serializeDb();
    const name = safeName(db.name) + '.json';
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'База данных партий', accept: { 'application/json': ['.json'] } }] });
        await writeToHandle(h, text);
        await setFileHandle(h);
        showToast('База данных сохранена в файл');
        return;
      } catch (e) { if (e?.name === 'AbortError') return; }
    }
    downloadText(name, text, 'application/json');
    showToast('База данных сохранена (скачивание)');
  });

  /* базы внутри файла */
  $('#gdb-base')?.addEventListener('change', (e) => { currentBaseId = Number(e.target.value); selectedId = null; renderList(); });
  $('#gdb-base-new')?.addEventListener('click', async () => {
    const name = prompt('Название новой базы:', 'Новая база'); if (!name) return;
    const id = db.bases.reduce((m, b) => Math.max(m, b.id || 0), 0) + 1;
    db.bases.push({ id, name, games: [] }); currentBaseId = id;
    await persist(); refreshUI();
  });
  $('#gdb-base-rename')?.addEventListener('click', async () => {
    const base = curBase(); if (!base) return;
    const name = prompt('Новое название базы:', base.name); if (!name) return;
    base.name = name; await persist(); refreshUI();
  });
  $('#gdb-base-del')?.addEventListener('click', async () => {
    const base = curBase(); if (!base) return;
    if (!confirm(`Удалить базу «${base.name}» и все её партии?`)) return;
    db.bases = db.bases.filter((b) => b.id !== base.id);
    if (!db.bases.length) db.bases.push({ id: 1, name: 'Мои партии', games: [] });
    currentBaseId = db.bases[0].id; selectedId = null;
    await persist(); refreshUI();
  });

  /* поиск/сортировка */
  $('#gdb-search-btn')?.addEventListener('click', () => { const inp = $('#gdb-search'); inp.hidden = !inp.hidden; if (!inp.hidden) inp.focus(); else { searchStr = ''; renderList(); } });
  $('#gdb-search')?.addEventListener('input', (e) => { searchStr = e.target.value; renderList(); });
  $('#gdb-sort')?.addEventListener('click', (e) => { sortMode = SORT_NEXT[sortMode]; e.currentTarget.title = SORT_TITLE[sortMode]; renderList(); });

  /* добавить партию — открывает диалог тегов (канал 'gdb' в main) */
  $('#gdb-add')?.addEventListener('click', () => {
    if (!curBase()) { showToast('Сначала создайте базу', 'error'); return; }
    document.dispatchEvent(new CustomEvent('app:gdb-add'));
  });

  $('#gdb-del')?.addEventListener('click', async () => {
    const base = curBase(); if (!base) return;
    if (!selectedId) { showToast('Сначала выберите партию в списке', 'error'); return; }
    base.games = base.games.filter((g) => g.id !== selectedId); selectedId = null;
    await persist(); renderBaseSelect(); renderList();
    showToast('Партия удалена из базы');
  });

  $('#gdb-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('.gdb-card'); if (!card) return;
    const base = curBase(); if (!base) return;
    const g = base.games.find((x) => x.id === Number(card.dataset.id)); if (!g) return;
    selectedId = g.id; renderList();
    loadPdnRef?.(g.pdn);
  });
}

function applyDbText(text) {
  try {
    db = normalizeDb(JSON.parse(text));
    currentBaseId = db.bases[0]?.id ?? null; selectedId = null;
    persist(); refreshUI();
    showToast(`Открыта база данных «${db.name}»`);
  } catch (e) { showToast('Файл не является базой данных: ' + e.message, 'error'); }
}