export function isMobileSafari(browser, standalone = false) {
  const ua = browser.userAgent || '';
  const mobile = /iPhone|iPad|iPod/.test(ua) || (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1);
  const safari = /Version\/[\d.]+.*Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\//.test(ua);
  return mobile && safari && !standalone && !browser.standalone;
}
export function applyDockOffset(browser = navigator, element = document.documentElement, standalone = matchMedia('(display-mode: standalone)').matches) {
  const enabled = isMobileSafari(browser, standalone);
  element.style.setProperty('--dock-bottom-offset', enabled ? '16px' : '0px');
  element.classList.toggle('safari-dock-offset', enabled);
}
if (typeof window !== 'undefined') applyDockOffset();
