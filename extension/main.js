// Runs in the page's world: replaces getUserMedia/enumerateDevices so the page
// sees a virtual camera fed by frames from isolated.js, drawn onto a canvas.
(() => {
  'use strict';

  if (window.__tccInstalled) return;
  window.__tccInstalled = true;

  const DEVICE_ID = 'tiny-container-camera';
  const GROUP_ID = 'tiny-container-camera-group';
  const LABEL = 'Android Camera (Tiny Container)';
  const FPS = 30;

  let canvas = null;
  let ctx = null;
  let baseTrack = null;
  let activeTracks = 0;
  let decoding = false;
  let pending = null;
  let gotFrame = false;
  let statusText = 'Waiting for camera...';

  function send(type, extra) {
    window.postMessage({ __tcc: 'to-isolated', type, ...extra }, '*');
  }

  function log(...parts) {
    const text = parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p instanceof Error || (p && p.name && p.message)) return p.name + ': ' + p.message;
        try {
          return JSON.stringify(p);
        } catch (_) {
          return String(p);
        }
      })
      .join(' ');
    send('log', { text: location.host + location.pathname + ' | ' + text });
  }

  // Asks the extension whether this site may use the camera (it may show a
  // prompt). The answer only decides how getUserMedia fails; the extension
  // itself refuses to stream to a site that is not allowed.
  const permissionWaiters = new Map();
  let permissionSeq = 0;
  function requestPermission() {
    const id = ++permissionSeq;
    return new Promise((resolve) => {
      permissionWaiters.set(id, resolve);
      send('permission', { id });
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__tcc !== 'to-main') return;
    if (e.data.type === 'permission') {
      const resolve = permissionWaiters.get(e.data.id);
      permissionWaiters.delete(e.data.id);
      if (resolve) resolve(!!e.data.allowed);
    } else if (e.data.type === 'frame') {
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

  function fakeDevice() {
    const info = { deviceId: DEVICE_ID, groupId: GROUP_ID, kind: 'videoinput', label: LABEL };
    return { ...info, toJSON: () => info };
  }

  // Patches a window (the page or a same-origin iframe) to use the shared
  // virtual camera. Sites sometimes take getUserMedia from a fresh iframe to
  // get an unpatched copy, so iframes are patched as soon as they are touched.
  function patchWindow(win) {
    let md;
    try {
      md = win.navigator.mediaDevices;
    } catch (_) {
      return;
    }
    if (!md || md.__tccPatched) return;
    md.__tccPatched = true;

    const origGetUserMedia = md.getUserMedia.bind(md);
    const origEnumerateDevices = md.enumerateDevices.bind(md);

    md.getUserMedia = async function (constraints) {
      log('getUserMedia', constraints);
      if (!constraints || !constraints.video) return origGetUserMedia(constraints);
      if (!(await requestPermission())) {
        log('getUserMedia blocked by site permission');
        throw new DOMException('Camera access was blocked for this site', 'NotAllowedError');
      }
      try {
        const stream = constraints.audio
          ? await origGetUserMedia({ audio: constraints.audio })
          : new MediaStream();
        stream.addTrack(makeTrack());
        log('getUserMedia ok', stream.getTracks().map((t) => t.kind + ':' + t.label));
        return stream;
      } catch (err) {
        log('getUserMedia failed', err);
        throw err;
      }
    };

    md.enumerateDevices = async function () {
      const devices = (await origEnumerateDevices()).filter((d) => d.kind !== 'videoinput');
      devices.push(fakeDevice());
      log('enumerateDevices', devices.map((d) => d.kind + ':' + d.label));
      return devices;
    };

    const perms = win.navigator.permissions;
    if (perms && perms.query) {
      const origQuery = perms.query.bind(perms);
      perms.query = async function (desc) {
        const status = await origQuery(desc);
        if (desc && desc.name === 'camera') {
          log('permissions.query camera, real state:', status.state);
          Object.defineProperty(status, 'state', { get: () => 'granted' });
        }
        return status;
      };
    }

    const iframeProto = win.HTMLIFrameElement && win.HTMLIFrameElement.prototype;
    const desc = iframeProto && Object.getOwnPropertyDescriptor(iframeProto, 'contentWindow');
    if (desc && desc.get) {
      Object.defineProperty(iframeProto, 'contentWindow', {
        ...desc,
        get() {
          const child = desc.get.call(this);
          if (child) patchWindow(child);
          return child;
        },
      });
    }
  }

  patchWindow(window);
  log('installed');
})();
