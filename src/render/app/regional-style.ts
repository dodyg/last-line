import type { CampaignCountry } from '../../simulation/types';

export const REGIONAL_STYLE: Record<CampaignCountry, { ground: string; wall: number; roof: number; shutter: number; stone: string }> = {
  france: { ground: '#8b9864', wall: 0xb8ac8c, roof: 0x745952, shutter: 0x526d69, stone: '#b6aa8c' },
  belgium: { ground: '#71836a', wall: 0x997b62, roof: 0x595e65, shutter: 0x526256, stone: '#999b8e' },
  italy: { ground: '#b2a177', wall: 0xc4af89, roof: 0xa46b4b, shutter: 0x627251, stone: '#c2b18b' },
  germany: { ground: '#7d896a', wall: 0xa99883, roof: 0x62666c, shutter: 0x644f43, stone: '#a5a499' },
  luxembourg: { ground: '#81957d', wall: 0xb1a98d, roof: 0x576370, shutter: 0x617479, stone: '#aaa995' },
  netherlands: { ground: '#8b9d70', wall: 0xa2765d, roof: 0x7e5546, shutter: 0x4c665b, stone: '#b0a28b' },
};
