# Earwork

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
| `N` section · `M` measure · `B` beat · `Del` delete marker · `T` tap | `=`/`-`/`0` zoom in/out/fit · `F` follow · wheel zoom · `Shift`+wheel scroll |

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
```

**Audio path:**

```
decoded buffer ─► AudioWorklet [StretchEngine → ChannelMixer] ─► 10 × peaking EQ ─► high-pass ─► low-pass ─► master gain ─► out
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
