import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/content/config';
import { LULL_BANTER } from '../src/content/lull-banter';
import { RadioDirector } from '../src/game/radio';
import { Simulation } from '../src/simulation/simulation';
import type { SimEvent, WavePhase } from '../src/simulation/types';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const sim = new Simulation(2026);
  sim.state.units = sim.state.units.filter((unit) => unit.team === 'friendly').slice(0, 2);
  sim.state.units.forEach((unit, index) => {
    unit.pos = { x: 492 + index * 40, y: 612 };
    unit.pinned = false; unit.suppression = 0; unit.targetId = null; unit.health = 100;
  });
  const radio = new RadioDirector();
  const consider = (seconds: number, events: SimEvent[] = [], phase: WavePhase = 'prep') => radio.consider(events, sim.state.units, seconds * CONFIG.tickRate, 'clear', undefined, phase);
  return { sim, radio, consider };
}

describe('lull soldier banter', () => {
  it('starts only after a quiet interval and pairs two nearby living soldiers off the radio', () => {
    const { consider } = fixture();
    expect(consider(0)).toBeNull(); expect(consider(5)).toBeNull();
    const chatter = consider(6)!;
    const joke = LULL_BANTER.find((entry) => entry.line === chatter.text)!;
    expect(joke).toBeDefined(); expect(chatter.reply?.text).toBe(joke.reply);
    expect(chatter.reply?.speakerId).not.toBe(chatter.speakerId);
    expect(chatter.channel).toBe('field'); expect(chatter.delivery).toBe('tense');
  });

  it('spaces exchanges and avoids repeating recent jokes', () => {
    const { consider } = fixture(); consider(0);
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      const chatter = consider(6 + i * 40)!;
      expect(chatter.reply).toBeDefined(); lines.push(chatter.text);
      expect(consider(7 + i * 40)).toBeNull();
    }
    expect(new Set(lines).size).toBe(8);
  });

  it('does not joke while enemies are alive, the wave is active, or soldiers are under pressure', () => {
    const { sim, consider } = fixture(); consider(0);
    expect(consider(20, [], 'active')).toBeNull();
    sim.state.units[0]!.pinned = true;
    expect(consider(40)).toBeNull(); sim.state.units[0]!.pinned = false;
    sim.spawnEnemy('rifle', { x: 500, y: 200 });
    expect(consider(60)).toBeNull();
    sim.state.units.pop(); consider(70);
    expect(consider(75)).toBeNull(); expect(consider(76)?.reply).toBeDefined();
  });

  it('does not invent a conversation partner for distant soldiers or men on different floors', () => {
    const { sim, consider } = fixture();
    sim.state.units[1]!.pos.x = 900;
    consider(0); expect(consider(6)?.reply).toBeUndefined();
    sim.state.units[1]!.pos.x = 520;
    sim.state.units[0]!.buildingPosition = { buildingId: 1, level: 0, slot: 0 };
    sim.state.units[1]!.buildingPosition = { buildingId: 1, level: 1, slot: 0 };
    expect(consider(46)?.reply).toBeUndefined();
  });

  it('interrupts the joke and its pending reply immediately when shooting resumes', () => {
    const { sim, radio, consider } = fixture(); consider(0); expect(consider(6)?.reply).toBeDefined();
    const shooter = sim.state.units[0]!;
    const warning = consider(6.1, [{ type: 'shot', shooterId: shooter.id, shooterTeam: 'friendly', from: shooter.pos, to: { x: 100, y: 100 }, hit: false, weapon: 'M1 Garand', targetId: null }]);
    expect(radio.takeBanterInterruption()).toBe(true);
    expect(radio.takeBanterInterruption()).toBe(false);
    expect(warning?.text).toContain('Contact!'); expect(warning?.reply).toBeUndefined();
    expect(consider(7)).toBeNull();
  });
});
