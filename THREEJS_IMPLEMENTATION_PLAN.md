# Three.js implementation plan for Last Line

Convert the existing Phaser battlefield into a genuine 3D top-down battlefield using Three.js, while preserving the current game mechanics, content, controls, interface, audio, and saves. This is an execution handoff for an implementing agent. Complete the milestones and their acceptance checks in order; a primitive demo is an intermediate milestone, not the finished conversion.

Prepared on October 16, 2026 for `D:\GitHub\mud`. Inspect the workspace again before editing. This plan authorizes no deployment or unrelated gameplay redesign.

## 1. Sources of truth and scope

The current implementation defines behavior. Read `src/simulation/`, `src/content/`, `src/game/controller.ts`, `src/persistence.ts`, and the existing tests before changing integration code. The older `PLAN.md`, README, and asset descriptions contain historical defaults that can differ from current code. Do not restore those defaults. For example, read the campaign length and squad composition from current configuration rather than copying a number from documentation.

Keep these unchanged in behavior:

- The 960 by 720 logical battlefield and 30 ticks per second simulation, including accumulator limits, interpolation, seeded randomness, targeting, navigation, terrain effects, combat, friendly fire, suppression, morale, and line integrity.
- All friendly roles, enemy archetypes, weapons, personal upgrades, veteran specializations, fire orders, standing/crouching/prone postures, crawling, and vehicle headlights.
- Recruiting, formations, engineer construction and interruption, sandbags, trenches, bunkers, mortar pits, built bridges, both mine types, smoke, flares, artillery, air support, food supply, and enemy barrages.
- Every campaign country, generated landscape, road and river orientation, tributary, bridge type, building kind, destruction state, weather intensity, and day/night transition.
- Capture, crossing north, map transitions, supply choices, endless mode, defeat, victory, reports, roster identities, and service records.
- Pause and command gating, visibility auto-pause, title and settings screens, map review, restart, sound, accessibility, and resumable saves.
- Left-click, Shift-click, drag selection, right-click orders, Escape, Space, tooltips, and valid/invalid placement feedback.

Exclude new mechanics, a physics engine, navigation replacement, React, a UI redesign, a backend, multiplayer, editor tooling, free camera controls, and WebGPU migration. No Rapier dependency is needed: the simulation already owns collisions and damage, and visual height introduces no gameplay physics.

Do not modify gameplay tuning, RNG, persistence schema, or storage keys to accommodate rendering. Engine objects and cosmetic state must never enter saves. Small controller/UI edits for typed renderer integration and screen projection are expected.

## 2. Inspected architecture and baseline

| Existing area | Responsibility | Migration action |
| --- | --- | --- |
| `src/simulation/`, `src/content/` | Gameplay, terrain generation, content, RNG | Preserve |
| `src/game/controller.ts` | Fixed-step loop, commands, selections, orchestration | Keep; depend on a renderer interface |
| `src/game/render.ts` | Phaser drawing, preview types, effects | Replace implementation; extract public types first |
| `src/game/BattleScene.ts` | Phaser asset loading, pointer forwarding, frame callback | Replace with one browser runtime |
| `src/main.ts` | DOM wiring and Phaser startup | Replace startup and layout integration |
| `src/ui/`, `index.html`, `src/styles.css` | HTML interface and tooltip positioning | Preserve structure; adapt projection and canvas sizing |
| `src/game/audio.ts`, `src/game/radio.ts` | Existing Web Audio and speech/recorded chatter | Preserve |
| `src/persistence.ts` | Versioned localStorage and save validation | Preserve |
| `src/e2e-hook.ts`, `tests/`, `scripts/` | Test fixtures and verification | Preserve scenarios; replace renderer-specific assumptions |

The evaluation run reported 151 logic tests: 123 passed and 28 failed, with typechecking passing. Failures included persistence/localStorage setup, weather, landscape connectivity, terrain/building assertions, and balance. These are historical observations, not a waiver or a current baseline. Re-run before implementation, capture individual failures and runtime versions, and compare against that result. Browser checks were not established by that evaluation.

Git commands previously reported that this directory was not a Git repository. Recheck; do not create/reset a repository or assume branches/commits exist. Preserve unrelated files and work. If Git is unavailable, save a focused baseline copy or hashes of the files to be modified and preserve reference screenshots outside shipped assets.

## 3. Locked implementation decisions

### Rendering and visual direction

