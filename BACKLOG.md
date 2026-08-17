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

## Negatives measured by substitution, to be rerun

Everything under the headings below was scored by asking whether one
piece beat another on rank correlation of the mean. That framing makes
each part of a distribution look marginal on its own, because each one
explains a slice of the variance while together they would define the
shape. None of these should be treated as settled until they are rerun
inside a joint model and scored on the whole distribution.

The clearest case is commit 299a723, which dropped a two-stage
opportunity-then-points predictor because it scored .522 against .529.
Its own message says the generative structure earns its place in
correlation and simulation rather than point prediction, and it was
dropped anyway. A touchdown is six points and a team throws about 35
passes a game; neither fact can be recovered by adding a smooth
residual to a mean, however well that mean ranks.

Also to rerun on the same grounds:
- The two-stage predictor itself (299a723).
- The preseason weekly kernel, whose rescaled form landed at .5464
  against .5467 and was recorded as no help. Rescaling is composition,
  and it came out level on a measure that cannot see shape.
- Role-shaped intervals, which replaced the pooled bands rather than
  entering a model alongside level.

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

## Measured negative: resetting a player's role when the staff changes

An earlier note said a backfield split resets with a new play-caller,
carrying over at .264 under the same staff and -.054 under a new one.
That measured a team's lead-back share, meaning how concentrated the
backfield is, and it does not survive being asked in a form a decision
can use.

A player's own carry share carries over at slope .671 under the same
staff and .653 under a new one, which is the same. Fitting the two
groups separately and predicting 2025 out of sample was worse than one
fit for everyone: rmse .1461 against .1453, rank .676 against .685.
And the man who led a backfield leads it again 50% of the time when
the staff stays and 47% when it changes.

So a new coordinator does not tell you to fade a back. The one place
it shows is tight ends, whose target share carries at slope .737 under
the same staff and .484 under a new one.

I gave draft advice on the strength of the team-level number before
checking it in this form. See scripts/roleCarryoverEval.ts.

## What the situational simulation still gets wrong

Roles from 2024, weeks from 2025, 222 players. Catches +4%, yards
through the air +3%, on the ground +6%, scores -3%. The averages are
close. Two shapes are not.

Big weeks come too often: 100 yard games +24%, two-score games +19%.
Sweeping every knob showed where this does not come from. The
per-touch yardage spread stops moving the number below .5, and the
week-to-week swing in how many snaps a situation gets barely touches
it between .1 and .3. What does move it is the average: shrinking a
man's yards harder takes yardage from +6% to -1% and big games from
+27% to +9% together. So the tail is a mean that is slightly high,
amplified, rather than a spread that is too wide.

Quiet weeks also come too often, +12%, and shrinking harder makes that
worse rather than better, because it flattens a good player's ordinary
weeks. Something keeps real players productive that the model does not
carry. The likely candidate is that touches inside one game are not
independent: a man who gets an early target gets the next one, and a
team that is behind throws to him all afternoon. Every touch here is
drawn on its own.

That correlation is the next thing to model, and it is the same
missing piece in both numbers: it would thin the tails and fill in the
middle at once. See scripts/fitWeekSettings.ts for the sweeps.

## Week to week, and the part nobody predicts

2789 player-weeks in 2025, standard scoring.

Across players, who outscores whom this Sunday:

  the weekly model        .624
  the simulation          .515
  last season's average   .504

The weekly model wins clearly, and the simulation barely beats carrying
last season forward, which is what it should do since it gives a man
the same number every week.

Within one player, which of his own weeks are the good ones, over 165
men with ten or more games:

  the weekly model       -.023
  the simulation           0

The weekly model cannot tell. Its opponent index, its implied total,
its recent form and its snap share all move from week to week, and
together they carry no information about which of a man's afternoons
will be the big one. Its .624 comes from ranking players against each
other, not from reading a matchup.

That matters most where the tool is used most. Choosing which of two
of your own players to start is exactly the within-player question,
and nothing here answers it. The honest advice is to start the better
player. Anything the page says about a soft matchup is decoration.

Worth trying against this: the opponent index is a season aggregate,
and the one matchup measure that did carry over year to year was a
defence's extra suppression of the opposing room leader, at .204
against .100 for its general suppression.

## Measured negative: telling the simulation what game it is

The simulation was given the week it was playing: the opponent, how
soft that defence had been to the position, the spread, the game
total, and the wind. All of it bends the play counts the way the
measurements said it should, and gameContext.test.ts holds it to that.

It buys nothing. Across 3813 player-weeks in 2025, rank went from
.5257 to .5280 and the average miss from 3.94 to 3.95 points. Within a
single player, over 222 men with ten or more games, it scores .0127,
which given how those numbers scatter is not different from zero.

That is the second approach to find nothing there. The weekly ridge,
with its own opponent index, implied total, recent form and snap
share, scores -.023 within a player. Two models with different
information and different shapes both say the same thing: which of a
man's own afternoons will be the big one is not in the schedule, the
betting line, or how the defence has played.

What is left untried is information from the day itself rather than
the week before it: who is inactive, who is carrying a knock into
Sunday, how the snaps are being shared right now.

## Personnel is the situation, not the team, at least out of sample

Learning what an offence lines up in from the state rather than from
nine named situations wins, but not by much: surprise of .8568 against
.8634 for the buckets and .8935 for the league's overall mix, scored
on 2025 after learning from 2022 to 2024. All three pick the right
grouping about 65% of the time, because eleven personnel is the mode
nearly everywhere.

Where the learned version earns its place is the interaction a bucket
cannot hold. On third and two it puts heavy personnel at 15.4% from
the two yard line and 5.6% from the fifty, which the taxonomy called
goal line and third and short and could not compare.

Adding the offence itself makes it worse, three ways round. Tilting by
a three-year habit gives .8828. Restricting that to the seventeen
offences that kept their play-caller gives .8791. Fitting a column per
offence inside the model gives .8781. All are behind the .8568 of the
state alone.

That tempers the coach finding rather than contradicting it. Shotgun
rate really does travel with a coordinator at .697. Personnel repeats
at only .19 to .23 under the same man, and out of sample that is too
little and too unstable to pay, especially when half the league
changes play-callers between seasons.
