# Trono Scheduler

Design spec for the priority-queue scheduler that replaces the flat tick loop in
`scripts/trono/runner.js`.

Current loop: read state, try daily login claim, production claim, activity, fight,
sleep 90s. Every priority runs on every tick regardless of whether it is eligible, and
nothing persists between ticks. This document defines the loop that should replace it.

## Sources

| Fact | Source |
|---|---|
| Economy, vitals, regeneration | `GET /api/player_state.php` |
| Daily login reward state | `GET /api/daily_rewards.php` |
| Production state | `GET /api/daily_production.php` |
| Combat cost, gold, EXP | `scripts/trono/logs/runner.out` (measured wins) |
| Claim POST shape | `/assets/js/daily-rewards.js?v=5` (site client) |

## Transport invariants

- CDP port **9777**. 9222 is only the MCP default and is closed on this machine.
- One driver per tab. Exactly one process may drive the CloakBrowser tab; the guard is
  `scripts/trono/logs/driver.lock` (records `pid`, `name`, `at`). A lock whose pid is
  not alive is ignored, so a crashed runner never blocks the next start.
- All mutations are in-page `fetch()` from the authenticated tab. `apiPost` requires an
  explicit `csrf` option and refuses to run unless the runner was started with `--live`.
- Page fetches need the `X-Game-View: 1` header; without it a valid session still
  receives the public landing page.
- `GET /api/player_state.php` is the only endpoint that exposes `regeneration`.

## Priority queue

Each priority runs only when its precondition holds. A higher priority that is eligible
runs first and its result is allowed to change lower priorities' inputs.

### P0 - Session integrity

- **Precondition**: `GET /api/player_state.php` is not 200, or `isLoggedIn()` is false.
- **Action**: reconnect CDP, then autonomous login with bounded retries
  (startup: 5 attempts, 20s x attempt; recovery: 3 attempts, 15s x attempt).
- **Why first**: every other priority writes through the same session. Running them on a
  dead session produces 401s that look like logic bugs.
- **Budget**: none (wall clock only).
- **Failure**: never exit the process on a failed recovery. Increment `recoverFailures`,
  back off 30s x n, re-throw only at 5 consecutive failures.
- **Blocks**: everything. No other priority runs until this returns healthy.

### P1 - Daily login reward

- **Precondition**: `data.available === true`.
- **Action**: `POST /api/daily_rewards.php` with
  `{"action":"claim","request_id":<uuid v4>}` and header `X-CSRF-Token: data.csrf`,
  where `data.csrf` comes from the GET payload of the same endpoint.
- **Why first**: free gold, zero stamina, highest value per unit of cost in the system.
  Day 1 is 500 gold, day 5 is 1000 gold, other days give materials, keys and potions.
- **Reset**: 10:00 server time. Distinct from the 09:00 quest reset.
- **Budget**: none.
- **Failure**: `409 {"ok":false,"message":"Solicitud inválida."}` means the request shape
  was rejected, not that the reward is unavailable. Do not retry in a loop; log the
  status and skip to the next tick. Both request-shape defects found so far were the
  token source and a non-UUID `request_id`.

### P2 - Daily quests

- **Precondition**: unclaimed quest rewards exist for the current period.
- **Action**: claim each available quest reward through its own endpoint.
- **Why second**: 192 gold/day at zero stamina cost, the cheapest gold after P1.
- **Reset**: 09:00 server time.
- **Budget**: none.

### P3 - Production claim

- **Precondition**: `claim_available === true`.
- **Action**: `POST /api/daily_production.php`, `action: claim`.
- **Why third**: 164.5 gold/day, storage capped at 30h. Claiming late loses gold, and
  this is the only priority whose loss is silent.
- **Budget**: none.
- **Failure**: log `remaining_seconds`; if the cap is within 2h, escalate the tick
  interval rather than the claim.

### P4 - Combat farming

- **Precondition**: all of the following hold
  - stamina >= 3
  - current HP > `HP_FLOOR`
  - `current HP - predicted_cost x SAFETY_MULT` stays above `HP_FLOOR`
  - the predictor does not mark the fight as a loss
- **Action**: fight, then read the result and update the rolling HP-cost estimate.
- **Why fourth**: this is where stamina converts to gold, but it is also the only
  priority that can strand the hero. It must never run at the expense of P0-P3.
- **Budget**: 3 stamina per kill, 80 kills/day, 2.0 gold per stamina.
- **Failure**: on a loss or an abandoned fight, run `recover_abandon` and increment the
  failure counter. At `MAX_CONSECUTIVE_FAILURES` (2), stop fighting for this tick and
  re-read state rather than re-entering combat.

### P5 - Activity counters

- **Precondition**: activity is below its cap (`0/100` observed).
- **Action**: register activity.
- **Why fifth**: cheap and non-economic, but it can rotate the session instance, so it
  must never run while a fight is `active`.
- **Budget**: none.

### P6 - Slow progression

- **Precondition**: attribute points, skill points or talent points are available.
- **Action**: spend only through an explicit, reviewed rule set.
- **Gate**: any spend with economic risk requires human approval. The scheduler may
  report that points are pending; it may not decide how to spend them unattended.
- **Budget**: none in gold.

### P7 - Economy, market and withdrawal

- **Status**: fully gated. Not automated.
- The bot never spends gold, gems, diamonds or DOTIRIA, and never lists, buys or
  transfers anything without explicit human authorisation.