- Use plain Three.js with TypeScript and existing Vite. Start with `WebGLRenderer` and WebGL 2; retain static deployment and `base: './'`.
- Resolve compatible stable `three` and `@types/three` versions at implementation time, install exact versions, and retain the lockfile. Do not upgrade unrelated dependencies. Check documentation against the installed release.
- Use real geometry for soldiers, vehicles, buildings, roofs, trees, and fortifications. Ground textures, smoke, markers, and particle billboards are appropriate; a textured flat battlefield or upright sprite replacements alone do not satisfy 3D completion.
- Match the current muted European WWII palette, country-specific scenery, team recognition, and compact tactical presentation. Keep existing HTML panels and labels.
- Default to complete, locally generated stylized geometry with articulated unit parts. This provides a finishable asset path without waiting for external models. Procedural geometry must still have recognizable silhouettes, weapons, stances, and animation. If suitable licensed GLBs improve the result, use a manifest and retain the procedural fallback; record provenance in `ASSETS.md`.
- Begin with standard materials, one hemisphere/ambient contribution and one directional sunlight source. Limit shadows to useful objects. No mandatory bloom, SSAO, expensive reflections, or shadow-casting light per unit.

### Coordinates and camera

Keep simulation positions and distances in existing logical pixels. Introduce one shared conversion module:

```text
scale = 1 / 24 Three.js world units per simulation pixel
world.x = (simulation.x - CONFIG.field.width / 2) * scale
world.y = visual height
world.z = (simulation.y - CONFIG.field.height / 2) * scale
```

The battlefield is therefore 40 by 30 world units at the current configuration. Read dimensions from `CONFIG`; the conversion factor is a presentation constant, never a simulation change. Root pivots sit at ground contact. Normalize any loaded models to this convention. Document their local forward direction and centralize heading conversion; verify north/east/south/west facing rather than scattering angle corrections.

Use a fixed orthographic camera south of the field, looking north and down at approximately 70 degrees above the ground. No yaw or roll: simulation north stays at screen top and east at screen right. A modest pitch adjustment for readability is acceptable; keep the final view fixed. Fit the entire ground rectangle, deployment strip, capture area, exit band, and reasonable building height allowance inside the camera. Preserve the existing 4:3 game container and letterbox rather than stretch or crop. No orbit, pan, zoom, or perspective controls in this scope.

Because the camera has no yaw, screen-aligned ground rectangles still map to the existing selection rectangles. Test the result rather than assuming the old canvas fraction calculation remains valid. Tall scenery can obscure units even with this camera: use modest heights, readable ground markers, and local roof/canopy fading when needed. Occlusion treatment is cosmetic and must not change detection, line of sight, or selection eligibility.

### Ownership and timing

- The controller remains the sole owner of simulation stepping, accumulated time, selection, and command validation. Three.js never runs a second simulation or clock.
- The runtime owns exactly one animation-frame loop. It calls `controller.frame(deltaMs)` once per frame. Rendering happens through the renderer port; do not also render a second time in the runtime.
- Preserve `prevPos` interpolation and current facing/emplacement presentation helpers. Animation follows gameplay; animation callbacks never fire bullets, finish construction, or apply damage.
- Keep render clocks separate from simulation ticks. Match the current pause behavior for effects, river flow, weather, and shake; establish it from the old renderer. Reloads restore durable visual state from simulation data, not from a history of events.
- Use a separate derived RNG for scenery and cosmetic effects. Never advance `state.rng` or the enemy artillery RNG from rendering.

## 4. File layout and interfaces

Use the following modest module split. Equivalent names are acceptable if ownership stays clear; do not move existing simulation or UI modules for cosmetic organization.

```text
src/game/render-contract.ts          RendererPort, PreviewInfo, DragRect
src/render/BattleRenderer3D.ts       Implements the existing render lifecycle
src/render/app/BattleRuntime.ts     Canvas, RAF, resize, lifecycle, context events
src/render/app/coordinates.ts       Simulation/world/client conversions
src/render/app/camera.ts            Fixed camera and fit calculation
src/render/app/input.ts             Pointer forwarding and capture
src/render/app/resources.ts         Ownership and resource disposal
src/render/objects/terrain.ts       Ground, roads, fields, rivers, crossings
src/render/objects/scenery.ts       Vegetation, fences, rocks, country dressing
src/render/objects/buildings.ts     Standing/damaged/ruined structures
src/render/objects/units.ts         Infantry, vehicles, stance and animation
src/render/objects/fortifications.ts Construction, cover, mines, built bridges
src/render/effects/combat.ts        Tracers, shells, blasts, impacts, marks
src/render/effects/environment.ts   Weather, water motion, day/night, illumination
src/render/overlays.ts              Selection, bars, zones, previews, warnings
src/render/assets.ts                Optional model/texture manifest and factories
```

