# Musikatu

A desktop workbench for transcribing music by ear: slow it down, loop it, see what's playing, and split it into instruments. Everything runs on your own computer.

![Musikatu](docs/screenshot.png)

## Features

- **Playback:** 5–200% speed without changing the pitch, ±12 semitones and cents of pitch shift, gapless loops, and a zoomable waveform.
- **AI instrument splitter:** vocals, drums, bass, guitar, piano and other, with mute, solo and volume for each, on CPU or GPU.
- **Chords:**
  - live chord guess with guitar diagrams;
  - a whole-song chord chart you can edit;
  - export as text, bar by bar.
- **Beats and bars:** automatic tempo, bars and a metronome; loop bars N–M, snap selections to beats.
- **Audio → MIDI:** transcribe any instrument to a piano roll, play it along, and export MIDI that lines up with the bars.
- **Practice:**
  - a count-in before playback;
  - a speed trainer that speeds the loop up as you repeat it.
- **Tools:**
  - EQ;
  - vocal cut;
  - spectrum on a reference piano;
  - instrument transposition;
  - markers and saved loops;
  - rebindable keys, global hotkeys and MIDI pedals.

## Layout

Every tool is a panel you can put where you like: in the **sidebar**, in the **bottom strip**, as a **floating window**, or hidden. Use **Panels ▾** in the top bar, or the ⋯ menu on each panel. By default the Metronome, EQ and Mix open as floating windows from their buttons in the top bar. Windows can be moved and resized, and the layout is remembered.

## Run

```sh
npm install
npm run dev                 # development
npm run install:linux       # build and install for this user (launcher + `musikatu` command)
npx electron-builder        # installers for this OS → release/
npm test
```

The stem separation model (136 MB) is downloaded from inside the app the first time it's used. The beat and note models are bundled.

## Models

| Task | Model | Licence |
|---|---|---|
| Instrument separation | [HTDemucs 6-stem](https://huggingface.co/adowu/htdemucs-6s-onnx) (Meta AI), ONNX | MIT |
| Beats and downbeats | [Beat This!](https://github.com/CPJKU/beat_this) small (JKU Linz), exported here, see `scripts/beat-model/` | MIT |
| Notes → MIDI | [Basic Pitch](https://github.com/spotify/basic-pitch) (Spotify) | Apache-2.0 |

Inference runs with ONNX Runtime in a background process.

## Branches

- `ai-stems`: Musikatu (this version).
- `main`: the classic version without AI, tag `v1-classic`.
