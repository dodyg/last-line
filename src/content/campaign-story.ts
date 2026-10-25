import { CONFIG } from './config';
import type { CampaignCountry, Season } from '../simulation/types';

export interface HistoricalSource { title: string; url: string }
export interface CampaignChapter {
  title: string;
  period: string;
  /** Ordered seasons covered by this chapter; progress follows secured sectors. */
  seasons: readonly [Season, ...Season[]];
  context: string;
  orders: string;
  source: HistoricalSource;
}
export interface CampaignStory {
  title: string;
  premise: string;
  chapters: readonly CampaignChapter[];
  aftermath: string;
}

const breakout = { title: 'U.S. Army Center of Military History · Breakout and Pursuit', url: 'https://history.army.mil/Publications/Publications-Catalog/Breakout-And-Pursuit/' };
const lorraine = { title: 'U.S. Army University Press · The Encirclement of Nancy', url: 'https://www.armyupress.army.mil/Staff-Rides/Virtual-Staff-Ride/The-Encirclement-of-Nancy/' };
const europe = { title: 'U.S. Army Center of Military History · The War Against Germany', url: 'https://history.army.mil/Portals/143/Images/Publications/Publication%20By%20Title%20Images/W%20PDF/CMH_Pub_12-3.pdf' };
const bulge = { title: 'U.S. Army Medical Department · The German Counteroffensive in the Ardennes', url: 'https://achh.army.mil/history/book-wwii-bulge-garandchap-files-garandchap/' };
const italy = { title: 'National Army Museum · The battle for Italy', url: 'https://www.nam.ac.uk/explore/italian-campaign' };
const marketGarden = { title: 'National Army Museum · Operation Market Garden', url: 'https://www.nam.ac.uk/explore/market-garden?os=f' };
const scheldt = { title: 'Veterans Affairs Canada · The Battle of the Scheldt', url: 'https://www.veterans.gc.ca/en/remembrance/wars-and-conflicts/second-world-war/battle-of-the-scheldt?wbdisable=false' };
const liberation = { title: 'Veterans Affairs Canada · Liberation of the Netherlands', url: 'https://veterans.gc.ca/eng/remembrance/wars-and-conflicts/second-world-war/liberation-of-netherlands' };
const luxembourg = { title: 'Government of Luxembourg · The Second World War', url: 'https://luxembourg.public.lu/en/society-and-culture/history/second-world-war.html' };

export const STORY_NOTE = 'Historical campaign chronology; fictional U.S. squad and orders. Generated maps are composite engagements, not exact battle locations. Regional labels and the north exit are gameplay abstractions. Seasons follow the chapter chronology. Each country is a separate campaign; coalition operations are not attributed to this squad.';

