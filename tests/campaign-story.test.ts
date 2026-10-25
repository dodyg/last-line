import { beforeEach, describe, expect, it } from 'vitest';
import { CAMPAIGN_COUNTRIES } from '../src/content/campaigns';
import { CAMPAIGN_STORIES, campaignChapter, campaignSeason, dispatchHandover, type FieldDispatch } from '../src/content/campaign-story';
import { generateTerrain } from '../src/simulation/terrain';
import { Simulation } from '../src/simulation/simulation';
import { CONFIG } from '../src/content/config';
import { SEASON_WEATHER } from '../src/simulation/seasons';
import { renderCampaignBriefing } from '../src/ui/campaign-briefing';

const dispatch: FieldDispatch = { country: 'france', mapsCleared: 25, mapNumber: 30, sector: 'Normandie · Bocage', arrival: 'secured', squad: 3 };
beforeEach(() => document.body.replaceChildren());

describe('historical campaign narrative', () => {
  it('uses summer for the Normandy chapters regardless of map seed', () => {
    for (const seed of [1, 2, 3, 2026, 9001]) {
      const data = generateTerrain(seed, true, 4, 'france');
      expect(data.season).toBe('summer');
      expect(data.weather.toLowerCase()).not.toContain('snow');
    }
    expect(campaignSeason('france', 0)).toBe('summer');
    expect(campaignSeason('france', 49)).toBe('summer');
    expect(campaignSeason('france', 74)).toBe('autumn');
    expect(campaignSeason('belgium', 50)).toBe('winter');
    expect(campaignSeason('italy', 75)).toBe('spring');
  });

  it.each(CAMPAIGN_COUNTRIES)('restores %s with scenery and weather matching narrative progress', (country) => {
    const sim = new Simulation(2026, undefined, generateTerrain(2026, true, 4, country));
    for (const progress of [0, 50, 75]) {
      const snap = sim.snapshot();
      snap.mapsCleared = progress;
      snap.season = 'winter'; snap.weather = 'heavySnow';
      const restored = Simulation.fromSnapshot(snap);
      const expected = campaignSeason(country, progress);
      expect(restored.state.season).toBe(expected);
      expect(restored.terrainData().season).toBe(expected);
      expect(SEASON_WEATHER[expected]).toContain(restored.state.weather);
    }
  });

  it.each([false, true])('changes the season only with credited chapter progress (secured: %s)', (secured) => {
    const sim = new Simulation(2026, undefined, generateTerrain(2026, true, 4, 'belgium'));
    sim.state.mapsCleared = 49;
    sim.state.sectorCaptured = secured;
    for (const unit of sim.state.units.filter((unit) => unit.team === 'friendly')) {
      unit.pos.y = CONFIG.crossing.thresholdY;
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.pinned = false;
    }
    sim.step();
    expect(sim.state.mapNumber).toBe(2);
    expect(sim.state.mapsCleared).toBe(secured ? 50 : 49);
    expect(sim.state.season).toBe(secured ? 'winter' : 'autumn');
    expect(sim.terrainData().season).toBe(sim.state.season);
    expect(SEASON_WEATHER[sim.state.season!]).toContain(sim.state.weather);
  });

  it.each(CAMPAIGN_COUNTRIES)('advances %s only on secured-sector milestones and never loops after completion', (country) => {
    expect(campaignChapter(country, 0).index).toBe(0);
    expect(campaignChapter(country, 24).index).toBe(0);
    expect(campaignChapter(country, 25).index).toBe(1);
    expect(campaignChapter(country, 50).index).toBe(2);
    expect(campaignChapter(country, 75).index).toBe(3);
    expect(campaignChapter(country, 100).index).toBe(3);
    expect(campaignChapter(country, 1000).next).toBeUndefined();
    for (const chapter of CAMPAIGN_STORIES[country].chapters) {
      expect(new URL(chapter.source.url).protocol).toBe('https:');
      expect(chapter.context.length).toBeGreaterThan(60);
    }
    for (let progress = 0; progress <= 100; progress++) {
      expect(campaignChapter(country, progress).chapter.seasons).toContain(campaignSeason(country, progress));
    }
  });

  it('distinguishes an unsecured evacuation from a credited advance', () => {
    expect(dispatchHandover(dispatch)).toContain('previous sector is secure');
    const withdrawal = { ...dispatch, arrival: 'withdrawal' as const, mapNumber: 31 };
    expect(dispatchHandover(withdrawal)).toContain('No campaign progress was earned');
    expect(renderCampaignBriefing(withdrawal).textContent).toContain('Chapter 2/4');
  });

  it('shows current location, operational purpose, survivor count, next milestone, and inspectable sources', () => {
    const panel = renderCampaignBriefing(dispatch);
    document.body.append(panel);
    expect(panel.textContent).toContain('Map 30 · Normandie · Bocage');
    expect(panel.textContent).toContain('3 soldiers reached this position');
    expect(panel.textContent).toContain('Your orders');
    expect(panel.textContent).toContain('after 50 secured sectors');
    expect(panel.querySelector('details')?.textContent).toContain('fictional U.S. squad');
    expect(panel.querySelector('a')?.rel).toBe('noopener noreferrer');
    expect(panel.querySelector('a')?.href).toBe(campaignChapter('france', 25).chapter.source.url);
  });

  it('preserves local place labels as text and keeps theaters distinct', () => {
    const panel = renderCampaignBriefing({ ...dispatch, sector: '<img src=x onerror=alert(1)>' });
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.textContent).toContain('<img src=x');
    const italian = renderCampaignBriefing({ ...dispatch, country: 'italy', mapsCleared: 0 });
    expect(italian.textContent).toContain('Beyond Rome');
    expect(italian.textContent).not.toContain('Normandy');
    const dutch = renderCampaignBriefing({ ...dispatch, country: 'netherlands', mapsCleared: 0 });
    expect(dutch.textContent).toContain('failed to secure the final crossing');
  });
});
