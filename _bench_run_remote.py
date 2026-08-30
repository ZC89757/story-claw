import json, time, urllib.request, sys

BASE = "http://127.0.0.1:8191"
WF_PATH = "/root/_bench_workflow.json"
MAX_ATTEMPTS = 8  # 覆盖默认 Gate1/2 重试阈值（一般 5），保证最终 accept_anyway 放行


def get(path, timeout=15):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=timeout) as r:
        return json.loads(r.read())


def post(path, payload, timeout=30):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def history_record(prompt_id):
    req = urllib.request.Request(f"{BASE}/history.jsonl")
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read().decode("utf-8", errors="replace")
    last = None
    for line in raw.strip().splitlines():
        rec = json.loads(line)
        if rec.get("prompt_id") == prompt_id:
            last = rec
    return last


def main():
    print("HEALTH_BEFORE", get("/health"), flush=True)
    wf = json.load(open(WF_PATH, encoding="utf-8"))

    t_start_all = time.time()
    attempts = []

    for attempt in range(1, MAX_ATTEMPTS + 1):
        t_submit = time.time()
        resp = post("/prompt", {"prompt": wf, "client_id": "bench"})
        prompt_id = resp["prompt_id"]
        print(f"ATTEMPT {attempt} SUBMITTED {prompt_id} at {t_submit}", flush=True)

        while True:
            time.sleep(5)
            hist = get(f"/history/{prompt_id}")
            entry = hist.get(prompt_id)
            if not entry:
                continue
            status = entry.get("status", {}).get("status_str", "")
            elapsed = time.time() - t_submit
            print(f"ATTEMPT {attempt} POLL status={status} elapsed={elapsed:.1f}s", flush=True)
            if status in ("success", "error"):
                break

        t_done = time.time()
        rec = history_record(prompt_id)
        attempts.append({
            "attempt": attempt,
            "prompt_id": prompt_id,
            "wall_s": round(t_done - t_submit, 1),
            "status": status,
            "record": rec,
        })

        if status == "success":
            print(f"ATTEMPT {attempt} SUCCESS record={json.dumps(rec, ensure_ascii=False)}", flush=True)
            break
        else:
            err_msg = (rec or {}).get("error", "")
            print(f"ATTEMPT {attempt} ERROR: {err_msg[:300]}", flush=True)

    t_total = time.time() - t_start_all
    print(f"TOTAL_WALL {t_total:.1f}s over {len(attempts)} attempt(s)", flush=True)
    print("SUMMARY_JSON " + json.dumps({
        "total_wall_s": round(t_total, 1),
        "n_attempts": len(attempts),
        "final_status": attempts[-1]["status"] if attempts else None,
        "attempts": attempts,
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
