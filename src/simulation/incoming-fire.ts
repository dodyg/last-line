import { CONFIG } from '../content/config';
import type { Strike } from './types';

/** Target-specific warnings and evasive movement share the same audible approach window. */
export function strikeIsImminent(strike: Strike, tick: number): boolean {
  const seconds = strike.delivery === 'mortar' ? CONFIG.incomingFire.mortarWarningSeconds
    : strike.delivery === 'airSupport' ? CONFIG.incomingFire.airSupportWarningSeconds
      : CONFIG.incomingFire.artilleryWarningSeconds;
  const remaining = strike.landTick - tick;
  return remaining > 0 && remaining <= Math.round(seconds * CONFIG.tickRate);
}
