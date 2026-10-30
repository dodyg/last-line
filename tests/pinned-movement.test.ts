import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { buildingSlot } from '../src/simulation/buildings';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, TERRAIN_KIND } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  data.buildings = [{ kind: 'barn', name: 'Cover barn', col: 8, row: 11, cols: 2, rows: 2 }];
  // Preserve cell-by-cell routes, as on the current elevated maps.
  data.terrain.elevation = { cell: 12, cols: 81, rows: 61, heights: new Float32Array(81 * 61) };
  const sim = new Simulation(2026, undefined, data, false);
  const friendly = sim.state.units[0]!;
  sim.state.units = [friendly];
  friendly.pos = { x: 180, y: 400 }; friendly.prevPos = { ...friendly.pos };
  friendly.reloadTimer = 100_000; friendly.grenades = 0;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  sim.state.scheduler.prepTicksLeft = 100_000;
  sim.spawnEnemy('rifle', { x: 180, y: 240 });
  const enemy = sim.state.units.at(-1)!;
  enemy.reloadTimer = 100_000; enemy.grenades = 0; enemy.buildingCooldown = 100_000;
  return { sim, friendly, enemy };
}

describe('support traffic through a settled line', () => {
  it('lets a moving supply officer pass a dense row without being pushed backwards', () => {
    const { sim, friendly } = fixture();
    sim.state.units = [friendly];
    friendly.role = 'supply_officer';
    friendly.pos = { x: 200, y: 600 }; friendly.prevPos = { ...friendly.pos };
    for (let index = 0; index < 6; index++) {
      const parked = structuredClone(friendly);
      parked.id = sim.state.nextEntityId++; parked.role = 'rifleman';
      parked.pos = { x: 330 + index * 8, y: 600 }; parked.prevPos = { ...parked.pos };
      parked.path = []; parked.moveGoal = null;
      sim.state.units.push(parked);
    }
    expect(sim.command({ type: 'move', unitId: friendly.id, pos: { x: 600, y: 600 } }).ok).toBe(true);
    for (let tick = 0; tick < 360; tick++) sim.step();
    expect(friendly.pos.x).toBeGreaterThan(450);
  });
});

