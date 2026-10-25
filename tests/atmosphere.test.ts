import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { inRubble, landmarkHint, weatherGroundEffects } from '../src/simulation/environment';
import { RadioDirector } from '../src/game/radio';
import { battlePressure } from '../src/game/soundscape';
import { Simulation } from '../src/simulation/simulation';
import type { Building } from '../src/simulation/types';

describe('battlefield atmosphere and reports', () => {
  it('makes rain penalize vehicles on mud more than infantry while preserving roads', () => {
    const mud = CONFIG.terrain.effects.mud;
    expect(weatherGroundEffects(mud, 'heavyRain', true, false).speedMult).toBeLessThan(weatherGroundEffects(mud, 'heavyRain', false, false).speedMult);
    expect(weatherGroundEffects(CONFIG.terrain.effects.road, 'heavyRain', true, false)).toBe(CONFIG.terrain.effects.road);
    expect(weatherGroundEffects(mud, 'clear', true, false)).toBe(mud);
  });

  it('identifies persistent rubble and describes its real tactical effects', () => {
    const ruin: Building = { id: 1, kind: 'church', name: 'Church', pos: { x: 100, y: 100 }, cols: 3, rows: 3, health: 0, maxHealth: 100, destroyed: true };
    expect(inRubble([ruin], { x: 120, y: 120 }, 24)).toBe(true);
    expect(inRubble([ruin], { x: 50, y: 50 }, 24)).toBe(false);
    expect(landmarkHint(ruin)).toContain('cannot be repaired');
    expect(weatherGroundEffects({ speedMult: 1, accuracyMult: 1, reloadMult: 1 }, 'clear', false, true).speedMult).toBe(.8);
  });

  it('interrupts quiet chatter for incoming artillery and states the real direction', () => {
    const sim = new Simulation(2026); const radio = new RadioDirector(); const unit = sim.state.units.find((u) => u.team === 'friendly')!;
    const tick = 1000;
    const quiet = radio.consider([{ type: 'roleAbilityStarted', unitId: unit.id, kind: 'observe', pos: unit.pos }], sim.state.units, tick);
    expect(quiet?.text).toContain('Observation post');
    const urgent = radio.consider([{ type: 'enemyBarrageIncoming', pos: { x: 50, y: 50 }, shells: 3, landTick: tick + 100 }], sim.state.units, tick + 2 * CONFIG.tickRate);
    expect(urgent?.text).toContain('Incoming artillery'); expect(urgent?.text).toContain('north-west');
    expect(urgent?.channel).toBe('field');
  });

  it('reports a spotted tank and drops speech when no living speaker exists', () => {
    const sim = new Simulation(2026); const radio = new RadioDirector(); const unit = sim.state.units[0]!;
    const event = { type: 'scoutContact' as const, unitId: unit.id, role: 'vehicle' as const, pos: { x: 1100, y: 100 } };
    expect(radio.consider([event], sim.state.units, 1000)?.text).toContain('Tank observed');
    expect(new RadioDirector().consider([event], [], 1000)).toBeNull();
    expect(battlePressure(sim.state)).toBe(0);
    sim.state.units[0]!.pinned = true; expect(battlePressure(sim.state)).toBeGreaterThan(0);
  });
});
