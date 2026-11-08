export function createSemaphore(capacity) {
  let active = 0;
  const waiting = [];
  function drain() {
    while (active < capacity && waiting.length) {
      const next = waiting.shift();
      next.signal?.removeEventListener('abort', next.abort);
      active++;
      let released = false;
      next.resolve(() => { if (released) return; released = true; active--; drain(); });
    }
  }
  return { acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Solicitud cancelada.'));
      const entry = { resolve, signal, abort: () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(new Error('Solicitud cancelada.')); } };
      signal?.addEventListener('abort', entry.abort, { once: true });
      waiting.push(entry); drain();
    });
  } };
}
