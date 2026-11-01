#!/bin/sh
# Builds the netlink shim and makes the installed browsers start with it, for
# the current user only (no root needed). Run again after updating; use
# --uninstall to undo.
#
# Firefox ESR: the app menu / xdg-open (desktop entry), the XFCE "web browser"
# helper, and the `firefox-esr` command (~/.local/bin wrapper).
# Chrome / Chromium: user copies of their app menu entries with the shim
# added to LD_PRELOAD (keeping any library already preloaded there).
set -e
cd "$(dirname "$0")"

LIB_DIR="$HOME/.local/lib/tiny-container-camera"
LIB="$LIB_DIR/libnetlink_shim.so"
APPS="$HOME/.local/share/applications"
WRAPPER="$HOME/.local/bin/firefox-esr"
HELPER="$HOME/.local/share/xfce4/helpers/firefox.desktop"
FIREFOX=/usr/lib/firefox-esr/firefox-esr
MARK="# tiny-container-camera webrtc-fix"

ours() {
  [ -f "$1" ] && grep -q "$MARK" "$1"
}

# Refuses to replace a file the user made.
check_free() {
  if [ -f "$1" ] && ! ours "$1"; then
    echo "$1 exists and was not created by this script; not overwriting" >&2
    exit 1
  fi
}

if [ "$1" = "--uninstall" ]; then
  for f in "$WRAPPER" "$HELPER" "$APPS"/*.desktop; do
    if ours "$f"; then rm -f "$f" && echo "removed $f"; fi
  done
  rm -f "$LIB"
  echo "Uninstalled. Restart the browser."
  exit 0
fi

command -v gcc >/dev/null || { echo "gcc not found: sudo apt install gcc" >&2; exit 1; }

mkdir -p "$LIB_DIR" "$APPS"
gcc -O2 -shared -fPIC -o "$LIB" netlink_shim.c -ldl -lpthread
echo "built $LIB"
found=""

if [ -x "$FIREFOX" ]; then
  found=1
  DESKTOP="$APPS/firefox-esr.desktop"
  for f in "$WRAPPER" "$DESKTOP" "$HELPER"; do check_free "$f"; done
  mkdir -p "$(dirname "$WRAPPER")" "$(dirname "$HELPER")"

  cat > "$WRAPPER" <<EOF
#!/bin/sh
$MARK
export LD_PRELOAD="$LIB\${LD_PRELOAD:+:\$LD_PRELOAD}"
exec $FIREFOX "\$@"
EOF
  chmod +x "$WRAPPER"
  echo "wrote $WRAPPER"

  sed -e "s#^Exec=$FIREFOX#Exec=$WRAPPER#" /usr/share/applications/firefox-esr.desktop > "$DESKTOP"
  printf '%s\n' "$MARK" >> "$DESKTOP"
  echo "wrote $DESKTOP"

  cat > "$HELPER" <<EOF
[Desktop Entry]
$MARK
NoDisplay=true
Version=1.0
Encoding=UTF-8
Type=X-XFCE-Helper
X-XFCE-Category=WebBrowser
X-XFCE-CommandsWithParameter=$WRAPPER "%s"
Icon=firefox-esr
Name=Mozilla Firefox
X-XFCE-Commands=$WRAPPER
X-XFCE-Binaries=firefox-esr;firefox;
EOF
  echo "wrote $HELPER"
fi

for src in /usr/share/applications/google-chrome*.desktop \
           /usr/share/applications/com.google.Chrome*.desktop \
           /usr/share/applications/chromium*.desktop; do
  [ -f "$src" ] || continue
  found=1
  dest="$APPS/$(basename "$src")"
  check_free "$dest"
  # "Exec=env LD_PRELOAD=X prog" -> "Exec=env LD_PRELOAD=X:LIB prog";
  # any other "Exec=prog" -> "Exec=env LD_PRELOAD=LIB prog".
  sed -e "s#^Exec=env LD_PRELOAD=\([^ ]*\) #Exec=env LD_PRELOAD=\1:$LIB #" \
      -e "/^Exec=env LD_PRELOAD=/!s#^Exec=#Exec=env LD_PRELOAD=$LIB #" \
      "$src" > "$dest"
  printf '%s\n' "$MARK" >> "$dest"
  echo "wrote $dest"
done

[ -n "$found" ] || { echo "No Firefox ESR, Chrome or Chromium found." >&2; exit 1; }

echo "Done. Close every browser window and start it again from the app menu."
if command -v xfce4-panel >/dev/null && pgrep -x xfce4-panel >/dev/null; then
  # The XFCE menu caches desktop entries; without a restart it may keep
  # starting the browser without the fix.
  xfce4-panel -r >/dev/null 2>&1 &
  echo "Restarted the XFCE panel so its menu uses the new entries."
fi
