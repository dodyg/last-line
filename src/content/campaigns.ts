import type { BuildingKind, CampaignCountry, Team } from '../simulation/types';
import { deriveRng } from '../simulation/rng';

export type LocalLanguage = 'french' | 'dutch' | 'italian' | 'german' | 'luxembourgish';
export interface CampaignSector {
  label: string;
  /** Existing landscape families: bocage, orchard, hamlet, forest, fields, town. */
  setting: 0 | 1 | 2 | 3 | 4 | 5;
  language: LocalLanguage;
}
export interface CountryCampaign {
  name: string;
  description: string;
  sectors: readonly CampaignSector[];
  riverChance: number;
  groundTint: number;
  roof: readonly [number, number];
  trees: readonly ('oak' | 'beech' | 'birch' | 'pine')[];
  chatter: Record<Team, readonly string[]>;
}

export const CAMPAIGN_COUNTRIES: readonly CampaignCountry[] = ['france', 'belgium', 'italy', 'germany', 'luxembourg', 'netherlands'];
export const CAMPAIGNS: Record<CampaignCountry, CountryCampaign> = {
  france: {
    name: 'France', description: 'Normandy hedgerows, orchards, stone villages, and woodland. French signs and building names.',
    sectors: [
      { label: 'Normandie · Bocage', setting: 0, language: 'french' },
      { label: 'Val de Loire · Vergers', setting: 1, language: 'french' },
      { label: 'Picardie · Hameau', setting: 2, language: 'french' },
      { label: 'Vosges · Forêt', setting: 3, language: 'french' },
      { label: 'Champagne · Champs', setting: 4, language: 'french' },
      { label: 'Lorraine · Village', setting: 5, language: 'french' },
    ], riverChance: 0.55, groundTint: 0xb5ba92, roof: [0x897365, 0x5c5047], trees: ['oak', 'beech', 'birch'],
    chatter: { friendly: ['The sign says Rue de l’Église. Keep that church road covered.', 'These Normandy hedges hide a whole squad. Watch the gaps.'], enemy: ['Französisches Dorf voraus. Die Hecken im Auge behalten.', 'An der Kirche sammeln. Straße freihalten.'] },
  },
  belgium: {
    name: 'Belgium', description: 'Flemish farmland and brick villages meet the wooded Ardennes. Dutch and French signs vary by sector.',
    sectors: [
      { label: 'Vlaanderen · Akkers', setting: 4, language: 'dutch' },
      { label: 'Ardennes · Forêt', setting: 3, language: 'french' },
      { label: 'Wallonie · Village', setting: 5, language: 'french' },
      { label: 'Kempen · Bosweg', setting: 3, language: 'dutch' },
      { label: 'Brabant · Boomgaarden', setting: 1, language: 'dutch' },
      { label: 'Meuse · Hameau', setting: 2, language: 'french' },
    ], riverChance: 0.65, groundTint: 0xa9b69a, roof: [0x9b5d45, 0x6b4032], trees: ['oak', 'beech', 'pine'],
    chatter: { friendly: ['Belgian village ahead. Watch the windows along that brick row.', 'The Ardennes roads turn on themselves. Keep the squad together.'], enemy: ['Belgisches Dorf voraus. Fenster beobachten.', 'Im Ardennenwald nicht den Anschluss verlieren.'] },
  },
  italy: {
    name: 'Italy', description: 'Olive groves, stone hamlets, Apennine woodland, and Po Valley farms. Italian signs and terracotta roofs.',
    sectors: [
      { label: 'Toscana · Oliveti', setting: 1, language: 'italian' },
      { label: 'Appennini · Bosco', setting: 3, language: 'italian' },
      { label: 'Valle del Po · Campi', setting: 4, language: 'italian' },
      { label: 'Umbria · Borgo', setting: 5, language: 'italian' },
      { label: 'Emilia · Frutteti', setting: 1, language: 'italian' },
      { label: 'Lazio · Case di pietra', setting: 2, language: 'italian' },
    ], riverChance: 0.4, groundTint: 0xc8b785, roof: [0xb3764d, 0x7a492f], trees: ['pine', 'oak', 'pine'],
    chatter: { friendly: ['Via Roma on the sign. Keep an eye on that stone house.', 'Those olive trees hide movement. Check between the rows.'], enemy: ['Italienisches Dorf voraus. Die Steinhäuser decken den Weg.', 'Zwischen den Olivenbäumen tief bleiben.'] },
  },
  germany: {
    name: 'Germany', description: 'Rhineland towns, Eifel farms, and dense mixed forests. German street signs and slate or tile roofs.',
    sectors: [
      { label: 'Hürtgen · Waldweg', setting: 3, language: 'german' },
      { label: 'Rheinland · Felder', setting: 4, language: 'german' },
      { label: 'Rheinland · Ortsmitte', setting: 5, language: 'german' },
      { label: 'Eifel · Bauernhöfe', setting: 1, language: 'german' },
      { label: 'Westfalen · Dorf', setting: 5, language: 'german' },
      { label: 'Eifel · Mischwald', setting: 3, language: 'german' },
    ], riverChance: 0.6, groundTint: 0xa8ad90, roof: [0x777b7a, 0x484c4b], trees: ['pine', 'beech', 'pine', 'oak'],
    chatter: { friendly: ['Kirchstraße. Church street. Cover the junction by the steeple.', 'German woodland is thick here. Keep your buddy in sight.'], enemy: ['Kirchstraße sichern. Die Kreuzung muss frei bleiben.', 'Im Wald bleiben. Nicht auf der offenen Straße sammeln.'] },
  },
  luxembourg: {
    name: 'Luxembourg', description: 'Oesling woodland, Sûre crossings, and Gutland farms. Luxembourgish, French, and German local names.',
    sectors: [
      { label: 'Éislek · Bëschwee', setting: 3, language: 'luxembourgish' },
      { label: 'Sûre · Village', setting: 2, language: 'french' },
      { label: 'Guttland · Bauerenhäff', setting: 1, language: 'luxembourgish' },
      { label: 'Mosel · Obstgärten', setting: 1, language: 'german' },
      { label: 'Luxembourg · Carrefour', setting: 5, language: 'french' },
      { label: 'Éislek · Bësch', setting: 3, language: 'luxembourgish' },
    ], riverChance: 0.75, groundTint: 0xa8b394, roof: [0x747977, 0x454b48], trees: ['beech', 'oak', 'pine'],
    chatter: { friendly: ['Luxembourg crossing ahead. Keep that bridge in sight.', 'These wooded lanes are tight. Give the next man some room.'], enemy: ['Brücke in Luxemburg voraus. Den Übergang sichern.', 'Die Waldwege sind eng. Abstand halten.'] },
  },
  netherlands: {
    name: 'The Netherlands', description: 'Polder fields, orchards, brick towns, and broad calm waterways. Dutch signs and building names.',
    sectors: [
      { label: 'Brabant · Poldervelden', setting: 4, language: 'dutch' },
      { label: 'Betuwe · Boomgaarden', setting: 1, language: 'dutch' },
      { label: 'Gelderland · Rivierdorp', setting: 2, language: 'dutch' },
      { label: 'Brabant · Dorpsplein', setting: 5, language: 'dutch' },
      { label: 'Veluwe · Bosweg', setting: 3, language: 'dutch' },
      { label: 'Gelderland · Weilanden', setting: 4, language: 'dutch' },
    ], riverChance: 0.9, groundTint: 0xb0bd98, roof: [0x9a674f, 0x603e31], trees: ['oak', 'birch', 'beech'],
    chatter: { friendly: ['Kerkstraat on the sign. Watch that Dutch church street.', 'Another water crossing. Keep the bridge clear for the squad.'], enemy: ['Holländisches Dorf voraus. Die Brücke freihalten.', 'Die Felder sind offen. Hinter dem Deich bleiben.'] },
  },
};

