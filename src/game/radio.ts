import { LULL_BANTER } from '../content/lull-banter';
import { CONFIG } from '../content/config';
import type { CampaignCountry, SimEvent, Team, Unit, UnitRole, WavePhase, WeatherKind } from '../simulation/types';
import { CAMPAIGNS } from '../content/campaigns';

export type RadioCue = 'contact' | 'kill' | 'wounded' | 'medic' | 'wave' | 'clear' | 'ambient' | 'breakthrough' | 'artillery' | 'construction' | 'supplies' | 'airSupport' | 'flare';

type RadioTeamLines = Record<RadioCue, string[]>;
type RoleLines = Partial<Record<UnitRole, Partial<RadioTeamLines>>>;

const WEATHER_CHATTER: Record<WeatherKind, Record<Team, string[]>> = {
  clear: {
    friendly: ['Sunshine at last. I almost forgot what a clear sky looked like.', 'Look at that sun. Makes this field seem almost peaceful.', 'Good light, good weather. Let us enjoy it while it lasts.'],
    enemy: ['Endlich Sonne. Wenigstens sieht man das Gelände wieder.', 'Klarer Himmel heute. Das Feld liegt offen vor uns.', 'Die Sonne kommt heraus. Weiter, bevor sich das Wetter wieder dreht.'],
  },
  lightRain: {
    friendly: ['Just a little rain. Keep the rifle dry and we will manage.', 'Rain is picking up. Watch your footing by the ditch.', 'At least it is not coming down hard yet.'],
    enemy: ['Leichter Regen. Waffen trocken halten und weiter.', 'Der Boden wird weich. Abstand halten.', 'Nur leichter Regen—noch kommen wir gut voran.'],
  },
  rain: {
    friendly: ['This steady rain is soaking through everything.', 'Miserable weather. Keep the action clear and your head down.', 'Rain is running down my collar and into the rifle.'],
    enemy: ['Der Regen hört nicht auf. Ausrüstung trocken halten!', 'Mieses Wetter. Auf dem aufgeweichten Boden vorsichtig vorgehen.', 'Alles ist nass. Gewehr prüfen und weiter.'],
  },
  heavyRain: {
    friendly: ['This is a downpour! I can barely see the next hedge.', 'Worst rain I have ever seen. Keep hold of your footing!', 'We are soaked to the bone. Get under cover when you can.'],
    enemy: ['Was für ein Wolkenbruch! Kaum Sicht bis zur nächsten Hecke.', 'Der Boden wird zum Morast. Nicht den Anschluss verlieren!', 'Ich bin bis auf die Haut durchnässt. Weiter in Deckung!'],
  },
  lightFog: {
    friendly: ['A little fog is settling in. Keep your section close.', 'The mist is creeping over the field. Watch for movement.', 'Not much of a view now. Stay where we can see each other.'],
    enemy: ['Leichter Nebel zieht auf. Bei der Gruppe bleiben.', 'Die Sicht wird schlechter. Augen offen halten.', 'Nicht zurückfallen—im Nebel verliert man schnell die Orientierung.'],
  },
  fog: {
    friendly: ['This fog is swallowing the far side of the field.', 'I can barely make out the next position through this mist.', 'Stay close. The fog has hidden whole squads before.'],
    enemy: ['Der Nebel verschluckt das ganze Feld.', 'Ich sehe kaum bis zur nächsten Stellung.', 'Zusammenbleiben! Im Nebel verliert man leicht die Richtung.'],
  },
  heavyFog: {
    friendly: ['Thick as soup out there. Nobody moves without a word.', 'I cannot see ten yards. Keep your buddy in reach.', 'This fog is smothering every sound and sight.'],
    enemy: ['Dichter Nebel! Ohne Sichtzeichen rückt niemand vor.', 'Ich sehe kaum zehn Meter. Bei der Gruppe bleiben!', 'Der Nebel ist undurchdringlich. Auf Zuruf achten!'],
  },
  lightSnow: {
    friendly: ['Snow is starting to fall. Keep the ammunition covered.', 'A few flurries. Keep your gloves on and your eyes open.'],
    enemy: ['Es beginnt zu schneien. Munition abdecken.', 'Leichter Schneefall. Handschuhe an und Augen offen halten.'],
  },
  snow: {
    friendly: ['This snow is blowing straight into my sights.', 'Snow is coming down hard now. Keep your buddy in view.', 'My fingers are freezing. Keep moving when you can.'],
    enemy: ['Der Schnee weht mir direkt ins Visier.', 'Der Schneefall wird stärker. Bei der Gruppe bleiben.', 'Die Finger sind steif vor Kälte. Zusammenbleiben.'],
  },
  heavySnow: {
    friendly: ['Blizzard! I can barely see the next position.', 'That wind is cutting right through us. Stay close!', 'Snow everywhere. Call out before you move!'],
    enemy: ['Schneesturm! Ich sehe kaum die nächste Stellung.', 'Der Wind geht durch jede Schicht. Zusammenbleiben!', 'Überall Schnee. Vor jeder Bewegung rufen!'],
  },
};

