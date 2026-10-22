import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage as BrowserStorage } from 'happy-dom';
import {
  DEFAULT_PREFS,
  KEYS,
  Storage,
  loadBest,
  loadPrefs,
  loadSnapshot,
  saveBest,
  savePrefs,
  saveSnapshot,
  validateSnapshot,
} from '../src/persistence';
import { validateRawContent } from '../src/content/validate';
import { CONFIG } from '../src/content/config';
import unitsData from '../src/content/units.json';
import weaponsData from '../src/content/weapons.json';
import wavesData from '../src/content/waves.json';
import { Simulation } from '../src/simulation/simulation';

// Use browser storage even when Node exposes an unconfigured native localStorage.
const localStorageDescriptor = { configurable: true, value: new BrowserStorage() };
beforeEach(() => Object.defineProperty(window, 'localStorage', localStorageDescriptor));

afterEach(() => {
  if (localStorageDescriptor) {
    Object.defineProperty(window, 'localStorage', localStorageDescriptor);
  }
  window.localStorage.clear();
});

describe('snapshot validation', () => {
  const validSnap = () => new Simulation(123).snapshot();

  const errOf = (result: ReturnType<typeof validateSnapshot>): string => {
    expect(result).toHaveProperty('error');
    return (result as { error: string }).error;
  };

  it('accepts a genuine snapshot', () => {
    const result = validateSnapshot(JSON.parse(JSON.stringify(validSnap())));
    expect(result).toHaveProperty('snap');
  });

  it('rejects non-objects and unsupported versions with clear errors', () => {
    expect(validateSnapshot(null)).toHaveProperty('error');
    expect(validateSnapshot([1, 2, 3])).toHaveProperty('error');
    expect(errOf(validateSnapshot('save'))).toMatch(/not a valid record/);
    const wrongVersion = { ...validSnap(), schemaVersion: 99 };
    expect(errOf(validateSnapshot(wrongVersion))).toMatch(/Unsupported save version/);
  });

  it('restores a v1 save with no mines and on map 1, and round-trips mines in a v2 save', () => {
    // v1 predates mines: an older save must still load, with an empty minefield.
    // It also predates buildings, so the record carries no building list at all.
    const v1 = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    v1.schemaVersion = 1;
    delete v1.mines;
    delete v1.buildings;
    const migrated = validateSnapshot(v1);
    expect(migrated).toHaveProperty('snap');
    if ('error' in migrated) throw new Error(migrated.error);
    expect(migrated.snap.mines).toEqual([]);
    expect(migrated.snap.schemaVersion).toBe(30);
    // v1 also predates the northern march: it restores on map 1 with nobody across.
    expect(migrated.snap.mapNumber).toBe(1);
    expect(migrated.snap.mapsCleared).toBe(0);
    expect(migrated.snap.crossedUnits).toEqual([]);
    expect(migrated.snap.baseTerrainSeed).toBe(migrated.snap.seed);
    // And it predates destructible buildings, so its map is regenerated without
    // any rather than with structures the save has no record of.
    expect(migrated.snap.buildings).toEqual([]);
    expect(migrated.snap.terrainHasBuildings).toBe(false);

    // A v2 save carries laid mines, armed state included.
    const v2 = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    v2.mines = [
      { id: 7, pos: { x: 100, y: 200 }, kind: 'at', armed: true },
      { id: 8, pos: { x: 300, y: 400 }, kind: 'ap', armed: false },
    ];
    const restored = validateSnapshot(v2);
    expect(restored).toHaveProperty('snap');
    if ('error' in restored) throw new Error(restored.error);
    expect(restored.snap.mines).toEqual([
      { id: 7, pos: { x: 100, y: 200 }, kind: 'at', armed: true },
      { id: 8, pos: { x: 300, y: 400 }, kind: 'ap', armed: false },
    ]);
  });

  it('treats a mine with no recorded type as anti-personnel', () => {
    // Mines predate the split into AP and AT, so an older record has no type.
    const snap = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    snap.mines = [{ id: 5, pos: { x: 10, y: 10 }, armed: true }];
    const result = validateSnapshot(snap);
    expect(result).toHaveProperty('snap');
    if ('error' in result) throw new Error(result.error);
    expect(result.snap.mines[0]!.kind).toBe('ap');
    expect(validateSnapshot({ ...snap, mines: [{ id: 5, pos: { x: 10, y: 10 }, kind: 'nuclear', armed: true }] }))
      .toHaveProperty('error');
  });

  it('rejects malformed mine records', () => {
    const bad = (mine: unknown): string => {
      const snap = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
      snap.mines = [mine];
      return errOf(validateSnapshot(snap));
    };
    expect(bad({ id: 1, pos: { x: 10, y: 10 } })).toMatch(/arming state/);
    expect(bad({ id: 1, pos: { x: 10, y: 10 }, armed: 'yes' })).toMatch(/arming state/);
    expect(bad({ id: 0, pos: { x: 10, y: 10 }, armed: true })).toMatch(/mine id/);
    expect(bad({ id: 1, pos: { x: -40, y: 10 }, armed: true })).toMatch(/out of bounds/);
    // An unarmed mine mid-lay is legitimate, so it must be accepted.
    const laying = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    laying.mines = [{ id: 1, pos: { x: 10, y: 10 }, armed: false }];
    expect(validateSnapshot(laying)).toHaveProperty('snap');
  });

  it('rejects unknown archetypes, duplicate ids, and out-of-bounds positions', () => {
    const snap = validSnap();
    (snap.units[0] as unknown as { role: string }).role = 'tank commander';
    expect(errOf(validateSnapshot(JSON.parse(JSON.stringify(snap))))).toMatch(/archetype/);

    const dupes = validSnap();
    dupes.units[1]!.id = dupes.units[0]!.id;
    expect(errOf(validateSnapshot(dupes))).toMatch(/Duplicate unit id/);

    const far = validSnap();
    far.units[0]!.pos = { x: 99999, y: 0 };
    expect(errOf(validateSnapshot(far))).toMatch(/out of bounds/);
  });

  it('rejects corrupt numbers and scheduler state without throwing', () => {
    const nanPoints = validSnap();
    nanPoints.points = Number.NaN;
    expect(errOf(validateSnapshot(nanPoints))).toMatch(/points/);

    const negativeIntegrity = validSnap();
    negativeIntegrity.integrity = -3;
    expect(errOf(validateSnapshot(negativeIntegrity))).toMatch(/integrity/);

    const badPhase = validSnap();
    (badPhase.scheduler as unknown as { phase: string }).phase = 'celebrating';
    expect(errOf(validateSnapshot(badPhase))).toMatch(/wave phase/);

    const badQueue = validSnap();
    badQueue.scheduler.spawnQueue = ['rifle', 'dragon'] as unknown as typeof badQueue.scheduler.spawnQueue;
    expect(errOf(validateSnapshot(badQueue))).toMatch(/spawn queue/);

    // The march north: a soldier cannot be on the map and off it at the same time.
    const bothPlaces = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    const onMap = (bothPlaces.units as Array<Record<string, unknown>>)[0]!;
    bothPlaces.crossedUnits = [onMap];
    expect(errOf(validateSnapshot(bothPlaces))).toMatch(/Duplicate unit id/);

    // Only Allied soldiers can be over the edge.
    const enemyAcross = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    enemyAcross.crossedUnits = [{ ...onMap, id: 991, team: 'enemy', role: 'rifle', service: { healthRestored: 0, fortificationsBuilt: 0, grenadesThrown: 0 } }];
    expect(errOf(validateSnapshot(enemyAcross))).toMatch(/crossed|Allied|archetype/i);

    const badMap = validSnap();
    badMap.mapNumber = 0;
    expect(errOf(validateSnapshot(badMap))).toMatch(/map number/);

    const badSeed = { ...validSnap(), baseTerrainSeed: -1 };
    expect(errOf(validateSnapshot(badSeed))).toMatch(/base terrain seed/);

    const badEndless = validSnap();
    badEndless.scheduler.endlessWavesCleared = 1.5;
    expect(errOf(validateSnapshot(badEndless))).toMatch(/endless wave counter/);

    // The crossing marker is accepted but rebuilt, not trusted.
    const marked = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    (marked.units as Array<Record<string, unknown>>)[0]!.crossed = 'yes';
    expect(errOf(validateSnapshot(marked))).toMatch(/crossing flag/);
  });

  it('round-trips the campaign position and a soldier over the north edge', () => {
    const sim = new Simulation(4242);
    // Stage a crossing: one soldier over the edge, one still on the map.
    const ids = sim.state.units.filter((u) => u.team === 'friendly').map((u) => u.id);
    const crosser = sim.state.units.find((u) => u.id === ids[0]!)!;
    crosser.pos = { x: crosser.pos.x, y: CONFIG.crossing.thresholdY };
    crosser.xp = 3;
    crosser.kills = 5;
    crosser.weaponUpgrades.accuracy = 1;
    sim.step();
    expect(sim.crossedCount).toBe(1);

    const snap = sim.snapshot();
    expect(snap.mapNumber).toBe(1);
    expect(snap.mapsCleared).toBe(0);
    expect(snap.crossedUnits.map((u) => u.id)).toEqual([ids[0]]);
    // The transient marker is never persisted; restoring rebuilds it from the
    // two unit lists instead.
    expect(snap.crossedUnits[0]!.crossed).toBeUndefined();
    expect(snap.units[0]!.crossed).toBeUndefined();

    const restored = validateSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(restored).toHaveProperty('snap');
    if ('error' in restored) throw new Error(restored.error);
    expect(restored.snap.crossedUnits).toHaveLength(1);
    expect(restored.snap.crossedUnits[0]!.xp).toBe(3);
    expect(restored.snap.crossedUnits[0]!.kills).toBe(5);
    expect(restored.snap.crossedUnits[0]!.weaponUpgrades.accuracy).toBe(1);
    expect(restored.snap.scheduler.phase).toBe('crossing');
    expect(Simulation.fromSnapshot(restored.snap).snapshot()).toEqual(snap);
  });

  it('restores a v5 save with a battery that has no stream of its own', () => {
    // v5 shipped Axis counter-battery fire but shared the combat random stream;
    // v6 gave the battery its own. A v5 save therefore has a cooldown but no
    // battery stream, and must resume with one derived from its seed.
    const v5 = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    v5.schemaVersion = 5;
    v5.enemyArtilleryCooldown = 300;
    delete v5.enemyArtilleryRng;
    const migrated = validateSnapshot(v5);
    expect(migrated).toHaveProperty('snap');
    if ('error' in migrated) throw new Error(migrated.error);
    expect(migrated.snap.enemyArtilleryCooldown).toBe(300);
    expect(migrated.snap.enemyArtilleryRng).toBeUndefined();

    const restored = Simulation.fromSnapshot(migrated.snap);
    expect(restored.state.enemyArtilleryCooldown).toBe(300);
    expect(restored.state.enemyArtilleryRng.s).toBeGreaterThanOrEqual(0);
    // The resumed run is playable and keeps its own fire plan from then on.
    for (let i = 0; i < 60; i++) restored.step();
    expect(restored.snapshot().enemyArtilleryRng).toBeDefined();

    // A save from before the battery existed at all defaults to a ready one.
    const v4 = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    v4.schemaVersion = 4;
    delete v4.enemyArtilleryCooldown;
    delete v4.enemyArtilleryRng;
    const older = validateSnapshot(v4);
    expect(older).toHaveProperty('snap');
    if ('error' in older) throw new Error(older.error);
    expect(older.snap.enemyArtilleryCooldown).toBe(0);
  });

  it('restores a v6 save where weapon upgrades took no time', () => {
    // v7 made personal weapon upgrades occupy the soldier for a few seconds. A
    // save from before that has no work timer on any soldier, so every weapon is
    // already assembled when it resumes.
    const v6 = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    v6.schemaVersion = 6;
    for (const unit of v6.units as Array<Record<string, unknown>>) delete unit.upgradeTimer;
    const migrated = validateSnapshot(v6);
    expect(migrated).toHaveProperty('snap');
    if ('error' in migrated) throw new Error(migrated.error);
    expect(migrated.snap.units.every((u) => u.upgradeTimer === undefined)).toBe(true);
    const restored = Simulation.fromSnapshot(migrated.snap);
    for (const unit of restored.state.units) expect(restored.upgradeTicksLeft(unit)).toBe(0);
  });

  it('rejects a corrupt weapon upgrade work timer', () => {
    const bad = validSnap();
    bad.units[0]!.upgradeTimer = -5;
    expect(errOf(validateSnapshot(bad))).toMatch(/weapon upgrade timer/);

    const notANumber = validSnap();
    (notANumber.units[0] as unknown as Record<string, unknown>).upgradeTimer = 'soon';
    expect(errOf(validateSnapshot(notANumber))).toMatch(/weapon upgrade timer/);

    // A soldier mid-upgrade round-trips with his time still to serve.
    const working = validSnap();
    working.units[0]!.upgradeTimer = 42;
    const result = validateSnapshot(working);
    expect(result).toHaveProperty('snap');
    if ('error' in result) throw new Error(result.error);
    expect(result.snap.units[0]!.upgradeTimer).toBe(42);
  });

  it('rejects a corrupt enemy artillery stream and shell records', () => {
    const badStream = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    badStream.enemyArtilleryRng = { s: Number.NaN };
    expect(errOf(validateSnapshot(badStream))).toMatch(/enemy artillery random state/);

    const badCooldown = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    badCooldown.enemyArtilleryCooldown = -1;
    expect(errOf(validateSnapshot(badCooldown))).toMatch(/enemy artillery cooldown/);

    const badSource = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    badSource.strikes = [{
      id: 1,
      pos: { x: 100, y: 100 },
      landTick: 10,
      radius: 60,
      damage: 40,
      suppressionAmount: 10,
      source: 'martian',
    }];
    expect(errOf(validateSnapshot(badSource))).toMatch(/strike source/);

    // The battery's own shells round-trip like any other.
    const good = JSON.parse(JSON.stringify(validSnap())) as Record<string, unknown>;
    good.strikes = [{
      id: 1,
      pos: { x: 100, y: 100 },
      landTick: 10,
      radius: 60,
      damage: 40,
      suppressionAmount: 10,
      source: 'enemy',
    }];
    expect(validateSnapshot(good)).toHaveProperty('snap');
  });

  it('loadSnapshot returns null for a missing save and an error for a corrupt one', () => {
    const storage = new Storage();
    expect(loadSnapshot(storage)).toBeNull();
    storage.set(KEYS.save, '{not json');
    expect(loadSnapshot(storage)).toHaveProperty('error');
    storage.set(KEYS.save, JSON.stringify(validSnap()));
    expect(loadSnapshot(storage)).toHaveProperty('snap');
  });
});

