// Runs in the page's world: replaces getUserMedia/enumerateDevices so the page
// sees a virtual camera fed by frames from isolated.js, drawn onto a canvas.
(() => {
  'use strict';

  const md = navigator.mediaDevices;
  if (!md || md.__tccPatched) return;
  md.__tccPatched = true;

  const DEVICE_ID = 'tiny-container-camera';
  const GROUP_ID = 'tiny-container-camera-group';
  const LABEL = 'Android Camera (Tiny Container)';
  const FPS = 30;

  const origGetUserMedia = md.getUserMedia.bind(md);
  const origEnumerateDevices = md.enumerateDevices.bind(md);

  let canvas = null;
  let ctx = null;
  let baseTrack = null;
  let activeTracks = 0;
  let decoding = false;
  let pending = null;
  let gotFrame = false;
  let statusText = 'Waiting for camera...';

  function send(type) {
    window.postMessage({ __tcc: 'to-isolated', type }, '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__tcc !== 'to-main') return;
    if (e.data.type === 'frame') {
      pending = e.data.data;
      drawPending();
    } else if (e.data.type === 'status') {
      statusText = e.data.text;
      if (!gotFrame) drawPlaceholder();
    }
  });

  // Decodes only the newest frame; frames arriving mid-decode are dropped.
  async function drawPending() {
    if (decoding || !pending || !ctx) return;
    decoding = true;
    const data = pending;
    pending = null;
    try {
      const bmp = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      gotFrame = true;
    } catch (_) {
      // Corrupt frame: skip it.
    }
    decoding = false;
    if (pending) drawPending();
  }

  function drawPlaceholder() {
    if (!ctx) return;
    ctx.fillStyle = '#202124';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e8eaed';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(statusText, canvas.width / 2, canvas.height / 2);
  }

  function ensureBaseTrack() {
    if (baseTrack && baseTrack.readyState === 'live') return baseTrack;
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    ctx = canvas.getContext('2d');
    gotFrame = false;
    drawPlaceholder();
    baseTrack = canvas.captureStream(FPS).getVideoTracks()[0];
    return baseTrack;
  }

  function makeTrack() {
    const track = ensureBaseTrack().clone();
    const origGetSettings = track.getSettings.bind(track);
    const origStop = track.stop.bind(track);
    let stopped = false;

    Object.defineProperty(track, 'label', { get: () => LABEL });
    track.getSettings = () => ({
      ...origGetSettings(),
      deviceId: DEVICE_ID,
      groupId: GROUP_ID,
      width: canvas.width,
      height: canvas.height,
      frameRate: FPS,
      facingMode: 'user',
    });
    track.getCapabilities = () => ({
      deviceId: DEVICE_ID,
      groupId: GROUP_ID,
      width: { min: 1, max: canvas.width },
      height: { min: 1, max: canvas.height },
      frameRate: { min: 1, max: FPS },
      facingMode: ['user'],
    });
    track.getConstraints = () => ({});
    track.applyConstraints = () => Promise.resolve();
    track.stop = () => {
      if (stopped) return;
      stopped = true;
      origStop();
      if (--activeTracks === 0) send('stop');
    };

    if (activeTracks++ === 0) send('start');
    return track;
  }

  md.getUserMedia = async function (constraints) {
    if (!constraints || !constraints.video) return origGetUserMedia(constraints);
    const stream = constraints.audio
      ? await origGetUserMedia({ audio: constraints.audio })
      : new MediaStream();
    stream.addTrack(makeTrack());
    return stream;
  };

  md.enumerateDevices = async function () {
    const devices = (await origEnumerateDevices()).filter((d) => d.kind !== 'videoinput');
    devices.push({
      deviceId: DEVICE_ID,
      groupId: GROUP_ID,
      kind: 'videoinput',
      label: LABEL,
      toJSON() {
        return { deviceId: DEVICE_ID, groupId: GROUP_ID, kind: 'videoinput', label: LABEL };
      },
    });
    return devices;
  };
})();
