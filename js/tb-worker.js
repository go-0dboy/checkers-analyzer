/**
 * @module tb-worker
 * Расчёт баз v2. Сам пишет .bin (FS Access handle), перезаписывая каждые 100k.
 * Младшие базы грузит полностью (loadAll) для синхронных зондов.
 * Команды: lower{k,blob}, set-file{handle}, run{k}, pause.
 */
import { TBSolver, TBReader } from './tb.js';

const lower = new Map();
let fileHandle = null, stopFlag = false;

async function saveFile(buf) {
  if (!fileHandle) return;
  try {
    const w = await fileHandle.createWritable();
    await w.write(buf);
    await w.close();
  } catch (e) { self.postMessage({ error: 'save: ' + (e?.message || e) }); }
}

self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.cmd === 'pause') { stopFlag = true; return; }
  if (d.cmd === 'set-file') { fileHandle = d.handle; return; }
  if (d.cmd === 'lower') {
    const r = new TBReader(d.blob);
    lower.set(d.k, r);
    await r.loadAll();
    self.postMessage({ lowerReady: d.k });
    return;
  }
  if (d.cmd === 'run') {
    stopFlag = false;
    const solver = new TBSolver(d.k, (state) => {
      let n = 0; for (const p of state.board) if (p) n++;
      const r = lower.get(n);
      return r ? r.probe(state) : null;
    });
    const done = await solver.run({
      onProgress: (p, ph) => self.postMessage({ progress: p, phase: ph }),
      stop: () => stopFlag,
      onSave: (buf) => saveFile(buf),                      // перезапись файла каждые 100k
    });
    if (done) {
      await saveFile(done);
      if (done.byteLength <= 16 * 1024 * 1024) self.postMessage({ done: true, buf: done }, [done]); // сразу в анализ
      else self.postMessage({ done: true, buf: null });   // большая — через data/ + manifest
    } else self.postMessage({ done: false });
  }
};
self.postMessage({ ready: true });