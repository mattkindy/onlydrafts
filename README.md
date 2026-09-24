# depth-chart

A weekly fantasy football projection model, and a phone-first web page
that shows what it says. The page is published from `docs/` on GitHub
Pages under the name onlydrafts.

Two things live here. One is the model: a simulation that starts at a
single play and builds drives, games and seasons out of it, plus the
weekly ridge and the Sleeper blend that sit beside it. The other is the
site: a draft board, a weekly start-or-sit board, waivers, matchups and
standings, all of it static JSON written at build time so the page needs
no server.

`src/README.md` is where the model is described. It is the place to read
before changing anything under `src/`.

## Layout

```
src/         the model: features, fits, simulation, scoring, metrics
app/         the Preact page vite builds into docs/
scripts/     entry points for the weekly refresh, plus the benches
data/        curated inputs (data/raw is downloaded and gitignored)
docs/        the built site, and the write-ups the site links to
worker/      a Cloudflare worker that reads private ESPN leagues
```

`src/` splits further: `features/` and `model/` contain the fits and the
walk, `data/` the loaders, `sim/` the season and lineup simulation,
`scoring/` the fantasy point formulas, `backtest/` the metrics, and
`graph/` the node and edge types.

## Getting started

Use the Node version in `.nvmrc`. Then install, and download the
nflverse files the model reads:

```
npm install
npx tsx scripts/fetchData.ts --seasons 2015-2025 --no-plays
npm run typecheck
npm test
```

The files land in `data/raw/`, which stays out of git. The weekly model
trains on every season from 2016, and each of those reads the season
before it, so the download starts at 2015 and ends at the last finished
season. `--no-plays` leaves out the per-play files, about 1.2 GB, which
only the `aggregate*.ts` scripts and some benches read. `npm run week`
downloads the season being played, plays included.

`npm test` runs vitest over everything, `src/` and `app/` alike. Tests
that read `data/raw/` skip themselves when it is missing and say so.
`npm run typecheck` checks the node code, the app, the scripts that
import from the app, and the worker, since each has its own tsconfig.

## The weekly refresh

```
npm run week
```

That is `scripts/week.ts`, and it runs six steps in order:

1. `fetchData.ts` pulls this season's nflverse files again, forced, so a
   week that has since been played comes back.
2. `fetchSleeperProjections.ts` pulls Sleeper's projections for the
   season.
3. `aggregateTouches.ts` recounts the season's touches into
   `data/curated/touches.csv`.
4. `aggregateLeverage.ts` counts the same touches again by leverage,
   which the board's sleeper score reads.
5. `fetchWeather.ts` pulls the forecast for the season's outdoor games
   into `data/curated/weatherWeekly.csv`.
6. `buildSite.ts` writes the site.

A GitHub Actions workflow runs the same thing on Tuesday and Sunday
mornings and commits the result. Another typechecks and tests every
push to `main` and every pull request.

It picks the current season on its own. Pass `--season` to override it,
and anything else you pass goes through to `buildSite.ts`:

```
npx tsx scripts/week.ts --season 2026 --league <sleeper id> --weeks 10-12
```

## Building and serving the site

`buildSite.ts` writes the prediction JSON into `docs/data/`: a board per
season, a slate per week, an `index.json` saying which weeks exist, and
the simulation tables the live pages play a game out with. Then it
typechecks the app and runs `npx vite build`, which builds `app/` into
`docs/` with the hashed assets. Stale assets from earlier builds are
dropped at the end.

To build the page on its own, without redoing the predictions:

```
npx vite build
```

To work on the page against the JSON already in `docs/`:

```
npx vite
```

There is also `npx tsx scripts/serve.ts`, a local server on port 3210
that trains the weekly model once and then returns predictions and
Sleeper league rosters, and `scripts/start.ts`, which prints the
start-or-sit comparison for named players at the terminal:

```
npx tsx scripts/start.ts --season 2025 --week 10 "st. brown" "nacua"
```

## Where the rest of the writing is

- `src/README.md`: how the model is put together, level by level, what
  is still doubled up, and which bench measured each constant in it.
- `docs/scoreboard.md`: the bench log. Every change that moved a number,
  in the order it landed, scored on the same three instruments.
- `data/curated/README.md`: what each curated file is, which ones a
  script reproduces, and which are compiled by hand.
- `scripts/README.md`: findings from the benches, and a guide to which
  scripts are entry points.
- `worker/README.md`: the ESPN worker and why it exists.
- `BACKLOG.md`: what is designed but not built.

## Data

nflverse publishes weekly player stats, rosters, schedules, depth charts
and play-by-play as flat files. `scripts/fetchData.ts` downloads them to
`data/raw/`.

Coaching staffs have no flat-file source, so they are curated by hand in
`data/curated/coaches.csv` (head coaches and offensive coordinators) and
`data/curated/coordinators.csv`. Both are in use: `src/data/coaches.ts`
loads them, and the play-level fits and the staff-change features read
them from there. A wrong name in either file fails quietly, so check the
staff before leaning on a finding that turns on one. See
`data/curated/README.md`.

The rest of `data/curated/` is aggregated from the raw downloads by the
script named in each file's header comment, so those files come back
identical on a rerun. `data/kept/` contains the cached matchup and
played season tables the walk reads.
