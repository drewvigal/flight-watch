// Flight watch dashboard. Reads routes.json and data/history.json; no build step.

const $ = (sel, el = document) => el.querySelector(sel);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86400000;

const state = { maxStops: 9, preferredOnly: false, showMixed: true, routes: {} };
let config, history;

// ---------- formatting ----------

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const ymd = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
const shortDate = (s) => { const { m, d } = ymd(s); return `${MONTHS[m - 1]} ${d}`; };
const pairLabel = (p) => `${shortDate(p.outbound)} – ${shortDate(p.return)}`;
const tsDate = (t) => { const d = new Date(t); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const duration = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
const clock = (s) => { const [h, m] = s.slice(11).split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const safeUrl = (u) => (typeof u === 'string' && u.startsWith('https://www.google.com/travel/flights') ? u : null);
const flightsLink = (pair, label, cls) => {
  const href = safeUrl(pair?.url);
  return href && el('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer',
    'aria-label': `${label} for ${pairLabel(pair)}, opens Google Flights` }, label, ' ↗');
};
const stopsText = (n) => (n === 0 ? 'Nonstop' : n === 1 ? '1 stop' : `${n} stops`);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// ---------- preferences ----------

const rankOf = (code) => {
  const i = config.preferredAirlines.findIndex((a) => a.code === code);
  return i === -1 ? 999 : i + 1;
};

const passes = (o) =>
  o.stops <= state.maxStops &&
  (state.showMixed || !o.mixed) &&
  (!state.preferredOnly || rankOf(o.primary) !== 999);

/** Lowest price in one history observation, following the stops and mixed filters. */
function observedLow(obs) {
  if (!obs.lows) return state.maxStops >= 9 && state.showMixed ? obs.lowest : null;
  let best = null;
  for (const [stops, b] of Object.entries(obs.lows)) {
    if (Number(stops) > state.maxStops) continue;
    const v = state.showMixed ? b.any : b.single;
    if (v != null && (best === null || v < best)) best = v;
  }
  return best;
}

// ---------- per-route data ----------

function routeView(route) {
  const ui = (state.routes[route.id] ??= { pair: 'all', sort: 'price', showAll: false });
  const latest = history.latest?.[route.id]?.pairs ?? {};
  const pairs = Object.entries(latest).map(([key, p]) => ({ key, ...p })).sort((a, b) => a.outbound.localeCompare(b.outbound));
  if (ui.pair !== 'all' && !pairs.some((p) => p.key === ui.pair)) ui.pair = 'all';
  const selected = ui.pair === 'all' ? pairs : pairs.filter((p) => p.key === ui.pair);
  const selectedKeys = new Set(selected.map((p) => p.key));

  const options = selected
    .flatMap((p) => p.options.map((o) => ({ ...o, pair: p })))
    .filter(passes);
  options.sort(ui.sort === 'rank'
    ? (a, b) => rankOf(a.primary) - rankOf(b.primary) || a.price - b.price
    : (a, b) => a.price - b.price || rankOf(a.primary) - rankOf(b.primary));
  const cheapest = options.reduce((m, o) => (!m || o.price < m.price ? o : m), null);

  // Our own tracked history: lowest matching fare per day.
  const byDay = new Map();
  for (const obs of history.observations ?? []) {
    if (obs.routeId !== route.id || !selectedKeys.has(`${obs.outbound}_${obs.return}`)) continue;
    const v = observedLow(obs);
    if (v == null) continue;
    const d = new Date(obs.ts);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
    if (!byDay.has(day) || v < byDay.get(day)) byDay.set(day, v);
  }
  const ours = [...byDay].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);

  // Google's own price history for the same searches (any airline).
  const g = new Map();
  for (const p of selected) {
    for (const [sec, price] of p.google?.history ?? []) {
      const t = sec * 1000;
      if (!g.has(t) || price < g.get(t)) g.set(t, price);
    }
  }
  const google = [...g].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);

  const typical = (cheapest?.pair ?? selected[0])?.google?.typical ?? null;
  return { ui, pairs, selected, options, cheapest, ours, google, typical };
}

