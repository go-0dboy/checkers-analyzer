/**
 * @module board
 * Отрисовка доски и ввод (клик + drag). Правил здесь НЕТ — модуль только
 * показывает переданное состояние и эмитит намерения пользователя наружу.
 *
 * События:
 *   'squareclick' → { sq }   клик по клетке (sq — индекс 0..63)
 *   'dragdrop'    → { from, to } перетаскивание фигуры
 *
 * Координаты и порядок клеток учитывают переворот (flipped): отображаемый
 * индекс d маппится в логический sq через {@link _displayToSq}.
 */

import { WHITE, colorOf, isKingPiece, isDarkSquare, squareName } from './engine.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS_DESC = ['8', '7', '6', '5', '4', '3', '2', '1'];

export class BoardUI {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.boardEl контейнер .board
   * @param {HTMLElement} opts.frameEl рамка (для анимации переворота)
   * @param {Object} opts.coords четыре контейнера координат
   */
  constructor({ boardEl, frameEl, coords }) {
    this.boardEl = boardEl;
    this.frameEl = frameEl;
    this.coordEls = coords;
    this.flipped = false;
    this.setupMode = false;
    this.interactive = true;
    this.squares = [];
    this.lastState = null;
    this.lastView = {};
    this._listeners = {};
    this._pending = null;
    this._buildSquares();
    this._renderCoords();
    this._bindPointer();
  }

  /** Подписка на событие. */
  on(event, callback) { (this._listeners[event] ??= []).push(callback); return this; }
  _emit(event, payload) { for (const cb of this._listeners[event] ?? []) cb(payload); }

  /** Создаёт 64 DOM-клеток один раз. */
  _buildSquares() {
    const frag = document.createDocumentFragment();
    for (let d = 0; d < 64; d++) {
      const el = document.createElement('div');
      el.className = 'square';
      el.setAttribute('role', 'gridcell');
      frag.appendChild(el);
      this.squares.push(el);
    }
    this.boardEl.appendChild(frag);
  }

  /** Перерисовывает подписи координат с учётом переворота. */
  _renderCoords() {
    const files = this.flipped ? [...FILES].reverse() : FILES;
    const ranks = this.flipped ? [...RANKS_DESC].reverse() : RANKS_DESC;
    const fill = (container, values) => {
      container.replaceChildren();
      for (const v of values) {
        const s = document.createElement('span');
        s.textContent = v;
        container.appendChild(s);
      }
    };
    fill(this.coordEls.top, files);
    fill(this.coordEls.bottom, files);
    fill(this.coordEls.left, ranks);
    fill(this.coordEls.right, ranks);
  }

  /** Отображаемый индекс d → логический индекс клетки. */
  _displayToSq(d) {
    const row = d >> 3, col = d & 7;
    const base = 56 - 8 * row + col;
    return this.flipped ? 63 - base : base;
  }

  /** Устанавливает ориентацию мгновенно, без анимации. */
setFlipped(flipped) {
  if (this.flipped === flipped) return;
  this.flipped = flipped;
  this._renderCoords();
  if (this.lastState) this.render(this.lastState, this.lastView);
}
toggleFlip() { this.setFlipped(!this.flipped); }

  /** Режим расстановки: клетки кликабельны как холст, фигуры не тащим. */
  setSetupMode(on) { this.setupMode = on; this.boardEl.classList.toggle('setup-mode', on); }
  setInteractive(on) { this.interactive = on; }

  /**
   * Полная перерисовка по состоянию и «виду» (подсветки).
   * @param {{board:Array, turn:string}} state
   * @param {Object} view { lastMove, selected, hints, movable }
   */
  render(state, view = {}) {
    this.lastState = state;
    this.lastView = view;
    const { lastMove = null, selected = null, hints = null, movable = null } = view;
    const hintMap = new Map();
    if (hints) for (const h of hints) hintMap.set(h.to, Boolean(h.isCapture));

    for (let d = 0; d < 64; d++) {
      const el = this.squares[d];
      const sq = this._displayToSq(d);
      el.dataset.sq = sq;
      el.setAttribute('aria-label', squareName(sq));
      el.classList.toggle('sq-dark', isDarkSquare(sq));
      el.classList.toggle('sq-light', !isDarkSquare(sq));
      el.classList.remove('selected', 'last-from', 'last-to', 'hint-move', 'hint-capture', 'movable', 'drag-source');

      const piece = state.board[sq];
      let pieceEl = el.querySelector('.piece');
      if (piece) {
        if (!pieceEl) { pieceEl = document.createElement('div'); el.appendChild(pieceEl); }
        const cls = 'piece ' + (colorOf(piece) === WHITE ? 'white' : 'black') + (isKingPiece(piece) ? ' king' : '');
        if (pieceEl.className !== cls && !pieceEl.classList.contains('drag-ghost')) pieceEl.className = cls;
        if (lastMove && sq === lastMove.to && !pieceEl.classList.contains('drop-in')) {
          pieceEl.classList.add('drop-in');
          setTimeout(() => pieceEl.classList.remove('drop-in'), 260);
        }
      } else if (pieceEl) {
        pieceEl.remove();
      }

      if (selected === sq) el.classList.add('selected');
      if (lastMove) {
        if (sq === lastMove.from) el.classList.add('last-from');
        if (sq === lastMove.to) el.classList.add('last-to');
      }
      if (hintMap.has(sq)) el.classList.add(hintMap.get(sq) ? 'hint-capture' : 'hint-move');
      if (movable?.has(sq)) el.classList.add('movable');
    }
  }

  _bindPointer() {
    this.boardEl.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onPointerMove(e), { passive: false });
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
    window.addEventListener('pointercancel', () => this._cancelGesture());
    this.boardEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    const squareEl = e.target.closest('.square');
    if (!squareEl) return;
    const sq = Number(squareEl.dataset.sq);
    const pieceEl = squareEl.querySelector('.piece');
    const canDrag = !this.setupMode && this.interactive && Boolean(pieceEl) && squareEl.classList.contains('movable');
    this._pending = { sq, pieceEl, canDrag, x0: e.clientX, y0: e.clientY, dragging: false, ghost: null };
    if (canDrag) e.preventDefault();
  }

  _onPointerMove(e) {
    const p = this._pending;
    if (!p || !p.canDrag) return;
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 6) return;
      p.dragging = true;
      document.body.classList.add('is-dragging');
      p.ghost = p.pieceEl.cloneNode(true);
      p.ghost.classList.add('drag-ghost');
      document.body.appendChild(p.ghost);
      p.pieceEl.closest('.square')?.classList.add('drag-source');
    }
    e.preventDefault();
    p.ghost.style.left = e.clientX + 'px';
    p.ghost.style.top = e.clientY + 'px';
  }

  _onPointerUp(e) {
    const p = this._pending;
    if (!p) return;
    this._pending = null;
    if (p.dragging) {
      this._teardownDrag(p);
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const squareEl = under?.closest('.square');
      const to = squareEl ? Number(squareEl.dataset.sq) : null;
      if (to !== null && to !== p.sq) this._emit('dragdrop', { from: p.sq, to });
      else this._emit('squareclick', { sq: p.sq });
      return;
    }
    this._emit('squareclick', { sq: p.sq });
  }

  _teardownDrag(p) {
    document.body.classList.remove('is-dragging');
    p.ghost?.remove();
    p.pieceEl?.closest('.square')?.classList.remove('drag-source');
  }
  _cancelGesture() { if (this._pending) { this._teardownDrag(this._pending); this._pending = null; } }
}