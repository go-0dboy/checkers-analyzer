/**
 * @module engine
 * Чистый движок русских шашек. НОЛЬ зависимостей от DOM.
 *
 * Ответственность:
 *   • представление позиции (массив 64 + очередь хода);
 *   • генерация легальных ходов (тихие + серии взятий);
 *   • применение хода, определение окончания партии;
 *   • кодирование/декодирование FEN (по PDN 3.0, §10);
 *   • настройка разделителя взятия по GameType (по PDN 3.0, §11).
 *
 * Инварианты модели:
 *   • доска — массив длины 64, индекс = rank*8 + file (rank 0 = 1-я горизонталь);
 *   • клетка = null | 'w' | 'b' | 'W' | 'B' (строчные — простые, прописные — дамки);
 *   • игра идёт только по тёмным клеткам ((file+rank) чётно).
 *
 * Правила (русские шашки):
 *   • простая ходит на 1 по диагонали вперёд; бьёт на 1 вперёд и назад;
 *   • дамка «летающая»: ходит/бьёт на любое расстояние по диагонали;
 *   • взятие обязательно; превращение в середине серии действует сразу;
 *   • съеденные шашки снимаются ПОСЛЕ серии (во время серии блокируют проход
 *     и повторный прыжок через ту же шашку).
 *
 * Локальное правило завершения серии («ешь, пока можешь»):
 *   перепрыгнув жертву, дамка перебирает все посадки за ней. Если среди них
 *   есть хоть одна, с которой бой продолжается, — посадки, обрывающие бой за
 *   этой же жертвой, ЗАПРЕЩЕНЫ (преждевременная остановка). Если продолжающих
 *   посадок за жертвой нет — серия честно заканчивается, какой бы короткой ни
 *   была. Это НЕ «максимальное взятие по длине»: короткая серия легальна, раз
 *   за её жертвой продолжить невозможно (пример: f8xg7-h6 при наличии длинной
 *   f8xd6-c5xb4-a3xb2-c1). Именно это свойство держит этюдные конструкции
 *   (треугольник Петрова, петля). См. {@link _explore}.
 */

export const SIZE = 8;
export const WHITE = 'w';
export const BLACK = 'b';

/** Четыре диагональных направления: [df, dr]. */
const DIRS = Object.freeze([[1, 1], [1, -1], [-1, 1], [-1, -1]]);

/* ── геометрия доски ─────────────────────────────────────────────── */
export const idx = (file, rank) => rank * SIZE + file;
export const fileOf = (i) => i % SIZE;
export const rankOf = (i) => Math.floor(i / SIZE);
const inside = (f, r) => f >= 0 && f < SIZE && r >= 0 && r < SIZE;
export const isDarkSquare = (i) => (fileOf(i) + rankOf(i)) % 2 === 0;
const isPromotionRank = (color, rank) => (color === WHITE ? rank === SIZE - 1 : rank === 0);
export const opposite = (color) => (color === WHITE ? BLACK : WHITE);

/** Алгебраическое имя клетки («c3») → индекс; -1 при невалидном вводе. */
export function nameToIdx(name) {
  const m = /^([a-h])([1-8])$/i.exec(String(name).trim());
  if (!m) return -1;
  return idx(m[1].toLowerCase().charCodeAt(0) - 97, parseInt(m[2], 10) - 1);
}
/** Индекс → алгебраическое имя клетки. */
export function squareName(i) {
  return 'abcdefgh'[fileOf(i)] + String(rankOf(i) + 1);
}

/* ── предикаты фигуры ────────────────────────────────────────────── */
export const colorOf = (p) => (p === 'w' || p === 'W' ? WHITE : BLACK);
export const isKingPiece = (p) => (p === 'W' || p === 'B');
export const isManPiece = (p) => (p === 'w' || p === 'b');
export const pieceChar = (color, king) => (king ? color.toUpperCase() : color);

/* ── состояние ───────────────────────────────────────────────────── */
/**
 * Создаёт состояние. ply 0 = ход белых («N.»), ply 1 = ход чёрных («N...»),
 * поэтому позиция с очередью чёрных стартует с ply 1 — это держит нумерацию
 * нотации корректной при загрузке FEN с ходом чёрных.
 * @param {Array} board массив 64
 * @param {string} turn WHITE | BLACK
 */
export function createState(board, turn = WHITE) {
  return { board: board.slice(), turn, plies: turn === WHITE ? 0 : 1 };
}

/** Стандартная начальная расстановка. */
export function initialState() {
  const board = new Array(SIZE * SIZE).fill(null);
  for (let r = 0; r < SIZE; r++) {
    for (let f = 0; f < SIZE; f++) {
      const i = idx(f, r);
      if (!isDarkSquare(i)) continue;
      if (r <= 2) board[i] = 'w';
      else if (r >= 5) board[i] = 'b';
    }
  }
  return createState(board, WHITE);
}

