#!/usr/bin/env bash
# Builds and installs the spoon SVG as the system X11 cursor theme "spoon".
# Run ON LINUX (X11) after git pull.
#
# Usage:
#   bash wallpaper/linux/install-spoon-cursor.sh
#   bash wallpaper/linux/install-spoon-cursor.sh --uninstall
#
# The script is safe to re-run. Sizes and hotspot are computed to match the
# in-app CSS cursor exactly (same math as kiosk-browsers.js).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # = wallpaper/

SPOON_SVG="$PROJ_DIR/assets/utensils/spoon-cursor.svg"
FK_SVG="$PROJ_DIR/assets/utensils/forkknife.svg"

THEME_NAME="spoon"
ICONS_DIR="$HOME/.icons"
THEME_DIR="$ICONS_DIR/$THEME_NAME"
CURSORS_DIR="$THEME_DIR/cursors"
DEFAULT_DIR="$ICONS_DIR/default"
PREV_FILE="$THEME_DIR/.previous-theme"

# ---- Detect desktop environment -----------------------------------------------
detect_de() {
  local de="${XDG_CURRENT_DESKTOP:-}"
  if   [ "$de" = "X-Cinnamon" ] || [ "${DESKTOP_SESSION:-}" = "cinnamon" ]; then echo "Cinnamon"
  elif [ "$de" = "GNOME"      ] || [ -n "${GNOME_DESKTOP_SESSION_ID:-}" ];   then echo "GNOME"
  elif [ "$de" = "MATE"       ]; then echo "MATE"
  elif [ "$de" = "XFCE"       ]; then echo "XFCE"
  elif [ "$de" = "KDE"        ] || [ "${KDE_FULL_SESSION:-}" = "true" ];      then echo "KDE"
  else echo "${de:-unknown}"; fi
}

# ---- Detect currently active cursor theme -----------------------------------
detect_current_theme() {
  local t=""
  # 1. gsettings (GNOME / Cinnamon)
  if command -v gsettings &>/dev/null; then
    t=$(gsettings get org.gnome.desktop.interface cursor-theme 2>/dev/null | tr -d "'" | tr -d '"' || true)
  fi
  # 2. ~/.icons/default/index.theme
  if [ -z "$t" ] && [ -f "$DEFAULT_DIR/index.theme" ]; then
    t=$(grep -m1 '^Inherits=' "$DEFAULT_DIR/index.theme" 2>/dev/null | cut -d= -f2 | tr -d ' ' || true)
    # Don't treat a loop back to "spoon" as the real previous theme
    [ "$t" = "spoon" ] && t=""
  fi
  # 3. /usr/share/icons/default/index.theme
  if [ -z "$t" ] && [ -f /usr/share/icons/default/index.theme ]; then
    t=$(grep -m1 '^Inherits=' /usr/share/icons/default/index.theme 2>/dev/null | cut -d= -f2 | tr -d ' ' || true)
  fi
  echo "${t:-Adwaita}"
}

# ---- Uninstall ----------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ]; then
  if [ ! -d "$THEME_DIR" ]; then
    echo "Nothing to uninstall ($THEME_DIR does not exist)."
    exit 0
  fi
  PREV="$(cat "$PREV_FILE" 2>/dev/null || echo "Adwaita")"
  echo "Uninstalling spoon cursor theme, restoring: $PREV"
  mkdir -p "$DEFAULT_DIR"
  printf '[Icon Theme]\nInherits=%s\n' "$PREV" > "$DEFAULT_DIR/index.theme"
  if command -v gsettings &>/dev/null; then
    if gsettings set org.gnome.desktop.interface cursor-theme "$PREV" 2>/dev/null; then
      echo "  gsettings: cursor-theme = $PREV"
    fi
  fi
  rm -rf "$THEME_DIR"
  echo "Removed $THEME_DIR"
  echo "Log out and back in (or restart the kiosk) for the change to take effect."
  exit 0
fi

# ---- Dependency check / install -----------------------------------------------
install_pkg() {
  local pkg="$1" cmd="$2"
  if command -v "$cmd" &>/dev/null; then
    echo "  $cmd: OK"
  else
    echo "  $cmd: not found — installing $pkg..."
    sudo apt-get install -y "$pkg"
  fi
}
echo "Checking dependencies..."
install_pkg librsvg2-bin rsvg-convert
install_pkg x11-apps     xcursorgen

