// Riftborn stats page (https://feedback.riftborn.us/metrics/, the inbox's origin): reads the leaderboard Worker's
// GET /api/admin/stats with the same admin key as the inbox. The key never leaves this page except as the
// Authorization header to API below. It lives in sessionStorage only (this tab; closing it forgets the key); a
// copy an older page kept in localStorage is deleted as the page starts. A refused key (401) is wiped.
// Every number comes from the Worker's counters and is only ever shown with textContent; SVG is built with
// createElementNS and setAttribute, styled by class only. The page has a strict CSP (the _headers of
// feedback.riftborn.us, and index.html's own meta policy).
import { BAR_BOX, DEFINITIONS, FIGURE_LABELS, TREND_BOX, barGeometry, buildView, formatChange, formatNumber, parseStats, toCsv, trendGeometry } from './chart.js';

const API = 'https://api.riftborn.us';
// Where this page lives (any other copy cannot reach the Worker: CORS).
const HOMES = ['feedback.riftborn.us'];
const STORE_KEY = 'riftborn-feedback-admin-key';

const $ = selector => document.querySelector(selector);
const el = {
  login: $('#login'), loginForm: $('#loginForm'), keyInput: $('#keyInput'), loginError: $('#loginError'),
  stats: $('#stats'), status: $('#status'), lock: $('#lock'), refresh: $('#refresh'), csv: $('#csv'),
  tableToggle: $('#tableToggle'), trendSeries: $('#trendSeries'), charts: $('#charts'), tables: $('#tables'),
  health: $('#health'), trend: $('#trend'), funnel: $('#funnel'), definitions: $('#definitions'),
  bars: { length: $('#lengths'), character: $('#characters'), weapon: $('#weapons'), device: $('#devices'), version: $('#versions') }
};

const storage = kind => { try { return window[kind]; } catch { return null; } };
const read = (kind, key) => { try { return storage(kind)?.getItem(key) || ''; } catch { return ''; } };
const write = (kind, key, value) => { try { value ? storage(kind)?.setItem(key, value) : storage(kind)?.removeItem(key); } catch { /* storage blocked */ } };

// Older pages could keep the key in localStorage: never read, always deleted.
write('localStorage', STORE_KEY, '');
let key = read('sessionStorage', STORE_KEY);
let loading = false;
const RANGE_KEY = 'riftborn-stats-range'; // the chosen range: not secret, so localStorage
const RANGES = ['7', '30', '90', 'all'];
// The earlier period's change figures come from one wider request: 7 days from the last 30, 30 from 90, 90 from all.
const COMPARE = { 7: 30, 30: 90, 90: 'all' };
const SVG = 'http://www.w3.org/2000/svg';
let range = RANGES.includes(read('localStorage', RANGE_KEY)) ? read('localStorage', RANGE_KEY) : '30';
let series = 'players';
let sequence = 0;
let view = null;

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

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/** An SVG element: createElementNS and setAttribute only; looks come from classes. */
function svgEl(tag, attrs = {}) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  return element;
}

// ---- data ----

async function fetchStats(rangeName) {
  const response = await api('/api/admin/stats?range=' + encodeURIComponent(rangeName));
  return parseStats(await response.json());
}

// ---- drawing ----

const percent = value => `${formatNumber(value * 100, 1)}%`;
const nothing = (host, text) => host.replaceChildren(node('p', 'nodata', text));

function renderFigures(v) {
  for (const figure of v.figures) {
    const card = $(`[data-figure="${figure.id}"]`);
    if (!card) continue;
    card.querySelector('.kpi-label').textContent = FIGURE_LABELS[figure.id] || figure.id;
    card.querySelector('.kpi-value').textContent = figure.value === null ? '—' : figure.id === 'winRate' ? percent(figure.value) : formatNumber(figure.value);
    const delta = card.querySelector('.delta');
    let text = '', tone = 'flat';
    if (figure.id === 'accounts') text = 'today, all time';
    else if (v.comparison === 'ok' && figure.change) {
      text = `${formatChange(figure.change)} vs previous ${v.range === 'all' ? 'period' : v.range + ' days'}`;
      tone = figure.change.value > 0 ? 'up' : figure.change.value < 0 ? 'down' : 'flat';
    } else if (String(v.range) === 'all') text = 'whole history';
    else text = 'no earlier period yet';
    delta.textContent = text;
    delta.className = 'delta ' + tone;
  }
}

