/**
 * @module pdn
 * Разбор и генерация PDN 3.0 (стандарт Wieger Wesselink, rel. 3.0).
 *
 * Принцип «чтение либерально, запись строго» (стандарт, §1.2):
 *   • при ЗАПИСИ соблюдаем grammar §4.1 + restrictions §4.2;
 *   • при ЧТЕНИИ используем reading grammar §4.4 (разделитель взятия [x:],
 *     многоточия, лидирующие нули) и терпим распространённые вольности,
 *     включая НЕДОПУСТИМЫЕ ходы в OCR-файлах: такой ход пропускается
 *     (сбор в `skipped`), а разбор продолжается, чтобы одна опечатка не
 *     обрушивала загрузку всего дебютного дерева.
 *
 * База вариации определяется по номеру/цвету её первого хода через стек
 * магистрали (см. {@link chooseVariationBase}): это корректно обрабатывает
 * как стандартные вариации-альтернативы последнего хода, так и книжные
 * вариации-альтернативы «хода с тем же номером» от текущей позиции.
 *
 * Соответствие стандарту:
 *   §3 теги; §4.1/§4.2 grammar/restrictions; §4.3 комментарии {…} и вложенные
 *   вариации; §4.4 reading grammar (CAPTURESEPARATOR [x:], ELLIPSES);
 *   §10 FEN (терпим завершающую точку и слитный цвет секции);
 *   §11 GameType → ResultType + capture separator (25/41 → ':').
 */

import {
  WHITE, BLACK,
  initialState, makeMove, findMoves, nameToIdx,
  moveToString, stateToFEN, fenToState, getGameStatus, sepForGameType, setCaptureSep,
} from './engine.js';

// Токены: комментарий целиком; номер хода сохраняет value.
const TOKEN_RE = /\{[^}]*\}|\(|\)|1\/2-1\/2|\d+-\d+|\*|\d+\.+|(?:!!|\?\?|!\?|\?!|[!?])|[a-h][1-8](?:[x:×-][a-h][1-8])+/gi;
const RESULT_RE = /^(1-0|0-1|1\/2-1\/2|0-0|2-0|0-2|1-1|\*)$/;

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
    else if (RESULT_RE.test(raw)) tokens.push({ type: 'result', value: raw });
    else if (/^\d/.test(raw)) tokens.push({ type: 'number', value: raw });
    else if (/^[!?]/.test(raw)) tokens.push({ type: 'annotation', value: raw });
    else tokens.push({ type: 'move', raw, squares: raw.toLowerCase().split(/[x:×-]/) });
  }
  if (text.slice(last).trim()) throw new Error(`Непонятный фрагмент в конце текста: «${text.slice(last).trim().slice(0, 24)}…»`);
  return tokens;
}

function resolveMove(state, names, raw) {
  const path = names.map(nameToIdx);
  const bad = names.find((_, k) => path[k] < 0);
  if (bad) throw new Error(`Неизвестная клетка «${bad}» в ходе «${raw}»`);
  const from = path[0], to = path[path.length - 1];
  const candidates = findMoves(state, from, to);
  if (candidates.length === 0) throw new Error(`Ход «${raw}» недопустим в этой позиции`);
  if (path.length > 2) {
    const exact = candidates.find((m) => m.path.length === path.length && m.path.every((s, k) => s === path[k]));
    if (exact) return exact;
    const partial = candidates.find((m) => { let k = 0; for (const s of m.path) if (s === path[k]) k++; return k === path.length; });
    if (partial) return partial;
  }
  return candidates[0];
}

function peekFirstMove(tokens, start) {
  let num = null, color = null;
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === 'number') {
      const m = /^(\d+)/.exec(t.value);
      num = m ? parseInt(m[1], 10) : null;
      color = t.value.includes('...') ? BLACK : WHITE;
      continue;
    }
    if (t.type === 'comment') continue;
    if (t.type === 'move') return { num, color, squares: t.squares, raw: t.raw };
    return { num: null, color: null, squares: null, raw: null };
  }
  return { num: null, color: null, squares: null, raw: null };
}

function skipVariation(tokens, pos) {
  let depth = 1; pos.i++;
  while (pos.i < tokens.length && depth > 0) {
    if (tokens[pos.i].type === 'open') depth++;
    else if (tokens[pos.i].type === 'close') depth--;
    pos.i++;
  }
}

function chooseVariationBase(tokens, start, cur, lastNode, lastHome, container, lineNodes) {
  const peek = peekFirstMove(tokens, start);
  if (peek.num !== null && peek.color !== null) {
    const target = peek.color === WHITE ? 2 * (peek.num - 1) : 2 * peek.num - 1;
    for (const node of lineNodes) {
      if (node.state.plies === target) return { base: node.state, cont: node.children };
    }
    if (lastNode && cur.plies === target) return { base: cur, cont: lastNode.children };
  }
  const cand = lastNode
    ? [[cur, lastNode.children], [lastNode.before, lastHome]]
    : [[cur, container]];
  if (peek.color !== null) cand.sort((a, b) => (a[0].turn === peek.color ? 0 : 1) - (b[0].turn === peek.color ? 0 : 1));
  if (peek.squares) {
    for (const [b, vc] of cand) {
      try { resolveMove(b, peek.squares, peek.raw); return { base: b, cont: vc }; } catch { /* next */ }
    }
  }
  return { base: cand[0][0], cont: cand[0][1] };
}

