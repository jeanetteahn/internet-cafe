#!/usr/bin/env bash
# Sourceable helper — do not execute directly.
#
# Functions:
#   spoon_cursor_apply   — save the active Cinnamon cursor theme, switch to spoon
#   spoon_cursor_restore — restore the saved theme and remove the state file
#
# Crash safety: if the state file from a previous session still exists when
# spoon_cursor_apply is called, it reuses the saved theme instead of re-reading
# gsettings (which might now return "spoon", locking the restore to the wrong value).

_CURSOR_STATE_FILE="/tmp/internet-cafe-wallpaper/cursor-theme-state"

spoon_cursor_apply() {
  if [ ! -d "$HOME/.icons/spoon/cursors" ]; then
    echo "[cursor] WARNING: ~/.icons/spoon/cursors not found — skipping cursor switch" >&2
    return 0
  fi
  mkdir -p "$(dirname "$_CURSOR_STATE_FILE")"
  if [ -f "$_CURSOR_STATE_FILE" ]; then
    local saved
    saved="$(cat "$_CURSOR_STATE_FILE" 2>/dev/null || true)"
    if [ -z "$saved" ] || [ "$saved" = "spoon" ]; then
      saved="Adwaita"
      echo "$saved" > "$_CURSOR_STATE_FILE"
    fi
    echo "[cursor] previous-session state file found — previous theme: $saved" >&2
  else
    local current=""
    if command -v gsettings &>/dev/null; then
      current=$(gsettings get org.cinnamon.desktop.interface cursor-theme 2>/dev/null \
                | tr -d "'" | tr -d '"' || true)
    fi
    if [ -z "$current" ] || [ "$current" = "spoon" ]; then
      current="Adwaita"
    fi
    echo "$current" > "$_CURSOR_STATE_FILE"
    echo "[cursor] saved previous theme: $current" >&2
  fi
  if command -v gsettings &>/dev/null; then
    gsettings set org.cinnamon.desktop.interface cursor-theme "spoon" 2>/dev/null || true
    echo "[cursor] cursor-theme → spoon" >&2
  fi
}

spoon_cursor_restore() {
  [ -f "$_CURSOR_STATE_FILE" ] || return 0
  local prev
  prev="$(cat "$_CURSOR_STATE_FILE" 2>/dev/null || echo "Adwaita")"
  if [ -z "$prev" ] || [ "$prev" = "spoon" ]; then prev="Adwaita"; fi
  if command -v gsettings &>/dev/null; then
    gsettings set org.cinnamon.desktop.interface cursor-theme "$prev" 2>/dev/null || true
    echo "[cursor] cursor-theme restored to $prev" >&2
  fi
  rm -f "$_CURSOR_STATE_FILE"
}
