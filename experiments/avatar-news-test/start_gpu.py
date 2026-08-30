"""Start the configured GPU without running the production ComfyUI probe."""

from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from compshare_lifecycle import (  # noqa: E402
    configuration_error,
    get_instance_id,
    inspect_instance,
    start_instance,
)


def main() -> int:
    error = configuration_error()
    if error:
        print(f"GPU configuration error: {error}", file=sys.stderr)
        return 1

    state, _ = inspect_instance()
    print(f"instance={get_instance_id()} state={state or 'unknown'}")
    if state.lower() == "running":
        return 0

    success, message = start_instance()
    print(message)
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())