/** Поверхностная копия состояния (доска клонируется). */
export function cloneState(state) {
  return { board: state.board.slice(), turn: state.turn, plies: state.plies || 0 };
}

/**
 * Рекурсивный перебор всех серий взятий из клетки start.
 * ВОЗВРАЩАЕТ массив завершённых серий, достижимых отсюда. Реализует локальное
 * правило завершения двухпроходным циклом по посадкам за каждой жертвой:
 *   проход 1 — для каждой посадки рекурсивно считаем под-серии;
 *   проход 2 — зная hasContinuation, решаем, какие посадки допустимы
 *              (продолжающие всегда; тупиковые — только если продолжить
 *              за этой жертвой в принципе нельзя).
 *
 * @param {Array} board        доска
 * @param {string} color       цвет бьющей стороны
 * @param {number} origin      индекс исходной клетки серии (для path[0])
 * @param {number} start       индекс текущей позиции бьющей фигуры
 * @param {boolean} kingNow    летит ли фигура как дамка на этом шаге
 * @param {Set} capturedSet    уже съеденные в серии (блокируют проход/повтор)
 * @param {number[]} capturedList съеденные в порядке взятия
 * @param {number[]} path      посадки в порядке серии
 * @returns {Array} завершённые серии взятий
 */
function _explore(board, color, origin, start, kingNow, capturedSet, capturedList, path) {
  const isBlocked = (i) => capturedSet.has(i) || (board[i] !== null && i !== origin);
  const results = [];
  const f = fileOf(start), r = rankOf(start);

  for (const [df, dr] of DIRS) {
    const entries = []; // посадки за жертвой в этом направлении: { tIdx, land, becameKing }

    if (kingNow) {
      let nf = f + df, nr = r + dr;
      while (inside(nf, nr) && !isBlocked(idx(nf, nr))) { nf += df; nr += dr; }
      if (!inside(nf, nr)) continue;
      const tIdx = idx(nf, nr);
      const tPiece = board[tIdx];
      if (!tPiece || colorOf(tPiece) === color || capturedSet.has(tIdx)) continue;
      let lf = nf + df, lr = nr + dr;
      while (inside(lf, lr) && !isBlocked(idx(lf, lr))) {
        entries.push({ tIdx, land: idx(lf, lr), becameKing: kingNow || isPromotionRank(color, lr) });
        lf += df; lr += dr;
      }
    } else {
      const tf = f + df, tr = r + dr, lf = f + 2 * df, lr = r + 2 * dr;
      if (inside(lf, lr)) {
        const tIdx = idx(tf, tr), land = idx(lf, lr);
        if (!capturedSet.has(tIdx)) {
          const tPiece = board[tIdx];
          if (tPiece && colorOf(tPiece) !== color && !isBlocked(land)) {
            entries.push({ tIdx, land, becameKing: isPromotionRank(color, lr) });
          }
        }
      }
    }
    if (entries.length === 0) continue;

    // проход 1: под-серии каждой посадки
    const computed = [];
    for (const e of entries) {
      capturedSet.add(e.tIdx); capturedList.push(e.tIdx); path.push(e.land);
      const subs = _explore(board, color, origin, e.land, e.becameKing, capturedSet, capturedList, path);
      computed.push({ e, subs });
      capturedSet.delete(e.tIdx); capturedList.pop(); path.pop();
    }
    const hasContinuation = computed.some((c) => c.subs.length > 0);

    // проход 2: сбор серий с применением локального правила
    for (const { e, subs } of computed) {
      if (subs.length > 0) {
        for (const s of subs) results.push(s); // продолжающая посадка
      } else if (!hasContinuation) {
        capturedSet.add(e.tIdx); capturedList.push(e.tIdx); path.push(e.land);
        results.push({ from: path[0], to: e.land, path: [...path], captures: [...capturedList], king: e.becameKing, isCapture: true });
        capturedSet.delete(e.tIdx); capturedList.pop(); path.pop();
      }
      // иначе: преждевременная остановка при наличии продолжения — отбрасываем
    }
  }
  return results;
}

/**
 * Все легальные ходы стороны, которой ходить. Взятия имеют приоритет:
 * если есть хоть одна серия взятий, тихие ходы не возвращаются.
 * @param {{board:Array, turn:string}} state
 * @returns {Array} ходы
 */
