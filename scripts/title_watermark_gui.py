"""
title_watermark_gui.py — 视频标题水印工具

给定视频文件夹 + 标题文字 + 原文 txt，生成标题图（参考原文风格）、
抠除背景后贴到该文件夹下所有视频的左上角（直接覆盖原视频）。

用法：
  python scripts/title_watermark_gui.py
"""
import concurrent.futures
import io
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

# 禁用系统代理（避免 requests 经代理时 TLS 握手失败，与 utils/gpt-image-gen.py 一致）
os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

import numpy as np
import requests
from google import genai
from google.genai import types
from PIL import Image, ImageFilter, ImageTk

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_DIR = Path.home() / ".story-claw"
TEXT_LLM_CONFIG = CONFIG_DIR / "config.json"
IMAGE_GEN_CONFIG = CONFIG_DIR / "image_gen_config.json"

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm", ".m4v", ".ts"}

# 都走同一个 ZenMux 中转站，直接换 model id 即可，不用调用单独的 utils/gpt-image-gen.py
IMAGE_GEN_MODEL = "openai/gpt-image-2"
IMAGE_GEN_TIMEOUT_MS = 180_000
MAX_IMAGE_GEN_RETRIES = 3
BG_QUANTIZE_STEP = 8
CUTOUT_T1 = 30
CUTOUT_T2 = 70
CROP_ALPHA_THRESHOLD = 150
CROP_PADDING = 8
OVERLAY_WIDTH_RATIO = 0.32
MARGIN_RATIO = 0.03
PREVIEW_MAX_SIZE = 360
OVERLAY_CONCURRENCY = min(4, os.cpu_count() or 4)
DESIGN_MODEL = "google/gemini-3.5-flash"
DESIGN_LLM_TIMEOUT = 120
DESIGN_LLM_RETRIES = 2

# ID 水印（防盗用，定时跳位到画面四角+居中，循环播放）
ID_WATERMARK_SLOT_SECONDS = 10
ID_FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
]

# 右下角固定小字（不透明，每个视频都会加）
CREDIT_TEXT = "所有内容由story-claw一键生成。"
CREDIT_FONT_RATIO = 0.03
CREDIT_MARGIN_RATIO = 0.02

DEFAULT_SPEED = 1.1
SPEED_MIN = 0.5
SPEED_MAX = 3.0
SPEED_STEP = 0.1

DESIGN_PROMPT_TEMPLATE = (
    "以下是一篇小说原文全文。请根据其题材和氛围，为短剧标题卡设计一套具体的文字视觉方案，"
    "用一段中文描述（不超过100字）说明：字体风格（如手写体/黑体/衬线体/书法体等）、"
    "文字颜色（必须与背景色不同，不能选跟背景相近或相同的颜色）、"
    "文字边缘或描边效果（如是否有描边、光晕、破损、金属质感、阴影等）、"
    "整体氛围基调。只输出这段描述本身，不要解释、不要分点、不要输出与设计无关的内容：\n\n{content}"
)

IMAGE_PROMPT_TEMPLATE = (
    "电影感短剧标题卡设计。{design_clause}"
    "纯色背景（整张画布背景为单一纯色，无渐变、无纹理、无阴影、无装饰图案），"
    "画面正中是标题文字：\"{title}\"，文字颜色必须与背景颜色不同，"
    "不允许文字颜色与背景颜色相近或相同，"
    "除标题文字外画面中不得出现任何其他文字、图案、logo、水印、边框或装饰元素，横版构图"
)


