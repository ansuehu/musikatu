import sys, numpy as np, torch, onnxruntime as ort
from beat_this.inference import load_model
from beat_this.preprocessing import LogMelSpect

S = sys.argv[1]
T = 1500
model = load_model("small0", device="cpu").eval()

class Wrap(torch.nn.Module):
    def __init__(self, m): super().__init__(); self.m = m
    def forward(self, spect):
        out = self.m(spect)
        return out["beat"], out["downbeat"]

w = Wrap(model).eval()
dummy = torch.randn(1, T, 128)
path = f"{S}/beat_this_small0_1500.onnx"
torch.onnx.export(w, (dummy,), path, input_names=["spect"], output_names=["beat", "downbeat"], opset_version=17, dynamo=False, do_constant_folding=True)
print("exported", path)

# --- parity on real log-mel windows from the song ---
audio = np.fromfile(f"{S}/song-22k-mean.f32", dtype=np.float32)
mel_t = LogMelSpect()(torch.from_numpy(audio))  # (time, 128)
print("torch mel", tuple(mel_t.shape))
sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
worst = 0
for start in [0, 1500, 4000, 7000]:
    x = mel_t[start:start + T].unsqueeze(0)
    with torch.no_grad():
        ref = w(x)
    got = sess.run(None, {"spect": x.numpy()})
    d = max(float(np.abs(ref[0].numpy() - got[0]).max()), float(np.abs(ref[1].numpy() - got[1]).max()))
    worst = max(worst, d)
print("onnx vs torch max |logit diff| on 4 real windows:", worst)

# --- the third-party mel graph vs the reference LogMelSpect ---
mel_sess = ort.InferenceSession(f"{S}/beat/mel_spectrogram.onnx", providers=["CPUExecutionProvider"])
clip = audio[: 22050 * 40]
mel_o = mel_sess.run(None, {"audio_pcm": clip[None, :]})[0][0]
mel_r = LogMelSpect()(torch.from_numpy(clip)).numpy()
n = min(len(mel_o), len(mel_r))
print("mel frames onnx/ref", len(mel_o), len(mel_r), "max |diff|", float(np.abs(mel_o[:n] - mel_r[:n]).max()))

# --- reference beats (the library's own pipeline) for later comparison ---
from beat_this.inference import Audio2Beats
a2b = Audio2Beats(checkpoint_path="small0", device="cpu", dbn=False)
beats, downbeats = a2b(audio, 22050)
np.save(f"{S}/ref_beats.npy", beats); np.save(f"{S}/ref_downbeats.npy", downbeats)
print("reference:", len(beats), "beats,", len(downbeats), "downbeats; first", np.round(beats[:6], 2), "| downbeats", np.round(downbeats[:4], 2))
