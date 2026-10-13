# Earwork AI

This is Earwork plus **on-device AI instrument separation**. The classic version without AI lives on the `main` branch (tag `v1-classic`). Both use different app IDs, so they install side by side.

A precision playback workbench for transcribing music by ear: load a recording, zoom into the waveform, loop a phrase, and slow it down or retune it. You can also filter or cancel parts of the mix, see which notes are sounding, and check pitches against a reference piano.

## Running

```sh
npm install
npm run dev              # Vite dev server + Electron, with hot reload
npm run dev -- song.mp3  # ...opening a file straight away
npm start                # production build, then Electron
npm test                 # DSP + analysis unit tests (Node's built-in runner)
npm run typecheck
npm run dist             # installers for the current OS → release/ (AppImage+deb, dmg+zip, nsis)
npm run dist:dir         # unpacked app only, quick to check
```

## Features

**Playback**
- Speed from 5% to 200% without changing pitch.
- Pitch shift of ±12 semitones plus ±50 cents, independent of speed.
- Sample-accurate seeking and gapless loops.

**Waveform**
- Whole-file overview plus a detail view that zooms down to individual samples.
- The view can follow the playhead.

**Markers**
- Sections are named (Intro, Verse…).
- Measures are numbered automatically; beats are unlabelled ticks.
- Markers can be dropped while playing, so you can tap them in time.
- Drag a flag to move it; double-click between markers to select that span.
- Tap tempo reports the original BPM, corrected for the current speed.

**Saved loops**
- Named loops are recalled with `1`–`9`.

**Mix tools**
- 10-band graphic EQ with high-pass and low-pass filters, presets (Bass line, Melody/vocal…) and a response curve.
- Channel modes: mono, left only, right only, vocal cut (L−R) and vocal cut that keeps the bass.

**Spectrum and note estimator**
- The live spectrum is drawn directly over an 88-key piano.
- Shows detected notes, a chord guess (including slash chords), and the strongest peak with its deviation in cents.
- Analyses the decoded audio at the playhead, so it works while paused and at any speed. EQ, channel mode and pitch shift are taken into account.

**AI instrument splitter (Stems tab)**
- Splits a song into **vocals, drums, bass, guitar, piano/keys and other** using HTDemucs v4 (6 sources).
- Runs entirely on your computer; nothing is uploaded. The model (136 MB, fp16 weights) is downloaded once from a pinned Hugging Face revision and verified by SHA-256. *Import file…* works offline.
- **Run on Auto / GPU / CPU.** Auto times one chunk on each, once per machine, and keeps the faster.
  - GPU backends: DirectML on Windows (any vendor); WebGPU on macOS (Metal) and Linux (Vulkan, AMD/Intel/NVIDIA); CUDA on Linux when its libraries are present.
  - If a GPU can't start, separation falls back to CPU automatically.
- Separation runs in a background utility process, so playback and the UI stay responsive. Shows progress, a time-left estimate, and Cancel.
- A per-stem mixer (volume, **M**ute, **S**olo; Ctrl/⌘-click S for exclusive solo) feeds the time-stretcher, so you can solo the bass at 50% speed.
  - *Stems / Original* (`Shift+S`) A/B-compares against the untouched recording.
  - Soloing one stem shows its waveform, and the spectrum, note and chord detection follow what you hear.
- Stems are cached per song (16-bit WAV) and reload instantly; the mixer settings are saved with the project. *Export WAVs…* writes the six stems anywhere.

**Chord chart (Chords tab and the chord row above the waveform)**
- Every song is charted automatically in about a second, in a background worker. Once stems exist, it re-charts from the instruments only (no vocals or drums), which is cleaner.
- How it works: chroma (pitch-class profile) every 0.2 s, scored against chord templates, then decoded with Viterbi and a change penalty. Chords change only when the music clearly does, and silence becomes N.C.
- Vocabulary: Simple (major/minor), Standard (+ 7ths, sus, dim, power) or Full.
- **Chord row:** click a chord to jump to it, double-click to select it (then `L` loops it). `<` / `>` step through chords and `C` selects the current one.
- **Chords tab:**
  - guitar diagrams of every chord in the song (capo-aware; click one to hear it)
  - the progression, following the playhead
  - type over any chord to correct it (`Am7`, `F#m7b5`, `Bb/D`, `N.C.`); *Split at playhead* inserts a change
  - copy or save a text chord sheet
- Corrections are saved with the song and never overwritten automatically.
- Names follow what you hear: they include the pitch shift, the instrument transposition and your spelling choice.

**Guitar chord diagrams**
- The current chord guess is drawn as a guitar chord box: muted and open strings, finger numbers, barres, the position label (e.g. "6fr"), root notes highlighted, and note names under the strings.
- Familiar open and barre shapes are shown first. Other voicings come from a fretboard search that covers all 16 chord qualities in every key, slash chords included. Use ‹ › to step through up to four voicings across the neck.
- A capo setting (1–9) re-fingers the shape, labelled e.g. "B♭ (G shape)".
- Click a diagram to hear it strummed.
- A guess must hold for about 0.2 s before the diagram changes, so it doesn't flicker during playback.

