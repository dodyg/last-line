import type { PatrolArea, SimEvent, SimState } from '../simulation/types';
import type { TerrainData } from '../simulation/terrain';
import type { Preferences } from '../persistence';

export interface PreviewInfo {
  cost?: number;
  kind: 'suppress' | 'ambush' | 'recruit' | 'barbedWire' | 'sandbag' | 'trench' | 'bunker' | 'mortarPit' | 'bridge' | 'mine' | 'artillery' | 'airSupport' | 'flare' | 'smoke' | 'satchel' | 'patrol' | 'demolishFence';
  patrolArea?: PatrolArea;
  ambushArcs?: { origin: { x: number; y: number }; facing: number; range: number; arcDegrees: number }[];
  role?: string;
  mineKind?: 'ap' | 'at';
  throwerPos?: { x: number; y: number };
  throwRange?: number;
  pos: { x: number; y: number };
  valid: boolean;
  reason?: string;
  engineerPos?: { x: number; y: number };
  engineerRange?: number;
  bridgeAxis?: 'horizontal' | 'vertical';
  bridgeHalfWidth?: number;
  bridgeHalfLength?: number;
}

/** Logical battlefield pixels, with the same orientation and units as simulation coordinates. */
export interface DragRect { x0: number; y0: number; x1: number; y1: number }

/** The controller owns simulation state; the renderer treats it as read-only. */
export interface RendererPort {
  setPreferences?(prefs: Preferences): void;
  resetCamera?(): void;
  rebuildStatic(state: SimState, terrainData: TerrainData): void;
  handleEvents(state: SimState, events: readonly SimEvent[]): void;
  frame(state: SimState, alpha: number, preview: PreviewInfo | null, selection: readonly number[], dt: number, drag?: DragRect | null): void;
  shake(magnitude: number, duration: number): void;
  getShakeMagnitude(): number;
  destroy(): void;
}
