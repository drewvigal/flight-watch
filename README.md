# flight-watch

A personal fare-watching dashboard. A GitHub Actions workflow queries Google Flights (through SerpApi) once a day for the routes in `routes.json`, appends the results to `data/history.json`, and publishes a static dashboard with GitHub Pages. No server, no database, no npm dependencies.

## Files

| File | What it is |
|---|---|
| `routes.json` | Your routes, airline ranking and search budget settings. Edit this. |
| `scripts/fetch.mjs` | The fetcher. Reads `SERPAPI_KEY` from the environment or `.env`. |
| `data/history.json` | Fare history, appended on every run. |
| `index.html`, `assets/` | The dashboard. |
| `scripts/serve.mjs` | Local preview server. |
| `.github/workflows/fetch-fares.yml` | Daily schedule, manual trigger, and Pages publish. |

## Run it locally

Requires Node 22 or newer.

```bash
echo "SERPAPI_KEY=paste-your-key-here" > .env   # then put your real key in the file
node scripts/fetch.mjs --dry-run                # list planned searches, spends nothing
node scripts/fetch.mjs                          # fetch for real
node scripts/serve.mjs                          # dashboard at http://localhost:8765
```

`.env` is git-ignored. The key is only ever sent as the `api_key` URL parameter and is scrubbed from all log output.

## Editing routes

You can edit `routes.json` in the browser: open the file on GitHub, click the pencil icon, change the dates, and commit to `main`. The dashboard republishes within a minute or two. Date pairs you add are searched on the next daily run (or straight away if you run the workflow from the Actions tab), whatever their `checkEveryDays` setting.

Before adding dates, check the budget: each date pair costs about `31 / checkEveryDays` searches a month, and the total has to stay under your SerpApi plan's limit. If a run would go over, the fetcher skips it rather than overspend.

Each route in `routes.json` has:

- `origin`, `destinations`: airport codes. Several destinations are searched together in one search.
- `maxStops` (0, 1 or 2) and `preferredStops`.
- `enabled`: set to `false` to pause a route. Paused routes stay in the file and keep their history, and the dashboard lists them so you can turn them back on.
- Dates, one of:
  - `datePairs`: explicit `{ "outbound": "YYYY-MM-DD", "return": "YYYY-MM-DD" }` entries, or
  - `window` (`earliestDeparture`, `latestReturn`) with `tripLengthNights`, optional `departWeekdays` (`"Thu"` etc.) and `maxDatePairs`. The fetcher picks that many date pairs spread evenly across the window and tracks the same ones every day.

  - or `window` (`earliestDeparture`, `latestDeparture`) with `returnDates` and `minNights`: every departure day in the window is paired with each return date.
- `checkEveryDays` (optional): search each of the route's date pairs only every Nth day, staggered across days, so more dates fit in the budget. `node scripts/fetch.mjs --all` searches everything at once.

Date pairs whose outbound date has passed are skipped automatically.

`preferredAirlines` is your ranking, most preferred first, by two-letter airline code.

`watchAirlines` lists airlines that get their own searches, because they rarely make the normal cheapest list. A route's `watchAirlinesOnReturnDates` says which return dates get that extra airline-only search; each one costs a search like any other date pair. The dashboard's Airline selector offers the watched airlines as a group.

## Search budget

Every date pair on an enabled route costs one SerpApi search each time it is checked. The free plan allows 250 a month. The current config tracks 24 Milan date pairs plus 8 Icelandair/Neos-only searches every seventh day, and 3 Bay Area pairs every third day, about 173 searches a month. `node scripts/fetch.mjs --dry-run` prints the count for the current config. Before each run the fetcher checks the account's remaining searches (that check is free) and stops if the run would dip into `settings.monthlySearchReserve`.

## What "mixed airlines" means

An option is flagged as mixed when its outbound journey uses more than one airline. The first search response only describes the outbound journey, with the round-trip total price; looking up the return flights costs an extra search per option, so the return carrier is not checked.
