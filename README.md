# Tiny Container Camera

Use your Android phone/tablet camera as a webcam in **Microsoft Teams (web)**
running in Firefox inside [Tiny Computer / tiny_container](https://github.com/Cateners/tiny_container)
or any other proot environment.

## Why?

Inside proot, Android's `/dev/video*` devices are not accessible without root,
and `v4l2loopback` cannot be installed because kernel modules cannot be loaded.
So the camera cannot be passed through as a regular V4L2 device (this includes
`scrcpy --v4l2-sink`).

This extension takes a different route: the **IP Webcam** app on Android
serves an MJPEG stream at `http://127.0.0.1:8080/video`, and the Firefox
extension exposes that stream to web pages as a virtual camera through
`getUserMedia()`. The microphone still uses the real audio input (PulseAudio).

```
IP Webcam (Android) ──MJPEG──▶ background.js ──port──▶ isolated.js ──postMessage──▶ main.js
                               (fetch, no CORS/CSP)                                 canvas.captureStream()
                                                                                    → getUserMedia() in Teams
```

## Usage

1. On Android, install **IP Webcam** (`com.pas.webcam`) from the Play Store.
   Via ADB:
   `adb shell am start -a android.intent.action.VIEW -d "market://details?id=com.pas.webcam"`
2. Open IP Webcam. Set **Video preferences → Video resolution** to 640x480
   (recommended), then tap **Start server**.
3. Download the signed `.xpi` from the
   [Releases](https://github.com/CreatorB/tiny-container-camera/releases) page,
   then in Firefox open `about:addons` → gear icon →
   *Install Add-on From File…*
4. Open https://teams.microsoft.com, join a meeting, and pick the
   **Android Camera (Tiny Container)** camera.

### Samsung: IP Webcam stops in the background

One UI freezes background apps ("Freecess"), so the IP Webcam server stops as
soon as you switch back to Tiny Computer. Exclude it from battery optimization
(Settings → Battery → Background usage limits → *Never sleeping apps*), or via
ADB:

```sh
adb shell dumpsys deviceidle whitelist +com.pas.webcam
adb shell cmd appops set com.pas.webcam RUN_ANY_IN_BACKGROUND allow
```

### Changing the stream URL

Open the extension options in `about:addons` (for example, to use IP Webcam
on another phone: `http://192.168.1.10:8080/video`). For hosts other than
`127.0.0.1`/`localhost`, Firefox will ask for access permission.

## Development

To try code changes without signing: `about:debugging` → *This Firefox* →
*Load Temporary Add-on…* → select `extension/manifest.json`.
Temporary add-ons are removed when Firefox closes.

`sh build.sh` builds `dist/tiny-container-camera.xpi` (unsigned). To sign it,
use [`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign).

### Testing without a phone

```sh
python3 tools/mock_mjpeg.py --port 8080 image1.jpg image2.jpg
```

Then open `http://127.0.0.1:8080/tcc-test.html` and click **Start camera**.

## Limitations

- Firefox 128+ only (uses `world: "MAIN"` content scripts).
- Frames are decoded from JPEG inside proot, so lower resolutions run smoother.
- Teams still asks for microphone permission as usual. No camera permission
  prompt appears because the camera is virtual.

## License

MIT, see [LICENSE](LICENSE).
