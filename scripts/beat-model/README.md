# Rebuilding `electron/beats/models/beat_this_small0.onnx`

The bundled beat model is the official Beat This! `small0` checkpoint, exported to ONNX here because the
third-party exports either freeze a shape (`b = len(x)` gets traced as a constant, so results depend on the
input length) or are the 80–190 MB `final` model.

```sh
python3 -m venv /tmp/bt && /tmp/bt/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
/tmp/bt/bin/pip install onnx onnxruntime numpy soundfile einops rotary-embedding-torch "git+https://github.com/CPJKU/beat_this.git"
# the one-line fix: let the batch size stay symbolic
sed -i 's/        b = len(x)/        b = x.shape[0]/' /tmp/bt/lib/python3*/site-packages/beat_this/model/beat_tracker.py
# needs, in <workdir>: song-22k-mean.f32 (any song, mono float32 at 22.05 kHz, mean downmix) and
# beat/mel_spectrogram.onnx (from huggingface.co/ashudesai/songbird-models) for the checks
/tmp/bt/bin/python export_beat_this.py <workdir>
```

The script exports at a fixed 1500-frame window (opset 17), then checks the ONNX logits against PyTorch on real
audio, the mel front end against the reference `LogMelSpect`, and writes the reference beats for comparison.
