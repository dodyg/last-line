import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { bridgeKey } from '../src/simulation/bridges';
import { deriveRng } from '../src/simulation/rng';
import { demolitionSites } from '../src/simulation/sappers';
import { Simulation, sec } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import type { SimEvent, Vec2 } from '../src/simulation/types';
import { buildSpawnQueue } from '../src/simulation/waves';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = []; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  sim.spawnFriendly('medic', { x: 900, y: 700 });
  const bunker = { id: sim.state.nextEntityId++, pos: { x: 492, y: 564 } };
  sim.state.bunkers.push(bunker);
  const tick = (n: number) => Array.from({ length: n }, () => sim.step()).flat();
  const spawn = (pos: Vec2 = { x: 492, y: 480 }) => {
    expect(sim.spawnEnemySapperTeam(pos)).toBe(true);
    const team = sim.state.enemySapperTeams.at(-1)!;
    const sapper = sim.state.units.find((unit) => unit.id === team.sapperId)!;
    return { team, sapper };
  };
  const arm = () => {
    const events: SimEvent[] = [];
    for (let i = 0; i < 900 && sim.state.enemyDemolitionCharges.length === 0; i++) events.push(...sim.step());
    expect(sim.state.enemyDemolitionCharges).toHaveLength(1);
    return events;
  };
  return { sim, bunker, tick, spawn, arm };
}

