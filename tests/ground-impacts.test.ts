import { describe, expect, it } from 'vitest';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, riverPathPoints } from '../src/simulation/terrain';
import { CONFIG } from '../src/content/config';
import { MAX_GROUND_IMPACTS, type GroundImpactKind } from '../src/simulation/types';

function fixture(realTerrain = false) {
  const data = generateTerrain(2026, false, 2);
  if (!realTerrain) {
    data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
    data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  }
  const sim = new Simulation(2026, undefined, data, false); sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const strike = (kind: GroundImpactKind | undefined, pos = { x: 492, y: 500 }, source: 'friendly' | 'enemy' = 'friendly') => {
    const id = sim.state.nextEntityId++;
    sim.state.strikes.push({ id, pos, landTick: sim.state.ticks + 1, radius: 32, damage: 0, suppressionAmount: 0, source, delivery: kind });
    return id;
  };
  return { sim, data, strike };
}

describe('persistent earth impact history', () => {
  it.each(['mortar', 'artillery', 'airSupport', undefined] as const)('records exactly one %s mark when a strike lands, using its existing identity', (kind) => {
    const { sim, strike } = fixture(), id = strike(kind), beforeRng = sim.state.rng.s, nextId = sim.state.nextEntityId;
    const events = sim.step(), expected = { id, kind: kind ?? 'artillery', pos: { x: 492, y: 500 }, tick: sim.state.ticks };
    expect(sim.state.groundImpacts).toEqual([expected]); expect(events).toContainEqual({ type: 'groundImpact', impact: expected, blastRadius: 32 });
    expect(sim.state.rng.s).toBe(beforeRng); expect(sim.state.nextEntityId).toBe(nextId);
    expect(sim.step().some((event) => event.type === 'groundImpact')).toBe(false); expect(sim.state.groundImpacts).toHaveLength(1);
  });

  it('records enemy barrages as well as player artillery without leaving marks before impact', () => {
    const { sim, strike } = fixture(); strike('artillery', undefined, 'enemy'); sim.state.strikes[0]!.landTick += 3;
    for (let i = 0; i < 3; i++) { sim.step(); expect(sim.state.groundImpacts).toEqual([]); }
    sim.step(); expect(sim.state.groundImpacts![0]!.kind).toBe('artillery');
  });

  it('keeps a bombing run as separate ground impacts along its actual impact positions', () => {
    const { sim, strike } = fixture();
    for (const x of [444, 492, 540]) strike('airSupport', { x, y: 500 }); sim.step();
    expect(sim.state.groundImpacts!.map((mark) => mark.pos.x).sort()).toEqual([444, 492, 540]);
    expect(sim.state.groundImpacts!.every((mark) => mark.kind === 'airSupport')).toBe(true);
  });

  it('bounds the history by discarding the oldest marks', () => {
    const { sim, strike } = fixture();
    for (let i = 0; i < MAX_GROUND_IMPACTS + 3; i++) { strike('mortar'); sim.step(); }
    expect(sim.state.groundImpacts).toHaveLength(MAX_GROUND_IMPACTS);
    expect(sim.state.groundImpacts![0]!.tick).toBe(4);
  });

  it('does not plant earth craters on water or bridge decks', () => {
    const { sim, data, strike } = fixture(true);
    expect(data.zones.river).not.toBeNull();
    const point = riverPathPoints(data.zones.river!, sim.state.seed)[4]!;
    strike('artillery', { x: point.x, y: point.y }); sim.step(); expect(sim.state.groundImpacts).toEqual([]);
    const bridge = data.zones.bridges[0]!; strike('airSupport', { x: bridge.x, y: bridge.y }); sim.step();
    expect(sim.state.groundImpacts).toEqual([]);
  });

  it('preserves scars exactly across save/Continue and restores old saves without scars', () => {
    const { sim, strike } = fixture(true); strike('mortar'); sim.step(); strike('artillery'); sim.step(); strike('airSupport'); sim.step();
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.groundImpacts).toEqual(sim.state.groundImpacts);
    for (let i = 0; i < 60; i++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
    const old = sim.snapshot(); old.schemaVersion = 24; delete old.groundImpacts;
    const legacy = validateSnapshot(JSON.parse(JSON.stringify(old))); if ('error' in legacy) throw new Error(legacy.error);
    expect(legacy.snap.schemaVersion).toBe(30); expect(legacy.snap.groundImpacts).toEqual([]);
  });

  it('leaves marks behind when the squad moves to a new battlefield', () => {
    const { sim, strike } = fixture(); strike('artillery'); sim.step(); expect(sim.state.groundImpacts).toHaveLength(1);
    for (const unit of sim.state.units) unit.pos.y = CONFIG.crossing.thresholdY - 1;
    sim.step(); expect(sim.state.mapNumber).toBe(2); expect(sim.state.groundImpacts).toEqual([]);
  });

  it.each(['kind', 'position', 'futureTick', 'fractionalTick', 'id', 'duplicate', 'overCap'] as const)('rejects corrupt history: %s', (field) => {
    const { sim, strike } = fixture(); strike('mortar'); sim.step(); const saved = JSON.parse(JSON.stringify(sim.snapshot())), mark = saved.groundImpacts[0];
    if (field === 'kind') mark.kind = 'laser';
    if (field === 'position') mark.pos.x = -1;
    if (field === 'futureTick') mark.tick = saved.ticks + 1;
    if (field === 'fractionalTick') mark.tick = .5;
    if (field === 'id') mark.id = 0;
    if (field === 'duplicate') saved.groundImpacts.push(mark);
    if (field === 'overCap') saved.groundImpacts = Array.from({ length: MAX_GROUND_IMPACTS + 1 }, (_, id) => ({ ...mark, id: id + 1 }));
    expect(validateSnapshot(saved)).toHaveProperty('error');
  });
});
