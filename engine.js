/*
 * Habito game engine.
 *
 * Everything here is pure and derived from two inputs: the habit definitions
 * and the check-in log. Nothing (XP, streaks, shields, badges) is stored, so
 * un-checking a box can never leave the game in an inconsistent state and
 * re-checking can never be used to farm rewards.
 *
 * Design rules that make it stick (see README for the reasoning):
 *   - The tiny version of a habit counts. Showing up keeps the streak alive.
 *   - One bad day doesn't erase weeks of work: shields absorb a missed period.
 *   - Habit strength decays gradually instead of dropping to zero.
 *   - Coming back after a miss is rewarded, not shamed.
 *   - Bonus drops are unpredictable (variable reward) but deterministic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HabitEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const XP = {
    full: 10,
    tiny: 4,
    comeback: 15,
    milestone: { 7: 50, 21: 100, 30: 150, 66: 300, 100: 500, 365: 1500 },
  };
  const SHIELD = { start: 1, max: 3, earnEvery: { day: 7, week: 4 } };
  const DROP_CHANCE = 12; // percent of check-ins that roll a bonus
  // Strength halves after this many missed periods (days or weeks).
  const STRENGTH_HALF_LIFE = { day: 14, week: 3 };
  const MILESTONES = [7, 21, 30, 66, 100, 365];
  // Check-in goals per habit. 66 is the median time for a habit to become
  // automatic (Lally et al., 2010); the others are stretch goals.
  const JOURNEY = [66, 100, 365];

  // ---------- date keys (YYYY-MM-DD, calendar dates, DST-safe) ----------

  function toKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function fromUTC(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function addDays(key, n) {
    return fromUTC(parseKey(key) + n * 86400000);
  }

  function diffDays(a, b) {
    return Math.round((parseKey(b) - parseKey(a)) / 86400000);
  }

  // 0 = Monday ... 6 = Sunday
  function weekday(key) {
    return (new Date(parseKey(key)).getUTCDay() + 6) % 7;
  }

  function weekStart(key) {
    return addDays(key, -weekday(key));
  }

  // ---------- periods ----------

  /*
   * A habit's schedule is one of:
   *   { type: 'daily' }
   *   { type: 'days', days: [0, 2, 4] }   // Mon, Wed, Fri
   *   { type: 'weekly', times: 3 }        // any 3 days per week
   * Each is turned into a list of periods with a target count, so streaks and
   * shields work the same way for all of them.
   *
   * Editing a schedule must not rewrite the past, so earlier schedules are kept
   * in `pastSchedules: [{ until, schedule }]` and each date is judged by the
   * schedule that applied on that date.
   */
  function periodUnit(schedule) {
    return schedule.type === 'weekly' ? 'week' : 'day';
  }

  function segments(habit) {
    const out = [];
    let from = habit.createdAt;
    for (const past of habit.pastSchedules || []) {
      if (past.until < from) continue;
      out.push({ from, to: past.until, schedule: past.schedule });
      from = addDays(past.until, 1);
    }
    out.push({ from, to: null, schedule: habit.schedule });
    return out;
  }

  function scheduleAt(habit, key) {
    const segs = segments(habit);
    for (const seg of segs) if (seg.to === null || key <= seg.to) return seg.schedule;
    return habit.schedule;
  }

  // A week cut short (habit created mid-week, or schedule changed mid-week)
  // only asks for its share of the weekly target.
  function weekTarget(times, days) {
    if (days >= 7) return times;
    return Math.max(1, Math.min(times, days, Math.round((times * days) / 7)));
  }

  function periods(habit, today) {
    const out = [];
    for (const seg of segments(habit)) {
      const last = seg.to !== null && seg.to < today ? seg.to : today;
      if (seg.from > last) continue;
      const s = seg.schedule;
      if (s.type === 'weekly') {
        for (let w = weekStart(seg.from); w <= last; w = addDays(w, 7)) {
          const start = w < seg.from ? seg.from : w;
          const weekEnd = addDays(w, 6);
          const end = seg.to !== null && seg.to < weekEnd ? seg.to : weekEnd;
          const target = weekTarget(s.times, diffDays(start, end) + 1);
          out.push({ key: start, start, end, target, unit: 'week' });
        }
      } else {
        for (let d = seg.from; d <= last; d = addDays(d, 1)) {
          if (s.type === 'days' && !s.days.includes(weekday(d))) continue;
          out.push({ key: d, start: d, end: d, target: 1, unit: 'day' });
        }
      }
    }
    return out;
  }

  function isScheduled(habit, key) {
    const s = scheduleAt(habit, key);
    return s.type !== 'days' || s.days.includes(weekday(key));
  }

  // ---------- variable reward ----------

  // FNV-1a: cheap, stable hash so each (habit, day) has a fixed bonus roll.
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function bonusDrop(habitId, key) {
    const h = hash(`${habitId}:${key}`);
    if (h % 100 >= DROP_CHANCE) return 0;
    return 5 + ((h >>> 8) % 5) * 5; // 5, 10, 15, 20 or 25
  }

  // ---------- per-habit simulation ----------

  /*
   * Walks every period from creation to today and returns the full game state
   * for one habit. `log` maps date keys to 'full' | 'tiny'.
   */
  function simulate(habit, log, today) {
    log = log || {};
    const unit = periodUnit(habit.schedule);

    let streak = 0;
    let best = 0;
    let bestDays = 0;
    let lastUnit = null;
    let current = null;
    let shields = SHIELD.start;
    let strength = 0;
    let xp = 0;
    let fullCount = 0;
    let tinyCount = 0;
    let comebacks = 0;
    let shieldsUsed = 0;
    let pendingComeback = false;
    const statuses = {};
    const events = [];

    for (const p of periods(habit, today)) {
      // Switching between daily and weekly carries the streak over in the new unit.
      if (lastUnit && p.unit !== lastUnit) {
        streak = p.unit === 'week' ? Math.ceil(streak / 7) : streak * 7;
        best = p.unit === 'week' ? Math.ceil(best / 7) : best * 7;
      }
      lastUnit = p.unit;
      const alpha = 1 - Math.pow(0.5, 1 / STRENGTH_HALF_LIFE[p.unit]);
      const earnEvery = SHIELD.earnEvery[p.unit];
      const inProgress = p.end >= today;
      let count = 0;
      for (let d = p.start; d <= p.end && d <= today; d = addDays(d, 1)) {
        const v = log[d];
        if (!v || !isScheduled(habit, d)) continue;
        count++;
        if (v === 'tiny') {
          tinyCount++;
          xp += XP.tiny;
        } else {
          fullCount++;
          xp += XP.full;
        }
        const drop = bonusDrop(habit.id, d);
        if (drop) {
          xp += drop;
          events.push({ type: 'drop', key: d, xp: drop });
        }
        if (pendingComeback) {
          pendingComeback = false;
          comebacks++;
          xp += XP.comeback;
          events.push({ type: 'comeback', key: d, xp: XP.comeback });
        }
      }
      const met = count >= p.target;
      if (inProgress) current = { key: p.key, count, target: p.target, met };

      if (met) {
        streak++;
        if (streak % earnEvery === 0 && shields < SHIELD.max) {
          shields++;
          events.push({ type: 'shield-earned', key: p.key });
        }
        // Milestones are defined in days; weekly habits map weeks to days.
        const asDays = p.unit === 'week' ? streak * 7 : streak;
        const prevDays = p.unit === 'week' ? (streak - 1) * 7 : streak - 1;
        for (const m of MILESTONES) {
          if (prevDays < m && asDays >= m) {
            xp += XP.milestone[m];
            events.push({ type: 'milestone', key: p.key, days: m, xp: XP.milestone[m] });
          }
        }
        statuses[p.key] = 'done';
      } else if (inProgress) {
        statuses[p.key] = count > 0 ? 'partial' : 'pending';
      } else if (shields > 0) {
        shields--;
        shieldsUsed++;
        statuses[p.key] = 'shielded';
        events.push({ type: 'shield-used', key: p.key });
      } else {
        if (fullCount + tinyCount > 0) pendingComeback = true;
        streak = 0;
        statuses[p.key] = 'missed';
      }

      if (!inProgress || met) {
        strength += alpha * ((met ? 1 : count / p.target) - strength);
      }
      best = Math.max(best, streak);
      bestDays = Math.max(bestDays, p.unit === 'week' ? streak * 7 : streak);
    }

    return {
      unit,
      streak,
      best,
      bestDays,
      current,
      shields,
      shieldsUsed,
      strength: Math.round(strength * 100),
      xp,
      fullCount,
      tinyCount,
      comebacks,
      statuses,
      events,
    };
  }

  // ---------- player level ----------

  // Total XP needed to reach `level`: 0, 100, 250, 450, 700, ...
  function xpForLevel(level) {
    return 25 * (level - 1) * (level + 2);
  }

  function levelInfo(xp) {
    let level = 1;
    while (xp >= xpForLevel(level + 1)) level++;
    const floor = xpForLevel(level);
    const ceil = xpForLevel(level + 1);
    return { level, xp, into: xp - floor, needed: ceil - floor, title: title(level) };
  }

  const TITLES = [
    [1, 'Beginner'],
    [3, 'Starter'],
    [5, 'Regular'],
    [8, 'Committed'],
    [12, 'Disciplined'],
    [17, 'Unshakeable'],
    [25, 'Legend'],
  ];

  function title(level) {
    let t = TITLES[0][1];
    for (const [min, name] of TITLES) if (level >= min) t = name;
    return t;
  }

  // ---------- badges ----------

  const BADGES = [
    { id: 'first', name: 'First step', desc: 'Log your first check-in', test: (s) => s.checkins >= 1 },
    { id: 'tiny10', name: 'Showing up counts', desc: 'Use the tiny version 10 times', test: (s) => s.tiny >= 10 },
    { id: 'week', name: 'One week', desc: 'Reach a 7-day streak', test: (s) => s.bestDays >= 7 },
    { id: 'comeback', name: 'Bounce back', desc: 'Return after a missed day', test: (s) => s.comebacks >= 1 },
    { id: 'shield', name: 'Saved by the shield', desc: 'Have a shield protect a streak', test: (s) => s.shieldsUsed >= 1 },
    { id: 'month', name: 'Month strong', desc: 'Reach a 30-day streak', test: (s) => s.bestDays >= 30 },
    { id: 'auto', name: 'On autopilot', desc: 'Reach 66 days: the median time for a habit to become automatic', test: (s) => s.bestDays >= 66 },
    { id: 'strong', name: 'Rock solid', desc: 'Get a habit to 90% strength', test: (s) => s.maxStrength >= 90 },
    { id: 'hundred', name: 'Centurion', desc: 'Log 100 check-ins', test: (s) => s.checkins >= 100 },
    { id: 'level10', name: 'Double digits', desc: 'Reach level 10', test: (s) => s.level >= 10 },
  ];

  // ---------- whole game ----------

  function game(state, today) {
    const perHabit = {};
    let xp = 0;
    const agg = { checkins: 0, tiny: 0, bestDays: 0, comebacks: 0, shieldsUsed: 0, maxStrength: 0 };
    for (const h of state.habits) {
      const r = simulate(h, state.logs[h.id], today);
      perHabit[h.id] = r;
      xp += r.xp;
      agg.checkins += r.fullCount + r.tinyCount;
      agg.tiny += r.tinyCount;
      agg.comebacks += r.comebacks;
      agg.shieldsUsed += r.shieldsUsed;
      agg.bestDays = Math.max(agg.bestDays, r.bestDays);
      if (!h.archived) agg.maxStrength = Math.max(agg.maxStrength, r.strength);
    }
    const lvl = levelInfo(xp);
    agg.level = lvl.level;
    const badges = BADGES.map((b) => ({ id: b.id, name: b.name, desc: b.desc, earned: b.test(agg) }));
    return { perHabit, level: lvl, badges, stats: agg };
  }

  // ---------- data validation ----------

  const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

  function validKey(k) {
    return typeof k === 'string' && KEY_RE.test(k) && k >= '2000-01-01' && k <= '2999-12-31' && addDays(k, 0) === k;
  }

  function cleanSchedule(s) {
    if (!s || typeof s !== 'object') return null;
    if (s.type === 'daily') return { type: 'daily' };
    if (s.type === 'weekly' && Number.isInteger(s.times)) {
      return { type: 'weekly', times: Math.min(6, Math.max(1, s.times)) };
    }
    if (s.type === 'days' && Array.isArray(s.days)) {
      const days = [...new Set(s.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
      if (days.length) return { type: 'days', days };
    }
    return null;
  }

  function cleanText(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  }

  /*
   * Returns a safe copy of saved or imported data, dropping anything that
   * doesn't fit. Throws only when the data isn't Habito data at all.
   */
  function normalize(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.habits)) throw new Error('Not Habito data');
    const logsIn = data.logs && typeof data.logs === 'object' ? data.logs : {};
    const habits = [];
    const logs = {};
    let dropped = 0;
    const ids = new Set();

    for (const h of data.habits) {
      const schedule = h && cleanSchedule(h.schedule);
      const name = h && cleanText(h.name, 60);
      if (!schedule || !name || !ID_RE.test(h.id) || ids.has(h.id) || !validKey(h.createdAt)) {
        dropped++;
        continue;
      }
      ids.add(h.id);
      const pastSchedules = (Array.isArray(h.pastSchedules) ? h.pastSchedules : [])
        .map((p) => p && validKey(p.until) && cleanSchedule(p.schedule) ? { until: p.until, schedule: cleanSchedule(p.schedule) } : null)
        .filter(Boolean)
        .sort((a, b) => (a.until < b.until ? -1 : 1));
      const habit = {
        id: h.id,
        name,
        tiny: cleanText(h.tiny, 60),
        cue: cleanText(h.cue, 80),
        schedule,
        createdAt: h.createdAt,
        archived: h.archived === true,
      };
      if (pastSchedules.length) habit.pastSchedules = pastSchedules;
      habits.push(habit);

      const src = logsIn[h.id] && typeof logsIn[h.id] === 'object' ? logsIn[h.id] : {};
      const log = {};
      for (const [k, v] of Object.entries(src)) {
        if (validKey(k) && (v === 'full' || v === 'tiny')) log[k] = v;
      }
      logs[h.id] = log;
    }
    return { state: { habits, logs }, dropped };
  }

  // ---------- journey ----------

  /*
   * Progress toward the next check-in goal. Counts check-ins, not the streak,
   * so a missed day pauses the journey instead of resetting it.
   */
  function journey(count) {
    const i = JOURNEY.findIndex((g) => count < g);
    if (i === -1) return { count, goal: null, prev: JOURNEY[JOURNEY.length - 1], pct: 100 };
    const goal = JOURNEY[i];
    return { count, goal, prev: i ? JOURNEY[i - 1] : 0, pct: Math.floor((count / goal) * 100) };
  }

  // ---------- month overview ----------

  function monthDays(monthKey) {
    const first = `${monthKey}-01`;
    const out = [];
    for (let d = first; d.slice(0, 7) === monthKey; d = addDays(d, 1)) out.push(d);
    return out;
  }

  function shiftMonth(monthKey, n) {
    let [y, m] = monthKey.split('-').map(Number);
    m += n;
    y += Math.floor((m - 1) / 12);
    m = ((m - 1) % 12 + 12) % 12 + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  /*
   * One month of check-ins for every active habit, plus how many of each
   * day's habits were done. Cell states:
   *   full | tiny     logged
   *   shielded        missed, but a shield covered it
   *   missed          missed a day that was due
   *   open            no check-in on a day that wasn't strictly due (weekly habits, today)
   *   off             before the habit existed, in the future, or not scheduled
   * Today only counts toward the score once it's done, so an unfinished day
   * never lowers the percentage.
   */
  function month(state, monthKey, today) {
    const days = monthDays(monthKey);
    const rows = [];
    const daily = days.map((key) => ({ key, due: 0, done: 0 }));

    for (const h of state.habits) {
      if (h.archived) continue;
      const log = state.logs[h.id] || {};
      const sim = simulate(h, log, today);
      let done = 0;
      let dayEligible = 0;
      let weekShare = 0;
      let anyWeekly = false;

      const cells = days.map((d, i) => {
        if (d > today || d < h.createdAt || !isScheduled(h, d)) return 'off';
        const s = scheduleAt(h, d);
        const weekly = s.type === 'weekly';
        const v = log[d];
        if (v || d < today) {
          if (weekly) {
            weekShare += s.times / 7;
            anyWeekly = true;
          } else {
            dayEligible++;
          }
        }
        if (!weekly) {
          daily[i].due++;
          if (v) daily[i].done++;
        }
        if (v) {
          done++;
          return v;
        }
        if (weekly || d === today) return 'open';
        return sim.statuses[d] === 'shielded' ? 'shielded' : 'missed';
      });

      const possible = dayEligible + (anyWeekly ? Math.max(1, Math.round(weekShare)) : 0);
      const pct = possible ? Math.min(100, Math.round((done / possible) * 100)) : null;
      rows.push({ id: h.id, name: h.name, cells, done, possible, pct });
    }

    const totalDone = rows.reduce((n, r) => n + Math.min(r.done, r.possible), 0);
    const totalPossible = rows.reduce((n, r) => n + r.possible, 0);
    const perfect = daily.filter((d) => d.due > 0 && d.done === d.due).length;

    return {
      key: monthKey,
      days,
      rows,
      daily,
      perfect,
      pct: totalPossible ? Math.round((totalDone / totalPossible) * 100) : null,
    };
  }

  return {
    XP,
    SHIELD,
    MILESTONES,
    JOURNEY,
    toKey,
    addDays,
    diffDays,
    weekday,
    weekStart,
    periods,
    isScheduled,
    scheduleAt,
    normalize,
    bonusDrop,
    simulate,
    xpForLevel,
    levelInfo,
    game,
    monthDays,
    shiftMonth,
    month,
    journey,
  };
});