**Reference piano**
- Click or drag keys for piano or sine tones.
- The A4 reference (e.g. 432 Hz) also drives the key positions and note detection.

**Transposition**
- Note and chord names can be written for B♭, E♭, F or octave instruments.
- Accidentals are spelled Auto (lead-sheet style: B♭, E♭, F♯, C♯m), all sharps or all flats.

**Shortcuts**
- Every action can be rebound (⌨ button or `Ctrl+,`).
- Global hotkeys keep working while another app is focused.
- MIDI pedals and pads are supported through MIDI learn. USB foot pedals that type keys work through the Key or Global columns.

**Per-file memory**
- Markers, loops, EQ, channel mode, speed and pitch are saved automatically for each file under the app's user-data folder.

## Default keys

| | |
| --- | --- |
| `Space` play/pause · `S` stop · `Home` to start | `←`/`→` ±1 s · `Shift+←/→` ±5 s · `,`/`.` previous/next marker |
| `L` loop on/off · `Shift+L` save loop · `1`–`9` recall · `Esc` clear | `H` half speed · `[`/`]` speed ±5% · `Shift+↑/↓` pitch ±1 st |
| `N` section · `M` measure · `B` beat · `Del` delete marker · `T` tap · `<`/`>` chords · `C` select chord | `=`/`-`/`0` zoom in/out/fit · `F` follow · wheel zoom · `Shift`+wheel scroll |

## Stem separation: performance

Measured on a Ryzen with 16 threads and a Radeon RX 6700 XT (Linux):

| | per 7.8 s chunk | 3:42 song |
| --- | --- | --- |
| CPU (8 threads) | 1.5–2.0 s | ≈ 80 s |
| GPU (WebGPU / Vulkan) | 2.4 s | ≈ 95 s |

GPU and CPU outputs agree to 87 dB SNR. Peak memory of the separator process is about 2.5 GB. On machines with fewer CPU cores the GPU usually wins, which is why Auto measures instead of assuming.

The model is HTDemucs by Défossez et al. (Meta AI), MIT licence; the ONNX export is by adowu (MIT).

## Architecture

```
electron/main.cjs        window, menu, dialogs, project files, global hotkeys, single instance / open-with
electron/preload.cjs     window.api bridge (sandboxed, context-isolated)
src/dsp/                 StretchEngine (phase vocoder + resampler), ChannelMixer, FFT — pure TS, unit-tested
src/analysis/            SpectrumAnalyzer, note/chord estimation, naming & transposition, guitar voicings — pure TS, unit-tested
src/audio/               AudioWorklet host, AudioEngine (transport, EQ chain, reference tones), EQ presets
src/waveform/            min/max/RMS peak pyramid + canvas drawing
src/components/          views and panels
src/shortcuts.ts         action registry, key-combo normalisation, accelerator mapping
src/midi.ts              Web MIDI listener (note-on / CC pedal presses)
src/project.ts           per-file project data and persistence
src/stems/               stem types/mixer maths, useStems hook (model, separation, cache, engine layers)
electron/stems/          model download/verification, separation service + IPC, ONNX Runtime utility process
```

**Audio path:**

```
decoded mix + 6 stems ─► AudioWorklet [per-source gains → StretchEngine → ChannelMixer] ─► 10 × peaking EQ ─► high-pass ─► low-pass ─► master gain ─► out
                                                              reference tones ──────────────────────────────┘
```

**Time-stretch and pitch.**
- A phase vocoder (4096-point frames, 75% overlap) with identity phase locking stretches the audio by `pitch / speed`.
- A Hermite resampler then reads the result `pitch` times faster, so tempo and pitch stay independent.
- At 100% speed with no pitch shift, the output is identical to the input.
- Loops read the source circularly, so a wrap continues smoothly instead of restarting.
- Every output sample carries the source position it came from, which keeps the playhead latency-compensated.

**Analysis.**
- 16384-point Blackman-Harris FFT, mixed according to the channel mode and weighted by the EQ's response.
- Each note's salience is a harmonic sum over its first five partials; spurious octave and twelfth matches are suppressed.
- Chords are matched against 16 chord-quality templates over the detected notes' chroma.

## Known limitations

- **Transients:** drum hits and other sharp attacks soften at very slow speeds; the usual fix is detecting attacks and handling them separately.
- **Chord guesses:** they are a hint. Dense mixes, distorted guitars and strong vocals will confuse them; EQ and vocal cut help.
- **Global hotkeys on Wayland:** they go through the desktop's GlobalShortcuts portal, so the desktop may ask for permission the first time. If registration fails, the dialog says so.
- **Vocal cut:** it only removes what is mixed exactly to the centre. Reverb and stereo effects on the voice remain.
