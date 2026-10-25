# Country campaigns

The New Game chooser starts a procedural campaign in one of six countries.
The country is saved with the run and used to generate every later map. Named
sectors suggest regional landscapes; buildings and junction signs use local
names. Individual buildings and battlefield layouts are fictional.

| Country | Landscape emphasis | Local names and signs |
| --- | --- | --- |
| France | Bocage, orchards, villages, woodland, and fields | French |
| Belgium | Flemish fields, brick villages, and Ardennes woodland | Dutch in Flemish sectors; French in Walloon sectors |
| Italy | Olive groves, stone boundaries, Apennine woodland, and Po Valley farms | Italian |
| Germany | Rhineland towns, Eifel farms, and mixed woodland | German |
| Luxembourg | Oesling woodland, Sûre crossings, and Gutland farms | Luxembourgish, French, and German by sector |
| The Netherlands | Polder parcels, orchards, brick towns, and broad calm waterways | Dutch |

The Netherlands has more frequent water crossings, wider channels, no river
rapids, and decorative drainage ditches. Italy has warmer ground and terracotta
roofs, stone field boundaries, more rocky clutter, olive silhouettes in the
Tuscan orchard sector, and a higher initial chance of clear weather. Every
country uses protected lanes and connected roads; road crossings receive
bridges. Terrain is generated from the country and map seed, so restoration
reproduces the same scenery and building footprints.

New battlefields use landscape version 4. Road-frontage buildings form small
clusters with gated vegetable gardens, farmyards, and churchyards where space
allows. Door paths meet the nearest street segment. Low walls establish firing
positions with open rear access and a slower, concealed flank; local ridges
reinforce those positions without obstructing protected routes. Woodland edges
follow road corridors, Italian parcels gain stone terrace boundaries, and Dutch
parcels have narrow decorative silt drainage margins and lower relief. These
drainage margins are ground dressing, not additional river crossings.

Ground wear, irregular river margins, small bank reeds and stones, and varied
roof shapes and facade tones supplement the existing seasons and regional
materials. Cosmetic bank growth never adds invisible collision or cover.
Vehicle movement leaves bounded twin-track history, saved with the map;
artillery scars include fading scorch halos. Neither history consumes combat
randomness or changes navigation. Both histories reset on arrival at a new map.
Building facade geometry is batched by material to keep the added detail cheap.

Existing version 1–3 saves retain their original terrain and footprints. New runs
and newly entered sectors use version 4. Wide bridge decks on new maps are fitted
to the actual variable-width channel so roads reach both banks. Intersecting
crossings and streets that meet a bridge's side share open low platforms;
ordinary bridges retain their separate deck and underpass routes.

The squad remains the game's U.S. Army force. Country selection changes the
setting, local signage, and contextual remarks. Allied speech remains English
and Axis speech German. Weather remarks are selected from current conditions.

Profiles are in `src/content/campaigns.ts`. Saves without a campaign country use
the original generator to preserve their existing battlefield.

## Campaign narrative

`src/content/campaign-story.ts` supplies four chronological chapters per country.
France follows Normandy, the breakout, the pursuit, and the Moselle fighting;
Belgium follows liberation, supply access, the Ardennes offensive, and recovery.
Italy follows the advance beyond Rome, the Gothic Line, winter, and the spring
offensive. Germany follows the frontier, forest fighting, the renewed Rhineland
advance, and Central Europe. Luxembourg follows liberation, the border watch,
the German offensive, and recovery. The Netherlands follows Market Garden,
the Scheldt, the divided winter, and liberation.

The first deployment pauses for orders. Every map arrival shows a field dispatch:
credited advances share the existing supply-choice screen; unsecured evacuations
pause for fallback orders. Pause reopens current context and orders. The campaign
chooser previews the chronology, and results explain the historical aftermath.
Each briefing includes a linked historical source and an explanation of scope.

Chapters depend on **secured maps**, in quarters of the configured campaign goal
(currently 0, 25, 50, and 75). Evacuations do not advance the chronology. Narrative
state is derived from existing save fields, so saves need no migration and the
terrain, seasons, battle rules, and procedural map seeds remain compatible.
Regional labels are scenery profiles, not a literal geographical itinerary:
maps are fictional composite engagements, seasons are gameplay abstractions,
and the north exit means onward travel rather than a historical compass bearing.
The fictional U.S. detachment is not credited with coalition achievements.

Historical references used for the narrative (accessed 24 October 2026):

- [U.S. Army CMH: Breakout and Pursuit](https://history.army.mil/Publications/Publications-Catalog/Breakout-And-Pursuit/)
- [Army University Press: The Encirclement of Nancy](https://www.armyupress.army.mil/Staff-Rides/Virtual-Staff-Ride/The-Encirclement-of-Nancy/)
- [U.S. Army CMH: The War Against Germany](https://history.army.mil/Portals/143/Images/Publications/Publication%20By%20Title%20Images/W%20PDF/CMH_Pub_12-3.pdf)
- [U.S. Army Medical Department: German Counteroffensive in the Ardennes](https://achh.army.mil/history/book-wwii-bulge-garandchap-files-garandchap/)
- [National Army Museum: The battle for Italy](https://www.nam.ac.uk/explore/italian-campaign)
- [Truman Presidential Library: Statement on the surrender in Italy, 2 May 1945](https://www.trumanlibrary.gov/library/public-papers/20/statement-president-surrender-german-forces-italy)
- [National Army Museum: Operation Market Garden](https://www.nam.ac.uk/explore/market-garden?os=f)
- [Veterans Affairs Canada: Battle of the Scheldt](https://www.veterans.gc.ca/en/remembrance/wars-and-conflicts/second-world-war/battle-of-the-scheldt?wbdisable=false)
- [Veterans Affairs Canada: Liberation of the Netherlands](https://veterans.gc.ca/eng/remembrance/wars-and-conflicts/second-world-war/liberation-of-netherlands)
- [Government of Luxembourg: The Second World War](https://luxembourg.public.lu/en/society-and-culture/history/second-world-war.html)

Historical context: the U.S. Army Center of Military History's
[European theater campaign summaries](https://history.army.mil/Research/Reference-Topics/Army-Campaigns/Brief-Summaries/World-War-II/World-War-II-European-African-Middle-Eastern-Theater/)
cover Allied operations in Italy, northern France, the Low Countries, and
Germany. Its [Ardennes history](https://history.army.mil/portals/143/Images/Publications/catalog/7-8.pdf)
describes the campaign in Belgium and Luxembourg. Country profiles use these
settings as inspiration rather than recreating a specific battle or its order
of battle.
