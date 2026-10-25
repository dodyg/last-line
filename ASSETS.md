# Assets and provenance

## Visuals

| Asset | Source | License | Use |
| --- | --- | --- | --- |
| Roads, terrain kinds, vegetation, buildings, soldiers, vehicles, fortifications, effects and tactical marks | Procedural geometry in `src/render/BattleRenderer3D.ts` | Original project code | Three-dimensional battlefield presentation |
| Older field tiles and overhead infantry sheet | Canvas Digital Studios and nicisbig; see earlier asset records below | CC0 and CC BY 3.0 | Retained as source provenance; no longer imported or bundled by the Three.js runtime |

The older infantry and terrain artwork remains in the source tree for
provenance. The current 3D runtime does not import or bundle those images.

### Buildings: why they are drawn, not sourced

Buildings are the one asset class that was searched for and deliberately **not**
taken from a third party. Four candidates were inspected, and each failed a
different test; the record is kept here so the decision is not re-litigated:

| Candidate | License | Why it was not used |
| --- | --- | --- |
| Buch, [Orthographic outdoor tiles](https://opengameart.org/content/orthographic-outdoor-tiles) | CC0 | The closest match in shape — orthogonal top-down houses and walls, 16x16 tiles — but the palette is bright, saturated Nintendo-era pixel art with blue and crimson roofs. At the 95–190 px footprints this game needs, the tiles scale up chunky and clash with the muted, semi-realistic field and infantry art. |
| Canvas Digital Studios, [16 Bit Style Army Tileset](https://opengameart.org/content/16-bit-style-army-tileset) (already used for terrain) | CC0 | Contains ground, foliage, obstacles and crates but **no buildings at all**, so it cannot cover this need despite being the project's existing source. |
| rubberduck, [50 free textures 5](https://opengameart.org/content/50-free-textures-5-with-normalmaps) | CC0 | Muted and high resolution, and it does contain stone, brick, plaster and roof materials — but in a 51 MB pack aimed at 3D use, and sampling twelve of its textures found gravel, brick, wood, metal and grass with no slate or terracotta roofing suitable for farmhouse or church tops. |
| OpenGameArt building searches (village, ruins, destroyed building, medieval building) | mixed | Returns 16x16 fantasy/RPG tilesets almost without exception: the same style and palette problem as Buch, for content that is also less appropriate to a 1944 Normandy village. |

Buildings are currently generated as Three.js geometry in
`src/render/BattleRenderer3D.ts`. Their visual damage and ruin states follow
simulation building records; the procedural model requires no external model
downloads.


## Audio

| Asset | Source | License |
| --- | --- | --- |
| Combat, artillery, heal, UI, wave, breakthrough, defeat and victory effects | Synthesized at runtime with the Web Audio API in `src/game/audio.ts` | Original project code |
| Allied voice clips | [Soldier Voice Acting](https://opengameart.org/content/soldier-voice-acting) by kurt | CC BY 3.0; attribution and processing details in `src/assets/ww2/voices/SOURCES.md` |
| Medic request shout | Locally synthesized "Medic!" using Microsoft David Desktop; bundled as `medic-call.wav` | Processing details in `src/assets/ww2/voices/SOURCES.md` |
| Grenade supplies shout | Locally synthesized "Grenade supplies!" using Microsoft David Desktop; bundled as `grenade-supplies-call.wav` | Processing details in `src/assets/ww2/voices/SOURCES.md` |
| German radio clips | [German Voices](https://opengameart.org/content/german-voices-0), voice actor Manuel Senfft, shared by Andrettin | CC0; processing details in `src/assets/ww2/voices/SOURCES.md` |

Voice clips are loaded from local bundled files. Missing or blocked audio simply
plays silent and never blocks gameplay. The mixer respects volume, mute, and the
pause state.

## Third-party software

| Package | Version | License | Use |
| --- | --- | --- | --- |
| three | 0.186.1 | MIT | Three-dimensional rendering and scene management |
| @types/three | 0.183.1 | MIT | Three.js TypeScript declarations |
| Vite | 8.3.1 | MIT | Development server and production bundling |
| TypeScript | 7.0.2 | Apache-2.0 | Type checking |
| Vitest | 4.1.11 | MIT | Logic test runner |
| happy-dom | 20.14.5 | MIT | DOM environment for logic tests |
| @playwright/test | 1.63.0 | Apache-2.0 | Browser smoke/performance verification |

Run `npm install` to fetch these at their pinned versions from
`package-lock.json`.

## Branding

The title **Last Line**, the scenario text, wave names, telegraph texts and
all in-game copy are original to this project. The game is inspired by the
broad experience of classic defense games such as Mud and Blood 2; it uses no
assets, data, or code from any such game.

### Procedural battlefield soundscape

`src/game/soundscape.ts` synthesizes wind, rain, sheltered drips, bird calls, distant low rumbles, and sparse adaptive music with Web Audio. No external recordings or music licenses are required for these layers. Music responds to nearby threats, pinned troops, and sector capture; music and ambience duck beneath speech and fade during pause or hidden views. Settings provide separate saved music and ambience sliders. Local field chatter omits radio static; radio exchanges retain the receiver treatment. Browser speech availability still determines spoken contextual lines; captions always remain available.

Lull banter is authored in `src/content/lull-banter.ts`: 24 paired exchanges between nearby adult soldiers, using existing field voices and captions. Banter starts after 6 seconds of quiet during preparation or a secured-sector lull, repeats no sooner than 20–35 seconds, avoids the last eight lines, and is interrupted by renewed combat.