Extract `PreviewInfo` and `DragRect` from the existing renderer without narrowing their fields. Define the port around the methods the controller already uses:

```ts
interface RendererPort {
  rebuildStatic(state: SimState, terrainData: TerrainData): void;
  handleEvents(state: SimState, events: readonly SimEvent[]): void;
  frame(
    state: SimState, alpha: number, preview: PreviewInfo | null,
    selection: readonly number[], dt: number, drag?: DragRect | null,
  ): void;
  shake(magnitude: number, duration: number): void;
  getShakeMagnitude(): number;
  destroy(): void;
}
```

Import the existing simulation types; this is not a new state model. Treat the entire state and nested collections as read-only by contract, even where current TypeScript types are mutable. Avoid widespread type refactors just to express deep immutability.

The runtime exposes typed `worldToClient(pos, height?)`, `clientToWorld(clientX, clientY)`, readiness, and bounded renderer diagnostics for integrations/tests. Here `world` in these two public names means logical battlefield coordinates; document that clearly or name them `simulationToClient` and `clientToSimulation` consistently. Results use viewport CSS pixels, never drawing-buffer pixels. Return null for points outside the usable battlefield or an unavailable canvas. The controller and HUD must not import Three.js.

Keep the existing Phaser renderer runnable until the Three.js path has a complete vertical slice. A development-only switch is acceptable during migration. Final production defaults to Three.js and removes the old runtime/dependency; do not maintain two shipping engines.

## 5. Ordered milestones

### M0 Record behavior and prepare the baseline

- [ ] Inspect current files and applicable `AGENTS.md` instructions; preserve changes since this plan.
- [ ] Run the baseline commands in section 7. Record Node/npm versions and each failure, including browser availability and WebGL capability.
- [ ] Capture reference views of title, normal combat, placement, a river crossing, standing/ruined buildings, night, severe weather, and narrow layout using deterministic seeds or existing hooks. Use actual generated features rather than assuming a seed has a river.
- [ ] Save representative current snapshots, including a damaged building, in-progress construction, night/flare/headlight state, and a pending barrage. Preserve the original save text for comparison.
- [ ] Inventory the current `Command`, `SimEvent`, `UIMode`, `PreviewInfo`, terrain kinds, role unions, building kinds, and persistent collections into a coverage table in the execution log. Mark how each is presented in 3D.

Gate: baseline results and fixtures exist; the agent can explain the current behavior without relying on historical documentation.

### M1 Extract the renderer boundary without changing behavior

- [ ] Add `render-contract.ts`; make the controller depend on `RendererPort` and move preview/drag imports there.
- [ ] Adapt the existing renderer to the port, including the public shake getter. Change `screenShake()` in `src/e2e-hook.ts` to use that getter instead of reading the private `shakeMag` field.
- [ ] Keep Phaser as the active renderer for this milestone. Run typechecking and relevant existing tests.

Gate: the existing game works through the port with no changed simulation outcomes or UI behavior.

### M2 Establish a playable Three.js vertical slice

- [ ] Add Three.js dependencies and the runtime, camera, coordinate conversion, resource ownership, and 3D renderer.
- [ ] Create one canvas under `#game`. Use the live host dimensions, a capped device pixel ratio of at most 2, and renderer sizing that does not create resize feedback loops. Observe the container; handle zero/hidden dimensions and changed pixel ratio.
- [ ] Provide a fixed fitted camera, a lit ground plane, a few actual 3D scenery objects, and selectable articulated 3D infantry. Reuse the current simulation and controller.
- [ ] Initialize the renderer before enabling play; call `attachRenderer` and `boot` in a controlled order. Title-screen terrain and map-review terrain must render even with no active run. The current `controller.frame` returns early when `sim` is null because Phaser draws independently; provide a render-only path for the retained title presentation, including after `quitToTitle`, so a resize cannot leave a cleared canvas. This path never steps gameplay or sends gameplay events.
- [ ] Keep one RAF loop through restart, title return, and map review. Reset elapsed-time bookkeeping after background suspension so returning never fast-forwards a battle.
- [ ] Handle renderer initialization failure with a useful DOM message. On WebGL context loss, pause through the controller and preserve saves; on restoration rebuild as needed, reset timing, and leave resuming under the existing Resume action.

