import requests
import time
import random
import json
import os
import sys
from datetime import datetime
from compshare_lifecycle import configuration_error, get_instance_id, start_instance

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

for _k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(_k, None)

# ── 节奏配置 ─────────────────────────────────────────────────────
SPRINT_DURATION = 60     # 冲刺期持续 1 分钟
SPRINT_MIN    = 5.0      # 冲刺期请求间隔最短 5 秒
SPRINT_MAX    = 10.0     # 冲刺期请求间隔最长 10 秒

# ─────────────────────────────────────────────────────────────────


def try_start():
    success, message = start_instance()
    return {"RetCode": 0 if success else -1, "Message": message}


def sprint(attempt):
    """冲刺期：持续 SPRINT_DURATION 秒，每隔 5~10s 请求一次，抢到返回 True"""
    end = time.time() + SPRINT_DURATION
    now_str = lambda: datetime.now().strftime("%H:%M:%S")
    print(f"[{now_str()}] ── 冲刺开始（持续 {SPRINT_DURATION}s）──")
    while time.time() < end:
        attempt += 1
        result = try_start()
        ret = result.get("RetCode", -1)
        msg = result.get("Message", json.dumps(result, ensure_ascii=False))
        if ret == 0:
            print(f"[{now_str()}] 第 {attempt} 次 ★ 启动成功！{msg}")
            return True, attempt
        wait = round(random.uniform(SPRINT_MIN, SPRINT_MAX), 1)
        remaining = round(end - time.time(), 0)
        print(f"[{now_str()}] 第 {attempt:>3} 次 · 失败 (RetCode={ret}) {msg}  → {wait}s  剩余冲刺 {remaining:.0f}s")
        time.sleep(wait)
    return False, attempt


# ── ComfyUI 就绪探测 ─────────────────────────────────────────────
# 抢到 GPU 后 ComfyUI 可能还没起来。每 5s 发一个最小图生视频任务，
# 直到 /prompt 返回 prompt_id 即认定就绪（任务照常生成，不下载保存）。
VIDEO_CONFIG_PATH = os.path.expanduser("~/.story-claw/video_config.json")
# 固定测试图：64×64 纯灰 PNG 的 base64（纯 base64，无 data: 前缀），免依赖
TEST_IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PMQ0AAAwDoDqv9UrYvQQckD4XAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHLANtV0Vq+zpWkAAAAAElFTkSuQmCC"


