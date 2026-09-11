#!/usr/bin/env bash
# Restarts the wallpaper/kiosk app using whatever code currently exists in
# this project folder. Kills any already-running instance first, so this
# is safe to trigger any time — including right after a `git pull` — and
# always picks up your latest code, visuals, and animations rather than
# leaving a stale instance running alongside a new one.
#
# This is what the double-clickable launcher (see install-desktop-launcher.sh)
# runs. You can also run it directly from a terminal.
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pkill -f xwinwrap 2>/dev/null
pkill -f electron 2>/dev/null
sleep 1

exec bash "$PROJECT_DIR/linux/xwinwrap-launch.sh"
