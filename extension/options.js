'use strict';

const DEFAULT_URL = 'http://127.0.0.1:8080/video';
const input = document.getElementById('url');
const access = document.getElementById('access');
const msg = document.getElementById('msg');

// Match patterns have no port: http://127.0.0.1/* covers every port.
function originPattern(url) {
  const u = new URL(url);
  return u.protocol + '//' + u.hostname + '/*';
}

async function showAccess(url) {
  const granted = await browser.permissions.contains({ origins: [originPattern(url)] });
  access.textContent = granted
    ? 'Access to ' + new URL(url).host + ': granted'
    : 'Access to ' + new URL(url).host + ': not granted. Click the button below.';
  access.style.color = granted ? '#188038' : '#c5221f';
}

browser.storage.local.get({ url: DEFAULT_URL }).then(({ url }) => {
  input.value = url;
  showAccess(url);
});

document.getElementById('save').addEventListener('click', async () => {
  const url = input.value.trim() || DEFAULT_URL;
  try {
    new URL(url);
  } catch (_) {
    msg.textContent = 'Invalid URL.';
    return;
  }
  const granted = await browser.permissions.request({ origins: [originPattern(url)] });
  await showAccess(url);
  if (!granted) {
    msg.textContent = 'Permission to access ' + new URL(url).origin + ' was denied.';
    return;
  }
  await browser.storage.local.set({ url });
  msg.textContent = 'Saved. Reload the meeting tab.';
});
