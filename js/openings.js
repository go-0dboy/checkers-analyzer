/**
 * @module openings
 * Панель «Дебюты» в режиме анализа. Читает data/openings.json.
 * У дебюта может быть НЕСКОЛЬКО линий (варианты и перестановки ходов):
 * дебют считается кандидатом, если сыгранная линия совпадает (по клеткам
 * from/to) с любой из его линий; когда линия поглощена — дебют «определён».
 * Под названием выводится согласованная линия; сыгранные ходы подсвечены;
 * если согласовано несколько линий — показан счётчик «N вар.».
 * Выводятся ВСЕ найденные дебюты (без ограничения).
 * Справа от названия — знак «?»: по клику всплывающая подсказка с описанием.
 */
import { nameToIdx } from './engine.js';

const OPENINGS_URL = 'data/openings.json';
let openings = [];
let currentList = [];   // то, что сейчас отрисовано (для подсказки по индексу)
let tipEl = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initOpeningsUI({ history }) {
  load().then(() => {
    document.addEventListener('app:sync', () => { hideTip(); render(history); });
    render(history);
    wireHelp();
  });
}

async function load() {
  try {
    const r = await fetch(OPENINGS_URL, { cache: 'no-store' });
    if (r.ok) openings = ((await r.json()).openings || []).map(normalize);
  } catch { openings = []; }
}

function normalize(o) {
  o.lines = (o.lines || []).map((line) => line.map((m) => {
    const sq = String(m).toLowerCase().split(/[x:×-]/);
    return { from: nameToIdx(sq[0]), to: nameToIdx(sq[sq.length - 1]), str: m };
  }));
  return o;
}

/** Линия совпадает с сыгранной по всем общим ходам. */
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

  // Кандидаты: дебюты, у которых хотя бы одна линия согласована с сыгранной.
  const cands = openings
    .map((o) => {
      const matching = o.lines.filter((l) => lineMatches(l, played));
      if (!matching.length) return null;
      return {
        o,
        line: matching[0],                                   // основная согласованная линия
        variants: matching.length,                           // сколько линий ещё согласованы
        done: matching.some((l) => played.length >= l.length), // линия поглощена — дебют определён
      };
    })
    .filter(Boolean);

  if (cnt) cnt.textContent = String(cands.length);
  if (!cands.length) {
    body.innerHTML = '<div class="lib-empty">Дебют не найден — линия не совпадает ни с одним дебютом базы</div>';
    return;
  }

  cands.sort((a, b) => (b.done - a.done) || (b.variants - a.variants) || (b.line.length - a.line.length));

  // ВСЕ найденные дебюты (без slice) — панель прокручивается.
  body.innerHTML = cands.map(({ o, line, variants, done }, i) => {
    currentList[i] = o;
    const seqHtml = line
      .map((x, idx) => `<span class="open-mv${idx < played.length ? ' played' : ''}">${esc(x.str)}</span>`)
      .join(' ');
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

/* ── всплывающая подсказка ───────────────────────────────────────── */
function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'open-tip';
    tipEl.className = 'open-tip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
    tipEl.addEventListener('click', (e) => e.stopPropagation());
  }
  return tipEl;
}
function hideTip() { if (tipEl) tipEl.hidden = true; }

function showTip(btn, text) {
  const tip = ensureTip();
  tip.textContent = text;
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
    if (tipEl && !tipEl.hidden && tipEl.dataset.for === String(i)) { hideTip(); tipEl.dataset.for = ''; return; }
    ensureTip().dataset.for = String(i);
    showTip(h, o.desc || o.name);
  });

  document.addEventListener('click', (e) => {
    if (tipEl && !tipEl.hidden && !e.target.closest('.open-help')) hideTip();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  body.addEventListener('scroll', hideTip, { passive: true });
  window.addEventListener('resize', hideTip);
}