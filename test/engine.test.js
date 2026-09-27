const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

const START = '2026-09-01'; // a Tuesday

function daily(id = 'h') {
  return { id, createdAt: START, schedule: { type: 'daily' } };
}

function logRange(from, n, value = 'full') {
  const log = {};
  for (let i = 0; i < n; i++) log[E.addDays(from, i)] = value;
  return log;
}

test('date helpers are calendar-based', () => {
  assert.equal(E.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(E.addDays('2026-03-29', 1), '2026-03-30'); // across EU DST
  assert.equal(E.diffDays('2026-01-01', '2026-12-31'), 364);
  assert.equal(E.weekday('2026-09-28'), 0); // Monday
  assert.equal(E.weekStart('2026-09-27'), '2026-09-21');
});

test('consecutive days build a streak', () => {
  const r = E.simulate(daily(), logRange(START, 5), E.addDays(START, 4));
  assert.equal(r.streak, 5);
  assert.equal(r.best, 5);
});

test('today not yet done does not break the streak', () => {
  const today = E.addDays(START, 5);
  const r = E.simulate(daily(), logRange(START, 5), today);
  assert.equal(r.streak, 5);
  assert.equal(r.statuses[today], 'pending');
  assert.equal(r.shields, E.SHIELD.start);
});

test('the tiny version keeps the streak alive for fewer XP', () => {
  const full = E.simulate(daily(), logRange(START, 3, 'full'), E.addDays(START, 2));
  const tiny = E.simulate(daily(), logRange(START, 3, 'tiny'), E.addDays(START, 2));
  assert.equal(tiny.streak, 3);
  assert.ok(tiny.xp < full.xp);
});

test('a shield absorbs one missed day', () => {
  const log = { ...logRange(START, 3), ...logRange(E.addDays(START, 4), 2) };
  const r = E.simulate(daily(), log, E.addDays(START, 5));
  assert.equal(r.statuses[E.addDays(START, 3)], 'shielded');
  assert.equal(r.streak, 5);
  assert.equal(r.shields, 0);
});

test('missing with no shields resets the streak and rewards the comeback', () => {
  const log = { ...logRange(START, 3), ...logRange(E.addDays(START, 5), 1) };
  const r = E.simulate(daily(), log, E.addDays(START, 5));
  assert.equal(r.statuses[E.addDays(START, 4)], 'missed');
  assert.equal(r.streak, 1);
  assert.equal(r.best, 3);
  assert.equal(r.comebacks, 1);
  assert.ok(r.events.some((e) => e.type === 'comeback'));
});

test('shields are earned every 7 days and capped', () => {
  const r = E.simulate(daily(), logRange(START, 40), E.addDays(START, 39));
  assert.equal(r.shields, E.SHIELD.max);
});

test('strength decays gradually instead of resetting', () => {
  const r1 = E.simulate(daily(), logRange(START, 30), E.addDays(START, 29));
  const r2 = E.simulate(daily(), logRange(START, 30), E.addDays(START, 31));
  assert.ok(r1.strength > 70);
  assert.ok(r2.strength < r1.strength);
  assert.ok(r2.strength > r1.strength - 10);
});

test('specific-days habits ignore unscheduled days', () => {
  const h = { id: 'g', createdAt: '2026-09-07', schedule: { type: 'days', days: [0, 2, 4] } };
  const log = { '2026-09-07': 'full', '2026-09-09': 'full', '2026-09-11': 'full', '2026-09-08': 'full' };
  const r = E.simulate(h, log, '2026-09-13');
  assert.equal(r.streak, 3);
  assert.equal(r.fullCount, 3); // Tuesday check-in doesn't count
});

test('weekly habits count completions per week', () => {
  const h = { id: 'w', createdAt: '2026-09-07', schedule: { type: 'weekly', times: 3 } };
  const log = {
    '2026-09-07': 'full', '2026-09-09': 'full', '2026-09-12': 'full',
    '2026-09-15': 'full', '2026-09-16': 'full', '2026-09-17': 'tiny',
    '2026-09-22': 'full',
  };
  const r = E.simulate(h, log, '2026-09-23');
  assert.equal(r.statuses['2026-09-07'], 'done');
  assert.equal(r.statuses['2026-09-14'], 'done');
  assert.equal(r.statuses['2026-09-21'], 'partial');
  assert.equal(r.streak, 2);
});

test('weekly habit created mid-week gets a fair first target', () => {
  const h = { id: 'w', createdAt: '2026-09-12', schedule: { type: 'weekly', times: 3 } }; // Saturday
  const r = E.simulate(h, { '2026-09-12': 'full', '2026-09-13': 'full' }, '2026-09-14');
  assert.equal(r.statuses['2026-09-07'], 'done');
});

test('bonus drops are deterministic and occasional', () => {
  assert.equal(E.bonusDrop('x', START), E.bonusDrop('x', START));
  let hits = 0;
  for (let i = 0; i < 1000; i++) if (E.bonusDrop('x', E.addDays(START, i))) hits++;
  assert.ok(hits > 60 && hits < 200, `hits=${hits}`);
});

test('milestones pay out once', () => {
  const r = E.simulate(daily(), logRange(START, 8), E.addDays(START, 7));
  assert.equal(r.events.filter((e) => e.type === 'milestone').length, 1);
});

test('levels follow the XP curve', () => {
  assert.equal(E.levelInfo(0).level, 1);
  assert.equal(E.levelInfo(99).level, 1);
  assert.equal(E.levelInfo(100).level, 2);
  assert.equal(E.levelInfo(250).level, 3);
  const l = E.levelInfo(300);
  assert.equal(l.into, 50);
  assert.equal(l.needed, 200);
});

test('game aggregates habits and badges', () => {
  const state = { habits: [daily('a'), daily('b')], logs: { a: logRange(START, 7), b: {} } };
  const g = E.game(state, E.addDays(START, 6));
  assert.equal(g.stats.checkins, 7);
  assert.ok(g.badges.find((b) => b.id === 'first').earned);
  assert.ok(g.badges.find((b) => b.id === 'week').earned);
  assert.ok(!g.badges.find((b) => b.id === 'month').earned);
});