const ALLIED: RadioTeamLines = {
  contact: [
    'Contact front! They are pouring through the hedgerow!', 'Enemy north of the line! Heads down, now!', 'They are hitting our left flank! Hold it!',
    'Movement by the stone wall! I have them in sight!', 'German infantry in the open! Fire, fire!', 'They are closing from the orchard!',
    'Wait for it—now! Open fire!', 'I see the column! Pass it down, they are coming!', 'Keep that lane covered! Do not let them through!',
    'That machine gun is tearing us up! Suppress it!', 'Movement at the crossroads! Watch your flank!', 'More in the treeline! They just keep coming!',
    'Right side! They are crawling up the ditch!', 'I have shapes moving behind the smoke!', 'They are on the wire! Keep them off us!',
    'Second squad, shift right! The left hedge is open!', 'I can hear them in the orchard! Eyes on the gaps!', 'Do not bunch up! They are ranging us!',
    'Incoming fire from the north! Get flat!', 'They are trying the road again! Bar the way!', 'Hold your fire until you see a target! Make it count!',
  ],
  kill: [
    'He is down! Keep firing, there are more!', 'Target down! Scan—quickly, the next one!', 'Good hit! Keep them off us!',
    'He is down! Do not let the rest through!', 'Confirmed! Shift fire, right side!', 'Good shot! Hold that position!',
    'That one dropped! Keep your sights up!', 'He went down by the wall! Next target, left!', 'Good hit! Do not let them regroup!',
    'One less coming through! Watch the smoke!', 'Target stopped! Check the far hedge!',
  ],
  wounded: [
    'I am hit! I am hit! Somebody cover me!', 'Taking fire! Get me out of this lane!', 'I have been hit! I can still fight!',
    'Pinned down! I cannot move! Keep firing!', 'That was too close! I am still here!', 'We are taking hits! Do not let them through!',
    'I am bleeding! I need cover over here!', 'My leg is gone numb—keep them back!', 'I cannot lift my head! They have us fixed!',
    'Taking rounds from the right! Somebody answer them!', 'I am hit bad! Do not leave me in the open!',
  ],
  medic: [
    'Medic moving up! Keep low, son!', 'Easy now. Let me see that wound.', 'You are going home after this. Hold still!',
    'Dressing applied. Back behind cover!', 'Medic here! Keep the lane clear!', 'Breathe easy. You are not done yet.',
  ],
  wave: [
    'Incoming! Get down and take your positions!', 'Here they come again! Hold the line!', 'Check your sectors! They are coming back!',
    'Steady—steady! Wait for a clear shot!', 'Enemy column approaching! Prepare to fire!', 'They are forming up beyond the fields!',
    'Stay in the trench! Let them come to us!', 'All posts, stand by! Contact any second!',
    'Get your heads down! They are forming beyond the road!', 'Rifles loaded? Check your magazines now!', 'They are coming through the mist—hold until they are close!',
    'Stay with your section! Nobody breaks cover alone!', 'The next push will be worse. Brace yourselves!',
  ],
  clear: [
    'That is the last of them. Check your ammunition!', 'Quiet for now. Keep a lookout!', 'Good work. Catch your breath and watch the north!',
    'The field is clear. Nobody lower your guard!', 'We held. Get the wounded behind cover!', 'Reload and reset the line!',
    'Count heads! Get the wounded under the wall!', 'We bought a minute. Make every round ready!', 'Do not stand up yet—there may be stragglers!',
    'Check the wire and pass ammunition forward!',
  ],
  ambient: [
    'This rain makes every hedge look like a German.', 'My hands are frozen. Still, the rifle works.', 'When this is over, I want a warm bed and a proper meal.',
    'Keep your mate in sight. Nobody gets left behind.', 'The farm looked peaceful before all this started.', 'Save your ammunition. We may need every round.',
    'Keep low. A quiet field can turn loud in a second.', 'I can hear the guns over the ridge.',
    'My ears are still ringing from that barrage.', 'I keep thinking I saw movement in that hedge.', 'There is mud in every part of this rifle.',
    'Tell me we are holding. I cannot see through the smoke.', 'Keep talking on the set. Silence makes it worse.', 'My hands will not stop shaking. Pass me a fresh clip.',
    'I promised my brother I would make it back.',
  ],
  breakthrough: [
    'They are through! Fall back and cover the gap!', 'Break in the line! Rally on the next position!',
    'They crossed the wire! Stop that column!', 'We have lost the forward post. Reform the line!',
  ],
  artillery: [
    'Guns have our mark! Incoming rounds—down, down!', 'Artillery is walking in! Get clear of the open ground!',
    'Shells on the field! Keep your heads below the trench!', 'That barrage is ours! Stay under cover until it lifts!',
  ],
  construction: [
    'Sandbags going up here! Give me a few seconds!', 'Digging in—keep them off my back!',
    'Trench line is ready! Get down in it!', 'Need another man on this shovel! We are exposed!',
  ],
  supplies: [
    'Rations are coming through! Get them under cover!', 'Food crate received—pass it down the line!',
    'Good, fresh rations. Make sure every man gets some!', 'Supply drop confirmed. Keep the crate out of the mud!',
  ],
  airSupport: [
    'Air support is on the way! Clear the marked run!', 'Bombs inbound—friendlies off the target!',
    'Radio has the run. Watch for the first bombs!',
  ],
  flare: [
    'Flare is away! Use the light while it lasts!', 'Burning flare overhead—pick out their positions!',
    'Good light over the hedge. Aim for their shapes!',
  ],
};