Gate: New Game, Continue, pause/resume, recruitment, selection, right-click movement, automatic shooting, and return to title work on the Three.js path. No simulation module imports Three.js or browser APIs.

### M3 Finish input and all projected UI

- [ ] Convert `clientX/clientY` using the current canvas bounding rectangle, normalized device coordinates, the camera, and ray intersection with the ground plane. Apply the exact inverse coordinate conversion. Do not raycast decorative roofs/water to determine movement coordinates.
- [ ] Keep placement and right-click commands in logical coordinates and use existing controller validation. Reject out-of-field presses without clamping them into valid orders. During an active drag, retain a defined outside-release mapping so pointer-up always completes/cancels the gesture.
- [ ] For clicks on raised friendly geometry, allow a renderer-only unit hit proxy. If needed, add an optional resolved friendly ID to `pointerLeft` while retaining the actual ground coordinate as the drag origin. Validate eligibility and execute selection in the controller using its existing replacement/Shift-toggle semantics. Placement modes ignore this ID. Preserve ground-radius fallback selection and never let scenery or smoke intercept commands.
- [ ] Preserve drag threshold, selection margin, additive drag, release outside canvas, right-click cancellation, and keyboard behavior. Use pointer capture with button tracking; pointer cancel, blur, lost capture, and teardown clear unfinished gestures without issuing an order. Do not duplicate events through both canvas and window listeners.
- [ ] Update terrain-tooltip positioning in `src/ui/hud.ts`: it currently uses logical-coordinate fractions. Inject a projection callback, convert viewport coordinates into tooltip-parent coordinates, clamp to the parent, and hide if projection is unavailable. Keep tooltip contents and inspection rules unchanged.
- [ ] Make placement ghosts, ranges, engineer links, capture/deployment/exit zones, selection rings, health/suppression/pin feedback, and the drag rectangle share the camera and coordinate conversion. Use intentional depth/render order so they stay legible without z-fighting. Decorative layers must not receive pointer events.
- [ ] Add projection/readiness methods to the test-only hook. Replace `__lastlineGame.scale.canvasBounds` and every hard-coded canvas fraction in `tests/browser.spec.ts`, including the narrow-viewport test. Use `worldToClient` for real mouse clicks and drags, not controller calls that bypass input. Update any affected scripts.

Gate: actual mouse interaction is aligned at desktop and 800 by 900 viewports, after scrolling, after HUD layout changes, with browser zoom/high DPI, and near all battlefield edges. Ground projection round-trips within one logical pixel when shake is disabled. Body-click selection and drag selection work in all stances.

### M4 Port complete terrain and structure presentation

- [ ] Consume `TerrainData` and existing terrain helpers. Preserve the shape and placement of roads, junctions/roundabouts, fields, rivers, diagonal/vertical channels, branches, rapids, natural and built bridges, and irregular mud. Never regenerate a second terrain layout inside the renderer.
- [ ] Cover every `TERRAIN_KIND` and existing landscape version, including passable foliage, low fences, crops, orchards, rocks, obstacles, and ruins. Visual density and ground footprint must communicate the actual traversal rules. Keep river/mud beds visually shallow so flat-plane navigation remains credible.
- [ ] Render every current building kind and country variation. Use simulation building IDs/health/destruction for standing/damaged/ruined state. Skip building footprint cells when placing generic scenery. A destroyed building immediately becomes low rubble with a visibly traversable footprint; do not leave an opaque wall where the simulation permits passage.
- [ ] Implement sandbags, trenches, bunkers, mortar pits, both mine types, engineer work sites/progress, and built bridges from current state. Match the existing emplacement presentation offset without moving the unit in simulation.
- [ ] Make `rebuildStatic` dispose map-owned resources and reset transient effects, ID caches, and damage caches. It must work for title preview, map review, resume, restart, and campaign transitions, including the controller's minimal idle state.

Gate: all six countries and both terrain layout versions render; wet/dry maps and bridge variants match simulation geometry. Mid-battle reloads restore damage, ruins, construction, and cover correctly. Reviewing a different map and returning restores the original battlefield and pause state.

### M5 Finish units and tactical readability

