/**
 * @module settings
 * Кнопка-шестерёнка и модалка настроек.
 * В каждой секции сначала идут НЕперемещаемые «центральные» панели (отделены
 * разделителем), затем перемещаемые, сгруппированные по колонке:
 * сначала правые, разделитель, затем левые.
 * Стрелки ↑/↓ визуально переставляют строки и сохраняют фокус.
 */
import { savePrefs, loadPrefs } from './storage.js';
import { THEME_IDS, BOARD_IDS, updateThemeMenu, updateBoardMenu } from './themes.js';

/* ── значения по умолчанию (новая раскладка v2) ─────────────────── */
const DEFAULT_PANELS = { players: false, meta: true, notation: true, library: true, openings: true, setupTags: true, setupFen: true };
export function getPanelPrefs() {
  const p = loadPrefs();
  return Object.assign({}, DEFAULT_PANELS, p.panels || {});
}

const DEFAULT_SIDES = { meta: 'left', notation: 'right', library: 'left', openings: 'left', setupTags: 'right' };
export function getSidePrefs() {
  const p = loadPrefs();
  return Object.assign({}, DEFAULT_SIDES, p.sides || {});
}

const DEFAULT_ORDER = {
  analyze: { meta: 0, library: 1, openings: 2, notation: 0 },
  setup:   { setupTags: 0 },
};
export function getOrderPrefs() {
  const p = loadPrefs();
  const o = p.order || {};
  return {
    analyze: Object.assign({}, DEFAULT_ORDER.analyze, o.analyze || {}),
    setup:   Object.assign({}, DEFAULT_ORDER.setup,   o.setup   || {}),
  };
}
const MODE_OF = { meta: 'analyze', notation: 'analyze', openings: 'analyze', library: 'analyze', setupTags: 'setup' };

const THEME_NAMES = { dark: 'Орех', light: 'Пергамент', forest: 'Изумруд', midnight: 'Полночь', stone: 'Камень', wine: 'Бордо', teal: 'Океан' };
const BOARD_NAMES = { classic: 'Классика', marble: 'Мрамор', green: 'Сукно', cherry: 'Вишня', ocean: 'Океан', graphite: 'Графит', sand: 'Песок' };
const PANEL_LABELS = {
  players: 'Панель игроков',
  meta: 'Панель партии',
  notation: 'Панель нотации',
  openings: 'Панель дебютов',
  library: 'Панель библиотеки',
  setupTags: 'Панель тегов',
  setupFen: 'Панель FEN',
};

/* локальные apply, чтобы не зависеть от экспортов themes.js */
function applyTheme(id) { if (!THEME_IDS.includes(id)) return; document.documentElement.dataset.theme = id; savePrefs({ theme: id }); updateThemeMenu(); }
function applyBoard(id) { if (!BOARD_IDS.includes(id)) return; document.documentElement.dataset.board = id; savePrefs({ board: id }); updateBoardMenu(); }

