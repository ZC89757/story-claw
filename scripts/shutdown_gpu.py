"""Stop the configured CompShare GPU instance through compshare-cli."""

import sys
from datetime import datetime

from compshare_lifecycle import configuration_error, get_instance_id, stop_instance

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


def shutdown_gpu():
    now = lambda: datetime.now().strftime("%H:%M:%S")
    config_error = configuration_error()
    if config_error:
        message = f"CompShare GPU 配置不完整：{config_error}"
        print(f"[{now()}] [FAIL] {message}")
        return {"RetCode": -1, "Message": message}

    instance_id = get_instance_id()
    print(f"[{now()}] 正在通过 compshare-cli 关闭 GPU 实例 {instance_id}...")

    success, message = stop_instance()
    if success:
        print(f"[{now()}] [OK] GPU 实例关闭成功：{message}")
        return {"RetCode": 0, "Message": message}

    print(f"[{now()}] [FAIL] GPU 实例关闭失败：{message}")
    return {"RetCode": -1, "Message": message}


if __name__ == "__main__":
    result = shutdown_gpu()
    raise SystemExit(0 if result["RetCode"] == 0 else 1)
