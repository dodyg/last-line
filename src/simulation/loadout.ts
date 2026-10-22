import type { Content } from '../content/validate';
import type { Unit } from './types';

/** Heavy-weapon soldiers use their Garand only while their primary ammo is empty. */
export function usesBackupRifle(unit: Unit, content: Content): boolean {
  if (unit.team !== 'friendly') return false;
  if (unit.role === 'at') return (unit.rockets ?? content.friendly.at.rockets ?? 0) <= 0;
  if (unit.role === 'mortarman') return (unit.mortarBombs ?? content.friendly.mortarman.mortarBombs ?? 0) <= 0;
  return false;
}
