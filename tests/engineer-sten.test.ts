import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture(role: 'engineer' | 'radio_engineer') {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false); sim.state.units = []; sim.state.points = 100;
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  expect(sim.command({ type: 'recruit', role, pos: { x: 492, y: 612 } }).ok).toBe(true);
  const soldier = sim.state.units.at(-1)!; soldier.reloadTimer = 0; soldier.grenades = 0;
  sim.spawnEnemy('rifle', { x: 492, y: 432 }); const enemy = sim.state.units.at(-1)!;
  enemy.health = 100_000; enemy.reloadTimer = 100_000;
  const step = () => { enemy.pinned = true; enemy.suppression = CONFIG.suppression.max; return sim.step(); };
  return { sim, soldier, enemy, step };
}

describe.each(['engineer', 'radio_engineer'] as const)('%s STEN loadout', (role) => {
  it('equips recruited and saved engineers with a short-range automatic weapon', () => {
    const { sim, soldier } = fixture(role);
    expect(sim.weaponOf(soldier)).toMatchObject({ name: 'STEN Submachine Gun', kind: 'hitscan', range: 200, burstShots: 8, armorMult: .15 });
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.weaponOf(restored.state.units.find((unit) => unit.id === soldier.id)!)).toEqual(sim.weaponOf(soldier));
    expect(sim.weaponOf(sim.spawnFriendly('rifleman', { x: 600, y: 612 }))?.name).toBe('M1 Garand');
  });

  it('fires an eight-round hitscan burst, reloads, and then starts another burst', () => {
    const { sim, soldier, enemy, step } = fixture(role), weapon = sim.weaponOf(soldier)!;
    const reloadTicks = sim.reloadTicksFor(soldier, weapon);
    const shotTicks: number[] = [];
    for (let i = 0; i < weapon.shotIntervalTicks * 8 + reloadTicks + 5; i++) {
      for (const event of step()) if (event.type === 'shot' && event.shooterId === soldier.id) {
        expect(event.weapon).toBe('STEN Submachine Gun'); shotTicks.push(sim.state.ticks);
      }
    }
    expect(shotTicks.length).toBeGreaterThan(8);
    for (let i = 1; i < 8; i++) expect(shotTicks[i]! - shotTicks[i - 1]!).toBe(weapon.shotIntervalTicks);
    expect(shotTicks[8]! - shotTicks[7]!).toBeGreaterThanOrEqual(reloadTicks);
    expect(enemy.health).toBeLessThan(100_000); expect(sim.state.projectiles).toEqual([]);
  });

  it('cannot fire at rifle range outside the STEN range', () => {
    const { soldier, enemy, step } = fixture(role); enemy.pos.y = soldier.pos.y - 250; enemy.prevPos = { ...enemy.pos };
    for (let i = 0; i < 10; i++) expect(step().some((event) => event.type === 'shot' && event.shooterId === soldier.id)).toBe(false);
  });

  it.each(['pinned', 'moving', 'upgrading'] as const)('holds fire while %s', (condition) => {
    const { soldier, step } = fixture(role);
    if (condition === 'pinned') { soldier.pinned = true; soldier.suppression = CONFIG.suppression.max; }
    if (condition === 'moving') { soldier.path = [{ x: 700, y: 612 }]; soldier.moveGoal = { x: 700, y: 612 }; }
    if (condition === 'upgrading') soldier.upgradeTimer = 100;
    for (let i = 0; i < 5; i++) expect(step().some((event) => event.type === 'shot' && event.shooterId === soldier.id)).toBe(false);
  });
});
