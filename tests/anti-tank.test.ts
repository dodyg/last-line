import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = []; sim.state.points = 100;
  sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  expect(sim.command({ type: 'recruit', role: 'at', pos: { x: 492, y: 612 } }).ok).toBe(true);
  const soldier = sim.state.units.at(-1)!;
  sim.spawnEnemy('vehicle', { x: 492, y: 432 });
  const tank = sim.state.units.at(-1)!;
  tank.pinned = true; tank.suppression = CONFIG.suppression.max; tank.reloadTimer = 100_000;
  soldier.reloadTimer = 0; soldier.morale = 100;
  sim.state.rng.s = 7;
  return { sim, soldier, tank };
}

describe('anti-tank loadout', () => {
  it('equips a recruited soldier with the bazooka and retains it after save/restore', () => {
    const { sim, soldier } = fixture();
    expect(sim.weaponOf(soldier)).toMatchObject({ name: 'M1A1 Bazooka', kind: 'explosive', armorMult: 1.5 });
    const restored = Simulation.fromSnapshot(sim.snapshot());
    expect(restored.weaponOf(restored.state.units.find((unit) => unit.id === soldier.id)!)).toEqual(sim.weaponOf(soldier));
  });

  it('automatically fires a traveling rocket whose impact applies the anti-armor bonus', () => {
    const { sim, soldier, tank } = fixture();
    const healthBefore = tank.health;
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'shot', shooterId: soldier.id, targetId: tank.id, weapon: 'M1A1 Bazooka', hit: true }));
    expect(tank.health).toBe(healthBefore);
    expect(sim.state.projectiles).toHaveLength(1);
    const rocket = sim.state.projectiles[0]!;
    expect(rocket.sourceId).toBe(soldier.id);
    expect(rocket.speed).toBe(260 / CONFIG.tickRate);
    expect(rocket.splashRadius).toBe(32); expect(rocket.armorMult).toBe(1.5); expect(rocket.arc).toBe(false);
    soldier.reloadTimer = 100_000;
    for (let tick = 0; tick < CONFIG.tickRate; tick++) sim.step();
    expect(sim.state.projectiles).toHaveLength(0);
    expect(healthBefore - tank.health).toBeCloseTo(95 * 1.5);
  });
});
