/**
 * @module storage
 * Ввод-вывод, не связанный с игрой: файлы, буфер обмена, локальные настройки.
 * Хранилище настроек (тема, скин, ориентация) — localStorage под одним ключом.
 */

/** Диалог выбора файла → текст (null если отменено). */
export function pickAndReadFile(inputEl, accept = '.pdn,.txt') {
  return new Promise((resolve, reject) => {
    inputEl.accept = accept;
    inputEl.value = '';
    const cleanup = () => { inputEl.removeEventListener('change', onChange); inputEl.removeEventListener('cancel', onCancel); };
    const onChange = async () => {
      const file = inputEl.files?.[0];
      cleanup();
      if (!file) return resolve(null);
      try { resolve(await file.text()); }
      catch (e) { reject(new Error(`Не удалось прочитать файл: ${e.message}`)); }
    };
    const onCancel = () => { cleanup(); resolve(null); };
    inputEl.addEventListener('change', onChange);
    inputEl.addEventListener('cancel', onCancel);
    inputEl.click();
  });
}

/** Скачивание текста как файла (Blob + временная ссылка). */
export function downloadText(filename, text, mime = 'application/x-draughts-pdn') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 800);
}

/** Имя файла PDN из тегов (имена игроков + дата). */
export function suggestFilename(headers = {}) {
  const parts = [headers.White, headers.Black, headers.Date].filter((v) => v && v !== '?');
  const base = parts.length ? parts.join('-') : 'partiya';
  return base.replace(/[^\wа-яёА-ЯЁ.\-]+/g, '_').slice(0, 80) + '.pdn';
}

/** Запись текста в буфер обмена (Clipboard API с фолбэком на execCommand). */
export async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* фолбэк ниже */ }
  }
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:-9999px;opacity:0';
  document.body.appendChild(area); area.select(); area.setSelectionRange(0, text.length);
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Браузер не дал доступа к буферу обмена');
}

/** Чтение текста из буфера обмена. */
export async function readTextFromClipboard() {
  if (!navigator.clipboard?.readText) throw new Error('Нет доступа к буферу обмена — вставьте PDN вручную');
  try { return await navigator.clipboard.readText(); }
  catch { throw new Error('Нет доступа к буферу обмена — вставьте PDN вручную'); }
}

const PREFS_KEY = 'ru-checkers-analyzer:prefs';

/** Читает объект настроек ({} при ошибке/отсутствии). */
export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}; }
  catch { return {}; }
}

/** Сливает patch в настройки и сохраняет; возвращает итоговый объект. */
export function savePrefs(patch) {
  try {
    const merged = { ...loadPrefs(), ...patch };
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
    return merged;
  } catch { return {}; }
}