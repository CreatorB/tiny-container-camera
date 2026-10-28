'use strict';

const origin = new URLSearchParams(location.search).get('origin') || '';
document.getElementById('origin').textContent = origin;

// Closes even if the message fails (e.g. the extension was reloaded while the
// prompt was open); an unanswered request is then simply denied.
function decide(allow) {
  let sent;
  try {
    sent = browser.runtime.sendMessage({ type: 'permission-decision', origin, allow });
  } catch (_) {
    sent = Promise.resolve();
  }
  Promise.race([sent, new Promise((r) => setTimeout(r, 2000))])
    .catch(() => {})
    .then(() => window.close());
}

document.getElementById('allow').onclick = () => decide(true);
document.getElementById('block').onclick = () => decide(false);