def read_txt_content(path: str) -> str:
    raw = Path(path).read_bytes()
    text = None
    for enc in ("utf-8", "gbk"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode("utf-8", errors="ignore")
    return text.strip()


def read_text_llm_config() -> dict:
    cfg = json.loads(TEXT_LLM_CONFIG.read_text(encoding="utf-8"))
    if not cfg.get("model") or not cfg.get("api_key"):
        raise ValueError("config.json 缺少 model 或 api_key")
    return cfg


def infer_title_design(txt_path: str, log) -> str:
    content = read_txt_content(txt_path)
    if not content:
        log("原文内容为空，跳过风格推测")
        return ""

    for attempt in range(1, DESIGN_LLM_RETRIES + 1):
        try:
            cfg = read_text_llm_config()
            base_url = (cfg.get("base_url") or "https://api.openai.com/v1").rstrip("/")
            resp = requests.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {cfg['api_key']}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": DESIGN_MODEL,
                    "messages": [{"role": "user", "content": DESIGN_PROMPT_TEMPLATE.format(content=content)}],
                },
                timeout=DESIGN_LLM_TIMEOUT,
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()
        except Exception as e:
            log(f"[{attempt}/{DESIGN_LLM_RETRIES}] 风格推测失败：{e}")

    log("风格推测重试后仍失败，将不使用风格提示继续")
    return ""


def build_image_prompt(title: str, design: str) -> str:
    design_clause = f"文字设计要求：{design} " if design else ""
    return IMAGE_PROMPT_TEMPLATE.format(title=title, design_clause=design_clause)


def generate_raw_image(prompt: str, output_path: str, log) -> bool:
    cfg = json.loads(IMAGE_GEN_CONFIG.read_text(encoding="utf-8"))

    for attempt in range(1, MAX_IMAGE_GEN_RETRIES + 1):
        try:
            client = genai.Client(
                api_key=cfg["api_key"],
                vertexai=True,
                http_options=types.HttpOptions(
                    api_version="v1",
                    base_url="https://zenmux.ai/api/vertex-ai",
                    timeout=IMAGE_GEN_TIMEOUT_MS,
                ),
            )
            resp = client.models.generate_images(
                model=IMAGE_GEN_MODEL,
                prompt=prompt,
                config=types.GenerateImagesConfig(
                    number_of_images=1,
                    output_mime_type="image/png",
                    http_options=types.HttpOptions(
                        extra_body={"imageSize": "1536x1024"},
                        timeout=IMAGE_GEN_TIMEOUT_MS,
                    ),
                ),
            )
            generated = getattr(resp, "generated_images", None)
            if not generated:
                raise RuntimeError("响应中没有 generated_images")

            img_obj = generated[0].image
            img_bytes = None
            if hasattr(img_obj, "image_bytes") and img_obj.image_bytes:
                img_bytes = img_obj.image_bytes
            elif hasattr(img_obj, "save"):
                buf = io.BytesIO()
                img_obj.save(buf)
                img_bytes = buf.getvalue()
            if not img_bytes:
                raise RuntimeError("响应中图片数据为空")

            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(img_bytes)
            log(f"[{IMAGE_GEN_MODEL}] 生成成功")
            return True
        except Exception as e:
            log(f"[{attempt}/{MAX_IMAGE_GEN_RETRIES}] 生图失败: {e}")
            if attempt < MAX_IMAGE_GEN_RETRIES:
                time.sleep(2)
    return False


