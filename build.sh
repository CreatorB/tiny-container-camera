#!/bin/sh
# Packs the extension into dist/tiny-container-camera.xpi
# With --debug, also writes an unpacked copy to dist/debug-extension that sends
# page logs to tools/log_server.py.
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/tiny-container-camera.xpi
(cd extension && zip -qr ../dist/tiny-container-camera.xpi . -x .amo-upload-uuid)
echo "dist/tiny-container-camera.xpi"

if [ "$1" = "--debug" ]; then
  rm -rf dist/debug-extension
  cp -r extension dist/debug-extension
  rm -f dist/debug-extension/.amo-upload-uuid
  sed -i "s#^const LOG_URL = '';#const LOG_URL = 'http://127.0.0.1:8091/log';#" dist/debug-extension/background.js
  grep -q "^const LOG_URL = 'http" dist/debug-extension/background.js
  echo "dist/debug-extension/manifest.json"
fi