- [ ] Render all friendly roles and enemy archetypes. Distinguish infantry factions, role equipment, observer, medic, engineers, mortarman, truck-mounted gun, and armored vehicle. A shared infantry body with appropriate equipment variants is sufficient.
- [ ] Animate movement, standing/crouching/prone, crawling, firing, pinning, healing, building, and weapon fitting using existing state/events. Animate wheels/tracks and gun direction for vehicles. Keep bodies attached to interpolated ground anchors and weapons aimed consistently.
- [ ] Keep stable renderer objects keyed by entity ID; update transforms and poses rather than rebuilding geometry each frame. Remove dead/crossed entities and clear stale selection/target visuals. Reconstruct a resumed unit correctly without requiring a prior stance or construction event.
- [ ] Ensure all health, suppression, low morale, selection, role, reload/upgrade, and relevant action feedback from the old renderer is represented. Preserve detailed information in the existing HTML panels rather than adding a DOM panel per unit.
- [ ] Address obscuring roofs and foliage cosmetically. A selectable soldier must remain recognizable and clickable without exposing or hiding units by new tactical rules.

Gate: every role can be recognized at the default camera size; posture and vehicle state changes are visible; units near buildings remain usable. The result reads as a complete 3D game rather than a collection of placeholder cubes or flat sprites.

### M6 Finish combat and environment effects

- [ ] Map existing renderer-handled events to 3D feedback: small-arms tracers, muzzle flashes, grenades, rockets/shells, artillery/mortar/air-support impacts, mines, deaths, building hits, healing, movement confirmations, and breakthrough warnings. Enumerate remaining events and deliberately retain their HUD/audio-only treatment where appropriate.
- [ ] Render persistent projectiles, smoke clouds, flares (including pending deployment), strikes, construction, and danger markers from state. Use events only for transient effects; avoid duplicate effects when handling an impact plus its generic explosion event. A reload must not replay historical explosions.
- [ ] Keep cosmetic arcs separate from impact timing and damage. Bound tracer, blast, dust, smoke, mark, and particle counts; pool frequently reused objects. Use existing event positions/radii rather than inventing hit locations from mesh intersections.
- [ ] Implement flowing water/rapids, all rain/fog/snow intensities, and existing day/dusk/night/dawn behavior. Use `dayNightAtTick`, current weather, flare radius/timers, and headlight state. Visual lighting must not change detection or hit calculations. At night the battlefield remains playable and feedback remains readable.
- [ ] Preserve shake magnitude semantics and preference behavior through the new public getter. Use the displayed camera consistently for projection/picking so shake cannot produce a second hidden coordinate system. Follow the current reduced-motion preference behavior; do not add a second settings system.

Gate: mine, mortar, friendly/enemy artillery, smoke, flares, headlights, severe weather, and night have recognizable feedback with correct timing. Audio remains single-sourced in the existing audio system. Pause/resume behavior matches the recorded baseline.

### M7 Verify parity, lifecycle, and performance

- [ ] Add focused coordinate/camera tests for round-tripping, fitting edges, no mirroring, viewport changes, and off-field rejection. Use real Three.js math where possible; do not mock away projection.
- [ ] Add a meaningful non-mutation/parity check: run identical seeded command/tick sequences with a no-op renderer and the new renderer, compare snapshots and command results. Independently compare state before/after render-only calls, including typed terrain buffers and RNG streams. Do not freeze nonempty typed arrays with `Object.freeze`; use copies/checksums where needed. Rendering must not advance the simulation clock.
- [ ] Exercise current browser scenarios through production output. Add only missing coverage for raised-unit clicks, projected tooltips, outside drag release/cancel, context loss/restore, and map-resource lifecycle. Preserve assertions; update fixtures only where the baseline demonstrates they were already invalid.
- [ ] Inspect screenshots, not just DOM assertions, for the representative states in section 8. Record artifacts and fix visual defects before completion.
- [ ] Run the existing stress scenario with a full squad, 80 enemies, vehicles and effects. Record frame-time percentiles, actual entity counts, renderer calls/triangles, viewport, browser, device pixel ratio, and GPU/hardware or software-rendering status. Target smooth 60 FPS on a stated ordinary desktop GPU; headless/software measurements are comparative evidence, not proof of hardware performance.
- [ ] Reuse geometry/materials and instance repeated scenery. Keep skinned/articulated infantry optimization separate from simple static instancing. Bound active effects and light counts. Avoid per-frame geometry rebuilds and broad allocations. If performance fails, measure shadows, transparency overdraw, animation, and draw calls before reducing fidelity.
- [ ] Warm asset caches, then cycle title/new run/restart/map review/campaign transition at least ten times. Inspect `renderer.info` geometry/texture counts and active listeners/loops: there must be no continuing growth after stable caches. Release mixers, geometry, materials, textures, render targets, observers, listeners, pointer capture, and RAF on their owning lifetime; do not dispose shared resources while another map/view still uses them.

