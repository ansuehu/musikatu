# Tab sync evaluation

Measures how well a Guitar Pro tab is lined up with its recording (`src/tabs/`), so changes to the sync can be measured instead of guessed. There are two parts: test tabs made from the chord evaluation's charts (`make-tabs.ts`, `eval.ts`), and real Guitar Pro tabs of songs recorded to a click (`real.ts`).

## Data

Nothing copyrighted is in the repo. The recordings, beats, stems and notes are the chord evaluation's (`scratch/eval/`, see `scripts/chord-eval/README.md`). The test tabs are made locally from song descriptions in `scratch/tabs/<song>.json`: guitar shapes, and the sections in tab order with their bars, repeat counts, and the beat where each pass starts in the recording. The descriptions follow the chord evaluation's reference charts for Oasis' *Wonderwall* (capo 2) and Green Day's *Boulevard of Broken Dreams* (E♭ tuning), as a guitar tab with eighth-note strums and a bass track, written with repeat signs.

```sh
node scripts/tab-eval/make-tabs.ts scratch/tabs                 # → scratch/tabs/out/<song>.<variant>.gp + truth
node scripts/tab-eval/eval.ts scratch/eval scratch/tabs          # SOURCES=mix,stems,stems+notes,stems+notes+chart
```

Each song gets 8 tabs that differ from the recording the way real tabs do:

| Variant | The tab… |
|---|---|
| clean | matches the recording |
| cut-intro | leaves out the intro |
| cut-outro | leaves out the last section |
| drop-pass | repeats a section fewer times than the recording plays it |
| extra-pass | repeats a section more times than the recording plays it |
| transposed | is written without the capo (Wonderwall) or in standard tuning (Boulevard) |
| guitar-only | has no bass track |
| messy | cut-intro, drop-pass, extra-pass and transposed together |

The options below make the app's beat grid worse before syncing, to see how the sync copes when the beat tracker fails. Errors are still measured against the original beats.

| Option | Effect |
|---|---|
| `BEAT_DROP=0.1` | removes 10% of the tracked beats |
| `BEAT_JITTER=30` | moves the remaining beats by up to ±30 ms |
| `BEAT_HALF=1` / `BEAT_DOUBLE=1` | gives the sync half or twice the beats |
| `ANCHOR=1` | places the first bar by hand, as a user would by dragging it |
| `SR=48000` | analyses at another sample rate |
| `PARAMS='{"jump":4}'` | overrides alignment parameters |

## Scores

- **Bar-start error:** for each bar of the tab the recording plays, the distance from where the sync starts it to where it really starts, in ms and in beats. The reference bar starts are on the tracked beats (beat k of the chart is beat k of `beats.json`), so on an unperturbed grid this measures choosing the right beat. Timing within a beat is the beat tracker's, and the `BEAT_JITTER` runs show how errors in it carry over.
- **Within ½ beat:** share of the tab's bars placed within half a beat of their true start. Bars the sync leaves out count as misses. When the tab and recording repeat a section a different number of times, any pass of it counts.
- **Right music:** share of true bar starts where the panel shows a bar with the same notes as the true one, within half a beat. A pass of a repeat that is identical to the true pass counts as right here (but not in "within ½ beat"), because the player sees the same music.
- **Confidence:** how well the section confidence shown in the panel separates right music from wrong.

## Results

Stems are the guitar and bass stems; mix is the original recording. Both songs, 44.1 kHz, tracked beats:

| Variant | Stems: within ½ beat | Stems: right music | Mix: within ½ beat | Mix: right music | Mix: p95 error |
|---|---|---|---|---|---|
| clean | 98.9% | 99.4% | 98.9% | 99.4% | 0 ms |
| cut-intro | 98.8% | 99.4% | 93.9% | 95.1% | 2760 ms (4 beats, Wonderwall) |
| cut-outro | 100% | 100% | 100% | 100% | 0 ms |
| drop-pass | 98.9% | 99.4% | 98.9% | 99.4% | 0 ms |
| extra-pass | 96.8% | 99.4% | 96.8% | 99.4% | 0 ms |
| transposed | 98.9% | 99.4% | 98.9% | 99.4% | 0 ms |
| guitar-only | 98.9% | 99.4% | 98.9% | 99.4% | 0 ms |
| messy | 96.3% | 99.4% | 85.2% | 95.0% | 5760 ms (8 beats, Boulevard) |
| **all** | **98.4%** | **99.5%** | **96.6%** | **98.5%** | |

The median bar-start error is 0 ms (0 beats) in every row. Wherever the stems' p95 is above 0 it is also 0 ms. The transposition is found every time: +2 semitones for Wonderwall without the capo, −1 for Boulevard in standard tuning.

With a worse beat grid (stems / mix):

