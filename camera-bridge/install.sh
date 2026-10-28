#!/bin/sh
# Installs the ADB camera bridge for the current user and registers it with
# Firefox as a native messaging host, so the extension can start the camera.
# Run again after updating; use --uninstall to undo.
set -e
cd "$(dirname "$0")"

DIR="$HOME/.local/lib/tiny-container-camera/camera-bridge"
HOSTS="$HOME/.mozilla/native-messaging-hosts"
MANIFEST="$HOSTS/tiny_container_camera.json"

if [ "$1" = "--uninstall" ]; then
  rm -f "$MANIFEST"
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

mkdir -p "$DIR" "$HOSTS"
cp tcc_camera.py tcc_host.py "$DIR/"
chmod +x "$DIR/tcc_camera.py" "$DIR/tcc_host.py"

cat > "$MANIFEST" <<EOF
{
  "name": "tiny_container_camera",
  "description": "Tiny Container Camera ADB bridge",
  "path": "$DIR/tcc_host.py",
  "type": "stdio",
  "allowed_extensions": ["tiny-container-camera@creatorb"]
}
EOF

echo "Installed to $DIR"
echo "Registered $MANIFEST"
echo "Restart Firefox, then use the extension's toolbar button."
