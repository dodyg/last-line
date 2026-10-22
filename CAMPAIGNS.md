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

The squad remains the game's U.S. Army force. Country selection changes the
setting, local signage, and contextual remarks. Allied speech remains English
and Axis speech German. Weather remarks are selected from current conditions.

Profiles are in `src/content/campaigns.ts`. Saves without a campaign country use
the original generator to preserve their existing battlefield.

Historical context: the U.S. Army Center of Military History's
[European theater campaign summaries](https://history.army.mil/Research/Reference-Topics/Army-Campaigns/Brief-Summaries/World-War-II/World-War-II-European-African-Middle-Eastern-Theater/)
cover Allied operations in Italy, northern France, the Low Countries, and
Germany. Its [Ardennes history](https://history.army.mil/portals/143/Images/Publications/catalog/7-8.pdf)
describes the campaign in Belgium and Luxembourg. Country profiles use these
settings as inspiration rather than recreating a specific battle or its order
of battle.
