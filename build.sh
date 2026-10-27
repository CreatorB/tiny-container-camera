#!/bin/sh
# Packs the extension into dist/tiny-container-camera.xpi
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/tiny-container-camera.xpi
(cd extension && zip -qr ../dist/tiny-container-camera.xpi . -x .amo-upload-uuid)
echo "dist/tiny-container-camera.xpi"
