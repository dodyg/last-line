# Radio voice recordings

## Prerecorded American soldier phrase pack

- **Files:** `soldiers/*.wav`; combat transcripts are in `soldiers/manifest.json`, and the 96 banter recordings are in `soldiers/banter-manifest.json`.
- **Source:** Synthesized offline during asset authoring with Kokoro.js 1.2.1 and `onnx-community/Kokoro-82M-v1.0-ONNX` (Kokoro-82M v1.0).
- **Voices:** Michael and Puck for soldiers; Fenrir for Control.
- **Changes:** Trimmed leading/trailing silence, normalized peak level, exported as mono 24 kHz 16-bit PCM WAV. Radio processing is applied during playback.
- **Authoring tools/model:** https://github.com/hexgrad/kokoro (Apache-2.0); https://huggingface.co/hexgrad/Kokoro-82M (Apache-2.0); https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX.
- The game ships the audio files only. No synthesis model or inference library is loaded by the game.

## Medic request shout

- **File:** `medic-call.wav`
- **Text:** "Medic!"
- **Source:** Synthesized offline with the same Michael voice used by the new soldier phrase pack.
- **Changes:** Exported as mono 24 kHz WAV. Bundled playback requires no system speech voice or model.

## Grenade supplies request shout

- **File:** `grenade-supplies-call.wav`
- **Text:** "Grenade supplies!"
- **Source:** Synthesized offline with the same Michael voice used by the new soldier phrase pack.
- **Changes:** Exported as mono 24 kHz WAV. Bundled playback requires no system speech voice or model.

## Allied soldier voice pack

- **Title:** Soldier Voice Acting
- **Author:** kurt
- **Source:** https://opengameart.org/content/soldier-voice-acting
- **License:** Creative Commons Attribution 3.0 (CC BY 3.0)
- **License text:** https://creativecommons.org/licenses/by/3.0/
- **Files included:** `soldierintro.ogg`, `unitselection.ogg`, `aknowledgement.ogg`, `battlecries.ogg`, `wounded.ogg`
- **Changes:** The game segments the recordings at pauses and applies a radio band-pass filter during playback.
- Selection acknowledgments use the individual takes in `unitselection.ogg` with six stable pitch/cadence profiles assigned by soldier id, and rotate takes on repeated selections. They play through the voice volume bus with battlefield panning.

## German radio voices

- **Title:** German Voices
- **Voice actor:** Manuel Senfft; commissioned and shared by Andrettin
- **Source:** https://opengameart.org/content/german-voices-0
- **License:** CC0 1.0
- **Files included:** `wyrmsun_german-voice_001.wav` through `wyrmsun_german-voice_022.wav`
- **Changes:** The game segments the recordings at pauses and applies a radio band-pass filter during playback.
