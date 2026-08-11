"""
gemini-image-gen.py — Gemini 图像生成 helper（供 Node.js 通过 child_process 调用）

用法：
  python gemini-image-gen.py <output_path> <prompt> [--aspect <ratio>] [image1.png image2.png ...]

  --aspect 可选，值如 "9:16" 或 "16:9"，默认不指定（Gemini 自动决定）

退出码：
  0  成功（图片写入 output_path）
  1  失败（错误信息输出到 stderr）
"""
import io, json, os, sys
from pathlib import Path

# 走本地 Clash HTTP 代理（zenmux.ai 等需代理才能连通）
# 清掉系统残留的 ALL_PROXY=socks5://...（httpx 会优先用且因缺 socksio 崩）
for _k in ["ALL_PROXY", "all_proxy"]:
    os.environ.pop(_k, None)
os.environ["HTTP_PROXY"]  = "http://127.0.0.1:7890"
os.environ["HTTPS_PROXY"] = "http://127.0.0.1:7890"
os.environ["http_proxy"]  = "http://127.0.0.1:7890"
os.environ["https_proxy"] = "http://127.0.0.1:7890"

from google import genai
from google.genai import types
from PIL import Image


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
    """拒绝纯黑、纯白、全透明或近乎单色的空白结果。"""
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


def main():
    if len(sys.argv) < 3:
        print("usage: gemini-image-gen.py <output_path> <prompt> [--aspect <ratio>] [images...]", file=sys.stderr)
        sys.exit(1)

    output_path = sys.argv[1]
    prompt      = sys.argv[2]

    # 解析可选的 --aspect 参数
    aspect_ratio: str | None = None
    rest = sys.argv[3:]
    if len(rest) >= 2 and rest[0] == "--aspect":
        aspect_ratio = rest[1]
        image_paths  = rest[2:]
    else:
        image_paths  = rest

    prompt = append_aspect_instruction(prompt, aspect_ratio)

    cfg_path = Path.home() / ".story-claw" / "image_gen_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

    client = genai.Client(
        api_key=cfg["api_key"],
        vertexai=True,
        http_options=types.HttpOptions(
            api_version="v1",
            base_url="https://zenmux.ai/api/vertex-ai"
        )
    )

    contents = []
    for p in image_paths:
        contents.append(types.Part.from_bytes(
            data=Path(p).read_bytes(),
            mime_type="image/png"
        ))
    contents.append(prompt)

    img_config = types.ImageConfig(aspectRatio=aspect_ratio) if aspect_ratio else None
    resp = client.models.generate_content(
        model="google/gemini-3.1-flash-lite-image",
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["TEXT", "IMAGE"],
            image_config=img_config,
        )
    )

    candidates = getattr(resp, "candidates", None) or []
    content = getattr(candidates[0], "content", None) if candidates else None
    parts = getattr(content, "parts", None) or []

    saved = False
    for part in parts:
        if part.inline_data is not None:
            img_bytes = part.inline_data.data
            try:
                validate_generated_image(img_bytes)
            except ValueError as exc:
                Path(output_path).unlink(missing_ok=True)
                print(f"image quality check failed: {exc}", file=sys.stderr)
                sys.exit(1)
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(img_bytes)
            saved = True
            break

    if not saved:
        # 安全拦截或仅返回文字时，明确报错而不是因空 content 抛 TypeError
        texts = [p.text for p in parts if p.text]
        feedback = getattr(resp, "prompt_feedback", None)
        detail = " ".join(texts)[:200] or str(feedback or "empty candidates/content")
        print(f"no image in response: {detail}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