function parseSequence(tokens, pos, state, container, depth, skipped, lineNodes) {
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
      case 'annotation':
        if (lastNode) lastNode.annotation = t.value;
          pos.i++;
        break;
      case 'open': {
        if (!lastNode) { skipped.push({ raw: '(вариация без хода)', depth }); skipVariation(tokens, pos); break; }
        const { base, cont } = chooseVariationBase(tokens, pos.i + 1, cur, lastNode, lastHome, container, lineNodes);
        pos.i++;
        const sub = parseSequence(tokens, pos, base, cont, depth + 1, skipped, []);
        if (tokens[pos.i]?.type !== 'close') throw new Error('Вариация не закрыта скобкой «)»');
        pos.i++;
        if (sub.result) result = sub.result;
        break;
      }
      case 'move': {
        let move;
        try { move = resolveMove(cur, t.squares, t.raw); }
        catch { skipped.push({ raw: t.raw, depth }); pos.i++; continue; }
        const next = makeMove(cur, move);
        const node = { move, state: next, before: cur, children: [], commentsBefore: pendingBefore, commentsAfter: [] };
        pendingBefore = [];
        const home = lastNode ? lastNode.children : container;
        home.push(node);
        lineNodes.push(node);
        lastHome = home; lastNode = node; cur = next; pos.i++;
        break;
      }
    }
  }
  return { state: cur, result };
}

export function parsePDN(text) {
  if (!text || !text.trim()) throw new Error('Пустой текст PDN');
  const headers = {};
  const tagRe = /\[\s*([A-Za-z]\w*)\s+"([^"]*)"\s*\]/g;
  let m;
  while ((m = tagRe.exec(text))) headers[m[1]] = m[2];

  const moveText = text
    .replace(/\[\s*[A-Za-z]\w*\s+"[^"]*"\s*\]/g, ' ')
    .replace(/;[^\n]*/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/%[^\n]*/g, ' ');
  const tokens = tokenize(moveText);

  let rootState;
  if (headers.FEN) {
    try { rootState = fenToState(headers.FEN); }
    catch (e) { throw new Error(`Некорректный тег [FEN]: ${e.message}`); }
  } else {
    rootState = initialState();
  }
  setCaptureSep(headers.GameType ? sepForGameType(headers.GameType) : ':');

  const tree = [];
  const skipped = [];
  const pos = { i: 0 };
  const parsed = parseSequence(tokens, pos, rootState, tree, 0, skipped, []);
  if (tree.length === 0 && Object.keys(headers).length === 0) throw new Error('В тексте не найдено ни тегов, ни ходов');
  return { headers, result: parsed.result ?? headers.Result ?? null, rootState, tree, skipped };
}

/**
 * Разбивает текст на партии ПОСТРОЧНО: новая партия начинается только когда
 * встречена строка-тег ПОСЛЕ того, как уже были ходы. Устойчиво к пустым
 * строкам между тегами и ходами одной партии и к партиям без пустых строк.
 */
export function parsePDNBatch(text) {
  if (!text || !text.trim()) throw new Error('Пустой текст PDN');
  const lines = text.split(/\r?\n/);
  const isTagLine = (l) => /^\s*\[/.test(l);
  const isMoveLine = (l) => /[a-h][1-8]\s*[x:×-]\s*[a-h][1-8]/i.test(l) || /^\s*\d+\./.test(l);

  const chunks = [];
  let cur = [];
  let seenMove = false;
  for (const line of lines) {
    if (isTagLine(line) && seenMove) {
      if (cur.length) chunks.push(cur.join('\n'));
      cur = [line];
      seenMove = false;
    } else {
      cur.push(line);
      if (!isTagLine(line) && isMoveLine(line)) seenMove = true;
    }
  }
  if (cur.length && cur.some((l) => l.trim())) chunks.push(cur.join('\n'));

  const games = [];
  for (const chunk of chunks) {
    try {
      const parsed = parsePDN(chunk);
      if (!parsed.tree.length) { games.push({ error: 'Партия без ходов', chunk }); continue; }

      let hasComments = false;
      const cc = (n) => { if (n.commentsBefore?.length || n.commentsAfter?.length) hasComments = true; n.children?.forEach(cc); };
      parsed.tree.forEach(cc);
      if (hasComments) { games.push({ error: 'Партия содержит комментарии', chunk }); continue; }

      let hasVariations = false;
      const cv = (n) => { if (n.children.length > 1) hasVariations = true; n.children.forEach(cv); };
      parsed.tree.forEach(cv);
      if (hasVariations) { games.push({ error: 'Партия содержит ветвления', chunk }); continue; }

      if (parsed.skipped && parsed.skipped.length > 0) {
        games.push({ error: `Партия содержит недопустимые ходы: ${parsed.skipped.map((s) => s.raw).join(', ')}`, chunk });
        continue;
      }
      if (!parsed.result || parsed.result === '*') { games.push({ error: 'Партия без результата', chunk }); continue; }
      games.push(parsed);
    } catch (e) {
      games.push({ error: e.message, chunk });
    }
  }
  if (!games.length) throw new Error('В тексте не найдено ни одной партии');
  return games;
}

const pad2 = (n) => String(n).padStart(2, '0');
export function formatDate(date = new Date()) {
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

export function detectResult(history) {
  let node = history.root;
  while (node.children.length) node = node.children[0];
  const status = getGameStatus(node.state);
  if (!status.over) return '*';
  if (status.winner === WHITE) return '1-0';
  if (status.winner === BLACK) return '0-1';
  return '1/2-1/2';
}

const safeComment = (s) => String(s).replace(/[{}]/g, '').trim();

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
    tokens.push(numText(ply), moveToString(node.move) + (node.annotation || ''));
    pushComments(node, 'commentsAfter');
    continuation(node, ply + 1, false);
  };
  const continuation = (parent, ply, isFirst) => {
    if (parent.children.length === 0) return;
    const main = parent.children[0];
    pushComments(main, 'commentsBefore');
    if (ply % 2 === 0 || isFirst) tokens.push(numText(ply));
    tokens.push(moveToString(main.move) + (main.annotation || ''));
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