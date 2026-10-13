# Bundled beat-tracking models

- `beat_this_small0.onnx`: **Beat This!** small model (2.1M parameters), beat and downbeat tracking.
  F. Foscarin, J. Schlüter, G. Widmer, *Beat This! Accurate Beat Tracking Without DBN Postprocessing*, ISMIR 2024.
  Weights: official `small0` checkpoint from https://github.com/CPJKU/beat_this (MIT licence).
  Exported for Earwork at a fixed 1500-frame window (opset 17), with `b = len(x)` replaced by `b = x.shape[0]`
  so the tracer does not freeze a shape. Verified within 4e-5 of the PyTorch model on real audio, and the
  app's beats and downbeats match the reference `Audio2Beats` pipeline exactly on a test song.
  SHA-256 `e3b1f6b530b2c55fe3dd1558060f747b117f98afe0deb676774858109338bfb1`
- `mel_spectrogram.onnx`: the model's log-mel front end (22.05 kHz, 50 frames/s, 128 bands) as an ONNX graph,
  from https://huggingface.co/ashudesai/songbird-models (MIT), revision `345312bf5604913b3c0d05815f93c81c4b114e4d`.
  Matches the reference `LogMelSpect` within 1.3e-4.
  SHA-256 `f8581e3661590d690a467a1d4ba57d789f45683a289d7280d53a9eec774675b5`

MIT License

Copyright (c) 2024 Institute of Computational Perception, JKU Linz

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
