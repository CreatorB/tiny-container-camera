#!/bin/sh
# Installs the ADB camera bridge for the current user and registers it as a
# native messaging host for Firefox, Chrome and Chromium, so the extension can
# start the camera. Run again after updating; use --uninstall to undo.
#
# Chrome only lets listed extension IDs talk to the host. The ID of the
# unpacked build (fixed by the "key" in manifests/chrome.json) is listed
# below; add others, e.g. a Chrome Web Store ID, with --chrome-id ID.
set -e
cd "$(dirname "$0")"

NAME="tiny_container_camera"
DIR="$HOME/.local/lib/tiny-container-camera/camera-bridge"
FIREFOX_ID="tiny-container-camera@creatorb"
CHROME_IDS="kcpfcipcfophknlglpnlgkepmimheeik"
FIREFOX_HOSTS="$HOME/.mozilla/native-messaging-hosts"
CHROME_HOSTS="$HOME/.config/google-chrome/NativeMessagingHosts $HOME/.config/chromium/NativeMessagingHosts"

uninstall=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) uninstall=1 ;;
    --chrome-id) shift; CHROME_IDS="$CHROME_IDS $1" ;;
    *) echo "usage: $0 [--uninstall] [--chrome-id ID ...]" >&2; exit 1 ;;
  esac
  shift
done

if [ -n "$uninstall" ]; then
  for d in $FIREFOX_HOSTS $CHROME_HOSTS; do rm -f "$d/$NAME.json"; done
  rm -rf "$DIR"
  echo "Uninstalled."
  exit 0
fi

missing=""
for tool in adb scrcpy ffmpeg python3; do
  command -v "$tool" >/dev/null || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "Missing:$missing" >&2
  echo "Install with: sudo apt install adb scrcpy ffmpeg python3" >&2
  exit 1
fi

mkdir -p "$DIR"
cp tcc_camera.py tcc_host.py "$DIR/"
chmod +x "$DIR/tcc_camera.py" "$DIR/tcc_host.py"
echo "Installed to $DIR"

mkdir -p "$FIREFOX_HOSTS"
cat > "$FIREFOX_HOSTS/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Tiny Container Camera ADB bridge",
  "path": "$DIR/tcc_host.py",
  "type": "stdio",
  "allowed_extensions": ["$FIREFOX_ID"]
}
EOF
echo "Registered for Firefox: $FIREFOX_HOSTS/$NAME.json"

origins=""
for id in $CHROME_IDS; do
  origins="$origins${origins:+, }\"chrome-extension://$id/\""
done
for d in $CHROME_HOSTS; do
  mkdir -p "$d"
  cat > "$d/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Tiny Container Camera ADB bridge",
  "path": "$DIR/tcc_host.py",
  "type": "stdio",
  "allowed_origins": [$origins]
}
EOF
  echo "Registered for Chrome/Chromium: $d/$NAME.json"
done

echo "Restart the browser, then use the extension's toolbar button."
