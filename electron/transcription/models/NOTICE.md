# Bundled transcription model

- `basic_pitch_nmp.onnx`: **Basic Pitch** (Spotify), polyphonic note transcription, from
  R. M. Bittner, J. J. Bosch, D. Rubinstein, G. Meseguer-Brocal, S. Ewert, *A Lightweight
  Instrument-Agnostic Model for Polyphonic Note Transcription and Multipitch Estimation*, ICASSP 2022.
  File `basic_pitch/saved_models/icassp_2022/nmp.onnx` from https://github.com/spotify/basic-pitch,
  Apache License 2.0 (full text in `LICENSE-basic-pitch.txt`).
  SHA-256 `2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec`

Musikatu reimplements the windowing (`electron/transcription/basic-pitch.cjs`) and note extraction
(`src/transcription/basicPitch.ts`) of basic-pitch 0.4.0, without pitch bends. On test audio the notes match the
reference package exactly (start, end, pitch; amplitudes within 1e-7).
