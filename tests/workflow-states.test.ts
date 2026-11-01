import { describe, expect, it } from 'vitest';
import { assignSapperMission, buildingOrderPhase, plantSapperCharge, resetSapperMission, sapperMission,
  smokeAssaultPhase, supportDispatch, supportRequest, transportPhase } from '../src/simulation/workflow-states';
import type { EnemySapperTeam, EnemySmokeAssault, Unit } from '../src/simulation/types';

describe('serializable workflow states', () => {
  it('replans a sapper mission and tracks a planted charge across a save', () => {
    const team: EnemySapperTeam = { id: 1, sapperId: 2, escortIds: [], target: null, plantPos: null, plantTicks: 0, nextPlanTick: 0, chargeId: null };
    expect(sapperMission(team, false).phase).toBe('searching');
    assignSapperMission(team, { kind: 'bunker', id: 4 }, { x: 3, y: 5 });
    expect(sapperMission(team, false).phase).toBe('approaching');
    expect(sapperMission(team, true).phase).toBe('planting');
    resetSapperMission(team, 12);
    expect(sapperMission(team, false).phase).toBe('searching');
    expect(team.nextPlanTick).toBe(12);
    assignSapperMission(team, { kind: 'bridge', key: 'bridge' }, { x: 3, y: 5 });
    plantSapperCharge(team, 7);
    expect(sapperMission(JSON.parse(JSON.stringify(team)), false)).toEqual({ phase: 'withdrawing', chargeId: 7 });
  });

  it('distinguishes waiting, dispatched, paused, approaching and working support', () => {
    expect(supportRequest(3, [4]).phase).toBe('queued');
    expect(supportRequest(3, [3]).phase).toBe('assigned');
    expect(supportDispatch(undefined, false, false).phase).toBe('idle');
    expect(supportDispatch(3, true, true).phase).toBe('paused');
    expect(supportDispatch(3, false, false).phase).toBe('approaching');
    expect(supportDispatch(3, false, true).phase).toBe('working');
  });

  it('recognizes entry, interruption and occupancy without storing redundant phase', () => {
    const unit = { pos: { x: 0, y: 0 }, moveGoal: { x: 10, y: 0 }, clearBuilding: { buildingId: 1, level: 0, ticks: 2 } } as Unit;
    expect(buildingOrderPhase(unit)).toBe('approachingClear');
    unit.pos.x = 10;
    expect(buildingOrderPhase(unit)).toBe('enteringAfterClear');
    delete unit.clearBuilding;
    unit.buildingOrder = { buildingId: 1, level: 0, slot: 0, climbTicks: 2 };
    unit.pos.x = 0;
    expect(buildingOrderPhase(unit)).toBe('approaching');
    unit.pos.x = 10;
    expect(buildingOrderPhase(unit)).toBe('climbing');
    delete unit.buildingOrder;
    unit.buildingPosition = { buildingId: 1, level: 0, slot: 0 };
    expect(buildingOrderPhase(unit)).toBe('occupied');
    delete unit.buildingPosition;
    expect(buildingOrderPhase(unit)).toBe('none');
  });

  it('moves a transport through unloading and departure', () => {
    const unit = { pos: { x: 0, y: 0 }, transport: { passengers: 6, dropOff: { x: 20, y: 0 }, exit: { x: 0, y: 0 }, unloadTicks: 1, retryTick: 0 } } as Unit;
    expect(transportPhase(unit, 10)).toBe('approaching');
    unit.pos.x = 20;
    expect(transportPhase(unit, 10)).toBe('unloading');
    unit.transport!.unloadTicks = 0;
    expect(transportPhase(unit, 10)).toBe('waitingForSlots');
    unit.transport!.passengers = 0;
    expect(transportPhase(unit, 10)).toBe('withdrawing');
    unit.pos.x = 0;
    expect(transportPhase(unit, 10)).toBe('departed');
  });

  it('ends smoke assaults on timeout or loss of the deployed squad', () => {
    const plan: EnemySmokeAssault = { id: 1, leaderId: 2, unitIds: [2], pos: { x: 0, y: 0 }, deployTick: 5, endTick: 20, deployed: false };
    expect(smokeAssaultPhase(plan, 2)).toBe('warning');
    plan.deployed = true;
    expect(smokeAssaultPhase(plan, 5)).toBe('advancing');
    expect(smokeAssaultPhase(plan, 20)).toBe('finished');
    plan.unitIds = [];
    expect(smokeAssaultPhase(plan, 6)).toBe('finished');
  });
});