const AXIS: RadioTeamLines = {
  contact: [
    'Feind voraus! Gegner im Knick! Deckung!', 'Vorne sitzen sie fest — weiter vor!', 'Feuer aus dem Obstgarten! Erwiderungsfeuer!',
    'Ein Maschinengewehr links! Runter!', 'Ziele im offenen Gelände! Schießen!', 'Gegner auf dem Höhenrücken! Achtung, Gewehre!',
    'Sie halten die Kreuzung! Durchstoßen!', 'Bewegung hinter der Hecke! Auseinanderziehen!',
    'Feindscharfschütze! Tief bleiben!', 'Weiter vor! Nicht im Freien stehen bleiben!', 'Feuer aufs Gehöft! Schützen in den Fenstern!',
    'Sie liegen im Graben! Umgehen, bevor wir festliegen!', 'Bewegung links — an der Mauer!', 'Sie haben die Gasse unter Feuer! Stellung suchen!',
    'Abstand halten! Eine Salve erwischt alle!', 'Feuer aus dem Graben! Nebel werfen!',
    'Ich sehe nichts im Staub! Stellungen durchgeben!', 'Sie weichen zur nächsten Hecke zurück — nachsetzen!',
    'Maschinengewehr im Obstgarten! Runter und vorwärts!', 'Nicht stehen bleiben! Das Feld ist ein Schussfeld!',
  ],
  kill: [
    'Ein Verteidiger ausgeschaltet! Weiter vor!', 'Ziel erledigt. Feuer verlegen!', 'Guter Treffer! Druck halten!',
    'Ihre Stellung wankt. Vorwärts!', 'Bestätigt. Nicht stehen bleiben!', 'Ein Gewehr weniger!',
    'Verteidiger getroffen! Weiter!', 'Die Mauer ist frei! Fenster im Auge behalten!', 'Sie sind niedergehalten — jetzt vor!',
    'Einer liegt im Graben! Augen nach vorn!', 'Nächstes Mündungsfeuer anvisieren!',
  ],
  wounded: [
    'Ich bin getroffen! Deckung, verdammt!', 'Unter Feuer! Sanitäter! Ich brauche einen Sanitäter!', 'Verwundet! Ich kann noch gehen!',
    'Die Stellung niederhalten! Ich komme nicht hoch!', 'Getroffen! Lasst mich nicht hier liegen!', 'Sanitäter! Ich halte das nicht allein!',
    'Zieht mich hinter den Stein!', 'Meine Hand ist taub! Weiterfeuern!', 'Ich liege! Nicht alle auf einen Haufen!',
    'Sanitäter nach vorn! Ich kann nicht weiter!',
  ],
  medic: [
    'Stillhalten. Ich bringe dich wieder auf die Beine.', 'Schnell verbinden. Zurück in Deckung!', 'Du schaffst es. Bleib liegen!',
    'Sanitäter hier. Wo bist du getroffen?', 'Druck auf die Wunde. Wir müssen weiter!', 'Du bist versorgt. Zurück auf deinen Posten!',
  ],
  wave: [
    'Antreten! Bei Tagesanbruch erwarten sie uns!', 'Zum Vormarsch bereitmachen! Abstand halten!', 'Der Angriff beginnt! Hinter den Panzern bleiben!',
    'Los! Stellung nehmen, bevor sie uns erwischen!', 'Zusammenbleiben! Den Vordermann nicht verlieren!', 'Die Verteidiger warten! Ihre Linie durchbrechen!',
    'Bei der Gruppe bleiben! Nicht draußen verirren!', 'Auf mein Zeichen über das Feld! Los!',
    'Auf den Nebel warten, dann paarweise vor!', 'Zusammen hinüber — niemand bleibt zurück!', 'Sie beobachten die Straße. Durch die Senke!',
    'Nerven behalten! Vor Einbruch der Dunkelheit nehmen wir den Knick!', 'Erste Gruppe vor! Zweite Gruppe, Feuerschutz!',
  ],
  clear: [
    'Die Stellung ist unsere. Knick absuchen!', 'Hier halten und Munition zählen!', 'Sie sind zurückgewichen. Gegenstoß erwarten!',
    'An der Mauer sammeln. Nicht auseinanderziehen!', 'Die Straße ist frei. Nächsten Vorstoß vorbereiten!', 'Männer prüfen und nachladen!',
    'Die Verteidiger sind still. Graben vorsichtig absuchen!', 'An der Steinmauer sammeln!', 'Nicht nachlassen — der Gegenstoß kann sofort kommen!',
    'Durchzählen! Fehlende melden!',
  ],
  ambient: [
    'Die westlichen Straßen sind ein Heckenlabyrinth.', 'Ausrüstung trocken halten, wenn möglich.', 'Die Panzer sehen durch die Obstgärten nichts.',
    'Bei der Gruppe bleiben. Das Feld ist offen.', 'Ein schneller Marsch nach Westen wurde versprochen.', 'Vor dem Weitermarsch auf das Zeichen warten.',
    'Das Dorf liegt gleich hinter dem Höhenrücken.', 'Kopf unten halten. Ihre Scharfschützen warten nur.',
    'Das Funkgerät fällt bei dem Wetter ständig aus.', 'Seit der Flussüberquerung habe ich nicht geschlafen.', 'Hinter jeder Hecke steckt ein Gewehr.',
    'Ruhig atmen. Den Rauch rieche ich, bevor ich das Dorf sehe.', 'Man sagte, die Linie sei schwach. Sie haben gelogen.',
    'Nicht umdrehen. Den Mann vor dir im Auge behalten.',
  ],
  breakthrough: [
    'Durchbruch! Straße offen halten!', 'Ihre Linie ist durchbrochen. Vor, bevor sie sich sammeln!',
    'Die Verteidiger weichen! Nachsetzen!', 'Durchbruch gelungen. Panzer nach vorn!',
  ],
  artillery: [
    'Granaten im Anflug! Auseinander und in Deckung!', 'Artillerie auf unserer Stellung! Straße sofort räumen!',
    'Einschläge! Weiterbewegen — nicht im Graben drängen!', 'In Deckung! Ihre Geschütze haben uns erfasst!',
  ],
  construction: [
    'Sie graben sich ein! Stellung weiter unter Druck setzen!', 'Draht und Sandsäcke voraus — anderen Weg suchen!',
    'Ein neuer Graben! Nicht über freies Feld angreifen!', 'Pioniere an der Linie! Schaufeltrupp unter Feuer nehmen!',
  ],
  supplies: [
    'Verpflegung wird abgeworfen! Kiste sichern!', 'Rationen gesichtet — hin, bevor der Feind sie findet!',
    'Verpflegung im Anflug! Kiste von der Straße holen!', 'Nachschub für die Verteidiger. Himmel beobachten!',
  ],
  airSupport: [
    'Feindflieger im Anflug! Auseinander und in Deckung!', 'Flugzeuge voraus—runter von der Straße!',
    'Luftangriff! Nicht in der offenen Senke bleiben!',
  ],
  flare: [
    'Leuchtkugel über uns! Deckung suchen!', 'Die Verteidiger sehen uns jetzt—auseinander!',
    'Flare am Himmel! Weiterbewegen, nicht stehen bleiben!',
  ],
};

