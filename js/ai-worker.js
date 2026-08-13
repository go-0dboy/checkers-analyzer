import { analyze, gradeMove } from './ai.js';
self.onmessage = (e) => {
  const { id, type, state, before, after, opts, extra } = e.data || {};
  try {
    if (type === 'analyze') self.postMessage({ id, result: analyze(state, opts, extra) });
    else if (type === 'grade') self.postMessage({ id, grade: gradeMove(before, after, opts, extra) });
  } catch (err) { self.postMessage({ id, error: String(err?.message || err) }); }
};