function priceLevel(view) {
  const price = view.cheapest?.price;
  if (price == null) return null;
  if (view.ours.length >= 7) {
    const sorted = view.ours.map((p) => p.v).sort((a, b) => a - b);
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    const level = price <= q(0.25) ? 'low' : price >= q(0.75) ? 'high' : 'typical';
    return { level, basis: `Compared with your ${view.ours.length} days of tracked prices` };
  }
  const t = view.typical;
  if (t?.length === 2) {
    const level = price < t[0] ? 'low' : price > t[1] ? 'high' : 'typical';
    return { level, basis: `Compared with Google's typical range, ${money(t[0])}–${money(t[1])}, until a week of your own history builds up` };
  }
  return null;
}

// ---------- chart ----------

function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function renderChart(view, width) {
  const { ours, google, typical } = view;
  const all = [...ours, ...google];
  if (!all.length) return el('p', { class: 'empty' }, 'No price history yet.');

  const W = Math.max(280, Math.round(width));
  const H = W < 480 ? 190 : 220;
  const m = { l: 46, r: 52, t: 10, b: 24 };
  let t0 = Math.min(...all.map((p) => p.t));
  let t1 = Math.max(...all.map((p) => p.t));
  if (t1 - t0 < 2 * DAY) { t0 -= DAY; t1 += DAY; }
  let lo = Math.min(...all.map((p) => p.v));
  let hi = Math.max(...all.map((p) => p.v));
  const pad = Math.max((hi - lo) * 0.12, hi * 0.03);
  lo = Math.max(0, lo - pad); hi += pad;
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');

  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': 'Price over time. The options table below lists current fares.' });

  if (typical?.length === 2) {
    const top = Math.min(hi, typical[1]), bottom = Math.max(lo, typical[0]);
    if (top > bottom) root.append(svg('rect', { class: 'band', x: m.l, y: y(top), width: W - m.l - m.r, height: y(bottom) - y(top) }));
  }
  for (const v of niceTicks(lo, hi)) {
    root.append(svg('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    root.append(svg('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, money(v)));
  }
  root.append(svg('line', { class: 'axis', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
  const nx = W < 480 ? 3 : 5;
  for (let i = 0; i < nx; i++) {
    const t = t0 + ((t1 - t0) * i) / (nx - 1);
    root.append(svg('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === nx - 1 ? 'end' : 'middle' }, tsDate(t)));
  }

  if (google.length > 1) root.append(svg('path', { class: 'google', d: line(google) }));
  if (ours.length > 1) root.append(svg('path', { class: 'ours', d: line(ours) }));
  const showDots = ours.length <= 30;
  ours.forEach((p, i) => {
    if (showDots || i === ours.length - 1) root.append(svg('circle', { class: 'ours-dot', cx: x(p.t), cy: y(p.v), r: 4.5 }));
  });
  const lastOurs = ours[ours.length - 1];
  if (lastOurs) root.append(svg('text', { class: 'end-label', x: x(lastOurs.t) + 8, y: y(lastOurs.v) + 4 }, money(lastOurs.v)));

  // Hover / touch: crosshair plus tooltip with both series.
  const cross = svg('line', { class: 'cross', y1: m.t, y2: H - m.b, visibility: 'hidden' });
  root.append(cross);
  const tip = $('#tip');
  const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  const near = (pts, t) => {
    const p = pts.reduce((b, q) => (!b || Math.abs(q.t - t) < Math.abs(b.t - t) ? q : b), null);
    return p && Math.abs(p.t - t) <= 1.5 * DAY ? p : null;
  };
  const move = (ev) => {
    const box = root.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const t = times.reduce((b, q) => (Math.abs(x(q) - px) < Math.abs(x(b) - px) ? q : b), times[0]);
    cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t)); cross.setAttribute('visibility', 'visible');
    const a = near(ours, t), b = near(google, t);
    tip.replaceChildren(
      el('div', {}, tsDate(t)),
      a && el('div', {}, 'Tracked: ', el('b', {}, money(a.v))),
      b && el('div', {}, 'Google: ', el('b', {}, money(b.v))),
    );
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, ev.clientX + 12)) + 'px';
    tip.style.top = Math.max(8, box.top + 8) + 'px';
  };
  const leave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerdown', move);
  root.addEventListener('pointerleave', leave);
  root.addEventListener('pointercancel', leave);
  return root;
}

// ---------- route card ----------

function airlineCell(o) {
  const rank = rankOf(o.primary);
  return el('td', { class: 'airline' },
    o.airlines.map((a) => a.name).join(' + '),
    rank !== 999 && el('span', { class: 'badge rank', title: 'Your airline ranking' }, `#${rank} pick`),
    o.mixed && el('span', { class: 'badge mixed' }, 'Mixed airlines'),
  );
}

function renderTable(view, rerender) {
  const { ui, options } = view;
  const allDates = view.selected.length > 1;
  const shown = ui.showAll ? options : options.slice(0, 8);
  const sortBtn = (key, label) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(ui.sort === key),
    onclick: () => { ui.sort = key; rerender(); },
  }, label);

  const head = el('div', { class: 'table-head' },
    el('h3', {}, `Current best options (${options.length})`),
    el('div', { class: 'sort' }, 'Sort by', sortBtn('price', 'Price'), sortBtn('rank', 'My airlines')),
  );
  if (!options.length) {
    return el('div', {}, head, el('p', { class: 'empty' }, 'No current fares match these filters. Try allowing more stops or mixed airlines.'));
  }
  const table = el('table', { class: 'options' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Airline(s)'), el('th', {}, 'Stops'), el('th', {}, 'Total time'),
      allDates && el('th', {}, 'Dates'), el('th', { class: 'price' }, 'Price'))),
    el('tbody', {}, shown.map((o) => el('tr', {},
      airlineCell(o),
      el('td', { class: 'stops' }, stopsText(o.stops), el('div', { class: 'path' }, o.path.join(' → ') + (o.depart ? ' · departs ' + clock(o.depart) : ''))),
      el('td', { class: 'dur' }, duration(o.durationMin)),
      allDates && el('td', { class: 'dates' }, pairLabel(o.pair)),
      el('td', { class: 'price' }, money(o.price), flightsLink(o.pair, 'Book', 'book')),
    ))),
  );
  const more = options.length > 8 && el('button', {
    type: 'button', class: 'more', onclick: () => { ui.showAll = !ui.showAll; rerender(); },
  }, ui.showAll ? 'Show fewer' : `Show all ${options.length}`);
  return el('div', {}, head, table, more);
}

