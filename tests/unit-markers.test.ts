import { expect, it, vi } from 'vitest';
import type { GameController } from '../src/game/controller';
import { UnitMarkers } from '../src/render/app/unit-markers';
import { Simulation } from '../src/simulation/simulation';
import type { SimState } from '../src/simulation/types';

it('keeps marker actions attached to current soldiers after restart and removes casualties', () => {
  const sim = new Simulation(2026);
  const state: SimState = structuredClone(sim.state);
  const selected = vi.fn(), pointer = vi.fn(), right = vi.fn();
  const controller = { battlefieldState: state, alpha: 0, selectionIds: [], mode: { kind: 'none' },
    selectSoldier: selected, pointerLeft: pointer, pointerRight: right } as unknown as GameController;
  const container = document.createElement('div');
  container.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
  document.body.append(container);
  const markers = new UnitMarkers(container, controller, (pos) => ({ ...pos }));
  markers.update();
  const first = container.querySelector<HTMLButtonElement>('.unit-marker')!;
  expect(container.querySelectorAll('.unit-marker')).toHaveLength(4);
  expect(first.getAttribute('aria-label')).toContain('Rifleman');
  first.click(); expect(selected).toHaveBeenCalledWith(state.units[0]!.id, false);

  const restarted = structuredClone(state.units[0]!);
  restarted.pos = { x: 700, y: 600 }; restarted.prevPos = { ...restarted.pos };
  state.units[0] = restarted;
  controller.mode = { kind: 'move' };
  markers.update(); first.click();
  expect(pointer).toHaveBeenCalledWith(700, 600);
  first.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(right).toHaveBeenCalledWith(700, 600);
  restarted.dead = true; markers.update();
  expect(container.querySelectorAll('.unit-marker')).toHaveLength(3);
  markers.destroy(); expect(container.children).toHaveLength(0);
  container.remove();
});