def cutout_dominant_color(raw_path: str, cutout_path: str, log) -> Image.Image:
    img = Image.open(raw_path).convert("RGB")
    arr = np.array(img).astype(np.int32)

    quant = (arr // BG_QUANTIZE_STEP) * BG_QUANTIZE_STEP
    codes = (quant[..., 0] << 16) | (quant[..., 1] << 8) | quant[..., 2]
    vals, counts = np.unique(codes.reshape(-1), return_counts=True)
    bg_code = int(vals[np.argmax(counts)])
    bg_color = np.array(
        [(bg_code >> 16) & 0xFF, (bg_code >> 8) & 0xFF, bg_code & 0xFF], dtype=np.float64
    )

    dist = np.sqrt(np.sum((arr.astype(np.float64) - bg_color) ** 2, axis=2))
    alpha = np.zeros(dist.shape, dtype=np.float64)
    alpha[dist >= CUTOUT_T2] = 255.0
    ramp = (dist > CUTOUT_T1) & (dist < CUTOUT_T2)
    alpha[ramp] = (dist[ramp] - CUTOUT_T1) / (CUTOUT_T2 - CUTOUT_T1) * 255.0

    alpha_img = Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8), mode="L")
    alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(radius=1))

    rgba = img.convert("RGBA")
    rgba.putalpha(alpha_img)

    # 裁剪范围只看明显不透明的像素，避免背景渐变/噪点产生的零星低alpha像素把裁剪框撑到全图
    ys, xs = np.where(np.array(alpha_img) > CROP_ALPHA_THRESHOLD)
    if len(xs) == 0 or len(ys) == 0:
        log("警告：抠图后未检测到前景内容（生成图片可能不是纯色背景），使用整张图")
        cropped = rgba
    else:
        x0 = max(0, int(xs.min()) - CROP_PADDING)
        x1 = min(rgba.width, int(xs.max()) + CROP_PADDING + 1)
        y0 = max(0, int(ys.min()) - CROP_PADDING)
        y1 = min(rgba.height, int(ys.max()) + CROP_PADDING + 1)
        cropped = rgba.crop((x0, y0, x1, y1))

    cropped.save(cutout_path)
    return cropped


def scan_videos(folder: str) -> list:
    videos = []
    for entry in os.scandir(folder):
        if entry.is_file() and os.path.splitext(entry.name)[1].lower() in VIDEO_EXTS:
            videos.append(Path(entry.path))
    videos.sort()
    return videos


def summarize_ffmpeg_error(stderr: str) -> str:
    """ffmpeg 失败时日志很长，libx264/aac 的收尾统计行会挤掉真正的报错原因，
    优先摘取含 error/failed/no space 等关键字的行，找不到再退回看原始尾部。"""
    lines = stderr.strip().splitlines()
    hits = [l for l in lines if re.search(r"error|failed|no space|permission denied", l, re.IGNORECASE)]
    if hits:
        return "\n".join(hits[-10:])
    return stderr.strip()[-1500:]


def get_video_dimensions(video_path: str) -> tuple:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x",
            video_path,
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {summarize_ffmpeg_error(result.stderr)}")
    w_str, h_str = result.stdout.strip().split("x")
    return int(w_str), int(h_str)


_cjk_font_path = None


def find_cjk_font() -> str:
    global _cjk_font_path
    if _cjk_font_path is None:
        for candidate in ID_FONT_CANDIDATES:
            if os.path.isfile(candidate):
                _cjk_font_path = candidate
                break
        else:
            raise RuntimeError("未找到可用的中文字体文件（msyh/simhei/simsun），无法添加ID水印文字")
    return _cjk_font_path


def escape_ffmpeg_path(path: str) -> str:
    return path.replace("\\", "/").replace(":", "\\:")


