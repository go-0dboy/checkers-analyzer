/**
 * @module pdn
 * Разбор и генерация PDN 3.0 (стандарт Wieger Wesselink, rel. 3.0).
 *
 * Принцип «чтение либерально, запись строго» (стандарт, §1.2):
 *   • при ЗАПИСИ соблюдаем grammar §4.1 + restrictions §4.2;
 *   • при ЧТЕНИИ используем reading grammar §4.4 (разделитель взятия [x:],
 *     многоточия, лидирующие нули и т.п.) и терпим распространённые вольности.
 *
 * Соответствие стандарту (ссылки на разделы):
 *   §3   теги (Event/Site/Date/Round/White/Black/Result/GameType/FEN …);
 *   §4.1 grammar: теги, ходы, вариации ( ), комментарии { }, NAG $n;
 *   §4.2 restriction 7 — разделитель взятия по GameType;
 *   §4.2 restriction 8/9 — полная запись неоднозначных взятий (чтение терпит обе);
 *   §4.3 комментарии в фигурных скобках, вложенные вариации;
 *   §4.4 reading grammar — CAPTURESEPARATOR [x:], ELLIPSES, liberal tokens;
 *   §10  FEN (терпим завершающую точку и слитный цвет секции);
 *   §11  GameType → ResultType + capture separator (25/41 → ':').
 *
 * Комментарии привязываются к ходам в двух фазах (до/после), чтобы round-trip
 * сохранял их позицию. Вариация «( … )» после хода X кладётся как СИБЛИНГ X
 * (ребёнок родителя X), а не как его продолжение — иначе магистраль и ветка
 * менялись бы местами при повторной загрузке.
 */

import {
  WHITE, BLACK,
  initialState, makeMove, findMoves, nameToIdx,
  moveToString, stateToFEN, fenToState, getGameStatus, sepForGameType, setCaptureSep,
} from './engine.js';

// Токены: комментарий ловится целиком; порядок альтернатив не важен.
const TOKEN_RE = /\{[^}]*\}|\(|\)|1\/2-1\/2|\d+-\d+|\*|\d+\.+|[a-h][1-8](?:[x:×-][a-h][1-8])+/gi;

function tokenize(text) {
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const gap = text.slice(last, m.index);
    if (gap.trim()) throw new Error(`Непонятный фрагмент в тексте партии: «${gap.trim().slice(0, 24)}…»`);
    last = m.index + m[0].length;
    const raw = m[0];
    if (raw[0] === '{') tokens.push({ type: 'comment', value: raw.slice(1, -1) });
    else if (raw === '(') tokens.push({ type: 'open' });
    else if (raw === ')') tokens.push({ type: 'close' });
    else if (/^(1-0|0-1|1\/2-1\/2|\*|\d+-\d+)$/.test(raw)) tokens.push({ type: 'result', value: raw });
    else if (/^\d/.test(raw)) tokens.push({ type: 'number' });
    else tokens.push({ type: 'move', raw, squares: raw.toLowerCase().split(/[x:×-]/) });
  }
  if (text.slice(last).trim()) throw new Error(`Непонятный фрагмент в конце текста: «${text.slice(last).trim().slice(0, 24)}…»`);
  return tokens;
}

/** Разрешает ход по списку имён клеток: точное совпадение пути, иначе частичное, иначе первый кандидат. */
function resolveMove(state, names, raw) {
  const path = names.map(nameToIdx);
  const bad = names.find((_, k) => path[k] < 0);
  if (bad) throw new Error(`Неизвестная клетка «${bad}» в ходе «${raw}»`);
  const from = path[0], to = path[path.length - 1];
  const candidates = findMoves(state, from, to);
  if (candidates.length === 0) throw new Error(`Ход «${raw}» недопустим в этой позиции — проверьте предыдущие ходы`);
  if (path.length > 2) {
    const exact = candidates.find((m) => m.path.length === path.length && m.path.every((s, k) => s === path[k]));
    if (exact) return exact;
    const partial = candidates.find((m) => { let k = 0; for (const s of m.path) if (s === path[k]) k++; return k === path.length; });
    if (partial) return partial;
  }
  return candidates[0];
}

/**
 * Рекурсивный разбор последовательности ходов на одном уровне.
 * Вариации уходят в lastHome (сиблинги lastNode), комментарии до первого хода
 * уровня — в pendingBefore этого хода.
 */
function parseSequence(tokens, pos, state, container, depth) {
  let cur = state, lastNode = null, lastHome = container, result = null, pendingBefore = [];
  while (pos.i < tokens.length) {
    const t = tokens[pos.i];
    switch (t.type) {
      case 'number': pos.i++; break;
      case 'result': result = t.value; pos.i++; break;
      case 'close':
        if (depth === 0) throw new Error('Лишняя закрывающая скобка «)» в тексте партии');
        return { state: cur, result };
      case 'comment':
        if (lastNode) lastNode.commentsAfter.push(t.value);
        else pendingBefore.push(t.value);
        pos.i++;
        break;
      case 'open': {
        if (!lastNode) throw new Error('Вариация «(» встречается до хода, который она заменяет');
        pos.i++;
        const sub = parseSequence(tokens, pos, lastNode.before, lastHome, depth + 1); // ВАЖНО: lastHome, не lastNode.children
        if (tokens[pos.i]?.type !== 'close') throw new Error('Вариация не закрыта скобкой «)»');
        pos.i++;
        if (sub.result) result = sub.result;
        break;
      }
      case 'move': {
        const move = resolveMove(cur, t.squares, t.raw);
        const next = makeMove(cur, move);
        const node = { move, state: next, before: cur, children: [], commentsBefore: pendingBefore, commentsAfter: [] };
        pendingBefore = [];
        const home = lastNode ? lastNode.children : container;
        home.push(node);
        lastHome = home; lastNode = node; cur = next; pos.i++;
        break;
      }
    }
  }
  return { state: cur, result };
}

