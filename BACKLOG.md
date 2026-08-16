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

## Measured negative: weekly kernel over the preseason schedule

Running the weekly model across all 17 games before kickoff, with last
season's rates standing in for recent form, does not beat multiplying
the season projection by an opponent factor. On 2025, 3673 held-out
player-weeks: flat 0.547, weekly kernel 0.514, weekly kernel rescaled
to the season projection 0.546.

The reason is worth keeping. Before a season starts, the only inputs
that move week to week are the opponent, home or away, and the game's
expected scoring, and together they are small next to the player's own
level. A typical player's best projected week beats his worst by 3 to
5 percent either way. That is not a modelling failure, it is what is
knowable in August, and the flat weeks on the board are close to right.

What is wrong is the band around each week rather than the week itself.
Every player draws his spread from one of five buckets per position, so
A.J. Brown and CeeDee Lamb get the same range at the same average when
their actual seasons look nothing alike. See scripts/preseasonWeeklyEval.ts.

## Measured negative: shaping the bands by a player's role

Concentration, the share of a season that lands in a player's best
quarter of weeks, really is predictable from his role. Trained on
earlier seasons and scored on the next one, a ridge on targets,
carries, target depth, touchdown rate and scoring level ranks it at
.364 for 2024 and .517 for 2025, against .324 and .463 for his own
past concentration and .224 and .182 for a flat position average.

It does not carry into better weekly bands. Splitting the residual
model into three concentration bands per position made every quantile
worse on 2025, and blending it back toward the pooled model made
things worse in proportion to how much weight it got, with no minimum
in between. By edge: floor -1.6%, median -1.2%, ceiling -2.4%,
95th -2.6%. The role bands do spread players further apart, and the
extra confidence is wrong more often than right.

The likely reason is that concentration's own split-half reliability
inside a single season is only about .24 for receivers, so predicting
it well in rank terms still means predicting a narrow slice of a
mostly random quantity. Predicted concentration spans .45 to .56 where
observed spans .37 to .58.

The untested lead is participation data, which we do not yet download.
The nflverse pbp_participation release covers 2022 to 2025 and carries
offense_formation, offense_personnel, route, defenders_in_box,
defense_man_zone_type and defense_coverage_type. Alignment and route
are information none of the current features contain.

See scripts/concentrationEval.ts and scripts/shapedIntervalEval.ts.
The shaped residual model in src/backtest/intervals.ts stays as the
harness for that test. Nothing on the board uses it.
