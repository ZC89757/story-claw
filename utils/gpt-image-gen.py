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
import io
import json
import os
import sys
from pathlib import Path

# 禁用系统代理（避免 httpx 经代理时 TLS 握手失败）
os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

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

    client = genai.Client(
        api_key=cfg["api_key"],
        vertexai=True,
        http_options=types.HttpOptions(
            api_version="v1",
            base_url="https://zenmux.ai/api/vertex-ai",
        ),
    )

    # 读取模型名（config 里已含 :openai 后缀）
    model = cfg["model"]

    edit_config = types.EditImageConfig(
        output_mime_type="image/png",
        http_options=types.HttpOptions(
            extra_body={"imageSize": image_size},
        ),
    )

    if image_paths:
        # 图生图：edit_image
        refs = []
        for i, p in enumerate(image_paths, start=1):
            img_bytes = compress_image(p)
            refs.append(
                types.RawReferenceImage(
                    reference_id=i,
                    reference_image=types.Image(image_bytes=img_bytes, mime_type="image/png"),
                )
            )

        resp = client.models.edit_image(
            model=model,
            prompt=prompt,
            reference_images=refs,
            config=edit_config,
        )
    else:
        # 文生图：generate_images
        gen_config = types.GenerateImagesConfig(
            number_of_images=1,
            output_mime_type="image/png",
            http_options=types.HttpOptions(
                extra_body={"imageSize": image_size},
            ),
        )
        resp = client.models.generate_images(
            model=model,
            prompt=prompt,
            config=gen_config,
        )

    # 取第一张图
    generated = getattr(resp, "generated_images", None)
    if not generated:
        print("no generated_images in response", file=sys.stderr)
        sys.exit(1)

    img_obj = generated[0].image
    img_bytes: bytes | None = None

    # SDK 有两种写法，兼容处理
    if hasattr(img_obj, "image_bytes") and img_obj.image_bytes:
        img_bytes = img_obj.image_bytes
    elif hasattr(img_obj, "save"):
        buf = io.BytesIO()
        img_obj.save(buf)
        img_bytes = buf.getvalue()

    if not img_bytes:
        print("empty image data in response", file=sys.stderr)
        sys.exit(1)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_bytes(img_bytes)
    print(f"saved: {output_path}")


if __name__ == "__main__":
    main()
