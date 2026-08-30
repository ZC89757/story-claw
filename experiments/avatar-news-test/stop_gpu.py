"""Stop the configured GPU and verify that billing compute has stopped."""

from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from compshare_lifecycle import (  # noqa: E402
    configuration_error,
    get_instance_id,
    inspect_instance,
    stop_instance,
)


def main() -> int:
    error = configuration_error()
    if error:
        print(f"GPU configuration error: {error}", file=sys.stderr)
        return 1

    success, message = stop_instance()
    state, _ = inspect_instance()
    print(f"instance={get_instance_id()} {message}; verified_state={state or 'unknown'}")
    return 0 if success and state.lower() == "stopped" else 1


if __name__ == "__main__":
    raise SystemExit(main())