def escape_drawtext(text: str) -> str:
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def build_id_drawtext_chain(
    id_text: str,
    w: int,
    h: int,
    in_label: str,
    out_label: str,
    title_bottom_y: int = None,
    bottom_right_reserve: int = 0,
) -> str:
    """生成"定时跳位"ID水印的 drawtext 滤镜链：每隔 ID_WATERMARK_SLOT_SECONDS 秒
    循环跳到四角+居中五个位置之一，只在自己的时间窗口内 enable，其余时间原样透传。
    若 title_bottom_y 给定（标题图占了左上角），左上角这个位置改放到标题图下方，避免遮挡。
    bottom_right_reserve 用于把右下角这个位置往上抬，给固定的右下角小字留出空间。"""
    font_path = escape_ffmpeg_path(find_cjk_font())
    text_escaped = escape_drawtext(id_text)
    margin = max(10, round(w * 0.03))
    fontsize = max(14, round(w * 0.035))

    top_left_y = f"{title_bottom_y + margin}" if title_bottom_y is not None else f"{margin}"
    positions = [
        (f"{margin}", top_left_y),
        (f"w-text_w-{margin}", f"{margin}"),
        (f"{margin}", f"h-text_h-{margin}"),
        (f"w-text_w-{margin}", f"h-text_h-{margin}-{bottom_right_reserve}"),
        ("(w-text_w)/2", "(h-text_h)/2"),
    ]
    n = len(positions)
    cycle = ID_WATERMARK_SLOT_SECONDS * n

    parts = []
    cur_in = in_label
    for i, (x_expr, y_expr) in enumerate(positions):
        seg_out = out_label if i == n - 1 else f"idwm{i}"
        slot_start = i * ID_WATERMARK_SLOT_SECONDS
        slot_end = (i + 1) * ID_WATERMARK_SLOT_SECONDS
        enable_expr = f"between(mod(t\\,{cycle})\\,{slot_start}\\,{slot_end})"
        parts.append(
            f"[{cur_in}]drawtext=fontfile='{font_path}':text='{text_escaped}':"
            f"fontsize={fontsize}:fontcolor=white@0.55:"
            f"x={x_expr}:y={y_expr}:enable='{enable_expr}'[{seg_out}]"
        )
        cur_in = seg_out
    return ";".join(parts)


def credit_reserve_height(w: int) -> int:
    """右下角固定小字大致占用的高度（含上下留白），供 ID 水印避让使用。"""
    margin = max(6, round(w * CREDIT_MARGIN_RATIO))
    fontsize = max(10, round(w * CREDIT_FONT_RATIO))
    return fontsize + margin * 2


def build_credit_drawtext(w: int, h: int, in_label: str, out_label: str) -> str:
    """右下角固定不透明小字（每个视频都会加，不受 ID 水印开关影响）。"""
    font_path = escape_ffmpeg_path(find_cjk_font())
    text_escaped = escape_drawtext(CREDIT_TEXT)
    margin = max(6, round(w * CREDIT_MARGIN_RATIO))
    fontsize = max(10, round(w * CREDIT_FONT_RATIO))

    return (
        f"[{in_label}]drawtext=fontfile='{font_path}':text='{text_escaped}':"
        f"fontsize={fontsize}:fontcolor=white:borderw=2:bordercolor=black:"
        f"x=w-text_w-{margin}:y=h-text_h-{margin}[{out_label}]"
    )


def get_or_create_overlay_png(
    cutout_img: Image.Image, target_w: int, overlay_cache: dict, cache_lock: threading.Lock, tmp_dir: str
) -> tuple:
    cached = overlay_cache.get(target_w)
    if cached is not None:
        return cached
    with cache_lock:
        cached = overlay_cache.get(target_w)
        if cached is None:
            ratio = target_w / cutout_img.width
            target_h = max(1, round(cutout_img.height * ratio))
            resized = cutout_img.resize((target_w, target_h), Image.LANCZOS)
            overlay_path = os.path.join(tmp_dir, f"overlay_{target_w}.png")
            resized.save(overlay_path)
            cached = (overlay_path, target_h)
            overlay_cache[target_w] = cached
    return cached


def build_atempo_chain(speed: float) -> str:
    """atempo 单级只支持 0.5~2.0，超出范围时拆成多级串联。"""
    factors = []
    s = speed
    while s > 2.0:
        factors.append(2.0)
        s /= 2.0
    while s < 0.5:
        factors.append(0.5)
        s /= 0.5
    factors.append(s)
    return ",".join(f"atempo={f:.6f}" for f in factors)


