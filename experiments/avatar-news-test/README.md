# Avatar News Test

Isolated A/B test for an anime news presenter. The repository's production
pipeline and GPU lifecycle scripts are not modified.

## Models

- EchoMimicV3 Flash: 8-step, 768x768, one short Chinese speech clip.
- LongCat-Video-Avatar 1.5: 8-step distilled INT8, 480p, single GPU. Its
  UMT5-XXL text encoder stays in system RAM so the remaining models fit the
  32 GB 5090.

Large repositories, Python wheels, and model weights are downloaded only on
the configured 5090 instance under `/root/avatar-news-test`.

## Lifecycle

```powershell
python experiments/avatar-news-test/start_gpu.py
python experiments/avatar-news-test/stop_gpu.py
```

`start_gpu.py` starts the configured CompShare instance without submitting the
unrelated production ComfyUI/LTX readiness render.