export const CAMPAIGN_STORIES: Record<CampaignCountry, CampaignStory> = {
  france: {
    title: 'From the hedgerows to the frontier',
    premise: 'Your detachment holds the roads behind the Allied advance. Every position secured lets the next convoy and the next company move forward.',
    chapters: [
      { title: 'A foothold is not a breakthrough', period: 'July 1944', seasons: ['summer'], context: 'After the June landings, the Normandy campaign became a struggle through hedgerows. German resistance kept the Allied foothold from becoming a rapid advance inland.', orders: 'Hold a lane through the bocage. Repel the counterattacks, secure the northern sector, and bring the surviving squad to the next position.', source: breakout },
      { title: 'The front breaks open', period: 'Late July–August 1944', seasons: ['summer'], context: 'The breakout from Normandy turned slow fighting into pursuit. The German counterattack at Mortain failed to restore the front; Allied forces pressed on across France.', orders: 'Protect the exposed flank of the pursuit. Clear each blocking position before moving the veterans forward; speed means little if the supply road closes behind you.', source: breakout },
      { title: 'An army runs on roads', period: 'August–September 1944', seasons: ['summer', 'autumn'], context: 'Paris was liberated in August, but victory was still distant. The pursuit stretched Allied supply routes and gave retreating German forces an opportunity to regroup.', orders: 'Keep a route open for fuel, ammunition, and wounded men. Establish a defensible stop, defeat the local attacks, then hand the road on to the next unit.', source: breakout },
      { title: 'The Moselle barrier', period: 'September 1944', seasons: ['autumn'], context: 'The Third Army reached the Moselle after its advance across France. Fighting for bridgeheads around Nancy showed that the pursuit had become another contested campaign.', orders: 'Secure the approaches to the next crossing. Hold against counterattacks until the sector is safe, then move the squad onward together.', source: lorraine },
    ],
    aftermath: 'Your route is secure. Beyond these positions, the war continued through the frontier battles and the winter of 1944–45. France was a passage toward victory, not the end of the fighting.',
  },
  belgium: {
    title: 'The roads that held the front',
    premise: 'Liberation brings the army into Belgium, but the roads it needs for the advance will soon become the roads it must defend.',
    chapters: [
      { title: 'Beyond the French frontier', period: 'September 1944', seasons: ['autumn'], context: 'The Allied pursuit carried into Belgium. Antwerp was captured, but possession of its docks alone could not supply the armies while the Scheldt approaches remained under German control.', orders: 'Secure the next road junction. Keep the route behind the advance open and move only after the local position can be handed over.', source: scheldt },
      { title: 'A port without a passage', period: 'October–November 1944', seasons: ['autumn'], context: 'The First Canadian Army led the struggle to clear the Scheldt in northern Belgium and the southwestern Netherlands. Access to Antwerp depended on fighting through canals, dykes, and defended low ground.', orders: 'Hold a supporting route while the wider battle for supply access continues. Deny the enemy a way back into the road network.', source: scheldt },
      { title: 'The quiet front erupts', period: 'December 1944', seasons: ['winter'], context: 'On 16 December, German forces attacked through the Ardennes. American formations resting or gaining experience on a supposedly quiet front suddenly faced a major offensive.', orders: 'Trade ground for time if you must, but make each stand count. Secure a sector before marching out to earn progress; evacuating an unsecured position earns none.', source: bulge },
      { title: 'Recovering the road', period: 'January 1945', seasons: ['winter'], context: 'The Ardennes fighting continued into January as Allied armies recovered the initiative. Roads and settlements that had changed hands had to be secured again.', orders: 'Reopen the route one defended position at a time. Keep the veterans together; the campaign needs soldiers who can hold the next junction as well as take it.', source: europe },
    ],
    aftermath: 'The route through Belgium is held. The Ardennes offensive did not reverse the Allied advance, but its human cost remained long after the armies moved east.',
  },
  italy: {
    title: 'The long road north',
    premise: 'This is the Italian front, fought alongside the war in northwest Europe. Your detachment keeps a route open through a campaign of repeated defensive lines.',
    chapters: [
      { title: 'Beyond Rome', period: 'June–August 1944', seasons: ['summer'], context: 'Rome fell to the Allies on 4 June. The German armies withdrew northward, using successive defensive positions to slow the U.S. Fifth and British Eighth Armies.', orders: 'Keep the pursuing columns supplied. Secure the next halt and its approaches, then bring the squad forward before the enemy can isolate it.', source: italy },
      { title: 'The Gothic Line', period: 'August–September 1944', seasons: ['summer', 'autumn'], context: 'The Allied advance reached the Gothic Line on the approaches to the Po Valley. Mountain terrain and prepared defences made another quick breakthrough elusive.', orders: 'Hold the road serving the forward troops. Deny the enemy a counterattack route and preserve enough men to establish the next position.', source: italy },
      { title: 'A winter of holding on', period: 'Autumn 1944–winter 1945', seasons: ['autumn', 'winter'], context: 'Bad weather and difficult supply routes slowed the Italian campaign. The multinational Allied armies fought on while partisan activity continued behind German lines.', orders: 'Defend the supply link. Recover between attacks, use cover, and secure each sector before committing the squad to the next march.', source: italy },
      { title: 'Out toward the plain', period: 'April 1945', seasons: ['spring'], context: 'The spring offensive finally carried Allied forces into the Po Valley. The long campaign approached its end as German resistance in Italy collapsed.', orders: 'Keep the route open through the final positions. Do not spend the surviving squad carelessly simply because the wider front is giving way.', source: italy },
    ],
    aftermath: 'Your detachment has completed its route. The German surrender in Italy took effect on 2 May 1945; surviving civilians and soldiers faced a country scarred by occupation and war.',
  },
  germany: {
    title: 'Through the western defences',
    premise: 'The German frontier is not an open door. Your detachment must secure the roads behind a succession of difficult advances into the Reich.',
    chapters: [
      { title: 'At the frontier', period: 'September–October 1944', seasons: ['autumn'], context: 'The rapid summer pursuit gave way to the Rhineland campaign. German frontier defences and resistance around Aachen confronted Allied forces with a new kind of battle.', orders: 'Anchor a position on the approach roads. Repel the local attacks and secure room for the next move.', source: europe },
      { title: 'The forest front', period: 'November–December 1944', seasons: ['autumn', 'winter'], context: 'The Rhineland fighting continued through late autumn, including the costly battles in the Hürtgen Forest. An approach toward the Rhine became a prolonged struggle for defended ground.', orders: 'Protect the link to the forward companies. Keep fields of fire covered and move the squad together when the position is secure.', source: europe },
      { title: 'The advance resumes', period: 'February–March 1945', seasons: ['winter', 'spring'], context: 'After the Ardennes crisis, Allied operations again pressed toward the Rhine. The western German campaign moved from the frontier battles toward the river barrier.', orders: 'Secure a staging position for the renewed advance. Hold its road and approaches before committing to the next sector.', source: europe },
      { title: 'Beyond the Rhine', period: 'March–April 1945', seasons: ['spring'], context: 'The crossing of the Rhine opened the Central Europe campaign. Allied armies advanced into Germany as organised resistance increasingly broke apart.', orders: 'Keep the route behind the advance usable. Clear the remaining positions and preserve the men who have carried this campaign this far.', source: europe },
    ],
    aftermath: 'Your assigned route is secure. Germany surrendered in May 1945. The end of combat in Europe left the work of occupation, relief, and rebuilding still ahead.',
  },
  luxembourg: {
    title: 'Liberation, then the storm',
    premise: 'Your detachment guards the links between frontier outposts and the roads behind them. In Luxembourg, liberation will have to be defended.',
    chapters: [
      { title: 'The flags return', period: 'September 1944', seasons: ['autumn'], context: 'American troops liberated Luxembourg City on 10 September. The advance toward the German border brought hope after years of Nazi occupation.', orders: 'Secure the local road network. Keep the passage open for the units moving toward the frontier.', source: luxembourg },
      { title: 'Watching the border', period: 'Autumn 1944', seasons: ['autumn'], context: 'The front stabilised along the eastern border. Apparent quiet concealed the danger of a renewed German attack.', orders: 'Hold the approaches between outposts. Build a position that can withstand a sudden assault and keep a way out for the squad.', source: luxembourg },
      { title: 'The offensive breaks', period: 'December 1944', seasons: ['winter'], context: 'The German counteroffensive struck northern and eastern Luxembourg during the Battle of the Bulge. Communities recently liberated became battlefields again.', orders: 'Delay the enemy at each defensible position. An evacuation saves soldiers, but only a secured sector advances your campaign.', source: luxembourg },
      { title: 'Liberation a second time', period: 'January–February 1945', seasons: ['winter'], context: 'The north and east had to be recovered after the German offensive. Vianden was liberated on 22 February, as the fighting finally moved beyond Luxembourg.', orders: 'Secure the routes back through the battered settlements. Bring the surviving veterans through the last positions together.', source: luxembourg },
    ],
    aftermath: 'The route is open again. Liberation did not erase Luxembourg’s losses under occupation or the destruction of the winter battles; recovery would take years.',
  },
  netherlands: {
    title: 'Bridges, supply lines, liberation',
    premise: 'Your fictional U.S. detachment holds supporting positions in a wider coalition campaign. A crossing matters only while the road behind it remains open.',
    chapters: [
      { title: 'The bridge gamble', period: 'September 1944', seasons: ['autumn'], context: 'Operation Market Garden sought a route across Dutch bridges into Germany. U.S. airborne divisions fought at Eindhoven and Nijmegen; British and Polish troops fought at Arnhem. The attempt failed to secure the final crossing.', orders: 'Defend a supporting route against counterattacks. Keep the squad’s passage open; do not assume that taking one position means the whole corridor is safe.', source: marketGarden },
      { title: 'Opening the supply artery', period: 'October–November 1944', seasons: ['autumn'], context: 'The First Canadian Army led the Scheldt campaign to open Antwerp to shipping. Fighting through the estuary’s defended approaches made the captured port usable for the Allied armies.', orders: 'Hold the roads supporting the wider supply effort. Secure the sector, take what supplies the squad needs, and move on as a unit.', source: scheldt },
      { title: 'A divided country', period: 'Winter 1944–45', seasons: ['winter'], context: 'Liberation remained incomplete. The occupied western Netherlands endured the Hunger Winter while Allied armies prepared further operations.', orders: 'Keep a supporting position connected to the rear. Preserve the squad and prevent counterattacks from cutting the route through the liberated area.', source: liberation },
      { title: 'The last positions', period: 'April–May 1945', seasons: ['spring'], context: 'Canadian and other Allied forces liberated more of the Netherlands in the spring. German forces in the Netherlands surrendered in May, ending the occupation.', orders: 'Secure the remaining route without wasting the survivors of the winter. Every position held brings this detachment closer to the end of its assignment.', source: liberation },
    ],
    aftermath: 'Your supporting route is secure. Dutch liberation was a coalition achievement, with a major Canadian role. The end of occupation brought relief, mourning, and the task of feeding and rebuilding a devastated country.',
  },
};