describe('holding position under fire', () => {
  it.each([24, 52])('does not keep walking back into an occupied slot after yielding %s pixels', (distance) => {
    const { sim, friendly } = fixture();
    sim.state.units = [friendly];
    friendly.pos = { x: 360 - distance, y: 600 }; friendly.prevPos = { ...friendly.pos };
    friendly.moveGoal = { x: 360, y: 600 }; friendly.path = [];
    const parked = structuredClone(friendly); parked.id = sim.state.nextEntityId++; parked.role = 'gun_truck';
    parked.pos = { x: 360, y: 600 }; parked.prevPos = { ...parked.pos }; parked.moveGoal = null;
    sim.state.units.push(parked);
    for (let tick = 0; tick < 120; tick++) {
      sim.step();
      expect(friendly.path).toEqual([]);
      expect(friendly.running).toBe(false);
    }
    // A deliberate order remains available after settling beside the vehicle.
    expect(sim.command({ type: 'move', unitId: friendly.id, pos: { x: 240, y: 600 } }).ok).toBe(true);
    sim.step(); expect(friendly.path.length).toBeGreaterThan(0);
  });

  it.each(['friendly', 'enemy'] as const)('keeps pinned %s soldiers still while nearby allies yield', (team) => {
    const { sim, friendly, enemy } = fixture();
    const pinned = team === 'friendly' ? friendly : enemy;
    const ally = structuredClone(pinned); ally.id = sim.state.nextEntityId++;
    ally.pos = { x: pinned.pos.x + 2, y: pinned.pos.y }; ally.prevPos = { ...ally.pos };
    ally.morale = 0; ally.path = []; ally.moveGoal = null;
    // Exercise both orderings in the pairwise collision pass.
    sim.state.units = team === 'friendly' ? [pinned, ally] : [ally, pinned];
    const origin = { ...pinned.pos }, allyOrigin = { ...ally.pos };
    for (let tick = 0; tick < 30; tick++) {
      pinned.suppression = CONFIG.suppression.max;
      pinned.path = [{ x: origin.x + 100, y: origin.y }];
      sim.step();
      expect(pinned.pinned).toBe(true);
      expect(pinned.pos).toEqual(origin);
      expect(pinned.path).toEqual([]);
    }
    expect(ally.pos).not.toEqual(allyOrigin);
  });

  it('keeps a pinned building occupant at its window through automatic exit checks', () => {
    const { sim, enemy } = fixture();
    sim.state.units = [enemy];
    const building = sim.state.buildings[0]!;
    enemy.buildingPosition = { buildingId: building.id, level: 0, slot: 0 };
    enemy.pos = buildingSlot(building, enemy.buildingPosition, sim.state.terrain.cell);
    const origin = { ...enemy.pos };
    sim.state.ticks = 89 - enemy.id % 90;
    enemy.suppression = CONFIG.suppression.max;
    sim.step();
    expect(enemy.pinned).toBe(true);
    expect(enemy.buildingPosition).toBeDefined();
    expect(enemy.pos).toEqual(origin);
  });

  it('follows the chosen cover route without replacing its next waypoint every tick', () => {
    const { sim, friendly, enemy } = fixture();
    friendly.health = 10_000;
    sim.step(); sim.step();
    const goal = { ...enemy.moveGoal! };
    expect(enemy.path.length).toBeGreaterThan(1);
    const nextWaypoint = { ...enemy.path[0]! };
    // Stay with that waypoint until reaching it, even after crossing a grid edge.
    for (let tick = 0; tick < 100 && enemy.path[0]?.x === nextWaypoint.x && enemy.path[0]?.y === nextWaypoint.y; tick++) {
      const before = Math.hypot(enemy.pos.x - nextWaypoint.x, enemy.pos.y - nextWaypoint.y);
      sim.step();
      expect(enemy.moveGoal).toEqual(goal);
      // A cover shadow can start before the chosen cell center: settle there.
      if (enemy.path.length === 0) { expect(enemy.advance).toBe(false); break; }
      expect(Math.hypot(enemy.pos.x - nextWaypoint.x, enemy.pos.y - nextWaypoint.y)).toBeLessThan(before);
      if (Math.hypot(enemy.pos.x - nextWaypoint.x, enemy.pos.y - nextWaypoint.y) > .001) expect(enemy.path[0]).toEqual(nextWaypoint);
    }
  });

  it('holds cover under continued fire instead of bounding out and retreating again', () => {
    const { sim, friendly, enemy } = fixture();
    friendly.health = 10_000;
    // Behind the barn: enemy fire is obstructed, but incoming suppression persists.
    enemy.pos = { x: 216, y: 240 }; enemy.prevPos = { ...enemy.pos };
    const origin = { ...enemy.pos };
    for (let tick = 0; tick < CONFIG.enemy.bounding.windowTicks * 2; tick++) {
      enemy.targetId = friendly.id;
      enemy.suppression = CONFIG.suppression.recoverThreshold + 1;
      sim.step();
      expect(enemy.pos).toEqual(origin);
      expect(enemy.path).toEqual([]);
    }
  });

  it('returns fire from a low fence throughout the bounding cycle', () => {
    const { sim, friendly, enemy } = fixture();
    friendly.pos = { x: 360, y: 400 }; friendly.prevPos = { ...friendly.pos };
    enemy.pos = { x: 360, y: 260 }; enemy.prevPos = { ...enemy.pos };
    sim.state.terrain.kinds![11 * sim.state.terrain.cols + 15] = TERRAIN_KIND.stoneFence;
    enemy.reloadTimer = 0; enemy.shotTimer = 0;
    const origin = { ...enemy.pos };
    let shots = 0;
    for (let tick = 0; tick < CONFIG.enemy.bounding.windowTicks * 2; tick++) {
      shots += sim.step().filter((event) => event.type === 'shot' && event.shooterId === enemy.id).length;
      expect(enemy.pos).toEqual(origin);
    }
    expect(shots).toBeGreaterThan(0);
  });

  it('resumes movement once a pin has recovered and no threat holds it in cover', () => {
    const { sim, enemy } = fixture();
    sim.state.units = [enemy];
    enemy.pos = { x: 360, y: 240 }; enemy.prevPos = { ...enemy.pos };
    enemy.suppression = CONFIG.suppression.max;
    const origin = { ...enemy.pos };
    sim.step(); expect(enemy.pinned).toBe(true); expect(enemy.pos).toEqual(origin);
    for (let tick = 0; tick < 150; tick++) sim.step();
    expect(enemy.pinned).toBe(false);
    expect(enemy.pos).not.toEqual(origin);
    expect(enemy.path.length).toBeGreaterThan(0);
  });
});
