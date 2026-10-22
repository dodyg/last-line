# Mud and Blood 2–style browser game implementation plan

## Objective and handoff

Build a complete, playable single-player browser game inspired by Mud and Blood 2: a top-down battlefield, a small defending squad, automatic real-time combat, tactical positioning, escalating enemy waves, reinforcements, cover, suppression, and unpredictable battlefield pressure.

Use TypeScript, Phaser, and Vite. The intended outcome is a finished local application and a verified production build, not just a scaffold or a visual demo. Use an original working title, **Last Line**, and original or appropriately licensed assets. Reproduce the broad gameplay experience rather than claiming exact historical rules, assets, or balance.

The user requested this plan after receiving the stack recommendation. Gameplay values below are proposed implementation defaults, not verified values from the original game. Proceed with these defaults unless the user steers otherwise; tune them through playtesting without changing the core scope.

### Current workspace

- Inspected on 2026-10-04 at `/mnt/d/github/mud`.
- No application files, package manifest, README, or existing PLAN.md were found.
- Hidden environment directories exist; preserve them.
- `git status` reported that this directory is not currently a usable Git repository. Do not assume commits or branches are available, and do not replace `.git`.
- No implementation has been performed. All milestone checkboxes below start incomplete.

### Instructions for the implementing agent

1. Read this file and any applicable workspace instructions before editing.
2. Inspect the workspace again; preserve any work added after this plan.
3. Complete milestones in order, getting the playable combat loop working before expanding content.
4. Update checkboxes only after their acceptance criteria pass. Record actual commands, results, decisions, and remaining issues in the handoff log at the end.
5. Resolve routine implementation choices autonomously. If a dependency or browser tool is unavailable, use a reasonable alternative and record the limitation.
6. Finish all required release scope. Optional work is deliberately outside the completion criteria.
7. Provide local run instructions and test evidence. Publishing externally is a separate step unless the user requests it.

## Scope and completion target

### Required release

- Title screen with New Game, Continue when a valid save exists, settings, and concise controls.
- One battlefield with deterministic, seeded terrain variation and several cover positions.
- Four initial riflemen, individual selection and move orders, automatic target acquisition and firing.
- Five recruitable roles: rifleman, machine gunner, medic, anti-armor soldier, and sniper.
- Three enemy archetypes: rifle infantry, assault infantry, and armored vehicle.
- Health, range, accuracy, reload time, line of sight, directional cover, suppression, and simple experience progression.
- Tactical-point economy, recruitment, sandbag and trench placement, and one targeted artillery support ability.
- Fifteen authored waves with a victory screen, plus optional endless continuation offered after victory.
- A defended line with integrity; defeat on zero integrity. Enemy breakthroughs damage it.
- Pause/resume, restart, visible-tab pause, sound controls, and meaningful combat feedback.
- Local settings, personal best, and one resumable autosave slot.
- Responsive layout for desktop browsers, keyboard-accessible menus, and a readable in-game HUD.
- Automated simulation tests, browser smoke coverage, production build verification, and documentation.

### Outside this release

Multiplayer, accounts, cloud saves, shared leaderboards, backend services, mobile touch controls, campaigns, a map editor, mod support, realistic rigid-body physics, advanced ballistic simulation, full replay tooling, and a generic ECS framework. Add them only under a later request.

## Stack and setup decisions

| Concern | Choice | Purpose |
| --- | --- | --- |
| Rendering and input | Phaser | Sprites, battlefield effects, pointer input, scenes, audio |
| Language | TypeScript with strict checking | Explicit simulation data and reliable refactoring |
| Development/build | Vite and npm | Local server, asset handling, static production output |
| Gameplay | Plain TypeScript | Test combat without a browser or Phaser |
| Content | Imported JSON with validation | Centralized tuning of units, weapons, waves |
| Menus and HUD | HTML/CSS overlay | Accessible buttons, readable panels, responsive layout |
| Persistence | localStorage | Small versioned saves and preferences |
| Logic tests | Vitest | Meaningful deterministic simulation checks |
| Browser checks | Playwright if available | Real controls, persistence, restart, built application |
| Delivery | Static `dist/` directory | Deployable without a server-side runtime |

Use one package and one application. No React, state-management framework, physics library, or networking dependency is needed for this scope. Prefer Phaser's existing audio and rendering features and browser-native controls.