const ROLE_LINES: Record<Team, RoleLines> = {
  friendly: {
    rifleman: { contact: ['Rifleman here, I have the left lane!', 'I see them crossing by the fence!', 'My sights are on the road—keep them coming!'], construction: ['Fitting a new sight now—cover me for a moment!', 'Give me a few seconds to set this barrel right!', 'Cleaning up the action—do not let them close!'], ambient: ['Clean your sights and check the bolt.', 'I will cover the gap by the fence.', 'I can barely hear over that gun.'] },
    mg: { contact: ['Machine gun covering the approach!', 'I have the lane! Get down behind me!', 'Give me a target and I will cut them off!'], wave: ['Give me a clear lane and I will pin them down!', 'I am set! Keep our men out of my line!'], ambient: ['Barrel is getting hot. Short bursts!', 'Feed belt is running low—bring me another!'] },
    medic: { wounded: ['Stay with me! I am coming to you!', 'Keep pressure on it! Look at me, soldier!', 'I have you. Breathe, damn it!'], ambient: ['Keep the wounded close to cover.', 'I am out of dressings. Make these count.'] },
    at: { contact: ['Anti-tank team ready. Waiting for armor!', 'Armor spotted! I need a clean angle!', 'Hold that road—I have a rocket ready!'], breakthrough: ['Armor through the line! I need a clear shot!', 'Tank on the road! Get me a flank shot!'], ambient: ['Save the rocket for a clean side shot.', 'That launcher is heavier every mile.'] },
    sniper: { contact: ['Sniper has eyes on the forward squad.', 'Marksman watching the orchard. Stay low.', 'I have their officer in sight—waiting for a clear shot.'], kill: ['Target confirmed. Relocating now.', 'One down. Changing position before they answer.'], ambient: ['One shot, then change position.', 'Wind is shifting. Give me a second.'] },
    engineer: { contact: ['Engineers up! I will dig in while you cover me!', 'I need cover to finish this trench!', 'Sandbags going down—keep those heads low!'], wave: ['Get behind the works! I am building under fire!', 'The trench is not finished! Hold them for me!'], construction: ['Work complete! Take cover in the trench!', 'Sandbags are set! Get behind them!', 'I need another shovel and ten seconds!'], ambient: ['Give me a minute and I can turn this ground into cover.', 'This soil is full of stones. Keep watch while I dig.'] },
    radio_engineer: { contact: ['Radio set is live. Give me a clear target!', 'I hear the battery. Call your coordinates!', 'Signal is breaking up—repeat your last!'], wave: ['Coordinates confirmed! Guns are standing by!', 'Battery is loaded. Waiting on your mark!'], artillery: ['Fire mission sent! Get down when those rounds land!', 'Battery is answering! Stay off the target, friendlies!', 'Rounds are away! Keep the line covered!'], supplies: ['Request sent for rations. Keep the set clear!', 'Quartermaster confirms a food drop. Marking our position!', 'Ration crate requested—keep your eyes on the sky!'], airSupport: ['Air control has the coordinates. Clear the bomb line!', 'Pilot confirms the run—mark held steady!', 'Radio check complete. The aircraft are inbound!'], flare: ['Flare away! You have light over the target!', 'Mark is burning. Use the light before it fades!', 'Signal is up—watch the enemy positions!'], ambient: ['I have the battery on the line. Mark the target and I will call it in.', 'Keep this aerial clear of the wire!', 'Hold the handset steady; I can barely hear the battery.'] },
    mortarman: { contact: ['Mortar crew needs a clear patch of ground!', 'Keep them off my position until I get the tube set!', 'I need a stationary base before I can range them!'], kill: ['Good burst! Check the next group for the observer!', 'That landed right among them. Shifting the tube!', 'One less in the open—give me another bearing!'], wounded: ['I am hit! Keep the tube covered!', 'Need a hand here—the ammunition is exposed!', 'I can still fire. Keep them away from the rounds!'], artillery: ['Mortar round away! Keep your heads down!', 'Firing for effect—watch that target!', 'Bomb on the way! Shifting to a new position!', 'Range set! Another round is going out!', 'Short on the first one—walking it onto the hedge!', 'Tube is hot. Give me a moment to reload!'], ambient: ['Check the tube and keep the ammunition dry.', 'Waiting for a target in range.', 'Keep the bombs covered; damp fuzes are no good.', 'One round at a time. I need a quiet position to range them.'] },
    gun_truck: { contact: ['Mounted gun is up! I have the road!', 'Machine gun crew, open up on that squad!', 'Truck gun is covering our line!', 'Driver, swing the nose toward that hedge!', 'Keep rolling—this gun can fire on the move!', 'They are in range. Short bursts from the truck!'], kill: ['One down beside the road! Keep the gun traversing!', 'Good burst. Driver, take us to the next gap!', 'Target stopped—watch the field beyond him!'], wounded: ['I am hit in the cab! Keep the truck moving!', 'Gunner is hit! Someone cover this side!', 'Taking rounds through the bed—do not stop here!'], wave: ['Keep the truck moving between bursts!', 'I have a clear run on the flank!', 'Road is open. We can shift before they range us!'], ambient: ['Top up the belt before we move out.', 'Keep an eye on the radiator.', 'That open cab will not stop a rifle round. Keep moving!', 'Kill the engine and listen—there is movement past the hedge.'] },
  },
  enemy: {
    rifle: { contact: ['Schützenzug in Stellung. Sprungweise vor!', 'Zweite Gruppe, linke Flanke sichern!', 'Verteidiger an der Steinmauer!'], wave: ['Abstand halten. Straße nicht verstopfen!', 'Vorrücken, wenn das MG feuert!'], ambient: ['Hecke prüfen, bevor ihr sie überquert.', 'Munition trocken halten.'] },
    assault: { contact: ['Sturmgruppe rückt nah heran!', 'Nebel raus! Wir stürmen den Graben!', 'Feuer aus der Hecke — näher ran!'], wave: ['Handgranaten bereit. Wir nehmen den Graben!', 'Auf mein Zeichen warten, dann vor!'], ambient: ['Tief bleiben bis zur Mauer.', 'Granaten griffbereit halten.'] },
    vehicle: { contact: ['Panzer rückt vor! Infanterie, nachkommen!', 'Fahrer, runter von der Straße! Panzerabwehr voraus!', 'Feindgeschütz links — Turm schwenken!', 'Kette halten! Ich richte den Bug auf die Mauer!', 'Die Verteidiger haben Bazookas—Rauch und weiter!'], kill: ['Ziel ausgeschaltet! Infanterie soll nachrücken!', 'Guter Treffer. Kanone laden, nächstes Ziel!', 'Widerstand gebrochen—weiter auf die Straße!'], wounded: ['Treffer an der Wanne! Fahrer, zurück in Deckung!', 'Rauch! Wir sind getroffen und stehen zu lange!', 'Kette beschädigt! Nicht hier liegen bleiben!'], breakthrough: ['Panzer durch! Straße freimachen!', 'Weiterrollen! Keine Neuformierung zulassen!', 'Die Kette ist durch—Infanterie, in die Lücke!'], ambient: ['Die Ketten rutschen im Schlamm.', 'Durch den Rauch ist kaum etwas zu sehen.', 'Licht aus? In dieser Nacht ist die Straße kaum zu erkennen.', 'Die Besatzung braucht eine Pause, aber die Kolonne wartet nicht.'] },
    gun_truck: { contact: ['MG-Gruppe, im Lastwagen vor!', 'Lkw-MG eröffnet das Feuer!', 'Die Infanterie rückt hinter dem Lkw-MG nach!', 'Fahrer, an die Hecke ran—wir decken die Straße!', 'Nicht anhalten! Das MG kann auch während der Fahrt feuern!'], kill: ['Verteidiger am Straßenrand ausgeschaltet!', 'Guter Feuerstoß. Weiterfahren, bevor sie antworten!', 'Einer weniger—Gurt prüfen und nach vorn!'], wounded: ['Treffer im Fahrerhaus! Raus aus dem Schussfeld!', 'Der Schütze ist verwundet—halt den Wagen in Bewegung!', 'Durch die Ladefläche! Wir brauchen Deckung!'], breakthrough: ['Lkw-MG durch! Straße für die Gruppe freihalten!', 'Weiterfahren! Die Verteidiger sammeln sich schon!', 'Die Lücke ist offen—Gruppe nach vorn!'], wave: ['Maschinengewehr auf die Straße richten!', 'Der Lkw muss in Bewegung bleiben!', 'Schnell über die offene Stelle, dann hinter die Mauer!'], ambient: ['Gurt nachladen und den Motor laufen lassen.', 'Auf der Straße bleiben, der Graben ist zu weich.', 'Die Scheinwerfer machen uns sichtbar—aber ohne Licht fahren wir langsamer.', 'Motor läuft heiß. Nicht länger als nötig im Schussfeld bleiben.'] },
  },
};

