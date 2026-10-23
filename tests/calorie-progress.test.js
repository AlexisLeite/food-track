import test from 'node:test';
import assert from 'node:assert/strict';
import { calorieProgressMarkup } from '../public/calorie-progress.js';
const render = (total, target = 1800, maintenance = 2400) => calorieProgressMarkup({ total, target, maintenance });

test('below and at target only the target arrow and green intake are shown', () => {
  for (const total of [0, 900, 1800]) {
    const markup = render(total);
    assert.match(markup, /calorie-goal-target/);
    assert.doesNotMatch(markup, /calorie-goal-maintenance|class="calorie-gradient"|class="calorie-overflow"/);
  }
  assert.match(render(900), /class="calorie-fill"[^>]*width="50"/);
});

test('between target and maintenance the visible intake uses only part of the full-range gradient', () => {
  const markup = render(2100);
  assert.match(markup, /aria-valuemax="2400"/);
  assert.match(markup, /calorie-goal-maintenance/);
  assert.match(markup, /gradientUnits="userSpaceOnUse" x1="75" y1="0" x2="100"/);
  assert.match(markup, /class="calorie-gradient" x="75" y="5" width="12.5"/);
  assert.doesNotMatch(markup, /class="calorie-overflow"/);
});

test('solid red only begins past maintenance and gradient references remain unique during transitions', () => {
  assert.doesNotMatch(render(2400), /class="calorie-overflow"/);
  const first = render(3000), second = render(3000);
  assert.match(first, /class="calorie-overflow" x="80" y="5" width="20"/);
  assert.match(first, /class="calorie-gradient" x="60" y="5" width="20"/);
  const id = text => text.match(/linearGradient id="([^"]+)"/)[1];
  assert.notEqual(id(first), id(second));
  assert.ok(first.includes(`url(#${id(first)})`));
});

test('equal or higher targets, unavailable maintenance, and loading never produce invalid gradients', () => {
  for (const markup of [render(2600,2400),render(3000,2800),render(2100,1800,null),render(300,0,2400)]) {
    assert.doesNotMatch(markup, /NaN|Infinity|width="-/);
  }
  assert.doesNotMatch(render(2600,2400), /class="calorie-gradient"/);
  assert.doesNotMatch(render(2100,1800,null), /calorie-goal-maintenance/);
  assert.match(calorieProgressMarkup({unavailable:true}), /unavailable/);
});
