#!/usr/bin/env bash
# Installs a double-clickable launcher — in the Cinnamon menu, and on your
# Desktop if you have one — that (re)starts the wallpaper/kiosk app using
# whatever code currently exists in this project folder.
#
# Safe to click any time, including while the app is already running: it
# kills the existing instance first via relaunch.sh, then starts fresh, so
# clicking it after a `git pull` is how you pick up new code, visuals, or
# animations without touching a terminal.
#
# This is a manual, click-when-you-want-it launcher — separate from
# install-autostart.sh, which makes the app start automatically at login
# with no action from you. You can use either, both, or neither.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DESKTOP_FILE_CONTENT="[Desktop Entry]
Version=1.0
Type=Application
Name=Internet Cafe Wallpaper
Comment=(Re)start the video wallpaper + kiosk browser cluster
Exec=/bin/bash \"$PROJECT_DIR/linux/relaunch.sh\"
Icon=video-x-generic
Terminal=false
Categories=Utility;
"

mkdir -p "$HOME/.local/share/applications"
printf '%s' "$DESKTOP_FILE_CONTENT" > "$HOME/.local/share/applications/internet-cafe-wallpaper.desktop"
chmod +x "$HOME/.local/share/applications/internet-cafe-wallpaper.desktop"
echo "Installed to the app menu: internet-cafe-wallpaper.desktop"

if [ -d "$HOME/Desktop" ]; then
  printf '%s' "$DESKTOP_FILE_CONTENT" > "$HOME/Desktop/internet-cafe-wallpaper.desktop"
  chmod +x "$HOME/Desktop/internet-cafe-wallpaper.desktop"

  # Nemo (like most modern file managers) treats a freshly-placed .desktop
  # file as untrusted until told otherwise, and won't run it on
  # double-click until you do. This marks it trusted automatically where
  # `gio` supports it; if double-clicking still does nothing, right-click
  # the icon once and choose "Allow Launching" — a one-time step.
  gio set "$HOME/Desktop/internet-cafe-wallpaper.desktop" metadata::trusted true 2>/dev/null || true

  echo "Installed a Desktop icon: ~/Desktop/internet-cafe-wallpaper.desktop"
  echo "(If double-clicking it does nothing at first, right-click it once and choose \"Allow Launching\".)"
fi