export function isCampaignCountry(value: unknown): value is CampaignCountry {
  return typeof value === 'string' && CAMPAIGN_COUNTRIES.includes(value as CampaignCountry);
}
export function campaignSectorForSeed(country: CampaignCountry, seed: number): CampaignSector {
  const sectors = CAMPAIGNS[country].sectors;
  return sectors[deriveRng(seed, 0x43414d50).s % sectors.length]!;
}

export const LOCAL_BUILDING_NAMES: Record<LocalLanguage, Record<BuildingKind, readonly string[]>> = {
  french: {
    church: ['Église Saint-Michel', 'Église Notre-Dame'], hospital: ['Hôpital Saint-Jean', 'Hôtel-Dieu'],
    castle: ['Château de la Motte', 'Château du Vieux Pont', 'Forteresse des Prés'],
    house: ['Maison Lambert', 'Maison Dupont', 'Maison Lefèvre'], school: ['École communale', 'École du village'],
    restaurant: ['Auberge du Pont', 'Restaurant de la Gare'], bakery: ['Boulangerie Marchand', 'Le Fournil'],
    clinic: ['Cabinet médical', 'Clinique Saint-Jean'], generalStore: ['Épicerie Dupont', 'Magasin général'],
    bar: ['Café du Marché', 'Le Bistrot'], barn: ['Grange du Moulin', 'Grange des Prés'],
  },
  dutch: {
    church: ['Sint-Martinuskerk', 'Dorpskerk'], hospital: ['Sint-Jozefziekenhuis', 'Gasthuis'],
    castle: ['Kasteel De Motte', 'Kasteel aan de Maas', 'Oud Kasteel'],
    house: ['Huis De Vries', 'Huis Janssen', 'Huis Van Dijk'], school: ['Dorpsschool', 'Sint-Jozefschool'],
    restaurant: ['Herberg De Brug', 'Restaurant Het Station'], bakery: ['Bakkerij Janssen', 'Dorpsbakkerij'],
    clinic: ['Dokterspraktijk', 'Dorpskliniek'], generalStore: ['Kruidenierswinkel', 'De Dorpswinkel'],
    bar: ['Café De Markt', 'Herberg De Molen'], barn: ['Schuur De Molen', 'Boerenschuur'],
  },
  italian: {
    church: ['Chiesa di San Michele', 'Chiesa di Santa Maria'], hospital: ['Ospedale San Giovanni', 'Ospedale del paese'],
    castle: ['Castello della Rocca', 'Castello sul Ponte', 'Rocca Vecchia'],
    house: ['Casa Rossi', 'Casa Bianchi', 'Casa Moretti'], school: ['Scuola comunale', 'Scuola del paese'],
    restaurant: ['Trattoria del Ponte', 'Osteria della Piazza'], bakery: ['Panificio Rossi', 'Forno del paese'],
    clinic: ['Ambulatorio medico', 'Clinica San Marco'], generalStore: ['Alimentari Bianchi', 'Emporio del paese'],
    bar: ['Bar della Piazza', 'Caffè Roma'], barn: ['Fienile Rossi', 'Granaio del Mulino'],
  },
  german: {
    church: ['Sankt-Michaels-Kirche', 'Dorfkirche'], hospital: ['Sankt-Johannes-Krankenhaus', 'Städtisches Krankenhaus'],
    castle: ['Burg am Fluss', 'Schloss Falkenstein', 'Alte Festung'],
    house: ['Haus Müller', 'Haus Schmidt', 'Haus Weber'], school: ['Dorfschule', 'Volksschule'],
    restaurant: ['Gasthaus zur Brücke', 'Gasthof am Markt'], bakery: ['Bäckerei Müller', 'Dorfbäckerei'],
    clinic: ['Arztpraxis', 'Landarztpraxis'], generalStore: ['Kolonialwaren Schmidt', 'Dorfladen'],
    bar: ['Zur alten Mühle', 'Schankstube am Markt'], barn: ['Scheune Weber', 'Scheune am Hof'],
  },
  luxembourgish: {
    church: ['Duerfkierch', 'Michaelskierch'], hospital: ['Spidol', 'Saint-Jean Spidol'],
    castle: ['Buerg op der Héicht', 'Schlass um Floss', 'Al Buerg'],
    house: ['Haus Schmit', 'Haus Weber', 'Haus Muller'], school: ['Duerfschoul', 'Gemengeschoul'],
    restaurant: ['Auberge du Pont', 'Restaurant de la Place'], bakery: ['Bäckerei Schmit', 'Duerfbäckerei'],
    clinic: ['Dokterpraxis', 'Clinique du village'], generalStore: ['Duerfbuttek', 'Épicerie Schmit'],
    bar: ['Café de la Place', 'Café beim Millen'], barn: ['Scheier', 'Scheier beim Haff'],
  },
};
export const LOCAL_STREET_SIGNS: Record<LocalLanguage, readonly string[]> = {
  french: ['Rue de l’Église', 'Place du Marché'], dutch: ['Kerkstraat', 'Dorpsstraat'],
  italian: ['Via Roma', 'Piazza della Chiesa'], german: ['Kirchstraße', 'Marktplatz'],
  luxembourgish: ['Duerfstrooss', 'Kierchewee'],
};
