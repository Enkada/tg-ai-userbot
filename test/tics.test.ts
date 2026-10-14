// The avoid-list's "so" opener item (src/tics.ts). Synthetic replies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avoidListClause } from '../src/tics.ts';

const filler = (n: number) => Array.from({ length: n }, (_, i) => `plain reply number ${i}.`);

test('"so" openers in any shape count toward the item', () => {
  const her = ["so i'm the backup plan now.", 'oh, so you want orders.', 'okay so what now?', ...filler(27)];
  assert.match(avoidListClause(her, []), /opening with "so \.\.\."/);
});

test('below the threshold nothing is listed', () => {
  const her = ["so i'm the backup plan now.", 'oh so you want orders.', ...filler(28)];
  assert.doesNotMatch(avoidListClause(her, []), /opening with "so/);
});

test('"so much / so many / so far" and mid-sentence "so" are not openers', () => {
  const her = ['so much for that plan.', 'so far so good.', 'so many tabs open.', 'and so it goes.', 'also, sure.', ...filler(25)];
  assert.doesNotMatch(avoidListClause(her, []), /opening with "so/);
});
