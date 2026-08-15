# Backlog

Everything discussed for this project and its current status. Done
work is in the commit history and the README.

## In progress

- Coach dataset (head coach and offensive coordinator per team,
  2015 to 2024) is being curated into `data/curated/coaches.csv`.

## Designed, not built

- Coach continuity features: same OC year over year, scheme
  inheritance when a coordinator moves, reunions between a player and
  his former coordinator. Blocked on the coach dataset.
- Chemistry: pair tenure from stint overlaps, target-weighted pair
  efficiency with shrinkage, college teammate overlap. Tenure and
  college need only roster data; pair efficiency needs play-by-play.
- OL continuity, snap-weighted. The roster-based version (share of
  last season's five most-used linemen still on the week-1 roster) is
  computed and available on SeasonExample, and it learned the expected
  direction in training but slightly hurt held-out scores, so it is
  out of the ridge. Retry with lines defined by snap counts.
- Defensive personnel loss as a game-script signal for opposing
  offenses.
- Depth chart ingestion (nflverse `depth_charts`) for the weekly role
  layer, and simulated depth charts that reshuffle when a simulated
  injury removes a starter, which is where handcuff value comes from.
- Coach in-game tendency profiles from play-by-play (pace, pass rate
  by score and clock, rotation habits), attached to coach nodes, for
  the game simulator.
- Rookie projection from draft capital; rookies are invisible to every
  current evaluation.
- ADP is in: Fantasy Football Calculator preseason snapshots, 2016
  through 2025, with an evaluation in scripts/adpEval.ts. Remaining:
  use the ADP board inside the draft simulations, and add rookies to
  the comparison, since the market ranks them and the model cannot
  yet.
- Rerun the draft simulation scored against realized 2024 outcomes
  rather than value implied by our own weekly model.
- Per-position weekly models; one pooled set of weights leaves QB
  accuracy behind.
- Pluggable player-quality input: draft capital and snap counts first,
  Approximate Value next, PFF grades behind a manual CSV import if
  Matt exports them.
- The start-or-sit tool as an actual interface; the kernel and the
  floor-and-ceiling quantiles exist.
- Same-team catcher pairs simulate at 0.07 correlation where the data
  says 0; needs a negative competition channel.

## Decided against, with reasons recorded

- Season-average snap share as a season-model feature (measures
  inverse efficiency; commit history has the numbers).
- A Datalog engine at current scale; the code keeps facts and derived
  features separated so one can slot in later.
- Injury prediction; evaluation scores per game played instead.
