import { CONFIG } from '../content/config';
import { rngNext, type RngState } from './rng';
import type { TankComponent, Unit } from './types';

export const TANK_COMPONENTS: readonly TankComponent[] = ['tracks', 'turret', 'machineGun'];
export const TANK_DAMAGE_LABELS: Record<TankComponent, string> = {
  tracks: 'Tracks destroyed · immobilized',
  turret: 'Turret knocked out · cannon disabled',
  machineGun: 'Machine gun destroyed',
};

export function tankImmobilized(unit: Unit): boolean {
  return unit.team === 'enemy' && unit.role === 'vehicle' && unit.tankDamage?.tracks === true;
}

/** A surviving penetrating hit can knock out one of the remaining systems. */
export function damageTankComponent(unit: Unit, damageDealt: number, armorMult: number, rng: RngState): TankComponent | null {
  const tuning = CONFIG.armoredVehicle.componentDamage;
  if (unit.team !== 'enemy' || unit.role !== 'vehicle' || unit.dead || unit.health <= 0
    || damageDealt < tuning.minimumDamage || armorMult < tuning.minimumArmorMult) return null;
  const remaining = TANK_COMPONENTS.filter((component) => !unit.tankDamage?.[component]);
  if (!remaining.length) return null;
  const roll = rngNext(rng);
  if (roll >= tuning.disableChance) return null;
  const component = remaining[Math.floor(roll / tuning.disableChance * remaining.length)]!;
  (unit.tankDamage ??= { tracks: false, turret: false, machineGun: false })[component] = true;
  if (component === 'tracks') { unit.path = []; unit.moveGoal = null; unit.advance = false; }
  if (component === 'turret') { unit.burstRemaining = 0; unit.shotTimer = 0; }
  if (component === 'machineGun') { unit.secondaryBurstRemaining = 0; unit.secondaryShotTimer = 0; }
  return component;
}