# ---- Locate node ---------------------------------------------------------------
if ! command -v node &>/dev/null; then
  # Try loading nvm (common on dev machines)
  [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
fi
if ! command -v node &>/dev/null; then
  echo "ERROR: 'node' not found on PATH. Source your shell profile or install Node.js." >&2
  exit 1
fi

# ---- Compute pixel dimensions and generate shadow SVG -------------------------
# Mirrors the exact math in kiosk-browsers.js so sizes and hotspot match the
# in-app CSS cursor pixel-for-pixel.
echo "Computing cursor dimensions via node..."

TMP_DIR=$(mktemp -d /tmp/spoon-cursor-XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

NODE_SCRIPT="$TMP_DIR/compute.js"
cat > "$NODE_SCRIPT" << 'NODEJS_EOF'
const fs = require('fs');
const fkPath    = process.argv[2];
const spoonPath = process.argv[3];

const CLOCK_SIZE   = 110;  // must match kiosk-browsers.js
const FK_GRAPHIC_W = CLOCK_SIZE;

const fkSvgRaw   = fs.readFileSync(fkPath, 'utf8');
const fkVbMatch  = fkSvgRaw.match(/viewBox="([\d.\s]+)"/);
const fkVbParts  = fkVbMatch ? fkVbMatch[1].trim().split(/\s+/) : ['0','0','61.72','21.86'];
const fkVbW      = parseFloat(fkVbParts[2]);

function _pathXBounds(ds) {
  let minX = Infinity, maxX = -Infinity;
  const hit = x => { if (x < minX) minX = x; if (x > maxX) maxX = x; };
  for (const d of ds) {
    const toks = [...d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g)].map(m => m[0]);
    let i = 0, cx = 0, cmd = '';
    const n = () => { const v = parseFloat(toks[i] || '0'); i++; return isNaN(v) ? 0 : v; };
    while (i < toks.length) {
      if (/[MmLlHhVvCcSsQqTtAaZz]/.test(toks[i])) { cmd = toks[i++]; continue; }
      switch (cmd) {
        case 'M': cx=n();n();hit(cx);cmd='L';break; case 'm':cx+=n();n();hit(cx);cmd='l';break;
        case 'L': cx=n();n();hit(cx);break;         case 'l':cx+=n();n();hit(cx);break;
        case 'H': cx=n();hit(cx);break;              case 'h':cx+=n();hit(cx);break;
        case 'V': n();break;                          case 'v':n();break;
        case 'C': n();n();n();n();cx=n();n();hit(cx);break; case 'c':n();n();n();n();cx+=n();n();hit(cx);break;
        case 'S': n();n();cx=n();n();hit(cx);break;  case 's':n();n();cx+=n();n();hit(cx);break;
        case 'Q': n();n();cx=n();n();hit(cx);break;  case 'q':n();n();cx+=n();n();hit(cx);break;
        case 'T': cx=n();n();hit(cx);break;           case 't':cx+=n();n();hit(cx);break;
        case 'A': n();n();n();n();n();cx=n();n();hit(cx);break; case 'a':n();n();n();n();n();cx+=n();n();hit(cx);break;
        case 'Z': case 'z': break;
        default: i++; break;
      }
    }
  }
  return { extent: maxX === -Infinity ? 0 : maxX - (minX === Infinity ? 0 : minX) };
}

const fkAllDs        = [...fkSvgRaw.matchAll(/\sd="([^"]+)"/g)].map(m => m[1]);
const forkExtent     = _pathXBounds(fkAllDs.slice(0, 2)).extent;
const forkRenderedPx = forkExtent * FK_GRAPHIC_W / fkVbW;

const spoonRaw      = fs.readFileSync(spoonPath, 'utf8');
const spoonVbMatch  = spoonRaw.match(/viewBox="([\d.\s]+)"/);
const spoonVbParts  = spoonVbMatch ? spoonVbMatch[1].trim().split(/\s+/) : ['0','0','37.78','37.77'];
const spoonVbW      = parseFloat(spoonVbParts[2]);
const spoonVbH      = parseFloat(spoonVbParts[3]);

const diagUnits  = Math.sqrt(spoonVbW * spoonVbW + spoonVbH * spoonVbH);
const scale      = forkRenderedPx / diagUnits;
const artW       = Math.round(spoonVbW * scale);
const artH       = Math.round(spoonVbH * scale);

const SD = 9, DY = 4;
const SIG3  = Math.ceil(3 * SD);
const PAD_L = SIG3;
const PAD_T = Math.max(0, SIG3 - DY);
const PAD_R = SIG3;
const PAD_B = SIG3 + DY;
const outerW = artW + PAD_L + PAD_R;
const outerH = artH + PAD_T + PAD_B;

const hotX = Math.round(3.47 * scale) + PAD_L;
const hotY = Math.round(0.50 * scale) + PAD_T;

// Filter region percentages (same as kiosk-browsers.js)
const fRegX = (-Math.ceil(PAD_L / artW * 100)) + '%';
const fRegY = (-Math.ceil(PAD_T / artH * 100)) + '%';
const fRegW = (Math.ceil(outerW / artW * 100) + 1) + '%';
const fRegH = (Math.ceil(outerH / artH * 100) + 1) + '%';

// Build the wrapped SVG with drop shadow baked in, fill inlined.
const stripped = spoonRaw
  .replace(/<\?xml[^?]*\?>\n?/, '')
  .replace(/<defs>[\s\S]*?<\/defs>\n?/, '')
  .replace(/\s+id="[^"]+"/g, '')
  .replace(/\s+data-name="[^"]+"/g, '')
  .replace(/class="cls-1"/g, 'fill="#ea4b00"')
  .replace(/\n\s*\n/g, '\n')
  .trim();
const bodyMatch = stripped.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/);
const body      = bodyMatch ? bodyMatch[1].trim() : stripped;

