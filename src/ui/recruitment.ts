import { ARMORY, weaponChoices } from '../content/armory';
import { CONFIG } from '../content/config';
import { getContent } from '../content/validate';
import { recruitBuild } from '../simulation/recruit-build';
import { fireOrdersForRole, type FriendlyRole, type RecruitBuild } from '../simulation/types';

/** A paused equipment desk, used before committing a recruit to the battlefield. */
export class RecruitmentScreen {
  readonly root = document.createElement('div');
  private role: FriendlyRole = 'rifleman';
  private points = 0;
  private confirm: ((build: RecruitBuild) => void) | null = null;
  private cancelled: (() => void) | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor() {
    this.root.id = 'overlay-recruitment'; this.root.className = 'overlay'; this.root.hidden = true;
    this.root.innerHTML = `<form class="panel recruit-panel" role="dialog" aria-modal="true" aria-labelledby="recruit-heading">
      <header><p class="recruit-eyebrow">Personnel &amp; equipment · battle paused</p><h2 id="recruit-heading">Prepare soldier</h2><p id="recruit-role-description" class="subtle"></p></header>
      <div class="recruit-columns">
        <section aria-labelledby="recruit-equipment-heading"><h3 id="recruit-equipment-heading">Equipment</h3>
          <label for="recruit-weapon">Primary weapon</label><select id="recruit-weapon"></select>
          <p id="recruit-weapon-description"></p><p id="recruit-weapon-history" class="subtle"></p>
          <dl id="recruit-weapon-stats" class="weapon-stats"></dl>
          <h3>Standard role kit</h3><p id="recruit-role-kit"></p>
          <p class="subtle">Attributes start at 25–75. Every three cleared waves survived adds +1 to each, up to 100. Role abilities and standard ammunition are included.</p>
        </section>
        <section aria-labelledby="recruit-orders-heading"><h3 id="recruit-orders-heading">Initial orders</h3><label for="recruit-stance">Posture</label><select id="recruit-stance"><option value="standing">Standing · fastest movement</option><option value="crouching">Crouching · lower profile</option><option value="prone">Prone · lowest profile</option></select>
          <label for="recruit-fire-order">Fire order</label><select id="recruit-fire-order"></select>
          <p class="subtle">Posture and fire orders can be changed in the field.</p>
        </section>
      </div>
      <footer><dl id="recruit-cost-breakdown" class="weapon-stats"></dl><p id="recruit-build-status" role="status"></p>
        <div class="dialog-actions"><button id="btn-recruit-cancel" class="menu-button" type="button">Cancel</button><button id="btn-recruit-deploy" class="menu-button primary" type="submit">Choose deployment position</button></div>
        <p class="subtle">Points are spent only when you place this soldier in the southern deployment zone.</p>
      </footer></form>`;
    (document.getElementById('overlay-root') ?? document.body).append(this.root);
    this.root.addEventListener('change', () => this.render());
    this.get<HTMLFormElement>('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const result = recruitBuild(getContent(), this.role, this.read());
      if ('error' in result || result.cost > this.points) return;
      const callback = this.confirm; this.hide(); callback?.(result.build);
    });
    this.get('#btn-recruit-cancel').addEventListener('click', () => this.cancel());
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); }
      if (event.key !== 'Tab') return;
      const controls = [...this.root.querySelectorAll<HTMLElement>('select:not(:disabled), button:not(:disabled), a[href]')];
      const first = controls[0]!, last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  get open(): boolean { return !this.root.hidden; }

  show(role: FriendlyRole, points: number, confirm: (build: RecruitBuild) => void, cancel: () => void): void {
    this.role = role; this.points = points; this.confirm = confirm; this.cancelled = cancel;
    this.returnFocus = document.activeElement as HTMLElement | null;
    const content = getContent(), def = content.friendly[role];
    this.get('#recruit-heading').textContent = `Prepare ${def.label}`;
    this.get('#recruit-role-description').textContent = `Standard role: ${def.blurb}`;
    const choices = weaponChoices({ team: 'friendly', role });
    const weapons = choices.length ? choices.map((issue) => issue.id) : [def.weapon ?? ''];
    this.get<HTMLSelectElement>('#recruit-weapon').replaceChildren(...weapons.map((id) => {
      const option = document.createElement('option'); option.value = id;
      const surcharge = id === def.weapon ? 0 : ARMORY.find((issue) => issue.id === id)?.cost ?? 0;
      option.textContent = `${content.weapons[id]?.name ?? (role === 'mortarman' ? 'M2 60 mm mortar' : 'Medical supplies')} · ${surcharge ? `+${surcharge} pt` : 'Included'}`;
      return option;
    }));
    this.get<HTMLSelectElement>('#recruit-weapon').value = def.weapon ?? '';
    this.get<HTMLSelectElement>('#recruit-weapon').disabled = choices.length < 2;
    const vehicle = role === 'gun_truck';
    const stance = this.get<HTMLSelectElement>('#recruit-stance'); stance.value = 'standing'; stance.disabled = vehicle;
    const labels = { auto: 'Automatic targeting', antiArmor: 'Prioritize armor', stopBreakthrough: 'Stop breakthroughs', holdGrenades: 'Hold grenades', seekGunfire: 'Seek heard gunfire' };
    const orders = this.get<HTMLSelectElement>('#recruit-fire-order');
    orders.replaceChildren(...fireOrdersForRole(role).map((order) => {
      const option = document.createElement('option'); option.value = order; option.textContent = labels[order]; return option;
    }));
    orders.value = role === 'at_gun' ? 'antiArmor' : 'auto';
    const kit = [`${def.health} HP`, `${def.speed} base movement`];
    if (def.grenades) kit.push(`${def.grenades} grenades`);
    if (def.specialistAmmo) kit.push(`${def.specialistAmmo} ${role === 'flamethrower' ? 'fuel bursts' : 'rifle grenades'}`);
    if (def.rockets) kit.push(`${def.rockets} rockets`);
    if (def.mortarBombs) kit.push(`${def.mortarBombs} mortar bombs`);
    if (def.heal) kit.push(`Medical supplies · ${def.heal.amount} HP per treatment`);
    if (role === 'rifleman' || role === 'engineer') kit.push(`${CONFIG.smoke.startingGrenades} smoke grenade${CONFIG.smoke.startingGrenades === 1 ? '' : 's'}`);
    this.get('#recruit-role-kit').textContent = kit.join(' · ');
    this.root.hidden = false; this.render();
    this.get<HTMLButtonElement>('#btn-recruit-cancel').focus({ preventScroll: true });
    this.get('.recruit-columns').scrollTop = 0;
  }

  private read(): RecruitBuild {
    const selected = this.get<HTMLSelectElement>('#recruit-weapon').value;
    return { weaponId: selected || undefined,
      stance: this.get<HTMLSelectElement>('#recruit-stance').value as RecruitBuild['stance'],
      fireOrder: this.get<HTMLSelectElement>('#recruit-fire-order').value as RecruitBuild['fireOrder'] };
  }

  private render(): void {
    const content = getContent(), build = this.read(), weapon = content.weapons[build.weaponId ?? ''];
    const issue = ARMORY.find((entry) => entry.id === build.weaponId);
    this.get('#recruit-weapon-description').textContent = issue?.handling ?? 'Specialist equipment included with this role.';
    this.get('#recruit-weapon-history').textContent = issue ? `${issue.cartridge} · ${issue.action} · ${issue.feed}` : '';
    this.rows('#recruit-weapon-stats', weapon ? [
      ['Game range', `${weapon.range} px`],
      ['Base aim', `${Math.round(weapon.accuracy * 100)}%`],
      ['Damage per hit', `${Math.round(weapon.damage * 10) / 10}`],
      ['Base firing cycle', `${(weapon.reloadTicks / CONFIG.tickRate).toFixed(1)}s`],
      ['Shots per burst', `${weapon.burstShots}`],
    ] : [['Equipment', this.role === 'mortarman' ? 'Indirect fire mortar' : 'Medical treatment']]);
    const result = recruitBuild(content, this.role, build);
    const base = CONFIG.costs.recruit[this.role], cost = 'cost' in result ? result.cost : base;
    const weaponCost = build.weaponId && build.weaponId !== content.friendly[this.role].weapon ? issue?.cost ?? 0 : 0;
    this.rows('#recruit-cost-breakdown', [['Recruit', `${base} pt`], ['Weapon change', `${weaponCost} pt`], ['Total / available', `${cost} / ${this.points} pt`]]);
    const error = 'error' in result ? result.error : cost > this.points ? `Need ${cost - this.points} more points. Choose another weapon.` : 'Build ready. Choose a position next.';
    this.get('#recruit-build-status').textContent = error;
    this.get<HTMLButtonElement>('#btn-recruit-deploy').disabled = 'error' in result || cost > this.points;
  }

  private rows(selector: string, rows: string[][]): void {
    this.get(selector).replaceChildren(...rows.flatMap(([label, value]) => {
      const term = document.createElement('dt'), detail = document.createElement('dd');
      term.textContent = label!; detail.textContent = value!; return [term, detail];
    }));
  }

  cancel(): void { const callback = this.cancelled; this.hide(); callback?.(); }
  hide(): void {
    this.root.hidden = true; this.confirm = null; this.cancelled = null;
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }
}
