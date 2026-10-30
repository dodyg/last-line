import { describe, expect, it } from 'vitest';
import { ARMORY, canIssueWeapon, weaponChoices, WEAPON_ISSUE_SECONDS } from '../src/content/armory';
import { getContent } from '../src/content/validate';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation, sec } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(42, false, 2);
  data.kinds.fill(0); data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.terrain.elevation = undefined; data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(42, undefined, data, false);
  const unit = sim.state.units[0]!;
  sim.state.units = [unit];
  sim.state.points = 100;
  sim.command({ type: 'recruit', role: 'supply_officer', pos: { x: 240, y: 660 } });
  const officer = sim.state.units.at(-1)!;
  officer.pos = { x: 210, y: 400 }; officer.prevPos = { ...officer.pos }; sim.state.points = 100; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  unit.pos = { x: 200, y: 400 }; unit.prevPos = { ...unit.pos }; unit.grenades = 0; unit.reloadTimer = 0;
  return { sim, unit, officer, equip: (weaponId: string) => sim.command({ type: 'equipWeapon', unitId: unit.id, weaponId }) };
}

describe('personal weapon issue', () => {
  it('offers ten described weapons with contrasting range, accuracy, and cadence', () => {
    const content = getContent();
    expect(ARMORY).toHaveLength(10);
    for (const issue of ARMORY) {
      expect(content.weapons[issue.id]).toBeDefined();
      expect(issue.description.length).toBeGreaterThan(60);
      expect(issue.source).toMatch(/^https:\/\//);
    }
    expect(content.weapons.m3!.range).toBeLessThan(content.weapons.scout_carbine!.range);
    expect(content.weapons.scout_carbine!.range).toBeLessThan(content.weapons.rifle!.range);
    expect(content.weapons.rifle!.reloadTicks).toBeLessThan(content.weapons.springfield!.reloadTicks);
    expect(content.weapons.m3!.shotIntervalTicks).toBeGreaterThan(content.weapons.thompson!.shotIntervalTicks);
    expect(content.weapons.bren!.accuracy).toBeGreaterThan(content.weapons.mg!.accuracy);
  });

  it('charges once, cancels the old burst and ambush, and retains individual training', () => {
    const { sim, unit, equip } = fixture();
    unit.weaponUpgrades.accuracy = 2; unit.burstRemaining = 10; unit.targetId = 99;
    unit.ambush = { facing: 0, range: 200, arcDegrees: 90, prepTicks: 0, triggered: true, bonusShots: 10 };
    const attributes = structuredClone(unit.attributes);
    expect(equip('m3')).toEqual({ ok: true });
    expect(sim.weaponOf(unit)?.name).toBe('M1 Garand');
    expect(sim.state.points).toBe(100);
    sim.step();
    expect(sim.weaponOf(unit)?.name).toBe('M3 Grease Gun');
    expect(sim.state.points).toBe(98); expect(unit.upgradeTimer).toBeGreaterThanOrEqual(sec(WEAPON_ISSUE_SECONDS) - 1);
    expect(unit.burstRemaining).toBe(0); expect(unit.targetId).toBeNull(); expect(unit.ambush).toBeUndefined();
    expect(unit.weaponUpgrades.accuracy).toBe(2); expect(unit.attributes).toEqual(attributes);
    const saved = sim.snapshot();
    expect(equip('m3').ok).toBe(false); expect(sim.snapshot()).toEqual(saved);
  });

  it('requires a separate living Supply Officer before accepting an order', () => {
    const { sim, unit, officer, equip } = fixture();
    sim.state.units = [unit];
    const before = sim.snapshot();
    expect(equip('m3')).toMatchObject({ ok: false, reason: expect.stringContaining('Supply Officer') });
    expect(sim.snapshot()).toEqual(before);
    officer.dead = true; sim.state.units.push(officer);
    expect(equip('m3').ok).toBe(false);
  });

  it('routes delivery to a moving soldier, preserves pending orders in saves, and charges only at handover', () => {
    const { sim, unit, officer, equip } = fixture();
    officer.pos = { x: 500, y: 400 }; officer.prevPos = { ...officer.pos };
    expect(equip('m3').ok).toBe(true);
    expect(unit.pendingWeaponId).toBe('m3');
    expect(officer.supplyTargetId).toBe(unit.id);
    expect(officer.path.length).toBeGreaterThan(0);
    const pending = sim.snapshot();
    expect(equip('scout_carbine').ok).toBe(false);
    expect(sim.snapshot()).toEqual(pending);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(pending)));
    if ('error' in checked) throw new Error(checked.error);
    const resumed = Simulation.fromSnapshot(checked.snap);
    expect(resumed.state.units[0]!.pendingWeaponId).toBe('m3');
    for (const invalid of [null, 12, 'shell', 'unknown', 'sniper']) {
      const corrupt = JSON.parse(JSON.stringify(pending)); corrupt.units[0].pendingWeaponId = invalid;
      expect(validateSnapshot(corrupt)).toHaveProperty('error');
    }
    for (let i = 0; i < 600 && resumed.state.units[0]!.pendingWeaponId; i++) resumed.step();
    expect(resumed.state.units[0]!.assignedWeaponId).toBe('m3');
    expect(resumed.state.points).toBe(98);
    unit.pos = { x: 250, y: 500 }; unit.prevPos = { ...unit.pos };
    sim.state.points = 0;
    for (let i = 0; i < 600; i++) sim.step();
    expect(unit.assignedWeaponId).toBeUndefined();
    expect(unit.pendingWeaponId).toBe('m3');
    sim.state.points = 100;
    for (let i = 0; i < 60 && unit.pendingWeaponId; i++) sim.step();
    expect(unit.assignedWeaponId).toBe('m3');
    expect(unit.pendingWeaponId).toBeUndefined();
    expect(sim.state.points).toBe(98);
  });

  it('reassigns a delivery after the supplier dies and cancels when given a replacement order', () => {
    const { sim, unit, officer, equip } = fixture();
    officer.pos = { x: 500, y: 400 }; officer.prevPos = { ...officer.pos };
    expect(equip('m3').ok).toBe(true);
    officer.dead = true; officer.health = 0;
    sim.step();
    expect(unit.pendingWeaponId).toBe('m3');
    sim.command({ type: 'recruit', role: 'supply_officer', pos: { x: 240, y: 660 } });
    const replacement = sim.state.units.at(-1)!;
    sim.step();
    expect(replacement.supplyTargetId).toBe(unit.id);
    expect(sim.command({ type: 'move', unitId: replacement.id, pos: { x: 500, y: 600 } }).ok).toBe(true);
    expect(unit.pendingWeaponId).toBeUndefined();
    expect(sim.state.points).toBe(94);
  });

  it.each(['unknown', 'shell', '__proto__', 'sniper', 'bren'])('rejects incompatible or unknown issue %s without mutation', (id) => {
    const { sim, equip } = fixture(); const before = sim.snapshot();
    expect(equip(id).ok).toBe(false); expect(sim.snapshot()).toEqual(before);
  });

  it('restricts specialist and support equipment by training', () => {
    const { unit } = fixture();
    unit.role = 'mg'; expect(weaponChoices(unit).map((w) => w.id)).toEqual(['mg', 'bren']);
    unit.role = 'sniper'; expect(canIssueWeapon(unit, 'sniper')).toBe(true);
    for (const role of ['medic', 'at', 'mortarman', 'gun_truck', 'heavy_mg', 'at_gun'] as const) {
      unit.role = role; expect(weaponChoices(unit)).toEqual([]);
    }
    unit.role = 'rifleman'; unit.team = 'enemy'; expect(weaponChoices(unit)).toEqual([]);
  });

  it.each(['paused', 'pinned', 'dead', 'crossed', 'working', 'poor', 'over'] as const)('rejects issue while %s without spending points', (condition) => {
    const { sim, unit, equip } = fixture();
    if (condition === 'paused') sim.paused = true;
    if (condition === 'pinned') unit.pinned = true;
    if (condition === 'dead') unit.dead = true;
    if (condition === 'crossed') unit.crossed = true;
    if (condition === 'working') unit.upgradeTimer = 10;
    if (condition === 'poor') sim.state.points = 0;
    if (condition === 'over') sim.state.phase = 'defeat';
    const before = sim.snapshot(); expect(equip('m3').ok).toBe(false); expect(sim.snapshot()).toEqual(before);
  });

  it('holds fire during issue, then fires the new weapon at its actual range', () => {
    const { sim, unit, equip } = fixture();
    sim.spawnEnemy('rifle', { x: 200, y: 300 });
    const enemy = sim.state.units.at(-1)!;
    enemy.health = 100_000; enemy.reloadTimer = 100_000; enemy.grenades = 0;
    expect(equip('m3').ok).toBe(true);
    sim.step();
    for (let tick = 0; tick < sec(WEAPON_ISSUE_SECONDS) - 1; tick++) {
      enemy.pinned = true; enemy.suppression = CONFIG.suppression.max;
      expect(sim.step().some((event) => event.type === 'shot' && event.shooterId === unit.id)).toBe(false);
    }
    const shots = [];
    for (let tick = 0; tick < 100; tick++) {
      enemy.pinned = true; enemy.suppression = CONFIG.suppression.max;
      shots.push(...sim.step().filter((event) => event.type === 'shot' && event.shooterId === unit.id));
    }
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((event) => event.type === 'shot' && event.weapon === 'M3 Grease Gun')).toBe(true);
    enemy.pos = { x: 200, y: 170 }; enemy.prevPos = { ...enemy.pos };
    for (let tick = 0; tick < 30; tick++) {
      enemy.pinned = true; enemy.suppression = CONFIG.suppression.max;
      expect(sim.step().some((event) => event.type === 'shot' && event.shooterId === unit.id)).toBe(false);
    }
  });

  it('restores equipment and switching progress, accepts legacy defaults, and rejects corrupt loadouts', () => {
    const { sim, unit, equip } = fixture();
    sim.step(); // Deliver setup events before comparing resumed gameplay events.
    expect(equip('lee_enfield').ok).toBe(true);
    sim.step();
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const restored = Simulation.fromSnapshot(saved.snap);
    expect(restored.weaponOf(restored.state.units[0]!)?.name).toContain('Lee–Enfield');
    expect(restored.state.units[0]!.upgradeTimer).toBe(unit.upgradeTimer);
    for (let tick = 0; tick < 100; tick++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
    for (const invalid of [null, 12, 'shell', 'unknown', 'sniper']) {
      const raw = JSON.parse(JSON.stringify(sim.snapshot())); raw.units[0].assignedWeaponId = invalid;
      expect(validateSnapshot(raw)).toHaveProperty('error');
    }
    const legacy = sim.snapshot(); delete legacy.units[0]!.assignedWeaponId;
    expect(validateSnapshot(legacy)).toHaveProperty('snap');
    const old = Simulation.fromSnapshot(legacy);
    expect(old.weaponOf(old.state.units[0]!)?.name).toBe('M1 Garand');
  });
});