function renderTrend(v, seriesName) {
  const days = [...v.trend.complete, v.trend.todayRow];
  if (!v.trend.complete.length && !v.trend.todayRow.runs && !v.trend.todayRow.players) return nothing(el.trend, 'Nothing counted in this period yet.');
  const geometry = trendGeometry(days, seriesName, TREND_BOX, { partialLast: true });
  const { width, height, margin } = TREND_BOX;
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Daily counts over the chosen period' });
  for (const tick of geometry.yTicks) {
    svg.append(svgEl('line', { class: 's-grid', x1: margin.left, x2: width - margin.right, y1: tick.y, y2: tick.y }));
    const label = svgEl('text', { class: 's-axis', x: margin.left - 6, y: tick.y + 4, 'text-anchor': 'end' });
    label.textContent = tick.label;
    svg.append(label);
  }
  geometry.xTicks.forEach((tick, i) => {
    const label = svgEl('text', { class: 's-axis', x: tick.x, y: height - 8, 'text-anchor': i === geometry.xTicks.length - 1 && i > 0 ? 'end' : 'middle' });
    label.textContent = tick.label;
    svg.append(label);
  });
  if (geometry.line) {
    const first = geometry.points[0], lastComplete = geometry.points[geometry.points.length - 2] || geometry.points[0];
    svg.append(svgEl('path', { class: 's-area', d: `${geometry.line}L${lastComplete.x} ${height - margin.bottom}L${first.x} ${height - margin.bottom}Z` }));
    svg.append(svgEl('path', { class: 's-line', d: geometry.line }));
  }
  if (geometry.partialLine) svg.append(svgEl('path', { class: 's-partial', d: geometry.partialLine }));
  el.trend.replaceChildren(svg);
}