export function initSettings() {
  const gear = document.getElementById('settings-toggle');
  const modal = document.getElementById('settings-modal');
  if (!gear || !modal) return;

  const themeBox = modal.querySelector('#set-themes');
  const boardBox = modal.querySelector('#set-boards');

  themeBox.innerHTML = THEME_IDS.map((id) =>
    `<button class="set-opt" data-set-theme="${id}"><span class="set-swatch set-swatch-${id}"></span><span class="set-name">${THEME_NAMES[id] || id}</span></button>`).join('');
  boardBox.innerHTML = BOARD_IDS.map((id) =>
    `<button class="set-opt" data-set-board="${id}"><span class="set-swatch set-board-${id}"></span><span class="set-name">${BOARD_NAMES[id] || id}</span></button>`).join('');

  themeBox.addEventListener('click', (e) => { const b = e.target.closest('[data-set-theme]'); if (!b) return; applyTheme(b.dataset.setTheme); refreshActive(); });
  boardBox.addEventListener('click', (e) => { const b = e.target.closest('[data-set-board]'); if (!b) return; applyBoard(b.dataset.setBoard); refreshActive(); });

  /* делегирование событий панелей */
  modal.addEventListener('change', (e) => {
    if (e.target.matches('input[data-panel]')) {
      const p = loadPrefs();
      const panels = Object.assign({}, DEFAULT_PANELS, p.panels || {});
      panels[e.target.dataset.panel] = e.target.checked;
      savePrefs({ panels });
      document.dispatchEvent(new CustomEvent('app:settings'));
    }
    // тумблеры автохода/автобоя
  modal.querySelectorAll('input[data-auto]').forEach((cb) => {
      cb.addEventListener('change', () => {
        savePrefs(cb.dataset.auto === 'move' ? { autoMove: cb.checked } : { autoCapture: cb.checked });
      });
    });    
  });

  modal.addEventListener('click', (e) => {
    const sideBtn = e.target.closest('.set-side button');
    if (sideBtn) {
      const key = sideBtn.closest('.set-side').dataset.sideFor;
      const p = loadPrefs();
      const sides = Object.assign({}, DEFAULT_SIDES, p.sides || {});
      sides[key] = sideBtn.dataset.side;
      savePrefs({ sides });
      renderPanelRows();
      document.dispatchEvent(new CustomEvent('app:settings'));
      modal.querySelector(`.set-side[data-side-for="${key}"] button[data-side="${sideBtn.dataset.side}"]`)?.focus();
      return;
    }
    const orderBtn = e.target.closest('.set-order button');
    if (orderBtn) {
      const key = orderBtn.closest('.set-order').dataset.orderFor;
      movePanel(key, orderBtn.dataset.order === 'up' ? -1 : 1);
      const nb = modal.querySelector(`.set-order[data-order-for="${key}"] button[data-order="${orderBtn.dataset.order}"]`);
      if (nb && !nb.disabled) nb.focus();
      return;
    }
  });

  function keysInColOf(key) {
    const sides = getSidePrefs();
    const order = getOrderPrefs();
    const mode = MODE_OF[key] || 'analyze';
    const col = (sides[key] || 'right') === 'left' ? 'left' : 'right';
    return Object.keys(sides)
      .filter((k) => (MODE_OF[k] || 'analyze') === mode && ((sides[k] || 'right') === 'left' ? 'left' : 'right') === col)
      .sort((a, b) => (order[mode][a] ?? 0) - (order[mode][b] ?? 0));
  }

  function movePanel(key, dir) {
    const order = getOrderPrefs();
    const mode = MODE_OF[key] || 'analyze';
    const list = keysInColOf(key);
    const idx = list.indexOf(key);
    const swapWith = list[idx + dir];
    if (swapWith === undefined) return;
    const next = { analyze: { ...order.analyze }, setup: { ...order.setup } };
    const tmp = next[mode][key]; next[mode][key] = next[mode][swapWith]; next[mode][swapWith] = tmp;
    savePrefs({ order: next });
    renderPanelRows();
    document.dispatchEvent(new CustomEvent('app:settings'));
  }

  function refreshActive() {
    const t = document.documentElement.dataset.theme, b = document.documentElement.dataset.board;
    themeBox.querySelectorAll('[data-set-theme]').forEach((el) => el.classList.toggle('active', el.dataset.setTheme === t));
    boardBox.querySelectorAll('[data-set-board]').forEach((el) => el.classList.toggle('active', el.dataset.setBoard === b));
  }

  function buildRow(key, withSide, withOrder) {
    const panels = getPanelPrefs();
    const sides = getSidePrefs();
    const checked = panels[key] ? 'checked' : '';
    let controls = '';
    if (withOrder || withSide) {
      controls = '<span class="set-row-controls">';
      if (withOrder) {
        const list = keysInColOf(key);
        const idx = list.indexOf(key);
        controls += `<span class="set-order" data-order-for="${key}">
          <button type="button" data-order="up" title="Выше" ${idx <= 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-order="down" title="Ниже" ${idx >= list.length - 1 ? 'disabled' : ''}>↓</button>
        </span>`;
      }
      if (withSide) {
        const side = sides[key] || 'right';
        controls += `<span class="set-side" data-side-for="${key}">
          <button type="button" data-side="left" class="${side === 'left' ? 'active' : ''}">слева</button>
          <button type="button" data-side="right" class="${side === 'right' ? 'active' : ''}">справа</button>
        </span>`;
      }
      controls += '</span>';
    }
    return `<div class="set-row" data-panel-row="${key}">
      <label class="set-check"><input type="checkbox" data-panel="${key}" ${checked}> ${PANEL_LABELS[key]}</label>
      ${controls}
    </div>`;
  }

  /** Секция: сначала фиксированные (центр), разделитель, затем правые, разделитель, левые. */
  function buildSection(containerId, fixedKeys, sideKeys, mode) {
    const sides = getSidePrefs();
    const order = getOrderPrefs()[mode] || {};
    let html = '';
    for (const k of fixedKeys) html += buildRow(k, false, false);
    const right = sideKeys.filter((k) => (sides[k] || 'right') === 'right').sort((a, b) => (order[a] ?? 0) - (order[b] ?? 0));
    const left  = sideKeys.filter((k) => (sides[k] || 'right') === 'left').sort((a, b) => (order[a] ?? 0) - (order[b] ?? 0));
    if (right.length || left.length) {
      if (fixedKeys.length) html += '<div class="set-divider"></div>';
      for (const k of right) html += buildRow(k, true, true);
      if (right.length && left.length) html += '<div class="set-divider"></div>';
      for (const k of left) html += buildRow(k, true, true);
    }
    document.getElementById(containerId).innerHTML = html;
  }

  function renderPanelRows() {
    buildSection('set-analyze-rows', ['players'], ['meta', 'notation', 'openings', 'library'], 'analyze');
    buildSection('set-setup-rows', ['setupFen'], ['setupTags'], 'setup');
  }

  const open = () => { renderPanelRows(); refreshActive(); 
    const ap = getAutoPrefs();
    modal.querySelectorAll('input[data-auto]').forEach((cb) => {
      cb.checked = cb.dataset.auto === 'move' ? ap.move : ap.capture;
    });
    modal.hidden = false; 
  };

  const close = () => { modal.hidden = true; };

  gear.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
}

/** Автоход/автобой: включены по умолчанию, отключаются явно (false). */
export function getAutoPrefs() {
  const p = loadPrefs();
  return { move: p.autoMove !== false, capture: p.autoCapture !== false };
}