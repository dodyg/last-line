import { CONFIG } from '../content/config';

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