/** Horizontal bars: label left, bar, count and share right. extras[dim] = { drop, note } (the funnel's biggest loss and its percentage). */
function renderBars(host, rows, extras = {}, box = BAR_BOX) {
  if (!rows.length || rows.every(row => !row.n)) return nothing(host, 'Nothing counted yet.');
  const geometry = barGeometry(rows, box);
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${box.width} ${geometry.height}`, role: 'img', 'aria-label': 'Counts by group' });
  for (const bar of geometry.bars) {
    const extra = extras[bar.dim] || {};
    const label = svgEl('text', { class: 's-label', x: 0, y: bar.y + bar.height / 2 + 4 });
    label.textContent = bar.label;
    svg.append(label);
    svg.append(svgEl('rect', { class: extra.drop ? 's-drop' : 's-bar', x: bar.x, y: bar.y, width: Math.max(0, bar.width), height: bar.height }));
    const value = svgEl('text', { class: 's-value', x: box.width, y: bar.y + bar.height / 2 + 4, 'text-anchor': 'end' });
    value.textContent = `${formatNumber(bar.n)}  ${percent(bar.share)}${extra.note ? '  ' + extra.note : ''}`;
    svg.append(value);
  }
  host.replaceChildren(svg);
}

function renderFunnel(v) {
  const rows = v.funnel.map(step => ({ dim: String(step.stage), label: `Stage ${step.stage}`, n: step.reached, share: step.share }));
  const extras = {};
  for (const step of v.funnel) extras[String(step.stage)] = { drop: step.biggestDrop, note: step.lostShare === null ? '' : `-${formatNumber(step.lostShare * 100, 0)}%` };
  renderBars(el.funnel, rows, extras, { ...BAR_BOX, valueWidth: 170 });
}

function renderHealth(v) {
  const last = node('p', 'line');
  last.append('Last report received: ');
  last.append(node('b', v.health.stale ? 'bad' : '', v.health.last));
  const lines = [last];
  const { used, limit, state } = v.health.ceiling;
  const budget = node('p', 'line');
  budget.append("Today's counting: ");
  budget.append(node('b', state === 'ok' ? '' : 'bad', `${formatNumber(used)} of ${formatNumber(limit)} writes used`));
  lines.push(budget);
  if (state === 'full') lines.push(node('p', 'line', 'Counting stopped for today: the daily write limit was reached, so today is incomplete.'));
  else if (state === 'high') lines.push(node('p', 'line', 'Close to the daily write limit.'));
  el.health.replaceChildren(...lines);
}

function renderTables(v) {
  const cards = v.tables.map(table => {
    const card = node('section', 'card');
    card.append(node('h2', '', table.title));
    const grid = node('table');
    const head = node('tr');
    for (const name of table.head) head.append(node('th', '', name));
    const thead = node('thead');
    thead.append(head);
    const body = node('tbody');
    for (const row of table.rows) {
      const tr = node('tr');
      for (const cell of row) tr.append(node('td', '', typeof cell === 'number' ? formatNumber(cell) : String(cell)));
      body.append(tr);
    }
    grid.append(thead, body);
    card.append(grid);
    return card;
  });
  el.tables.replaceChildren(...cards);
}

function renderDefinitions() {
  const byId = Object.fromEntries(DEFINITIONS.map(item => [item.id, item]));
  for (const holder of document.querySelectorAll('[data-def]')) holder.textContent = byId[holder.dataset.def]?.text || '';
  const rows = [];
  for (const item of DEFINITIONS) rows.push(node('dt', '', item.title), node('dd', '', item.text));
  el.definitions.replaceChildren(...rows);
}

function render(v) {
  renderFigures(v);
  renderTrend(v, series);
  renderFunnel(v);
  for (const name of ['length', 'character', 'weapon', 'device', 'version']) renderBars(el.bars[name], v.breakdowns[name]);
  renderHealth(v);
  renderTables(v);
}

function showTables(on) {
  el.tables.hidden = !on;
  el.charts.hidden = on;
  el.tableToggle.setAttribute('aria-pressed', String(on));
  el.tableToggle.textContent = on ? 'CHART VIEW' : 'TABLE VIEW';
}

function markRange() {
  for (const button of document.querySelectorAll('button[data-range]')) button.setAttribute('aria-pressed', String(button.dataset.range === range));
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

/** Loads the chosen range, then the wider request for the change figures; a newer call drops this one's answer. */
async function load() {
  const mine = ++sequence;
  loading = true;
  el.refresh.disabled = true;
  el.status.textContent = '';
  try {
    const main = await fetchStats(range);
    if (mine !== sequence) return;
    let compare = null;
    if (COMPARE[range]) {
      try {
        compare = await fetchStats(COMPARE[range]);
      } catch (error) {
        if (error.status === 401) throw error;
        compare = null; // only the change figures go
      }
      if (mine !== sequence) return;
    }
    view = buildView({ main, compare, range, nowMs: Date.now() });
    render(view);
  } catch (error) {
    if (mine === sequence) handleError(error);
  } finally {
    if (mine === sequence) {
      loading = false;
      el.refresh.disabled = false;
    }
  }
}

function exportCsv() {
  if (!view) return;
  const blob = new Blob([toCsv(view.csv)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = node('a');
  a.href = url;
  a.download = `riftborn-stats-${range}-${view.today}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function lock(message = '') {
  key = '';
  sequence++; // an answer still on its way is dropped
  view = null;
  write('sessionStorage', STORE_KEY, '');
  el.stats.hidden = true;
  el.lock.hidden = true;
  el.login.hidden = false;
  el.loginError.textContent = message;
  for (const host of [el.trend, el.funnel, el.tables, el.health, ...Object.values(el.bars)]) host.replaceChildren();
  el.keyInput.value = '';
  el.keyInput.focus();
}

function unlock() {
  el.login.hidden = true;
  el.stats.hidden = false;
  el.lock.hidden = false;
  load();
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
el.refresh.addEventListener('click', () => load());
el.csv.addEventListener('click', exportCsv);
el.tableToggle.addEventListener('click', () => showTables(el.tables.hidden));
el.trendSeries.addEventListener('change', () => {
  series = el.trendSeries.value;
  if (view) renderTrend(view, series);
});
for (const button of document.querySelectorAll('button[data-range]')) {
  button.addEventListener('click', () => {
    range = button.dataset.range;
    write('localStorage', RANGE_KEY, range);
    markRange();
    load();
  });
}

renderDefinitions();
markRange();
if (key) unlock();
else lock();
