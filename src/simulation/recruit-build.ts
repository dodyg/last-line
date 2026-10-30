import { ARMORY, canIssueWeapon } from '../content/armory';
import { CONFIG } from '../content/config';
import type { Content } from '../content/validate';
import { fireOrdersForRole, type FriendlyRole, type RecruitBuild, type WeaponUpgradeType } from './types';

export const RECRUIT_UPGRADES: readonly WeaponUpgradeType[] = ['accuracy', 'reload', 'damage'];

/** Shared by the build screen and recruitment command; no mutation or randomness. */
export function recruitBuild(content: Content, role: FriendlyRole, raw: RecruitBuild = {}):
  { build: RecruitBuild; cost: number } | { error: string } {
  const def = content.friendly[role];
  if (!def || !raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Invalid recruit build.' };
  const weaponId = raw.weaponId ?? def.weapon ?? undefined;
  let cost = CONFIG.costs.recruit[role];
  if (raw.weaponId !== undefined && (typeof raw.weaponId !== 'string' || !content.weapons[raw.weaponId]
    || raw.weaponId !== def.weapon && !canIssueWeapon({ team: 'friendly', role }, raw.weaponId))) return { error: 'This role cannot carry that weapon.' };
  if (weaponId !== def.weapon && weaponId !== undefined) cost += ARMORY.find((issue) => issue.id === weaponId)!.cost;
  if (raw.upgrades !== undefined && (!raw.upgrades || typeof raw.upgrades !== 'object' || Array.isArray(raw.upgrades))) return { error: 'Invalid starting upgrades.' };
  const upgrades = { accuracy: 0, reload: 0, damage: 0 };
  for (const key of RECRUIT_UPGRADES) {
    const level = raw.upgrades?.[key] === undefined ? 0 : raw.upgrades[key]!;
    if (!Number.isInteger(level) || level < 0 || level > CONFIG.weaponUpgrades.maxLevel || !weaponId && level > 0) return { error: 'Invalid starting upgrade level for this role.' };
    upgrades[key] = level;
    cost += CONFIG.weaponUpgrades.costs[key].slice(0, level).reduce((sum, price) => sum + price, 0);
  }
  const vehicle = ['gun_truck', 'vehicle', 'troop_transport'].includes(role);
  const stance = raw.stance === undefined ? 'standing' : raw.stance;
  if (!['standing', 'crouching', 'prone'].includes(stance) || vehicle && stance !== 'standing') return { error: 'Invalid posture for this role.' };
  const fireOrder = raw.fireOrder === undefined ? (role === 'at_gun' ? 'antiArmor' : 'auto') : raw.fireOrder;
  if (!fireOrdersForRole(role).includes(fireOrder)) return { error: 'Invalid fire order for this role.' };
  return { build: { weaponId, upgrades, stance, fireOrder }, cost };
}
