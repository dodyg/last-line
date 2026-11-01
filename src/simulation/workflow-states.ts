import type { EnemySapperTeam, EnemySmokeAssault, Unit, Vec2, DemolitionTarget } from './types';

// These tagged views are reconstructed from the existing save fields. Keeping the
// wire format stable lets old saves and orders interrupted between ticks resume.
export type SapperMission =
  | { phase: 'searching' }
  | { phase: 'approaching' | 'planting'; target: DemolitionTarget; plantPos: Vec2 }
  | { phase: 'withdrawing'; chargeId: number };
export function sapperMission(team: EnemySapperTeam, inReach: boolean): SapperMission {
  if (team.chargeId !== null) return { phase: 'withdrawing', chargeId: team.chargeId };
  if (team.target && team.plantPos) return { phase: inReach ? 'planting' : 'approaching', target: team.target, plantPos: team.plantPos };
  return { phase: 'searching' };
}
export function resetSapperMission(team: EnemySapperTeam, nextPlanTick: number): void {
  team.target = null; team.plantPos = null; team.plantTicks = 0; team.nextPlanTick = nextPlanTick;
}
export function assignSapperMission(team: EnemySapperTeam, target: DemolitionTarget, plantPos: Vec2): void {
  team.target = { ...target }; team.plantPos = { ...plantPos }; team.plantTicks = 0;
}
export function plantSapperCharge(team: EnemySapperTeam, chargeId: number): void { team.chargeId = chargeId; }

export type SupportRequest = { phase: 'queued' | 'assigned'; targetId: number };
export function supportRequest(targetId: number, assignments: readonly (number | undefined)[]): SupportRequest {
  return { phase: assignments.includes(targetId) ? 'assigned' : 'queued', targetId };
}

export function assignSupport(unit: Unit, kind: 'medical' | 'supply', targetId: number): void {
  if (kind === 'medical') unit.medicalTargetId = targetId;
  else unit.supplyTargetId = targetId;
}
export function clearSupport(unit: Unit, kind: 'medical' | 'supply'): void {
  if (kind === 'medical') delete unit.medicalTargetId;
  else delete unit.supplyTargetId;
}

export type SupportDispatch = { phase: 'idle' } | { phase: 'approaching' | 'working' | 'paused'; targetId: number };
export function supportDispatch(targetId: number | undefined, pinned: boolean, inRange: boolean): SupportDispatch {
  if (targetId === undefined) return { phase: 'idle' };
  return { phase: pinned ? 'paused' : inRange ? 'working' : 'approaching', targetId };
}

export type BuildingOrderPhase = 'none' | 'approachingClear' | 'enteringAfterClear' | 'approaching' | 'climbing' | 'occupied';
export function buildingOrderPhase(unit: Unit): BuildingOrderPhase {
  const distance = unit.moveGoal ? Math.hypot(unit.pos.x - unit.moveGoal.x, unit.pos.y - unit.moveGoal.y) : 0;
  if (unit.clearBuilding) return unit.moveGoal && distance > 3 ? 'approachingClear' : 'enteringAfterClear';
  if (unit.buildingOrder) return unit.moveGoal && distance > 2 ? 'approaching' : 'climbing';
  return unit.buildingPosition ? 'occupied' : 'none';
}

export type TransportPhase = 'approaching' | 'unloading' | 'waitingForSlots' | 'withdrawing' | 'departed';
export function transportPhase(unit: Unit, cell: number): TransportPhase {
  const transport = unit.transport!;
  const withdrawing = transport.passengers === 0;
  const destination = withdrawing ? transport.exit : transport.dropOff;
  if (Math.hypot(unit.pos.x - destination.x, unit.pos.y - destination.y) > cell * .75) return withdrawing ? 'withdrawing' : 'approaching';
  if (withdrawing) return 'departed';
  return transport.unloadTicks > 0 ? 'unloading' : 'waitingForSlots';
}

export function finishTransportUnload(unit: Unit): void { unit.transport!.passengers = 0; }

export type SmokeAssaultPhase = 'warning' | 'advancing' | 'finished';
export function smokeAssaultPhase(plan: EnemySmokeAssault, tick: number): SmokeAssaultPhase {
  if (tick >= plan.endTick || (plan.deployed && plan.unitIds.length === 0)) return 'finished';
  return plan.deployed ? 'advancing' : 'warning';
}

export function deploySmokeAssault(plan: EnemySmokeAssault): void { plan.deployed = true; }