export interface ChatterResult {
  team: Team;
  text: string;
  /** Spoken after the requester's line, as the acknowledgment from radio control. */
  confirmation?: string;
  delivery: 'shout' | 'tense' | 'panic';
  cue: RadioCue;
  speakerId: number;
  channel: 'field' | 'radio';
  reply?: { text: string; speakerId: number };
}

/** Chooses restrained, non-repeating radio barks from actual combat events. */
export class RadioDirector {
  private lastSpokenAt = -Infinity;
  private recentLines: string[] = [];
  private nextAmbientAt = 0;
  private quietSinceTick: number | null = null;
  private lastWasBanter = false;
  private interruptedBanter = false;
  private lastPriority = -1;

  reset(): void { this.lastSpokenAt = -Infinity; this.lastPriority = -1; this.recentLines = []; this.nextAmbientAt = 0; this.quietSinceTick = null; this.lastWasBanter = false; this.interruptedBanter = false; }

  takeBanterInterruption(): boolean {
    const interrupted = this.interruptedBanter; this.interruptedBanter = false; return interrupted;
  }

  consider(events: readonly SimEvent[], units: readonly Unit[], tick: number, weather?: WeatherKind, country?: CampaignCountry, wavePhase?: WavePhase): ChatterResult | null {
    const combat = events.some((event) => ['shot', 'explosion', 'artilleryImpact', 'enemyBarrageIncoming', 'grenadeThrown', 'scoutContact', 'breakthrough', 'unitDied', 'buildingDestroyed'].includes(event.type)
      || (event.type === 'wavePhase' && event.phase === 'spawning'));
    const quiet = !combat && (wavePhase === undefined || wavePhase === 'prep' || wavePhase === 'advance')
      && !units.some((unit) => unit.health > 0 && !unit.dead && !unit.crossed && (unit.team === 'enemy' || unit.pinned || unit.targetId !== null || unit.suppression > CONFIG.suppression.recoverThreshold));
    if (quiet) this.quietSinceTick ??= tick;
    else {
      this.quietSinceTick = null;
      if (this.lastWasBanter) { this.interruptedBanter = true; this.lastWasBanter = false; this.lastSpokenAt = -Infinity; }
    }
    const candidates: Array<{ team: Team; role?: UnitRole; cue: RadioCue; priority: number; speakerId?: number; pos?: { x: number; y: number }; confirmation?: string; ambientLines?: readonly string[]; text?: string; reply?: ChatterResult['reply']; banter?: boolean }> = [];
    for (const event of events) {
      if (event.type === 'roleAbilityStarted') {
        const messages = { rally: 'Stay together! Hold this position!', observe: 'Observation post ready. Watching the approaches.', supply: 'Forward ammunition point ready. Bring the men here.', repair: 'Repair detail standing by. Cover us while we work.', suppress: 'Covering the marked ground! Keep their heads down!' };
        candidates.push({ team: 'friendly', cue: 'contact', priority: 2, speakerId: event.unitId, text: messages[event.kind] });
      } else if (event.type === 'scoutContact') {
        const label = event.role === 'vehicle' ? 'Tank' : event.role === 'mg_team' ? 'Machine-gun team' : event.role === 'sapper' ? 'Sappers' : event.role === 'troop_transport' ? 'Troop transport' : 'Enemy infantry';
        candidates.push({ team: 'friendly', cue: 'contact', priority: event.role === 'vehicle' ? 4 : 2, speakerId: event.unitId, pos: event.pos, text: `${label} observed. ${directionCallout(event.pos, 'friendly')}` });
      } else if (event.type === 'grenadesResupplied' || event.type === 'rocketsResupplied' || event.type === 'mortarBombsResupplied') {
        candidates.push({ team: 'friendly', cue: 'supplies', priority: 1, speakerId: event.officerId, text: `${event.type === 'rocketsResupplied' ? 'Rockets' : event.type === 'mortarBombsResupplied' ? 'Mortar bombs' : 'Grenades'} delivered.` });
      } else if (event.type === 'wavePhase'  && event.phase === 'spawning') {
        candidates.push({ team: 'enemy', cue: 'wave', priority: 2, text: 'Zum Angriff bereit! Abstand halten!' });
      } else if (event.type === 'waveCleared') {
        candidates.push({ team: 'friendly', cue: 'clear', priority: 2, text: 'That attack is over. Reload and check the wounded.' });
      } else if (event.type === 'breakthrough') {
        candidates.push({ team: 'friendly', cue: 'breakthrough', priority: 5, pos: event.pos, text: `Enemy through the line! Cover the gap! ${directionCallout(event.pos, 'friendly')}` });
        candidates.push({ team: 'enemy', role: event.role, cue: 'breakthrough', priority: 4, speakerId: event.unitId, pos: event.pos, text: `Durchbruch! ${directionCallout(event.pos, 'enemy')}` });
      } else if (event.type === 'unitDied') {
        const speakerTeam: Team = event.team === 'friendly' ? 'enemy' : 'friendly';
        const speakers = units.filter((unit) => unit.team === speakerTeam && unit.health > 0);
        const speaker = speakers.length > 0 ? speakers[Math.floor(Math.random() * speakers.length)] : undefined;
        candidates.push({ team: speakerTeam, role: speaker?.role, cue: 'kill', priority: 1, speakerId: speaker?.id, pos: event.pos, text: speakerTeam === 'friendly' ? 'Target down. Keep watch.' : 'Ziel ausgeschaltet. Weiter beobachten.' });
      } else if (event.type === 'healed') {
        candidates.push({ team: 'friendly', role: 'medic', cue: 'medic', priority: 2, speakerId: event.medicId, pos: event.pos, text: 'Dressing applied. Keep behind cover.' });
      } else if (event.type === 'airSupportOrdered') {
        if (units.some((unit) => unit.team === 'enemy' && unit.health > 0)) {
          candidates.push({ team: 'enemy', cue: 'airSupport', priority: 2, pos: event.pos });
        }
      } else if (event.type === 'flareDeployed') {
        candidates.push({ team: 'friendly', role: 'radio_engineer', cue: 'flare', priority: 2, pos: event.pos });
        if (units.some((unit) => unit.team === 'enemy' && unit.health > 0)) {
          candidates.push({ team: 'enemy', cue: 'flare', priority: 2, pos: event.pos });
        }
      } else if (event.type === 'mortarFired') {
        candidates.push({ team: 'friendly', role: 'mortarman', cue: 'artillery', priority: 1, speakerId: event.unitId, pos: event.pos, text: 'Mortar round away!' });
      } else if (event.type === 'enemyBarrageIncoming') {
        // Enemy guns ranging the line: the Axis call it to their own troops, and
        // the Allied line shouts the warning back.
        candidates.push({ team: 'enemy', cue: 'artillery', priority: 4, pos: event.pos, text: `Feuerschlag angefordert! ${directionCallout(event.pos, 'enemy')}` });
        candidates.push({ team: 'friendly', cue: 'artillery', priority: 5, pos: event.pos, text: `Incoming artillery! Take cover! ${directionCallout(event.pos, 'friendly')}` });
      } else if (event.type === 'artilleryImpact') {
        candidates.push({ team: 'enemy', cue: 'artillery', priority: 3, pos: event.pos, text: `Granateneinschlag! Deckung! ${directionCallout(event.pos, 'enemy')}` });
      } else if (event.type === 'constructionCompleted') {
        candidates.push({ team: 'friendly', role: 'engineer', cue: 'construction', priority: 2, pos: event.pos, text: `${event.kind === 'barbedWire' ? 'Barbed wire' : event.kind === 'sandbag' ? 'Sandbags' : event.kind === 'mine' ? 'Mine' : event.kind === 'mortarPit' ? 'Mortar pit' : event.kind === 'bridge' ? 'Bridge' : event.kind === 'bunker' ? 'Bunker' : 'Trench'} ready.` });
      } else if (event.type === 'weaponUpgraded') {
        // The soldier is head-down on his own weapon, so he is the one who says so.
        candidates.push({ team: 'friendly', cue: 'construction', priority: 1, speakerId: event.unitId, text: 'Working on my weapon. Cover me.' });
      } else if (event.type === 'weatherChanged') {
        for (const team of ['friendly', 'enemy'] as const) {
          if (units.some((unit) => unit.team === team && unit.health > 0)) {
            candidates.push({ team, cue: 'ambient', priority: 1, ambientLines: WEATHER_CHATTER[event.weather][team] });
          }
        }
      } else if (event.type === 'foodSupplies') {
        // The explicit request/acknowledgment exchange is handled by the controller.
      } else if (event.type === 'shot' && event.hit && event.targetId !== null && Math.random() < 0.09) {
        const target = units.find((unit) => unit.id === event.targetId && unit.health > 0);
        if (target !== undefined) candidates.push({ team: target.team, role: target.role, cue: 'wounded', priority: 3, speakerId: target.id, pos: event.to, text: target.team === 'friendly' ? 'I’m hit! Need cover!' : 'Getroffen! Ich brauche Deckung!' });
      } else if (event.type === 'shot' && Math.random() < 0.012) {
        const shooter = units.find((unit) => unit.id === event.shooterId);
        if (shooter) candidates.push({ team: event.shooterTeam, role: shooter.role, cue: 'contact', priority: 1, speakerId: shooter.id, pos: event.to, text: event.shooterTeam === 'friendly' ? `Contact! ${directionCallout(event.to, 'friendly')}` : `Feindkontakt! ${directionCallout(event.to, 'enemy')}` });
      }
    }

    if (candidates.length === 0 && quiet && this.quietSinceTick !== null && tick - this.quietSinceTick >= 6 * CONFIG.tickRate && tick >= this.nextAmbientAt) {
      this.nextAmbientAt = tick + (20 + Math.floor(Math.random() * 16)) * CONFIG.tickRate;
      const alive = units.filter((unit) => unit.team === 'friendly' && unit.health > 0 && !unit.dead && !unit.crossed && !unit.pinned && unit.targetId === null && unit.health > 25 && !unit.running && unit.medicalTargetId === undefined && !(unit.role === 'medic' && unit.healTimer > 0));
      if (alive.length > 0) {
        const speaker = alive[Math.floor(Math.random() * alive.length)];
        if (speaker !== undefined) {
          const partners = alive.filter((unit) => unit.id !== speaker.id && Math.hypot(unit.pos.x - speaker.pos.x, unit.pos.y - speaker.pos.y) <= 160
            && (!unit.buildingPosition && !speaker.buildingPosition || unit.buildingPosition && speaker.buildingPosition && unit.buildingPosition.buildingId === speaker.buildingPosition.buildingId && unit.buildingPosition.level === speaker.buildingPosition.level));
          const partner = partners[Math.floor(Math.random() * partners.length)];
          const jokes = LULL_BANTER.filter((joke) => !this.recentLines.includes(joke.line));
          const joke = jokes[Math.floor(Math.random() * jokes.length)];
          if (partner && joke) candidates.push({ team: 'friendly', cue: 'ambient', priority: 0, speakerId: speaker.id, text: joke.line, reply: { text: joke.reply, speakerId: partner.id }, banter: true });
          else {
            const roll = Math.random();
            const ambientLines = roll < 0.5 && weather !== undefined ? WEATHER_CHATTER[weather][speaker.team]
              : roll < 0.8 && country !== undefined ? CAMPAIGNS[country].chatter[speaker.team] : undefined;
            candidates.push({
              team: speaker.team, role: speaker.role, cue: 'ambient', priority: 0, speakerId: speaker.id,
              text: roll > .85 && speaker.kills >= 5 ? 'We’ve held through worse. Watch your sector.' : roll > .85 && speaker.service.healthRestored > 0 ? 'Keep the wounded close to cover. I’ll check on them.' : undefined,
              ...(ambientLines === undefined ? {} : { ambientLines }),
            });
          }
        }
      }
    }
    if (candidates.length === 0) return null;
    const requests = candidates.filter((candidate) => candidate.confirmation !== undefined);
    const priority = Math.max(...candidates.map((candidate) => candidate.priority));
    if (requests.length === 0 && tick - this.lastSpokenAt < (priority >= 4 && priority > this.lastPriority ? 1 : 7.5) * CONFIG.tickRate) return null;
    const selectable = requests.length > 0 ? requests : candidates;
    selectable.sort((a, b) => b.priority - a.priority);
    const highest = selectable.filter((candidate) => candidate.priority === selectable[0]?.priority);
    const chosen = highest[Math.floor(Math.random() * highest.length)];
    if (chosen === undefined) return null;
    const common = chosen.team === 'friendly' ? ALLIED : AXIS;
    const speakers = units.filter((unit) => unit.team === chosen.team && unit.health > 0 && !unit.dead && !unit.crossed);
    const roleSpeakers = chosen.role === undefined ? [] : speakers.filter((unit) => unit.role === chosen.role);
    const speaker = (chosen.speakerId === undefined ? undefined : units.find((unit) => unit.id === chosen.speakerId && unit.health > 0))
      ?? (roleSpeakers.length > 0 ? roleSpeakers[Math.floor(Math.random() * roleSpeakers.length)] : undefined)
      ?? speakers[Math.floor(Math.random() * speakers.length)];
    if (!speaker) return null;
    const speakerId = speaker?.id ?? (chosen.team === 'friendly' ? -1 : -2);
    const roleSpecific = speaker === undefined ? [] : ROLE_LINES[chosen.team][speaker.role]?.[chosen.cue] ?? [];
    const lines = chosen.ambientLines ?? (chosen.cue === 'ambient' ? ['Keep your eyes open.', 'Check your gear while it’s quiet.', 'Stay close. Watch your sector.'] : [...roleSpecific, ...common[chosen.cue]]);
    const options = lines.filter((line) => !this.recentLines.includes(line));
    const line = options[Math.floor(Math.random() * options.length)] ?? lines[0] ?? 'Stay alert. Keep your position.';
    let text = chosen.text ?? line;
    if (!chosen.text && chosen.pos !== undefined && ['contact', 'artillery', 'breakthrough', 'airSupport', 'flare'].includes(chosen.cue) && Math.random() < 0.72) {
      text = `${text} ${directionCallout(chosen.pos, chosen.team)}`;
    }
    this.recentLines.push(chosen.text ?? line);
    if (this.recentLines.length > 8) this.recentLines.shift();
    this.lastSpokenAt = tick; this.lastPriority = chosen.priority; this.lastWasBanter = chosen.banter === true;
    const panic = chosen.cue === 'wounded' || speaker?.pinned || (speaker?.morale ?? 100) < CONFIG.morale.rattledThreshold;
    const delivery = panic ? 'panic' : chosen.cue === 'ambient' || (speaker?.morale ?? 100) < CONFIG.morale.shakenThreshold ? 'tense' : Math.random() < 0.42 ? 'tense' : 'shout';
    const partner = chosen.team === 'friendly' && (chosen.text === 'Stay together! Hold this position!' || chosen.text === 'Covering the marked ground! Keep their heads down!' || chosen.cue === 'medic')
      ? units.find((unit) => unit.id !== speakerId && unit.team === 'friendly' && unit.health > 0 && !unit.dead && !unit.crossed && !unit.pinned && Math.hypot(unit.pos.x - speaker.pos.x, unit.pos.y - speaker.pos.y) <= 160) : undefined;
    const reply = chosen.reply ?? (partner ? { text: chosen.cue === 'medic' ? 'Thanks, doc.' : 'Understood! Keeping low!', speakerId: partner.id } : undefined);
    return { team: chosen.team, text, reply, confirmation: chosen.confirmation, delivery, cue: chosen.cue, speakerId, channel: ['wave', 'airSupport', 'flare'].includes(chosen.cue) ? 'radio' : 'field' };
  }
}

function directionCallout(pos: { x: number; y: number }, team: Team): string {
  const centerX = CONFIG.field.width / 2;
  const centerY = CONFIG.field.height / 2;
  const horizontal = pos.x < centerX - CONFIG.field.width * 0.14 ? 'west' : pos.x > centerX + CONFIG.field.width * 0.14 ? 'east' : '';
  const vertical = pos.y < centerY - CONFIG.field.height * 0.14 ? 'north' : pos.y > centerY + CONFIG.field.height * 0.14 ? 'south' : '';
  const direction = [vertical, horizontal].filter(Boolean).join('-');
  if (team === 'enemy') {
    const germanDirections: Record<string, string> = {
      north: 'Norden', south: 'Süden', west: 'Westen', east: 'Osten',
      'north-west': 'Nordwesten', 'north-east': 'Nordosten', 'south-west': 'Südwesten', 'south-east': 'Südosten',
    };
    return direction === '' ? 'Mitte! Augen auf!' : `${germanDirections[direction]}! Augen auf!`;
  }
  return direction === '' ? 'By the center—eyes up!' : `On the ${direction} side—eyes up!`;
}
