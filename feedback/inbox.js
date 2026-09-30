// Riftborn feedback inbox: reads the leaderboard Worker's /api/feedback with the admin key.
// The key never leaves this page except as the Authorization header to API below; it lives in
// sessionStorage, or localStorage when "Remember on this device" is ticked.
const API = 'https://riftborn-leaderboard.chanmanc10.workers.dev';
const STORE_KEY = 'riftborn-feedback-admin-key';
const FILTER_KEY = 'riftborn-feedback-filters';
const PAGE = 50;

const $ = selector => document.querySelector(selector);
const el = {
  login: $('#login'), loginForm: $('#loginForm'), keyInput: $('#keyInput'), remember: $('#remember'), loginError: $('#loginError'),
  inbox: $('#inbox'), filters: $('#filters'), status: $('#status'), list: $('#list'), more: $('#more'),
  unread: $('#unread'), lock: $('#lock'), refresh: $('#refresh'), csv: $('#csv'),
  f: { status: $('#fStatus'), category: $('#fCategory'), source: $('#fSource'), rating: $('#fRating') }
};

const storage = kind => { try { return window[kind]; } catch { return null; } };
const read = (kind, key) => { try { return storage(kind)?.getItem(key) || ''; } catch { return ''; } };
const write = (kind, key, value) => { try { value ? storage(kind)?.setItem(key, value) : storage(kind)?.removeItem(key); } catch { /* storage blocked */ } };

let key = read('sessionStorage', STORE_KEY) || read('localStorage', STORE_KEY);
let cursor = null;
let loading = false;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, init = {}) {
  let response;
  try {
    response = await fetch(API + path, { ...init, cache: 'no-store', headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) } });
  } catch {
    throw new HttpError(0, location.hostname === 'chancrisp.github.io'
      ? 'Could not reach the feedback Worker. Check your connection and try again.'
      : 'Could not reach the feedback Worker. The Worker only answers this page at chancrisp.github.io.');
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch { /* not JSON */ }
    throw new HttpError(response.status, message);
  }
  return response;
}

function query(extra = {}) {
  const params = new URLSearchParams();
  for (const [name, select] of Object.entries(el.f)) if (select.value !== 'all') params.set(name, select.value);
  for (const [name, value] of Object.entries(extra)) if (value != null) params.set(name, value);
  const text = params.toString();
  return text ? '?' + text : '';
}

// ---- rendering (textContent only: every field is player-written) ----

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const when = ms => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const stars = rating => (rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '');

function statusButton(item, next, label, card) {
  const button = node('button', null, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/feedback/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
      const was = item.status;
      item.status = next;
      bumpUnread(was, next);
      const hidden = (el.f.status.value === 'active' && next === 'archived') || !['all', 'active', next].includes(el.f.status.value);
      if (hidden) card.remove();
      else card.replaceWith(renderItem(item, card.querySelector('details')?.open));
    } catch (error) {
      handleError(error);
      button.disabled = false;
    }
  });
  return button;
}

function renderItem(item, open = false) {
  const card = node('li', `item is-${item.status}`);
  const details = node('details');
  details.open = open;
  const summary = node('summary');
  const meta = node('div', 'meta');
  meta.append(node('span', `chip ${item.category}`, item.category.toUpperCase()));
  if (item.rating) meta.append(node('span', 'stars', stars(item.rating)));
  meta.append(node('span', null, when(item.created_at)), node('span', null, item.source === 'dev' ? '/dev/' : item.source));
  if (item.build) meta.append(node('span', null, item.build));
  meta.append(node('span', `chip state ${item.status}`, item.status.toUpperCase()));
  summary.append(meta, node('div', 'preview', item.message));
  const body = node('div', 'body');
  body.append(node('p', 'message', item.message));
  if (item.contact) body.append(node('p', 'contact', 'Contact: ' + item.contact));
  body.append(node('pre', 'context', JSON.stringify(item.context ?? {}, null, 2)));
  const actions = node('div', 'actions');
  if (item.status !== 'read') actions.append(statusButton(item, 'read', 'MARK READ', card));
  if (item.status !== 'new') actions.append(statusButton(item, 'new', 'MARK NEW', card));
  if (item.status !== 'archived') actions.append(statusButton(item, 'archived', 'ARCHIVE', card));
  body.append(actions);
  details.append(summary, body);
  card.append(details);
  return card;
}

