/**
 * @module toast
 * Всплывающие уведомления. Один DOM-элемент #toast, перезаписываемый по вызову.
 * type: 'ok' | 'error'. Автоскрытие через ms миллисекунд.
 */

let toastTimer = null;

/**
 * Показывает тост.
 * @param {string} message текст
 * @param {'ok'|'error'} [type='ok']
 * @param {number} [ms=2600] время показа
 */
export function showToast(message, type = 'ok', ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}