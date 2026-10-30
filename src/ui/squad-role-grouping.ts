import { getContent } from '../content/validate';
import type { FriendlyRole, Unit } from '../simulation/types';

/** Rearrange existing buttons only when the roster or grouping changes. */
export class SquadRoleGrouping {
  private signature = '';
  private soldiers: readonly Unit[] = [];
  private rows: ReadonlyMap<number, HTMLButtonElement> = new Map();

  constructor(private roster: HTMLElement, private toggle: HTMLInputElement) {
    toggle.addEventListener('change', () => this.update(this.soldiers, this.rows));
  }

  update(soldiers: readonly Unit[], rows: ReadonlyMap<number, HTMLButtonElement>): void {
    this.soldiers = soldiers;
    this.rows = rows;
    const signature = `${this.toggle.checked}:${soldiers.map((unit) => `${unit.id}/${unit.role}`).join(',')}`;
    if (signature === this.signature) return;
    this.signature = signature;
    const focused = document.activeElement;
    const scrollTop = this.roster.scrollTop;
    const children: HTMLElement[] = [];
    if (this.toggle.checked) {
      const roles = Object.entries(getContent().friendly) as [FriendlyRole, { label: string }][];
      // Occupied roles first; missing roles remain visible below them in the same list.
      const count = (role: FriendlyRole) => soldiers.filter((unit) => unit.role === role).length;
      roles.sort(([a, x], [b, y]) => Number(count(b) > 0) - Number(count(a) > 0) || x.label.localeCompare(y.label));
      for (const [role, definition] of roles) {
        const members = soldiers.filter((unit) => unit.role === role);
        const group = document.createElement('div');
        group.className = `roster-role${members.length ? '' : ' empty'}`;
        group.dataset.role = role;
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', `${definition.label}: ${members.length}${members.length ? '' : ', missing'}`);
        const title = document.createElement('div');
        title.className = 'roster-role-title';
        const label = document.createElement('span');
        label.textContent = definition.label;
        const total = document.createElement('span');
        total.className = 'roster-role-count';
        total.textContent = members.length ? String(members.length) : '0 · Missing';
        title.append(label, total);
        group.append(title, ...members.map((unit) => rows.get(unit.id)!));
        children.push(group);
      }
    } else {
      children.push(...soldiers.map((unit) => rows.get(unit.id)!));
    }
    this.roster.replaceChildren(...children);
    if (focused instanceof HTMLElement && this.roster.contains(focused)) focused.focus({ preventScroll: true });
    this.roster.scrollTop = scrollTop;
  }
}
