import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseYamlDate } from './yaml.ts';

test('a declared date is read as local midnight on that day', () => {
  const parsed = parseYamlDate('2026-02-13');

  assert.ok(parsed);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 1);
  assert.equal(parsed.getDate(), 13);
});

test('a day that never happened is unparseable rather than the day it rolls into', () => {
  assert.equal(parseYamlDate('2026-02-31'), undefined);
  assert.equal(parseYamlDate('2026-13-01'), undefined);
  assert.equal(parseYamlDate('2026-04-31'), undefined);
});

test('the leap day is read on a leap year and rejected otherwise', () => {
  assert.ok(parseYamlDate('2024-02-29'));
  assert.equal(parseYamlDate('2026-02-29'), undefined);
});