- Withdrawal is an **off-chain payout**: minimum 10 USDT = 100,000 gold, lifetime quota
  15 USDT. Exactly one withdrawal is reachable; the residual 5 USDT cannot be withdrawn.
- There is no on-chain transaction to sign for this withdrawal. Any automation that
  claims otherwise is wrong.

## The invariant that silently breaks everything

Regeneration is **0 while any fight has `status: "active"`**.

- Signal: `vitals.regeneration.hp === 0` while vitals are below max.
- Recovery: `recover_abandon`.
- Why it matters: a stuck active fight turns a 9.52 HP/min hospital heal into zero.
  The economy then looks broken (fights refused, HP flat) while the real cause is a
  single orphaned fight record.

## Constants

| Constant | Value | Meaning |
|---|---|---|
| `HP_COST_MEAN` | 52 | **cold-start prior only.** At runtime the per-target cost is the measured moving average in `state/learning.json` (`lib/learning.js`, α 0.35) and it overrides the simulated estimate. Measured at level 5: 15-54 HP per kill, so a flat 52 is wrong by up to 3x in both directions and must never be the only input |
| `HP_BUFFER` | 12% of `maxHp` | HP held in reserve; a fight starts only when `hpCost + buffer <= hp` (`runner.js:332`). At `maxHp` 636 that is 76 HP |
| `SAFETY_MULT` | 1.30 | multiplier on predicted HP cost before accepting a fight |
| ~~`HP_FLOOR`~~ ~~`REST_TARGET`~~ | not implemented | The spec's absolute floor (136) and rest target (476) were replaced by the relative `HP_BUFFER`. Neither exists in `runner.js`; do not use them as thresholds, and do not cite them as current behaviour |
| `MAX_TICK_INTERVAL` | 6.5 h (390 min) | maximum gap between ticks while stamina exists |
| `MAX_CONSECUTIVE_FAILURES` | 2 | consecutive fight failures before leaving combat |
| `STAMINA_PER_KILL` | 3 | stamina cost per fight |
| `STAMINA_REGEN` | 10 / h | continuous, independent of combat |
| `HP_REGEN_PASSIVE` | 1.5% / min = 7.14 HP/min | outside the hospital |
| `HP_REGEN_RESTING` | 2% / min = 9.52 HP/min | inside the hospital |
| `KILLS_PER_DAY` | 80 | 240 stamina/day divided by 3 |
| `MAX_HP_COST_PER_KILL` | `maxHp * 0.015 * 1440 / 80` | HP/day the hero regenerates divided by kills/day. At `maxHp` 636 this is 171.7; above that per-kill cost, HP binds before stamina and the target's real yield is capped by HP, not by stamina |

Derivations:

- `HP_FLOOR` = 476 x 0.286 is set so the worst measured fight (65 HP) plus predictor
  overshoot cannot take the hero near zero.
- `MAX_TICK_INTERVAL` follows from the 30h production cap: 6.5h leaves a wide margin so
  production never overflows between ticks.
- `MAX_HP_COST_PER_KILL` = 10,281.6 HP regenerated per day / 80 kills. At 52 HP/kill the
  hero consumes 4,160 HP/day against 10,281.6 regenerated, so HP is not the daily
  bottleneck today. Re-measure after every level-up and alarm at the threshold.

## State file

`state/scheduler.json`, rewritten atomically after each tick. Keep it small:

```json
{
  "last_tick_at": "2026-11-11T19:47:33.725Z",
  "priorities": {
    "P1": { "last_success_at": "2026-11-11T19:47:02Z", "period_key": "2026-11-11" },
    "P3": { "last_success_at": "2026-11-11T12:10:00Z", "claim_available": false },
    "P4": { "last_success_at": "2026-11-11T19:47:33Z", "consecutive_failures": 0 }
  },
  "backoff_until": null
}
```

Rules:

- Write after the tick, not before, so a crash never records work that did not happen.
- `last_success_at` is the only thing that decides whether a free daily claim is due; do
  not infer it from gold deltas.

## Acceptance criteria

Falsifiable, one run each:

1. 24h unattended: zero manual logins, and `logs/runner.err` contains no unhandled
   exception.
2. Daily login reward claimed exactly once per `period_key`; `total_claims` increments by
   exactly 1 per day.
3. Production is never observed at its 30h cap.
4. No fight starts with HP at or below `HP_FLOOR`.
5. No fight starts when the predictor marks a loss.
6. `vitals.regeneration.hp` is never 0 for more than one consecutive tick while vitals
   are below max (orphaned fight would violate this).
7. Kills per day never exceed 80, and stamina never goes negative.
8. Every mutating request carries a CSRF token taken from the endpoint it targets.
9. A forced session death during a tick recovers without human action, within 5 attempts.
10. Killing the runner mid-tick leaves no lock that blocks the next start.

## Known unknowns

- **Does regeneration accrue while the browser is closed?** Unresolved. If it does not,
  HP becomes the binding constraint whenever online time is below roughly 9.7 h/day, and
  the per-target HP cost accumulated in `state/learning.json` stops being comparable across
  sessions. Measure by comparing `vitals.current.hp` at shutdown and at next start against
  the elapsed wall clock.
- Whether the daily login reward's `request_id` is idempotency-checked server-side, or
  only format-validated. Treat every claim as non-retryable until measured.
