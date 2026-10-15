# Chord-chart evaluation

Scores the app's chord chart against reference annotations, so changes to the chord analysis can be measured instead of guessed.

## Data

Audio isn't in the repo. Per song, the evaluation directory (e.g. `scratch/eval/`, which is gitignored) holds:

- `<name>.src`: path to the audio file (or put the audio itself there as `<name>.flac/.wav/.mp3/.m4a`)
- `<name>.beats.json`: beats and downbeats from the app's beat model (`prepare.cjs`)
- `<name>.lab`: the reference, `start end chord` per line in seconds (`chart2lab.cjs` makes it from a chart)
- `stems/<name>/*.wav`: optional stems (`separate.cjs`); the app charts from stems when it has them, so both are scored

`charts/` has beat-indexed reference charts for two songs: Oasis' *Wonderwall* and Green Day's *Boulevard of Broken Dreams*. They were written from the songs' known progressions, at sounding pitch, with section starts read off the separated bass and guitar. The beat numbers refer to the beats `prepare.cjs` tracks on the album versions, so they only line up with those recordings.

```sh
D=scratch/eval
node scripts/chord-eval/prepare.cjs $D ~/Music/Wonderwall.flac                  # decode + beats
node scripts/chord-eval/separate.cjs ~/.config/Musikatu/models/htdemucs_6s_fp16weights.onnx $D/stems ~/Music/Wonderwall.flac
echo ~/Music/Wonderwall.flac > $D/Wonderwall.src
cp scripts/chord-eval/charts/Wonderwall.chart $D/ && node scripts/chord-eval/chart2lab.cjs $D Wonderwall
node scripts/chord-eval/eval.ts $D                                                 # VOCAB=simple|standard|full, DUMP=beat-sync:stems
```

## Scores

Time-weighted on a 10 ms grid, as in MIREX / mir_eval:

- **root:** the root is right
- **maj/min:** the root and the major/minor quality are right; chords that are neither are left out of this score (sus, power chords)
- **≥3 notes:** the detected chord shares at least three notes with the reference (MIREX)
- **segm.:** 1 − the worse of over- and under-segmentation; 100 means the changes are exactly where the reference has them
- **changes/min:** chart busyness; the two references have about 40–42

## Results (standard vocabulary, mean of the two songs)

| Source | Method | root | maj/min | ≥3 notes | segm. | changes/min |
|---|---|---|---|---|---|---|
| mix | frames + snap to beats (before) | 66.5 | 35.7 | 48.8 | 81.4 | 40.2 |
| mix | beat-synchronous | 74.1 | 36.9 | 47.0 | 91.1 | 42.4 |
| stems | frames + snap to beats (before) | 75.6 | 38.8 | 42.8 | 84.2 | 38.3 |
| stems | beat-synchronous | 86.9 | 36.8 | 40.9 | 95.6 | 40.2 |

maj/min is low because both recordings are mostly root-and-fifth guitars, so the chart says A♭5 or F♯5 where the reference says A♭ or F♯m. With `VOCAB=simple` (major/minor only), maj/min on the beat-synchronous chart rises to 64.0 (mix) and 74.0 (stems), and ≥3 notes to 56.0 and 65.1.

The beat switch costs (`BEAT_SWITCH_PENALTY` in `src/analysis/chordTimeline.ts`) were checked with `PENALTY_SCALE` from 0.5 to 2: about 1.5× the first guess was best on every score, and they were set there. Both songs change chord every two beats, so more songs are needed before tuning them further.
