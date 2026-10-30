# Prerecorded soldier voices

American soldier dialogue plays ordinary bundled WAV files. There is no model,
inference worker, GPU requirement, API key, or third-party speech request in the
game. Audio files load from the same host as the game. Common combat lines decode
after the first audio interaction; longer banter loads when selected and stays
cached. Replies prefetch while the opening line plays. Downloaded clips play offline.
The first interaction also removes this game's obsolete voice-model cache,
preserving unrelated cached data.

The combat phrase pack contains 98 clips: two American soldier voices, two variations
for each of the 13 chatter cues, exact common event reports and support requests,
a preview for each soldier voice, and two Control acknowledgments. The manifest
at `src/assets/ww2/voices/soldiers/manifest.json` lists every transcript and file.
Speaker IDs select a consistent soldier voice; Control has its own voice.

All 24 lull conversations have prerecorded openings and replies in both voices,
adding 96 clips listed in `soldiers/banter-manifest.json`. Exchanges play off the
radio, with a 250 ms pause between turns. A reply uses the other voice when two
soldiers share a default voice assignment. Combat, pause, and mute cancel the
active exchange and prevent its pending reply from playing later.

Exact event lines take priority. Contextual combat captions without an exact
recording use a short matching combat bark. Other unrecorded ambient lines
and weather reports stay caption-only. Captions retain precise directions and
other details; short prerecorded callouts need not repeat every caption word.

Support requests play the operator's recorded request followed by Control's
recorded reply. Completion fires once, after the reply ends. Mute, pause, and
cancellation stop active clips and suppress pending playback. Field lines play
unfiltered; radio lines receive filtering, compression, and static through the
existing voice volume control.

To hear the pack, open Settings > Audio > Preview American voice. It loads and
plays a local file; the resulting status says "Played bundled American voice".

The pack was synthesized once during asset authoring with Kokoro-82M and
Kokoro.js, then trimmed, normalized, and exported as mono 24 kHz 16-bit PCM.
Those authoring dependencies and their model are not included in the project
runtime or package dependencies. See the voice assets' SOURCES.md for provenance.

Run `node scripts/verify-recorded-voices.mjs` after building and starting a
preview server to check local-file playback with all external requests blocked.
Run `node scripts/verify-banter.mjs` against the same server to verify a complete
two-voice conversation, reply timing, and combat interruption in the game.
