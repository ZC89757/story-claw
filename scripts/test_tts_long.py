"""测试豆包 TTS 处理长文本（1600+ 字符）并返回字级时间轴"""
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

if len(sys.argv) < 2:
    print("用法: python test_tts_long.py <文本文件路径>")
    sys.exit(1)

TEXT = open(sys.argv[1], "r", encoding="utf-8").read().strip()

payload = {
    "user": {"uid": "story-claw"},
    "req_params": {
        "text": TEXT,
        "speaker": NARRATOR,
        "audio_params": {
            "format": "mp3",
            "sample_rate": 24000,
            "enable_timestamp": True,
        },
        "additions": json.dumps({"disable_markdown_filter": True}),
    },
}
headers = {"X-Api-Key": API_KEY, "X-Api-Resource-Id": RESOURCE, "Content-Type": "application/json"}

print("=" * 80)
print(f"文本长度: {len(TEXT)} 字符")
print(f"音色: {NARRATOR}  资源: {RESOURCE}")
print("=" * 80)

resp = requests.post(BASE_URL, headers=headers, json=payload, timeout=120,
                     proxies={"http": None, "https": None}, stream=True)
print(f"HTTP {resp.status_code}")
if resp.status_code != 200:
    print(resp.text[:500]); raise SystemExit(1)

all_words = []
audio_chunks = 0
total_bytes = 0

for line in resp.iter_lines():
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("data") and isinstance(d["data"], str):
        audio_chunks += 1
        total_bytes += len(d["data"])
    sent = d.get("sentence")
    if sent and sent.get("words"):
        all_words.extend(sent["words"])

print(f"音频分片: {audio_chunks}")
print(f"音频数据: {total_bytes / 1024:.1f} KB")
print(f"时间戳 word 数: {len(all_words)}")

if all_words:
    duration = all_words[-1].get("endTime", 0)
    print(f"总时长: {duration:.2f} 秒")
    print("-" * 80)
    print("前 10 个字的时间戳:")
    for w in all_words[:10]:
        st = w.get("startTime"); et = w.get("endTime")
        print(f"  {str(w.get('word')):8s}  start={st:<7.3f} end={et:<7.3f}")
    print("...")
    print("后 10 个字的时间戳:")
    for w in all_words[-10:]:
        st = w.get("startTime"); et = w.get("endTime")
        print(f"  {str(w.get('word')):8s}  start={st:<7.3f} end={et:<7.3f}")
    print("-" * 80)
    print("✅ 豆包 TTS 成功返回字级时间轴")
    
    # 保存完整时间轴
    output = "nvidia_intro_timeline.json"
    with open(output, "w", encoding="utf-8") as f:
        json.dump({"words": all_words, "duration": duration}, f, ensure_ascii=False, indent=2)
    print(f"✅ 已保存到 {output}")
else:
    print("❌ 未拿到时间戳")
