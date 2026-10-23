import test from 'node:test';
import assert from 'node:assert/strict';
import { isMobileSafari, applyDockOffset } from '../public/dock-offset.js';
const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 };

test('Safari toolbar correction is limited to mobile Safari with browser controls', () => {
  assert.equal(isMobileSafari(iphone), true);
  const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 };
  assert.equal(isMobileSafari(ipad), true);
  assert.equal(isMobileSafari({ ...ipad, maxTouchPoints: 0 }), false);
  assert.equal(isMobileSafari(iphone, true), false);
  assert.equal(isMobileSafari({ ...iphone, standalone: true }), false);
  for (const token of ['CriOS/142', 'FxiOS/142', 'EdgiOS/142', 'OPiOS/142']) {
    assert.equal(isMobileSafari({ ...iphone, userAgent: iphone.userAgent + ' ' + token }), false);
  }
  assert.equal(isMobileSafari({ userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/142 Mobile Safari/537.36' }), false);
});

test('the verified offset is exactly 16px and resets for other browsers', () => {
  const values = {}, classes = new Set();
  const element = { style: { setProperty: (key, value) => { values[key] = value; } }, classList: { toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key) } };
  applyDockOffset(iphone, element, false);
  assert.equal(values['--dock-bottom-offset'], '16px');
  assert.ok(classes.has('safari-dock-offset'));
  applyDockOffset({ userAgent: 'Chrome' }, element, false);
  assert.equal(values['--dock-bottom-offset'], '0px');
  assert.ok(!classes.has('safari-dock-offset'));
});
