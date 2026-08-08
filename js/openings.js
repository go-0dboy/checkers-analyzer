/**
 * @module openings
 * Панель «Дебюты» на IndexedDB (сид из data/ по манифесту).
 * Дебют — кандидат, если сыгранная линия совпадает с любой его линией (префикс).
 * Админ (?admin=1): кнопка «✎» в шапке панели — импорт/экспорт JSON базы,
 * удаление дебютов, перечитывание. Экспортированный файл можно положить в
 * data/ и добавить в manifest.json — база станет поставляемой по умолчанию.
 */
import { nameToIdx } from './engine.js';
import { idbAll, idbSeedIfEmpty} from './idb.js';

const ADMIN_KEY = 'ru-checkers-analyzer:admin';
let openings = [];
let currentList = [];
let tipEl = null;
let adminMode = false;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initOpeningsUI({ history }) {
  load().then(() => {
    document.addEventListener('app:sync', () => { hideTip(); render(history); });
    render(history);
    wireHelp();
  });
}

async function load() {
  await idbSeedIfEmpty();
  openings = (await idbAll('openings')).map(normalize);
}
function normalize(o) {
  o.lines = (o.lines || []).map((line) => line.map((m) => {
    const sq = String(m).toLowerCase().split(/[x:×-]/);
    return { from: nameToIdx(sq[0]), to: nameToIdx(sq[sq.length - 1]), str: m };
  }));
  return o;
}
function lineMatches(line, played) {
  const L = Math.min(line.length, played.length);
  for (let i = 0; i < L; i++) {
    if (line[i].from !== played[i].from || line[i].to !== played[i].to) return false;
  }
  return true;
}

function render(history) {
  const body = document.getElementById('openings-body');
  const cnt = document.getElementById('openings-count');
  if (!body) return;
  const played = [];
  let n = history.current;
  while (n && n.move) { played.unshift(n.move); n = n.parent; }
  currentList = [];
  if (!played.length) {
    if (cnt) cnt.textContent = '0';
    body.innerHTML = '<div class="lib-empty">Сделайте ход — покажу подходящие дебюты</div>';
    return;
  }
  const cands = openings
    .map((o) => {
      const matching = o.lines.filter((l) => lineMatches(l, played));
      if (!matching.length) return null;
      return { o, line: matching[0], variants: matching.length, done: matching.some((l) => played.length >= l.length) };
    })
    .filter(Boolean);
  if (cnt) cnt.textContent = String(cands.length);
  if (!cands.length) { body.innerHTML = '<div class="lib-empty">Дебют не найден — линия не совпадает ни с одним дебютом базы</div>'; return; }
  cands.sort((a, b) => (b.done - a.done) || (b.variants - a.variants) || (b.line.length - a.line.length));
  body.innerHTML = cands.slice(0, 12).map(({ o, line, variants, done }, i) => {
    currentList[i] = o;
    const seqHtml = line.map((x, idx) => `<span class="open-mv${idx < played.length ? ' played' : ''}">${esc(x.str)}</span>`).join(' ');
    return `<div class="open-group${done ? ' done' : ''}">
      <div class="open-head">
        <span class="open-name">${esc(o.name)}</span>
        <span class="open-badges">
          ${variants > 1 ? `<span class="open-var" title="Согласованных вариантов: ${variants}">${variants} вар.</span>` : ''}
          ${done ? '<span class="open-badge">определён</span>' : ''}
          <button class="open-help" data-i="${i}" title="О дебюте" aria-label="О дебюте">?</button>
        </span>
      </div>
      <div class="open-line">${seqHtml}</div>
    </div>`;
  }).join('');
}

function wireHelp() {
  const body = document.getElementById('openings-body');
  if (!body) return;
  body.addEventListener('click', (e) => {
    const h = e.target.closest('.open-help');
    if (!h) return;
    e.stopPropagation();
    const i = Number(h.dataset.i);
    const o = currentList[i];
    if (!o) return;
    if (tipEl && !tipEl.hidden && tipEl.dataset.for === 'O' + i) { hideTip(); return; }
    showTip(h, o.desc || o.name, 'O' + i);
  });
  body.addEventListener('scroll', hideTip, { passive: true });
  document.addEventListener('click', (e) => { if (tipEl && !tipEl.hidden && !e.target.closest('.open-help')) hideTip(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('resize', hideTip);
}
function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'open-tip'; tipEl.className = 'open-tip'; tipEl.hidden = true;
    document.body.appendChild(tipEl);
    tipEl.addEventListener('click', (e) => e.stopPropagation());
  }
  return tipEl;
}
function hideTip() { if (tipEl) tipEl.hidden = true; }
function showTip(btn, text, key) {
  const tip = ensureTip();
  tip.textContent = text; tip.dataset.for = key; tip.hidden = false;
  const r = btn.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = r.left - tw - 10;
  if (left < 8) left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
  let top = r.top - 4;
  if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;
  if (top < 8) top = 8;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}

