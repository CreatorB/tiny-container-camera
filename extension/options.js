'use strict';

const DEFAULT_URL = 'http://127.0.0.1:8080/video';
const input = document.getElementById('url');
const msg = document.getElementById('msg');

browser.storage.local.get({ url: DEFAULT_URL }).then(({ url }) => {
  input.value = url;
});

document.getElementById('save').addEventListener('click', async () => {
  const url = input.value.trim() || DEFAULT_URL;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch (_) {
    msg.textContent = 'Invalid URL.';
    return;
  }
  // 127.0.0.1/localhost are granted by default; other hosts need permission.
  const granted = await browser.permissions.request({ origins: [origin + '/*'] });
  if (!granted) {
    msg.textContent = 'Permission to access ' + origin + ' was denied.';
    return;
  }
  await browser.storage.local.set({ url });
  msg.textContent = 'Saved. Reload the Teams tab.';
});
