import { TBSolver } from './tb.js';
let base = new Map(), stopFlag = false;
self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.cmd === 'load') { base = new Map(d.entries); postMessage({ size: base.size }); }
  else if (d.cmd === 'run') {
    stopFlag = false;
    const solver = new TBSolver(d.k, (key) => base.get(key));
    const done = await solver.run({
      onProgress: (p, ph) => postMessage({ progress: p, phase: ph }),
      stop: () => stopFlag,
      onChunk: (ch) => { for (const [k, v] of ch) base.set(k, v); postMessage({ chunk: ch }); },
    });
    postMessage({ done: !!done });
  }
  else if (d.cmd === 'pause') stopFlag = true;
};