Gate: zero new logic failures, no unexplained browser regressions, correct saves, no state mutation from rendering, no missing assets/shader errors/uncaught errors, and recorded visual/performance/lifecycle evidence. If a pre-existing failure remains, identify the exact baseline match; a green summary cannot be claimed for a failing suite.

### M8 Remove the old engine and deliver

- [ ] Make Three.js the default and only shipped battlefield path. Remove Phaser imports, startup, scale observers, private globals, the old renderer/scene, and the Phaser dependency. Preserve reusable palette/geometry helpers where justified.
- [ ] Retain only needed visual assets; keep audio and required provenance. Ensure all runtime assets and decoder files, if used, are bundled/self-hosted and work from a relative subpath without a CDN.
- [ ] Update README architecture, dependency versions, run instructions, browser/WebGL requirements, graphics behavior, and asset credits. Leave the older plan as historical context with a brief pointer if necessary; do not rewrite unrelated documentation.
- [ ] Re-run final checks after removal. Inspect `npm ls phaser` and source/test/script searches; legacy historical mentions in documentation are acceptable, runtime/test dependencies are not.
- [ ] Complete the execution log below and report changed files, actual checks, screenshots, measured performance, and unresolved baseline issues. Deliver locally; do not publish.

Gate: a fresh dependency install and production build run the complete game using Three.js, with compatible saves and no reliance on Phaser internals.

## 6. Resource and loading rules

Use explicit ownership: application-shared assets versus map-owned geometry versus entity-owned instances versus pooled transient effects. Removing an Object3D from a scene is not resource disposal. Cache useful shared geometry/materials; free the cache at application teardown. Do not clear global Three.js caches indiscriminately on each map transition.

Rebuilds are synchronous from the controller's perspective. Procedural assets satisfy this. If loading GLBs asynchronously, pre-load shared assets or use immediate procedural substitutes and generation tokens so late results cannot attach to a different map or a destroyed renderer. A failed optional asset cannot leave a blank battlefield or disable commands. Loading must not secretly advance a live battle.

Treat color textures as sRGB and data textures as linear according to the installed Three.js API. Set output color/tone mapping deliberately. Avoid washed-out ground, invisible night units, and excessive contrast from blindly copied lighting values.

## 7. Commands and evidence

Run from the repository root. Use the existing package scripts and lockfile; `npm ci` is for a clean install verification, not a reason to overwrite work or erase useful baselines.