const svg = [
  `<svg width="${outerW}" height="${outerH}" xmlns="http://www.w3.org/2000/svg">`,
  `<defs><filter id="s" x="${fRegX}" y="${fRegY}" width="${fRegW}" height="${fRegH}" color-interpolation-filters="sRGB">`,
  `<feDropShadow dx="0" dy="${DY}" stdDeviation="${SD}" flood-color="#000" flood-opacity="0.42"/>`,
  `</filter></defs>`,
  `<svg x="${PAD_L}" y="${PAD_T}" width="${artW}" height="${artH}" viewBox="0 0 ${spoonVbW} ${spoonVbH}" filter="url(#s)">`,
  body,
  `</svg>`,
  `</svg>`,
].join('');

process.stdout.write(JSON.stringify({ artW, artH, outerW, outerH, hotX, hotY, svg }));
NODEJS_EOF

JSON=$(node "$NODE_SCRIPT" "$FK_SVG" "$SPOON_SVG")

# Parse JSON fields with node (avoids jq dependency)
get_field() { node -e "process.stdout.write(String(JSON.parse(process.argv[1]).$1))" "$JSON"; }

ART_W=$(get_field artW)
ART_H=$(get_field artH)
OUTER_W=$(get_field outerW)
OUTER_H=$(get_field outerH)
HOT_X=$(get_field hotX)
HOT_Y=$(get_field hotY)
# 2x values
OUTER_W2=$((OUTER_W * 2))
OUTER_H2=$((OUTER_H * 2))
HOT_X2=$((HOT_X * 2))
HOT_Y2=$((HOT_Y * 2))

echo "  art=${ART_W}x${ART_H}  outer=${OUTER_W}x${OUTER_H}  hotspot=(${HOT_X},${HOT_Y})"

# Write wrapper SVG to temp file
SVG_FILE="$TMP_DIR/spoon-shadow.svg"
node -e "process.stdout.write(JSON.parse(process.argv[1]).svg)" "$JSON" > "$SVG_FILE"

# ---- Render PNGs --------------------------------------------------------------
echo "Rendering PNGs..."
PNG_1X="$TMP_DIR/spoon_${OUTER_W}.png"
PNG_2X="$TMP_DIR/spoon_${OUTER_W2}.png"
rsvg-convert -w "$OUTER_W"  -h "$OUTER_H"  "$SVG_FILE" -o "$PNG_1X"
rsvg-convert -w "$OUTER_W2" -h "$OUTER_H2" "$SVG_FILE" -o "$PNG_2X"
echo "  rendered ${OUTER_W}x${OUTER_H} and ${OUTER_W2}x${OUTER_H2}"

# ---- Build xcursorgen config and cursor binary --------------------------------
CFG="$TMP_DIR/spoon.cfg"
printf '%d %d %d %s\n'   "$OUTER_W"  "$HOT_X"  "$HOT_Y"  "$PNG_1X" > "$CFG"
printf '%d %d %d %s\n'   "$OUTER_W2" "$HOT_X2" "$HOT_Y2" "$PNG_2X" >> "$CFG"

CURSOR_BIN="$TMP_DIR/spoon.cursor"
xcursorgen "$CFG" "$CURSOR_BIN"
echo "  xcursorgen: built $CURSOR_BIN"

# ---- Detect previous theme (saved for --uninstall) ----------------------------
PREV_THEME="$(detect_current_theme)"
echo "Previous cursor theme: $PREV_THEME"

# ---- Install theme directory --------------------------------------------------
echo "Installing theme to $CURSORS_DIR..."
mkdir -p "$CURSORS_DIR"

