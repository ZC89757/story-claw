"""
gemini-image-gen.py — Gemini 图像生成 helper（供 Node.js 通过 child_process 调用）

用法：
  python gemini-image-gen.py <output_path> <prompt> [--aspect <ratio>] [image1.png image2.png ...]

  --aspect 可选，值如 "9:16" 或 "16:9"，默认不指定（Gemini 自动决定）

退出码：
  0  成功（图片写入 output_path）
  1  失败（错误信息输出到 stderr）
"""
import json, os, sys
from pathlib import Path

# 禁用系统代理（避免 httpx 经代理时 TLS 握手失败）
os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

from google import genai
from google.genai import types

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
        model="google/gemini-3.1-flash-image-preview",
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["TEXT", "IMAGE"],
            image_config=img_config,
        )
    )

    saved = False
    for part in resp.candidates[0].content.parts:
        if part.inline_data is not None:
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(part.inline_data.data)
            saved = True
            break

    if not saved:
        # 只有文字，没有图像
        texts = [p.text for p in resp.candidates[0].content.parts if p.text]
        print(f"no image in response: {' '.join(texts)[:200]}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