/** Progress follows secured maps, never evacuations, combat ticks, or random seeds. */
export function campaignChapter(country: CampaignCountry, mapsCleared: number, goal = CONFIG.crossing.campaignMaps) {
  const story = CAMPAIGN_STORIES[country];
  const index = Math.min(story.chapters.length - 1, Math.floor(Math.max(0, mapsCleared) * story.chapters.length / Math.max(1, goal)));
  const nextAt = Math.ceil((index + 1) * goal / story.chapters.length);
  return { story, chapter: story.chapters[index]!, index, nextAt, next: story.chapters[index + 1] };
}

export interface FieldDispatch {
  country: CampaignCountry;
  mapsCleared: number;
  mapNumber: number;
  sector: string;
  arrival: 'deployment' | 'secured' | 'withdrawal' | 'review';
  squad: number;
}

export function dispatchHandover(dispatch: FieldDispatch): string {
  const strength = `${dispatch.squad} soldier${dispatch.squad === 1 ? '' : 's'}`;
  switch (dispatch.arrival) {
    case 'deployment': return `Headquarters assigns ${strength} to the first blocking position. Establish the line before the enemy arrives.`;
    case 'secured': return `The previous sector is secure. ${strength} reached this position; the supply detail has caught up. Refit here before the next attack.`;
    case 'withdrawal': return `${strength} evacuated the previous position before it was secured. Headquarters has ordered a fallback stand here. No campaign progress was earned; the current historical chapter continues.`;
    case 'review': return `Current assignment: ${strength} on the field. Review these orders before resuming the battle.`;
  }
}

/** Narrative chronology owns campaign seasons; map seeds cannot change the date. */
export function campaignSeason(country: CampaignCountry, mapsCleared: number, goal = CONFIG.crossing.campaignMaps): Season {
  const { chapter, index, story } = campaignChapter(country, mapsCleared, goal);
  const start = Math.ceil(index * goal / story.chapters.length);
  const end = Math.ceil((index + 1) * goal / story.chapters.length);
  const progress = Math.max(0, mapsCleared - start) / Math.max(1, end - start);
  return chapter.seasons[Math.min(chapter.seasons.length - 1, Math.floor(progress * chapter.seasons.length))]!;
}
