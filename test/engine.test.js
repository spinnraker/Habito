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

test('month helpers handle lengths and year boundaries', () => {
  assert.equal(E.monthDays('2026-02').length, 28);
  assert.equal(E.monthDays('2028-02').length, 29);
  assert.equal(E.monthDays('2026-09').at(-1), '2026-09-30');
  assert.equal(E.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(E.shiftMonth('2026-12', 1), '2027-01');
});

test('month overview scores each habit without penalising today', () => {
  const h = { id: 'a', createdAt: '2026-09-10', schedule: { type: 'daily' } };
  const log = { ...logRange('2026-09-10', 5), '2026-09-17': 'tiny' }; // 10–14, 17
  const m = E.month({ habits: [h], logs: { a: log } }, '2026-09', '2026-09-18');
  const row = m.rows[0];
  const cell = (d) => row.cells[d - 1];
  assert.equal(cell(9), 'off'); // before creation
  assert.equal(cell(10), 'full');
  assert.equal(cell(15), 'shielded'); // starting shield
  assert.equal(cell(16), 'missed');
  assert.equal(cell(17), 'tiny');
  assert.equal(cell(18), 'open'); // today, not done yet
  assert.equal(cell(19), 'off'); // future
  assert.equal(row.done, 6);
  assert.equal(row.possible, 8); // 10th–17th; today excluded until done
  assert.equal(row.pct, 75);
  assert.equal(m.perfect, 6);
});

test('month overview: weekly habits have no daily misses', () => {
  const h = { id: 'w', createdAt: '2026-09-01', schedule: { type: 'weekly', times: 2 } };
  const log = { '2026-09-01': 'full', '2026-09-03': 'full', '2026-09-08': 'full' };
  const m = E.month({ habits: [h], logs: { w: log } }, '2026-09', '2026-09-14');
  const row = m.rows[0];
  assert.ok(!row.cells.includes('missed'));
  assert.equal(row.possible, 4); // 2 a week over 13 elapsed days
  assert.equal(row.pct, 75);
  assert.equal(m.daily[0].due, 0); // weekly habits don't make a day "due"
});

test('month overview skips archived habits and empty months', () => {
  const h = { id: 'a', createdAt: '2026-09-01', schedule: { type: 'daily' }, archived: true };
  const m = E.month({ habits: [h], logs: {} }, '2026-09', '2026-09-10');
  assert.equal(m.rows.length, 0);
  assert.equal(m.pct, null);
});
