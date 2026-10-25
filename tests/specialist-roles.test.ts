import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { getContent } from '../src/content/validate';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import { buildingSlot } from '../src/simulation/buildings';
import { crewArcContains, updateCrew } from '../src/simulation/specialists';
import { acquireTarget } from '../src/simulation/combat';
import type { FriendlyRole, EnemyArchetype } from '../src/simulation/types';

function fixture(building = false) {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.terrain.elevation?.heights.fill(0); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  data.buildings = building ? [{ kind: 'barn', name: 'Test barn', col: 10, row: 10, cols: CONFIG.buildings.footprints.barn.cols, rows: CONFIG.buildings.footprints.barn.rows }] : [];
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = []; sim.state.points = 1000;
  sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const enemy = (role: EnemyArchetype, x = 492, y = 372) => {
    sim.spawnEnemy(role, { x, y }); const unit = sim.state.units.at(-1)!;
    unit.reloadTimer = 100_000; unit.secondaryReloadTimer = 100_000; unit.morale = 100; return unit;
  };
  const tick = (n: number) => Array.from({ length: n }, () => sim.step()).flat();
  return { sim, enemy, tick };
}

describe('specialist roles', () => {
  it.each(['scout','heavy_mg','assault_infantry','at_gun'] as FriendlyRole[])('recruits %s and preserves its loadout through save validation', (role) => {
    const { sim } = fixture();
    expect(sim.command({ type: 'recruit', role, pos: { x: 492, y: 612 } }).ok).toBe(true);
    const unit = sim.state.units.at(-1)!;
    expect(sim.weaponOf(unit)).not.toBeNull();
    expect(sim.state.points).toBe(1000-CONFIG.costs.recruit[role]);
    expect(validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())))).toHaveProperty('snap');
    expect(Simulation.fromSnapshot(sim.snapshot()).weaponOf(unit)).toEqual(sim.weaponOf(unit));
  });

  it.each(['heavy_mg','at_gun'] as FriendlyRole[])('%s deploys before firing and packs before moving', (role) => {
    const { sim, enemy, tick } = fixture();
    const crew = sim.spawnFriendly(role, { x: 492, y: 612 });
    const target = enemy('vehicle', 492, 432);
    crew.grenades = 0;
    const setup = role === 'at_gun' ? 4 : 3;
    expect(tick(CONFIG.tickRate*setup-1).some((e) => e.type === 'shot' && e.shooterId === crew.id)).toBe(false);
    const fired = sim.step(); expect(fired).toContainEqual(expect.objectContaining({ type: 'shot', shooterId: crew.id }));
    expect(crew.deployment?.ticks).toBe(0);
    expect(sim.command({ type: 'move', unitId: crew.id, pos: { x: 612, y: 612 } }).ok).toBe(true);
    const before = { ...crew.pos };
    sim.step(); expect(crew.pos).toEqual(before); expect(crew.deployment!.packingTicks).toBeGreaterThan(0);
    target.reloadTimer = 100_000;
    tick(CONFIG.tickRate*3+1); expect(crew.pos.x).toBeGreaterThan(before.x);
  });

  it('traverses slowly to a flank, resets setup, and refuses shots outside the firing arc', () => {
    const { sim, enemy } = fixture(); const gun = sim.spawnFriendly('at_gun', { x: 492, y: 612 });
    const target = enemy('vehicle', 700, 612);
    gun.deployment = { ticks: 0, packingTicks: 0, facing: -Math.PI/2 };
    expect(crewArcContains(gun, target.pos)).toBe(false);
    expect(sim.fireShot(gun, target, sim.weaponOf(gun)!)).toBe(false);
    updateCrew(gun,target,false); expect(gun.deployment.ticks).toBe(CONFIG.tickRate*4);
    expect(gun.deployment.facing).toBeGreaterThan(-Math.PI/2);
    expect(gun.deployment.facing).toBeLessThan(-1.5);
  });

  it('enemy machine gun teams establish a suppression position instead of bounding', () => {
    const { sim, enemy, tick } = fixture(); const defender = sim.spawnFriendly('rifleman',{ x: 492,y: 612 }); defender.reloadTimer = 100_000; defender.grenades=0;
    const team = enemy('mg_team',492,372); team.reloadTimer=0;
    const before = { ...team.pos }; const events = tick(100);
    expect(team.pos).toEqual(before);
    expect(events).toContainEqual(expect.objectContaining({ type: 'shot',shooterId: team.id,weapon:'MG 42 Tripod' }));
    expect(defender.suppression).toBeGreaterThan(0);
  });

  it('enemy anti-tank infantry ignore infantry and need two seconds to aim at trucks', () => {
    const { sim, enemy, tick } = fixture();
    const at = enemy('at_infantry',492,432); at.reloadTimer=0;
    const rifle = sim.spawnFriendly('rifleman',{ x: 492,y: 552 }); rifle.reloadTimer=100_000; rifle.grenades=0;
    tick(2); expect(at.targetId).toBeNull();
    const truck = sim.spawnFriendly('gun_truck',{ x: 492,y: 612 }); truck.reloadTimer=100_000;
    expect(tick(59).some((e) => e.type === 'shot' && e.shooterId === at.id)).toBe(false);
    expect(sim.step()).toContainEqual(expect.objectContaining({ type:'shot',shooterId:at.id,targetId:truck.id }));
  });

  it('sharpshooters prioritize support soldiers and reveal themselves when firing', () => {
    const { sim, enemy } = fixture();
    const sniper = enemy('sharpshooter',492,350); sniper.reloadTimer=0;
    const rifle = sim.spawnFriendly('rifleman',{ x:492,y:500 }); rifle.reloadTimer=100_000; rifle.grenades=0;
    const medic = sim.spawnFriendly('medic',{ x:520,y:580 });
    const picked = acquireTarget(getContent(),sim.state.terrain,[],sniper,[rifle,medic],sim.weaponOf(sniper)!,CONFIG);
    expect(picked?.id).toBe(medic.id);
    expect(sim.step()).toContainEqual(expect.objectContaining({ type:'shot',shooterId:sniper.id,targetId:medic.id }));
    expect(sniper.revealedUntil).toBeGreaterThan(sim.state.ticks);
  });

  it('field officers accelerate pin recovery for their own side', () => {
    const a = fixture(), b = fixture();
    const supported = a.enemy('rifle'), alone = b.enemy('rifle'); a.enemy('field_officer',516,372);
    for (const u of [supported,alone]) { u.pinned=true;u.suppression=65;u.morale=50; }
    a.tick(10); b.tick(10);
    expect(supported.suppression).toBeLessThan(alone.suppression);
    expect(supported.morale).toBeGreaterThan(alone.morale);
  });

  it('scouts expose infiltrators at range and smoke blocks their observation', () => {
    const { sim, enemy } = fixture(); const infiltrator = enemy('infiltrator',492,350);
    sim.spawnFriendly('rifleman',{ x:492,y:612 }).reloadTimer=100_000;
    sim.step(); expect(infiltrator.detectedUntil ?? 0).toBe(0);
    const scout = sim.spawnFriendly('scout',{ x:516,y:612 }); scout.reloadTimer=100_000;
    expect(sim.scoutObserves(infiltrator)).toBe(true); sim.step(); expect(infiltrator.detectedUntil).toBeGreaterThan(sim.state.ticks);
    sim.state.smokes.push({ id:sim.state.nextEntityId++,pos:{x:504,y:480},radius:65,ticksRemaining:300 });
    expect(sim.scoutObserves(infiltrator)).toBe(false);
    scout.pinned=true; expect(sim.scoutObserves(infiltrator)).toBe(false);
  });

  it('infiltrators keep advancing silently past distant defenders', () => {
    const { sim, enemy, tick } = fixture(); const infiltrator=enemy('infiltrator',60,300); infiltrator.reloadTimer=0;
    const defender=sim.spawnFriendly('rifleman',{x:150,y:450}); defender.reloadTimer=100_000;defender.grenades=0;
    const before={...infiltrator.pos};
    expect(tick(120).some((e)=>e.type==='shot' && e.shooterId===infiltrator.id)).toBe(false);
    expect(infiltrator.pos).not.toEqual(before); expect(infiltrator.moveGoal!.y).toBeGreaterThan(CONFIG.lineY);
    expect(infiltrator.path.some((p)=>p.x>250)).toBe(true);
  });

  it('assault infantry clear occupied buildings then take the ordered position', () => {
    const { sim, enemy, tick } = fixture(true); const building=sim.state.buildings[0]!;
    const assault=sim.spawnFriendly('assault_infantry',{x:300,y:360}); assault.grenades=0;
    const defender=enemy('rifle',300,240); defender.buildingPosition={buildingId:building.id,level:0,slot:4};
    defender.pos=buildingSlot(building,defender.buildingPosition,24); defender.prevPos={...defender.pos};
    expect(sim.command({type:'garrison',unitIds:[assault.id],buildingId:building.id,level:0}).ok).toBe(true);
    expect(assault.clearBuilding?.buildingId).toBe(building.id);
    expect(validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())))).toHaveProperty('snap');
    tick(600); expect(defender.health).toBeLessThanOrEqual(0); expect(assault.buildingPosition?.buildingId).toBe(building.id);
    expect(assault.clearBuilding).toBeUndefined();
  });

  it('scout observation halves mortar scatter without bypassing smoke', () => {
    const impact = (observed: boolean) => {
      const { sim, enemy } = fixture();
      const mortar = sim.spawnFriendly('mortarman', { x: 492, y: 612 }); mortar.mortarTimer = 0;
      const spotter = sim.spawnFriendly(observed ? 'scout' : 'rifleman', { x: 516, y: 550 });
      spotter.reloadTimer = 100_000; spotter.grenades = 0;
      const target = enemy('rifle', 492, 350); target.pinned = true; target.suppression = CONFIG.suppression.max;
      sim.state.rng.s = 42;
      sim.step(); const strike = sim.state.strikes.find((s) => s.delivery === 'mortar')!;
      return Math.hypot(strike.pos.x - target.pos.x, strike.pos.y - target.pos.y);
    };
    expect(impact(true)).toBeCloseTo(impact(false) * .5);
  });

  it('continues specialist deployment and aim deterministically after save/restore', () => {
    const { sim, enemy, tick } = fixture();
    sim.spawnFriendly('heavy_mg', { x: 492, y: 612 });
    sim.spawnFriendly('gun_truck', { x: 540, y: 612 }).reloadTimer = 100_000;
    enemy('at_infantry', 540, 420).reloadTimer = 0; tick(12);
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const a = Simulation.fromSnapshot(saved.snap), b = Simulation.fromSnapshot(saved.snap);
    for (let i = 0; i < 120; i++) expect(a.step()).toEqual(b.step());
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('a new move order cancels building clearing and weapon crews cannot run or garrison a gun', () => {
    const { sim, enemy } = fixture(true); const building = sim.state.buildings[0]!;
    const assault = sim.spawnFriendly('assault_infantry', { x: 300, y: 360 });
    const defender = enemy('rifle'); defender.buildingPosition = { buildingId: building.id, level: 0, slot: 4 };
    defender.pos = buildingSlot(building, defender.buildingPosition, 24); defender.prevPos = { ...defender.pos };
    expect(sim.command({ type: 'garrison', unitIds: [assault.id], buildingId: building.id, level: 0 }).ok).toBe(true);
    expect(sim.command({ type: 'moveGroup', unitIds: [assault.id], pos: { x: 600, y: 612 } }).ok).toBe(true);
    expect(assault.clearBuilding).toBeUndefined();
    const gun = sim.spawnFriendly('at_gun', { x: 492, y: 612 });
    expect(sim.command({ type: 'pace', unitIds: [gun.id], pace: 'run' }).ok).toBe(false);
    defender.health = 0; defender.dead = true;
    expect(sim.command({ type: 'garrison', unitIds: [gun.id], buildingId: building.id, level: 0 }).ok).toBe(false);
  });

  it('validates specialist state and rejects corrupt saved timers', () => {
    const { sim, enemy }=fixture(); const gun=sim.spawnFriendly('heavy_mg',{x:492,y:612}); enemy('mg_team'); sim.step();
    expect(validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())))).toHaveProperty('snap');
    gun.deployment!.ticks=-1;
    expect(validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())))).toEqual({error:'Corrupt weapon crew deployment.'});
  });

  it('introduces every new enemy in authored waves and retains them in endless composition', () => {
    const waves=getContent().waves;
    for (const role of ['mg_team','sharpshooter','field_officer','at_infantry','infiltrator']) {
      expect(waves.some((w)=>w.composition.some((c)=>c.archetype===role))).toBe(true);
      expect(waves.at(-1)!.composition.some((c)=>c.archetype===role)).toBe(true);
    }
  });
});