let counts = { new: 0 };
function showUnread() {
  el.unread.hidden = false;
  el.unread.textContent = `${counts.new} UNREAD`;
  document.title = counts.new ? `(${counts.new}) Riftborn · Feedback inbox` : 'Riftborn · Feedback inbox';
}
function bumpUnread(was, next) {
  if (was === next) return;
  if (was === 'new') counts.new--;
  if (next === 'new') counts.new++;
  showUnread();
}

// ---- flow ----

function handleError(error) {
  if (error.status === 401) {
    lock('That key was not accepted.');
    return;
  }
  el.status.textContent = error.message;
}

async function load(append = false) {
  if (loading) return;
  loading = true;
  el.refresh.disabled = true;
  el.more.disabled = true;
  if (!append) {
    cursor = null;
    el.status.textContent = 'Loading…';
  }
  try {
    const data = await (await api('/api/feedback' + query({ limit: PAGE, cursor: append ? cursor : null }))).json();
    if (!append) el.list.replaceChildren();
    for (const item of data.items) el.list.append(renderItem(item));
    cursor = data.nextCursor;
    counts = data.counts || counts;
    showUnread();
    el.more.hidden = !cursor;
    const shown = el.list.children.length;
    el.status.textContent = shown ? `Showing ${shown} · ${data.counts?.total ?? shown} total` : 'No feedback matches these filters.';
  } catch (error) {
    handleError(error);
  } finally {
    loading = false;
    el.refresh.disabled = false;
    el.more.disabled = false;
  }
}

async function exportCsv() {
  el.csv.disabled = true;
  try {
    const response = await api('/api/feedback.csv' + query());
    const blob = await response.blob();
    const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'riftborn-feedback.csv';
    const url = URL.createObjectURL(blob);
    const a = node('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    handleError(error);
  } finally {
    el.csv.disabled = false;
  }
}

function lock(message = '') {
  key = '';
  write('sessionStorage', STORE_KEY, '');
  write('localStorage', STORE_KEY, '');
  el.inbox.hidden = true;
  el.lock.hidden = true;
  el.unread.hidden = true;
  el.login.hidden = false;
  el.loginError.textContent = message;
  el.list.replaceChildren();
  el.keyInput.value = '';
  el.keyInput.focus();
}

function unlock() {
  el.login.hidden = true;
  el.inbox.hidden = false;
  el.lock.hidden = false;
  load();
}

el.loginForm.addEventListener('submit', event => {
  event.preventDefault();
  key = el.keyInput.value.trim();
  if (!key) return;
  write('sessionStorage', STORE_KEY, key);
  write('localStorage', STORE_KEY, el.remember.checked ? key : '');
  el.loginError.textContent = '';
  unlock();
});
el.lock.addEventListener('click', () => lock());
el.refresh.addEventListener('click', () => load());
el.more.addEventListener('click', () => load(true));
el.csv.addEventListener('click', exportCsv);
el.filters.addEventListener('submit', event => event.preventDefault());

// Filters persist per device (they are not secret).
try {
  const saved = JSON.parse(read('localStorage', FILTER_KEY) || '{}');
  for (const [name, select] of Object.entries(el.f)) if ([...select.options].some(o => o.value === saved[name])) select.value = saved[name];
} catch { /* ignore */ }
for (const select of Object.values(el.f)) {
  select.addEventListener('change', () => {
    write('localStorage', FILTER_KEY, JSON.stringify(Object.fromEntries(Object.entries(el.f).map(([n, s]) => [n, s.value]))));
    load();
  });
}

if (key) unlock();
else lock();