function renderRoute(route, card) {
  const view = routeView(route);
  const rerender = () => renderRoute(route, card);
  const { ui, pairs, cheapest, ours, google } = view;

  const sub = `${route.origin.join('/')} to ${route.destinations.join(', ')} · round trip · up to ${stopsText(route.maxStops).toLowerCase()}`;
  if (!pairs.length) {
    card.replaceChildren(el('h2', {}, route.name), el('p', { class: 'sub' }, sub),
      el('p', { class: 'empty' }, 'No fares fetched yet for upcoming dates on this route.'));
    return;
  }

  const chip = (key, label) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(ui.pair === key),
    onclick: () => { ui.pair = key; ui.showAll = false; rerender(); },
  }, label);
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Travel dates' },
    pairs.length > 1 && chip('all', 'All dates'), pairs.map((p) => chip(p.key, pairLabel(p))));

  const level = priceLevel(view);
  const arrows = { low: '↓ Low', typical: '→ Typical', high: '↑ High' };
  const nowTile = el('div', { class: 'tile' },
    el('div', { class: 'label' }, 'Cheapest now'),
    cheapest
      ? [el('div', { class: 'value' }, money(cheapest.price), ' ', level && el('span', { class: `badge ${level.level}` }, arrows[level.level])),
         el('div', { class: 'detail' }, `${cheapest.airlines.map((a) => a.name).join(' + ')} · ${stopsText(cheapest.stops)} · ${pairLabel(cheapest.pair)}`),
         level && el('div', { class: 'basis' }, level.basis),
         flightsLink(cheapest.pair, 'View on Google Flights', 'book tile-link')]
      : el('div', { class: 'detail' }, 'No fares match these filters.'),
  );

  const low = ours.reduce((m, p) => (!m || p.v < m.v ? p : m), null);
  const gLow = google.reduce((m, p) => (!m || p.v < m.v ? p : m), null);
  const lowTile = el('div', { class: 'tile' },
    el('div', { class: 'label' }, 'Lowest seen'),
    low
      ? [el('div', { class: 'value' }, money(low.v)),
         el('div', { class: 'detail' }, `on ${tsDate(low.t)} · ${ours.length} day${ours.length === 1 ? '' : 's'} tracked`)]
      : el('div', { class: 'detail' }, 'No tracked prices match these filters yet.'),
    gLow && (!low || gLow.v < low.v) && el('div', { class: 'basis' }, `Google's 60-day low: ${money(gLow.v)} on ${tsDate(gLow.t)}`),
  );

  const chartWrap = el('div', { class: 'chart-wrap' },
    el('p', { class: 'chart-title' }, 'Price over time'),
    el('div', { class: 'legend' },
      el('span', {}, el('i', { style: 'border-color: var(--series-1)' }), 'Tracked by this dashboard'),
      google.length > 1 && el('span', {}, el('i', { style: 'border-color: var(--context)' }), "Google's price history"),
      view.typical && el('span', {}, el('i', { class: 'band' }), "Google's typical range"),
    ),
  );

  card.replaceChildren(...[
    el('h2', {}, route.name), el('p', { class: 'sub' }, sub),
    chips, el('div', { class: 'tiles' }, nowTile, lowTile), chartWrap,
    state.preferredOnly && el('p', { class: 'basis muted' }, 'The chart includes all airlines; the airline filter applies to the tile and table.'),
    renderTable(view, rerender),
  ].filter(Boolean));
  chartWrap.append(renderChart(view, chartWrap.clientWidth));
}

