# Musikatu

A music transcription workbench with **on-device AI** (formerly *Earwork AI*). The classic version without AI lives on the `main` branch (tag `v1-classic`). The two use different app IDs, so they install side by side.

When it starts under the new name for the first time, Musikatu adopts the old `Earwork AI` data folder automatically: the downloaded model, cached stems, per-song projects, preferences and shortcuts all carry over.

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
- **Stem cache** (bottom of the Stems tab):
  - Lists every cached song: size, length, date and backend, with a "this song" badge for the open one, and warnings when the original file has moved or an entry is incomplete. Each song can be deleted on its own.
  - The cache folder can be changed (e.g. to a bigger disk): existing stems are moved there (renamed on the same disk, copied then removed across disks), and *Use default* moves them back.
  - Only the app's own stem folders are ever moved or deleted, so a shared folder is safe.

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

**Beats, bars and metronome (Beats tab)**
- Every song gets a beat grid automatically, about 3 s on CPU: beats, downbeats, tempo and meter.
  - Uses **Beat This!** (JKU Linz, ISMIR 2024), small model, 10 MB, bundled with the app, so it works offline.
  - Its output matches the reference implementation exactly on a test song (all 278 beats and 79 downbeats).
- **Waveform:** bar numbers along the top, bar and beat lines. The transport shows *Bar 17 · 3* and the tempo, adjusted for the current speed.
- **Metronome** (`K`): clicks on every beat with an accent on the 1. It is rendered in the audio thread, so it stays in time at any speed and across loops.
  - The ⚙ editor offers an overall level up to 200%, a sine, triangle or square sound, and per click (accent / other beats) volume, pitch in Hz (slider or typed, with the note name) and length.
  - Each click has a ▶ Test button that works while stopped.
  - Presets: Classic, Woodblock, Cutting, Low & soft, Accent only. Settings are remembered app-wide.
- **Bar tools:**
  - *Loop bars 9–12*, plus `Shift+B` to select the current bar.
  - `PageUp` / `PageDown` move between bars.
  - Selections snap to beats (can be turned off).
- **Fixing the grid:** move the downbeat ±1 beat, ½× / 2× tempo, change the meter, "Bar 1 here". Corrections are saved with the song.
- **Chord chart:** chord changes snap onto beats, chord rows show bar.beat, and the exported sheet has a bar-by-bar section (`| C | Am | F G |`, with `%` for repeated bars).

**Practice tools (Practice tab)**
- **Count-in** (`I`, or the *1·2·3·4* transport button): one or two bars of clicks before playback starts.
  - It plays at the song's tempo at your current speed, with your metronome sounds, while a big countdown shows on screen; the playhead waits where you pressed play.
  - Optionally it counts in again before every loop repeat, giving you time to reset your hands.
  - Rendered in the audio thread, so the clicks are sample-accurate.
- **Speed trainer** (`R`): loops the selection, starting at, say, 60% and raising the speed by a step every N passes up to a target.
  - At the target it keeps looping, starts over, or stops.
  - A badge in the speed panel shows it's running; the Practice tab shows the pass count and progress.
  - Works together with the count-in and the metronome.
- **Click track:** the metronome (Beats tab).

**Audio → notes / MIDI (Notes tab and piano roll)**
- Transcribes any separated stem (vocals, bass, guitar, piano/keys, other) or the full mix into notes.
  - Uses Spotify's **Basic Pitch**, a 230 KB model bundled with the app, on CPU: about 1.6 s for a 3:42 song.
  - Matches the reference package exactly on test audio.
- **Piano roll** under the waveform, sharing its zoom and scroll:
  - notes in each stem's colour, with bar and beat lines
  - notes glow while they sound; click one to hear it
  - Shift-click selects several; `↑`/`↓` move the selection a semitone, `Del` removes it
- **♪ play-along:** a synth plays the notes in sync with the recording at any speed, loop and pitch shift. *Hear the notes only* mutes the recording to check the transcription by ear.
- **Detection settings per source:** new-note sensitivity, sustain, shortest note and pitch range (each instrument starts with a sensible range). They re-apply instantly, without re-running the model.
- **Export MIDI:** one track per source with a matching GM instrument.
  - With a beat grid, the file carries the song's own tempo map (one beat = one quarter) and a time-signature change for any irregular bar.
  - Every detected bar starts a MIDI bar, and notes stay within about 3 ms of the audio.
  - Opens directly in MuseScore, Guitar Pro or a DAW.

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

**Window**
- **Hide or show the File / Edit / View menu bar:** the window button at the right of the top bar, *View ▸ Show Menu Bar*, or `Ctrl+Shift+M`.
  - While hidden, `Alt` shows it briefly, and its shortcuts (e.g. `Ctrl+O`) keep working.
  - The choice is remembered.
  - Linux and Windows only: macOS has no per-window menu bar.

## Default keys

| | |
| --- | --- |
| `Space` play/pause · `S` stop · `Home` to start | `←`/`→` ±1 s · `Shift+←/→` ±5 s · `,`/`.` previous/next marker |
| `L` loop on/off · `Shift+L` save loop · `1`–`9` recall · `Esc` clear | `H` half speed · `[`/`]` speed ±5% · `Shift+↑/↓` pitch ±1 st |
| `N` section · `M` measure · `B` beat · `Del` delete marker · `T` tap · `<`/`>` chords · `C` select chord · `PageUp`/`PageDown` bars · `Shift+B` select bar · `K` metronome · `↑`/`↓`/`Del` edit selected notes · `I` count-in · `R` speed trainer | `=`/`-`/`0` zoom in/out/fit · `F` follow · wheel zoom · `Shift`+wheel scroll |

## Stem separation: performance

Measured on a Ryzen with 16 threads and a Radeon RX 6700 XT (Linux):

| | per 7.8 s chunk | 3:42 song |
| --- | --- | --- |
| CPU (8 threads) | 1.5–2.0 s | ≈ 80 s |
| GPU (WebGPU / Vulkan) | 2.4 s | ≈ 95 s |

GPU and CPU outputs agree to 87 dB SNR. Peak memory of the separator process is about 2.5 GB. On machines with fewer CPU cores the GPU usually wins, which is why Auto measures instead of assuming.

The model is HTDemucs by Défossez et al. (Meta AI), MIT licence; the ONNX export is by adowu (MIT).

The note model is Spotify's Basic Pitch (Apache-2.0); see `electron/transcription/models/NOTICE.md`. The beat model is Beat This! small (Foscarin, Schlüter, Widmer, JKU Linz; MIT). It was exported here from the official checkpoint; see `scripts/beat-model/` and `electron/beats/models/NOTICE.md`.

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
