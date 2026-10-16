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

## Real tabs

```sh
node scripts/chord-eval/prepare.cjs scratch/eval song.flac      # beats
DEVICE=cpu node scripts/chord-eval/separate.cjs <model> scratch/eval/stems song.flac
echo /path/to/song.flac > scratch/eval/<song>.src
node scripts/tab-eval/real.ts scratch/eval <song> <tab file>    # VERBOSE=1: sections, BARS=1: bars off by ½ beat, SUMMARY=<file>
```

Six songs with a Guitar Pro tab, kept locally:

- five from Mise en Abyme's album, transcribed with drums: *Drip*, *Emergence*, *Reflection*, *Framed Pieces*, *A Way Out*;
- Chon's *Dew*, a fan tab with no drum track.

They are much harder than the test tabs:

- 3/4, 5/4 and 7/4 sections, with single 1/16, 1/8, 7/8, 9/8, 11/8 and 14/8 bars;
- tempo changes, some in the middle of a bar;
- 6- and 7-string guitars in drop tunings;
- clean intros without drums, blast beats, and recordings longer than their tabs (*A Way Out* by 55 s, *Emergence* by a 21-second intro).

**The truth.** These songs were played to a click and the tabs follow it, so the truth comes from the tab:

1. Its tempo map gives each bar's time.
2. Its drum hits, matched to the onsets of the drum stem, give the offset to the recording: first for the whole song, then for each section. A section keeps the previous section's offset while it still fits, since drum grooves fit nearly as well one bar off, and it moves only where the recording adds or leaves out something.
3. Then each bar gets an offset within ±100 ms of its section's.

Sections whose peak isn't sharp (under 3× the fit 50 ms either side) get no truth, nor do bars with too few drum hits near them. That excludes clean intros, and blast beats, which repeat every eighth. The sync uses neither drums nor onsets, so this truth is independent of it.

*Dew* gets no truth. Matching its guitar notes against the guitar and bass stems has no clear peak (1.2×), and the recording is 16 s longer than the tab's tempo map. The tab's timing doesn't follow the recording closely enough to measure against.

**Results** (within ½ beat of the true bar start; median / p95 error with the tempo lock):

| Song | Bars with truth | Stems, beats only | Stems, tempo lock | Mix, beats only | Mix, tempo lock | Median / p95 (stems) |
|---|---|---|---|---|---|---|
| Drip | 157 of 183 | 90.4% | 100% | 87.9% | 100% | 10 / 26 ms |
| Emergence | 57 of 202 | 56.1% | 98.2% | 52.6% | 98.2% | 6 / 21 ms |
| Reflection | 116 of 144 | 37.1% | 56.9% | 28.4% | 59.5% | 70 / 329 ms |
| Framed Pieces | 176 of 213 | 91.5% | 92.6% | 89.2% | 100% | 13 / 433 ms |
| A Way Out | 260 of 262 | 80.0% | 100% | 76.2% | 93.5% | 15 / 35 ms |
| **all** | 766 | **76.5%** | **91.6%** | **72.6%** | **91.5%** | |

The app gives the same on *Drip* (100%, median 12 ms) and *Emergence* (56 of 57, median 10 ms, p95 23 ms), at 48 kHz with its own beat tracking. All harness checks pass.

**Why the tempo lock.** The harmony sync can only start bars on tracked beats, and on these songs the beat tracker often loses the pulse:

- it counts a drumless intro at half speed, which the grid repair fixes;
- it sits on the off-beats in syncopated riffs;
- it ticks two to four times too fast through blast beats;
- it wanders in odd meters (*Emergence* bars 107–117 have 6–10 tracked beats per 4/4 bar).

The tempo lock (`src/tabs/tempo.ts`) uses the fact that recording time is a straight line of tab time, broken only where the recording adds or leaves out something. It takes runs of bars the sync placed on a steady tempo and keeps the ones that tell one consistent story. A run placed somewhere wrong, but on a steady tempo, is left out. Then:

- single bars off the line of their neighbours are moved onto it;
- stretches between two runs on the same line are rebuilt on that line, whatever the sync put there;
- the bars before the first run and after the last are put on its line if their harmony fits about as well as the rest of the song and as well as the sync's own placement (or the sync repeated material there). An intro the tab doesn't have fails that test;
- whole stretches half a beat off, between two runs that agree, are moved back.

Where a recording doesn't keep the tab's tempo, no runs line up and nothing moves (unit tests with rubato and an intro missing from the tab). On the test songs, the lock changes within ½ beat from 98.4% to 99.0% on stems and from 96.6% to 97.3% on the mix.

**What didn't work.**

- **Onsets.** Matching the tab's guitar and bass onsets to the recording's: steady eighth-note riffs look the same half a beat later (88.1% → 89.4% on *Drip*).
- **Regridding.** Replacing the tracked beats with the tab's where they disagreed, then analysing and syncing again. It helped *Reflection* and hurt *Emergence*, because counting 9/8 in dotted quarters or quarters is a legitimate difference, not an error. And no measure from inside the app could tell when to trust the second pass.

**Still wrong.**

- ***Reflection*:** 57–60%. The tracker counts sixteenths through the first 30 seconds. The sync takes section B for a repeat of A, which has similar harmony, and the recording drifts about 0.4 s against the tab over the song.
- ***Framed Pieces* on stems:** 92.6%. Its two long runs are 0.9 s apart where the tab says they meet; the recording probably holds something there that the tab doesn't. The mix gets it right.
- ***Dew*:** after the first minute the sync scatters, with jumps, and nearly every section is marked as a poor match. The panel at least says so.

The sync takes 2–4 s per song in the worker.

## What goes wrong

- **Sections with the same chords.** Both songs' intros have the same chords as their verses. When the tab leaves out the intro, the tab's verse can start at the intro just as well, and on the mix (vocals included) it sometimes does. One drag fixes it: with the first bar placed by hand, every variant is at least 95% within ½ beat on the mix (cut-intro 98–100%), and the remaining misses are passes of identical repeats. The stems separate the cases better.
- **Endings the tab doesn't have.** The recordings ring on past the charts' last chord. Wonderwall's last two bars match the chorus as well as the written ending, so the ending is sometimes placed one bar late. Those bars get a low confidence.
- **Clean tabs.** The test tabs were written from the same progressions as the reference. The Mise en Abyme tabs were transcribed with the click and match their recordings closely; *Dew* doesn't, and there the sync fails. Tabs with wrong notes or bars, and songs not played to a click, are only covered by the test tabs.
- **Quiet parts on the mix.** *Drip*'s clean intro is placed right but scores 0.21–0.30, because the clean guitars are quiet under everything else, so it is tinted as a poor match. The stems help a little.