// ---------- page ----------

function renderAll() {
  const main = $('#routes');
  main.replaceChildren();
  for (const route of config.routes.filter((r) => r.enabled)) {
    const card = el('section', { class: 'route' });
    main.append(card);
    renderRoute(route, card);
  }
  const paused = config.routes.filter((r) => !r.enabled);
  const box = $('#paused');
  box.hidden = !paused.length;
  if (paused.length) {
    box.replaceChildren(
      el('h2', {}, 'Paused routes'),
      el('ul', {}, paused.map((r) => {
        const obs = (history.observations ?? []).filter((o) => o.routeId === r.id);
        const last = obs[obs.length - 1];
        const low = obs.reduce((m, o) => (!m || o.lowest < m.lowest ? o : m), null);
        return el('li', {}, el('b', {}, r.name), ' ',
          last ? `last checked ${tsDate(last.ts)} at ${money(last.lowest)}; lowest seen ${money(low.lowest)}. ` : 'never checked. ',
          'To resume, set ', el('code', {}, '"enabled": true'), ' for ', el('code', {}, r.id), ' in routes.json.');
      })),
    );
  }
}

function readFilters() {
  state.maxStops = Number($('#f-stops').value);
  state.preferredOnly = $('#f-preferred').checked;
  state.showMixed = $('#f-mixed').checked;
  try { localStorage.setItem('fw-filters', JSON.stringify({ s: state.maxStops, p: state.preferredOnly, m: state.showMixed })); } catch {}
  renderAll();
}

async function start() {
  try {
    const get = (url) => fetch(url, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); });
    [config, history] = await Promise.all([get('routes.json'), get('data/history.json')]);
  } catch (e) {
    $('#updated').textContent = 'Could not load fare data. ' + e.message;
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem('fw-filters') ?? 'null');
    if (saved) { $('#f-stops').value = String(saved.s); $('#f-preferred').checked = !!saved.p; $('#f-mixed').checked = saved.m !== false; }
  } catch {}
  const names = config.preferredAirlines.map((a) => a.name).join(', ');
  $('#f-preferred').parentElement.title = 'Your ranking: ' + names;
  $('#updated').textContent = history.updatedAt
    ? 'Fares last checked ' + new Date(history.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'No fares fetched yet.';
  $('#filters').addEventListener('change', readFilters);
  let timer;
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(renderAll, 150); });
  readFilters();
}

start();
