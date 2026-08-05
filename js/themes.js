/**
 * @module themes
 * Пикеры цветовой темы и скина доски/фигур. Полностью самодостаточен:
 * читает DOM, пишет data-атрибуты на <html> и настройки в storage.
 * Не зависит от игрового цикла и не образует циклических импортов.
 *
 * Механика: выбор темы/скина = установка [data-theme]/[data-board] на корне;
 * CSS-переменные делают всё остальное. Выбор запоминается в localStorage.
 * applyTheme/applyBoard экспортируются, чтобы их мог вызывать settings.js.
 */

import { savePrefs } from './storage.js';

/** Допустимые идентификаторы тем (должны совпадать с [data-theme] в CSS и data-theme в разметке). */
export const THEME_IDS = ['dark', 'light', 'forest', 'midnight', 'stone', 'wine', 'teal'];
/** Допустимые идентификаторы скинов доски (должны совпадать с [data-board] в CSS и разметке). */
export const BOARD_IDS = ['classic', 'marble', 'green', 'cherry', 'ocean', 'graphite', 'sand'];

const themePickerEl = () => document.querySelector('.theme-picker');
const boardPickerEl = () => document.querySelector('.board-picker');

export function closeThemeMenu() {
  themePickerEl()?.classList.remove('open');
  document.getElementById('theme-toggle')?.setAttribute('aria-expanded', 'false');
}
export function closeBoardMenu() {
  boardPickerEl()?.classList.remove('open');
  document.getElementById('board-toggle')?.setAttribute('aria-expanded', 'false');
}

/** Ставит галочку у текущей темы в списке. */
export function updateThemeMenu() {
  const cur = document.documentElement.dataset.theme;
  document.querySelectorAll('.theme-opt').forEach((b) => b.classList.toggle('active', b.dataset.theme === cur));
}
/** Ставит галочку у текущего скина в списке. */
export function updateBoardMenu() {
  const cur = document.documentElement.dataset.board;
  document.querySelectorAll('.board-opt').forEach((b) => b.classList.toggle('active', b.dataset.board === cur));
}

/** Применяет тему и сохраняет в настройки. Доступна внешним модулям (settings.js). */
export function applyTheme(id) {
  if (!THEME_IDS.includes(id)) return;
  document.documentElement.dataset.theme = id;
  savePrefs({ theme: id });
  updateThemeMenu();
}
/** Применяет скин доски и сохраняет в настройки. Доступна внешним модулям (settings.js). */
export function applyBoard(id) {
  if (!BOARD_IDS.includes(id)) return;
  document.documentElement.dataset.board = id;
  savePrefs({ board: id });
  updateBoardMenu();
}

/**
 * Вешает обработчики пикеров и глобальные клики/Escape для их закрытия.
 * Вызывается один раз из boot() после установки начальных data-атрибутов.
 */
export function bindThemePickers() {
  const tBtn = document.getElementById('theme-toggle');
  const bBtn = document.getElementById('board-toggle');

  tBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeBoardMenu();
    const open = themePickerEl()?.classList.toggle('open');
    tBtn?.setAttribute('aria-expanded', String(open));
  });
  bBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeThemeMenu();
    const open = boardPickerEl()?.classList.toggle('open');
    bBtn?.setAttribute('aria-expanded', String(open));
  });

  document.querySelectorAll('.theme-opt').forEach((b) =>
    b.addEventListener('click', () => { applyTheme(b.dataset.theme); closeThemeMenu(); }));
  document.querySelectorAll('.board-opt').forEach((b) =>
    b.addEventListener('click', () => { applyBoard(b.dataset.board); closeBoardMenu(); }));

  // клик вне пикеров сворачивает их
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.theme-picker')) closeThemeMenu();
    if (!e.target.closest('.board-picker')) closeBoardMenu();
  });
  // Escape сворачивает пикеры (безвредно, когда закрыты)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeThemeMenu(); closeBoardMenu(); }
  });
}