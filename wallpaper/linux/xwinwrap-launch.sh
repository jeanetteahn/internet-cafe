#!/usr/bin/env bash
# Fallback launcher for window managers that ignore Electron's native
# `type: 'desktop'` hint (main.js tries that first). xwinwrap creates a
# placeholder window pinned to the desktop layer and reparents an
# arbitrary app's window into it — the same trick most existing "live
# wallpaper on Linux" tools (mpv-based ones especially) use.
#
# xwinwrap isn't packaged in every distro's repos. On Debian/Ubuntu-based
# systems (Mint included) it's usually unavailable via apt and needs
# building from source:
#   sudo apt install build-essential libx11-dev libxext-dev libxrender-dev
#   git clone https://github.com/ujjwal96/xwinwrap
#   cd xwinwrap && make && sudo make install
# (search your distro's package manager first — some do carry it)
#
# Also needs `xdotool` for screen-size detection (falls back to a 1920x1080
# guess if it's missing, so install it for correct results):
#   sudo apt install xdotool
#
# This only manipulates X11 windows. Under Wayland it generally only has
# a chance of working through XWayland, and even then depends on how
# tolerant your compositor is of X11 clients requesting background
# placement — it is not guaranteed, unlike on a real X11 session.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Use the project's own local Electron (installed by `npm install` into
# node_modules) rather than assuming a global `electron` command is on
# PATH — a plain `npm install` never puts one there.
#
# Deliberately the real native binary (node_modules/electron/dist/electron),
# NOT node_modules/.bin/electron. That .bin wrapper is a small script
# starting with `#!/usr/bin/env node` — it needs `node` on PATH to even
# start. That's fine in an interactive terminal (opening one sources
# ~/.bashrc, which is what wires up nvm's PATH additions), but this script
# is also meant to be launched from a desktop icon or an XDG autostart
# entry — neither of which sources ~/.bashrc, so `node` isn't found there
# and the wrapper dies immediately with "No such file or directory". The
# real Electron binary below is self-contained and needs nothing on PATH.
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron not found at $ELECTRON_BIN — run 'npm install' in $PROJECT_DIR first." >&2
  exit 1
fi

# Full virtual screen geometry (all monitors combined). Adjust to a
# specific monitor's geometry (from `xrandr`) if you only want the
# wallpaper on one screen.
GEOMETRY=$(xdotool getdisplaygeometry 2>/dev/null || echo "1920 1080")
WIDTH=$(echo "$GEOMETRY" | awk '{print $1}')
HEIGHT=$(echo "$GEOMETRY" | awk '{print $2}')

# NOTE: deliberately no `-fs` here. xwinwrap's own usage text says `-ov`
# (override_redirect, what makes this sit seamlessly in the background) is
# intended for non-fullscreen mode; combining `-ov` with `-fs` triggers a
# BadMatch X error on window creation on at least some X11/compositor
# combinations (confirmed on Cinnamon/Mutter-family setups). The explicit
# `-g` geometry below already covers the full display, so dropping `-fs`
# costs nothing.
exec xwinwrap -ov -s -st -sp -nf -b -un -g "${WIDTH}x${HEIGHT}+0+0" -- \
  "$ELECTRON_BIN" "$PROJECT_DIR"