| Beat grid | Median error | p95 error | Within ½ beat | Right music |
|---|---|---|---|---|
| 10% of beats removed, rest moved ±30 ms | 15 ms (0.02 beats) | 29 ms (0.04 beats) | 97.7% / 96.6% | 99.5% / 98.5% |
| half the beats (tracker at half speed) | 0 ms | 0 ms | 98.4% / 97.9% | 99.7% / 99.7% |
| twice the beats (tracker at double speed) | 0 ms | 0 / 350 ms | 96.6% / 92.6% | 99.2% / 94.4% |
| 48 kHz instead of 44.1 kHz | 0 ms | 0 ms | 97.3% / 96.6% | 99.2% / 98.5% |
| first bar placed by hand | 0 ms | 0 ms | 98.4% / 98.4% | 99.5% / 99.5% |

Transcribed notes and the chord chart as extra evidence did not help: 97.7% / 99.5% (stems + notes) and 96.9% / 99.5% (stems + notes + chart), against 98.4% / 99.5% for the stems alone. The app uses the guitar and bass stems when the song has them, and the mix otherwise.

**Confidence.** The confidence combines two things: how well the harmony matches, and how much worse the best alignment gets if the section's first bar (or any bar with the same notes) may not sound within a beat of where it was put. The panel tints sections below 0.5 amber ("check this") and below 0.3 red ("poor match"). Amber catches 86% of the bars showing the wrong music and 3% of the right ones; red catches 14% and 0%. It can't flag the rest, because harmony alone can't tell them apart (see below).

## A real tab: *Drip* (Mise en Abyme)

```sh
node scripts/chord-eval/prepare.cjs scratch/eval Drip.flac     # beats; separate.cjs for the stems (drums are needed)
echo /path/to/Drip.flac > scratch/eval/Drip.src
node scripts/tab-eval/real.ts scratch/eval Drip "scratch/drip/03 Drip.gp"   # VERBOSE=1: per section, BARS=1: bars off by ½ beat
```

A full-band Guitar Pro tab:

- 183 bars at a constant 175 BPM, no repeat signs;
- mostly 4/4, with eleven 5/4 bars and single 1/8, 7/8 and 9/8 bars;
- eight tracks in drop C: two clean guitars, two rhythm guitars, lead, harmony, bass and drums.

The band played to a click, so the truth comes from the tab. Its tempo map gives each bar's time, and its 1229 drum hits matched to the onsets of the drum stem give the offset. The fit is sharp: 1.55 at the best offset against 0.19 fifty ms off. Section by section the offset is either the song's or 86–88 ms earlier: section A, and everything from C' (around bar 122) to the end. That is a sixteenth note at 175 BPM, so the tab is a sixteenth note longer or shorter than the recording at those two points. The truth uses each bar's local offset. The 23 bars without drums nearby (most of the clean intro) are left out of the scores.

| Audio | Median error | p95 error | Max | Within ½ beat | Unplaced |
|---|---|---|---|---|---|
| guitar + bass stems | 15 ms (0.04 beats) | 293 ms (0.86 beats) | 382 ms | 88.1% | 0 of 160 |
| mix | 15 ms (0.04 beats) | 194 ms (0.57 beats) | 505 ms | 85.6% | 4 of 160 |
| mix, in the app (48 kHz, its own beat tracking) | 13 ms | 308 ms | | 86.3% | 3 of 160 |

The sync takes about 2 s in a worker (3.9 s in the app, including reading the file). Almost all the misses are half a beat off (170–190 ms). That is the beat tracker: in these syncopated riffs it sometimes locks onto the off-beats, and 20 of the 160 true bar starts have no tracked beat within 60 ms. Since bars can only start on tracked beats, those bars land half a beat off. Lining bars up with the tab's note onsets, rather than with the tracked beats, would fix this, but it needs a truth that doesn't also come from onsets.

Two changes came from this song. The tracker counted the 35-second clean intro (no drums) at half speed, so the grid repair now splits stretches whose spacing is about twice the song's beat. And the uniqueness part of the confidence now rules out the bar sounding within a beat of its place, not only starting exactly there; before, correct sections of this song scored as low as 0.02.

## What goes wrong

- **Sections with the same chords.** Both songs' intros have the same chords as their verses. When the tab leaves out the intro, the tab's verse can start at the intro just as well, and on the mix (vocals included) it sometimes does. One drag fixes it: with the first bar placed by hand, every variant is at least 95% within ½ beat on the mix (cut-intro 98–100%), and the remaining misses are passes of identical repeats. The stems separate the cases better.
- **Endings the tab doesn't have.** The recordings ring on past the charts' last chord. Wonderwall's last two bars match the chorus as well as the written ending, so the ending is sometimes placed one bar late. Those bars get a low confidence.
- **Clean tabs.** The test tabs were written from the same progressions as the reference. *Drip* is a real tab, but it matches its recording closely: it was transcribed with the click, apart from two sixteenth-note slips. Tabs with wrong notes or bars haven't been measured.
- **Quiet parts on the mix.** *Drip*'s clean intro is placed right but scores 0.21–0.30, because the clean guitars are quiet under everything else, so it is tinted as a poor match. The stems help a little.
