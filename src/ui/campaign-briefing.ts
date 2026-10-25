import { CAMPAIGNS } from '../content/campaigns';
import { campaignChapter, dispatchHandover, STORY_NOTE, type FieldDispatch } from '../content/campaign-story';
import { CONFIG } from '../content/config';

/** Shared by the deployment/pause dossier and the arrival supply screen. */
export function renderCampaignBriefing(dispatch: FieldDispatch): HTMLElement {
  const { story, chapter, index, next, nextAt } = campaignChapter(dispatch.country, dispatch.mapsCleared);
  const section = document.createElement('section');
  section.className = 'campaign-briefing';
  section.setAttribute('aria-label', 'Campaign field briefing');
  const add = (tag: string, text: string, className = '') => {
    const el = document.createElement(tag);
    el.textContent = text;
    el.className = className;
    section.append(el);
    return el;
  };
  add('p', `${CAMPAIGNS[dispatch.country].name} · ${chapter.period} · Chapter ${index + 1}/${story.chapters.length}`, 'dispatch-kicker');
  add('h3', chapter.title);
  add('p', chapter.context);
  add('p', `Map ${dispatch.mapNumber} · ${dispatch.sector}`, 'dispatch-location');
  add('p', dispatchHandover(dispatch));
  add('h4', 'Your orders');
  add('p', chapter.orders);
  add('p', 'Repel all waves or capture the northern objective, then march every survivor through the north exit. Fortifications stay behind.', 'subtle');
  add('p', `${dispatch.mapsCleared}/${CONFIG.crossing.campaignMaps} sectors secured. ${next ? `Next: ${next.title}, after ${nextAt} secured sectors.` : 'Final chapter: complete the remaining secured sectors to finish this assignment.'}`, 'dispatch-progress');
  add('h4', 'Ground and support');
  add('p', 'Wet mud and water hinder vehicles most; roads and bridges keep supply routes usable. Ruins provide infantry cover but slow movement. Scouts can establish observation posts in elevated buildings. Engineers repair standing structures; prepare another position before a strongpoint collapses.', 'subtle');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Historical source & campaign scope';
  const note = document.createElement('p');
  note.textContent = STORY_NOTE;
  const link = document.createElement('a');
  link.textContent = chapter.source.title;
  link.href = chapter.source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  details.append(summary, note, link);
  section.append(details);
  return section;
}
