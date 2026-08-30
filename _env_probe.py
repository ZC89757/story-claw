import importlib, torch
print("torch:", torch.__version__)
print("cuda:", torch.version.cuda)
print("cudnn:", torch.backends.cudnn.version())
print("flash_sdp:", torch.backends.cuda.flash_sdp_enabled(),
      "mem_eff:", torch.backends.cuda.mem_efficient_sdp_enabled(),
      "math:", torch.backends.cuda.math_sdp_enabled())
print("GPU:", torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0))
for mod in ("xformers", "flash_attn", "sage_attention", "sageattention", "triton"):
    try:
        m = importlib.import_module(mod)
        v = getattr(m, "__version__", "yes")
        print("  {}: {}".format(mod, v))
    except Exception as e:
        print("  {}: NO ({})".format(mod, type(e).__name__))
