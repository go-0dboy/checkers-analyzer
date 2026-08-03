/**
 * @module history
 * Дерево ходов + навигация + рендер нотации в виде дерева ветвей.
 * children[0] — магистраль, children[1..] — вариации. Узел хранит комментарии
 * в двух фазах (commentsBefore/commentsAfter), чтобы round-trip сохранял их позицию.
 * Нумерация: номер пары один раз перед ходом белых; «N...» перед чёрным — только
 * когда последовательность стартует с чёрного хода.
 */

import { initialState, makeMove, moveToString } from './engine.js';

let NEXT_NID = 1;

export class HistoryNode {
  constructor(move, parent, state) {
    this.nid = NEXT_NID++;
    this.move = move;
    this.parent = parent;
    this.state = state;
    this.children = [];
    this.commentsBefore = [];
    this.commentsAfter = [];
  }
}

export class GameHistory {
  constructor({ container, state = initialState() } = {}) {
    this.container = container;
    this.root = new HistoryNode(null, null, state);
    this.current = this.root;
    this._byNid = new Map([[this.root.nid, this.root]]);
    this.onChange = null;
    this.onEditComment = null;

    this.container?.addEventListener('click', (e) => {
      const cm = e.target.closest('.move-comment');
      if (cm) {
        const node = this._byNid.get(Number(cm.dataset.nid));
        if (node) {
          this.goToNode(node);
          this.onEditComment?.({ node, phase: cm.dataset.phase, index: Number(cm.dataset.index) });
        }
        return;
      }
      const moveEl = e.target.closest('.move');
      if (!moveEl) return;
      const node = this._byNid.get(Number(moveEl.dataset.nid));
      if (node) this.goToNode(node);
    });
  }

  get currentState() { return this.current.state; }
  get lastMove()     { return this.current.move; }
  get canBack()      { return this.current.parent !== null; }
  get canForward()   { return this.current.children.length > 0; }
  get isEmpty()      { return this.root.children.length === 0; }

  reset(state) {
    this.root = new HistoryNode(null, null, state);
    this.current = this.root;
    this._byNid = new Map([[this.root.nid, this.root]]);
    this._notify();
  }

  loadFromTree(state, tree) {
    this.root = new HistoryNode(null, null, state);
    this._byNid = new Map([[this.root.nid, this.root]]);
    const graft = (rawNodes, parent) => {
      for (const raw of rawNodes) {
        const node = new HistoryNode(raw.move, parent, raw.state);
        node.commentsBefore = raw.commentsBefore ? raw.commentsBefore.slice() : [];
        node.commentsAfter = raw.commentsAfter ? raw.commentsAfter.slice() : [];
        parent.children.push(node);
        this._byNid.set(node.nid, node);
        graft(raw.children, node);
      }
    };
    graft(tree, this.root);
    this.current = this.root;
    this._notify();
  }

  addMove(move) {
    const key = moveToString(move);
    let child = this.current.children.find((c) => moveToString(c.move) === key);
    if (!child) {
      child = new HistoryNode(move, this.current, makeMove(this.current.state, move));
      this.current.children.push(child);
      this._byNid.set(child.nid, child);
    }
    this.current = child;
    this._notify();
    return child;
  }

  back()    { if (this.canBack)    { this.current = this.current.parent;      this._notify(); } }
  forward() { if (this.canForward) { this.current = this.current.children[0]; this._notify(); } }
  toStart() { if (this.current !== this.root) { this.current = this.root; this._notify(); } }
  toEnd() {
    let node = this.current;
    while (node.children.length) node = node.children[0];
    if (node !== this.current) { this.current = node; this._notify(); }
  }
  goToNode(node) { if (node && node !== this.current) { this.current = node; this._notify(); } }

  /** Число узлов в поддереве, включая сам узел. */
  subtreeSize(node) {
    let n = 1;
    for (const c of node.children) n += this.subtreeSize(c);
    return n;
  }

