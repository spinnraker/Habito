# Habito

A habit tracker with game mechanics built to keep you going, not to punish you. Black and white, one screen, no account, works offline.

## Use it

```sh
npm start          # http://localhost:8080
npm test           # engine tests
```

No dependencies and no build step. To put it on your iPhone, host the folder on any static host (GitHub Pages works: Settings → Pages → deploy from this branch), open it in Safari, then Share → Add to Home Screen. It runs full-screen and offline. Data stays on the device; use Progress → Export backup to keep a copy.

## Why the game is built this way

Most streak apps fail the same way: one missed day wipes out weeks of progress, and people quit. Each rule here addresses a specific reason habits don't stick.

| Rule | Why |
|---|---|
| **The tiny version counts.** Every habit has a two-minute version. Doing it keeps the streak alive (4 XP instead of 10). | The hardest part is starting. Small versions keep you in motion on bad days. |
| **Shields.** Every 7-day streak (4 weeks for weekly habits) earns a shield, up to 3. A shield absorbs a missed day automatically. | One missed day shouldn't erase a month. Shields are earned, so they reward consistency. |
| **Strength (0–100).** A slow-moving average: a miss nudges it down, it never drops to zero. | A more honest picture of progress than a fragile streak. |
| **Comeback bonus.** Your first check-in after a broken streak earns +15 XP. | The danger is missing twice, not once. Coming back is rewarded instead of shamed. |
| **Surprise drops.** About 1 in 8 check-ins drops 5–25 bonus XP. | Unpredictable rewards hold attention longer than fixed ones. |
| **Cue.** "After I pour my coffee…" | Tying a new habit to an existing routine makes it far more likely to happen. |
| **Soft limit of 3.** Adding a fourth habit shows a gentle warning. | Starting too many at once is the most common way to fail. |
| **66-day badge.** | 66 days is the median time for a habit to become automatic (Lally et al., 2010). |

Milestones at 7, 21, 30, 66, 100 and 365 days pay XP. Levels need progressively more XP.

## How it works

- `engine.js` is pure logic. XP, streaks, shields, strength and badges are recomputed from the check-in log every time; nothing is stored. Un-checking a day can't corrupt state, and re-checking can't farm rewards: bonus drops come from a hash of habit and date, so they're fixed.
- `app.js` handles the UI and saves to `localStorage` (`habito:v1`).
- `sw.js` caches the app for offline use. Bump `CACHE` when you ship changes.
