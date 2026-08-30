"""
gpt-image-gen.py — GPT Image 图像生成 helper（供 Node.js 通过 child_process 调用）

使用 Google GenAI SDK（Vertex AI 模式）调用 ZenMux 的 openai/gpt-image-2:openai

用法：
  python gpt-image-gen.py <output_path> <prompt> [--aspect <ratio>] [image1.png image2.png ...]

  --aspect  可选，值如 "9:16" 或 "16:9"，默认 "1:1"（1024x1024）

退出码：
  0  成功（图片写入 output_path）
  1  失败（错误信息输出到 stderr）
"""
import base64
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

# This experiment uses the direct bnode endpoint. The local proxy accepts a
# connection but stalls image-edit requests, so clear inherited proxy settings.
for _k in ["ALL_PROXY", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(_k, None)

from google import genai
from google.genai import types
from PIL import Image

# aspect_ratio → imageSize 映射（gpt-image-2 支持的尺寸）
ASPECT_TO_SIZE: dict[str, str] = {
    "9:16": "1024x1536",   # 竖版
    "16:9": "1536x1024",   # 横版
    "1:1":  "1024x1024",   # 方形
    "3:2":  "1536x1024",   # 近似横版
    "2:3":  "1024x1536",   # 近似竖版
}
DEFAULT_SIZE = "1024x1024"
# 参考图压缩目标短边像素（避免超大图占带宽/tokens）
COMPRESS_MAX_PX = 512

ASPECT_INSTRUCTIONS: dict[str, str] = {
    "16:9": (
        "MANDATORY OUTPUT FORMAT: create a true 16:9 landscape image. "
        "Compose the scene specifically for a wide horizontal canvas, keeping all "
        "essential subjects and text inside the frame. The returned image canvas itself "
        "must be 16:9. Do not return a 3:2, 4:3, square, or portrait canvas, and do not "
        "simulate 16:9 with letterboxing or borders."
    ),
    "9:16": (
        "MANDATORY OUTPUT FORMAT: create a true 9:16 portrait image. "
        "Compose the scene specifically for a tall vertical canvas, keeping all essential "
        "subjects and text inside the frame. The returned image canvas itself must be 9:16. "
        "Do not return a 2:3, 3:2, square, or landscape canvas, and do not simulate 9:16 "
        "with letterboxing or borders."
    ),
    "1:1": (
        "MANDATORY OUTPUT FORMAT: create a true 1:1 square image. The returned image "
        "canvas itself must be square, with no letterboxing or borders."
    ),
}


def append_aspect_instruction(prompt: str, aspect_ratio: str | None) -> str:
    instruction = ASPECT_INSTRUCTIONS.get(aspect_ratio or "")
    return f"{prompt}\n\n{instruction}" if instruction else prompt


def validate_generated_image(img_bytes: bytes) -> None:
    """拒绝纯黑、纯白、全透明或近乎单色的空白结果，让调用方触发重试。"""
    try:
        with Image.open(io.BytesIO(img_bytes)) as img:
            rgba = img.convert("RGBA")
            rgba.thumbnail((256, 256))
            pixels = list(rgba.getdata())
    except Exception as exc:
        raise ValueError(f"invalid generated image: {exc}") from exc

    if not pixels:
        raise ValueError("generated image has no pixels")

    visible = [(r, g, b) for r, g, b, a in pixels if a >= 16]
    if len(visible) < len(pixels) * 0.01:
        raise ValueError("generated image is blank: almost fully transparent")

    count = len(visible)
    black_ratio = sum(max(rgb) <= 8 for rgb in visible) / count
    white_ratio = sum(min(rgb) >= 247 for rgb in visible) / count
    channels = list(zip(*visible))
    means = [sum(channel) / count for channel in channels]
    variances = [sum((value - mean) ** 2 for value in channel) / count for channel, mean in zip(channels, means)]

    if black_ratio >= 0.995:
        raise ValueError(f"generated image is blank: black pixels {black_ratio:.1%}")
    if white_ratio >= 0.995:
        raise ValueError(f"generated image is blank: white pixels {white_ratio:.1%}")
    if max(variances) < 1.0:
        raise ValueError(f"generated image is blank: near-solid color variance={max(variances):.3f}")


def compress_image(img_path: str) -> bytes:
    """将参考图压缩到短边不超过 COMPRESS_MAX_PX，返回 PNG bytes。"""
    with Image.open(img_path) as img:
        img = img.convert("RGBA")
        w, h = img.size
        short = min(w, h)
        if short > COMPRESS_MAX_PX:
            scale = COMPRESS_MAX_PX / short
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


def openai_image_bytes(resp: object) -> bytes:
    """Extract image bytes from an OpenAI-compatible Images API response."""
    data = getattr(resp, "data", None) or []
    if not data:
        raise ValueError("no image data in OpenAI-compatible response")

    item = data[0]
    b64_json = getattr(item, "b64_json", None)
    if b64_json:
        return base64.b64decode(b64_json)

    image_url = getattr(item, "url", None)
    if image_url:
        with urllib.request.urlopen(image_url, timeout=120) as response:
            return response.read()

    raise ValueError("response image has neither b64_json nor url")


def generate_openai_compatible(
    cfg: dict,
    prompt: str,
    image_paths: list[str],
    image_size: str,
    aspect_ratio: str | None,
) -> bytes:
    import httpx
    from openai import OpenAI

    client = OpenAI(
        api_key=cfg["api_key"],
        base_url=cfg["base_url"].rstrip("/"),
        timeout=600.0,
        max_retries=0,
        http_client=httpx.Client(trust_env=False, timeout=600.0),
    )
    api_prompt = append_aspect_instruction(prompt, aspect_ratio)

    common = {
        "model": cfg["model"],
        "prompt": api_prompt,
        "n": 1,
        "size": image_size,
        "response_format": "b64_json",
        "extra_body": {
            "image_size": image_size,
            **({"aspect_ratio": aspect_ratio} if aspect_ratio else {}),
        },
    }

    if image_paths:
        images = [
            (f"reference_{index}.png", compress_image(path), "image/png")
            for index, path in enumerate(image_paths, start=1)
        ]
        resp = client.images.edit(image=images, **common)
    else:
        resp = client.images.generate(**common)

    return openai_image_bytes(resp)


def generate_vertex(
    cfg: dict,
    prompt: str,
    image_paths: list[str],
    image_size: str,
    aspect_ratio: str | None,
) -> bytes:
    client = genai.Client(
        api_key=cfg["api_key"],
        vertexai=True,
        http_options=types.HttpOptions(
            api_version="v1",
            base_url=cfg.get("base_url", "https://zenmux.ai/api/vertex-ai"),
        ),
    )

    edit_config = types.EditImageConfig(
        output_mime_type="image/png",
        http_options=types.HttpOptions(
            extra_body={"imageSize": image_size},
        ),
    )

    api_prompt = append_aspect_instruction(prompt, aspect_ratio)

    if image_paths:
        refs = []
        for index, path in enumerate(image_paths, start=1):
            refs.append(
                types.RawReferenceImage(
                    reference_id=index,
                    reference_image=types.Image(
                        image_bytes=compress_image(path),
                        mime_type="image/png",
                    ),
                )
            )

        resp = client.models.edit_image(
            model=cfg["model"],
            prompt=api_prompt,
            reference_images=refs,
            config=edit_config,
        )
    else:
        gen_config = types.GenerateImagesConfig(
            number_of_images=1,
            output_mime_type="image/png",
            http_options=types.HttpOptions(
                extra_body={"imageSize": image_size},
            ),
        )
        resp = client.models.generate_images(
            model=cfg["model"],
            prompt=api_prompt,
            config=gen_config,
        )

    generated = getattr(resp, "generated_images", None)
    if not generated:
        raise ValueError("no generated_images in Vertex response")

    img_obj = generated[0].image
    if hasattr(img_obj, "image_bytes") and img_obj.image_bytes:
        return img_obj.image_bytes
    if hasattr(img_obj, "save"):
        buf = io.BytesIO()
        img_obj.save(buf)
        return buf.getvalue()
    raise ValueError("empty image data in Vertex response")


def main() -> None:
    if len(sys.argv) < 3:
        print(
            "usage: gpt-image-gen.py <output_path> <prompt> [--aspect <ratio>] [images...]",
            file=sys.stderr,
        )
        sys.exit(1)

    output_path = sys.argv[1]
    prompt = sys.argv[2]

    # 解析可选的 --aspect 参数
    aspect_ratio: str | None = None
    rest = sys.argv[3:]
    if len(rest) >= 2 and rest[0] == "--aspect":
        aspect_ratio = rest[1]
        image_paths = rest[2:]
    else:
        image_paths = rest

    image_size = ASPECT_TO_SIZE.get(aspect_ratio or "", DEFAULT_SIZE) if aspect_ratio else DEFAULT_SIZE

    cfg_path = Path.home() / ".story-claw" / "image_gen_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

    base_url = cfg.get("base_url", "https://zenmux.ai/api/vertex-ai")
    api_format = cfg.get("api_format")
    if not api_format:
        api_format = "vertex" if "vertex-ai" in base_url else "openai"

    try:
        if api_format == "openai":
            img_bytes = generate_openai_compatible(
                cfg, prompt, image_paths, image_size, aspect_ratio
            )
        elif api_format == "vertex":
            img_bytes = generate_vertex(
                cfg, prompt, image_paths, image_size, aspect_ratio
            )
        else:
            raise ValueError(f"unsupported image api_format: {api_format}")
    except Exception as exc:
        print(f"image API request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        validate_generated_image(img_bytes)
    except ValueError as exc:
        Path(output_path).unlink(missing_ok=True)
        print(f"image quality check failed: {exc}", file=sys.stderr)
        sys.exit(1)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_bytes(img_bytes)
    print(f"saved: {output_path}")


if __name__ == "__main__":
    main()
