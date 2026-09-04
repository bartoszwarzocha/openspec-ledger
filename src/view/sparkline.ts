/**
 * Geometry for the progress curve in the change detail panel.
 *
 * The point of this chart is the time axis, so the x position of a snapshot is
 * its DATE, not its index. Spacing points evenly - which is what a sparkline
 * normally does - draws a four-month silence and a one-day gap identically, and
 * a chart that hides exactly the fact the extension exists to show is worse
 * than no chart: it reads as steady progress when the truth is a cliff.
 *
 * Pure, so every position and every tick can be checked without a webview.
 */

import { daysBetween, fromDateKey, toDateKey } from '../model/keys.ts';
import type { ProgressSnapshot, SnapshotSource } from '../model/types.ts';
import { makeProgress } from '../model/keys.ts';

export interface SparkPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  percent: number;
  completed: number;
  total: number;
  source: SnapshotSource;
}

export interface SparkDot {
  x: number;
  y: number;
  point: SparkPoint;
}

export interface SparkTick {
  x: number;
  /** Short label, e.g. `14 Jul`; the year is added when the span crosses one. */
  label: string;
  date: string;
}

export interface SparkGeometry {
  /** `d` of the progress curve. */
  line: string;
  /** The same curve closed down to the baseline. */
  area: string;
  dots: SparkDot[];
  /** Dated ticks along the x axis, first and last always included. */
  ticks: SparkTick[];
  /** Horizontal guides at 0, 50 and 100 percent, as y coordinates. */
  guides: Array<{ y: number; percent: number }>;
  /** Whole days from the first snapshot to the last. */
  spanDays: number;
  first: SparkPoint;
  last: SparkPoint;
}

export interface SparkBox {
  width: number;
  height: number;
  /** Room for the percentage scale on the left. */
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  /** Room for the date labels underneath. */
  paddingBottom: number;
}

export function sparkPoints(snapshots: readonly ProgressSnapshot[]): SparkPoint[] {
  return snapshots
    .map((snapshot) => ({
      date: snapshot.date,
      percent: makeProgress(snapshot.completed, snapshot.total).percent,
      completed: snapshot.completed,
      total: snapshot.total,
      source: snapshot.source,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-07-14` -> `14 Jul`, or `14 Jul 26` when the span crosses a year. */
export function shortDate(key: string, withYear: boolean): string {
  const date = fromDateKey(key);
  if (Number.isNaN(date.getTime())) {
    return key;
  }
  const month = MONTHS[date.getMonth()] ?? '';
  const day = date.getDate();
  return withYear ? `${day} ${month} ${`${date.getFullYear()}`.slice(2)}` : `${day} ${month}`;
}

/**
 * Up to `max` dated ticks, always including the first and the last.
 *
 * Evenly spaced in TIME rather than across the snapshots, so the labels read as
 * a calendar and the eye can measure a flat stretch against them.
 */
export function axisTicks(
  first: string,
  last: string,
  max: number,
  place: (date: string) => number,
): SparkTick[] {
  const span = daysBetween(first, last);
  const crossesYear = first.slice(0, 4) !== last.slice(0, 4);
  const tick = (date: string): SparkTick => ({
    x: place(date),
    label: shortDate(date, crossesYear),
    date,
  });

  if (span <= 0 || max <= 2) {
    return span <= 0 ? [tick(first)] : [tick(first), tick(last)];
  }

  const steps = Math.min(max - 1, span);
  const ticks: SparkTick[] = [];
  const start = fromDateKey(first);
  for (let index = 0; index <= steps; index++) {
    const at = new Date(start);
    at.setDate(at.getDate() + Math.round((span * index) / steps));
    ticks.push(tick(toDateKey(at)));
  }
  // Rounding can land two steps on the same day at a short span.
  return ticks.filter((entry, index) => index === 0 || entry.date !== ticks[index - 1]?.date);
}

/**
 * Lay the curve out inside `box`.
 *
 * A single snapshot is drawn as one dot in the middle rather than as a line at
 * zero: one measurement is one measurement, not a trend.
 */
export function sparkGeometry(
  points: readonly SparkPoint[],
  box: SparkBox,
  maxTicks = 6,
): SparkGeometry | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return undefined;
  }

  const innerWidth = box.width - box.paddingLeft - box.paddingRight;
  const innerHeight = box.height - box.paddingTop - box.paddingBottom;
  if (innerWidth <= 0 || innerHeight <= 0) {
    return undefined;
  }

  const baseline = box.height - box.paddingBottom;
  const spanDays = Math.max(0, daysBetween(first.date, last.date));
  const round = (value: number): number => Math.round(value * 100) / 100;

  const place = (date: string): number => {
    if (spanDays === 0) {
      return round(box.paddingLeft + innerWidth / 2);
    }
    const offset = Math.min(Math.max(daysBetween(first.date, date), 0), spanDays);
    return round(box.paddingLeft + (offset / spanDays) * innerWidth);
  };
  const height = (percent: number): number =>
    round(baseline - (Math.min(100, Math.max(0, percent)) / 100) * innerHeight);

  const dots: SparkDot[] = points.map((point) => ({
    x: place(point.date),
    y: height(point.percent),
    point,
  }));

  // A step, not a slope: progress changes when a box is ticked, and the days in
  // between are flat. Interpolating them would draw work that did not happen.
  const segments: string[] = [];
  dots.forEach((dot, index) => {
    if (index === 0) {
      segments.push(`M ${dot.x} ${dot.y}`);
      return;
    }
    segments.push(`H ${dot.x}`);
    segments.push(`V ${dot.y}`);
  });
  const line = segments.join(' ');

  const firstDot = dots[0];
  const lastDot = dots[dots.length - 1];
  const area =
    firstDot && lastDot && dots.length > 1
      ? `${line} V ${baseline} H ${firstDot.x} Z`
      : '';

  return {
    line,
    area,
    dots,
    ticks: axisTicks(first.date, last.date, maxTicks, place),
    guides: [0, 50, 100].map((percent) => ({ y: height(percent), percent })),
    spanDays,
    first,
    last,
  };
}

/**
 * A sentence for the reader who will not measure the axis.
 *
 * It names the two things the picture is bad at conveying precisely: how long
 * the record covers, and how much of it was reconstructed rather than watched.
 */
export function historyCaption(points: readonly SparkPoint[], spanDays: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return 'No snapshot recorded yet.';
  }
  const backfilled = points.filter((point) => point.source === 'backfilled').length;
  const span =
    spanDays === 0 ? 'a single day' : `${spanDays} day${spanDays === 1 ? '' : 's'}`;
  const reconstructed =
    backfilled === 0
      ? ''
      : backfilled === points.length
        ? ', all reconstructed from git history'
        : `, ${backfilled} of them reconstructed from git history`;
  return (
    `${points.length} snapshot${points.length === 1 ? '' : 's'} across ${span}, ` +
    `${first.date} to ${last.date}${reconstructed}. ` +
    `Now ${last.completed}/${last.total} (${last.percent}%).`
  );
}