export function getLegalMoves(state) {
  const captures = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const p = state.board[i];
    if (!p || colorOf(p) !== state.turn) continue;
    const series = _explore(state.board, state.turn, i, i, isKingPiece(p), new Set(), [], [i]);
    for (const s of series) captures.push(s);
  }
  if (captures.length) return captures;

  const quiet = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const p = state.board[i];
    if (!p || colorOf(p) !== state.turn) continue;
    if (isKingPiece(p)) {
      for (const [df, dr] of DIRS) {
        let nf = fileOf(i) + df, nr = rankOf(i) + dr;
        while (inside(nf, nr) && state.board[idx(nf, nr)] === null) {
          quiet.push({ from: i, to: idx(nf, nr), path: [i, idx(nf, nr)], captures: [], king: true, isCapture: false });
          nf += df; nr += dr;
        }
      }
    } else {
      const fwd = state.turn === WHITE ? 1 : -1;
      for (const df of [-1, 1]) {
        const nf = fileOf(i) + df, nr = rankOf(i) + fwd;
        if (inside(nf, nr) && state.board[idx(nf, nr)] === null) {
          // тихий ход на последний ряд превращает шашку в дамку
          const promotes = isPromotionRank(state.turn, nr);
          quiet.push({ from: i, to: idx(nf, nr), path: [i, idx(nf, nr)], captures: [], king: promotes, isCapture: false });
        }
      }
    }
  }
  return quiet;
}

/** Легальные ходы конкретной клетки. */
export function getMovesForPiece(state, from) {
  return getLegalMoves(state).filter((m) => m.from === from);
}

/** Есть ли у стороны обязательное взятие. */
export function hasMandatoryCapture(state) {
  const moves = getLegalMoves(state);
  return moves.length > 0 && moves[0].isCapture;
}

/**
 * «Сырые» одиночные прыжки из клетки (для пошагового UI серий).
 * В отличие от {@link _explore}, НЕ применяет правило завершения — возвращает
 * все физически возможные прыжки; фильтрацию по разрешённым сериям делает UI.
 */
export function getJumpSteps(state, from, capturedList = [], kingNow = null) {
  const board = state.board;
  const piece = board[from];
  if (!piece) return [];
  const color = colorOf(piece);
  if (kingNow === null) kingNow = isKingPiece(piece);
  const capturedSet = new Set(capturedList);
  const isBlocked = (i) => capturedSet.has(i) || (board[i] !== null && i !== from);
  const steps = [];
  const f = fileOf(from), r = rankOf(from);
  for (const [df, dr] of DIRS) {
    if (kingNow) {
      let nf = f + df, nr = r + dr;
      while (inside(nf, nr) && !isBlocked(idx(nf, nr))) { nf += df; nr += dr; }
      if (!inside(nf, nr)) continue;
      const tIdx = idx(nf, nr);
      const tPiece = board[tIdx];
      if (!tPiece || colorOf(tPiece) === color || capturedSet.has(tIdx)) continue;
      let lf = nf + df, lr = nr + dr;
      while (inside(lf, lr) && !isBlocked(idx(lf, lr))) {
        steps.push({ to: idx(lf, lr), captured: tIdx, king: kingNow || isPromotionRank(color, lr) });
        lf += df; lr += dr;
      }
    } else {
      const tf = f + df, tr = r + dr, lf = f + 2 * df, lr = r + 2 * dr;
      if (!inside(lf, lr)) continue;
      const tIdx = idx(tf, tr), land = idx(lf, lr);
      if (capturedSet.has(tIdx)) continue;
      const tPiece = board[tIdx];
      if (!tPiece || colorOf(tPiece) === color) continue;
      if (isBlocked(land)) continue;
      steps.push({ to: land, captured: tIdx, king: isPromotionRank(color, lr) });
    }
  }
  return steps;
}

/** Ходы from→to. НЕ применяет правил завершения — нужно парсеру PDN. */
export function findMoves(state, from, to) {
  return getLegalMoves(state).filter((m) => m.from === from && m.to === to);
}

/**
 * Применяет ход, возвращая НОВОЕ состояние. Съеденные снимаются, превращение
 * учитывает флаг move.king (для серий он несёт «дамочность» на финише).
 */
export function makeMove(state, move) {
  const next = cloneState(state);
  const piece = next.board[move.from];
  if (!piece) throw new Error(`makeMove: на клетке ${squareName(move.from)} нет шашки`);
  const color = colorOf(piece);
  next.board[move.from] = null;
  for (const c of move.captures ?? []) next.board[c] = null;
  const reachesLast = isPromotionRank(color, rankOf(move.to));
  const king = (move.king !== undefined) ? move.king : (isKingPiece(piece) || reachesLast);
  next.board[move.to] = pieceChar(color, king);
  next.turn = opposite(color);
  next.plies += 1;
  return next;
}

/**
 * Статус партии: окончена ли, победитель/ничья, причина.
 * Победа — когда у стороны нет легальных ходов (шашечный «мат»).
 * Ничья — эвристика «ровно две дамки на доске» (тривиальный случай).
 * NOTE: ничья по трёхкратному повторению и по правилу N ходов дамками
 *       НЕ реализована (см. docs/TECHNICAL.md, «Известные ограничения»).
 */
