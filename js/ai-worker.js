/**
 * @module ai-worker
 * Воркер анализа. Базы — как TBReader (ленивые Blob-читатели):
 * зонд синхронный из LRU-кеша, вся таблица в память не грузится.
 */
import { analyze, gradeMove, setWeights, setTablebaseProbe } from './ai.js';
import { TBReader } from './tb.js';

const readers = new Map(); // k → TBReader

function tbProbe(state) {
  let n = 0;
  for (const p of state.board) if (p) n++;
  const r = readers.get(n);
  return r ? r.probe(state) : null;
}
setTablebaseProbe(tbProbe);

self.onmessage = (e) => {
  const d = e.data || {};
  const { id, type, state, before, after, opts, extra } = d;
  try {
    if (type === 'analyze') self.postMessage({ id, result: analyze(state, opts, extra) });
    else if (type === 'grade') self.postMessage({ id, grade: gradeMove(before, after, opts) });
    else if (d.cmd === 'tb-load') readers.set(d.k, new TBReader(d.blob));
    else if (d.cmd === 'weights') setWeights(d.weights);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};