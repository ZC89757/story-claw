# Procedural Avatar Mouth Test

This isolated experiment renders a CPU-only 2D avatar mouth test from a
single portrait and WAV narration. It deliberately avoids image-to-video
models and GPU use.

The first renderer is an acoustic baseline:

- audio RMS drives jaw opening;
- spectral centroid supplies a soft round-versus-wide bias;
- attack/release smoothing creates continuous parameter curves at 25 fps;
- the portrait stays static while a small, antialiased mouth patch is
  composited at the calibrated face position.

It is a visual-motion test, not a Chinese phoneme aligner. Production timing
should replace `analyze_audio()` with TTS character timestamps plus pinyin
viseme mapping.

Run from the repository root:

```powershell
python experiments/avatar-procedural-test/render_avatar.py `
  --image experiments/avatar-news-longform-test/input/reference_9x16.png `
  --audio experiments/avatar-news-longform-test/input/article_maxlen.wav `
  --output experiments/avatar-procedural-test/output/acoustic_smooth.mp4
```

Outputs include the MP4, a contact sheet, and render metrics.
