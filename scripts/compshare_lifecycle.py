"""CompShare instance lifecycle helpers backed by compshare-cli."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any


GPU_CONFIG_PATH = os.path.expanduser("~/.story-claw/gpu_config.json")


def load_gpu_config() -> dict[str, Any]:
    try:
        with open(GPU_CONFIG_PATH, "r", encoding="utf-8") as file:
            value = json.load(file)
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _credentials() -> tuple[str, str]:
    config = load_gpu_config()
    public_key = str(
        os.environ.get("COMPSHARE_PUBLIC_KEY") or config.get("public_key") or ""
    ).strip()
    private_key = str(
        os.environ.get("COMPSHARE_PRIVATE_KEY") or config.get("private_key") or ""
    ).strip()
    return public_key, private_key


def get_instance_id() -> str:
    config = load_gpu_config()
    return str(
        os.environ.get("STORY_CLAW_GPU_INSTANCE")
        or config.get("instance_id")
        or ""
    ).strip()


def _timeout(name: str, default: int) -> int:
    try:
        return max(1, int(load_gpu_config().get(name, default)))
    except (TypeError, ValueError):
        return default


def credentials_configured() -> bool:
    public_key, private_key = _credentials()
    return bool(public_key and private_key)


def configuration_error() -> str:
    public_key, private_key = _credentials()
    missing = []
    if not public_key:
        missing.append("public_key")
    if not private_key:
        missing.append("private_key")
    if not get_instance_id():
        missing.append("instance_id")
    if not missing:
        return ""
    return f"missing {', '.join(missing)} in {GPU_CONFIG_PATH}"


def _cli_env() -> dict[str, str]:
    public_key, private_key = _credentials()
    env = os.environ.copy()
    if public_key:
        env["COMPSHARE_PUBLIC_KEY"] = public_key
    if private_key:
        env["COMPSHARE_PRIVATE_KEY"] = private_key
    return env


def _cli_path() -> str:
    found = shutil.which("compshare")
    if found:
        return found

    appdata = os.environ.get("APPDATA", "")
    candidates = [
        os.path.join(appdata, "Python", "Python310", "Scripts", "compshare.exe"),
        os.path.join(appdata, "Python", "Python311", "Scripts", "compshare.exe"),
        os.path.join(appdata, "Python", "Python312", "Scripts", "compshare.exe"),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError("compshare executable was not found")


def _run_cli(args: list[str], timeout: int) -> dict[str, Any]:
    command = [_cli_path(), "--json", *args]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=_cli_env(),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": {"code": "LOCAL_TIMEOUT", "message": f"timed out after {timeout}s"},
        }
    except Exception as exc:
        return {"ok": False, "error": {"code": "LOCAL_ERROR", "message": str(exc)}}

    raw = (completed.stdout or completed.stderr or "").strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {
            "ok": False,
            "error": {
                "code": "INVALID_JSON",
                "message": raw[-500:] if raw else f"CLI exited with code {completed.returncode}",
            },
        }
    if completed.returncode != 0 and payload.get("ok") is not True:
        payload.setdefault("error", {}).setdefault(
            "message", f"CLI exited with code {completed.returncode}"
        )
    return payload


def _find_state(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("state", "State", "status", "Status", "UHostState", "InstanceState"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                return candidate
        for nested in value.values():
            state = _find_state(nested)
            if state:
                return state
    elif isinstance(value, list):
        for nested in value:
            state = _find_state(nested)
            if state:
                return state
    return ""


def _message(payload: dict[str, Any]) -> str:
    if payload.get("ok") is True:
        return "operation accepted"
    error = payload.get("error")
    if isinstance(error, dict):
        code = str(error.get("code") or "CLI_ERROR")
        message = str(error.get("message") or "unknown error")
        return f"{code}: {message}"
    return "unknown CLI error"


def inspect_instance() -> tuple[str, dict[str, Any]]:
    instance_id = get_instance_id()
    if not instance_id:
        result = {
            "ok": False,
            "error": {"code": "MISSING_INSTANCE_ID", "message": configuration_error()},
        }
        return "", result
    result = _run_cli(["instance", "show", instance_id, "--status"], timeout=60)
    return _find_state(result), result


def start_instance() -> tuple[bool, str]:
    config_error = configuration_error()
    if config_error:
        return False, config_error
    instance_id = get_instance_id()
    state, inspection = inspect_instance()
    if state.lower() == "running":
        return True, "instance is already Running"
    if inspection.get("ok") is not True:
        return False, f"state inspection failed: {_message(inspection)}"

    timeout = _timeout("start_timeout", 180)
    result = _run_cli(
        ["instance", "start", instance_id, "--timeout", str(timeout)],
        timeout=timeout + 30,
    )
    state_after, _ = inspect_instance()
    if result.get("ok") is True or state_after.lower() == "running":
        return True, f"instance state: {state_after or 'start accepted'}"
    return False, f"{_message(result)}; current state: {state_after or 'unknown'}"


def stop_instance() -> tuple[bool, str]:
    config_error = configuration_error()
    if config_error:
        return False, config_error
    instance_id = get_instance_id()
    state, inspection = inspect_instance()
    if state.lower() == "stopped":
        return True, "instance is already Stopped"
    if inspection.get("ok") is not True:
        return False, f"state inspection failed: {_message(inspection)}"

    timeout = _timeout("stop_timeout", 600)
    result = _run_cli(
        ["instance", "stop", instance_id, "--yes", "--timeout", str(timeout)],
        timeout=timeout + 30,
    )
    state_after, _ = inspect_instance()
    if result.get("ok") is True or state_after.lower() == "stopped":
        return True, f"instance state: {state_after or 'stop accepted'}"
    return False, f"{_message(result)}; current state: {state_after or 'unknown'}"
