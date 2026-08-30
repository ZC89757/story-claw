"""Forward CompShare CLI commands using Story Claw's configured credentials."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from compshare_lifecycle import _cli_env, _cli_path  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: gpu_cli.py COMMAND [ARGS...]", file=sys.stderr)
        return 2
    command = [_cli_path(), "--json", *sys.argv[1:]]
    return subprocess.run(command, env=_cli_env(), check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
