import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/content/config';
import { getContent } from '../src/content/validate';
import { validateSnapshot } from '../src/persistence';
import { recruitBuild } from '../src/simulation/recruit-build';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import type { RecruitBuild } from '../src/simulation/types';
import { RecruitmentScreen } from '../src/ui/recruitment';

const content = getContent();
function fixture() {
  const data = generateTerrain(42, false, 2);
  data.kinds.fill(0); data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(42, undefined, data, false); sim.state.points = 100;
  return sim;
}

describe('custom recruitment', () => {
  it('includes default equipment and charges cumulative starting upgrade prices', () => {
    for (const role of Object.keys(content.friendly) as Array<keyof typeof content.friendly>) {
      const standard = recruitBuild(content, role);
      expect(standard).toHaveProperty('cost', CONFIG.costs.recruit[role]);
    }
    const built = recruitBuild(content, 'rifleman', { weaponId: 'm3', upgrades: { accuracy: 2, reload: 1 }, stance: 'prone', fireOrder: 'holdGrenades' });
    expect(built).toHaveProperty('cost', 4 + 2 + 5 + 8 + 5);
  });

  it('issues the complete build in one transaction and preserves it in saves', () => {
    const sim = fixture();
    const build: RecruitBuild = { weaponId: 'm3', upgrades: { accuracy: 2, reload: 1, damage: 1 }, stance: 'crouching', fireOrder: 'holdGrenades' };
    expect(sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 400, y: 660 }, build }).ok).toBe(true);
    const soldier = sim.state.units.at(-1)!;
    expect(sim.state.points).toBe(70);
    expect(sim.weaponOf(soldier)?.name).toBe('M3 Grease Gun');
    expect(soldier).toMatchObject({ weaponUpgrades: { accuracy: 2, reload: 1, damage: 1 }, stance: 'crouching', fireOrder: 'holdGrenades', upgradeTimer: 0 });
    expect(soldier.attributes).toBeDefined();
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.units.at(-1)).toEqual(soldier);
  });

  it.each([
    { weaponId: 'shell' }, { weaponId: 'sniper' }, { upgrades: { accuracy: -1 } }, { upgrades: { reload: 4 } },
    { upgrades: { damage: 1.5 } }, { upgrades: { damage: null } }, { upgrades: null }, { stance: 'flying' }, { fireOrder: 'random' },
  ])('rejects malformed builds without spending points, IDs, or randomness: %j', (build) => {
    const sim = fixture(), before = sim.snapshot();
    expect(sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 400, y: 660 }, build: build as unknown as RecruitBuild }).ok).toBe(false);
    expect(sim.snapshot()).toEqual(before);
  });

  it('rejects a build that only has enough points for the base recruit', () => {
    const sim = fixture(); sim.state.points = 4; const before = sim.snapshot();
    expect(sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 400, y: 660 }, build: { weaponId: 'm3' } }).ok).toBe(false);
    expect(sim.snapshot()).toEqual(before);
  });

  it('respects specialist equipment and vehicle posture', () => {
    expect(recruitBuild(content, 'medic', { upgrades: { damage: 1 } })).toHaveProperty('error');
    expect(recruitBuild(content, 'gun_truck', { stance: 'prone' })).toHaveProperty('error');
    expect(recruitBuild(content, 'mg', { weaponId: 'bren' })).toHaveProperty('cost', CONFIG.costs.recruit.mg + 7);
    expect(recruitBuild(content, 'at_gun')).toHaveProperty('build.fireOrder', 'antiArmor');
  });
});

describe('recruitment screen', () => {
  afterEach(() => document.body.replaceChildren());
  it('configures every role with valid defaults, including specialist kits', () => {
    const screen = new RecruitmentScreen();
    for (const role of Object.keys(content.friendly) as Array<keyof typeof content.friendly>) {
      const confirm = vi.fn(); screen.show(role, 100, confirm, vi.fn());
      expect(screen.root.querySelector('h2')!.textContent).toContain(content.friendly[role].label);
      screen.root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(confirm).toHaveBeenCalledOnce();
      expect(recruitBuild(content, role, confirm.mock.calls[0]![0])).not.toHaveProperty('error');
      expect(screen.open).toBe(false);
    }
  });

  it('updates cost and blocks an unaffordable build, then cancels without confirming', () => {
    const screen = new RecruitmentScreen(), confirm = vi.fn(), cancel = vi.fn();
    screen.show('rifleman', 4, confirm, cancel);
    const weapon = screen.root.querySelector<HTMLSelectElement>('#recruit-weapon')!;
    weapon.value = 'm3'; weapon.dispatchEvent(new Event('change', { bubbles: true }));
    expect(screen.root.querySelector<HTMLButtonElement>('#btn-recruit-deploy')!.disabled).toBe(true);
    expect(screen.root.textContent).toContain('Need 2 more points');
    screen.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancel).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled(); expect(screen.open).toBe(false);
  });
});
