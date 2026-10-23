export function bindDaySwipe(root, { isEnabled, onSwipe }) {
  let gesture = null, suppressClickUntil = 0;
  const reset = () => { gesture = null; };
  root.addEventListener('touchstart', event => {
    reset();
    if (!isEnabled() || event.touches.length !== 1 || event.target.closest('input,textarea,select,[contenteditable],.date-nav') || !event.target.closest('.daily-section')) return;
    const touch = event.touches[0];
    // Leave Safari's screen-edge navigation gestures available.
    if (touch.clientX < 24 || touch.clientX > innerWidth - 24) return;
    gesture = { x: touch.clientX, y: touch.clientY, started: Date.now() };
  }, { passive: true });
  root.addEventListener('touchmove', event => {
    if (!gesture) return;
    if (event.touches.length !== 1 || !isEnabled()) return reset();
    const dx = event.touches[0].clientX - gesture.x, dy = event.touches[0].clientY - gesture.y;
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) return reset();
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5 && event.cancelable) event.preventDefault();
  }, { passive: false });
  root.addEventListener('touchend', event => {
    const current = gesture; reset();
    if (!current || !isEnabled() || event.touches.length || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - current.x, dy = event.changedTouches[0].clientY - current.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - current.started > 700) return;
    suppressClickUntil = Date.now() + 400;
    onSwipe(dx < 0 ? 1 : -1);
  }, { passive: true });
  root.addEventListener('touchcancel', reset, { passive: true });
  root.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}
