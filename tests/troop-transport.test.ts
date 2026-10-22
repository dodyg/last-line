import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { getContent } from '../src/content/validate';
import { validateSnapshot } from '../src/persistence';
import { isVehicle } from '../src/simulation/combat';
import { canRun } from '../src/simulation/movement';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import { buildSpawnQueue } from '../src/simulation/waves';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data), defender = sim.state.units[0]!;
  sim.state.units = [defender]; defender.pos = { x: 780, y: 660 }; defender.prevPos = { ...defender.pos };
  defender.reloadTimer = 100_000; defender.grenades = 0;
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  sim.spawnEnemy('troop_transport', { x: 360, y: 60 });
  const truck = sim.state.units.at(-1)!;
  const tick = (n: number) => { const events = []; for (let i = 0; i < n; i++) events.push(...sim.step()); return events; };
  const passengers = () => sim.state.units.filter((u) => u.team === 'enemy' && u.role === 'rifle' && !u.dead && u.health > 0);
  const destroy = () => {
    const weapon = { ...getContent().weapons.rifle!, damage: 10_000, range: 10_000, accuracy: 1 };
    for (let i = 0; i < 20 && !truck.dead; i++) sim.fireShot(defender, truck, weapon);
    expect(truck.dead).toBe(true);
  };
  return { sim, truck, defender, tick, passengers, destroy };
}

