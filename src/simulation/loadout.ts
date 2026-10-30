import type { Content } from '../content/validate';
import type { Unit } from './types';

export function equippedWeaponId(unit: Unit, content: Content): string | null {
  if (unit.tankCrew) return 'crew_pistol';
  if (usesBackupRifle(unit, content)) return 'rifle';
  return unit.team === 'friendly' ? unit.assignedWeaponId ?? content.friendly[unit.role as keyof Content['friendly']]?.weapon
    : content.enemy[unit.role as keyof Content['enemy']]?.weapon;
}

/** Heavy-weapon soldiers use their Garand only while their primary ammo is empty. */
export function usesBackupRifle(unit: Unit, content: Content): boolean {
  if (unit.team !== 'friendly') return false;
  if (unit.role === 'grenadier' || unit.role === 'flamethrower') return (unit.specialistAmmo ?? content.friendly[unit.role].specialistAmmo ?? 0) <= 0;
  if (unit.role === 'at') return (unit.rockets ?? content.friendly.at.rockets ?? 0) <= 0;
  if (unit.role === 'mortarman') return (unit.mortarBombs ?? content.friendly.mortarman.mortarBombs ?? 0) <= 0;
  return false;
}
