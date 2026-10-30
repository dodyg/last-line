import { CONFIG } from '../content/config';
import { getContent } from '../content/validate';
import { dist } from './combat';
import type { CommandResult, RoleDuty, SimEvent, SimState, Unit, Vec2 } from './types';

export const ROLE_ABILITIES: Partial<Record<Unit['role'], { kind: RoleDuty['kind']; label: string; description: string }>> = {
  officer: { kind: 'rally', label: 'Rally nearby troops', description: 'For 12s, recover nearby infantry suppression and morale within 160px. Officer must remain unpinned and stationary. 45s cooldown.' },
  scout: { kind: 'observe', label: 'Establish observation post', description: 'Hold fire to watch with 540px spotting range; elevated posts reach 620px. Reports remain marked for 12s after contact is lost. Movement cancels.' },
  supply_officer: { kind: 'supply', label: 'Set up forward supply', description: 'Spend 3 points for 12 ammunition items. Supplies nearby troops within 90px, one item every 2s. Officer stays here; movement abandons remaining stock.' },
  engineer: { kind: 'repair', label: 'Queue nearby repairs', description: 'Repair standing buildings within 160px, most damaged first. Each point buys 40 health over 4s. Pauses while engaged, suppressed, or constructing; movement cancels.' },
  mg: { kind: 'suppress', label: 'Suppress an area', description: 'Mark visible ground within weapon range. Suppress infantry within 55px for 10s, using suppression-only fire. Movement or pinning cancels. 20s cooldown.' },
  heavy_mg: { kind: 'suppress', label: 'Suppress an area', description: 'Mark visible ground within weapon range. Suppress infantry within 55px for 10s once deployed. Movement or pinning cancels. 20s cooldown.' },
};

export function roleAbility(state: SimState, unit: Unit | undefined, target?: Vec2): CommandResult {
  if (!unit || unit.team !== 'friendly' || unit.dead || unit.health <= 0 || unit.crossed || !ROLE_ABILITIES[unit.role]) return { ok: false, reason: 'Select an available specialist.' };
  if (unit.roleDuty) { delete unit.roleDuty; return { ok: true }; }
  if (unit.pinned || unit.buildingOrder || (unit.upgradeTimer ?? 0) > 0) return { ok: false, reason: 'This soldier must recover before using an ability.' };
  if ((unit.roleCooldown ?? 0) > 0) return { ok: false, reason: `Ability ready in ${Math.ceil(unit.roleCooldown! / CONFIG.tickRate)}s.` };
  const kind = ROLE_ABILITIES[unit.role]!.kind;
  if (kind === 'suppress' && (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y))) return { ok: false, reason: 'Mark ground to suppress.' };
  if (kind === 'supply' && state.points < 3) return { ok: false, reason: 'Forward supply costs 3 points.' };
  if (kind === 'supply') state.points -= 3;
  unit.roleDuty = { kind, origin: { ...unit.pos }, ticksRemaining: kind === 'rally' ? 12 * CONFIG.tickRate : kind === 'suppress' ? 10 * CONFIG.tickRate : 0, stock: kind === 'supply' ? 12 : 0, ...(kind === 'suppress' && target ? { target: { ...target } } : {}) };
  unit.roleCooldown = kind === 'rally' ? 45 * CONFIG.tickRate : kind === 'suppress' ? 20 * CONFIG.tickRate : 0;
  unit.path = []; unit.moveGoal = null; delete unit.patrol; delete unit.ambush; delete unit.gunfirePursuit;
  delete unit.medicalTargetId; delete unit.supplyTargetId;
  return { ok: true };
}