describe('enemy troop transport', () => {
  it('is a fast, unarmed vehicle with six embarked passengers and no infantry running bonus', () => {
    const { sim, truck, passengers } = fixture();
    expect(isVehicle(getContent(), truck)).toBe(true); expect(canRun(truck)).toBe(false);
    expect(getContent().enemy.troop_transport.speed).toBeGreaterThan(getContent().enemy.rifle.speed * 2);
    expect(sim.weaponOf(truck)).toBeNull(); expect(truck.transport!.passengers).toBe(6); expect(passengers()).toHaveLength(0);
  });

  it('drives to its drop-off and unloads exactly six distinct riflemen in a single event', () => {
    const { sim, truck, tick, passengers } = fixture();
    tick(90); expect(truck.pos.y).toBeGreaterThan(180); expect(passengers()).toHaveLength(0);
    const events = tick(180);
    expect(events.filter((event) => event.type === 'transportUnloaded')).toEqual([
      { type: 'transportUnloaded', unitId: truck.id, count: 6, pos: expect.any(Object) },
    ]);
    expect(passengers()).toHaveLength(6); expect(new Set(passengers().map((u) => u.id)).size).toBe(6);
    expect(truck.transport!.passengers).toBe(0);
    expect(passengers().every((u) => u.health > 0 && u.team === 'enemy')).toBe(true);
    const integrity = sim.state.integrity; tick(500);
    expect(sim.state.units.some((u) => u.id === truck.id)).toBe(false);
    expect(sim.state.battleRecord.enemyKills).toBe(0);
    expect(sim.state.integrity).toBeLessThanOrEqual(integrity); // Only dismounted infantry can break through.
    expect(tick(60).some((e) => e.type === 'transportUnloaded')).toBe(false);
  });

  it('kills all six passengers and awards their kills when destroyed before unloading', () => {
    const { sim, truck, defender, destroy, tick, passengers } = fixture();
    destroy(); expect(truck.transport!.passengers).toBe(0);
    expect(sim.state.battleRecord.enemyKills).toBe(7); expect(defender.kills).toBe(7);
    expect(sim.state.score).toBe(getContent().enemy.troop_transport.killValue + 6 * getContent().enemy.rifle.killValue);
    expect(tick(1)).toContainEqual({ type: 'transportPassengersKilled', unitId: truck.id, count: 6, pos: expect.any(Object) });
    tick(600); expect(passengers()).toHaveLength(0); expect(sim.state.battleRecord.enemyKills).toBe(7);
  });

  it('keeps passengers aboard during the unloading stop so destroying it then kills everyone', () => {
    const { truck, tick, destroy, passengers } = fixture();
    truck.pos = { ...truck.transport!.dropOff }; truck.prevPos = { ...truck.pos };
    tick(Math.floor(CONFIG.tickRate / 2)); expect(truck.transport!.unloadTicks).toBeGreaterThan(0);
    expect(passengers()).toHaveLength(0); destroy(); tick(90); expect(passengers()).toHaveLength(0);
  });

  it('does not kill soldiers who already dismounted when the empty truck is destroyed', () => {
    const { sim, truck, tick, destroy, passengers } = fixture();
    truck.pos = { ...truck.transport!.dropOff }; truck.prevPos = { ...truck.pos };
    tick(CONFIG.tickRate + 2); expect(passengers()).toHaveLength(6);
    destroy(); expect(sim.state.battleRecord.enemyKills).toBe(1); expect(passengers()).toHaveLength(6);
  });

  it('waits to unload if safe ground for the whole squad is blocked, then resumes', () => {
    const { sim, truck, tick, passengers } = fixture();
    truck.pos = { ...truck.transport!.dropOff }; truck.prevPos = { ...truck.pos };
    const terrain = sim.state.terrain; terrain.blocked.fill(1);
    terrain.blocked[Math.floor(truck.pos.y / terrain.cell) * terrain.cols + Math.floor(truck.pos.x / terrain.cell)] = 0;
    tick(70); expect(passengers()).toHaveLength(0); expect(truck.transport!.passengers).toBe(6);
    terrain.blocked.fill(0); tick(60); expect(passengers()).toHaveLength(6);
  });

  it('uses a nearby reachable drop-off when the original destination is enclosed', () => {
    const { sim, truck, tick, passengers } = fixture(); const terrain = sim.state.terrain;
    const col = Math.floor(truck.transport!.dropOff.x / terrain.cell), row = Math.floor(truck.transport!.dropOff.y / terrain.cell);
    for (let y = row - 1; y <= row + 1; y++) for (let x = col - 1; x <= col + 1; x++) {
      if (x !== col || y !== row) terrain.blocked[y * terrain.cols + x] = 1;
    }
    let unloaded = false;
    for (let i = 0; i < 500 && !unloaded; i++) unloaded = tick(1).some((event) => event.type === 'transportUnloaded');
    expect(unloaded).toBe(true); expect(passengers()).toHaveLength(6);
    for (const unit of passengers()) expect(terrain.blocked[Math.floor(unit.pos.y / terrain.cell) * terrain.cols + Math.floor(unit.pos.x / terrain.cell)]).toBe(0);
  });

  it('reserves enemy-cap slots for passengers while the transport is in the spawn queue and on the field', () => {
    const { sim, truck } = fixture(); sim.state.units = sim.state.units.filter((u) => u.id !== truck.id);
    for (let i = 0; i < CONFIG.caps.liveEnemies - 6; i++) sim.spawnEnemy('rifle', { x: 100 + i * 24, y: 60 });
    Object.assign(sim.state.scheduler, { phase: 'spawning', spawnQueue: ['troop_transport'], spawnTimer: 0 });
    sim.step(); expect(sim.state.scheduler.spawnQueue).toEqual(['troop_transport']);
    const removable = sim.state.units.find((u) => u.team === 'enemy')!; removable.dead = true; removable.health = 0;
    sim.step(); expect(sim.state.scheduler.spawnQueue).toEqual([]);
    expect(sim.state.units.filter((u) => u.team === 'enemy').reduce((n, u) => n + 1 + (u.transport?.passengers ?? 0), 0)).toBe(CONFIG.caps.liveEnemies);
  });

  it('preserves passenger count and unloading progress through a validated save without duplicate deployment', () => {
    const sim = new Simulation(2026); sim.state.scheduler.prepTicksLeft = 100_000;
    for (const u of sim.state.units) { u.reloadTimer = 100_000; u.grenades = 0; }
    sim.spawnEnemy('troop_transport', { x: 360, y: 480 }); const truck = sim.state.units.at(-1)!;
    truck.transport!.dropOff = { ...truck.pos }; for (let i = 0; i < 10; i++) sim.step();
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.units.find((u) => u.id === truck.id)!.transport).toEqual(truck.transport);
    const events = []; for (let i = 0; i < 120; i++) events.push(...restored.step());
    expect(events.filter((e) => e.type === 'transportUnloaded')).toHaveLength(1);
    expect(restored.state.units.filter((u) => u.team === 'enemy' && u.role === 'rifle')).toHaveLength(6);
    const again = Simulation.fromSnapshot(restored.snapshot());
    const later = []; for (let i = 0; i < 30; i++) later.push(...again.step());
    expect(later.some((e) => e.type === 'transportUnloaded')).toBe(false);
  });

  it('introduces transports in wave six and keeps them in later and endless waves', () => {
    const content = getContent();
    expect(content.waves.slice(0, 5).some((wave) => wave.composition.some((part) => part.archetype === 'troop_transport'))).toBe(false);
    expect(content.waves[5]!.composition).toContainEqual({ archetype: 'troop_transport', count: 1 });
    const { sim } = fixture(); sim.state.scheduler.waveIndex = 15;
    expect(buildSpawnQueue({ s: 2026 }, sim.state.scheduler, true).queue).toContain('troop_transport');
  });

  it.each(['passengers', 'dropOff', 'unloadTicks', 'retryTick'])('rejects corrupt saved transport %s', (key) => {
    const { sim } = fixture(); const snapshot = JSON.parse(JSON.stringify(sim.snapshot()));
    snapshot.units.find((u: { role: string }) => u.role === 'troop_transport').transport[key] = -1;
    expect(validateSnapshot(snapshot)).toHaveProperty('error');
  });
});