  /**
   * Удаляет текущий узел вместе со всем поддеревом (ход + всё после него в ветке).
   * Текущей становится родительская позиция. Корень не удаляется.
   * @returns {boolean} true при успехе
   */
  deleteCurrent() {
    const node = this.current;
    if (!node || !node.parent) return false;
    const parent = node.parent;
    const i = parent.children.indexOf(node);
    if (i === -1) return false;
    parent.children.splice(i, 1);
    const purge = (n) => { this._byNid.delete(n.nid); n.children.forEach(purge); };
    purge(node);
    this.current = parent;
    this._notify();
    return true;
  }

  _notify() {
    this.render();
    this.onChange?.({ node: this.current, state: this.current.state, lastMove: this.current.move });
  }

  render() {
    if (!this.container) return;
    const frag = document.createDocumentFragment();
    if (this.root.children.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.textContent = 'Ходов пока нет — сыграйте на доске или загрузите PDN.';
      frag.appendChild(empty);
    } else {
      this._renderContinuation(this.root, this.root.state.plies, frag, 0, true);
    }
    this.container.replaceChildren(frag);
    const active = this.container.querySelector(`.move[data-nid="${this.current.nid}"]`);
    if (active) {
      active.classList.add('active');
      const cRect = this.container.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      if (aRect.top < cRect.top) this.container.scrollTo({ top: this.container.scrollTop + (aRect.top - cRect.top) - 10, behavior: 'smooth' });
      else if (aRect.bottom > cRect.bottom) this.container.scrollTo({ top: this.container.scrollTop + (aRect.bottom - cRect.bottom) + 10, behavior: 'smooth' });
    }
  }

  _numberText(ply) { const n = Math.floor(ply / 2) + 1; return ply % 2 === 0 ? `${n}.` : `${n}...`; }
  _numSpan(ply) { const s = document.createElement('span'); s.className = 'move-num'; s.textContent = this._numberText(ply); return s; }
  _moveSpan(node) {
    const s = document.createElement('span');
    s.className = 'move' + (node.move.isCapture ? ' capture-move' : '');
    s.dataset.nid = node.nid;
    s.textContent = moveToString(node.move);
    s.title = 'Перейти к позиции после этого хода';
    return s;
  }
  _commentSpan(text, node, phase, index) {
    const s = document.createElement('span');
    s.className = 'move-comment';
    s.dataset.nid = node.nid; s.dataset.phase = phase; s.dataset.index = index;
    s.textContent = '{' + text + '}';
    s.title = 'Редактировать комментарий';
    return s;
  }
  _renderComments(node, phase, out) {
    const arr = node[phase] || [];
    for (let i = 0; i < arr.length; i++) out.appendChild(this._commentSpan(arr[i], node, phase, i));
  }
  _needsNumber(ply, isFirst) { return ply % 2 === 0 || isFirst; }

  _renderContinuation(parent, ply, out, depth, isFirst) {
    if (parent.children.length === 0) return;
    const main = parent.children[0];
    this._renderComments(main, 'commentsBefore', out);
    if (this._needsNumber(ply, isFirst)) out.appendChild(this._numSpan(ply));
    out.appendChild(this._moveSpan(main));
    this._renderComments(main, 'commentsAfter', out);
    for (let i = 1; i < parent.children.length; i++) {
      const block = document.createElement('span');
      block.className = 'var-block';
      block.dataset.depth = Math.min(depth + 1, 4);
      this._renderFrom(parent.children[i], ply, block, depth + 1);
      out.appendChild(block);
    }
    this._renderContinuation(main, ply + 1, out, depth, false);
  }
  _renderFrom(node, ply, out, depth) {
    this._renderComments(node, 'commentsBefore', out);
    out.appendChild(this._numSpan(ply));
    out.appendChild(this._moveSpan(node));
    this._renderComments(node, 'commentsAfter', out);
    this._renderContinuation(node, ply + 1, out, depth, false);
  }
}