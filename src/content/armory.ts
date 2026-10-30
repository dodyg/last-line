import type { Unit } from '../simulation/types';

export interface WeaponIssue {
  id: string;
  cost: number;
  cartridge: string;
  action: string;
  feed: string;
  description: string;
  handling: string;
  source: string;
}

const US_ARMS = 'https://www.nps.gov/spar/learn/historyculture/us-wwii-arms.htm';
const US_MANUAL = 'https://www.ibiblio.org/hyperwar/USA/ref/TM/pdfs/TM9-2200.pdf';

/** Historical specifications describe the firearm; combat numbers remain game abstractions. */
export const ARMORY: readonly WeaponIssue[] = [
  { id: 'rifle', cost: 3, cartridge: '.30-06 Springfield', action: 'Semi-automatic', feed: '8-round en-bloc clip',
    description: 'The U.S. service rifle. Full-power ammunition and self-loading operation provide effective aimed fire with quicker follow-up shots than a manually operated bolt-action rifle.',
    handling: 'Versatile medium-to-long-range rifle. Strong individual hits; less suppressive fire than a light machine gun.', source: US_MANUAL },
  { id: 'scout_carbine', cost: 2, cartridge: '.30 Carbine', action: 'Semi-automatic', feed: '15-round magazine',
    description: 'A compact, light arm developed for officers and support troops. Its smaller cartridge offers less reach than the Garand’s full-power rifle round.',
    handling: 'Quick follow-up shots at intermediate range, with lower damage and reach than a full-size rifle.', source: 'https://thecmp.org/sales-and-service/m1-carbine-information/' },
  { id: 'thompson', cost: 4, cartridge: '.45 ACP', action: 'Automatic', feed: '20- or 30-round box magazine',
    description: 'The M1A1 Thompson fires pistol ammunition from box magazines. A relatively heavy submachine gun suited to close fighting rather than distant rifle engagements.',
    handling: 'Strong close-range bursts and suppression. Limited reach and a pause between bursts.', source: US_MANUAL },
  { id: 'sten', cost: 2, cartridge: '9×19 mm', action: 'Automatic, open bolt', feed: '32-round magazine',
    description: 'An economical British submachine gun, also supplied to resistance forces. Its simple construction and pistol cartridge favor close engagements. Allied cross-issue is a game option.',
    handling: 'Affordable short-range burst fire; lighter individual hits than rifle ammunition.', source: 'https://stephentaylorhistorian.com/wp-content/uploads/2020/02/a-basic-manual-of-military-small-arms-1943-all-countries-huge-number-of-weapons-shown.pdf' },
  { id: 'm3', cost: 2, cartridge: '.45 ACP', action: 'Automatic, open bolt', feed: '30-round magazine',
    description: 'The U.S. M3 “Grease Gun” was a simpler production alternative to the Thompson. Its slower cyclic rate gives a more measured burst, while its pistol ammunition limits reach.',
    handling: 'Controlled close-range bursts. Slower firing cadence than the Thompson; poor reach against riflemen.', source: US_MANUAL },
  { id: 'springfield', cost: 3, cartridge: '.30-06 Springfield', action: 'Bolt-action, iron sights', feed: '5-round internal magazine',
    description: 'The unscoped M1903 Springfield uses a full-power rifle cartridge and a manually operated bolt. It remains distinct from the telescopic-sight M1903A4 sniper variant.',
    handling: 'Accurate, deliberate rifle fire. Longer reach than a carbine, with slower follow-up shots than the Garand.', source: US_MANUAL },
  { id: 'lee_enfield', cost: 3, cartridge: '.303 British', action: 'Bolt-action, aperture sights', feed: '10-round magazine, charger-loaded',
    description: 'The British No. 4 Mk I service rifle combines aperture sights with a ten-round magazine. Its bolt must be worked between shots. Allied cross-issue is a game option.',
    handling: 'Accurate long-range rifle fire. Faster follow-up than the unscoped Springfield here, but slower than the Garand.', source: 'https://paradata.org.uk/content/4663813-lee-enfield-rifles' },
  { id: 'mg', cost: 6, cartridge: '.30-06 Springfield', action: 'Automatic, bipod support', feed: '20-round magazine',
    description: 'The M1918A2 Browning Automatic Rifle supplies portable squad firepower. Its small magazine and fixed barrel constrain prolonged fire compared with a belt-fed machine gun.',
    handling: 'Long suppressive bursts. Less precise per shot than an aimed rifle; magazine changes interrupt fire.', source: US_MANUAL },
  { id: 'bren', cost: 7, cartridge: '.303 British', action: 'Automatic, bipod support', feed: '30-round magazine, commonly loaded to 28',
    description: 'The British Bren is an accurate squad light machine gun, normally served by a gunner and assistant. Its top-mounted magazine and spare barrel support controlled fire. Allied cross-issue is a game option.',
    handling: 'More accurate, shorter bursts than the BAR in this game; good suppression, with a longer pause between bursts.', source: 'https://www.awm.gov.au/visit/exhibitions/korea/weapons/bren' },
  { id: 'sniper', cost: 8, cartridge: '.30-06 Springfield', action: 'Bolt-action, telescopic sight', feed: '5-round internal magazine',
    description: 'The M1903A4 is the dedicated scoped Springfield variant. The sight aids deliberate distant shooting; it does not remove the need to operate the bolt and reacquire the target.',
    handling: 'Greatest reach and highest aimed precision. Very slow follow-up shots and poor crowd suppression.', source: US_ARMS },
];

const RIFLES = ['rifle', 'scout_carbine', 'thompson', 'sten', 'm3', 'springfield', 'lee_enfield'];
export function weaponChoices(unit: Pick<Unit, 'team' | 'role'>): readonly WeaponIssue[] {
  if (unit.team !== 'friendly') return [];
  const ids = unit.role === 'mg' ? ['mg', 'bren'] : unit.role === 'sniper' ? [...RIFLES, 'sniper']
    : ['rifleman', 'scout', 'assault_infantry', 'engineer', 'radio_engineer', 'officer', 'supply_officer'].includes(unit.role) ? RIFLES : [];
  return ARMORY.filter((weapon) => ids.includes(weapon.id));
}

export function canIssueWeapon(unit: Pick<Unit, 'team' | 'role'>, weaponId: string): boolean {
  return weaponChoices(unit).some((weapon) => weapon.id === weaponId);
}

export const WEAPON_ISSUE_SECONDS = 3;