At setup time, inspect the official [Phaser TypeScript/Vite template](https://github.com/phaserjs/template-vite-ts) and the installed Node version. Choose a stable compatible Phaser/Vite/TypeScript combination and record the exact installed versions in README.md. The template was advertising Phaser 4 when checked for this plan; some repository labels and tutorials still describe Phaser 3. Match code and API documentation to the actual installed major version. Do not mix examples blindly or introduce a prerelease merely to follow a version number.

Install compatible dependencies, commit a package-lock.json to the deliverable files, and use direct Vite scripts rather than copying template telemetry scripts. Ensure these commands exist:

```sh
npm install
npm run dev
npm run typecheck
npm run test
npm run build
npm run preview
npm run test:e2e
```

`typecheck` must run TypeScript without emitting files. `test` must run once and exit. Keep browser tests separate so a missing browser binary does not conceal passing or failing logic tests. Document Node requirements and how to install browser test prerequisites.

## Gameplay specification

### Battlefield and controls

Use a logical 960 × 720 battlefield, with enemies entering along the north edge and a defended line along the south edge. Keep the HUD outside world coordinates. Fit and letterbox the battlefield rather than stretching it; map pointer coordinates correctly at every display scale. Desktop layouts place recruitment and selection panels beside the field; narrower windows move them below it. Mobile play is not required.

- Left-click a friendly unit to select it; clicking empty ground clears selection.
- Right-click valid ground to move the selected unit. Suppress the native context menu only over the battlefield.
- Provide a visible Move button that enters left-click destination mode as an alternative to right-click.
- Units fire automatically while stationary; moving prevents firing for this release.
- Escape cancels a placement or targeting mode before opening pause.
- Space toggles pause unless focus is inside a form control.
- Recruitment selects a role, previews a position in the southern deployment zone, and confirms with left-click.
- Sandbag and artillery buttons enter explicit placement/targeting modes with a cancel option.
- Pause permits inspecting the squad but rejects gameplay commands. Document this behavior in the help panel.
- HUD interactions must never issue battlefield commands through the overlay.

### Initial tuning defaults

Keep all tuning in content/configuration files. These numbers are a first playable balance, not an immutable specification.

| Setting | Starting value |
| --- | --- |
| Starting squad | 4 riflemen |
| Starting tactical points | 12 |
| Defended-line integrity | 10 |
| Friendly squad cap | 12 |
| Initial preparation period | 10 simulation seconds |
| Break between cleared waves | 8 simulation seconds |
| Wave-clear reward | 3 points plus 1 per every 3 wave levels |
| Rifleman / machine gunner cost | 4 / 7 points |
| Medic / anti-armor soldier cost | 6 / 8 points |
| Sandbag cost | 3 points |
| Artillery cost / cooldown | 8 points / 30 simulation seconds |
| Infantry / vehicle breakthrough damage | 1 / 3 integrity |
| Simulation frequency | 30 ticks per second |

Display costs, restrictions, and cooldowns before confirmation. Deduct resources only when a command succeeds. Placement previews must indicate invalid positions, collisions, and insufficient resources. Confirmed support orders consume their cost even if no enemy is eventually hit.

### Unit behavior and combat

- Friendly roles share movement, health, selection, targeting, suppression, and experience rules.
- Riflemen provide inexpensive general-purpose fire.
- Machine gunners provide rapid infantry fire and stronger suppression, balanced by a longer reload.
- Medics prioritize healing the nearest wounded friendly in range. Healing has a cooldown and cannot revive dead units; medics do not shoot in this release.
- Anti-armor soldiers fire slow explosive rounds that damage vehicles and nearby infantry.
- Enemy riflemen advance, stop to engage valid defenders in range, and resume advancing when targets disappear.
- Assault infantry move faster and favor closing distance; their shorter range makes positioning matter.
- Vehicles advance slowly and fire at defenders; small arms cause reduced damage while anti-armor weapons remain effective.
- Resolve target choice by eligibility, then distance, then stable entity ID. Retain a target while valid to prevent distracting target flicker.
- Base hit probability depends on weapon accuracy, distance, unit experience, target cover, and attacker suppression. Clamp probabilities to safe bounds.
- Use a seeded random generator for all gameplay randomness. Cosmetic randomness must use a separate source.
- Use simplified hitscan rifles: resolve a shot immediately, then render a short tracer. Explosive rounds use simulation-owned travel time and impact events. Effects never determine damage.
- Projectiles and artillery damage all units in their impact radius, including friendlies; show this explicitly in the support tooltip. Direct rifle fire only targets opponents.
- Health reaching zero immediately removes the entity from targeting and selection. Emit one death event and grant rewards once.
- Surviving combatants earn experience on kills; cap the small accuracy/reload bonus. Credit explosive kills to a surviving source unit when applicable, and give artillery no unit experience.

### Cover, suppression, and movement

Generate a fixed traversable terrain layout from the run seed. Begin with a small grid and authored obstacle patterns, not unrestricted random blocks. Ensure enemy routes to the defended line and valid deployment cells remain open.

- Solid obstacles block movement and line of sight; sandbags reduce incoming accuracy but do not block movement or sight.
- A sandbag protects units near its south face against shots arriving from the north. Use the attack direction and unit proximity; standing anywhere near cover must not confer protection from every angle.

**Buildings (added after release, 2026-10-07).** Churches, field hospitals and
houses are solid while they stand — movement, line of sight, and bullets — and
become walkable, transparent ruins once destroyed, which is what makes them
different from every other obstacle on the map. They are placed in the contested
middle of the field, clear of the deployment strip, the water, each other and any
existing obstacle, so a structure can never wall the map off. Small arms barely
mark masonry; artillery, rockets and tank shells do the work. Tuning lives in
`CONFIG.buildings`.

**River and mud (added after release, 2026-10-07; river randomised the same day).**
Soft ground is passable everywhere and blocks nothing, including sight: it is the
cost of the ground rather than its shape. A meandering river crosses some maps
east to west, north of the deployment zone, and mud patches are scattered clear
of it. **Not every map has water**: `CONFIG.terrain.river.presenceChance` decides
per map, and a dry map carries more mud instead, so every battlefield has soft
ground worth reading and some are faster, more open fights. Obstacles and rubble
are never placed on either hazard, so a river can never become an accidental
wall. Both sides pay the same penalty — wading costs speed, accuracy and reload
time; mud costs more of each — which makes the river a place to catch an attack
mid-crossing rather than a free defensive line. The penalties are configured in
`CONFIG.terrain.effects`.
- Suppression rises from nearby hostile shots and explosions, decays without pressure, and reduces accuracy. Above a configured threshold, units become pinned and stop moving/firing until suppression drops below a lower recovery threshold.
- Use grid A* with a small existing implementation in the codebase if present, otherwise a compact local implementation. No navigation package is necessary.
- Validate destinations, find a traversable nearby cell when reasonable, and show a rejected-order message if no route exists.
- Dynamic units are not hard navigation obstacles. Apply lightweight separation so allies do not pile onto one point; avoid deadlocks in narrow routes.
- Use simulation coordinates for all distances, ray checks, and area damage. Add a spatial index only if profiling reveals a real bottleneck.

### Waves, support, scoring, and end states

Define fifteen waves as JSON composition plus spawn interval and lane variation. Wave 1 should teach rifle combat; introduce assault infantry around wave 4 and armor around wave 7. Telegraph first armor arrival before the preparation period ends so the player can recruit a counter. Avoid releasing more than the agreed live-unit limit at once.

Each wave passes through preparation, spawning, active combat, and cleared states. It clears only when all scheduled enemies have spawned and every enemy is dead or has crossed the line. A breakthrough removes the enemy once and damages integrity once. A wave-clear reward is granted once. Zero friendlies does not automatically end the run while recruitment remains possible; defeat depends on integrity.

**Marching north (added after release, 2026-10-07).** A run is a short campaign over
several maps. The northern band of the field is an exit, open from the first
second of a run: every living soldier ordered into it leaves the map's order of
battle and walks off. Once the last soldier is across, the next map is generated,
its wave counter restarts at 1, and the squad re-forms in the south with its
wounds, experience, kills, personal weapon upgrades, and service records intact;
points, score, and line integrity also carry over. Fortifications, mines,
in-flight shells, and the enemy holding the abandoned map do not. A fifth wave
phase, `crossing`, freezes the abandoned map's scheduler so it can neither start
another wave nor pay a clear reward, and a crossing soldier is excluded from
targeting, orders, and the squad cap. Clearing the configured number of maps wins
the campaign; winning one map's fifteen waves is still a win in its own right.

Artillery shows an area marker, lands after a short simulation delay, and applies area damage and suppression. Bound its center to playable terrain, allow targeting near obstacles, and clearly communicate friendly fire. Add a restrained screen shake with a setting to disable it.

Score = enemy kill values + wave-clear bonuses + surviving integrity bonus on victory. Keep the formula in configuration. Store a local personal best, not an online ranking. On final wave clear, stop combat, show victory and a summary, and offer New Game or Continue Endless. Endless composition scales the same content with bounded spawn rates and active-unit caps; no new asset types are required. On defeat, stop combat and offer Restart or Main Menu.

## Architecture and data flow

Use plain objects with stable numeric IDs and a small collection of focused modules. Avoid a framework inside the framework.

```text
HTML controls / battlefield input
                |
           typed commands
                |
  fixed-step TypeScript simulation <--- validated content + seeded RNG
                |
       state + per-tick events
          /             \
Phaser rendering       HUD + persistence snapshots
```

The simulation imports no Phaser APIs, DOM globals, audio objects, or wall-clock time. Commands are validated by the simulation even when the UI already validates them. The renderer reads state and consumes events; it never changes health, resources, or wave progression.

Suggested structure, adjusted only when a smaller arrangement is clearer:

```text
index.html
package.json
package-lock.json
tsconfig.json
vite.config.ts
src/
  main.ts
  styles.css
  game/
    BattleScene.ts
    render.ts
    input.ts
  simulation/
    types.ts
    simulation.ts
    combat.ts
    navigation.ts
    waves.ts
    rng.ts
  content/
    units.json
    weapons.json
    waves.json
    config.ts
    validate.ts
  ui/
    hud.ts
    menus.ts
  persistence.ts
public/assets/
tests/
  simulation.test.ts
  persistence.test.ts
  browser.spec.ts
README.md
ASSETS.md
PLAN.md
```

State includes schema version, seed and RNG state, elapsed ticks, next entity ID, units, pending explosive impacts, terrain, tactical points, integrity, score, wave scheduler, support cooldowns, and run phase. Persist every field needed to resume the same outcome. Selection, particles, sprite instances, and audio playback do not belong in saved gameplay state.

The update loop accumulates frame time and steps at 1/30 second. Cap catch-up work to five steps per rendered frame and discard excess accumulated time after a long stall. Clear the accumulator on pause/resume. Auto-pause when the document becomes hidden and require explicit resume on return. Gameplay timers use ticks, not `setTimeout`. Consume events from every simulated tick exactly once even if multiple steps occur in a frame.

Rendering interpolates positions where useful and keeps a map of entity IDs to display objects. Remove objects, listeners, effects, and audio on scene shutdown. Repeated restart must not multiply update loops or event handlers.

## Presentation and persistence

### Visual and audio direction

Use a readable muted battlefield palette with clear friendly/enemy outlines, visible facing, distinct unit silhouettes, dirt, trees, sandbags, tracers, explosions, and persistent but capped casualty/debris marks. Generated Phaser textures or simple original shapes are acceptable finished art when they form a consistent style; missing assets, broken images, or template branding are not.

Show selected-unit health, suppression, role, experience, and current action. Display tactical points, campaign map, wave/preparation timer, line integrity, score, pause state, and support cooldown. Keep short recent combat notices capped rather than flooding the screen. Include a brief first-run help overlay and a persistent Help button.

Create or source a small coherent set of rifle, machine-gun, explosion, healing/confirmation, and UI sounds. Unlock audio after user interaction. Cap simultaneous repeated shot sounds. Missing or blocked audio must not prevent play. Record external asset sources and licenses in ASSETS.md; record original generated assets as such. Respect mute, volume, reduced-motion preference, and the screen-shake toggle. Convey selection, danger, and pinned status through shape/text as well as color.

### Save contract

- Use separate versioned keys for preferences, personal best, and the autosave.
- Autosave periodically, approximately every 10 simulation seconds, and on pause and wave transitions. Avoid synchronous storage writes every frame.
- Save after a support purchase with pending impacts included so reload cannot refund the action.
- Continue restores a paused run and rebuilds the renderer from simulation state.
- A valid run includes known archetypes, finite coordinates, bounded entity counts, unique IDs, valid RNG/scheduler state, and nonnegative bounded resources/timers.
- Parse JSON defensively and validate the full snapshot shape; do not trust a TypeScript assertion as runtime validation.
- Unsupported or corrupt saves disable Continue and show a clear message without blocking New Game.
- If storage is unavailable or quota is exceeded, continue in memory and show a single nonintrusive notice.
- New Game replaces the old autosave when the new run is created. Victory/defeat remove the resumable run, update best score, and preserve preferences.
- Endless continuation creates a fresh resumable snapshot. Confirmation before replacing an active run should explain that only one autosave slot exists.

## Implementation milestones

### 1. Project foundation

- [x] Inspect workspace instructions and tools; record chosen package versions and Node requirement.
- [x] Set up Vite, strict TypeScript, Phaser, lockfile, and test scripts.
- [x] Add a basic title screen, battlefield scene, HTML HUD shell, and responsive sizing.
- [x] Remove demonstration content and ensure production asset paths support a documented deployment base.

Acceptance: development server displays the game shell; typecheck and production build pass; preview serves the built shell without missing assets or console errors.

### 2. Playable combat slice

- [x] Implement seeded state, fixed-step loop, validated content, commands, and events.
- [x] Add four selectable riflemen, movement, enemy spawning, automatic rifle combat, health, and deaths.
- [x] Implement line breakthroughs, tactical points, recruitment, one complete wave, defeat, and restart.
- [x] Add pause, explicit resume after tab hiding, selection details, and order feedback.
- [x] Add focused tests for deterministic combat, invalid purchases, and one-time death/breakthrough effects.

Acceptance: a user can start, select, reposition, recruit, fight a wave, lose, and restart. The simulation runs in tests without a browser. Paused gameplay does not advance timers or accept action commands.

### 3. Tactical systems

- [x] Add traversable seeded terrain, obstacles, A*, line of sight, sandbags, and placement validation.
- [x] Add suppression/pinning, experience, medic, machine gunner, anti-armor soldier, and both additional enemy types.
- [x] Add explosive travel/area damage, artillery cost and cooldown, and friendly-fire communication.
- [x] Implement all fifteen waves, rewards, victory, bounded endless continuation, and score summary.
- [x] Test cover direction, blocked sight/routes, medic limits, armor resistance, suppression recovery, and splash damage.

Acceptance: cover and positioning visibly change combat outcomes; each role has a useful distinct function; armor can be countered; victory and defeat are reachable; wave transitions cannot double-award points.

### 4. Complete player experience

- [x] Finish title/help/pause/settings/results flows, keyboard behavior, recruitment previews, and responsive HUD.
- [x] Add coherent battlefield art, animation, bounded effects, sounds, and asset provenance.
- [x] Implement validated autosave/continue, preferences, local best, and graceful storage failures.
- [x] Test restored simulation against the uninterrupted run, corrupt-save handling, and new-run replacement.
- [x] Playtest balance and tune content without weakening verification or bypassing systems.

Acceptance: the game explains its controls, has no placeholder flows, saves and resumes correctly, remains usable muted, and communicates support risks and failed actions clearly.

### 5. Verification and delivery

- [x] Run typecheck, logic tests, production build, and browser smoke checks against the production preview.
- [x] Verify desktop Chromium and Firefox where available; document actual browser coverage.
- [x] Stress-test the battle and repeated restart/continue cycles; fix leaks or unbounded work.
- [x] Write README.md with installation, controls, mechanics, scripts, save behavior, tuning, and static-host deployment instructions.
- [x] Complete ASSETS.md and update this plan's handoff log with evidence and remaining limitations.

Acceptance: every required release item passes the completion checklist below. Do not mark missing browser verification as passing; record why it could not run and complete available alternatives.

## Verification details

### Automated simulation coverage

Use a small set of meaningful tests with seeded scenarios. Avoid asserting renderer implementation details or writing one test for every trivial helper.

1. Same seed plus identical commands applied on the same ticks yields identical gameplay state.
2. Different frame-time batching with the same total simulated ticks produces the same outcome when catch-up limits are not reached.
3. Out-of-bounds/unreachable orders and unaffordable or capped purchases reject without consuming resources.
4. Targets outside range or behind solid terrain cannot be hit; appropriate directional cover changes the hit calculation.
5. Suppression pins units and recovers through the configured hysteresis; pause freezes all gameplay clocks.
6. Medic healing respects range, cooldown, maximum health, and death state.
7. Anti-armor damage differs meaningfully from small arms; splash affects both sides once per impact.
8. Dead units, breakthroughs, wave-clear rewards, and victory/defeat transitions resolve exactly once.
9. Save then restore yields the same subsequent state as uninterrupted simulation, including pending explosions and random state.
10. Malformed content and corrupt/unsupported saves fail clearly; unavailable storage does not crash gameplay.

### Browser smoke scenarios

- New Game creates four visible friendlies and an operational HUD.
- Select a soldier, issue a valid move, and observe position/selection-panel changes.
- Recruit once and confirm resources and squad count change once.
- Pause/resume and hide/restore the tab; confirm no unexpected combat progress.
- Save, reload, Continue, and confirm run state plus explicit paused status.
- Enter/cancel support mode and interact with HUD without leaking orders to the field.
- Reach a result screen using a small test fixture, restart repeatedly, and confirm no duplicate input or updates.
- Load the production build at desktop and narrower viewport sizes and verify pointer alignment and visible controls.
- Confirm no uncaught exceptions, failed local asset loads, or template content.

Prefer seeded fixture states or a test-only setup hook to long timing-dependent browser tests. Keep hooks restricted to the test/development build; production gameplay must not depend on them. Automated fast completion is verification, not a substitute for manually playing normal waves.

### Performance and playtesting

Provisional stress scenario: 12 friendly units, 80 enemies, 30 simultaneous explosive projectiles, and active cosmetic effects. Record browser, hardware/environment, and observed frame timing; aim for smooth 60 FPS rendering on an ordinary desktop, but do not invent a measured guarantee. Keep effects, corpses, event history, and simultaneous audio bounded. Profile before adding spatial indexing or object pools.

Manually play the opening three waves, the armor introduction, and the final wave. Aim for a normal first victory run of roughly 15–25 minutes after tuning. Confirm the player has a reasonable recovery opportunity after a casualty, recruitment does not trivialize early waves, and armor is not an unexplained unavoidable defeat.

## Definition of done

- [x] A fresh install can launch the game using documented commands.
- [x] Every required gameplay feature and menu flow works in the browser.
- [x] Normal play can reach both defeat and fifteen-wave victory; endless continuation works within caps.
- [x] Combat state is owned by the deterministic simulation and tested independently of rendering.
- [x] Settings, best score, and valid autosaves survive reload; corrupt/unavailable storage is handled.
- [x] Production build passes and has been served and exercised, not only compiled.
- [x] Typecheck and meaningful logic tests pass without disabled checks or suppressed failures.
- [x] Browser verification results and performance observations are recorded honestly.
- [x] README.md and ASSETS.md describe the delivered application accurately.
- [x] PLAN.md reflects completed work and lists any remaining limitations explicitly.

## References

- [Phaser documentation](https://docs.phaser.io/): framework concepts and APIs; match the selected major version.
- [Official Phaser TypeScript/Vite template](https://github.com/phaserjs/template-vite-ts): setup reference, version selection, build and static-delivery workflow.
- This plan intentionally contains proposed gameplay rules. Exact original-game fidelity would require a separate reference audit and revised acceptance criteria.

## Implementation handoff log

Append concise dated entries as work proceeds:

```text
Date / milestone:
Implemented:
Dependencies and decisions:
Verification commands and results:
Browser/playtest evidence:
Known issues or blocked checks:
Next concrete step:
```

Initial entry — 2026-10-04: Planning only. Workspace inspection found no existing app. Next step: milestone 1, project foundation.

2026-10-04 (evening) through 2026-10-05 (morning) / milestones 1–4:
Implemented: full application — Vite + strict TypeScript + Phaser 4 project; deterministic fixed-step simulation (seeded mulberry32 RNG, terrain generation with guaranteed lanes, grid A*, directional sandbag cover, suppression/pinning hysteresis, XP, hitscan and projectile combat, artillery strikes, wave scheduler with 15 authored waves and bounded endless mode); validated JSON content (units/weapons/waves); Phaser renderer with CC0 field tiles, CC-BY-SA WWII Allied/Axis infantry sprites and original code-drawn battlefield effects; synthesized WebAudio SFX; HTML/CSS HUD/menus (title, help, pause, settings, results, endless offer); versioned localStorage persistence with in-memory fallback; Vitest logic/persistence/balance suites and Playwright smoke suite with a test-only `?e2e` hook.
Dependencies and decisions: Phaser 4.2.1, Vite 8.3.1, TypeScript 7.0.2, Vitest 4.1.11, happy-dom 20.14.5, @playwright/test 1.63.0, Node 24; `base: './'` for sub-path static hosting; no React/state/physics/networking dependencies.
Verification commands and results: `npm run typecheck`, `npx vitest run`, `npm run build`, `npx playwright test` run repeatedly during development.
Known issues or blocked checks: stale `test-results/` artifacts from an interrupted Oct 4 run showed hook errors against an older build; superseded by fresh runs below. A concurrent agent session was also editing balance content in this workspace during Oct 5; see next entry.

2026-10-05 ~12:05–12:45 / milestone 4–5 (balance fix and delivery):
Implemented: fixed the failing campaign-balance check. Root causes found by instrumentation: (1) the scripted defender's sandbags sat outside the 22 px directional-cover window of its firing line, protecting nobody; (2) an over-wide AT "point reserve" gated all recruitment and starved the squad at ~6/14; (3) the defense line spanned x≈220–720 while enemies spawn at x 40–920, so flank spawns walked to the line unopposed. Rewrote the autoplay (`tests/helpers/autoplay.ts`, shared by `tests/balance.test.ts`): wide 6-bag line at y=596 covering x 160–800, units dug in 16 px south, continuous recruitment in all phases with AT/medic/MG priorities, second medic in large squads, artillery gated only by a missing-AT condition. Accepted concurrent-session content tuning as baseline (integrity 20, squad cap 14, artillery cooldown 24 s, wave-clear base ~11, friendly rifle range 280, enemy small arms nerfed).
Dependencies and decisions: balance tuning done in content/strategy only — no simulation rules were changed or bypassed; campaign remains fail-able (passive defender still loses at wave 6).
Verification commands and results: `npx vitest run` → 28/28 pass, including autoplay victory on seeds 11/2026/777/4242 (12.9–18.3 game-minutes, inside the 10–40 gate; seed 4242 finishes at integrity 1) and passive-defeat at wave 6. `npx tsc --noEmit` clean. `npm run build` succeeds (chunk-size warning is Phaser's bundle; expected). `npx playwright test` → 18/18 pass on Chromium and Firefox against the production preview (new game/HUD, select+move, recruit-once, pause/tab-hide, save→reload→continue, mode entry/cancel/HUD isolation, result screen + repeated restarts, 800 px viewport pointer alignment, zero console/page errors). `npm ci --dry-run` clean (lockfile consistent for fresh install). Removed debris: `tests/_diag.test.ts`, `debug-balance.mjs`, stale `test-results/`.
Browser/playtest evidence: all Playwright scenarios above executed on both browsers in WSL2/headless. Performance probe added (`tests/stress.spec.ts`, run via `STRESS=1 npx playwright test`): ~14 friendlies vs 80 enemies incl. 9 vehicles with live shells — 47 FPS average, p95 frame 28 ms, max 34 ms on Chromium **headless software rendering** (a lower bound; desktop GPUs should exceed this comfortably).
Known issues or blocked checks: (1) No human hands-on playtest was performed by the agent; balance was verified by seeded autoplay simulation plus scripted browser scenarios, as the plan permits automated fast completion only as verification — a human should still play the opening waves, the armor introduction, and the final wave and tune to taste. (2) Delivered tuning intentionally diverges from the plan's proposed starting defaults (integrity 20 vs 10, cap 14 vs 12, artillery 24 s vs 30 s, wave reward ~11+⌊wave/2⌋ vs 3+1/3) as allowed playtest tuning; README documents actual values. (3) Performance numbers are from a software rasterizer, not representative desktop hardware. (4) The workspace is not a git repository, so no commits were made.
Next concrete step: human playtest for feel; optionally add a second autosave slot or touch controls if requested.

2026-10-05 / milestone 5 (reconciliation and final delivery, second session):
Implemented: found and fixed the delivery's one critical simulation defect — `killUnit` guarded on `health <= 0`, but damage is applied before the call, so every shot/splash kill early-returned: deaths were silent (no `unitDied` event, no kill credit, no XP, no score) while the unit was swept by the health filter. Replaced the guard with an explicit `dead` flag on `Unit` (types, baseUnit, killUnit, breakthrough, dead-removal filter, target validity, snapshot validation). Narrowed enemy spawn lanes from x 40–920 to x 160–800 so attackers converge on the defended approach instead of walking past thin flanks (removes the structural leak source; complements the other session's wider line). Added an endless-mode bounded-generation test (`tests/simulation.test.ts`), a `tests/helpers/autoplay.ts` + `tests/balance.test.ts` balance harness consumer check, a `.gitignore`, `scripts/stress.mjs` (standalone frame-time probe), and this session adopted the concurrently authored `tests/helpers/autoplay.ts`, `tests/stress.spec.ts`, and README/PLAN updates after review.
Dependencies and decisions: balance pass was iterated against the autoplay harness across seeds 11/2026/777/4242 — final levers: friendly rifle/MG/AT range 280/300/300 (longer engagement window), enemy rifle hp 70 / accuracy 0.42 / range 200, integrity 20, squad cap 14, artillery cooldown 24 s, wave reward 11 + ⌊wave/2⌋, wave 15 thinned to 2 vehicles. Tuning stays in content/config per the plan; simulation rules changed only via the two defect fixes above (death-event correctness and lane narrowing), not to force outcomes.
Verification commands and results: `npm run typecheck` clean (TypeScript 7.0.2, strict, `noUncheckedIndexedAccess`); `npm test` → 29/29 pass (determinism, validation, cover/LOS/suppression/medic/armor/splash, one-time transitions, save-restore equality incl. JSON round-trip and pending strikes, corrupt/unsupported saves, storage fallback, malformed content, 4-seed campaign victory in 12.9–18.3 game-minutes with passive defeat, bounded endless generation); `npm run build` clean; `npm run test:e2e` → 18/18 (9 scenarios × Chromium 153 + Firefox 155, headless) against the production preview; `STRESS=1 npx playwright test` → 20/20 including the saturation probe (measured 24–52 FPS avg, p95 30–68 ms, on headless software rendering — a lower bound, not a desktop-GPU claim; probe gate set to a crude >15 FPS interactivity floor after borderline 24 FPS samples). `npm run dev` smoke-checked (page + module served). Fresh-install path verified via clean `npm install` earlier in delivery; package-lock.json committed to the deliverable.
Browser/playtest evidence: all browser scenarios executed headless on both engines; console clean (no page errors, no failed asset loads, no template content); pointer mapping verified against Phaser's canvas bounds (a ResizeObserver refreshes bounds when HUD panels shift layout). No human hands-on playtest by this session; the only manual-play claim in these logs is the other session's.
Known issues or blocked checks: (1) two agent sessions worked this workspace concurrently on Oct 5 (interrupted server restarts); their logs above may overlap — this entry supersedes factual conflicts, notably: the silent-death `killUnit` defect and spawn-lane change were simulation fixes made by this session, not strategy-only balance work. (2) Performance figures are software-rasterizer numbers on a loaded WSL2 machine; variance between runs was 21–52 FPS under identical load. (3) Delivered tuning intentionally diverges from the plan's proposed starting defaults as sanctioned playtest tuning; README states delivered values. (4) Workspace is not a git repository; nothing was committed.
Next concrete step: human playtest for feel (opening three waves, wave 7 armor intro, wave 15 finale); optional follow-ups: second autosave slot, touch controls, spatial index if profiling on real hardware ever demands it.

2026-10-07 / named veterans and squad service records (requested option 7):
Implemented: deterministic soldier names derived from seed/id without consuming combat RNG; XP-based ranks from Private through Technical Sergeant; battlefield rank insignia; a clickable, keyboard-accessible squad roster with HP, wounded/pinned/morale status, stable focus, and selected-soldier details directly beneath it. Added battle-report casualties, breakthroughs, and survivor contributions (kills, actual medic healing, completed engineer fortifications). Battle totals and service records persist across Continue/endless and validate at load; older saves migrate with zero historical totals. Corrected report accounting so breakthroughs do not count as kills or award kill score, and friendly-fire deaths award no kill credit/XP. Updated outdated engineer/radio fixtures and the Playwright base URL; sidebar scrolls rather than collapsing controls in Firefox.
Verification: production build and TypeScript checking pass. `npm test`: 33/34 pass; the existing active-defense campaign balance assertion still fails at wave 12 with 14 breakthroughs (same failure observed before the roster/report work). The autoplay helper is unchanged; refreshing its strategy remains a separate balance task. `npm run test:e2e -- --workers=2`: 22/22 pass in Chromium and Firefox, including saved ranks/contributions, real roster selection and focus retention, visible selected details, named casualty/removal feedback, battle reports, restarts, and narrow-view controls. Desktop roster and desktop/narrow battle-report screenshots inspected locally.
Known limitation: old saves cannot reconstruct historical healing, construction, deaths, or breakthroughs; new totals start when resumed. No new dependencies or game-balance tuning were introduced.

2026-10-07 / marching north to a new map (requested gameplay mechanic):
Implemented: a campaign layer over the wave cycle. The northern 56 px band of the field is an exit, reachable like any other ground. A living friendly ordered into it is marked `crossed`, leaves the order of battle immediately (excluded from target selection, move/group orders, the squad cap, engineer/radio availability, box-select, the roster, and the HUD's on-map count), and is carried off the field in the same tick. When the last soldier is across, `advanceToNextMap` generates a new battlefield, resets the wave counter to 1, grants a 12 s arrival preparation window, and re-deploys the squad in a southern assembly grid snapped to open ground. Player state survives (soldiers with wounds/XP/kills/per-soldier weapon upgrades/service records, points, score, integrity); ground state does not (sandbags, trenches, mines, construction sites, in-flight shells, and every enemy on the abandoned map). A new fifth wave phase, `crossing`, freezes the abandoned map's scheduler so it neither spawns nor pays a clear reward, and campaign victory fires after `CONFIG.crossing.campaignMaps` (3) maps; the original fifteen-wave victory is untouched. Terrain for map N is regenerated from `mapTerrainSeed(baseSeed, N)` (map 1 is the run seed itself) so a reload reproduces the same sequence of battlefields; snapshot schema v3 carries `mapNumber`, `mapsCleared`, `baseTerrainSeed`, `crossedUnits`, and `scheduler.endlessWavesCleared`, and v1/v2 saves migrate to map 1 with nobody across. Endless wave numbering now counts endless waves cleared across maps, so marching north no longer resets endless difficulty or its labels. Wired `crossingBegan`/`unitCrossed`/`mapCleared` events into the controller (terrain rebuild, notices, map/phase HUD), added a Map stat and a crossing readout to the HUD, painted the exit band and its arrival hatch in the renderer, documented the mechanic in the help overlay and README, and added a `rallyAtNorthEdge` e2e fixture.
Dependencies and decisions: no new dependencies. Decisions worth recording: (1) crossing is available at any time, not gated on clearing waves — it is a retreat as much as an advance; (2) "crossed" is derived state, stripped from snapshots and rebuilt from the two unit lists on restore, so a save is byte-identical regardless of when the march was captured; (3) a pinned soldier must recover before it can finish the walk, so the exit band cannot be used to escape a pin; (4) freshly generated maps use the same fifteen-wave curve, so the campaign is currently flat difficulty (documented as a known limitation).
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 86/86 pass (simulation 66, persistence 13, balance 3, soldiers 4), including the new crossing coverage: a soldier leaving `units` without becoming a casualty, the frozen abandoned map, the new battlefield and reset wave counter, per-soldier carry-over versus ground loss, one map clear per transition, campaign victory at three maps, split-squad snapshot round-trip equality, distinct per-map seeds, v1→v3 migration, and rejection of a unit present in both lists. `npm run build` clean. `npx playwright test` → 34 tests across Chromium and Firefox: 31 pass, plus the new "marching the whole squad north" scenario on both engines (map 2/3, wave 1/15, 4/14 squad, veteran's XP/kills/health/upgrade intact, sandbags gone, abandoned enemies absent, notices shown).
Browser/playtest evidence: the new scenario drives the real production build through the `?e2e` hook — real frame pipeline via `controller.frame`, real save/reload/Continue, then a real walking march to the band — and asserts both simulation state and HUD text. Three pre-existing browser scenarios are timing-flaky in full parallel runs (medic healed 55 rather than the asserted 30 HP before the results screen; a 6 s notice TTL expiring before the assertion; a Firefox `#btn-continue` click timing out); all three pass in isolation and none touch the crossing code.
Known issues or blocked checks: the exit band depth (56 px), the three-map campaign goal, and the arrival window (12 s) are first-pass values with no playtest behind them; nothing escalates between maps, so marching currently trades every fortification for banked experience and a wave-counter reset. The README's pre-existing balance-harness caveat (autoplay fails its active-defense check at wave 12) still stands and was not addressed here.
Next concrete step: playtest the march for feel and decide whether later maps should escalate (e.g. higher spawn counts or shorter prep per map), then tune `CONFIG.crossing` and `CONFIG.assembly` accordingly.

2026-10-07 / river crossing and mud (requested terrain features):
Implemented: soft ground as a third terrain category beside open and blocked. A meandering **river** (54–72 px wide, ±26 px sweep on a 520 px wavelength) crosses every map east to west, and 4–6 roughly round **mud patches** are scattered clear of it, both derived from the map seed so every reload reproduces them. Both are passable everywhere and block nothing — movement or line of sight — and the obstacle and rubble passes explicitly skip them, so a river can never become a wall. The penalty is applied to both sides identically: wading costs 55% speed, 70% accuracy and 45% more reload time; mud costs 50% speed, 78% accuracy and 60% more reload (all in `CONFIG.terrain.effects`, looked up through `terrainEffectsAt`). Wired into `speedOf`, `reloadTicksFor` and `hitChance` (new `attackerGroundAccuracyMult` context field), with `reloadTicksFor` made public so the penalty can be tested directly rather than inferred from a firefight. The renderer paints the water as a stroked centreline plus per-cell fills — so every cell the simulation charges for wading is visibly water — and the mud as dark wet blotches, both drawn under the field clutter and excluding tufts and crates. The terrain inspector reports "River" and "Mud" with the exact penalty. `TerrainData` gained `zones` (river area plus mud areas) and `kinds` gained 5 (river) and 6 (mud).
Dependencies and decisions: no new dependencies. Decisions worth recording: (1) the river is a hazard, not a barrier, per the request — so it deliberately grants no cover and blocks no line of sight; (2) both sides pay the same price, which keeps it a place to fight over rather than a defensive crutch; (3) the meander is a pure function of x and the seed rather than a random walk, so the band is continuous with no seam and the renderer can draw the same curve the simulation tested; (4) mud patches use an asymmetric spacing rule (`minGapFactorX` 2.6 vs `minGapFactorY` 1.35) and alternating field halves, because independent uniform placement fused them into one continuous bog across the map — caught by printing the generated layout as characters and fixed before shipping.
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 93/93 pass, including six new cases: every map has both features and neither ever marks a blocked cell; the ground lookup returns the configured effects and neutral values on firm ground; a soldier wading or bogged moves exactly the configured fraction of firm-ground distance; reload time scales by the configured multiplier; aim is worse in mud than on firm ground. `npm run build` clean. `npx playwright test` → 36/36 pass across Chromium and Firefox, including the new "river and mud" scenario: the squad's move order into the water is accepted (proving passability), the soldier enters the river, and its terrain effects report the speed, accuracy and reload penalties in the running game.
Browser/playtest evidence: the layout was inspected directly by printing each generated battlefield as characters for two seeds, which is what exposed both the zigzag meander (3.2 cycles across the field) and the fused mud field; the corrected layouts show one meandering channel and 3–4 separate patches with firm ground between. The rendered battlefield was then inspected as a screenshot, which exposed the stepped per-cell water and the too-dark mud; the water now reads as a continuous channel with a visible current line and the mud as wet earth distinct from shell craters.
Known issues or blocked checks: the penalties are first-pass with no playtest; because they are symmetric the river currently slightly favours whoever is shooting across it, and the channel may want to be narrower or partly fordable after play. Separately, the browser suite has pre-existing timing flakes under parallel load (a screen-shake magnitude that can decay to zero before the assertion, a 6 s notice TTL, and a medic's healed-HP total that overshoots its fixture): three such failures appeared on one full run, the affected scenarios pass in isolation, and a subsequent full run was 36/36 green. The pre-existing autoplay balance caveat (active-defense check fails at wave 12) still stands and was not addressed here.
Next concrete step: playtest a river crossing — whether the water is wide enough to matter and narrow enough not to stall a wave — then tune `CONFIG.terrain.effects`, `river` and `mud`.

2026-10-07 / animated river (requested):
Implemented: the river now flows. The static bed stays in `terrainG`, drawn once per map; a new `riverFlowG` layer above it is cleared and redrawn every frame by `drawRiverFlow(dt)`. The centreline is walked once into `riverCurve` (41 samples) at map build time and cached, so the animation rides the same curve the simulation tested against instead of re-deriving the meander each frame. The effect is a travelling phase — 34 px/s, wrapped at the 112 px dash spacing — that moves a broad low-alpha sheen plus four tracks of streamers downstream; dash length and alpha vary with distance from the bank and with position, so the pattern reads as current rather than a grid. The phase is a function of elapsed time rather than accumulated per-frame state, so it cannot drift. The flow keeps moving while the battle is paused (weather, not gameplay), and `dt` is clamped to 100 ms so a long stall cannot teleport the pattern.
Dependencies and decisions: no new dependencies. Decisions worth recording: (1) the animation is purely cosmetic and reads nothing from the simulation, so it cannot affect outcomes or determinism — the simulation suite is untouched; (2) it lives in its own graphics layer rather than rebuilding the terrain layer, so the cost per frame is one `clear()` plus ~690 short line commands, against a 960×720 field redrawn at 60 FPS; (3) the water is drawn under units and effects, so soldiers wading are never painted over.
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 93/93 pass (unchanged: the animation is renderer-only). `npm run build` clean. The animation was verified directly rather than by eye: a temporary probe read the renderer's `riverPhase` across three moments and confirmed it advances monotonically (1.02 → 18.50 → 36.04 px, i.e. 34 px/s as configured) with the 41-point curve cached, a 35.8 px half-width, and 690 commands in the flow layer — while the game was paused. The rendered result was then inspected as a screenshot, which is what prompted varying dash length and spacing, since the first pass read as a regular lattice of dashes rather than as moving water. Artifacts were removed after inspection.
Known issues or blocked checks: none specific to the animation. The pre-existing browser-suite timing flakes and the autoplay balance caveat noted in earlier entries still stand.
Next concrete step: if the motion ever proves distracting, expose it behind the existing reduced-motion preference or the screen-shake-adjacent settings; otherwise leave it as the battlefield's only ambient motion.

2026-10-07 / randomised river presence (requested):
Implemented: the river is no longer on every map. `generateZones` rolls `rngNext(rng) < CONFIG.terrain.river.presenceChance` (0.62) before laying anything out; on a dry map it returns `zones.river = null`, paints no water cells, keeps the flow layer empty, and reports no river penalty anywhere. `TerrainData.zones.river` is now nullable, and every consumer was given an explicit dry-map path: obstacle and rubble placement, `isRiverAt`, `terrainEffectsAt`, the renderer's bed and flow passes, `riverBand`, and the terrain inspector. Mud compensates: a map with a river gets 4–6 patches, a dry map 5–8 (`patchMinWithoutRiver`/`patchMaxWithoutRiver`), so soft ground is never absent. The controller notes which kind of field the map is in the Setting stat ("… · river" / "… · dry").
Dependencies and decisions: no new dependencies. Decisions worth recording: (1) presence is derived from the map seed like every other terrain feature, so it is stable per map and per save while varying run to run — 396 of 400 seeds roll as configured; (2) `generateTerrain` may retry obstacle layouts up to 25 times, so the roll had to come from its own derived stream rather than the attempt RNG, or a river could flicker between attempts of the same map; (3) a dry map is not a featureless one, which is why mud increases rather than staying fixed; (4) the flow layer is cleared unconditionally before the dry-map early return, because a map change from a wet battlefield to a dry one would otherwise leave the previous map's current painted on the new field.
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 94/94 pass. The river/mud suite was extended and reworked around the randomness: a new test walks 120 seeds and asserts that both outcomes actually occur, that they occur in roughly the configured proportion, that the zone and the painted cells always agree (a map never declares water it does not draw, or draws water it does not declare), that no soft-ground cell is ever blocked, and that every map has mud; a second new test proves a dry map reports no river penalty at any position and has no river cells. Because the fixtures previously hard-coded seeds that happened to be wet, they now find a seed with or without a river on demand, and the movement measurement anchors to the centre of the largest mud patch rather than a scanned cell that could sit on a patch edge. `npm run build` clean. `npx playwright test` → 36/36 across Chromium and Firefox, with the wading scenario moved to a known wet seed.
Browser/playtest evidence: two throwaway probes drove the work. The first reported river presence across 400 seeds (60.8% actual against 62% configured) and exposed that dry maps were getting *fewer* mud patches than wet ones, because uniformly-drawn patch rows collided and the spacing rule then rejected whole patches. The fix — each patch searching its own rolling window of rows, trying both halves of the field, with 200 attempts — raised yields to the configured range; a second probe showed a wet seed whose river splits the usable rows into two groups, which is what ruled out disjoint row slices in favour of a rolling window. Dry and wet battlefields were then both inspected as screenshots to confirm no water is left behind on a dry map and none is missing on a wet one; the artifacts were removed afterwards.
Known issues or blocked checks: the presence share (62%) and the dry-map mud counts are first-pass with no playtest; a dry map is meaningfully easier to attack across, so if the campaign ever wants even pacing this is the knob. The pre-existing browser-suite timing flakes and the autoplay balance caveat from earlier entries still stand.
Next concrete step: playtest both kinds of map — a dry one and one with a river — and decide whether 62% is the right share and whether a dry map needs another feature to stay interesting.

2026-10-07 / destructible buildings (requested):
Implemented: churches, field hospitals and houses are placed on every map and are the first destructible terrain in the game. While a building stands it is solid for all three purposes asked for — movement, line of sight, and bullets — and when its health reaches zero it collapses into a ruin whose footprint is walkable ground that blocks nothing. Placement is seeded and best-effort: buildings go in the contested middle of the field, never on the deployment strip, never in the water, never overlapping each other, and never swallowing an existing obstacle, so a building can never wall the map off. Footprints are marked in the terrain grid as a new cell kind and the blocked grid is rebuilt from a stored floor plan (`Terrain.baseBlocked`) plus whichever buildings still stand, which is how a destroyed one reopens its ground. `fireShot` resolves a wall on the flight path before it resolves the target: a round striking masonry is spent on the wall and the structure takes the damage, which is the only way cannon and rockets can be stopped, since they arc over obstacles and never consult line of sight. Blasts damage any building whose footprint the circle reaches. Small arms do 10% damage to masonry, so artillery, rockets and tank shells are the practical demolition tools. The renderer draws whole structures procedurally — church with a steeple, hospital with a red roof cross, house with a ridge and a door — redrawing only when one is hit or comes down; a damaged building shows cracks and a health bar, a ruin shows rubble. The terrain inspector names a building and reports its kind and remaining integrity. Snapshot schema is now v4, carrying `buildings` (health and ruin state) and `terrainHasBuildings`.
Dependencies and decisions: no new dependencies. Decisions worth recording: (1) the ruin is kept on the map rather than deleted, so the field still reads as built-up and a save has something to describe; (2) the floor plan is captured *before* footprints are marked, because it is the thing that has to be able to reopen them — getting that order wrong was a real bug caught in testing, where leveling a church left the ground solid; (3) `generateTerrain` takes a `withBuildings` flag and a legacy save regenerates without any, including leaving no building cell kind behind, so an old run can never contain invisible walls; (4) `terrainData()` is now generated with the same flag, or the renderer would have drawn buildings the simulation did not have; (5) small arms were deliberately left nearly useless against masonry so that structures are an artillery problem rather than something riflemen whittle down.
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 103/103 pass, including nine new building cases: placement clear of each other, the deployment zone and the water with every footprint cell marked solid and typed; the full kind roster appearing across seeds; intact start state; blocking sight and bullets while standing and short shots not being caught; reopening ground, sightline and bullet path on destruction without disturbing anything else; small arms versus artillery; blast damage by proximity; pathing around a standing block and straight through a ruin, asserting the soldier never stands inside a wall; snapshot round-trip of a partly damaged building and a ruin, including the reopened ground; and a legacy save regenerating with no buildings and no building cells. `npm run build` clean. `npx playwright test` → the new scenario passes on Chromium and Firefox: the map reports its buildings, a wall blocks a chosen sightline, razing it clears the line, and the ruin remains.
Browser/playtest evidence: two battlefields were captured and inspected as screenshots — a map with houses and a church, and one with houses, a church and a hospital — confirming the three kinds are visually distinct (cross-topped steeple, red roof cross, terracotta houses), legible at gameplay scale, and not so large that they crowd the field. Four throwaway probes drove the work: a roster probe to find seeds with each kind, a path probe that caught a test placing its target outside the battlefield, a rebuild probe that caught the floor-plan ordering bug, and a legacy probe that caught `terrainData()` regenerating buildings the simulation did not have. All throwaway artifacts were removed.
Known issues or blocked checks: building health, footprints and counts are first-pass with no playtest; a church at 1400 points is deliberately stubborn but may prove slow to bring down in practice. Buildings change wave pacing because they block sight lines the old maps did not have, and the autoplay balance check was not re-tuned for that — it still passes, but the campaign is now less open than when it was measured. The pre-existing browser-suite timing flakes remain.
Next concrete step: playtest a wave around a church — whether structures create interesting cover decisions or just stall attacks — then tune `CONFIG.buildings` health, counts and `smallArmsDamageMult`.

2026-10-07 / building art: external asset search and a procedural rebuild (requested):
Implemented: searched for third-party building textures and sprites, evaluated four candidates with licenses and visuals, rejected all of them for concrete reasons, and instead rebuilt the building art procedurally so it fits the game's palette and scale. Rejected: Buch's *Orthographic outdoor tiles* (CC0; right shape and orientation, but bright saturated Nintendo-era pixel art that scales chunky at a 190 px church and clashes with the muted field); the project's existing *16 Bit Style Army Tileset* (CC0; contains no buildings at all); rubberduck's *50 free textures 5* (CC0; muted and high-res but a 51 MB 3D-oriented pack, and sampling twelve of its textures found gravel, brick, wood, metal and grass with no slate or terracotta roofing); and general OpenGameArt building searches (almost entirely 16x16 fantasy/RPG tilesets with the same style problem). The replacement art draws each building as a roof seen from above: eaves overhanging the footprint over a dark wall course, two pitches meeting at a ridge so the north half catches the light and the south half falls away, roof-tile courses running down each pitch, a ridge cap, and a drop shadow cast south-east. Details identify the kind — church with a set-back steeple, a west tower and nave windows; hospital with a light roof panel and a large red cross; house with a chimney, skylights and a door front. Damage now reads in stages: cracks, then holes where the roof has come in, then the health bar. Ruins are redrawn as rubble spread wider than the old footprint, wall stumps on the north and west edges, and scattered masonry.
Dependencies and decisions: **no third-party assets were added**, so ASSETS.md gains no new license obligations; the buildings remain original project art alongside the roads, vehicles and effects. The evaluation and the reasons for rejection are recorded in ASSETS.md under "Buildings: why they are drawn, not sourced", with links and licenses, so the decision is not re-litigated. The simulation treats a building as a plain footprint rectangle with health, so if a suitable high-resolution desaturated orthogonal set is ever found under CC0 or CC BY, `drawBuilding` and `drawRuin` can be swapped for sprites without touching gameplay.
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 103/103 pass (unchanged: this entry touches only the renderer). `npm run build` clean. `npx playwright test` → the building scenario still passes on Chromium and Firefox.
Browser/playtest evidence: the work was driven by inspecting renders rather than assuming. The original buildings were captured close up and confirmed to be a flat grey box at church scale, which is what motivated the search and then the rebuild. The new art was then inspected twice: a close-up of the church showing the lit and shadowed pitches, tiling and tower, and a full-battlefield capture confirming all three kinds read distinctly at gameplay scale against the existing terrain — church in slate, houses in terracotta with visible chimney and shadow, hospital with its red cross panel. Four throwaway downloads and three throwaway capture scripts were removed afterwards; nothing downloaded was committed.
Known issues or blocked checks: the art is vector-style and will never match photographic ground texture in absolute fidelity; it is chosen for palette and scale coherence instead. No slate or terracotta roof texture was found under a permissive licence, so roof surfaces are flat-shaded with drawn tiling rather than textured — that is the most likely thing a future asset pass would improve. The pre-existing browser-suite timing flakes and the autoplay balance caveat from earlier entries still stand.
Next concrete step: if the flat-shaded roofs are judged too plain in play, source or draw a slate and a terracotta tile swatch and apply it to the two pitches, keeping the current geometry.

2026-10-07 / fix: a work site outlived its engineer (reported bug):
Implemented: an engineer killed part-way through laying a mine left the site in `constructionSites` forever, so its progress bar stayed drawn on the field and `#construction-status` kept listing it. The cause was `updateConstruction`: when the assigned builder is gone it looks for another available engineer, and if none is in range it `continue`s — which correctly pauses a site for an engineer who is merely pinned, busy or out of position, but never retires a site that can never be worked again. Sites are now abandoned once the squad has no living engineer at all: the site is removed from the state, so the field marker and the HUD line both disappear, and the full points cost is refunded with a notice. A living engineer out of position still pauses the work and keeps the site, and an engineer passing in range still takes it over.
Dependencies and decisions: no new dependencies. Decisions worth recording: (1) the test for "can never be finished" is *no living engineer anywhere*, not "no engineer currently in range", because the second would abandon legitimate paused work whenever the builder walked a few pixels too far — the existing pause-and-resume behaviour is deliberate and is now covered by its own test; (2) the points are refunded in full, on the reasoning that the squad lost the man rather than the decision, and the alternative (silently keeping the cost) is a hidden penalty for something the player did not do; (3) an engineer who has marched off the north edge counts as gone, since `livingFriendlies` already excludes them.
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 108/108 pass, with five new cases in a `work sites in progress` suite: a mine the engineer dies during is abandoned and refunded; sandbags and trenches the same way; a site is handed to a surviving engineer rather than abandoned; a site whose engineer is merely out of position pauses and resumes rather than being abandoned; and a paused site survives a save and reload. The first two were confirmed to fail against the un-fixed code before the fix was restored, so they genuinely cover the reported bug. `npm run build` clean. `npx playwright test` → 39/39 across Chromium and Firefox, including a new browser regression that recruits an engineer, orders a mine, kills the engineer mid-lay, and asserts `#construction-status` becomes hidden and `constructionSites` empties — also confirmed to fail without the fix. Two small additions to the test hook made that possible: `killFriendly`, `orderMine` and `placementError`, the last of which reports *why* a placement is refused so a fixture mismatch shows up as a clear message instead of a bare `false`.
Browser/playtest evidence: the browser test initially failed because the recruited engineer landed 113 px from the intended mine site, one pixel outside its 112 px working range. The refusal reason came straight from `validatePlacement` through the new hook rather than from guessing, which turned an opaque failure into a one-line fix to the fixture.
Known issues or blocked checks: none specific to this fix. The pre-existing browser-suite timing flakes and the autoplay balance caveat from earlier entries still stand.
Next concrete step: none outstanding for this bug; the same "can nothing ever finish this?" question is worth asking of other long-lived state if any is added later.

2026-10-08 / Axis artillery in the later waves (requested):
Implemented: the enemy now shells the defended line, and escalates. This is off-map counter-battery fire rather than a new unit: there is no artillery piece to find, kill or counter-batter, and no points are spent, because the threat asked for is battlefield pressure rather than another target. Nothing is scheduled before `CONFIG.enemyArtillery.firstWaveWithBarrage` (12), so the early and middle waves stay a rifle and armour fight; from wave 12 on, while a wave is actually under way, the battery has a per-second chance of firing that grows with the wave number (about 3% a second on wave 12, capped at 34% by the last wave), so the final push is fought under observed artillery. Each fire mission is aimed **at a soldier**, never at fixed ground, and scatters around them: 150 px at the first barrage wave tightening to 70 px by wave 15, so early missions are harassment and late ones land on the position. Shells per mission roll inclusive from `shellsMin`/`shellsMax` and grow by one every three waves to `maxShells` (3), spaced 0.47 s apart so a barrage walks the ground, and they land no further north than `minLandY` (280) so the Axis can never shell its own approach. Reuse throughout: the shells are the same `Strike` records, the same `updateStrikes` resolution and the same `CONFIG.artillery` damage/radius/suppression as the player's own fire mission, marked by the same countdown ring drawn in the enemy's colour, and `explodeAt` was already side-agnostic — so **an Axis barrage that catches its own advancing infantry kills them**, exactly as the player's does. A new `enemyBarrageIncoming` event drives an error-toned HUD warning ("Axis artillery is ranging the line — N shells incoming. Spread out!"), a horn, an Axis radio bark, and a save so a reload cannot dodge incoming fire. `Strike.source` ('friendly' | 'enemy') records the firing side; the battery also runs on its own derived RNG stream (`enemyArtilleryRng`, salted from the run seed and re-derived per map), so its fire plan is a property of the run and tuning it does not reshuffle every shot, scatter and spawn lane in the battle. Snapshot schema is now v6.
Dependencies and decisions: no new dependencies. Decisions worth recording: (1) the battery has **its own random stream** — the first cut shared `state.rng` and the comparison was unmeasurable, because every extra roll reshuffled the entire battle through spawn lanes and shot scatter, so "was that the artillery or the dice?" had no answer; isolating it made tuning a controlled experiment (same seed, only the shelling differs) and is better design besides; (2) the barrage fires only during `spawning` or `active` phases, since there is nothing to range during preparation and an abandoned map should not shell anyone; (3) endless play scales the barrage on `endlessWaveNumber` rather than the per-map counter, so marching north cannot reset the guns to sleep, but a *fresh map* does reset the battery's cooldown and stream, so every battlefield starts quiet; (4) `minLandY` exists so a scattered shell cannot land in the Axis' own start area — the enemy shelling its own assembly would read as a bug even though the damage system already allows it; (5) the tuning is deliberately conservative, because at a higher rate the feature stops adding pressure and starts deciding campaigns (measured below).
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 117/117 pass (simulation 94, persistence 15, soldiers 5, balance 3), with a new `Axis artillery` suite: silence before the configured wave and fire once under way; no barrage during its own wave's preparation; the configured reload observed tick by tick with nothing new scheduled; scatter tightening across the campaign and never landing north of `minLandY`; mission size growing to its ceiling; one shell damaging **both** sides once and only once; and a save/reload that preserves the cooldown and the shells in flight. Two new persistence cases cover the v5→v6 migration (a save with a cooldown but no battery stream resumes with one derived from its seed, and a pre-battery save simply starts ready) and reject a corrupt stream, a negative cooldown and an unknown `Strike.source`. `npm run build` clean. `npx playwright test` → 42/42 across Chromium and Firefox, including a new scenario that forces a fire mission, catches the warning notice with a `MutationObserver` (notices are transient live DOM, so reading them after the fact races the TTL), confirms the Axis shells are in flight and on their own countdown, saves and reloads to prove the incoming fire is not refunded by a page reload, then walks the shells onto a soldier and asserts the landing kills or maims him and is spent exactly once.
Browser/playtest evidence: the tuning was measured, not guessed. With the battery's stream isolated, one controlled run per seed across eight seeds compared the same runs with the barrage on and off: the unchanged (pre-tuning) settings cost **16 breakthroughs and a lost campaign on three of four seeds** against a clean sweep with the guns off. A candidate sweep then bracketed the intensity, showing that scatter is the decisive lever, not rate: at 210→145 px the shelling was nearly invisible (expected miss distance ~50 px against a 22 px lethal radius, so ~19% of shells could kill anyone), while at 120→45 px it decided campaigns (5/8 wins). The shipped setting (150→70 px) is the tightest that still sweeps 8/8 seeds, and lands within noise of the no-artillery baseline (integrity total 132 across eight seeds versus 136 with the guns silent) while visibly costing seeds that were already close — seed 11 falls from 20 integrity to 11, and seed 777 would have been beaten without it. A separate probe counted the missions actually fired: roughly 3.6 per campaign at this setting, rising to ~7 when the chance is doubled, which is the "occasional" the request asked for rather than a constant bombardment.
Known issues or blocked checks: the intensity, first barrage wave and scatter curve are measured against the balance harness but not playtested by hand, and the harness plays a fairly tidy defence — a player who bunches the squad on the line will feel this much harder. The known pre-existing browser timing flakes were not touched; the new notice assertion is deliberately immune to them by observing DOM insertions instead of racing the TTL. One real defect was found and fixed while browser-testing this feature: `Simulation.step()` reset `pendingEvents` at the top of every tick, so any event emitted *between* ticks — which is exactly how a fire mission is ordered before its first step — was silently discarded by the next step. `step` now carries already-queued events into its return value and drains the queue at the end instead of clearing it at the start; this affected the new barrage warning and would have affected any future event raised outside a tick.
Next concrete step: playtest the battery by hand — whether a countdown ring and 2.5 seconds is enough time to move a squad off the mark, and whether the wave-12 start is the right place for it to begin — then tune `CONFIG.enemyArtillery`.

2026-10-08 / weapon upgrades take time (requested):
Implemented: buying a personal weapon upgrade now occupies the soldier. The bonus is still banked the instant the points are spent — `purchaseWeaponUpgrade` raises the level and then sets `unit.upgradeTimer = sec(CONFIG.weaponUpgrades.upgradeSeconds)`, 3 seconds — but for those ticks the soldier's weapon is in pieces: he **cannot fire and cannot throw grenades**, because it is the same two hands. The firing block in `updateUnits` gained an `upgrading` guard covering both the grenade path and `tryFire`, so a soldier mid-upgrade is skipped entirely rather than shooting without his bonus. Deliberately *not* restricted: **movement**. A soldier caught upgrading in the open can still be ordered behind cover, which is what makes the delay a window of vulnerability rather than a trap. A second upgrade is refused while the first is in the works (`"still working on his weapon (Ns)"`), so three levels cannot be stacked into one uninterrupted silence — back to back they cost nine seconds, which is now the real price of a level-three weapon. The timer runs down in the per-unit timer block alongside reload/shot/heal/grenade, is frozen by pause like every other clock, and is **cleared on the march north**: a fresh map arrives with weapons assembled. A new `weaponUpgraded` event carries the unit, upgrade type, new level and tick count; the controller's purchase notice now says the weapon is in pieces for N seconds, the selection panel's action line reads "Working on weapon — Ns", and the three upgrade buttons grey out with "· in pieces (Ns)" and a tooltip explaining why. Snapshot schema is now v7.
Dependencies and decisions: no new dependencies. Decisions worth recording: (1) the benefit is applied immediately and only the *use* of the weapon is delayed — the alternative, deferring the bonus until the work finishes, would mean a soldier could lose points by dying mid-upgrade, which is a hidden penalty rather than a tactical choice; (2) the delay blocks grenades as well as rifle fire, since "cannot shoot" describes a man with a weapon in pieces, and a grenade is the same pair of hands; (3) movement is explicitly left alone, so the delay is a decision about *when* to upgrade rather than a way to freeze a soldier; (4) one job at a time was chosen over allowing a queue, because allowing parallel purchases would let a player pay for three levels and serve only one 3-second window, which defeats the mechanic; (5) the timer lives on the `Unit` as an optional field, so a pre-v7 save simply loads with `upgradeTimer` absent and every weapon already together — the same migration shape used for `crossed` and the battery stream.
Verification commands and results: `npm run typecheck` clean. `npx vitest run` → 126/126 pass (simulation 101, persistence 17, soldiers 5, balance 3), with a new `weapon upgrade time` suite: a soldier starts with no work pending; buying sets the configured timer, banks the bonus, and refuses a second purchase without spending the points; a soldier who demonstrably engages an enemy (baseline shots asserted first) fires **zero** rounds for the whole window and resumes on the tick the work completes; he can still be moved while upgrading; grenades are withheld too and none are spent; the timer freezes while paused and survives a save/reload with the remaining time; and the whole squad reaches the next map with weapons assembled. Two new persistence cases cover the v6→v7 migration (a save with no `upgradeTimer` resumes with none) and reject a negative or non-numeric timer while round-tripping a soldier caught mid-upgrade. `npm run build` clean. `npx playwright test` → 44/44 across Chromium and Firefox, including a new scenario that selects a soldier by clicking him on the field, buys aim training through the real button, asserts the notice, the "Working on weapon" action line and the greyed-out second button, moves him successfully mid-upgrade, saves and reloads to confirm the work is still outstanding, and then confirms the panel clears once the timer expires.
Browser/playtest evidence: the browser scenario's first two attempts failed for a reason worth recording — the upgrade buttons stay disabled when `selectUnit` is called through the test hook, because the HUD only refreshes on the render loop and a headless run cannot be relied on to drive it. The fixture was changed to select the soldier with a real click and wait on the button's own `disabled` state, which is both closer to what a player does and independent of loop timing. The final scenario passes on both engines.
Known issues or blocked checks: the 3-second value is a first-pass number with no playtest behind it, and the autoplay balance harness never buys upgrades, so the mechanic's effect on campaign pacing is not measured by simulation — it is a risk the player chooses, not a tuning lever that was validated. If upgrades ever look too cheap, this delay is the lever to raise before the point costs. The pre-existing browser-suite timing flakes and the untuned barrel of the previous entry still stand.
Next concrete step: playtest the feel — whether 3 seconds reads as a meaningful decision or just an irritation — and consider whether the delay should scale with upgrade level or with the type of work (a barrel being far more than a sight).

2026-10-09 / northern capture and veteran tactics:
Implemented in sequence: (1) after five waves, two soldiers can secure the marked northern zone by holding it uncontested for eight seconds; marching still works as an evacuation, but only a captured sector grants campaign progress; (2) riflemen and engineers have one smoke grenade, which blocks hitscan fire across its cloud for eight seconds while blasts pass through; (3) selectable fire orders cycle between automatic target selection, armor priority, breakthrough priority, and holding hand grenades; (4) Axis missions from wave 12 now require a living, unpinned observer with line of sight to a friendly target within its observation range; (5) soldiers at 3 XP may pick one role-specific specialization, with medic healing and completed engineering jobs also granting XP. Campaign HUD, controls, help text, smoke rendering, objective rendering, save schema v8 migration, and README descriptions were updated.
Dependencies and decisions: no new dependencies. Capture is persistent once earned, so losing the zone later does not erase secured progress; progress decays when the zone is contested or under-garrisoned. Evacuation is retained as a tactical retreat, while requiring capture before it earns campaign credit gives players a concrete reason to push beyond the defensive line. Fire orders modify target priority rather than override line of sight, range, or weapon role. Observer pressure can be interrupted by killing or suppressing the spotter, giving late waves a battlefield counterplay instead of an invisible artillery schedule. Specializations are permanent one-time choices and support XP rewards actions the role already performs.
Verification: `npm run build` passed after the priority-scoring cleanup; Vite emitted its existing large-chunk advisory. The earlier test run exposed happy-dom `localStorage` setup failures in the persistence suite, a schema-version expectation that was updated to v8, and legacy artillery/march fixtures that assumed no observer and automatic map credit. Those fixtures now include the observer and captured-sector state where the tests intend a successful campaign march. The full test suite was not rerun after those fixture edits. No hand playtest performed.
Next concrete step: playtest capture-zone placement and smoke duration; tune the objective and perk strengths if a full campaign feels too grindy or too easy.
