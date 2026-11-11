# Defiende el Trono — automation state (single source of truth)

Last updated: 2026-11-11. Workspace: `C:\Users\Dioneldis\Documents\Default Project`.

## Account & browser binding
- Site: https://defiendeeltrono.com — PHP MMO, Spanish UI, server-rendered pages.
- User **darksider95** (user_id 1068, character/kingdom 1060), hero `inferno`.
- CloakBrowser stealth Chromium, profile `C:\Users\Dioneldis\.cloakbrowser\profiles\trono`,
  CDP port **9777**, fingerprint seed **58317**.
- Launcher: `C:\Users\Dioneldis\.cloakbrowser\launch-trono.ps1` (idempotent).
- Credentials: `C:\Users\Dioneldis\.trono\credentials.json` (ACL restricted; never in code/logs).
  Env alternative: `TRONO_USER` / `TRONO_PASS`.

## Hard-won facts (verified live)
1. **Session dies after 180 s** of no *trusted* input. `assets/js/session-idle.js` gates on
   `event.isTrusted`, so synthetic clicks never renew it. Renewal = `POST /api/session_activity.php`
   form-urlencoded `action=activity&csrf=<config.csrf>&idle_ms=<ms>`. Config lives in
   `<script type="application/json" id="sessionIdleConfig">`.
2. **Every page fetch needs header `X-Game-View: 1`.** Without it the server returns the public
   landing page (10,903 bytes) even with a valid session. With it: 65–130 KB of real game HTML.
3. Cookies: `DTTSESS` (session-only) + `DEF_REMEMBER` (30 days, HttpOnly/Secure/Lax).
   Remember alone does NOT restore the session → autonomous login is required.
4. Login = `POST /` urlencoded `csrf, username, password, remember=1`; guest CSRF is in
   `input[name=csrf]` on the landing page. Verified end-to-end after wiping both cookies.
5. Transports: `GET /api/*.php` → `{ok:true,...}`; `POST /api/*.php` → JSON + header `X-CSRF-Token`
   (64 hex from `data-csrf`); legacy `/actions/*.php` and some pages = urlencoded form + 16-hex `csrf`.
6. CSRF is per page load — always re-extract before acting.
7. URL bar collapses to `/` (game-navigation.js) — never infer page from `location.pathname`.

## Economy (live numbers)
| Operation | Rate | Fee |
|---|---|---|
| ORO → DIAMANTES | 2,000 = 19 | 5% |
| ORO → DOTIRIA | **10,000 = 1** | — |
| DOTIRIA → USD balance | 10 → 9.50 USD (950 gems) | 5% |
| DOTIRIA → USDT withdrawal | 1:1, min 10, BSC/BEP20 or ETH/ERC20 | processor |

- Withdrawal policy (`data-config` on `/pages/economy.php`): `limit_cents:1500` = **$15 total quota**,
  `bonus_percent:30` on deposits, first withdrawal free (10–15 USDT, one time only).
- ⇒ Minimum real withdrawal = **10 USDT = 100,000 gold**. Account starts at 500 gold.
- Current income at lvl 1: activity milestones 15 gold × 5/day = 75; campaign ch.1 = 200 gold;
  daily login 500 (day 1); kingdom production 0/day. Dungeons need NV 20.
- **Profit is a function of leveling speed**, not farm repetition.

## Combat / progression
- Entry: `GET /pages/combat_pve.php?location_id=<id>&world_enemy_id=<id>`
  (plus `practice_hp|practice_damage|practice_armor` for the practice dummy).
- **Combat API (verified live, JSON + `X-CSRF-Token` = 64-hex `data-csrf` on `<main data-combat-pve>`):**
  - `POST /api/combat_pve.php {operation:'create_from_world', location_id, world_enemy_id, practice_hp, practice_damage, practice_armor, request_id, csrf}`
  - `POST {operation:'attack', combat_id, request_id, csrf}`
  - `POST {operation:'skill', skill_key, repeat_count, combat_id, request_id, csrf}`  (operation = the action key, not a special verb)
  - `POST {operation:'recover_abandon', combat_id, csrf}`
  - `GET /api/combat_state.php?combat_id=..`, `GET /api/combat_log.php?combat_id=..`
- **Damage model (measured):** basic = `attack_damage - enemy_def`; skill = `round(attack_damage * power) - enemy_def`;
  burn tick = `round(0.26 * round(attack_damage * power))` for 3 turns; taken = `enemy_dmg - our_armor`
  (x2 at level gap >= 5). Each exchange = 1 player action + 1 enemy action.
- **Practice dummy** (`location_id=62`, `world_enemy_id=133`): HP/damage/armor fully configurable,
  **0 stamina, 0 reward, and HP is NOT restored on finish** (tested: abandon and defeat both leave real HP lost).
  Use it only to calibrate damage numbers with `practice_damage=0`.
- Region 1 cards (lv, hp, dmg, def, stamina, gold, exp):
  virex 2/160/20/4/3/6/160 · aeril 3/255/26/6/3/9/190 · brumak 4/332/33/8/3/12/220 · lyss 5/491/39/10/4/15/250 ·
  morvak 6/625/46/12/4/18/280 · eryndor 7/774/52/14/4/21/310 · nymira 8/952/59/16/5/24/340 · sylthar 10/1637/110/20/5/30/625
- **HP is the scarce resource.** Regeneration (verified live with `player_state`):
  - passive **1.5% of max HP/mana per minute** (391 max → 5.865/min, measured 5.8–5.9)
  - resting at the hospital (NV 1) **2%/min total** (391 max → 7.82/min, measured 8.7/min over a 1.6 min window)
  - stamina 10/h passive + 0.2/h per Santuario level
