#!/bin/sh
# Builds the netlink shim and makes Firefox ESR start with it, for the current
# user only (no root needed). Run again after updating; use --uninstall to undo.
#
# Covers the app menu / xdg-open (desktop entry), the XFCE "web browser"
# helper, and the `firefox-esr` command (~/.local/bin wrapper).
set -e
cd "$(dirname "$0")"

LIB_DIR="$HOME/.local/lib/tiny-container-camera"
LIB="$LIB_DIR/libnetlink_shim.so"
WRAPPER="$HOME/.local/bin/firefox-esr"
DESKTOP="$HOME/.local/share/applications/firefox-esr.desktop"
HELPER="$HOME/.local/share/xfce4/helpers/firefox.desktop"
FIREFOX=/usr/lib/firefox-esr/firefox-esr
MARK="# tiny-container-camera webrtc-fix"

if [ "$1" = "--uninstall" ]; then
  for f in "$WRAPPER" "$DESKTOP" "$HELPER"; do
    if [ -f "$f" ] && grep -q "$MARK" "$f"; then rm -f "$f" && echo "removed $f"; fi
  done
  rm -rf "$LIB_DIR"
  echo "Uninstalled. Restart Firefox."
  exit 0
fi

command -v gcc >/dev/null || { echo "gcc not found: sudo apt install gcc" >&2; exit 1; }
[ -x "$FIREFOX" ] || { echo "$FIREFOX not found" >&2; exit 1; }

mkdir -p "$LIB_DIR" "$(dirname "$WRAPPER")" "$(dirname "$DESKTOP")" "$(dirname "$HELPER")"
gcc -O2 -shared -fPIC -o "$LIB" netlink_shim.c -ldl -lpthread
echo "built $LIB"

for f in "$WRAPPER" "$DESKTOP" "$HELPER"; do
  if [ -f "$f" ] && ! grep -q "$MARK" "$f"; then
    echo "$f exists and was not created by this script; not overwriting" >&2
    exit 1
  fi
done

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

echo "Done. Close every Firefox window and start it again."
if command -v xfce4-panel >/dev/null && pgrep -x xfce4-panel >/dev/null; then
  # The XFCE menu caches desktop entries; without a restart it may keep
  # starting Firefox without the fix.
  xfce4-panel -r >/dev/null 2>&1 &
  echo "Restarted the XFCE panel so its menu uses the new Firefox entry."
fi
