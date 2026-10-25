import { CONFIG } from '../content/config';
import { dayNightAtTick } from './daynight';
import { elevationAt } from './elevation';
import { unitEyeHeight } from './buildings';
import { foliageAlongLine, hasLineOfSight, isFoliageKind } from './terrain';
import type { NightContact, SimState, Unit, Vec2, WeaponStats } from './types';

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

export function nightContactFor(state: SimState, observer: Unit, target: Unit): NightContact | undefined {
  if (!dayNightAtTick(state.ticks, state.dayNightStartTick).night) return undefined;
  return observer.nightContacts?.find((contact) => contact.sourceId === target.id && contact.expiresTick > state.ticks
    && distance(contact.pos, target.pos) <= CONFIG.dayNight.gunfire.trackRadius
    && Math.abs(contact.height - elevationAt(state.terrain, target.pos.x, target.pos.y) - unitEyeHeight(state.terrain, target)) <= CONFIG.dayNight.gunfire.trackRadius);
}

/** Hearing has no line of sight requirement; flashes and tracers do. */
export function recordNightGunfire(state: SimState, source: Unit, kinds: Uint8Array, weapon?: WeaponStats): void {
  if (source.dead || source.health <= 0 || source.crossed) return;
  const night = dayNightAtTick(state.ticks, state.dayNightStartTick).night;
  const tuning = CONFIG.dayNight.gunfire, weather = CONFIG.weather[state.weather];
  const loudness = source.role === 'mortarman' || weapon?.kind === 'explosive' ? 1.4 : (weapon?.burstShots ?? 1) > 1 ? 1.1 : 1;
  const soundMult = Math.max(.4, 1 - weather.rainIntensity * .5 - (weather.snowIntensity ?? 0) * .3);
  const cell = state.terrain.cell;
  const index = Math.floor(source.pos.y / cell) * state.terrain.cols + Math.floor(source.pos.x / cell);
  for (const observer of state.units) {
    if (observer.team === source.team || observer.dead || observer.health <= 0 || observer.crossed) continue;
    const range = distance(observer.pos, source.pos);
    if (observer.team === 'friendly' && range <= tuning.soundRadius * loudness * soundMult) {
      observer.heardGunfire = [...(observer.heardGunfire ?? []).filter((old) => old.sourceId !== source.id && old.expiresTick > state.ticks), {
        sourceId: source.id, pos: { ...source.pos }, noticedTick: state.ticks,
        expiresTick: state.ticks + Math.round(CONFIG.tickRate * CONFIG.gunfireOrder.memorySeconds),
      }];
    }
    if (!night) continue;
    const foliage = (isFoliageKind(kinds[index] ?? 0) ? CONFIG.treeCover.visibilityMult : 1)
      * CONFIG.treeCover.lineVisibilityMult ** Math.min(8, foliageAlongLine(state.terrain, kinds, observer.pos, source.pos));
    const visualMult = weather.visibilityMult * foliage;
    const flash = range <= tuning.flashRadius * visualMult;
    const tracer = weapon !== undefined && range <= tuning.tracerRadius * visualMult;
    const ownBuildings = [source.buildingPosition?.buildingId, observer.buildingPosition?.buildingId].filter((id): id is number => id !== undefined);
    const clear = (flash || tracer) && hasLineOfSight(state.terrain, observer.pos, source.pos,
      unitEyeHeight(state.terrain, observer), unitEyeHeight(state.terrain, source), ownBuildings)
      && !state.smokes.some((smoke) => segmentDistance(smoke.pos, observer.pos, source.pos) <= smoke.radius);
    const kind: NightContact['kind'] | undefined = clear ? flash ? 'muzzleFlash' : 'tracer'
      : range <= tuning.soundRadius * loudness * soundMult ? 'sound' : undefined;
    if (!kind) continue;
    const contact: NightContact = {
      sourceId: source.id, kind, pos: { ...source.pos },
      height: elevationAt(state.terrain, source.pos.x, source.pos.y) + unitEyeHeight(state.terrain, source),
      noticedTick: state.ticks,
      expiresTick: state.ticks + Math.round(CONFIG.tickRate * (kind === 'sound' ? tuning.soundMemorySeconds : tuning.visualMemorySeconds)),
    };
    observer.nightContacts = [...(observer.nightContacts ?? []).filter((old) => old.sourceId !== source.id && old.expiresTick > state.ticks), contact];
  }
}

export function latestNightContact(unit: Unit, ticks: number): NightContact | undefined {
  let latest: NightContact | undefined;
  for (const contact of unit.nightContacts ?? []) {
    if (contact.expiresTick <= ticks) continue;
    if (latest === undefined || contact.noticedTick > latest.noticedTick) {
      latest = contact;
    } else if (contact.noticedTick === latest.noticedTick) {
      const proximity = distance(unit.pos, contact.pos) - distance(unit.pos, latest.pos);
      if (proximity < 0 || (proximity === 0 && contact.sourceId < latest.sourceId)) latest = contact;
    }
  }
  return latest;
}

export function contactBearing(from: Vec2, to: Vec2): string {
  const octant = (Math.round(Math.atan2(to.x - from.x, from.y - to.y) / (Math.PI / 4)) + 8) % 8;
  return ['North', 'North-East', 'East', 'South-East', 'South', 'South-West', 'West', 'North-West'][octant]!;
}

function segmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x, dy = end.y - start.y;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - start.x - dx * t, point.y - start.y - dy * t);
}
