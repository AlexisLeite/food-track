import { showProcessing, hideProcessing } from './processing.js';
const mic = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M8 21h8"/></svg>';
const stop = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const textIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>';
const sendIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m4 4 17 8-17 8 3-8zM7 12h14"/></svg>';
export function createVoiceInput({ toast, onBusyChange }) {
  let context = null, session = null, generation = 0, sending = false;
  const live = ctx => context === ctx && ctx.form.isConnected && ctx.form.closest('dialog')?.open;
  function state(ctx, mode, message = '') {
    if (!ctx?.form.isConnected) return;
    if (mode === 'sending') showProcessing(ctx.form, 'audio', 'Procesando audio…');
    else hideProcessing(ctx.form);
    const button = ctx.form.querySelector('[data-action=record-audio]');
    button.innerHTML = mode === 'recording' ? stop : mic;
    button.setAttribute('aria-label', mode === 'recording' ? 'Detener y enviar audio' : 'Grabar audio');
    button.title = button.getAttribute('aria-label');
    button.classList.toggle('recording', mode === 'recording');
    button.disabled = mode === 'requesting' || mode === 'sending';
    ctx.form.querySelector('[data-action=write-food]').disabled = mode !== 'idle';
    ctx.form.querySelector('[data-voice-status]').textContent = message || 'Tocá para grabar';
  }
  function release(recording) {
    clearTimeout(recording.timeout); clearInterval(recording.ticker);
    recording.stream?.getTracks().forEach(track => track.stop()); recording.chunks.length = 0;
  }
  function cancel({ restore = true } = {}) {
    settleMode(context);
    generation++; sending = false;
    if (session) {
      const previous = session; session = null; previous.send = false;
      if (previous.recorder?.state === 'recording') previous.recorder.stop();
      release(previous);
    }
    if (restore) state(context, 'idle'); onBusyChange(false);
  }
  async function send(blob, ctx) {
    if (!live(ctx) || sending || session) return;
    if (!blob.size || blob.size > 8 * 1024 * 1024) {
      state(ctx, 'idle'); onBusyChange(false);
      return toast(!blob.size ? 'No se grabó audio. Probá de nuevo.' : 'El audio supera los 8 MB.', true);
    }
    const request = ++generation; let handedOff = false;
    sending = true; onBusyChange(true); state(ctx, 'sending');
    try {
      handedOff = true;
      await ctx.onAudio(blob);
    } catch {
      handedOff = false; // The outbox keeps the audio and presents retry/delete actions.
    } finally {
      if (request === generation) { sending = false; onBusyChange(false); if (!handedOff) state(ctx, 'idle'); }
    }
  }

  function finish() {
    if (session?.recorder?.state !== 'recording') return;
    session.send = true; state(session.context, 'sending'); session.recorder.stop();
  }
  async function record() {
    if (session?.recorder?.state === 'recording') { finish(); return; }
    if (session || sending || !live(context) || context.form.dataset.processing) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Este navegador no permite grabar audio.', true);
    const ctx = context, request = ++generation;
    const recording = { context: ctx, chunks: [], stream: null, recorder: null, send: false };
    session = recording; onBusyChange(true); state(ctx, 'requesting', 'Activando micrófono…');
    try {
      recording.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (request !== generation || !live(ctx)) { release(recording); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = recording.recorder = new MediaRecorder(recording.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 24000 });
      recorder.ondataavailable = event => { if (request === generation && event.data.size) recording.chunks.push(event.data); };
      recorder.onerror = () => { if (request === generation) { cancel(); toast('No se pudo grabar el audio. Probá de nuevo.', true); } };
      recorder.onstop = () => {
        const shouldSend = recording.send && request === generation && live(ctx);
        const blob = shouldSend ? new Blob(recording.chunks, { type: recorder.mimeType }) : null;
        release(recording); recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
        if (session === recording) session = null;
        if (request === generation && !shouldSend) { state(ctx, 'idle'); onBusyChange(false); }
        if (shouldSend) send(blob, ctx);
      };
      recorder.start(); state(ctx, 'recording', 'Grabando… 0:00');
      ctx.form.querySelector('[data-action=record-audio]').focus({ preventScroll: true });
      const started = Date.now();
      recording.ticker = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); ctx.form.querySelector('[data-voice-status]').textContent = `Grabando… ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2, '0')}`; }, 1000);
      recording.timeout = setTimeout(finish, 60000);
    } catch {
      release(recording);
      if (request === generation) { session = null; state(ctx, 'idle'); onBusyChange(false); toast('No se pudo acceder al micrófono. Revisá el permiso y volvé a grabar.', true); }
    }
  }
  async function submitText(event) {
    event.preventDefault();
    const ctx = context;
    if (!live(ctx) || sending || session || ctx.form.dataset.processing) return;
    const text = ctx.form.querySelector('[data-meal-text]').value.trim();
    if (!text || text.length > 1500) return;
    const request = ++generation, editor = ctx.form.querySelector('[data-text-editor]');
    sending = true; onBusyChange(true);
    editor.querySelectorAll('textarea,button').forEach(element => { element.disabled = true; });
    showProcessing(ctx.form, 'text', 'Analizando comida…');
    try { await ctx.onTranscript(text, 'text'); }
    catch { /* The outbox keeps the text and displays the failure. */ }
    finally {
      if (request === generation) {
        sending = false; onBusyChange(false);
        editor.querySelectorAll('textarea,button').forEach(element => { element.disabled = false; });
        state(ctx, 'idle');
      }
    }
  }
  function settleMode(ctx) {
    if (!ctx) return;
    ctx.modeToken = (ctx.modeToken || 0) + 1;
    ctx.modeAnimations?.forEach(animation => animation.cancel()); ctx.modeAnimations = [];
    const options = ctx.form.querySelector('[data-input-options]'), editor = ctx.form.querySelector('[data-text-editor]');
    options.hidden = !!ctx.modeWriting; editor.hidden = !ctx.modeWriting;
    options.inert = !!ctx.modeWriting; editor.inert = !ctx.modeWriting;
    options.setAttribute('aria-hidden', String(!!ctx.modeWriting)); editor.setAttribute('aria-hidden', String(!ctx.modeWriting));
    ctx.form.querySelector('.input-surface').classList.remove('is-switching');
  }
  function setMode(writing) {
    const ctx = context;
    if (!live(ctx) || sending || session || ctx.form.dataset.processing || !!ctx.modeWriting === writing) return;
    const surface = ctx.form.querySelector('.input-surface'), startHeight = surface.getBoundingClientRect().height;
    settleMode(ctx);
    const options = ctx.form.querySelector('[data-input-options]'), editor = ctx.form.querySelector('[data-text-editor]');
    const incoming = writing ? editor : options, outgoing = writing ? options : editor;
    ctx.modeWriting = writing;
    incoming.hidden = false; incoming.inert = false; incoming.setAttribute('aria-hidden', 'false');
    outgoing.inert = true; outgoing.setAttribute('aria-hidden', 'true');
    const target = ctx.form.querySelector(writing ? '[data-meal-text]' : '[data-action=write-food]');
    target.focus({ preventScroll: true });
    if (!surface.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { settleMode(ctx); return; }
    const token = ctx.modeToken, direction = writing ? 1 : -1;
    surface.classList.add('is-switching');
    const timing = { duration: 180, easing: 'cubic-bezier(.22,.61,.36,1)' };
    ctx.modeAnimations = [
      outgoing.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: `translateX(${-direction * 12}px)` }], timing),
      incoming.animate([{ opacity: 0, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'translateX(0)' }], timing),
      surface.animate([{ height: `${startHeight}px` }, { height: `${incoming.getBoundingClientRect().height}px` }], timing)
    ];
    Promise.allSettled(ctx.modeAnimations.map(animation => animation.finished)).then(() => { if (ctx.modeToken === token) settleMode(ctx); });
  }
  function choose() { setMode(false); }
  function write() { setMode(true); }
  return {
    button() { return `<div class="input-surface"><div class="input-options" data-input-options><div class="voice-control"><button type="button" class="composer-action" data-action="record-audio" aria-label="Grabar audio" title="Grabar audio">${mic}</button><p class="voice-status" data-voice-status role="status" aria-live="polite">Tocá para grabar</p></div><div class="voice-control"><button type="button" class="composer-action" data-action="write-food" aria-label="Tocá para escribir" title="Tocá para escribir">${textIcon}</button><p class="voice-status">Tocá para escribir</p></div></div><div class="text-editor" data-text-editor hidden inert aria-hidden="true"><div class="composer"><textarea data-meal-text maxlength="1500" aria-label="Descripción o corrección de la comida" placeholder="Describí la comida o lo que querés corregir…"></textarea><button type="submit" class="composer-action" aria-label="Enviar texto" title="Enviar texto">${sendIcon}</button></div><button type="button" class="text" data-action="input-options">Volver</button></div></div>`; },
    bind(form, onTranscript, onAudio) { cancel(); context = { form, onTranscript, onAudio }; form.onsubmit = submitText; },
    record, cancel, write, choose
  };
}
