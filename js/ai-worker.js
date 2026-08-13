import { analyze, gradeMove, setWeights } from './ai.js';
self.onmessage = (e) => {
  const { id, type, state, before, after, opts, extra } = e.data || {};
  try {
    if (type === 'analyze') self.postMessage({ id, result: analyze(state, opts, extra) });
    else if (type === 'grade') self.postMessage({ id, grade: gradeMove(before, after, opts, extra) });
    else if (d.cmd === 'tb') setTablebase(new Map(d.entries));
    else if (d.cmd === 'tb-add') { /* если храним Map глобально — дописать */ }
    else if (d.cmd==='weights') setWeights(d.weights);
  } catch (err) { self.postMessage({ id, error: String(err?.message || err) }); }
};