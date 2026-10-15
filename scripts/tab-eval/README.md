# Tab sync evaluation

Measures how well a Guitar Pro tab is lined up with its recording (`src/tabs/`), so changes to the sync can be measured instead of guessed.

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

**Confidence.** Sections below 0.4 are marked as poorly matched in the panel. That catches 62% of the bars showing the wrong music and 3% of the right ones; at 0.5, 76% and 7%. The confidence combines how well the harmony matches with how much worse the best alignment would be if this section were placed elsewhere. It can't flag the remaining errors, because harmony alone can't tell them apart (next section).

## What goes wrong

- **Sections with the same chords.** Both songs' intros have the same chords as their verses. When the tab leaves out the intro, the tab's verse can start at the intro just as well, and on the mix (vocals included) it sometimes does. One drag fixes it: with the first bar placed by hand, every variant is at least 95% within ½ beat on the mix (cut-intro 98–100%), and the remaining misses are passes of identical repeats. The stems separate the cases better.
- **Endings the tab doesn't have.** The recordings ring on past the charts' last chord. Wonderwall's last two bars match the chorus as well as the written ending, so the ending is sometimes placed one bar late. Those bars get a low confidence.
- **Clean tabs.** These tabs were written from the same progressions as the reference. Real tabs have wrong chords, missing bars and different voicings. The structural variants and the transposition test cover the most common differences, but not wrong notes.
