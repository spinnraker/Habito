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
   */
  function periodUnit(habit) {
    return habit.schedule.type === 'weekly' ? 'week' : 'day';
  }

  function periods(habit, today) {
    const s = habit.schedule;
    const out = [];
    if (s.type === 'weekly') {
      for (let w = weekStart(habit.createdAt); w <= today; w = addDays(w, 7)) {
        // A habit created mid-week only has to fit into the days that are left.
        const daysLeft = 7 - Math.max(0, diffDays(w, habit.createdAt));
        out.push({ key: w, start: w, end: addDays(w, 6), target: Math.min(s.times, daysLeft) });
      }
    } else {
      for (let d = habit.createdAt; d <= today; d = addDays(d, 1)) {
        if (s.type === 'days' && !s.days.includes(weekday(d))) continue;
        out.push({ key: d, start: d, end: d, target: 1 });
      }
    }
    return out;
  }

  function isScheduled(habit, key) {
    const s = habit.schedule;
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
    const unit = periodUnit(habit);
    const alpha = 1 - Math.pow(0.5, 1 / STRENGTH_HALF_LIFE[unit]);
    const earnEvery = SHIELD.earnEvery[unit];

    let streak = 0;
    let best = 0;
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

      if (met) {
        streak++;
        if (streak % earnEvery === 0 && shields < SHIELD.max) {
          shields++;
          events.push({ type: 'shield-earned', key: p.key });
        }
        // Milestones are defined in days; weekly habits map weeks to days.
        const asDays = unit === 'week' ? streak * 7 : streak;
        const prevDays = unit === 'week' ? (streak - 1) * 7 : streak - 1;
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
    }

    return {
      unit,
      streak,
      best,
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
      agg.bestDays = Math.max(agg.bestDays, r.unit === 'week' ? r.best * 7 : r.best);
      if (!h.archived) agg.maxStrength = Math.max(agg.maxStrength, r.strength);
    }
    const lvl = levelInfo(xp);
    agg.level = lvl.level;
    const badges = BADGES.map((b) => ({ id: b.id, name: b.name, desc: b.desc, earned: b.test(agg) }));
    return { perHabit, level: lvl, badges, stats: agg };
  }

  return {
    XP,
    SHIELD,
    MILESTONES,
    toKey,
    addDays,
    diffDays,
    weekday,
    weekStart,
    periods,
    isScheduled,
    bonusDrop,
    simulate,
    xpForLevel,
    levelInfo,
    game,
  };
});
