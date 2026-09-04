import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProgressSnapshot } from '../model/types.ts';
import { axisTicks, historyCaption, shortDate, sparkGeometry, sparkPoints } from './sparkline.ts';

const BOX = {
  width: 720,
  height: 160,
  paddingLeft: 34,
  paddingRight: 12,
  paddingTop: 12,
  paddingBottom: 26,
};

function snap(date: string, completed: number, total = 63, source: 'observed' | 'backfilled' = 'backfilled'): ProgressSnapshot {
  return { date, completed, total, source };
}

test('snapshots are ordered by date whatever order they arrive in', () => {
  const points = sparkPoints([snap('2026-09-04', 61), snap('2026-07-14', 55)]);
  assert.deepEqual(points.map((p) => p.date), ['2026-07-14', '2026-09-04']);
});

test('a point sits where its DATE falls, not where its index falls', () => {
  // The whole failure this replaces: three snapshots, the middle one one day
  // after the first and 51 days before the last. Even spacing would put it at
  // the halfway mark and draw a four-month silence as steady progress.
  const geometry = sparkGeometry(
    sparkPoints([snap('2026-07-14', 55), snap('2026-07-15', 61), snap('2026-09-04', 61)]),
    BOX,
  );
  assert.ok(geometry);
  const [first, middle, last] = geometry.dots;
  assert.ok(first && middle && last);

  const span = last.x - first.x;
  const offset = middle.x - first.x;
  // 1 day of 52, so it belongs hard against the left, not in the middle.
  assert.ok(offset / span < 0.05, `middle point sits at ${((offset / span) * 100).toFixed(1)}% of the span`);
  assert.equal(geometry.spanDays, 52);
});

test('a flat stretch is drawn flat, because no box was ticked in it', () => {
  const geometry = sparkGeometry(sparkPoints([snap('2026-07-14', 61), snap('2026-09-04', 61)]), BOX);
  assert.ok(geometry);
  // A step path: horizontal to the new date, then vertical to the new value.
  assert.match(geometry.line, /^M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+$/);
  const [a, b] = geometry.dots;
  assert.equal(a?.y, b?.y);
});

test('one snapshot is one dot in the middle, not a line from zero', () => {
  const geometry = sparkGeometry(sparkPoints([snap('2026-09-04', 32, 32, 'observed')]), BOX);
  assert.ok(geometry);
  assert.equal(geometry.dots.length, 1);
  assert.equal(geometry.dots[0]?.x, BOX.paddingLeft + (BOX.width - BOX.paddingLeft - BOX.paddingRight) / 2);
  assert.equal(geometry.area, '', 'a single measurement is not a trend to shade under');
  assert.equal(geometry.spanDays, 0);
});

test('100 percent reaches the top of the box and 0 percent the baseline', () => {
  const geometry = sparkGeometry(sparkPoints([snap('2026-01-01', 0, 10), snap('2026-01-11', 10, 10)]), BOX);
  assert.ok(geometry);
  assert.equal(geometry.dots[0]?.y, BOX.height - BOX.paddingBottom);
  assert.equal(geometry.dots[1]?.y, BOX.paddingTop);
  assert.deepEqual(geometry.guides.map((g) => g.percent), [0, 50, 100]);
});

test('the axis carries dated ticks, first and last among them', () => {
  const geometry = sparkGeometry(
    sparkPoints([snap('2026-06-01', 0), snap('2026-07-14', 55), snap('2026-09-04', 61)]),
    BOX,
    6,
  );
  assert.ok(geometry);
  assert.ok(geometry.ticks.length >= 2 && geometry.ticks.length <= 6);
  assert.equal(geometry.ticks[0]?.date, '2026-06-01');
  assert.equal(geometry.ticks[geometry.ticks.length - 1]?.date, '2026-09-04');
  for (const tick of geometry.ticks) {
    assert.match(tick.label, /^\d{1,2} [A-Z][a-z]{2}( \d{2})?$/, `tick label ${tick.label}`);
  }
});

test('ticks gain the year only when the record crosses one', () => {
  assert.equal(shortDate('2026-07-14', false), '14 Jul');
  assert.equal(shortDate('2026-07-14', true), '14 Jul 26');
  const crossing = axisTicks('2025-12-20', '2026-01-10', 3, () => 0);
  assert.ok(crossing.every((tick) => /\d{2}$/.test(tick.label)));
});

test('a one-day record does not produce two ticks on the same day', () => {
  const ticks = axisTicks('2026-09-04', '2026-09-05', 6, () => 0);
  assert.deepEqual(ticks.map((t) => t.date), ['2026-09-04', '2026-09-05']);
});

test('the caption states the span and how much was reconstructed', () => {
  const points = sparkPoints([
    snap('2026-07-14', 55),
    snap('2026-09-04', 61, 63, 'observed'),
  ]);
  const caption = historyCaption(points, 52);
  assert.match(caption, /2 snapshots across 52 days/);
  assert.match(caption, /2026-07-14 to 2026-09-04/);
  assert.match(caption, /1 of them reconstructed from git history/);
  assert.match(caption, /Now 61\/63 \(97%\)/);
});

test('a record with no snapshots yields no geometry', () => {
  assert.equal(sparkGeometry([], BOX), undefined);
  assert.equal(historyCaption([], 0), 'No snapshot recorded yet.');
});
