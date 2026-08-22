"""
验证 seed-tts-1.0 字级时间戳。
关键:enable_timestamp 必须放在 req_params.audio_params 里(文档 p14,仅TTS1.0支持)。
用法: python scripts/test_tts_timestamp.py
"""

import sys, requests, json, os

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

for _k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(_k, None)

CFG = json.load(open(os.path.expanduser("~/.story-claw/tts_config.json"), "r", encoding="utf-8"))
BASE_URL = CFG["base_url"]
API_KEY  = CFG["api_key"]
RESOURCE = CFG["resource_id"]
NARRATOR = CFG["narrator_voice"]
TEXT     = "他猛地拔出长剑,寒光一闪,周围的人都愣住了。"

payload = {
    "user": {"uid": "story-claw"},
    "req_params": {
        "text": TEXT,
        "speaker": NARRATOR,
        "audio_params": {
            "format": "mp3",
            "sample_rate": 24000,
            "enable_timestamp": True,   # ← 正确位置
        },
        "additions": json.dumps({"disable_markdown_filter": True}),
    },
}
headers = {"X-Api-Key": API_KEY, "X-Api-Resource-Id": RESOURCE, "Content-Type": "application/json"}

print("=" * 64)
print(f"文本: {TEXT}")
print(f"音色: {NARRATOR}  资源: {RESOURCE}")
print("=" * 64)

resp = requests.post(BASE_URL, headers=headers, json=payload, timeout=30,
                     proxies={"http": None, "https": None})
print(f"HTTP {resp.status_code}")
if resp.status_code != 200:
    print(resp.text[:500]); raise SystemExit(1)

all_words = []
audio_chunks = 0
for line in resp.text.split("\n"):
    s = line.strip()
    if not s:
        continue
    try:
        d = json.loads(s)
    except Exception:
        continue
    if d.get("data") and isinstance(d["data"], str):
        audio_chunks += 1
    sent = d.get("sentence")
    if sent and sent.get("words"):
        all_words.extend(sent["words"])

print(f"音频分片: {audio_chunks}")
print(f"时间戳 word 数: {len(all_words)}")
if all_words:
    print("-" * 64)
    for w in all_words:
        st = w.get("startTime"); et = w.get("endTime")
        print(f"  {str(w.get('word')):8s}  start={st:<7} end={et:<7} conf={w.get('confidence')}")
    print("-" * 64)
    print("✅ seed-tts-1.0 返回字级时间戳 (startTime/endTime 单位:秒)")
else:
    print("❌ 仍未拿到 words")
