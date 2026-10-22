import type { Season } from '../../simulation/types';

export interface SeasonPalette {
  ground: readonly [number, number, number];
  pasture: string;
  wheat: string;
  ploughed: string;
  orchard: string;
  yard: string;
  mud: string;
  bank: string;
  shoulder: string;
  snowCover: number;
  snow: number;
  foliage: readonly number[];
  sky: number;
}

export const SEASON_PALETTES: Record<Season, SeasonPalette> = {
  spring: { ground: [91, 117, 66], pasture: '#789252', wheat: '#93a65a', ploughed: '#705746', orchard: '#6c8949',
    yard: '#83785a', mud: '#65503c', bank: '#83925f', shoulder: '#738251', snowCover: 0, snow: 0xe4e8e3,
    foliage: [0x719747, 0x8caa53, 0xa6bd68], sky: 0x293528 },
  summer: { ground: [83, 94, 62], pasture: '#65734a', wheat: '#a29958', ploughed: '#71604a', orchard: '#596b41',
    yard: '#7d7357', mud: '#66583f', bank: '#7c7855', shoulder: '#6b6b4a', snowCover: 0, snow: 0xe4e8e3,
    foliage: [0x435c32, 0x61763f, 0x829052], sky: 0x20251b },
  autumn: { ground: [117, 101, 62], pasture: '#968457', wheat: '#b49a60', ploughed: '#785640', orchard: '#937044',
    yard: '#887458', mud: '#69503d', bank: '#9a8154', shoulder: '#897447', snowCover: 0, snow: 0xe4e8e3,
    foliage: [0xa85e2e, 0xc58c39, 0xc6aa4a], sky: 0x343025 },
  winter: { ground: [190, 201, 199], pasture: '#c0cac5', wheat: '#b7b5a1', ploughed: '#8c8b80', orchard: '#bdc5bc',
    yard: '#aaa99b', mud: '#7b7a6d', bank: '#c4d0ca', shoulder: '#c7d1cb', snowCover: .78, snow: 0xe7eeed,
    foliage: [0x655c4d, 0x7c7361, 0x9c9a89], sky: 0x323c42 },
};

export function seasonPalette(season: Season = 'summer'): SeasonPalette { return SEASON_PALETTES[season]; }

export function seasonGroundColor(season: Season = 'summer'): number {
  const [r, g, b] = seasonPalette(season).ground;
  return (r << 16) | (g << 8) | b;
}
