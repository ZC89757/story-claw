#!/usr/bin/env bash
# Install H3 only. Existing manually managed ComfyUI processes are not killed.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install -d /root/story-claw
install -m 755 "$script_dir/start-h3-service.sh" /root/story-claw/start-h3-service.sh
# Keep recoverable copies; supervisor only loads the remaining *.conf files.
stamp="$(date +%Y%m%d-%H%M%S)"
if test -f /etc/supervisor/conf.d/story-claw-services.conf; then
  cp -p /etc/supervisor/conf.d/story-claw-services.conf "/etc/supervisor/conf.d/story-claw-services.conf.before-h3-$stamp"
fi
if test -f /etc/supervisor/conf.d/pipeline_wrapper.conf; then
  mv /etc/supervisor/conf.d/pipeline_wrapper.conf "/etc/supervisor/conf.d/pipeline_wrapper.conf.disabled-h3-$stamp"
fi
install -m 644 "$script_dir/../systemd/story-claw-services.conf" /etc/supervisor/conf.d/story-claw-services.conf
supervisorctl reread
supervisorctl update
supervisorctl status story-claw-h3