/** Tick-based and bounded; this never substitutes stale reports for line of sight. */
export function updateRoleAbilities(state: SimState, emit: (event: SimEvent) => void, observes: (scout: Unit, target: Unit) => boolean, clearSupply: (unit: Unit) => void): void {
  const content = getContent();
  for (const unit of state.units) {
    unit.roleCooldown = Math.max(0, (unit.roleCooldown ?? 0) - 1);
    if (unit.scoutReports) unit.scoutReports = unit.scoutReports.filter((report) => state.ticks - report.tick <= 12 * CONFIG.tickRate);
    const duty = unit.roleDuty;
    if (!duty) continue;
    if (unit.dead || unit.health <= 0 || unit.crossed || unit.path.length || unit.moveGoal || dist(unit.pos, duty.origin) > 4) { delete unit.roleDuty; continue; }
    if (duty.kind === 'rally' || duty.kind === 'suppress') {
      duty.ticksRemaining--;
      if (duty.ticksRemaining <= 0 || unit.pinned) { delete unit.roleDuty; continue; }
    }
    if (unit.pinned || (unit.upgradeTimer ?? 0) > 0) continue;
    if (duty.kind === 'rally') {
      for (const ally of state.units) if (ally.team === unit.team && !ally.dead && !ally.crossed && ally.health > 0 && dist(ally.pos, unit.pos) <= 160 && !['vehicle', 'gun_truck', 'troop_transport'].includes(ally.role)) {
        ally.suppression = Math.max(0, ally.suppression - 9 / CONFIG.tickRate);
        ally.morale = Math.min(100, ally.morale + 4 / CONFIG.tickRate);
      }
    } else if (duty.kind === 'observe' && state.ticks % CONFIG.tickRate === 0) {
      const reports = unit.scoutReports ??= [];
      for (const enemy of state.units) if (enemy.team === 'enemy' && !enemy.dead && enemy.health > 0 && !enemy.crossed && observes(unit, enemy)) {
        const previous = reports.find((report) => report.unitId === enemy.id);
        if (!previous || state.ticks - previous.tick > 6 * CONFIG.tickRate) emit({ type: 'scoutContact', unitId: unit.id, role: enemy.role, pos: { ...enemy.pos } });
        const report = { unitId: enemy.id, role: enemy.role, pos: { ...enemy.pos }, tick: state.ticks };
        if (previous) Object.assign(previous, report); else reports.push(report);
      }
      unit.scoutReports = reports.slice(-32);
    } else if (duty.kind === 'supply' && state.ticks % (2 * CONFIG.tickRate) === 0 && duty.stock > 0) {
      for (const ally of state.units) {
        if (ally.team !== 'friendly' || ally.dead || ally.crossed || ally.health <= 0 || dist(ally.pos, unit.pos) > 90 || !observes(unit, ally)) continue;
        const def = content.friendly[ally.role as keyof typeof content.friendly];
        if (!def) continue;
        const field = ally.role === 'grenadier' || ally.role === 'flamethrower' ? 'specialistAmmo' : ally.role === 'at' ? 'rockets' : ally.role === 'mortarman' ? 'mortarBombs' : 'grenades';
        const max = def[field] ?? 0;
        if ((ally[field] ?? max) >= max) continue;
        ally[field] = (ally[field] ?? max) + 1; duty.stock--;
        clearSupply(ally);
        emit({ type: field === 'specialistAmmo' ? 'specialistResupplied' : field === 'rockets' ? 'rocketsResupplied' : field === 'mortarBombs' ? 'mortarBombsResupplied' : 'grenadesResupplied', officerId: unit.id, targetId: ally.id, amount: 1 });
        break;
      }
    } else if (duty.kind === 'repair' && unit.targetId === null && !state.constructionSites.some((site) => site.builderId === unit.id) && unit.suppression <= CONFIG.suppression.recoverThreshold) {
      const building = state.buildings.filter((b) => !b.destroyed && b.health < b.maxHealth && dist(unit.pos, { x: b.pos.x + b.cols * state.terrain.cell / 2, y: b.pos.y + b.rows * state.terrain.cell / 2 }) <= 160)
        .sort((a, b) => a.health / a.maxHealth - b.health / b.maxHealth || a.id - b.id)[0];
      if (!building) continue;
      if (duty.stock <= 0) { if (state.points < 1) continue; state.points--; duty.stock = 40; }
      const amount = Math.min(10 / CONFIG.tickRate, duty.stock, building.maxHealth - building.health);
      building.health += amount; duty.stock -= amount;
    }
  }
}
