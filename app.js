(function () {
  'use strict';

  const E = window.HabitEngine;
  const STORE = 'habito:v1';
  const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const SOFT_LIMIT = 3;
  const HISTORY_WEEKS = 52;
  const JOURNEY_TEXT = {
    66: { to: 'until it’s automatic', reached: 'It’s automatic now' },
    100: { to: 'to 100', reached: 'Triple digits' },
    365: { to: 'to a full year', reached: 'A full year' },
  };

  const app = document.getElementById('app');
  const sheetEl = document.getElementById('sheet');
  const toastEl = document.getElementById('toast');

  let state = load();
  let view = 'today';
  let monthKey = today().slice(0, 7);
  let sheet = null; // { type: 'form', draft, id } | { type: 'detail', id }
  let lastToday = today();

  // ---------- storage ----------

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORE);
      if (raw) {
        const { state: s, dropped } = E.normalize(JSON.parse(raw));
        if (dropped) localStorage.setItem(`${STORE}:unreadable:${Date.now()}`, raw);
        return s;
      }
    } catch (e) {
      // Unreadable data: keep a copy instead of overwriting it on the next save.
      try { if (raw) localStorage.setItem(`${STORE}:unreadable:${Date.now()}`, raw); } catch (e2) { /* storage unavailable */ }
    }
    return { habits: [], logs: {} };
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }

  // ---------- helpers ----------

  function today() { return E.toKey(new Date()); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  function habit(id) { return state.habits.find((h) => h.id === id); }

  function active() { return state.habits.filter((h) => !h.archived); }

  function logOf(id) { return state.logs[id] || (state.logs[id] = {}); }

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  function scheduleText(s) {
    if (s.type === 'daily') return 'Every day';
    if (s.type === 'weekly') return `${plural(s.times, 'time')} a week`;
    return s.days.slice().sort().map((d) => DAY_NAMES[d]).join(', ');
  }

  // A habit is finished for today once it's logged, or once a weekly target is met.
  function doneToday(h, r, t) {
    return !!logOf(h.id)[t] || (h.schedule.type === 'weekly' && !!r.current && r.current.met);
  }

  function longDate(key) {
    return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function progressBar(pct, label) {
    return `<div class="bar" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`;
  }

  // Shown for sighted users; screen readers get the same facts as text.
  function legend(withMissed) {
    return `<div class="legend" aria-hidden="true">
        <span><i style="background:var(--fg)"></i>Done</span>
        <span><i style="background:var(--muted)"></i>Tiny</span>
        <span><i style="box-shadow:inset 0 0 0 1.5px var(--muted)"></i>Shielded</span>
        ${withMissed ? '<span><i style="background:linear-gradient(to top, var(--muted) 30%, var(--faint) 30%)"></i>Missed</span>' : ''}
      </div>`;
  }

  function tally(cells) {
    const n = (c) => cells.filter((x) => x === c).length;
    const parts = [[n('full'), 'done'], [n('tiny'), 'tiny'], [n('shielded'), 'shielded'], [n('missed'), 'missed']]
      .filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`);
    return parts.length ? parts.join(', ') : 'no check-ins yet';
  }

  // Re-rendering replaces the DOM; put focus back on the same control so
  // keyboard and VoiceOver users don't get thrown to the top of the page.
  const FOCUS_KEYS = ['action', 'id', 'key', 'view', 'type', 'day', 'delta', 'field'];
  function focusKey() {
    const el = document.activeElement;
    if (!el || el === document.body || !el.dataset) return null;
    const sel = FOCUS_KEYS.filter((k) => el.dataset[k] !== undefined)
      .map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`).join('');
    return sel || null;
  }
  function refocus(root, sel) {
    if (!sel) return;
    // If that exact control is gone (e.g. the tiny link after using it),
    // fall back to the same habit's check button, then anything for that habit.
    const id = /\[data-id="([^"]*)"\]/.exec(sel);
    const tries = [sel];
    if (id) tries.push(`[data-action="check"][data-id="${id[1]}"]`, `[data-id="${id[1]}"]`);
    for (const t of tries) {
      const el = root.querySelector(t);
      if (el && !el.disabled) { el.focus({ preventScroll: true }); return; }
    }
  }

  // ---------- toasts ----------

  const queue = [];
  let toasting = false;

  function toast(...msgs) {
    queue.length = 0; // a new action replaces messages still waiting
    queue.push(...msgs);
    if (!toasting) nextToast();
  }

  function nextToast() {
    const msg = queue.shift();
    if (!msg) { toasting = false; return; }
    toasting = true;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => {
      toastEl.classList.remove('show');
      setTimeout(nextToast, 260);
    }, 1500);
  }

  // ---------- actions ----------

  function setLog(id, key, value) {
    const t = today();
    const before = E.game(state, t);
    const log = logOf(id);
    if (value) log[key] = value; else delete log[key];
    save();
    const after = E.game(state, t);
    if (value) celebrate(before, after, id);
    if (value && navigator.vibrate) navigator.vibrate(8);
    render();
  }

  function celebrate(before, after, id) {
    const msgs = [];
    const gained = after.level.xp - before.level.xp;
    if (gained > 0) msgs.push(`+${gained} XP`);

    const seen = new Set(before.perHabit[id].events.map((e) => e.type + e.key + (e.days || '')));
    for (const e of after.perHabit[id].events) {
      if (seen.has(e.type + e.key + (e.days || ''))) continue;
      if (e.type === 'drop') msgs.push(`Bonus · +${e.xp}`);
      if (e.type === 'comeback') msgs.push('Welcome back · +' + e.xp);
      if (e.type === 'shield-earned') msgs.push('Shield earned');
      if (e.type === 'milestone') msgs.push(`${e.days}-day milestone · +${e.xp}`);
    }
    const b = before.perHabit[id];
    const a = after.perHabit[id];
    const was = b.fullCount + b.tinyCount;
    const now = a.fullCount + a.tinyCount;
    for (const goal of E.JOURNEY) {
      if (was < goal && now >= goal) {
        // A streak milestone for the same number already fired: say it once.
        const i = msgs.findIndex((m) => m.startsWith(`${goal}-day milestone`));
        const text = `${goal} check-ins · ${JOURNEY_TEXT[goal].reached}`;
        if (i === -1) msgs.push(text);
        else msgs[i] = `${JOURNEY_TEXT[goal].reached} · ${msgs[i].split(' · ')[1]}`;
      }
    }
    if (after.level.level > before.level.level) msgs.push(`Level ${after.level.level} · ${after.level.title}`);
    after.badges.forEach((b, i) => {
      if (b.earned && !before.badges[i].earned) msgs.push(`Badge · ${b.name}`);
    });
    if (msgs.length) toast(...msgs);
  }

  function cycle(v) { return !v ? 'full' : v === 'full' ? 'tiny' : null; }

  let opener = null; // control that opened the sheet, to return focus to

  function openSheet(s) {
    if (!sheet) opener = focusKey();
    sheet = s;
    document.body.style.overflow = 'hidden';
    app.inert = true;
    app.setAttribute('aria-hidden', 'true');
    renderSheet();
    sheetEl.scrollTop = 0;
    const title = sheetEl.querySelector('#sheet-title');
    if (title) title.focus({ preventScroll: true });
  }

  function closeSheet() {
    sheet = null;
    document.body.style.overflow = '';
    app.inert = false;
    app.removeAttribute('aria-hidden');
    renderSheet();
    render();
    refocus(app, opener);
    opener = null;
  }

  function newDraft(h) {
    if (h) {
      return {
        name: h.name, tiny: h.tiny || '', cue: h.cue || '',
        type: h.schedule.type,
        days: h.schedule.days ? h.schedule.days.slice() : [0, 2, 4],
        times: h.schedule.times || 3,
      };
    }
    return { name: '', tiny: '', cue: '', type: 'daily', days: [0, 2, 4], times: 3 };
  }

  function draftValid(d) {
    return d.name.trim() && (d.type !== 'days' || d.days.length > 0);
  }

  function saveDraft() {
    const d = sheet.draft;
    if (!draftValid(d)) return;
    const schedule =
      d.type === 'daily' ? { type: 'daily' } :
      d.type === 'days' ? { type: 'days', days: d.days.slice().sort() } :
      { type: 'weekly', times: d.times };
    const fields = { name: d.name.trim(), tiny: d.tiny.trim(), cue: d.cue.trim(), schedule };
    const t = today();
    if (sheet.id) {
      const h = habit(sheet.id);
      if (!h) return closeSheet();
      if (JSON.stringify(h.schedule) !== JSON.stringify(schedule) && h.createdAt < t) {
        // The new schedule applies from today; past days keep the old one.
        h.pastSchedules = (h.pastSchedules || []).concat({ until: E.addDays(t, -1), schedule: h.schedule });
      }
      Object.assign(h, fields);
      save();
      openSheet({ type: 'detail', id: h.id });
      render();
      return;
    }
    state.habits.push({ id: uid(), createdAt: t, archived: false, ...fields });
    save();
    closeSheet();
  }

  function exportData() {
    const json = JSON.stringify(state, null, 2);
    const name = `habito-${today()}.json`;
    // Downloads are unreliable in an iPhone home-screen app; the share sheet
    // lets you save to Files instead.
    const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare && typeof File === 'function') {
      const file = new File([json], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Habito backup' }).catch((e) => {
          if (e && e.name !== 'AbortError') download(json, name);
        });
        return;
      }
    }
    download(json, name);
  }

  function download(json, name) {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.hidden = true;
    document.body.appendChild(input); // some Safari versions ignore detached inputs
    input.onchange = () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      file.text().then((text) => {
        const { state: next, dropped } = E.normalize(JSON.parse(text));
        if (!next.habits.length && dropped) throw new Error('nothing usable');
        const note = dropped ? ` ${plural(dropped, 'habit')} in it can’t be read and will be skipped.` : '';
        if (!confirm(`Replace all current data with this backup?${note}`)) return;
        state = next;
        save();
        monthKey = today().slice(0, 7);
        render();
        toast('Backup restored');
      }).catch(() => toast('That file isn’t a Habito backup'));
    };
    input.click();
  }

  // ---------- rendering: main ----------

  function render() {
    const t = today();
    const g = E.game(state, t);
    const body = view === 'today' ? todayView(g, t) : view === 'month' ? monthView(t) : progressView(g);
    const keep = sheet ? null : focusKey();
    app.innerHTML = top() + body;
    refocus(app, keep);
  }

  function top() {
    const tab = (id, label) =>
      `<button class="tab" data-action="view" data-view="${id}" ${view === id ? 'aria-current="page"' : ''}>${label}</button>`;
    return `<header class="top">
      <nav class="tabs" aria-label="Sections">${tab('today', 'Today')}${tab('month', 'Month')}${tab('progress', 'Progress')}</nav>
      <button class="icon-btn" data-action="new" aria-label="New habit">+</button>
    </header>`;
  }

  function levelBar(l) {
    const pct = Math.round((l.into / l.needed) * 100);
    const label = `Level ${l.level}, ${l.title}. ${l.into} of ${l.needed} XP to level ${l.level + 1}. Open progress`;
    return `<button class="level" data-action="view" data-view="progress" aria-label="${label}">
      <div class="level-row" aria-hidden="true"><span>Level ${l.level} · ${l.title}</span><span>${l.into} / ${l.needed} XP</span></div>
      <div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
    </button>`;
  }

  function todayView(g, t) {
    const now = new Date();
    const date = now.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    const day = now.toLocaleDateString(undefined, { weekday: 'long' });
    const head = `<div class="date">${esc(date)}</div><h1>${esc(day)}</h1>`;
    const habits = active();

    if (!habits.length) {
      return `${head}<div class="empty">
        <p>Start with one habit. Make it so small you can’t say no.</p>
        <button class="btn" data-action="new">New habit</button>
      </div>`;
    }

    const due = habits.filter((h) => E.isScheduled(h, t));
    const rest = habits.filter((h) => !E.isScheduled(h, t));
    const allDone = due.length && due.every((h) => doneToday(h, g.perHabit[h.id], t));

    let html = head + levelBar(g.level);
    html += `<div class="list">${due.map((h) => row(h, g.perHabit[h.id], t)).join('')}</div>`;
    if (allDone) html += `<p class="all-done">That’s everything. See you tomorrow.</p>`;
    if (rest.length) {
      html += `<h2 class="section-label">Rest day</h2>
        <div class="list">${rest.map((h) => row(h, g.perHabit[h.id], t, true)).join('')}</div>`;
    }
    return html;
  }

  function checkLabel(name, v) {
    if (v === 'full') return `${name}: done. Tap to undo`;
    if (v === 'tiny') return `${name}: tiny version done. Tap to mark fully done`;
    return `Mark ${name} done`;
  }

  function row(h, r, t, resting) {
    const v = logOf(h.id)[t] || '';
    let sub = '';
    let weekMet = false;
    if (h.schedule.type === 'weekly' && r.current) {
      weekMet = r.current.met;
      sub = `${r.current.count} of ${r.current.target} this week${weekMet ? ' · done' : ''}`;
    }

    let line;
    if (!resting && !v && !weekMet && h.tiny) {
      line = `<button class="tiny-btn" data-action="tiny" data-id="${h.id}">${sub ? esc(sub) + ' · ' : ''}or just: ${esc(h.tiny)}</button>`;
    } else {
      const tinyText = sub ? `${sub} · tiny version today` : 'Tiny version done';
      const text = v === 'tiny' ? tinyText : sub || h.cue || scheduleText(h.schedule);
      line = `<div class="habit-sub">${esc(text)}</div>`;
    }

    const unit = r.unit === 'week' ? (r.streak === 1 ? 'week' : 'weeks') : (r.streak === 1 ? 'day' : 'days');
    const check = resting ? '' :
      `<button class="check" data-action="check" data-id="${h.id}" data-v="${v}" aria-label="${esc(checkLabel(h.name, v))}">${TICK}</button>`;

    return `<div class="habit${resting ? ' rest' : ''}">
      ${check}
      <div class="habit-body">
        <button class="habit-name" data-action="detail" data-id="${h.id}">${esc(h.name)}</button>
        ${line}
      </div>
      <button class="streak" data-action="detail" data-id="${h.id}" aria-label="Streak ${r.streak} ${unit}, ${r.shields} shields">
        <b>${r.streak}</b><small>${unit}</small>
        <span class="shields">${'<i></i>'.repeat(r.shields)}</span>
      </button>
    </div>`;
  }

  function monthView(t) {
    const habits = active();
    if (!habits.length) {
      return `<div class="empty"><p>Your month fills in as you check in.</p>
        <button class="btn" data-action="new">New habit</button></div>`;
    }

    const m = E.month(state, monthKey, t);
    const first = state.habits.reduce((min, h) => (h.createdAt < min ? h.createdAt : min), t).slice(0, 7);
    const current = t.slice(0, 7);
    const date = new Date(`${monthKey}-01T12:00:00`);
    const name = date.toLocaleDateString(undefined, { month: 'long' });
    const year = date.getFullYear();
    const n = m.days.length;
    const checkins = m.rows.reduce((sum, r) => sum + r.done, 0);

    const labels = m.days.map((d, i) => {
      const day = i + 1;
      const isToday = d === t;
      const nearToday = d !== t && Math.abs(E.diffDays(d, t)) <= 1;
      const show = isToday || ((day === 1 || day % 7 === 1) && !nearToday);
      return `<span class="${isToday ? 'is-today' : ''}">${show ? day : ''}</span>`;
    }).join('');

    const rows = m.rows.map((r) => `
      <button class="mrow" data-action="detail" data-id="${r.id}"
        aria-label="${esc(r.name)}: ${r.pct === null ? 'nothing due yet' : r.done > r.possible ? `${plural(r.done, 'check-in')}, ${r.pct} percent` : `${r.done} of ${r.possible}, ${r.pct} percent`}. ${tally(r.cells)}. Open habit">
        <span class="mrow-head" aria-hidden="true">
          <span class="mrow-name">${esc(r.name)}</span>
          <span class="mrow-score">${r.pct === null ? '–' : r.done > r.possible ? `${plural(r.done, 'check-in')} · ${r.pct}%` : `${r.done} of ${r.possible} · ${r.pct}%`}</span>
        </span>
        <span class="mcells" aria-hidden="true">${r.cells.map((c, i) =>
          `<i class="${c}${m.days[i] === t ? ' today' : ''}"></i>`).join('')}</span>
      </button>`).join('');

    const bars = m.daily.map((d) => {
      if (!d.due || d.key > t) return '<i></i>';
      const pct = Math.round((d.done / d.due) * 100);
      return `<i class="due" title="${d.done} of ${d.due}"><b style="height:${pct}%"></b></i>`;
    }).join('');

    return `
      <div class="date">${year}</div>
      <div class="month-head">
        <h1>${esc(name)}</h1>
        <div class="month-nav">
          <button data-action="month" data-delta="-1" ${monthKey <= first ? 'disabled' : ''} aria-label="Previous month">‹</button>
          <button data-action="month" data-delta="1" ${monthKey >= current ? 'disabled' : ''} aria-label="Next month">›</button>
        </div>
      </div>

      <div class="stats three">
        <div class="stat"><b>${m.pct === null ? '–' : m.pct + '%'}</b><small>Completed</small></div>
        <div class="stat"><b>${m.perfect}</b><small>Perfect days</small></div>
        <div class="stat"><b>${checkins}</b><small>Check-ins</small></div>
      </div>

      <div class="month" style="--n:${n}">
        <div class="mlabels" aria-hidden="true">${labels}</div>
        ${rows}
        <div class="mrow daily" role="img" aria-label="Each day: ${m.perfect} of ${m.daily.filter((d) => d.due && d.key <= t).length} days with every habit done">
          <span class="mrow-head" aria-hidden="true"><span class="mrow-name">Each day</span><span class="mrow-score">Share of habits done</span></span>
          <span class="mbars" aria-hidden="true">${bars}</span>
        </div>
      </div>

      ${legend(true)}`;
  }

  function progressView(g) {
    const l = g.level;
    const s = g.stats;
    const earned = g.badges.filter((b) => b.earned).length;
    const archived = state.habits.filter((h) => h.archived);

    return `
      <h1 class="sr-only">Progress</h1>
      <div class="big-level" aria-label="Level ${l.level}, ${l.title}"><b>${l.level}</b><span>${l.title}</span></div>
      <div class="level-row" style="margin-top:14px"><span>${l.xp} XP total</span><span>${l.needed - l.into} to level ${l.level + 1}</span></div>
      ${progressBar(Math.round((l.into / l.needed) * 100), `Progress to level ${l.level + 1}`)}

      <div class="stats">
        <div class="stat"><b>${s.checkins}</b><small>Check-ins</small></div>
        <div class="stat"><b>${s.bestDays}</b><small>Best streak</small></div>
        <div class="stat"><b>${s.comebacks}</b><small>Comebacks</small></div>
        <div class="stat"><b>${earned}/${g.badges.length}</b><small>Badges</small></div>
      </div>

      <h2 class="section-label">Badges</h2>
      <div class="badges">${g.badges.map((b) => `
        <div class="badge${b.earned ? ' earned' : ''}">
          <span class="dot"></span>
          <div><div class="badge-name">${esc(b.name)}</div><div class="badge-desc">${esc(b.desc)}</div></div>
        </div>`).join('')}
      </div>

      <h2 class="section-label">How it works</h2>
      <div class="rules">
        <p><b>The tiny version counts.</b> <span>On a bad day, do the two-minute version. Your streak stays alive.</span></p>
        <p><b>Shields.</b> <span>Every 7-day streak (4 weeks for weekly habits) earns a shield, up to 3. A shield absorbs one missed day automatically.</span></p>
        <p><b>Strength.</b> <span>A slow-moving score from 0 to 100. A missed day nudges it down, it never falls off a cliff.</span></p>
        <p><b>Come back.</b> <span>Your first check-in after a broken streak earns a bonus. Missing once is human. Just don’t miss twice.</span></p>
        <p><b>Surprises.</b> <span>Some check-ins drop bonus XP. You won’t know which.</span></p>
      </div>

      ${archived.length ? `<h2 class="section-label">Archived</h2>
        <div>${archived.map((h) => `<button class="row-btn" data-action="restore" data-id="${h.id}">${esc(h.name)}<span>Restore</span></button>`).join('')}</div>` : ''}

      <h2 class="section-label">Data</h2>
      <div>
        <button class="row-btn" data-action="export">Export backup<span>JSON</span></button>
        <button class="row-btn" data-action="import">Restore from backup<span>Replaces data</span></button>
      </div>
      <p class="hint" style="margin-top:12px">Everything is stored on this device only.</p>`;
  }

  // ---------- rendering: sheets ----------

  function renderSheet() {
    if (!sheet) { sheetEl.hidden = true; sheetEl.innerHTML = ''; return; }
    const keep = focusKey();
    sheetEl.hidden = false;
    sheetEl.innerHTML = `<div class="sheet-inner">${sheet.type === 'form' ? formView() : detailView()}</div>`;
    refocus(sheetEl, keep);
  }

  function formView() {
    const d = sheet.draft;
    const editing = !!sheet.id;
    const tooMany = !editing && active().length >= SOFT_LIMIT;
    const seg = (type, label) =>
      `<button data-action="type" data-type="${type}" aria-pressed="${d.type === type}">${label}</button>`;

    let schedule = '';
    if (d.type === 'days') {
      schedule = `<div class="days">${DAY_LETTERS.map((l, i) =>
        `<button class="day" data-action="day" data-day="${i}" aria-pressed="${d.days.includes(i)}" aria-label="${DAY_NAMES[i]}">${l}</button>`).join('')}</div>`;
    } else if (d.type === 'weekly') {
      schedule = `<div class="stepper">
        <button data-action="times" data-delta="-1" ${d.times <= 1 ? 'disabled' : ''} aria-label="Fewer">−</button>
        <output aria-live="polite">${plural(d.times, 'time')} a week</output>
        <button data-action="times" data-delta="1" ${d.times >= 6 ? 'disabled' : ''} aria-label="More">+</button>
      </div>`;
    }

    return `
      <h2 class="sr-only" id="sheet-title" tabindex="-1">${editing ? 'Edit habit' : 'New habit'}</h2>
      <div class="sheet-top">
        <button data-action="close">Cancel</button>
        <button class="done" data-action="save" ${draftValid(d) ? '' : 'disabled'}>${editing ? 'Save' : 'Add'}</button>
      </div>
      <div class="field"><label for="f-name">Habit</label>
        <input type="text" id="f-name" data-field="name" value="${esc(d.name)}" placeholder="Read" maxlength="60" autocomplete="off"></div>
      <div class="field"><label for="f-tiny">Tiny version</label>
        <input type="text" id="f-tiny" data-field="tiny" value="${esc(d.tiny)}" placeholder="Read one page" maxlength="60" autocomplete="off" aria-describedby="h-tiny">
        <p class="hint" id="h-tiny">What you can still do on your worst day. It keeps the streak alive.</p></div>
      <div class="field"><label for="f-cue">When</label>
        <input type="text" id="f-cue" data-field="cue" value="${esc(d.cue)}" placeholder="After I pour my coffee" maxlength="80" autocomplete="off" aria-describedby="h-cue">
        <p class="hint" id="h-cue">Attach it to something you already do.</p></div>
      <div class="field" role="group" aria-labelledby="g-often"><span id="g-often">How often</span>
        <div class="seg">${seg('daily', 'Daily')}${seg('days', 'Some days')}${seg('weekly', 'Weekly')}</div>
        ${schedule}
      </div>
      ${tooMany ? `<p class="warn">You already have ${active().length} habits. New habits stick best one or two at a time. Consider adding this once the others feel automatic.</p>` : ''}`;
  }

  function journeyBlock(j) {
    const text = j.goal
      ? `<b>${j.count}</b> of ${j.goal} check-ins <span>${JOURNEY_TEXT[j.goal].to}</span>`
      : `<b>${j.count}</b> check-ins <span>more than a year of practice</span>`;
    const left = j.goal ? `${j.goal - j.count} to go` : 'Complete';
    return `<h2 class="section-label">Journey</h2>
      <div class="journey">
        <div class="journey-row"><span class="journey-text">${text}</span><span class="journey-left">${left}</span></div>
        ${progressBar(j.pct, j.goal ? `Journey to ${j.goal} check-ins` : 'Journey')}
        <div class="journey-steps" aria-hidden="true">${E.JOURNEY.map((g) =>
          `<span class="${j.count >= g ? 'reached' : ''}">${g}</span>`).join('')}</div>
      </div>`;
  }

  function detailView() {
    const h = habit(sheet.id);
    if (!h) return '';
    const t = today();
    const r = E.simulate(h, state.logs[h.id], t);
    const log = logOf(h.id);
    const unit = r.unit === 'week' ? 'Weeks' : 'Days';

    // Last 7 days, editable (for when you forgot to log).
    let week = '';
    for (let i = 6; i >= 0; i--) {
      const d = E.addDays(t, -i);
      const ok = d >= h.createdAt && E.isScheduled(h, d);
      const v = ok ? log[d] || '' : '';
      const status = !ok ? 'not scheduled' : v === 'full' ? 'done' : v === 'tiny' ? 'tiny version' : 'not done';
      week += `<div class="col${i === 0 ? ' today' : ''}">
        <button class="check" data-action="edit-day" data-id="${h.id}" data-key="${d}" data-v="${v}" ${ok ? '' : 'disabled'} aria-label="${esc(longDate(d))}: ${status}">${TICK}</button>
        <small aria-hidden="true">${DAY_LETTERS[E.weekday(d)]}</small>
      </div>`;
    }

    // Up to a year of history, starting from the week the habit was created.
    // Columns stay at least 20 wide so a new habit's grid isn't stretched.
    const start = [E.addDays(E.weekStart(t), -7 * (HISTORY_WEEKS - 1)), E.weekStart(h.createdAt)].sort()[1];
    const weeks = E.diffDays(start, E.weekStart(t)) / 7 + 1;
    const since = new Date(`${start}T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    let heat = '';
    const cells = [];
    for (let d = start; d <= E.addDays(E.weekStart(t), 6); d = E.addDays(d, 1)) {
      const daily = E.scheduleAt(h, d).type !== 'weekly';
      let cls = '';
      if (d > t || d < h.createdAt || !E.isScheduled(h, d)) cls = 'off';
      else if (log[d]) cls = log[d];
      else if (daily && r.statuses[d] === 'shielded') cls = 'shielded';
      else if (daily && d < t) cls = 'missed';
      cells.push(cls);
      heat += `<i class="${cls}"></i>`;
    }

    return `
      <div class="sheet-top">
        <button data-action="close" aria-label="Back">‹ Back</button>
        <button data-action="edit" data-id="${h.id}">Edit</button>
      </div>
      <h1 class="detail-name" id="sheet-title" tabindex="-1">${esc(h.name)}</h1>
      <div class="detail-cue">${esc([h.cue, scheduleText(h.schedule)].filter(Boolean).join(' · '))}</div>
      ${h.tiny ? `<div class="detail-cue">Tiny version: ${esc(h.tiny)}</div>` : ''}

      <div class="stats">
        <div class="stat"><b>${r.strength}</b><small>Strength</small></div>
        <div class="stat"><b>${r.streak}</b><small>${unit}</small></div>
        <div class="stat"><b>${r.best}</b><small>Best</small></div>
        <div class="stat"><b>${r.shields}</b><small>Shields</small></div>
      </div>

      ${journeyBlock(E.journey(r.fullCount + r.tinyCount))}

      <h2 class="section-label">Last 7 days</h2>
      <div class="week-edit">${week}</div>
      <p class="hint">Tap to cycle: done, tiny, not done.</p>

      <h2 class="section-label">${weeks >= HISTORY_WEEKS ? 'Past year' : `Since ${esc(since)}`}</h2>
      <div class="heat" style="--cols:${Math.max(20, weeks)}" role="img" aria-label="History: ${tally(cells)}">${heat}</div>
      ${legend(true)}

      <div class="detail-actions">
        <button class="link" data-action="archive" data-id="${h.id}">Archive</button>
        <button class="link danger" data-action="delete" data-id="${h.id}">Delete</button>
      </div>`;
  }

  // ---------- events ----------

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const id = el.dataset.id;
    const t = today();

    switch (el.dataset.action) {
      case 'view':
        view = el.dataset.view;
        render();
        window.scrollTo(0, 0);
        break;
      case 'month':
        monthKey = E.shiftMonth(monthKey, Number(el.dataset.delta));
        render();
        break;
      case 'new':
        openSheet({ type: 'form', draft: newDraft(), id: null });
        break;
      case 'check': {
        const v = logOf(id)[t];
        setLog(id, t, v === 'full' ? null : 'full'); // tiny upgrades to full
        break;
      }
      case 'tiny':
        setLog(id, t, 'tiny');
        break;
      case 'detail':
        openSheet({ type: 'detail', id });
        break;
      case 'edit-day':
        setLog(id, el.dataset.key, cycle(logOf(id)[el.dataset.key]));
        renderSheet();
        break;
      case 'edit':
        openSheet({ type: 'form', draft: newDraft(habit(id)), id });
        break;
      case 'archive':
        habit(id).archived = true;
        save();
        closeSheet();
        toast('Archived. Restore it from Progress.');
        break;
      case 'delete':
        if (!confirm(`Delete “${habit(id).name}” and its entire history?`)) return;
        state.habits = state.habits.filter((h) => h.id !== id);
        delete state.logs[id];
        save();
        closeSheet();
        break;
      case 'restore':
        habit(id).archived = false;
        save();
        render();
        break;
      case 'close':
        if (sheet && sheet.type === 'form' && sheet.id && habit(sheet.id)) openSheet({ type: 'detail', id: sheet.id });
        else closeSheet();
        break;
      case 'save':
        saveDraft();
        break;
      case 'type':
        sheet.draft.type = el.dataset.type;
        renderSheet();
        break;
      case 'day': {
        const d = Number(el.dataset.day);
        const days = sheet.draft.days;
        sheet.draft.days = days.includes(d) ? days.filter((x) => x !== d) : days.concat(d);
        renderSheet();
        break;
      }
      case 'times':
        sheet.draft.times = Math.min(6, Math.max(1, sheet.draft.times + Number(el.dataset.delta)));
        renderSheet();
        break;
      case 'export':
        exportData();
        break;
      case 'import':
        importData();
        break;
    }
  });

  sheetEl.addEventListener('input', (ev) => {
    const f = ev.target.dataset.field;
    if (!f || !sheet || sheet.type !== 'form') return;
    sheet.draft[f] = ev.target.value;
    const btn = sheetEl.querySelector('[data-action="save"]');
    if (btn) btn.disabled = !draftValid(sheet.draft);
  });

  sheetEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.dataset.field) {
      ev.preventDefault();
      saveDraft();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && sheet) closeSheet();
  });

  // Roll over to a new day when the app is reopened or left open past midnight.
  function checkDay() {
    const t = today();
    if (t !== lastToday) {
      lastToday = t;
      render();
      if (sheet && sheet.type === 'detail') renderSheet();
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDay(); });
  setInterval(checkDay, 60000);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  render();
})();
