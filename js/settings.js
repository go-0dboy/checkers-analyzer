/**
 * @module settings
 * Кнопка-шестерёнка и модалка настроек.
 * Строки панелей в секциях «анализ» и «расстановка» рендерятся динамически:
 * панели группируются по колонке (сначала правые, разделитель, потом левые),
 * а внутри колонки — по порядку. Стрелки ↑/↓ визуально переставляют строки
 * в списке и сохраняют фокус на нажатой кнопке.
 */
import { savePrefs, loadPrefs } from './storage.js';
import { THEME_IDS, BOARD_IDS, applyTheme, applyBoard } from './themes.js';

const DEFAULT_PANELS = { players: true, meta: true, notation: true, library: true, openings: true, setupTags: true, setupFen: true };
export function getPanelPrefs() {
  const p = loadPrefs();
  return Object.assign({}, DEFAULT_PANELS, p.panels || {});
}

const DEFAULT_SIDES = { meta: 'right', notation: 'right', library: 'right', openings: 'right', setupTags: 'right' };
export function getSidePrefs() {
  const p = loadPrefs();
  return Object.assign({}, DEFAULT_SIDES, p.sides || {});
}

const DEFAULT_ORDER = {
  analyze: { meta: 0, notation: 1, openings: 2, library: 3 },
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

  themeBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set-theme]'); if (!b) return;
    applyTheme(b.dataset.setTheme); refreshActive();
  });
  boardBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set-board]'); if (!b) return;
    applyBoard(b.dataset.setBoard); refreshActive();
  });

  // Делегирование всех событий панелей на модалку — перерисовка не ломает обработчики
  modal.addEventListener('change', (e) => {
    if (e.target.matches('input[data-panel]')) {
      const p = loadPrefs();
      const panels = Object.assign({}, DEFAULT_PANELS, p.panels || {});
      panels[e.target.dataset.panel] = e.target.checked;
      savePrefs({ panels });
      document.dispatchEvent(new CustomEvent('app:settings'));
    }
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
      const newBtn = modal.querySelector(`.set-side[data-side-for="${key}"] button[data-side="${sideBtn.dataset.side}"]`);
      newBtn?.focus();
      return;
    }
    const orderBtn = e.target.closest('.set-order button');
    if (orderBtn) {
      const key = orderBtn.closest('.set-order').dataset.orderFor;
      const dir = orderBtn.dataset.order === 'up' ? -1 : 1;
      movePanel(key, dir);
      const newBtn = modal.querySelector(`.set-order[data-order-for="${key}"] button[data-order="${orderBtn.dataset.order}"]`);
      if (newBtn && !newBtn.disabled) newBtn.focus();
      return;
    }
  });

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

  function keysInColOf(key) {
    const sides = getSidePrefs();
    const order = getOrderPrefs();
    const mode = MODE_OF[key] || 'analyze';
    const col = (sides[key] || 'right') === 'left' ? 'left' : 'right';
    return Object.keys(sides)
      .filter((k) => (MODE_OF[k] || 'analyze') === mode && ((sides[k] || 'right') === 'left' ? 'left' : 'right') === col)
      .sort((a, b) => (order[mode][a] ?? 0) - (order[mode][b] ?? 0));
  }

  function refreshActive() {
    const t = document.documentElement.dataset.theme, b = document.documentElement.dataset.board;
    themeBox.querySelectorAll('[data-set-theme]').forEach((el) => el.classList.toggle('active', el.dataset.setTheme === t));
    boardBox.querySelectorAll('[data-set-board]').forEach((el) => el.classList.toggle('active', el.dataset.setBoard === b));
  }

  /** Генерирует HTML-строку одной панели с нужным набором контролов. */
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
        const upDis = idx <= 0 ? 'disabled' : '';
        const dnDis = idx >= list.length - 1 ? 'disabled' : '';
        controls += `<span class="set-order" data-order-for="${key}">
          <button type="button" data-order="up" title="Выше" ${upDis}>↑</button>
          <button type="button" data-order="down" title="Ниже" ${dnDis}>↓</button>
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

  /** Полная перерисовка строк панелей в обеих секциях. Группирует по колонке. */
  function renderPanelRows() {
    const sides = getSidePrefs();
    const order = getOrderPrefs();

    // --- Анализ: players + боковые панели (right → divider → left) ---
    const analyzeSideKeys = ['meta', 'notation', 'openings', 'library'];
    const rightKeys = analyzeSideKeys
      .filter(k => (sides[k] || 'right') === 'right')
      .sort((a, b) => (order.analyze[a] ?? 0) - (order.analyze[b] ?? 0));
    const leftKeys = analyzeSideKeys
      .filter(k => (sides[k] || 'right') === 'left')
      .sort((a, b) => (order.analyze[a] ?? 0) - (order.analyze[b] ?? 0));
    let analyzeHtml = buildRow('players', false, false);
    for (const k of rightKeys) analyzeHtml += buildRow(k, true, true);
    if (leftKeys.length > 0) analyzeHtml += '<div class="set-divider"></div>';
    for (const k of leftKeys) analyzeHtml += buildRow(k, true, true);
    document.getElementById('set-analyze-rows').innerHTML = analyzeHtml;

    // --- Расстановка: setupTags (со стороной) + setupFen (только видимость) ---
    const setupSideKeys = ['setupTags'];
    const rightSetup = setupSideKeys.filter(k => (sides[k] || 'right') === 'right');
    const leftSetup = setupSideKeys.filter(k => (sides[k] || 'right') === 'left');
    let setupHtml = '';
    for (const k of rightSetup) setupHtml += buildRow(k, true, true);
    if (leftSetup.length > 0 && rightSetup.length > 0) setupHtml += '<div class="set-divider"></div>';
    for (const k of leftSetup) setupHtml += buildRow(k, true, true);
    setupHtml += buildRow('setupFen', false, false);
    document.getElementById('set-setup-rows').innerHTML = setupHtml;
  }

  const open = () => { renderPanelRows(); refreshActive(); modal.hidden = false; };
  const close = () => { modal.hidden = true; };

  gear.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
}