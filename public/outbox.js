export async function submissionHash(value) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Blobs stay in IndexedDB, scoped to the signed-in account, until the complete workflow succeeds.
export function createOutboxStore(indexedDB = globalThis.indexedDB) {
  let opening;
  const open = () => opening ||= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('Este navegador no permite guardar envíos pendientes.'));
    const request = indexedDB.open('foodtrack-outbox', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('submissions', { keyPath: 'id' });
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
    request.onerror = () => { opening = null; reject(request.error); };
  });
  const transaction = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('submissions', mode), request = action(tx.objectStore('submissions'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('No se pudo guardar el envío en este dispositivo.'));
    });
  };
  return {
    // Store bytes rather than Blob objects: Safari can reject cloning a recorded
    // Blob into IndexedDB even though the same transaction accepts ArrayBuffer.
    put: async item => {
      const { blob, ...record } = item;
      if (blob) { record.blobBytes = await blob.arrayBuffer(); record.blobType = blob.type; }
      return transaction('readwrite', store => store.put(record));
    },
    remove: id => transaction('readwrite', store => store.delete(id)),
    list: async userId => (await transaction('readonly', store => store.getAll())).filter(item => item.userId === userId).map(record => {
      const { blobBytes, blobType, ...item } = record;
      if (blobBytes) item.blob = new Blob([blobBytes], { type: blobType });
      return item;
    })
  };
}

export function createOutbox({ store = createOutboxStore(), notify = () => {} } = {}) {
  let userId = null, revision = 0;
  const items = new Map(), running = new Set(), handlers = new Map();
  const panel = document.createElement('details'); panel.className = 'pending-submissions'; panel.hidden = true;
  let urls = [];
  const render = () => {
    urls.forEach(URL.revokeObjectURL); urls = []; panel.replaceChildren();
    const visible = [...items.values()].filter(item => item.userId === userId && (item.error || !running.has(item.id)));
    panel.hidden = !visible.length;
    if (!visible.length) return;
    const summary = document.createElement('summary'); summary.textContent = `Envíos pendientes (${visible.length})`; panel.append(summary);
    for (const item of visible) {
      const row = document.createElement('div'); row.className = 'pending-submission';
      const label = document.createElement('strong');
      label.textContent = `${item.kind.startsWith('chat') ? 'Asistente' : item.mealId ? 'Corrección de comida' : 'Comida'} · ${item.date || new Intl.DateTimeFormat('es-UY').format(new Date(item.createdAt))}`; row.append(label);
      if (item.blob) {
        const preview = document.createElement(item.blob.type.startsWith('image/') ? 'img' : 'audio');
        preview.src = URL.createObjectURL(item.blob); urls.push(preview.src);
        if (preview.tagName === 'AUDIO') { preview.controls = true; preview.preload = 'none'; } else preview.alt = 'Foto pendiente';
        row.append(preview);
      }
      if (item.text) { const text = document.createElement('p'); text.textContent = item.text; row.append(text); }
      const status = document.createElement('small'); status.textContent = running.has(item.id) ? 'Enviando…' : item.error || 'Guardado en este dispositivo'; row.append(status);
      const actions = document.createElement('div'); actions.className = 'pending-actions';
      for (const [label, action] of [['Reintentar', () => retry(item.id).catch(() => {})], ['Eliminar', async () => {
        try { await store.remove(item.id); items.delete(item.id); render(); } catch { notify('No se pudo eliminar el envío pendiente.', true); }
      }]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = running.has(item.id); button.onclick = action; actions.append(button);
      }
      row.append(actions); panel.append(row);
    }
  };
  async function retry(id) {
    const item = items.get(id), identity = userId;
    if (!item || item.userId !== identity) throw new Error('Iniciá sesión con el usuario de este envío.');
    if (running.has(id)) throw new Error('El envío ya está en curso.');
    running.add(id); render();
    const checkUser = () => { if (userId !== identity) throw new Error('El envío quedó pendiente al cambiar de usuario.'); };
    const checkpoint = async fields => { Object.assign(item, fields); await store.put(item); checkUser(); };
    try {
      await store.put(item); checkUser();
      const handler = handlers.get(item.kind); if (!handler) throw new Error('No se pudo recuperar este envío.');
      const result = await handler(item, checkpoint, checkUser);
      await store.remove(id); items.delete(id); return result;
    } catch (error) {
      item.error = error.message || 'No se pudo enviar.';
      try { await store.put(item); } catch { item.error = 'No se pudo guardar en el dispositivo. No cierres esta página.'; }
      if (identity === userId) { panel.open = true; notify(`${item.error} El envío sigue pendiente.`, true); }
      throw error;
    } finally { running.delete(id); render(); }
  }
  return {
    register(kind, handler) { handlers.set(kind, handler); },
    async submit(fields) {
      if (!userId) throw new Error('Iniciá sesión antes de enviar.');
      const identity = userId;
      const id = await submissionHash(JSON.stringify({ ...fields, blob: fields.blob ? { size: fields.blob.size, type: fields.blob.type } : null, nonce: crypto.randomUUID() }));
      if (userId !== identity) throw new Error('El usuario cambió antes de guardar el envío.');
      const item = { ...fields, id, userId: identity, createdAt: new Date().toISOString() };
      items.set(item.id, item); return retry(item.id);
    },
    retry,
    setUser(next) {
      if (next === userId) return;
      userId = next; const token = ++revision; render();
      if (next) store.list(next).then(saved => {
        if (revision !== token) return;
        for (const item of saved) if (!items.has(item.id)) items.set(item.id, item);
        render();
      }).catch(() => notify('No se pudieron leer los envíos pendientes de este dispositivo.', true));
    },
    mount(root) { root.prepend(panel); render(); }
  };
}

export async function processFoodSubmission(item, checkpoint, checkUser, { request, preparePhoto }) {
  const send = async (url, body, step) => {
    checkUser();
    const result = await request(url, { method: 'POST', body, headers: { 'X-Submission-ID': await submissionHash(`${item.id}:${step}`) } });
    checkUser(); return result;
  };
  if (item.blob?.type.startsWith('audio/') && !item.text) {
    const payload = new FormData(); payload.append('audio', item.blob, 'message.audio');
    const result = await send('/api/transcribe', payload, 'transcribe');
    if (!result.text?.trim()) throw new Error('No se escuchó voz en el audio.');
    await checkpoint({ text: result.text.trim() });
  }
  if (!item.mealId) {
    let data;
    if (item.kind === 'photo') {
      if (!item.prepared) await checkpoint({ blob: await preparePhoto(item.blob), prepared: true });
      const payload = new FormData(); payload.append('date', item.date); payload.append('photo', item.blob, 'comida.jpg');
      data = await send('/api/meals', payload, 'create');
    } else data = await send('/api/meals/describe', { date: item.date, description: item.text }, 'create');
    await checkpoint({ mealId: data.meal.id });
  }
  return send(`/api/meals/${item.mealId}/analyze`, { instructions: item.kind === 'reevaluate' ? item.text || '' : '' }, 'analyze');
}
