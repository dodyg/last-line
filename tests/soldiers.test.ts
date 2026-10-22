import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation, sec } from '../src/simulation/simulation';
import { soldierName, soldierRank } from '../src/simulation/soldiers';

describe('soldier identity and service records', () => {
  it('keeps identities and ranks stable across saves without consuming combat randomness', () => {
    const sim = new Simulation(42);
    const before = sim.snapshot();
    const names = sim.state.units.map((u) => soldierName(sim.state.seed, u.id));
    expect(new Set(names).size).toBe(names.length);
    expect(sim.snapshot()).toEqual(before);
    const restored = Simulation.fromSnapshot(JSON.parse(JSON.stringify(before)));
    expect(restored.state.units.map((u) => soldierName(restored.state.seed, u.id))).toEqual(names);
    expect(soldierRank(0).name).toBe('Private');
    expect(soldierRank(3).name).toBe('Sergeant');
    expect(soldierRank(100).level).toBe(CONFIG.xp.maxLevel);
  });

  it('counts deaths and breakthroughs once, keeps them separate, and restores the totals', () => {
    const sim = new Simulation(7);
    sim.state.units.forEach((u) => { u.reloadTimer = 1000; });
    const soldier = sim.state.units[0]!;
    sim.spawnEnemy('rifle', { x: soldier.pos.x, y: soldier.pos.y });
    sim.state.strikes.push({ id: 999, pos: { ...soldier.pos }, landTick: 1, radius: 15, damage: 1000, suppressionAmount: 0 });
    sim.step();
    expect(sim.state.battleRecord).toEqual({ enemyKills: 1, casualties: 1, breakthroughs: 0 });
    const scoreAfterKill = sim.state.score;
    sim.spawnEnemy('vehicle', { x: 900, y: CONFIG.breakthroughY + 1 });
    sim.step();
    sim.step();
    expect(sim.state.battleRecord).toEqual({ enemyKills: 1, casualties: 1, breakthroughs: 1 });
    expect(sim.state.score).toBe(scoreAfterKill);
    const snapshot = sim.snapshot();
    const restored = Simulation.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    restored.step();
    expect(restored.state.battleRecord).toEqual(snapshot.battleRecord);
    restored.state.battleRecord.casualties++;
    expect(snapshot.battleRecord.casualties).toBe(1);
  });

  it('credits actual healing and completed construction, then preserves contributions across saves', () => {
    const sim = new Simulation(7);
    sim.state.points = 40;
    expect(sim.command({ type: 'recruit', role: 'medic', pos: { x: 400, y: 660 } }).ok).toBe(true);
    const medic = sim.state.units.find((u) => u.role === 'medic')!;
    const wounded = sim.state.units[0]!;
    wounded.pos = { x: medic.pos.x + 20, y: medic.pos.y };
    wounded.health = 95;
    const events = sim.step();
    expect(medic.service.healthRestored).toBe(5);
    expect(events.find((e) => e.type === 'healed')).toMatchObject({ amount: 5 });
    sim.step();
    expect(medic.service.healthRestored).toBe(5);

    expect(sim.command({ type: 'recruit', role: 'engineer', pos: { x: 700, y: 650 } }).ok).toBe(true);
    const engineer = sim.state.units.find((u) => u.role === 'engineer')!;
    expect(sim.command({ type: 'sandbag', pos: { x: engineer.pos.x, y: 600 } }).ok).toBe(true);
    expect(engineer.service.fortificationsBuilt).toBe(0);
    const snapshot = sim.snapshot();
    const restored = Simulation.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    for (let i = 0; i <= sec(CONFIG.construction.sandbagSeconds); i++) restored.step();
    expect(restored.state.units.find((u) => u.id === engineer.id)!.service.fortificationsBuilt).toBe(1);
    expect(restored.state.units.find((u) => u.id === medic.id)!.service.healthRestored).toBe(5);
    expect(engineer.service.fortificationsBuilt).toBe(0); // detached snapshot
    restored.step();
    expect(restored.state.units.find((u) => u.id === engineer.id)!.service.fortificationsBuilt).toBe(1);
  });

  it('credits enemy kills and XP without rewarding friendly fire', () => {
    const sim = new Simulation(7);
    const shooter = sim.state.units[0]!;
    const ally = sim.state.units[1]!;
    sim.spawnEnemy('rifle', { x: 480, y: 300 });
    const enemy = sim.state.units.find((u) => u.team === 'enemy')!;
    enemy.reloadTimer = 1000;
    for (const target of [enemy, ally]) {
      sim.state.projectiles.push({
        id: sim.state.nextEntityId++, team: 'friendly', sourceId: shooter.id,
        pos: { ...target.pos }, target: { ...target.pos }, speed: 10,
        damage: 1000, splashRadius: 10, armorMult: 1, suppressionAmount: 0, suppressionRadius: 0, arc: false,
      });
      sim.step();
    }
    expect(shooter.kills).toBe(1);
    expect(shooter.xp).toBe(CONFIG.xp.infantryKillXp);
    expect(sim.state.battleRecord).toEqual({ enemyKills: 1, casualties: 1, breakthroughs: 0 });
    const restored = Simulation.fromSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.state.units.find((u) => u.id === shooter.id)!.kills).toBe(1);
  });

  it('accepts older saves and rejects malformed service totals', () => {
    const sim = new Simulation(7);
    const legacy = JSON.parse(JSON.stringify(sim.snapshot()));
    delete legacy.battleRecord;
    legacy.units.forEach((u: { service?: unknown }) => { delete u.service; });
    const migrated = validateSnapshot(legacy);
    expect(migrated).toHaveProperty('snap');
    if ('error' in migrated) throw new Error(migrated.error);
    expect(migrated.snap.battleRecord).toEqual({ enemyKills: 0, casualties: 0, breakthroughs: 0 });
    expect(migrated.snap.units[0]!.service).toEqual({ healthRestored: 0, fortificationsBuilt: 0, grenadesThrown: 0 });
    expect(Simulation.fromSnapshot(migrated.snap).snapshot()).toEqual({ ...migrated.snap, rng: { s: migrated.snap.rng.s >>> 0 } });
    for (const badValue of [-1, Number.NaN, Infinity, 'many', null]) {
      const bad = sim.snapshot();
      (bad.battleRecord as unknown as Record<string, unknown>).casualties = badValue;
      expect(validateSnapshot(bad)).toHaveProperty('error');
      (bad.units[0]!.service as unknown as Record<string, unknown>).healthRestored = badValue;
      bad.battleRecord.casualties = 0;
      expect(validateSnapshot(bad)).toHaveProperty('error');
    }
    const fractional = sim.snapshot();
    fractional.units[0]!.service.fortificationsBuilt = 0.5;
    expect(validateSnapshot(fractional)).toHaveProperty('error');
  });
});