- **REGENERATION IS ZERO WHILE ANY COMBAT IS ACTIVE.** `player_state` returns
  `vitals.regeneration.hp = 0` and `regeneration_details.hp.passive_label = "0%/min"` (same for mana)
  while a combat row sits in `status: "active"` — even an abandoned-looking one. Measured: combat
  45772 stuck active froze HP at 82 and mana at 259 for >10 min; one `recover_abandon` flipped
  `regeneration.hp` to 4.74 (1.5%/min) in the same second. This is THE trap: any dropped fetch
  mid-fight leaves a combat open and silently freezes the hero forever.
  - `player_state` is the only vitals source: `/api/hero_equipment.php` has **no** `regeneration` field.
  - Guards now in place: `fight()` abandons any combat it did not leave `finished`, and
    `runner.js` runs `ensureOutOfCombat()` every tick (regen 0 while below max → abandon + log).
  - The "resting re-POST resets the timer" theory was WRONG; the freeze was the orphan combat.
  A lost fight burns the whole pool. Never start a predicted loss — `lib/combat.js` gate.
- Best farm at lv1 + boots: **Virex, 160 EXP for ~66 HP** (2.42 EXP/HP) vs Aeril 190 EXP for ~170 HP (1.12).
- **Daily quests** (top income, no HP cost): `?view=ofertas` → cards are `<template data-mission-selection="<id>">`;
  accept = form POST `quest_action=accept_offer&instance_id=<id>&csrf=<16-hex>` to the offers URL.
  Progress counts only **after** accepting. Activity bar: each claimed daily = 20 points,
  milestones 20/40/60/80/100 → 15/15/20/20/30 gold + 25 EXP. Reset 09:00.
- Specialization: 3 points/level, max 100. FUERZA +2 atk/+2 dmg; VITALIDAD +10 HP/+1 def (class affinity);
  INTELIGENCIA +4 mana; PERCEPCION +0.4% acc; AGILIDAD +0.3% crit; RESISTENCIA +1 magic def.
  API: `POST /api/hero_attributes.php {attribute:"vitality"}` (one point per call).
  **Done: 3 → vitality** (`derived.hp +30`, `arm +3`; armor 3→6).
- Skills: `POST /api/hero_skill_upgrade.php {skill_key}` (1 point each).
  **Done: wildfire_bolt NV.1** (125% power, 7 mana, CD 2, burn 26% x3). It is the difference between
  losing to Aeril (no skill: 316 HP lost, defeat) and winning (~170 HP, victory).
- Campaign quest 1 "El Bosque de Sylvenor" requires NV 10+ (level 10, 20 kills, Sylthar).

## Scripts (all raw CDP, no Playwright)
| File | Purpose |
|---|---|
| `scripts/trono/lib/game.js` | `Game.connect/fetchPage/csrfFor/apiGet/apiPost/postForm/state/idleConfig/heartbeat/login/clearSession/evalInPage`. Mutations blocked unless `{allowMutate:true}`. |
| `scripts/trono/lib/combat.js` | `readHero/rankTargets/simulateFight/fight/calibrate/abandonCombat/combatCsrf` — damage model, HP-cost predictor, combat loop, guaranteed cleanup of unfinished combats |
| `scripts/trono/lib/driverlock.js` | single-driver lock (`logs/driver.lock`) — two drivers kill the session |
| `scripts/trono/lib/dailies.js` | `offers/active/ready/accept/acceptAll/claimAll` — daily quest board |
| `scripts/trono/plan.js` | read-only planner: hero stats + target ranking (WIN/LOSE, hpCost, exp/hp, exp/sta) |
| `scripts/trono/runner.js` | autonomous loop: heartbeat → free claims → dailies → points → best fight → rest. `--dry`, `--live`, `--loop=<s>`, `--fights=<n>` |
| `scripts/trono/dailies.js` | daily board inspector (`--json`, `--text`) |
| `scripts/trono/lib/credentials.js` | load/save credentials outside the repo |
| `scripts/trono/state.js` | live snapshot (hero, vitals, points, dailies, production) |
| `scripts/trono/keepalive.js` | heartbeat every ~40 s; exit 3 on 401/403 |
| `scripts/trono/login.js` | login only if dead; `--force`, `--wipe` |
| `scripts/trono/harvest.js` / `assets.js` / `peek.js` / `page-text.js` | harvesting + inspection helpers |

Run list:
```
node scripts/trono/keepalive.js --every=40
node scripts/trono/runner.js --live --loop=90     # lives in logs/runner.out
node scripts/trono/plan.js                        # why the bot picks a target
```

## Current state / next step
Runner v2 is live and plays: accepts the combat dailies, then farms **Virex** (best EXP/HP),
resting at the hospital whenever HP is below the predicted cost + 12% buffer.
**Verified working 2026-11-11 14:38:** hero hit **level 2** (371→391 HP), 3 attribute points and
1 skill point and 2 talent points were spent automatically, and the upgrade cut the Virex cost from
71 HP / 6 rounds to 39–65 HP / 4–6 rounds. Stable cadence of ~1 fight per tick.
Next levers: push to NV 10 (campaign), then dungeons at NV 20; add potion crafting once materials drop;
re-rank targets automatically every level-up (already done by `rankTargets`).
Diagnostics to trust when something looks frozen: `regenHp` in the runner state line must be > 0,
`logs/player_state_raw.json` for the raw vitals block, `node scripts/trono/plan.js` for target choice.

## Anti-ban rules in force
CloakBrowser only, headed, persistent profile, fixed seed; jitter between actions;
no credential handling; stop on captcha/rate-limit; never spend gold/gems/dotiria without human approval.