/**
 * Парсит PDN-текст.
 * @returns {{headers:Object, result:string|null, rootState:Object, tree:Array}}
 */
export function parsePDN(text) {
  if (!text || !text.trim()) throw new Error('Пустой текст PDN');
  const headers = {};
  const tagRe = /\[\s*([A-Za-z]\w*)\s+"([^"]*)"\s*\]/g;
  let m;
  while ((m = tagRe.exec(text))) headers[m[1]] = m[2];

  // чистим всё КРОМЕ комментариев {...} (их парсим как токены)
  const moveText = text
    .replace(/\[\s*[A-Za-z]\w*\s+"[^"]*"\s*\]/g, ' ')
    .replace(/;[^\n]*/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/%[^\n]*/g, ' ')
    .replace(/[!?]+/g, ' ');
  const tokens = tokenize(moveText);

  let rootState;
  if (headers.FEN) {
    try { rootState = fenToState(headers.FEN); }
    catch (e) { throw new Error(`Некорректный тег [FEN]: ${e.message}`); }
  } else {
    rootState = initialState();
  }
  // разделитель взятия для отображения/записи — из GameType (§11), иначе ':'
  setCaptureSep(headers.GameType ? sepForGameType(headers.GameType) : ':');

  const tree = [];
  const pos = { i: 0 };
  const parsed = parseSequence(tokens, pos, rootState, tree, 0);
  if (tree.length === 0 && Object.keys(headers).length === 0) throw new Error('В тексте не найдено ни тегов, ни ходов');
  return { headers, result: parsed.result ?? headers.Result ?? null, rootState, tree };
}

const pad2 = (n) => String(n).padStart(2, '0');
/** Дата в формате PDN YYYY.MM.DD (§3 Date). */
export function formatDate(date = new Date()) {
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

/** Авто-результат по конечной позиции магистрали. */
export function detectResult(history) {
  let node = history.root;
  while (node.children.length) node = node.children[0];
  const status = getGameStatus(node.state);
  if (!status.over) return '*';
  if (status.winner === WHITE) return '1-0';
  if (status.winner === BLACK) return '0-1';
  return '1/2-1/2';
}

/** Экранирование комментария для записи (PDN не допускает } внутри {…}). */
const safeComment = (s) => String(s).replace(/[{}]/g, '').trim();

/**
 * Генерирует PDN-текст по истории и тегам. Нумерация совпадает с отображением
 * и со стандартом; комментарии и вариации воспроизводятся на своих местах.
 */
export function generatePDN(history, headers = {}) {
  const root = history.root;
  const result = headers.Result ?? detectResult(history);
  const merged = { Event: '?', Site: '?', Date: formatDate(), Round: '?', White: '?', Black: '?', ...headers, Result: result };
  const tagLines = Object.entries(merged).map(([k, v]) => `[${k} "${v}"]`);
  if (stateToFEN(root.state) !== stateToFEN(initialState())) {
    tagLines.push(`[SetUp "1"]`, `[FEN "${stateToFEN(root.state)}"]`);
  }
  const tokens = [];
  const numText = (ply) => `${Math.floor(ply / 2) + 1}.${ply % 2 === 0 ? '' : '..'}`;
  const pushComments = (node, phase) => {
    for (const c of (node[phase] || [])) { const t = safeComment(c); if (t) tokens.push('{' + t + '}'); }
  };
  const fromNode = (node, ply) => {
    pushComments(node, 'commentsBefore');
    tokens.push(numText(ply), moveToString(node.move));
    pushComments(node, 'commentsAfter');
    continuation(node, ply + 1, false);
  };
  const continuation = (parent, ply, isFirst) => {
    if (parent.children.length === 0) return;
    const main = parent.children[0];
    pushComments(main, 'commentsBefore');
    if (ply % 2 === 0 || isFirst) tokens.push(numText(ply));
    tokens.push(moveToString(main.move));
    pushComments(main, 'commentsAfter');
    for (let i = 1; i < parent.children.length; i++) { tokens.push('('); fromNode(parent.children[i], ply); tokens.push(')'); }
    continuation(main, ply + 1, false);
  };
  continuation(root, root.state.plies, true);
  tokens.push(result);

  const moveLines = [];
  let line = '';
  for (const t of tokens) {
    if (line && (line + ' ' + t).length > 80) { moveLines.push(line); line = t; }
    else line = line ? `${line} ${t}` : t;
  }
  if (line) moveLines.push(line);
  return [...tagLines, '', ...moveLines].join('\n') + '\n';
}