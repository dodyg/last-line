import { afterEach, expect, it } from 'vitest';
import { SquadRoleGrouping } from '../src/ui/squad-role-grouping';
import type { Unit } from '../src/simulation/types';

afterEach(() => document.body.replaceChildren());

it('groups soldiers, exposes missing roles, and retains selection controls when switching back', () => {
  const roster = document.createElement('div');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  document.body.append(toggle, roster);
  const grouping = new SquadRoleGrouping(roster, toggle);
  const soldiers = [{ id: 1, role: 'rifleman' }, { id: 2, role: 'medic' }, { id: 3, role: 'rifleman' }] as Unit[];
  const rows = new Map(soldiers.map((unit) => {
    const row = document.createElement('button');
    row.dataset.unitId = String(unit.id);
    return [unit.id, row] as const;
  }));
  rows.get(2)!.setAttribute('aria-pressed', 'true');
  grouping.update(soldiers, rows);
  toggle.click();
  expect(roster.querySelector('[data-role="rifleman"]')?.querySelectorAll('button')).toHaveLength(2);
  expect(roster.querySelector('[data-role="engineer"]')?.textContent).toContain('0 · Missing');
  expect(roster.querySelector('[data-role="medic"] button')).toBe(rows.get(2));
  expect(rows.get(2)!.getAttribute('aria-pressed')).toBe('true');
  rows.get(2)!.focus();
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  expect([...roster.children]).toEqual([...rows.values()]);
  expect(document.activeElement).toBe(rows.get(2));
});

it('updates role coverage after casualties and recruits without rebuilding unchanged rosters', () => {
  const roster = document.createElement('div');
  const toggle = document.createElement('input');
  toggle.checked = true;
  const grouping = new SquadRoleGrouping(roster, toggle);
  const medic = { id: 1, role: 'medic' } as Unit;
  const row = document.createElement('button');
  const rows = new Map([[1, row]]);
  grouping.update([medic], rows);
  const group = roster.querySelector('[data-role="medic"]');
  grouping.update([medic], rows);
  expect(roster.querySelector('[data-role="medic"]')).toBe(group);
  row.remove(); // HUD removes casualties before updating grouping.
  grouping.update([], new Map());
  expect(roster.querySelector('[data-role="medic"]')?.textContent).toContain('0 · Missing');
  grouping.update([medic], rows);
  expect(roster.querySelector('[data-role="medic"]')?.classList.contains('empty')).toBe(false);
  expect(roster.querySelector('[data-role="medic"] button')).toBe(row);
});