export function getGameStatus(state) {
  if (getLegalMoves(state).length === 0) {
    return { over: true, winner: opposite(state.turn), reason: 'сторона, которой ходить, не имеет легальных ходов' };
  }
  let total = 0, kings = 0;
  for (const p of state.board) if (p) { total++; if (isKingPiece(p)) kings++; }
  if (total === 2 && kings === 2) {
    return { over: true, winner: null, reason: 'ничья: дамка против дамки, взятие недостижимо' };
  }
  return { over: false, winner: null, reason: null };
}

/**
 * Ход → строка нотации. Разделитель взятия берётся из модульной настройки
 * (по PDN 3.0 §11: русские/шпанциретти ':', прочие 'x').
 */
export function moveToString(move) {
  const sep = move.isCapture ? captureSep : '-';
  return move.path.map(squareName).join(sep);
}

/* ── FEN (PDN 3.0, §10) ──────────────────────────────────────────── */
// Нумерация полей 1..32 по тёмным клеткам: от 8-й горизонтали к 1-й, слева направо.
const FEN_TO_IDX = new Array(33).fill(-1);
const IDX_TO_FEN = new Array(SIZE * SIZE).fill(-1);
(() => {
  let n = 1;
  for (let r = SIZE - 1; r >= 0; r--) {
    for (let f = 0; f < SIZE; f++) {
      const i = idx(f, r);
      if (isDarkSquare(i)) { FEN_TO_IDX[n] = i; IDX_TO_FEN[i] = n; n++; }
    }
  }
})();

/** Состояние → FEN-строка вида «turn:W…:B…». */
export function stateToFEN(state) {
  const list = (color) => {
    const nums = [];
    for (let n = 1; n <= 32; n++) {
      const p = state.board[FEN_TO_IDX[n]];
      if (p && colorOf(p) === color) nums.push({ n, king: isKingPiece(p) });
    }
    const tokens = [];
    let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1].n === nums[j].n + 1 && nums[j + 1].king === nums[i].king) j++;
      const k = nums[i].king ? 'K' : '';
      tokens.push(nums[i].n === nums[j].n ? `${k}${nums[i].n}` : `${k}${nums[i].n}-${nums[j].n}`);
      i = j + 1;
    }
    return tokens.join(',');
  };
  return `${state.turn}:W${list(WHITE)}:B${list(BLACK)}`;
}

/**
 * FEN → состояние. Либеральное чтение: терпит точку в конце («…12.»),
 * которую §10.1 запрещает при записи, но которую ставят реальные файлы,
 * и слитный цвет секции («W13,…»). Пустые секции и «?» пропускаются.
 */
export function fenToState(fen) {
  const parts = String(fen).trim().split(':');
  if (parts.length < 2) throw new Error('Некорректный FEN: ожидается формат «сторона:W…:B…»');
  const turn = parts[0].trim().toLowerCase() === 'b' ? BLACK : WHITE;
  const board = new Array(SIZE * SIZE).fill(null);
  const put = (body, color) => {
    for (const raw of body.split(',')) {
      const token = raw.replace(/[^0-9Kk-]/g, ''); // чистим точку/пробелы
      if (!token) continue;
      const m = /^(K)?(\d+)(?:-(\d+))?$/.exec(token);
      if (!m) throw new Error(`Некорректный FEN-токен: «${raw}»`);
      const king = Boolean(m[1]);
      const from = parseInt(m[2], 10);
      const to = m[3] ? parseInt(m[3], 10) : from;
      if (from < 1 || to > 32 || from > to) throw new Error(`Номер клетки вне диапазона 1–32: «${raw}»`);
      for (let n = from; n <= to; n++) board[FEN_TO_IDX[n]] = pieceChar(color, king);
    }
  };
  for (let i = 1; i < parts.length; i++) {
    const sec = parts[i].trim();
    if (!sec) continue;
    const c = sec[0].toLowerCase();
    if (c !== 'w' && c !== 'b') continue; // '?' и прочее — пропускаем
    put(sec.slice(1), c === 'w' ? WHITE : BLACK);
  }
  return createState(board, turn);
}

/* ── разделитель взятия по GameType (PDN 3.0, §11) ───────────────── */
// Таблица стандарта: тип 25 (русские) и 41 (шпанциретти) пишут ':', остальные 'x'.
let captureSep = ':';
export function setCaptureSep(sep) { captureSep = (sep === 'x' || sep === ':') ? sep : ':'; }
export function getCaptureSep() { return captureSep; }
export function sepForGameType(gt) {
  const s = String(gt || '').split(',')[0];
  return (s === '25' || s === '41') ? ':' : 'x';
}