def overlay_on_video(
    video_path: Path,
    cutout_img: Image.Image,
    id_text: str,
    speed: float,
    overlay_cache: dict,
    tmp_dir: str,
    cache_lock: threading.Lock,
) -> None:
    w, h = get_video_dimensions(str(video_path))
    inputs = ["-i", str(video_path)]
    filter_parts = []
    cur_label = "0:v"
    title_bottom_y = None

    if cutout_img is not None:
        target_w = max(1, round(w * OVERLAY_WIDTH_RATIO))
        overlay_path, target_h = get_or_create_overlay_png(cutout_img, target_w, overlay_cache, cache_lock, tmp_dir)
        inputs += ["-loop", "1", "-i", overlay_path]
        margin_x = round(w * MARGIN_RATIO)
        margin_y = round(h * MARGIN_RATIO)
        title_bottom_y = margin_y + target_h
        out_label = "titled"
        filter_parts.append(f"[0:v][1:v]overlay=x={margin_x}:y={margin_y}:shortest=1[{out_label}]")
        cur_label = out_label

    if id_text:
        filter_parts.append(
            build_id_drawtext_chain(id_text, w, h, cur_label, "idwm", title_bottom_y, credit_reserve_height(w))
        )
        cur_label = "idwm"

    filter_parts.append(build_credit_drawtext(w, h, cur_label, "out"))
    cur_label = "out"

    if speed != 1.0:
        filter_parts.append(f"[{cur_label}]setpts=PTS/{speed:.6f}[sped]")
        cur_label = "sped"

    audio_args = (
        ["-filter:a", build_atempo_chain(speed), "-c:a", "aac", "-b:a", "192k"]
        if speed != 1.0
        else ["-c:a", "copy"]
    )

    tmp_out = str(video_path) + ".tmp_overlay.mp4"
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            *inputs,
            "-filter_complex", ";".join(filter_parts),
            "-map", f"[{cur_label}]", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "medium", "-crf", "14",
            *audio_args,
            tmp_out,
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
    )
    if result.returncode != 0:
        try:
            os.remove(tmp_out)
        except OSError:
            pass
        raise RuntimeError(summarize_ffmpeg_error(result.stderr))

    os.replace(tmp_out, str(video_path))


class TitleWatermarkApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("视频标题水印工具")
        self.cutout_image = None
        self.preview_photo = None
        self.log_queue = queue.Queue()
        self._build_widgets()
        self.root.after(150, self._poll_queue)

    def _build_widgets(self):
        frm = ttk.Frame(self.root, padding=10)
        frm.grid(row=0, column=0, sticky="nsew")

        ttk.Label(frm, text="视频文件夹:").grid(row=0, column=0, sticky="w", pady=4)
        self.folder_var = tk.StringVar()
        ttk.Entry(frm, textvariable=self.folder_var, width=55).grid(row=0, column=1, padx=4)
        ttk.Button(frm, text="浏览", command=self._browse_folder).grid(row=0, column=2)

        ttk.Label(frm, text="标题文字:").grid(row=1, column=0, sticky="w", pady=4)
        self.title_var = tk.StringVar()
        ttk.Entry(frm, textvariable=self.title_var, width=55).grid(row=1, column=1, padx=4, sticky="w")

        ttk.Label(frm, text="原文txt路径:").grid(row=2, column=0, sticky="w", pady=4)
        self.txt_var = tk.StringVar()
        ttk.Entry(frm, textvariable=self.txt_var, width=55).grid(row=2, column=1, padx=4)
        ttk.Button(frm, text="浏览", command=self._browse_txt).grid(row=2, column=2)

        ttk.Label(frm, text="ID水印文字(可选):").grid(row=3, column=0, sticky="w", pady=4)
        self.id_var = tk.StringVar()
        ttk.Entry(frm, textvariable=self.id_var, width=55).grid(row=3, column=1, padx=4, sticky="w")

        ttk.Label(frm, text="视频倍速:").grid(row=4, column=0, sticky="w", pady=4)
        self.speed_var = tk.StringVar(value=f"{DEFAULT_SPEED:.1f}")
        ttk.Spinbox(
            frm, from_=SPEED_MIN, to=SPEED_MAX, increment=SPEED_STEP,
            textvariable=self.speed_var, width=6, format="%.1f",
        ).grid(row=4, column=1, padx=4, sticky="w")

        self.gen_btn = ttk.Button(frm, text="生成标题图", command=self._on_generate_click)
        self.gen_btn.grid(row=5, column=0, pady=8, sticky="w")

        self.regen_btn = ttk.Button(frm, text="重新生成", command=self._on_generate_click, state="disabled")
        self.regen_btn.grid(row=5, column=1, pady=8, sticky="w")

        self.preview_label = tk.Label(
            frm, text="（预览）", width=50, height=15, relief="groove", bg="#dddddd"
        )
        self.preview_label.grid(row=6, column=0, columnspan=3, pady=4, sticky="w")

        self.apply_btn = ttk.Button(frm, text="应用到所有视频", command=self._on_apply_click)
        self.apply_btn.grid(row=7, column=0, columnspan=3, pady=8, sticky="w")

        ttk.Label(frm, text="日志:").grid(row=8, column=0, sticky="w")
        self.log_text = tk.Text(frm, width=80, height=14, state="disabled")
        self.log_text.grid(row=9, column=0, columnspan=3, pady=4)

    def _browse_folder(self):
        path = filedialog.askdirectory()
        if path:
            self.folder_var.set(path)

    def _browse_txt(self):
        path = filedialog.askopenfilename(filetypes=[("Text files", "*.txt")])
        if path:
            self.txt_var.set(path)

    def _log(self, msg: str):
        self.log_queue.put(msg)

    def _append_log(self, text: str):
        self.log_text.config(state="normal")
        self.log_text.insert("end", text + "\n")
        self.log_text.see("end")
        self.log_text.config(state="disabled")

    def _poll_queue(self):
        while True:
            try:
                msg = self.log_queue.get_nowait()
            except queue.Empty:
                break
            if isinstance(msg, tuple) and msg[0] == "__preview__":
                self._set_preview(msg[1])
            elif isinstance(msg, tuple) and msg[0] == "__done_generate__":
                self.gen_btn.config(state="normal")
                if self.cutout_image is not None:
                    self.regen_btn.config(state="normal")
            elif isinstance(msg, tuple) and msg[0] == "__done_apply__":
                self.apply_btn.config(state="normal")
            else:
                self._append_log(str(msg))
        self.root.after(150, self._poll_queue)

    def _set_preview(self, cutout_path: str):
        img = Image.open(cutout_path).convert("RGBA")
        img.thumbnail((PREVIEW_MAX_SIZE, PREVIEW_MAX_SIZE), Image.LANCZOS)
        bg = Image.new("RGBA", img.size, (221, 221, 221, 255))
        bg.alpha_composite(img)
        self.preview_photo = ImageTk.PhotoImage(bg.convert("RGB"))
        # width/height 在挂了图片之后单位从"字符数"变成"像素"，必须显式设成图片实际像素尺寸，
        # 不能用 0（不同 Tk 版本对 0 的处理不一致，可能导致控件塌缩成几乎看不见）
        self.preview_label.config(image=self.preview_photo, text="", width=bg.width, height=bg.height)

    def _on_generate_click(self):
        folder = self.folder_var.get().strip()
        title = self.title_var.get().strip()
        txt_path = self.txt_var.get().strip()

        if not folder or not os.path.isdir(folder):
            messagebox.showerror("错误", "请先选择有效的视频文件夹")
            return
        if not title:
            messagebox.showerror("错误", "请输入标题文字")
            return
        if txt_path and not os.path.isfile(txt_path):
            messagebox.showerror("错误", "原文txt路径无效")
            return

        self.gen_btn.config(state="disabled")
        self.regen_btn.config(state="disabled")
        self._append_log("=== 开始生成标题图 ===")
        threading.Thread(target=self._generate_worker, args=(folder, title, txt_path), daemon=True).start()

    def _generate_worker(self, folder: str, title: str, txt_path: str):
        try:
            design = ""
            if txt_path:
                self._log(f"读取原文并推测标题设计方案：{txt_path}")
                design = infer_title_design(txt_path, self._log)
                if design:
                    self._log(f"推测设计方案：{design}")

            prompt = build_image_prompt(title, design)
            raw_path = os.path.join(folder, "_title_raw.png")
            cutout_path = os.path.join(folder, "_title_cutout.png")

            self._log("调用生图接口...")
            if not generate_raw_image(prompt, raw_path, self._log):
                self._log("生成失败，已中止")
                return
            self._log(f"原图已保存：{raw_path}")

            self._log("开始抠图...")
            self.cutout_image = cutout_dominant_color(raw_path, cutout_path, self._log)
            self._log(f"抠图完成：{cutout_path}")
            self.log_queue.put(("__preview__", cutout_path))
        except Exception as e:
            self._log(f"生成过程出错：{e}")
        finally:
            self.log_queue.put(("__done_generate__",))

    def _on_apply_click(self):
        folder = self.folder_var.get().strip()
        if not folder or not os.path.isdir(folder):
            messagebox.showerror("错误", "请先选择有效的视频文件夹")
            return

        id_text = self.id_var.get().strip()
        cutout_path = os.path.join(folder, "_title_cutout.png")
        has_title = os.path.isfile(cutout_path)

        try:
            speed = round(float(self.speed_var.get()), 1)
        except ValueError:
            messagebox.showerror("错误", "倍速必须是数字")
            return
        if not (SPEED_MIN <= speed <= SPEED_MAX):
            messagebox.showerror("错误", f"倍速必须在 {SPEED_MIN}~{SPEED_MAX} 之间")
            return

        videos = scan_videos(folder)
        if not videos:
            messagebox.showinfo("提示", "该文件夹下没有找到视频文件")
            return

        parts = []
        if has_title:
            parts.append("标题图")
        if id_text:
            parts.append(f"ID水印「{id_text}」")
        parts.append("右下角固定小字")
        parts.append(f"{speed}倍速")
        if not messagebox.askyesno(
            "确认覆盖",
            f"即将直接覆盖 {len(videos)} 个视频文件（贴上{'+'.join(parts)}），此操作不可撤销，是否继续？",
        ):
            return

        self.apply_btn.config(state="disabled")
        self._append_log(f"=== 开始批量处理 {len(videos)} 个视频 ===")
        threading.Thread(
            target=self._apply_worker,
            args=(videos, cutout_path if has_title else None, id_text, speed),
            daemon=True,
        ).start()

    def _apply_worker(self, videos: list, cutout_path, id_text: str, speed: float):
        tmp_dir = tempfile.mkdtemp(prefix="title_wm_")
        cutout_img = Image.open(cutout_path).convert("RGBA") if cutout_path else None
        overlay_cache = {}
        cache_lock = threading.Lock()
        ok_count = 0
        fail_count = 0
        total = len(videos)
        self._log(f"并发数：{OVERLAY_CONCURRENCY}")
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=OVERLAY_CONCURRENCY) as executor:
                future_to_video = {
                    executor.submit(
                        overlay_on_video, video, cutout_img, id_text, speed, overlay_cache, tmp_dir, cache_lock
                    ): video
                    for video in videos
                }
                for done, future in enumerate(concurrent.futures.as_completed(future_to_video), 1):
                    video = future_to_video[future]
                    try:
                        future.result()
                        self._log(f"[{done}/{total}] 完成: {video.name}")
                        ok_count += 1
                    except Exception as e:
                        self._log(f"[{done}/{total}] 失败: {video.name} — {e}")
                        fail_count += 1
            self._log(f"=== 批量处理完成：成功 {ok_count}，失败 {fail_count} ===")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            self.log_queue.put(("__done_apply__",))


def main():
    root = tk.Tk()
    TitleWatermarkApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