describe('enemy sapper teams', () => {
  it('spawns one demolition specialist and two rifle escorts, with a team warning', () => {
    const { sim, spawn, tick } = fixture();
    const { team } = spawn();
    expect(sim.state.units.filter((unit) => unit.team === 'enemy').map((unit) => unit.role)).toEqual(['sapper', 'rifle', 'rifle']);
    expect(tick(1)).toContainEqual(expect.objectContaining({ type: 'sapperTeamInbound', unitIds: [team.sapperId, ...team.escortIds] }));
    expect(team.target).toMatchObject({ kind: 'bunker' });
  });

  it('preserves authored wave size and reserves both escorts for atomic spawning from wave eight', () => {
    const { sim, tick } = fixture();
    sim.state.scheduler.waveIndex = 7;
    const built = buildSpawnQueue(deriveRng(1, 2), sim.state.scheduler, false);
    expect(built.queue).toHaveLength(8); expect(built.queue[0]).toBe('sapper');
    expect(built.queue.filter((role) => role === 'rifle')).toHaveLength(2);
    sim.state.scheduler.phase = 'spawning'; sim.state.scheduler.spawnQueue = built.queue; sim.state.scheduler.spawnTimer = 1;
    tick(1);
    expect(sim.state.enemySapperTeams).toHaveLength(1);
    expect(sim.state.units.filter((unit) => unit.team === 'enemy')).toHaveLength(3);
    expect(sim.state.scheduler.spawnQueue).toHaveLength(5);
  });

  it('waits for three cap slots without partially spawning or consuming the queue', () => {
    const { sim, tick } = fixture();
    for (let i = 0; i < CONFIG.caps.liveEnemies - 2; i++) sim.spawnEnemy('rifle', { x: 100 + i * 25, y: 100 });
    sim.state.scheduler.waveIndex = 7; sim.state.scheduler.phase = 'spawning';
    sim.state.scheduler.spawnQueue = ['sapper', 'rifle', 'rifle']; sim.state.scheduler.spawnTimer = 1;
    tick(1);
    expect(sim.state.enemySapperTeams).toEqual([]);
    expect(sim.state.scheduler.spawnQueue).toEqual(['sapper', 'rifle', 'rifle']);
    const victim = sim.state.units.find((unit) => unit.team === 'enemy')!; victim.health = 0; victim.dead = true;
    tick(1);
    expect(sim.state.enemySapperTeams).toHaveLength(1);
    expect(sim.state.scheduler.spawnQueue).toEqual([]);
    expect(sim.state.units.filter((unit) => unit.team === 'enemy')).toHaveLength(CONFIG.caps.liveEnemies);
  });

  it('approaches a reachable bunker, spends four seconds planting, and gives an eight-second fuse', () => {
    const { sim, spawn, arm } = fixture(); const { team, sapper } = spawn();
    const events = arm();
    expect(events.filter((event) => event.type === 'sapperTargeted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'enemyChargePlanted')).toHaveLength(1);
    expect(team.plantTicks).toBe(sec(CONFIG.enemySappers.plantSeconds));
    expect(sim.state.enemyDemolitionCharges[0]!.ticksRemaining).toBe(sec(8));
    expect(events.some((event) => event.type === 'shot' && event.shooterId === sapper.id)).toBe(false);
    expect(sapper.pos.y).toBeGreaterThan(480);
  });

  it('pauses planting under pinning and cancels unarmed demolition when the sapper dies', () => {
    const { sim, spawn, tick, bunker } = fixture(); const { team, sapper } = spawn({ x: 492, y: 528 });
    tick(30); expect(team.plantTicks).toBe(29);
    sapper.pinned = true; sapper.suppression = 100; tick(10); expect(team.plantTicks).toBe(29);
    sim.paused = true; tick(30); expect(team.plantTicks).toBe(29); sim.paused = false;
    sapper.health = 0; sapper.dead = true; tick(300);
    expect(sim.state.enemySapperTeams).toEqual([]); expect(sim.state.enemyDemolitionCharges).toEqual([]);
    expect(sim.state.bunkers).toContainEqual(bunker);
  });

  it('keeps armed charges burning after the team dies and destroys the targeted bunker once', () => {
    const { sim, spawn, arm, tick } = fixture(); spawn(); arm();
    for (const unit of sim.state.units) if (unit.team === 'enemy') { unit.health = 0; unit.dead = true; }
    sim.paused = true; tick(100); expect(sim.state.enemyDemolitionCharges[0]!.ticksRemaining).toBe(sec(8)); sim.paused = false;
    expect(tick(sec(8) - 1).some((event) => event.type === 'enemyChargeDetonated')).toBe(false);
    const events = tick(1);
    expect(sim.state.bunkers).toEqual([]); expect(sim.state.enemyDemolitionCharges).toEqual([]);
    expect(events.filter((event) => event.type === 'structureDemolished')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'enemyChargeDetonated')).toHaveLength(1);
    expect(tick(10).filter((event) => event.type === 'enemyChargeDetonated')).toEqual([]);
  });

  it('withdraws the sapper and escorts after arming, while escorts can provide covering fire', () => {
    const { sim, spawn, arm, tick } = fixture(); const { team } = spawn();
    const target = sim.spawnFriendly('rifleman', { x: 550, y: 620 }); target.reloadTimer = 100_000; target.grenades = 0; target.health = 1000;
    const events = arm();
    expect(events.some((event) => event.type === 'shot' && team.escortIds.includes(event.shooterId))).toBe(true);
    const charge = sim.state.enemyDemolitionCharges[0]!;
    tick(180);
    for (const id of [team.sapperId, ...team.escortIds]) {
      const unit = sim.state.units.find((candidate) => candidate.id === id)!;
      expect(Math.hypot(unit.pos.x - charge.pos.x, unit.pos.y - charge.pos.y)).toBeGreaterThan(CONFIG.enemySappers.radius);
    }
  });

  it('ignores empty buildings, targets occupied ones, and abandons the mission if they evacuate before arming', () => {
    const { sim, spawn, tick } = fixture(); sim.state.bunkers = [];
    const building = { id: sim.state.nextEntityId++, kind: 'house' as const, name: 'Target house', pos: { x: 480, y: 552 }, cols: 2, rows: 2, health: 500, maxHealth: 500, destroyed: false };
    sim.state.buildings.push(building);
    expect(demolitionSites(sim.state)).toEqual([]);
    const occupant = sim.spawnFriendly('rifleman', { x: 492, y: 564 }); occupant.buildingPosition = { buildingId: building.id, level: 0, slot: 0 };
    occupant.reloadTimer = 100_000; occupant.grenades = 0;
    expect(demolitionSites(sim.state)).toHaveLength(1);
    const { team } = spawn({ x: 492, y: 540 }); tick(30);
    expect(team.target).toMatchObject({ kind: 'building', id: building.id });
    delete occupant.buildingPosition; occupant.pos = { x: 900, y: 700 }; tick(1);
    expect(team.target).toBeNull(); expect(team.plantTicks).toBe(0);
  });

  it('damages occupied buildings through the existing collapse system, even after the garrison leaves an armed charge', () => {
    const { sim } = fixture(); sim.state.bunkers = [];
    const id = sim.state.nextEntityId++;
    sim.state.buildings.push({ id, kind: 'house', name: 'Target house', pos: { x: 480, y: 552 }, cols: 2, rows: 2, health: 500, maxHealth: 500, destroyed: false });
    const restored = Simulation.fromSnapshot(sim.snapshot());
    restored.state.enemyDemolitionCharges.push({ id: restored.state.nextEntityId++, unitId: 999, target: { kind: 'building', id }, pos: { x: 492, y: 540 }, ticksRemaining: 1 });
    const events = restored.step();
    expect(restored.state.buildings[0]!.destroyed).toBe(true);
    expect(events.some((event) => event.type === 'buildingDestroyed')).toBe(true);
    expect(restored.state.terrain.blocked[Math.floor(564 / 24) * restored.state.terrain.cols + Math.floor(492 / 24)]).toBe(0);
  });

  it('destroys permanent bridges, clears deck occupants, restores water penalties, and keeps them destroyed after Continue', () => {
    const sim = new Simulation(2026); sim.state.scheduler.prepTicksLeft = 100_000;
    const bridge = sim.state.terrain.bridges![0]!, key = bridgeKey(bridge);
    const deck = sim.state.units[0]!; deck.pos = { x: bridge.x, y: bridge.y }; deck.bridgePosition = { key, level: 'deck' };
    deck.health = 1000;
    sim.state.enemyDemolitionCharges.push({ id: sim.state.nextEntityId++, unitId: 999, target: { kind: 'bridge', key },
      pos: { x: bridge.x, y: bridge.y }, ticksRemaining: 1 });
    const events = sim.step();
    expect(events.some((event) => event.type === 'structureDemolished' && event.kind === 'bridge')).toBe(true);
    expect(sim.state.terrain.bridges!.some((candidate) => bridgeKey(candidate) === key)).toBe(false);
    expect(deck.bridgePosition).toBeUndefined(); expect(deck.health).toBeLessThan(1000);
    expect(sim.terrainEffectsFor(deck).speedMult).toBeLessThan(1);
    // Use an ordinary valid health value for the persisted fixture.
    deck.health = 100;
    const checked = validateSnapshot(sim.snapshot()); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.destroyedBridgeKeys).toContain(key);
    expect(restored.state.terrain.bridges!.some((candidate) => bridgeKey(candidate) === key)).toBe(false);
  });

  it('removes engineer bridges without resurrecting them from their saved list', () => {
    const { sim, tick } = fixture();
    const bridge = { id: sim.state.nextEntityId++, pos: { x: 492, y: 348 }, axis: 'horizontal' as const, halfWidth: 18, halfLength: 72 };
    const surface = { ...bridge.pos, ...bridge, type: 'pontoon' as const };
    sim.state.builtBridges.push(bridge); sim.state.terrain.bridges = [surface];
    const key = bridgeKey(surface);
    sim.state.enemyDemolitionCharges.push({ id: sim.state.nextEntityId++, unitId: 999, target: { kind: 'bridge', key }, pos: { x: 492, y: 348 }, ticksRemaining: 1 });
    tick(1); expect(sim.state.builtBridges).toEqual([]);
    expect(Simulation.fromSnapshot(sim.snapshot()).state.terrain.bridges!.some((candidate) => bridgeKey(candidate) === key)).toBe(false);
  });

  it('lets engineers replace demolished crossings with pontoons that survive Continue', () => {
    const sim = new Simulation(2026); sim.state.scheduler.prepTicksLeft = 100_000; sim.state.points = 100;
    const bridge = sim.state.terrain.bridges![0]!, key = bridgeKey(bridge);
    sim.state.enemyDemolitionCharges.push({ id: sim.state.nextEntityId++, unitId: 999, target: { kind: 'bridge', key },
      pos: { x: bridge.x, y: bridge.y }, ticksRemaining: 1 });
    sim.step();
    sim.spawnFriendly('engineer', { x: bridge.x - 48, y: bridge.y });
    expect(sim.command({ type: 'bridge', pos: { x: bridge.x, y: bridge.y } })).toEqual({ ok: true });
    for (let i = 0; i < sec(CONFIG.construction.bridgeSeconds); i++) sim.step();
    expect(sim.state.builtBridges).toHaveLength(1);
    const restored = Simulation.fromSnapshot(sim.snapshot());
    expect(restored.state.builtBridges).toHaveLength(1);
    expect(restored.state.terrain.bridges!.some((candidate) => bridgeKey(candidate) === key && candidate.type === 'pontoon')).toBe(true);
  });

  it('preserves partial planting and armed fuses in validated saves', () => {
    const { sim, spawn, tick, arm } = fixture(); const { team } = spawn({ x: 492, y: 528 }); tick(45);
    const saved = validateSnapshot(sim.snapshot()); if ('error' in saved) throw new Error(saved.error);
    expect(Simulation.fromSnapshot(saved.snap).state.enemySapperTeams[0]!.plantTicks).toBe(team.plantTicks);
    arm(); tick(60);
    const armed = validateSnapshot(sim.snapshot()); if ('error' in armed) throw new Error(armed.error);
    const a = Simulation.fromSnapshot(armed.snap), b = Simulation.fromSnapshot(JSON.parse(JSON.stringify(armed.snap)));
    expect(a.state.enemyDemolitionCharges[0]!.ticksRemaining).toBe(sec(6));
    for (let i = 0; i < sec(6) + 10; i++) expect(a.step()).toEqual(b.step());
    expect(a.snapshot()).toEqual(b.snapshot()); expect(a.state.bunkers).toEqual([]);
    expect(armed.snap.enemyDemolitionCharges![0]!.ticksRemaining).toBe(sec(6));
  });

  it('retargets a destroyed bunker and never stays stuck on an unreachable structure', () => {
    const { sim, spawn, tick } = fixture(); const { team } = spawn(); tick(1);
    sim.state.bunkers = []; tick(1); expect(team.target).toBeNull();
    sim.state.bunkers.push({ id: sim.state.nextEntityId++, pos: { x: 300, y: 300 } });
    sim.state.terrain.blocked.fill(1);
    tick(90); expect(team.target).toBeNull(); expect(sim.state.enemyDemolitionCharges).toEqual([]);
  });

  it('migrates v28 without inventing missions and rejects corrupt missions, fuses, and bridge keys', () => {
    const { sim, spawn, tick, arm } = fixture(); const old = sim.snapshot(); old.schemaVersion = 28;
    delete old.enemySapperTeams; delete old.enemyDemolitionCharges; delete old.destroyedBridgeKeys;
    const migrated = validateSnapshot(old); if ('error' in migrated) throw new Error(migrated.error);
    expect(migrated.snap.schemaVersion).toBe(30); expect(migrated.snap.enemySapperTeams).toEqual([]);
    spawn({ x: 492, y: 528 }); tick(10);
    for (const change of [{ plantTicks: -1 }, { plantTicks: 121 }, { plantTicks: .5 }, { sapperId: sim.state.units.find((unit) => unit.team === 'friendly')!.id }, { escortIds: [5, 5] }, { target: { kind: 'unknown' } }, { nextPlanTick: Infinity }]) {
      const snap = sim.snapshot(); Object.assign(snap.enemySapperTeams![0]!, change);
      expect('error' in validateSnapshot(snap)).toBe(true);
    }
    arm();
    for (const change of [{ ticksRemaining: 0 }, { ticksRemaining: 241 }, { ticksRemaining: .5 }, { pos: { x: NaN, y: 500 } }, { target: { kind: 'bridge', key: 'bad' } }]) {
      const snap = sim.snapshot(); Object.assign(snap.enemyDemolitionCharges![0]!, change);
      expect('error' in validateSnapshot(snap)).toBe(true);
    }
    const bad = sim.snapshot(); bad.destroyedBridgeKeys = ['not a bridge']; expect('error' in validateSnapshot(bad)).toBe(true);
  });

  it('leaves missions, charges, and bridge destruction behind on the march north', () => {
    const { sim, spawn, arm, tick } = fixture(); spawn(); arm();
    sim.state.destroyedBridgeKeys = ['100:200:horizontal'];
    const friendly = sim.state.units.find((unit) => unit.team === 'friendly')!; friendly.pos.y = CONFIG.crossing.thresholdY;
    tick(1);
    expect(sim.state.mapNumber).toBe(2); expect(sim.state.enemySapperTeams).toEqual([]);
    expect(sim.state.enemyDemolitionCharges).toEqual([]); expect(sim.state.destroyedBridgeKeys).toEqual([]);
  });
});
