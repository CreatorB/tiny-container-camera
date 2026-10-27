# Tiny Container Camera

Pakai kamera HP/tablet Android sebagai webcam di **Microsoft Teams (web)** yang
berjalan di Firefox dalam [Tiny Computer / tiny_container](https://github.com/Cateners/tiny_container)
atau lingkungan proot lain.

## Kenapa perlu ini?

Di dalam proot, `/dev/video*` milik Android tidak bisa diakses tanpa root, dan
`v4l2loopback` tidak bisa dipasang karena kernel module tidak bisa di-load.
Jadi kamera tidak bisa diteruskan sebagai device V4L2 biasa (termasuk via
`scrcpy --v4l2-sink`).

Extension ini mengambil jalan lain: aplikasi **IP Webcam** di Android
memancarkan stream MJPEG ke `http://127.0.0.1:8080/video`, lalu extension
Firefox menyajikan stream itu ke halaman sebagai kamera virtual lewat
`getUserMedia()`. Mikrofon tetap memakai audio asli (PulseAudio).

```
IP Webcam (Android) ──MJPEG──▶ background.js ──port──▶ isolated.js ──postMessage──▶ main.js
                               (fetch, tanpa CORS/CSP)                              canvas.captureStream()
                                                                                    → getUserMedia() di Teams
```

## Cara pakai

1. Di Android, pasang **IP Webcam** (`com.pas.webcam`) dari Play Store.
   Lewat ADB:
   `adb shell am start -a android.intent.action.VIEW -d "market://details?id=com.pas.webcam"`
2. Buka IP Webcam. Atur **Video preferences → Video resolution** ke 640x480
   (disarankan), lalu tekan **Start server**.
3. Unduh `.xpi` bertanda tangan dari halaman
   [Releases](https://github.com/CreatorB/tiny-container-camera/releases),
   lalu di Firefox buka `about:addons` → ikon gerigi →
   *Install Add-on From File…*
4. Buka https://teams.microsoft.com, masuk meeting, lalu pilih kamera
   **Android Camera (Tiny Container)**.

### Samsung: IP Webcam berhenti saat di background

One UI membekukan aplikasi di background ("Freecess"), sehingga server
IP Webcam berhenti begitu kita kembali ke Tiny Computer. Kecualikan dari
penghematan baterai (Settings → Battery → Background usage limits →
*Never sleeping apps*), atau lewat ADB:

```sh
adb shell dumpsys deviceidle whitelist +com.pas.webcam
adb shell cmd appops set com.pas.webcam RUN_ANY_IN_BACKGROUND allow
```

### Pengembangan

Untuk mencoba perubahan kode tanpa signing: `about:debugging` →
*This Firefox* → *Load Temporary Add-on…* → pilih `extension/manifest.json`.
Add-on sementara hilang setiap kali Firefox ditutup.

`sh build.sh` membuat `dist/tiny-container-camera.xpi` (belum bertanda
tangan). Untuk signing, gunakan
[`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign).

### Mengganti URL stream

Buka opsi extension di `about:addons` (misalnya untuk IP Webcam di HP lain:
`http://192.168.1.10:8080/video`). Untuk host selain `127.0.0.1`/`localhost`,
Firefox akan meminta izin akses.

## Pengujian tanpa HP

```sh
python3 tools/mock_mjpeg.py --port 8080 gambar1.jpg gambar2.jpg
```

Lalu buka `http://127.0.0.1:8080/tcc-test.html` dan tekan **Start camera**.

## Batasan

- Hanya Firefox 128+ (memakai content script `world: "MAIN"`).
- Kamera di-decode dari JPEG di dalam proot, jadi resolusi rendah lebih lancar.
- Teams harus tetap memberi izin mikrofon seperti biasa. Izin kamera tidak
  diminta karena kameranya virtual.

## Lisensi

MIT, lihat [LICENSE](LICENSE).
