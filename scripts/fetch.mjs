#!/usr/bin/env node
// Fetches fares for the enabled routes in routes.json from SerpApi's Google
// Flights API and appends them to data/history.json.
//
//   node scripts/fetch.mjs             run all enabled routes
//   node scripts/fetch.mjs --dry-run   show what would be searched, spend nothing
//   node scripts/fetch.mjs --route ID  only one route
//   node scripts/fetch.mjs --limit N   at most N searches
//   node scripts/fetch.mjs --all       search every date pair now, ignoring checkEveryDays
//
// The key comes from the SERPAPI_KEY environment variable (.env locally, a
// repository secret in GitHub Actions). It is only ever sent as the api_key
// URL parameter and is never logged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_FILE = path.join(ROOT, 'routes.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'history.json');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- small helpers ----------

function loadDotEnv() {
  if (process.env.SERPAPI_KEY) return;
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** Remove the key from anything we are about to print. */
function scrub(text) {
  const key = process.env.SERPAPI_KEY;
  let out = String(text).replace(/api_key=[^&\s"']+/g, 'api_key=REDACTED');
  if (key) out = out.split(key).join('REDACTED');
  return out;
}

const log = (...a) => console.log(scrub(a.join(' ')));
const fail = (msg) => { console.error(scrub(msg)); process.exit(1); };

const toDate = (s) => new Date(s + 'T00:00:00Z');
const fmtDate = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1] ?? true;
}

// ---------- which date pairs to search ----------

/**
 * A route either lists explicit datePairs, or gives a window plus trip
 * lengths and we pick maxDatePairs of them, evenly spread. The pick is made
 * over the whole window (not just future dates) so the same dates are
 * tracked day after day; pairs whose outbound date has passed are dropped.
 * A route with returnDates instead tracks every departure day in its window
 * against each of those return dates.
 */
export function datePairsFor(route, today) {
  let pairs;
  if (Array.isArray(route.datePairs) && route.datePairs.length) {
    pairs = route.datePairs.map((p) => ({ outbound: p.outbound, return: p.return }));
  } else if (route.returnDates?.length && route.window) {
    // Grid: every departure day in the window, paired with each return date.
    const minNights = route.minNights ?? 1;
    pairs = [];
    const lastOut = toDate(route.window.latestDeparture);
    for (let d = toDate(route.window.earliestDeparture); d <= lastOut; d = addDays(d, 1)) {
      for (const back of route.returnDates) {
        if ((toDate(back) - d) / 86400000 >= minNights) pairs.push({ outbound: fmtDate(d), return: back });
      }
    }
  } else {
    const w = route.window;
    if (!w) return [];
    const nights = route.tripLengthNights?.length ? route.tripLengthNights : [7];
    const days = route.departWeekdays?.length ? route.departWeekdays : WEEKDAYS;
    const last = toDate(w.latestReturn);
    const candidates = [];
    for (let d = toDate(w.earliestDeparture), i = 0; d <= last; d = addDays(d, 1)) {
      if (!days.includes(WEEKDAYS[d.getUTCDay()])) continue;
      const back = addDays(d, nights[i % nights.length]);
      if (back <= last) candidates.push({ outbound: fmtDate(d), return: fmtDate(back) });
      i++;
    }
    const k = Math.min(route.maxDatePairs ?? 3, candidates.length);
    pairs = Array.from({ length: k }, (_, i) => candidates[Math.floor(((i + 0.5) * candidates.length) / k)]);
  }
  return pairs.filter((p) => p.outbound >= today);
}

// ---------- SerpApi ----------

async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error('Network error: ' + scrub(e.message));
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: response was not JSON`); }
  return { status: res.status, json };
}

async function getAccount(key) {
  const { status, json } = await getJson('https://serpapi.com/account.json?api_key=' + encodeURIComponent(key));
  if (status !== 200 || json.error) throw new Error('Account check failed: ' + (json.error ?? 'HTTP ' + status));
  return json;
}

async function searchFlights(key, route, pair, currency) {
  // stops: 0 any, 1 nonstop only, 2 one stop or fewer, 3 two stops or fewer
  const stops = route.maxStops === 0 ? 1 : route.maxStops === 1 ? 2 : route.maxStops === 2 ? 3 : 0;
  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: route.origin.join(','),
    arrival_id: route.destinations.join(','),
    outbound_date: pair.outbound,
    return_date: pair.return,
    type: '1',
    stops: String(stops),
    currency,
    hl: 'en',
    gl: 'us',
    api_key: key,
  });
  const { status, json } = await getJson('https://serpapi.com/search?' + params);
  if (json.error) return { error: json.error };
  if (status !== 200) return { error: 'HTTP ' + status };
  return { json };
}

// ---------- parsing ----------

function parseOption(it, isTop) {
  const segs = it.flights ?? [];
  if (!segs.length || typeof it.price !== 'number') return null;
  const airlines = [];
  for (const s of segs) {
    const code = (s.flight_number ?? '').split(' ')[0] || s.airline;
    if (!airlines.some((a) => a.code === code)) airlines.push({ code, name: s.airline });
  }
  const longest = segs.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a));
  const last = segs[segs.length - 1];
  return {
    price: it.price,
    airlines,
    primary: (longest.flight_number ?? '').split(' ')[0] || longest.airline,
    mixed: airlines.length > 1,
    stops: segs.length - 1,
    durationMin: it.total_duration ?? segs.reduce((n, s) => n + (s.duration ?? 0), 0),
    path: [segs[0].departure_airport?.id, ...segs.map((s) => s.arrival_airport?.id)],
    dest: last.arrival_airport?.id,
    depart: segs[0].departure_airport?.time,
    arrive: last.arrival_airport?.time,
    layovers: (it.layovers ?? []).map((l) => ({ id: l.id, min: l.duration, ...(l.overnight ? { overnight: true } : {}) })),
    flightNumbers: segs.map((s) => s.flight_number),
    top: isTop,
  };
}

export function parseResponse(json) {
  const options = [
    ...(json.best_flights ?? []).map((it) => parseOption(it, true)),
    ...(json.other_flights ?? []).map((it) => parseOption(it, false)),
  ].filter(Boolean).sort((a, b) => a.price - b.price);

  // Lowest price by exact stop count, with and without mixed-airline options,
  // so the chart can follow the dashboard's filters.
  const lows = {};
  for (const o of options) {
    const b = (lows[o.stops] ??= {});
    if (b.any === undefined || o.price < b.any) b.any = o.price;
    if (!o.mixed && (b.single === undefined || o.price < b.single)) b.single = o.price;
  }

  const pi = json.price_insights ?? {};
  const google = {
    lowest: pi.lowest_price ?? null,
    level: pi.price_level ?? null,
    typical: Array.isArray(pi.typical_price_range) ? pi.typical_price_range : null,
    history: Array.isArray(pi.price_history) ? pi.price_history.filter((p) => p.length === 2) : [],
  };
  // Link to the same search on Google Flights, for buying.
  const link = json.search_metadata?.google_flights_url;
  const url = typeof link === 'string' && link.startsWith('https://www.google.com/travel/flights') ? link : null;
  return { options, lows, google, url };
}

// ---------- main ----------

async function main() {
  loadDotEnv();
  const dryRun = process.argv.includes('--dry-run');
  const onlyRoute = arg('--route');
  const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;

  const config = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
  const settings = { currency: 'USD', maxSearchesPerRun: 8, keepOptionsPerDatePair: 12, monthlySearchReserve: 10, ...config.settings };
  const today = fmtDate(new Date());

  // A route with checkEveryDays: N has each of its date pairs searched every
  // Nth day, staggered so the work is spread evenly. --all ignores that.
  const everything = process.argv.includes('--all');
  const dayNumber = Math.floor(Date.now() / 86400000);
  const jobs = [];
  const tracked = {};
  let perMonth = 0;
  for (const route of config.routes) {
    if (!route.enabled) continue;
    const every = Math.max(1, route.checkEveryDays ?? 1);
    const pairs = datePairsFor(route, today);
    tracked[route.id] = new Set(pairs.map((p) => `${p.outbound}_${p.return}`));
    perMonth += (pairs.length / every) * 31;
    if (onlyRoute && route.id !== onlyRoute) continue;
    pairs.forEach((pair, i) => {
      if (everything || (dayNumber + i) % every === 0) jobs.push({ route, pair });
    });
  }
  const cap = everything ? limit : Math.min(limit, settings.maxSearchesPerRun);
  const planned = jobs.slice(0, cap);

  log(`Planned searches this run: ${planned.length}` + (jobs.length > planned.length ? ` (of ${jobs.length}; capped)` : ''));
  for (const j of planned) log(`  ${j.route.id}  ${j.pair.outbound} to ${j.pair.return}`);
  log(`At one run a day the current config uses about ${Math.round(perMonth)} searches a month.`);

  if (dryRun) return;
  if (!planned.length) { log('Nothing to search.'); return; }

  const key = process.env.SERPAPI_KEY;
  if (!key || key.includes('paste-your-key')) fail('SERPAPI_KEY is not set. Put it in .env locally or in the repository secret.');

  const account = await getAccount(key);
  const left = account.total_searches_left ?? 0;
  log(`SerpApi: ${left} of ${account.searches_per_month} searches left this month.`);
  if (left - settings.monthlySearchReserve < planned.length) {
    fail(`Not enough searches left (${left}, keeping ${settings.monthlySearchReserve} in reserve). Skipping this run.`);
  }

  const history = fs.existsSync(HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    : { version: 1, updatedAt: null, observations: [], latest: {} };

  let ok = 0;
  for (const { route, pair } of planned) {
    const ts = new Date().toISOString();
    let result;
    try {
      result = await searchFlights(key, route, pair, settings.currency);
    } catch (e) {
      result = { error: e.message };
    }
    if (result.error) {
      log(`  FAILED ${route.id} ${pair.outbound}: ${result.error}`);
      continue;
    }
    const { options, lows, google, url } = parseResponse(result.json);
    if (!options.length) {
      log(`  no fares returned for ${route.id} ${pair.outbound}`);
      continue;
    }
    const cheapest = options[0];
    history.observations.push({
      ts,
      routeId: route.id,
      outbound: pair.outbound,
      return: pair.return,
      lowest: cheapest.price,
      lows,
      googleLevel: google.level,
      googleTypical: google.typical,
      cheapest: { airlines: cheapest.airlines.map((a) => a.name), stops: cheapest.stops, mixed: cheapest.mixed, dest: cheapest.dest },
    });
    const slot = (history.latest[route.id] ??= { pairs: {} });
    slot.fetchedAt = ts;
    slot.pairs[`${pair.outbound}_${pair.return}`] = {
      outbound: pair.outbound,
      return: pair.return,
      fetchedAt: ts,
      options: options.slice(0, settings.keepOptionsPerDatePair),
      google,
      url,
    };
    ok++;
    log(`  ${route.id} ${pair.outbound} to ${pair.return}: from $${cheapest.price} (${options.length} options)`);
  }

  // Drop "latest" date pairs that have passed or are no longer tracked.
  for (const [routeId, slot] of Object.entries(history.latest)) {
    for (const [k, p] of Object.entries(slot.pairs)) {
      if (p.outbound < today || (tracked[routeId] && !tracked[routeId].has(k))) delete slot.pairs[k];
    }
  }

  if (ok) {
    history.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 1) + '\n');
  }
  log(`Saved ${ok} of ${planned.length} searches to data/history.json.`);
  if (!ok) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail('Fetch failed: ' + e.message));
}