```powershell
node --version
npm --version
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

The Playwright configuration serves the existing production `dist/` itself; build first. It currently uses Chromium and Firefox, IPv4 `127.0.0.1:4173`, and output paths under `/tmp/opencode/`. On Windows, make output paths workspace-relative if required for portable artifacts, and record the change. Do not weaken assertions or silently omit a browser to get a passing report. Install the configured browser binaries if missing and feasible; otherwise report the limitation separately from test failures.

Use PowerShell syntax for the optional stress suite. The config excludes stress tests unless `STRESS` is set; invoking the filename alone is insufficient under the current config.

```powershell
$env:STRESS = '1'
try {
  npx playwright test tests/stress.spec.ts --project=chromium
} finally {
  Remove-Item Env:STRESS -ErrorAction SilentlyContinue
}
```

Restore any pre-existing `STRESS` value instead of removing it if the environment had one. Also inspect `scripts/stress.mjs` and other diagnostic scripts for Phaser assumptions before using their results.

Do not fix unrelated baseline gameplay defects inside this conversion. Diagnose environmental test failures separately. If a baseline defect prevents verifying a required feature, isolate and document the correction and confirm it preserves the intended current mechanic; do not hide a gameplay change in a rendering patch. Keep existing passing tests passing and record exact remaining failures.

## 8. Completion coverage

Keep a compact matrix of scenario, seed/fixture, browser, result, screenshot path, and notes. Required evidence:

| Scenario | Required observation |
| --- | --- |
| Title, New Game, Continue, settings | One canvas, loaded terrain, usable DOM controls, no duplicate loop |
| Each campaign country; legacy and current terrain layout | Correct palette, scenery, building/road/water alignment and map review restoration |
| Soldier and truck/armor combat | Distinct teams/roles, movement, facing, weapon feedback and readable status |
| Selection and orders | Body/ground clicks, Shift toggle, drag box, formation order, outside release, cancel, scrolling and narrow/high-DPI layout |
| Engineer construction and both mines | Accurate preview geometry, engineer radius, progress/pause/abandonment, armed state, detonation |
| Buildings and cover | Standing/damaged/ruined geometry, correctly visible path through destruction, readable trench/bunker/mortar occupants |
| Rivers, roads and bridges | Dry/wet maps, horizontal/vertical/diagonal channels, tributaries, rapids, all existing bridge variants |
| Support and illumination | Friendly/enemy strikes, smoke, air support, pending flares, headlights, costs/cooldowns unchanged |
| Weather and night | All current weather kinds, visible day/night phases, legible units and warnings |
| Pause, tab hide, save/reload | Existing command rejection, timer semantics, preserved snapshots and durable visuals |
| Capture and map transitions | Crossed-unit removal, next-map rebuild, supply choice, victory/defeat/endless and restart |
| Resource lifecycle and stress | Bounded resources, no continuing memory growth, measured performance and correct recovery |

## 9. Reference documentation

Use official documentation matching the installed Three.js version:

- [OrthographicCamera](https://threejs.org/docs/pages/OrthographicCamera.html) and [Raycaster](https://threejs.org/docs/pages/Raycaster.html) for camera projection and picking.
- [WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html) for sizing, renderer information, and lifecycle.
- [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) and [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html) if external animated models are used.
- [InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html) for repeated geometry.
- [Object disposal](https://threejs.org/manual/pages/how-to-dispose-of-objects.html) and [color management](https://threejs.org/manual/pages/color-management.html) for resource and material handling.

## 10. Execution log

Milestones below reflect the work and evidence gathered in this conversion. “Partial” and “incomplete” are deliberate where full parity, visual coverage, or a performance gate has not been demonstrated.

| Milestone | Status | Changed files | Checks and evidence | Remaining issues |
| --- | --- | --- | --- | --- |
| M0 Baseline | Partial | Baseline hashes in `artifacts/pre-migration-sha256.txt`; no Git repository was present, and no repository was created. | Node.js 26.8.2, npm 11.19.1. Historical evaluation: 123/151 logic tests passed, 28 failed. Historical categories and the current failures overlap, but there is no pre-conversion per-test output to prove an exact match. | No saved pre-conversion screenshots or full named baseline report. Current failures are listed below and remain unverified against the exact pre-conversion tree. |
| M1 Renderer boundary | Complete | `src/game/render-contract.ts`, `src/game/controller.ts` | Controller uses the Three-independent `RendererPort`; `npm run typecheck` and production build pass. | None identified for the interface boundary. |
| M2 Playable vertical slice | Complete | `src/render/BattleRenderer3D.ts`, `src/render/app/BattleRuntime.ts`, `src/main.ts` | Production Chromium/Firefox suite reaches new games, campaign selection, restart, pause, save/reload, and result screens. Screenshot: `artifacts/threejs-preview.png`. | Broad campaign/visual parity is tracked under M4–M7. |
| M3 Input and projected UI | Complete | `src/render/app/coordinates.ts`, `src/render/app/camera.ts`, `src/ui/hud.ts`, `src/game/controller.ts`, `tests/browser.spec.ts` | Browser tests pass for projection round-trip at narrow viewport, selection/Shift-toggle, drag selection, move orders, and narrow layouts in both configured browsers. | Full high-DPI and all pointer/capture edge cases are not separately evidenced. |
| M4 Terrain and structures | Partial | `src/render/BattleRenderer3D.ts` | Production smoke tests pass map review, country choice, weather presentation, and map restoration. Geometry is procedural and uses instancing for repeated ground/scenery. | No complete visual matrix for every legacy/current terrain layout, country, river orientation, tributary, bridge, building damage stage, or fortification. Existing landscape/building simulation tests still fail. |
| M5 Units and readability | Partial | `src/render/BattleRenderer3D.ts`, `src/ui/hud.ts` | Procedural infantry/vehicle silhouettes, selection and health markers; browser tests pass for selection, recruitment, support and soldier movement. | Full role/posture/facing/combat visual review and screenshot set not completed. |
| M6 Effects and environment | Partial | `src/render/BattleRenderer3D.ts`, `src/e2e-hook.ts` | Snow/weather, barrage warning and impact feedback, mines, smoke, flares, and pause/save paths are represented; production tests pass weather continuation and barrage reload scenarios. | Not all weather intensities, day/night transitions, illumination, air support, and effect lifecycle cases have been visually reviewed. |
| M7 Parity and performance | Incomplete | `scripts/stress.mjs`, `src/e2e-hook.ts`, `tests/browser.spec.ts`, `artifacts/threejs-preview.png` | Final full Playwright run: 59/66 passed (Chromium + Firefox). After that run, the roster/report and barrage persistence fixtures were stabilized; targeted reruns passed both scenarios in both browsers (4/4). Building destruction and river/mud movement still fail in both browsers; Firefox map review timed out during the full and isolated runs. Stress on Chromium SwiftShader, 1280×720, DPR 1: 14 friendlies, 80 enemies, 30 strikes, 8 smoke clouds, 1 flare; 46 frames / 8 s, mean 176.2 ms, p50 183.3 ms, p95 183.4 ms, p99/max 200 ms; 904→1122 calls and 551→672 geometries. | Software-rendered stress is ~5.7 FPS and does not meet the 60 FPS target. Geometry count grew during the sample. Hardware GPU performance, ten-cycle resource stability, and full parity gates remain unverified. |
| M8 Cleanup and delivery | Complete | `package.json`, `package-lock.json`, `README.md`, `ASSETS.md`; deleted `src/game/render.ts` and `src/game/BattleScene.ts` | `npm ci` completed with 0 reported vulnerabilities; `npm run build` passed afterward. `npm ls phaser` reports `(empty)`; runtime/test/script source search found no Phaser references. Vite uses relative asset paths. | Build reports the main JavaScript chunk at about 883 kB (237 kB gzip), above Vite’s 500 kB warning threshold. No deployment was performed. |

### Current verification record

- `npm run typecheck`: passed.
- `npm run build`: passed after a clean `npm ci`; Three.js 0.186.1 and `@types/three` 0.183.1. The bundle-size warning remains.
- `npm run test`: 122 passed, 29 failed out of 151. Failures: persistence (17, including unavailable happy-dom `localStorage` and stale schema expectation), weather (1), campaigns (1), landscape (3, including a timeout), road intersections (2, including a timeout), simulation (4), and balance (1). These are in existing persistence/simulation/terrain logic; because no exact pre-conversion run was saved, do not label each one a proven baseline match.
- `npm run test:e2e`: final full run 59 passed, 7 failed out of 66. Two fixture timing issues (roster healing and barrage countdown) were then stabilized and rerun successfully in both browsers (4/4 targeted passes). The current deterministic failures are building destruction and river/mud movement in both browsers; Firefox map review also exceeded its 60-second timeout, including when isolated, while Chromium map review passed.
- Stress measurement is comparative software-renderer evidence from Chromium ANGLE/SwiftShader, not a hardware-GPU benchmark. Scene counts above were captured before and after the timed window; transient projectile activity appeared by the end.
- Screenshot and baseline hash record: `artifacts/threejs-preview.png`, `artifacts/pre-migration-sha256.txt`.

### Scenario coverage snapshot

| Scenario group | Browser/result | Evidence or limitation |
| --- | --- | --- |
| New game, country chooser, map review, restart, narrow layout | Chromium + Firefox; passed in suite | Preview image at `artifacts/threejs-preview.png`; map/campaign production smoke tests. |
| Selection, move orders, Shift-toggle, drag selection, projection | Chromium + Firefox; passed in suite | Projection round-trip includes narrow viewport; no standalone high-DPI capture. |
| Pause, tab-hide, save/reload, support, barrage, weather continuation | Chromium + Firefox; passed in suite | Production browser scenarios. |
| Building destruction and river/mud traversal | Chromium + Firefox; failed | Existing simulation assertions also fail; rendering work did not modify gameplay mechanics. |
| Full country/terrain/role/effect parity | Not fully reviewed | Requires per-scenario visual inspection and additional screenshots. |
| Stress and resource lifecycle | Measured, gate failed/unverified | SwiftShader performance below target; geometry count increased; ten-cycle stability not tested. |

Record exact dependency/runtime versions, baseline failures, chosen camera/material settings, asset sources, scenario coverage, test output locations, and unresolved limitations here. Keep measured results separate from targets. If interrupted, finish with the last passing milestone, current failure, and next concrete action.
