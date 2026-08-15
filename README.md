# depth-chart

Fantasy football draft analysis built on a graph. Player performance is
shaped by relationships: who coaches the offense, who else competes for
targets, which defenses show up on the schedule, whether the quarterback
changed. Most projection systems flatten those into per-player averages.
This project keeps them as edges and asks whether the structure predicts
fantasy output better than the averages do.

## The graph

Nodes:

- **Player**, with position and career stint history
- **Team**
- **Coach**, with a role (head coach, offensive coordinator, defensive
  coordinator)
- **Game**, one per scheduled matchup, carrying season, week, and site

Edges, each with a validity span so the graph can be queried "as of"
any week:

- Player plays for Team (a stint)
- Coach works for Team in a role (a stint)
- Team plays in Game, home or away

Everything the model uses is a feature computed by walking this graph at
a point in time. Examples worth testing early:

- **Continuity**: does the player have the same offensive coordinator as
  last season? The same quarterback?
- **Competition**: how many players at the same position joined the
  roster since last season, weighted by their draft capital?
- **Scheme inheritance**: when a coordinator moves teams, do his skill
  players' usage patterns move with him?
- **Schedule shape**: strength of opposing defenses by week, bye timing,
  rest differentials.
- **Non-scoring personnel**: linemen and defenders never earn fantasy
  points, but their edges shape the players who do. OL continuity moves
  a back's efficiency, a defense that lost its best pass rusher changes
  every opposing quarterback's week, and a team whose own defense got
  worse trails more and throws more. The graph includes every roster
  spot for this reason; scoring stays limited to the fantasy positions.

## Prediction and backtest

The target is weekly fantasy points. Scoring is a set of per-stat
weights in `src/scoring/`: start from a standard, half, or full PPR
preset and override any weight to match a league's settings. The loop:

1. Build the graph as of draft day for season S using only information
   available then.
2. Extract features per player, predict the season's weekly points.
3. Score against what actually happened, with seasons S-3 through S-1
   as training data.

Baselines to beat, in order of difficulty: last season's points per
game, then ADP-implied rank. Metrics live in `src/backtest/`: RMSE on
points and Spearman rank correlation within each position, since draft
decisions are rankings, not point estimates.

Two rules keep the comparison fair:

- **ADP is a dated snapshot.** Each season's baseline uses the latest
  ADP available before that season's drafts, and the model gets a
  matching information cutoff. Comparing against stale July ADP
  flatters the model; letting the model see September news that the
  ADP snapshot predates flatters it worse.
- **Injuries are not misses.** Predictions are scored per game played.
  A player who tears an ACL in the preseason drops out of evaluation
  rather than counting against the model, unless injury risk itself
  becomes a modeled feature someday. Even then, some of it is dice.

## From player rankings to roster decisions

A draft picks a roster, and a roster is worth more or less than the sum
of its players:

- **Bye coverage**: two stars sharing a bye week cost a likely loss that
  their individual projections never show.
- **Replacement value**: the tenth-best QB and the tenth-best RB are
  different distances from what's freely available on waivers, so raw
  points overvalue QBs at the draft.
- **Correlation**: a QB stacked with his WR raises the roster's ceiling
  because their big weeks arrive together. A RB facing your own DST
  works against you in the same way.
- **Weekly decisions**: the same weekly predictions that score a draft
  also answer the in-season question, who do I start this week, using
  that week's matchup, and that tool is where this project likely ends
  up.

The season simulation is what makes all of this scoreable: simulate
weeks, fill lineups, and count wins, so a backtest can judge whole
rosters and draft strategies rather than isolated player projections.

## Data

- **nflverse** publishes weekly player stats, rosters, and schedules as
  flat files. `scripts/fetchData.ts` downloads them to `data/raw/`,
  which stays out of git.
- Coaching staff history has no single flat-file source. The plan is a
  hand-curated `data/coaches.csv` seeded from Pro Football Reference,
  small enough to maintain by hand (32 teams, 3 roles, ~10 seasons).

## Getting started

```
npm install
npm test
npx tsx scripts/fetchData.ts --seasons 2021-2025
```

## Layout

```
src/graph/      node and edge types, as-of queries
src/scoring/    fantasy point formulas per format
src/backtest/   metrics and season splits
scripts/        data download
data/           raw and curated inputs (raw is gitignored)
```