def wait_comfyui_ready():
    with open(VIDEO_CONFIG_PATH, "r", encoding="utf-8") as f:
        vcfg = json.load(f)
    base_url = str(vcfg.get("base_url", "http://127.0.0.1:8188")).rstrip("/")
    with open(vcfg["workflow_path"], "r", encoding="utf-8") as f:
        workflow = json.load(f)

    # 注入测试参数（节点 id 与 runner/render.ts 一致）
    workflow["324"]["inputs"]["base64_data"]       = TEST_IMAGE_B64
    workflow["320:319"]["inputs"]["value"]         = "a quiet test scene"
    workflow["320:312"]["inputs"]["value"]         = 1024
    workflow["320:299"]["inputs"]["value"]         = 1536
    workflow["320:295"]["inputs"]["length"]        = 9   # LTX 最小帧，任务最轻
    workflow["320:305"]["inputs"]["frames_number"] = 9

    now_str = lambda: datetime.now().strftime("%H:%M:%S")
    print(f"[{now_str()}] GPU 实例已启动，渲染服务正在预热；就绪后将自动运行轻量视频自检...")
    attempt = 0

    # 1. 提交测试任务，拿到 prompt_id
    pid = None
    while pid is None:
        attempt += 1
        try:
            resp = requests.post(
                f"{base_url}/prompt",
                json={"prompt": workflow},
                timeout=15,
                proxies={"http": None, "https": None},
            )
            if resp.status_code == 200:
                pid = resp.json().get("prompt_id")
                if pid:
                    print(f"[{now_str()}] 渲染服务已连接，轻量自检任务已入队，正在确认视频生成功能...")
                    break
            print(f"[{now_str()}] 渲染服务暂未就绪（第 {attempt} 次检测，HTTP {resp.status_code}），5s 后自动继续...")
        except Exception as e:
            print(f"[{now_str()}] 渲染服务正在预热（第 {attempt} 次检测），5s 后自动继续...")
        time.sleep(5)

    # 2. 轮询直到测试任务完成（视频真正生成好）
    # 若 pid 连续 60s 不出现在 history，说明 ComfyUI 重启了，重新提交
    MISSING_TIMEOUT = 60  # 秒
    poll = 0
    missing_since = None
    while True:
        time.sleep(5)
        poll += 1
        try:
            r = requests.get(f"{base_url}/history/{pid}", timeout=10,
                             proxies={"http": None, "https": None})
            if r.status_code != 200:
                continue
            entry = r.json().get(pid)
            if not entry:
                if missing_since is None:
                    missing_since = time.time()
                elapsed = time.time() - missing_since
                if elapsed >= MISSING_TIMEOUT:
                    print(f"[{now_str()}] 暂未查询到自检任务，渲染服务可能已重启，正在自动重新提交...")
                    pid = None
                    missing_since = None
                    attempt = 0
                    # 重新进入提交循环
                    while pid is None:
                        attempt += 1
                        try:
                            resp = requests.post(
                                f"{base_url}/prompt",
                                json={"prompt": workflow},
                                timeout=15,
                                proxies={"http": None, "https": None},
                            )
                            if resp.status_code == 200:
                                pid = resp.json().get("prompt_id")
                                if pid:
                                    print(f"[{now_str()}] 渲染服务已恢复，轻量自检任务已重新入队")
                                    break
                            print(f"[{now_str()}] 渲染服务暂未就绪（第 {attempt} 次检测，HTTP {resp.status_code}），5s 后自动继续...")
                        except Exception as e2:
                            print(f"[{now_str()}] 渲染服务正在恢复（第 {attempt} 次检测），5s 后自动继续...")
                        time.sleep(5)
                    poll = 0
                elif int(elapsed) % 30 == 0 and int(elapsed) > 0:
                    print(f"[{now_str()}] 正在等待渲染服务登记自检任务...（已等待 {elapsed:.0f}s）")
                continue
            missing_since = None  # pid 出现了，重置计时
            status = entry.get("status", {}).get("status_str", "")
            if status == "success":
                print(f"[{now_str()}] ★ 轻量视频自检完成，GPU 已就绪（自检耗时 {poll * 5}s）")
                return
            # queued_sttn / sttn = ComfyUI 已完成 i2v，GPU 确认可用，无需等 LaMa
            if status in ("queued_sttn", "sttn"):
                print(f"[{now_str()}] ★ 视频生成服务已通过自检（{status}），GPU 已就绪")
                return
            if status == "error":
                print(f"[{now_str()}] 测试任务失败: {entry.get('status')}，但继续（可能是 IC-LoRA 暂时异常）")
                return
            if poll % 6 == 0:
                print(f"[{now_str()}] 轻量视频自检进行中...（已运行 {poll * 5}s，状态 {status}）")
        except Exception as e:
            print(f"[{now_str()}] 自检状态暂时无法查询，系统将自动继续检测...")


def main():
    config_error = configuration_error()
    if config_error:
        raise RuntimeError(f"CompShare GPU 配置不完整：{config_error}")

    attempt = 0
    round_num = 0
    print(f"[{datetime.now().strftime('%H:%M:%S')}] 启动抢 GPU 脚本")
    print(f"  实例: {get_instance_id()}  启动方式: compshare-cli")
    print(f"  节奏: 连续冲刺 {SPRINT_DURATION}s（间隔 {SPRINT_MIN:.0f}~{SPRINT_MAX:.0f}s）")
    print("─" * 55)

    while True:
        round_num += 1
        # 冲刺
        success, attempt = sprint(attempt)
        if success:
            break

        # 连续冲刺，不休息
        print(f"[{datetime.now().strftime('%H:%M:%S')}] 第 {round_num} 轮结束，立即开始下一轮冲刺\n")

    # 抢到实例后，等待 ComfyUI 就绪（发测试任务，返回 prompt_id 即就绪）
    wait_comfyui_ready()


if __name__ == "__main__":
    main()
