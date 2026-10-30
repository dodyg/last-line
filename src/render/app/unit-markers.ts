import type { GameController } from '../../game/controller';
import { getContent } from '../../content/validate';
import { soldierName } from '../../simulation/soldiers';
import { unitBuildingHeight } from '../../simulation/buildings';
import { WORLD_UNITS_PER_PIXEL } from './coordinates';
import type { FriendlyRole, Vec2 } from '../../simulation/types';

/** Invisible hit areas keep soldiers selectable; identification stays in tooltips and the roster. */
export class UnitMarkers {
  private readonly layer = document.createElement('div');
  private readonly buttons = new Map<number, HTMLButtonElement>();

  constructor(private readonly container: HTMLElement, private readonly controller: GameController,
    private readonly project: (pos: Vec2, height: number) => Vec2 | null) {
    this.layer.className = 'unit-markers';
    this.layer.setAttribute('aria-label', 'Soldiers on the battlefield');
    container.append(this.layer);
  }

  update(): void {
    const state = this.controller.battlefieldState;
    const live = new Set<number>();
    const bounds = this.container.getBoundingClientRect();
    const content = getContent();
    if (state) for (const unit of state.units) {
      if (unit.team !== 'friendly' || unit.dead || unit.crossed || unit.health <= 0) continue;
      live.add(unit.id);
      let button = this.buttons.get(unit.id);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'unit-marker';
        button.dataset.unitId = String(unit.id);
        button.addEventListener('click', (event) => {
          const current = this.controller.battlefieldState?.units.find((candidate) => candidate.id === unit.id);
          if (!current) return;
          if (this.controller.mode.kind !== 'none') this.controller.pointerLeft(current.pos.x, current.pos.y);
          else this.controller.selectSoldier(unit.id, event.shiftKey);
        });
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          const current = this.controller.battlefieldState?.units.find((candidate) => candidate.id === unit.id);
          if (current) this.controller.pointerRight(current.pos.x, current.pos.y);
        });
        this.layer.append(button);
        this.buttons.set(unit.id, button);
      }
      const point = this.project({ x: unit.prevPos.x + (unit.pos.x - unit.prevPos.x) * this.controller.alpha,
        y: unit.prevPos.y + (unit.pos.y - unit.prevPos.y) * this.controller.alpha }, unitBuildingHeight(state.terrain, unit) * WORLD_UNITS_PER_PIXEL + .03);
      const x = point ? point.x - bounds.left : -100, y = point ? point.y - bounds.top : -100;
      button.hidden = !point || x < 0 || y < 0 || x > bounds.width || y > bounds.height;
      const transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      if (button.style.transform !== transform) button.style.transform = transform;
      const selected = this.controller.selectionIds.includes(unit.id);
      button.classList.toggle('selected', selected);
      button.classList.toggle('pinned', unit.pinned);
      if (button.getAttribute('aria-pressed') !== String(selected)) button.setAttribute('aria-pressed', String(selected));
      const role = content.friendly[unit.role as FriendlyRole];
      const label = `${soldierName(state.baseTerrainSeed, unit.id)}, ${role?.label ?? unit.role}, HP ${Math.ceil(unit.health)}${unit.pinned ? ', pinned' : ''}`;
      if (button.getAttribute('aria-label') !== label) { button.setAttribute('aria-label', label); button.title = label; }
    }
    for (const [id, button] of this.buttons) if (!live.has(id)) { button.remove(); this.buttons.delete(id); }
  }

  destroy(): void { this.layer.remove(); this.buttons.clear(); }
}
