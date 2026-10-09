// Riftborn stats page (https://feedback.riftborn.us/metrics/, the inbox's origin): reads the leaderboard Worker's
// GET /api/admin/stats with the same admin key as the inbox. The key never leaves this page except as the
// Authorization header to API below. It lives in sessionStorage only (this tab; closing it forgets the key); a
// copy an older page kept in localStorage is deleted as the page starts. A refused key (401) is wiped.
// Every number comes from the Worker's counters and is only ever shown with textContent; the page has a strict
// CSP (the _headers of feedback.riftborn.us, and index.html's own meta policy).
const API = 'https://api.riftborn.us';
// Where this page lives (any other copy cannot reach the Worker: CORS).
const HOMES = ['feedback.riftborn.us'];
const STORE_KEY = 'riftborn-feedback-admin-key';

const $ = selector => document.querySelector(selector);
const el = {
  login: $('#login'), loginForm: $('#loginForm'), keyInput: $('#keyInput'), loginError: $('#loginError'),
  stats: $('#stats'), status: $('#status'), lock: $('#lock')
};

const storage = kind => { try { return window[kind]; } catch { return null; } };
const read = (kind, key) => { try { return storage(kind)?.getItem(key) || ''; } catch { return ''; } };
const write = (kind, key, value) => { try { value ? storage(kind)?.setItem(key, value) : storage(kind)?.removeItem(key); } catch { /* storage blocked */ } };

// Older pages could keep the key in localStorage: never read, always deleted.
write('localStorage', STORE_KEY, '');
let key = read('sessionStorage', STORE_KEY);
let loading = false;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, init = {}) {
  let response;
  try {
    response = await fetch(API + path, { ...init, cache: 'no-store', headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) } });
  } catch {
    throw new HttpError(0, HOMES.includes(location.hostname)
      ? 'Could not reach the Worker. Check your connection and try again.'
      : 'Could not reach the Worker. The Worker only answers this page at feedback.riftborn.us.');
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch { /* not JSON */ }
    throw new HttpError(response.status, message);
  }
  return response;
}

// ---- flow ----

function handleError(error) {
  if (error.status === 401) {
    lock('That key was not accepted.');
    return;
  }
  if (error.status === 429) {
    el.status.textContent = 'Too many requests from this network. Wait a minute and try again.';
    return;
  }
  el.status.textContent = error.message;
}

function lock(message = '') {
  key = '';
  write('sessionStorage', STORE_KEY, '');
  el.stats.hidden = true;
  el.lock.hidden = true;
  el.login.hidden = false;
  el.loginError.textContent = message;
  el.keyInput.value = '';
  el.keyInput.focus();
}

function unlock() {
  el.login.hidden = true;
  el.stats.hidden = false;
  el.lock.hidden = false;
}

el.loginForm.addEventListener('submit', event => {
  event.preventDefault();
  key = el.keyInput.value.trim();
  if (!key) return;
  write('sessionStorage', STORE_KEY, key);
  el.loginError.textContent = '';
  unlock();
});
el.lock.addEventListener('click', () => lock());

if (key) unlock();
else lock();