describe('storage wrapper', () => {
  it('persists prefs and best records through real storage', () => {
    const storage = new Storage();
    expect(loadPrefs(storage)).toEqual(DEFAULT_PREFS);
    savePrefs(storage, { ...DEFAULT_PREFS, volume: 0.3, muted: true });
    expect(loadPrefs(storage)).toEqual({ ...DEFAULT_PREFS, volume: 0.3, muted: true });

    expect(loadBest(storage).bestScore).toBe(0);
    saveBest(storage, { bestScore: 4321, victories: 2 });
    expect(loadBest(storage)).toEqual({ bestScore: 4321, victories: 2 });
  });

  it('keeps working in memory when storage throws, without crashing', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    const storage = new Storage();
    const sim = new Simulation(9);
    expect(saveSnapshot(storage, sim.snapshot())).toBe(false);
    expect(storage.status).toBe('memory');
    // Snapshot round-trips through the in-memory fallback.
    expect(loadSnapshot(storage)).toHaveProperty('snap');
  });
});

describe('content validation', () => {
  it('accepts the shipped content', () => {
    expect(() => validateRawContent(unitsData, weaponsData, wavesData)).not.toThrow();
  });

  it('fails clearly on malformed content', () => {
    expect(() => validateRawContent({}, weaponsData, wavesData)).toThrow(/units\.friendly/);
    // An empty weapon table surfaces as an unresolved weapon reference.
    expect(() => validateRawContent(unitsData, {}, wavesData)).toThrow(/weapons root|unknown weapon/);
    const missingFriendly = { friendly: {}, enemy: unitsData.enemy };
    expect(() => validateRawContent(missingFriendly, weaponsData, wavesData)).toThrow(/missing friendly unit/);
    const badHealth = JSON.parse(JSON.stringify(unitsData)) as typeof unitsData;
    (badHealth.friendly.rifleman as unknown as Record<string, unknown>).health = 'lots';
    expect(() => validateRawContent(badHealth, weaponsData, wavesData)).toThrow(/rifleman\.health/);
    const shortWaves = { waves: wavesData.waves.slice(0, 5) };
    expect(() => validateRawContent(unitsData, weaponsData, shortWaves)).toThrow(/exactly 15/);
    const unknownArchetype = {
      waves: Array.from({ length: 15 }, () => ({
        label: 'Bad',
        composition: [{ archetype: 'dragon', count: 2 }],
        spawnIntervalSeconds: 1,
      })),
    };
    expect(() => validateRawContent(unitsData, weaponsData, unknownArchetype)).toThrow(/archetype/);
  });
});
