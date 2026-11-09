import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/simulation';
import { validateSnapshot } from '../src/persistence';

describe('battlefield animals', () => {
  it('generates deterministically and persists movement and fear', () => {
    const sim = new Simulation(42);
    expect(sim.state.animals).toEqual(new Simulation(42).state.animals);
    expect(sim.state.animals!.length).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) sim.step();
    const checked = validateSnapshot(sim.snapshot());
    expect('snap' in checked).toBe(true);
    if (!('snap' in checked)) return;
    const restored = Simulation.fromSnapshot(checked.snap);
    for (let i = 0; i < 30; i++) { sim.step(); restored.step(); }
    expect(restored.state.animals).toEqual(sim.state.animals);
  });

  it('scatters from gunfire, dies in blasts, and can trip AP but not AT mines', () => {
    const sim = new Simulation(42);
    const internal = sim as unknown as { emit: (event: unknown) => void; updateMines: () => void; explodeAt: (pos: {x: number; y: number}, radius: number, damage: number, armor: number, suppression: number, source: null) => number };
    const animal = { species: 'sheep' as const, pos: { x: 200, y: 200 }, heading: 0, frightenedUntil: 0 };
    sim.state.animals = [animal];
    internal.emit({ type: 'shot', from: { x: 180, y: 200 } });
    expect(animal.frightenedUntil).toBeGreaterThan(sim.state.ticks);
    expect(animal.heading).toBe(0);
    sim.state.mines = [{ id: 9999, kind: 'at', pos: { ...animal.pos }, armed: true }];
    internal.updateMines();
    expect(sim.state.mines).toHaveLength(1);
    sim.state.mines[0]!.kind = 'ap';
    internal.updateMines();
    expect(sim.state.mines).toHaveLength(0);
    expect(sim.state.animals).toHaveLength(0);
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'mineTriggered', animalTriggered: true }));
    sim.state.animals = [{ ...animal, pos: { x: 250, y: 250 } }];
    internal.explodeAt({ x: 250, y: 250 }, 30, 100, 1, 0, null);
    expect(sim.state.animals).toHaveLength(0);
  });
});