# Save the previous theme once (don't overwrite on re-run if already pointing at spoon)
if [ ! -f "$PREV_FILE" ] || [ "$(cat "$PREV_FILE")" = "spoon" ]; then
  echo "$PREV_THEME" > "$PREV_FILE"
fi

# Place the single cursor binary
cp "$CURSOR_BIN" "$CURSORS_DIR/spoon.cursor"

# ---- Named cursor symlinks (these names map to the spoon) --------------------
# Excluded (inherited from parent theme): xterm, ibeam, text, grab, grabbing,
# fleur, col-resize, row-resize, ew-resize, ns-resize, nwse-resize, nesw-resize,
# all-scroll, zoom-in, zoom-out, copy, and other resize/grip cursors.
SPOON_NAMES=(
  left_ptr default arrow top_left_arrow
  circle not-allowed no-drop crossed_circle
  dnd-none dnd-move dnd-copy dnd-link dnd-ask dnd-no-drop
  X_cursor
  wait watch progress left_ptr_watch half-busy
)

for name in "${SPOON_NAMES[@]}"; do
  ln -sf spoon.cursor "$CURSORS_DIR/$name"
done

# ---- Hash-named aliases -------------------------------------------------------
# Standard X11 cursor hash names (from libXcursor / Adwaita sources) that some
# toolkits look up by hash rather than by symbolic name.
declare -A HASH_MAP=(
  # left_ptr
  ["5c6cd98b3f3ebcb1f9c7f1c204630408"]="left_ptr"
  ["b66166c04f8c3109214a4fbd64a50fc8"]="left_ptr"
  # default
  ["d9ce0ab605698f320427677b458ad60b"]="default"
  # top_left_arrow
  ["a2a266d0498c3104214a47bd64ab0fc8"]="top_left_arrow"
  # X_cursor
  ["00000000000000020006000e7e9ffc3f"]="X_cursor"
  # wait
  ["0426c94ea35c87780ff01dc239897213"]="wait"
  # watch
  ["3ecb610c1bf2410f44200f48c40d3599"]="watch"
  ["9116a3ea924ed2162ecab71ba103b17f"]="watch"
  # left_ptr_watch / progress
  ["08e8e1c95fe2fc01f976f1e063a24ccd"]="left_ptr_watch"
  ["3c6c4f67d6e35484e9e2bad6eb09f7ca"]="left_ptr_watch"
  # circle / not-allowed
  ["0ea85b24192d2383acde9b34bd8d740f"]="circle"
  ["fcf21c00b30f7e3f83fe0dfd12e71cff"]="crossed_circle"
  # no-drop
  ["03b6e0fcb3499374a867c041f52298f0"]="no-drop"
  ["6407b0e94181790501fd1e167b474872"]="no-drop"
  # dnd-none
  ["e29285e634086352946a0e7090d73106"]="dnd-none"
  ["4498f0e0c1937ffe01fd06f973665830"]="dnd-none"
)

for hash in "${!HASH_MAP[@]}"; do
  ln -sf spoon.cursor "$CURSORS_DIR/$hash"
done
echo "  created ${#SPOON_NAMES[@]} named cursors + ${#HASH_MAP[@]} hash aliases"

# ---- index.theme --------------------------------------------------------------
# Inherits= points at the old theme so xterm, resize, and grab cursors fall
# through to the parent rather than showing a generic X.
cat > "$THEME_DIR/index.theme" << EOF
[Icon Theme]
Name=spoon
Comment=Spoon cursor for internet-cafe kiosk
Inherits=$PREV_THEME
EOF
echo "  wrote index.theme (Inherits=$PREV_THEME)"

# ---- Set as default -----------------------------------------------------------
mkdir -p "$DEFAULT_DIR"
printf '[Icon Theme]\nInherits=%s\n' "$THEME_NAME" > "$DEFAULT_DIR/index.theme"
echo "  set ~/.icons/default/index.theme → $THEME_NAME"

DE="$(detect_de)"
if command -v gsettings &>/dev/null; then
  if gsettings set org.gnome.desktop.interface cursor-theme "$THEME_NAME" 2>/dev/null; then
    echo "  gsettings: cursor-theme = $THEME_NAME"
  fi
fi

echo ""
echo "Desktop environment detected: $DE"
echo "Cursor theme 'spoon' installed. Changes:"
echo "  ~/.icons/spoon/         — theme files"
echo "  ~/.icons/default/       — X11 default override"
if command -v gsettings &>/dev/null; then
  echo "  gsettings cursor-theme  — set to spoon"
fi
echo ""
echo "Log out and back in (or restart the kiosk) for the change to take effect."
echo "To uninstall: bash $0 --uninstall"
