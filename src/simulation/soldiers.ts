import { CONFIG } from '../content/config';
import type { SoldierAttributes, Unit } from './types';

export const SOLDIER_ATTRIBUTES = [
  { key: 'strength', label: 'Strength', effect: 'Stamina recovery' },
  { key: 'agility', label: 'Agility', effect: 'Reload speed' },
  { key: 'speed', label: 'Speed', effect: 'Movement speed' },
  { key: 'stealth', label: 'Stealth', effect: 'Concealment while not revealed' },
  { key: 'marksmanship', label: 'Marksmanship', effect: 'Aim, combined with role skill and weapon training' },
  { key: 'endurance', label: 'Endurance', effect: 'Running duration' },
  { key: 'resolve', label: 'Resolve', effect: 'Suppression recovery' },
] as const;

export const ATTRIBUTE_GROWTH_WAVES = 3;

/** Field experience grows slowly, including for soldiers in support roles. */
export function trainSoldierAttributes(unit: Unit): void {
  if (unit.team !== 'friendly' || unit.dead || unit.health <= 0 || unit.crossed
    || ['vehicle', 'gun_truck', 'troop_transport'].includes(unit.role)) return;
  unit.attributeTrainingWaves = (unit.attributeTrainingWaves ?? 0) + 1;
  if (unit.attributeTrainingWaves < ATTRIBUTE_GROWTH_WAVES) return;
  unit.attributeTrainingWaves = 0;
  // Older saves start from their existing neutral ratings, without rerolling.
  unit.attributes ??= { strength: 50, agility: 50, speed: 50, stealth: 50, marksmanship: 50, endurance: 50, resolve: 50 };
  for (const { key } of SOLDIER_ATTRIBUTES) unit.attributes[key] = Math.min(100, unit.attributes[key] + 1);
}

/** A private hash gives each recruit stable ratings without spending combat RNG. */
export function generateSoldierAttributes(seed: number, id: number): SoldierAttributes {
  let hash = ((seed >>> 0) ^ Math.imul(id, 0x9e3779b1)) >>> 0;
  const attributes = {} as SoldierAttributes;
  for (const { key } of SOLDIER_ATTRIBUTES) {
    hash = (hash + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(hash ^ (hash >>> 15), hash | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    attributes[key] = 25 + ((mixed ^ (mixed >>> 14)) >>> 0) % 51;
  }
  return attributes;
}

/** Neutral legacy ratings and vehicle immunity keep existing equipment stats intact. */
export function soldierAttributeMultiplier(unit: Unit, key: keyof SoldierAttributes): number {
  if (['vehicle', 'gun_truck', 'troop_transport'].includes(unit.role)) return 1;
  return 1 + ((unit.attributes?.[key] ?? 50) - 50) * .004;
}

const FIRST_NAMES = [
  'James', 'William', 'Robert', 'John', 'Thomas', 'George', 'Charles', 'Edward',
  'Henry', 'Arthur', 'Frank', 'Joseph', 'Walter', 'Richard', 'Samuel', 'Albert',
] as const;
const SURNAMES = [
  'Miller', 'Wilson', 'Brown', 'Taylor', 'Clark', 'Walker', 'Hall', 'Allen',
  'Baker', 'Wright', 'Adams', 'Nelson', 'Carter', 'Mitchell', 'Roberts', 'Turner',
  'Phillips', 'Campbell', 'Parker', 'Evans', 'Edwards', 'Collins', 'Stewart', 'Morris',
  'Reed', 'Cook', 'Morgan', 'Bell', 'Murphy', 'Bailey', 'Cooper', 'Richardson',
] as const;

/** Identity uses no combat RNG and needs no additional save data. */
export function soldierName(seed: number, id: number): string {
  const index = ((seed >>> 0) + Math.imul(id, 159)) >>> 0;
  return `${FIRST_NAMES[index % FIRST_NAMES.length]} ${SURNAMES[Math.floor(index / FIRST_NAMES.length) % SURNAMES.length]}`;
}

const RANKS = [
  { name: 'Private', short: 'Pvt', badge: '•' },
  { name: 'Private First Class', short: 'Pfc', badge: '⌃' },
  { name: 'Corporal', short: 'Cpl', badge: '⌃⌃' },
  { name: 'Sergeant', short: 'Sgt', badge: '⌃⌃⌃' },
  { name: 'Staff Sergeant', short: 'SSgt', badge: '⌃⌃⌃━' },
  { name: 'Technical Sergeant', short: 'TSgt', badge: '⌃⌃⌃═' },
] as const;

export function soldierRank(xp: number) {
  const level = Math.max(0, Math.min(Math.floor(xp), CONFIG.xp.maxLevel, RANKS.length - 1));
  return { ...RANKS[level]!, level };
}
