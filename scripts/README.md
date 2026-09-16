# What is in here

Two kinds of file sit in this directory, and the difference matters
before you delete anything.

The one-off evals and checks have been deleted. Each was written to
answer a single question, and what each one found is written down in
`docs/scoreboard.md` and in the findings below. Where a finding
mentions a script that is no longer here, it says so.

**Entry points**, the ones a person runs on purpose:

- `week.ts` is the weekly refresh. `npm run week` runs it, and it calls
  the next four in order.
- `fetchData.ts` downloads the nflverse files into `data/raw/`.
- `fetchSleeperProjections.ts` pulls Sleeper's weekly projections.
- `pullAdp.ts` and `pullSleeperAdp.ts` pull draft position snapshots.
- `aggregate*.ts` count the raw play-by-play into the tables in
  `data/curated/`. Each writes the file named in its header comment and
  reproduces it exactly on a rerun.
- `buildSite.ts` writes the prediction JSON and the page into `docs/`.
  `buildSimTables.ts` writes the tables the live pages play a game out
  with, and `buildSite.ts` calls it.
- `serve.ts` is a local server for the weekly tools, on port 3210.
- `start.ts` prints the start or sit comparison for named players at
  the terminal.
- `seasonOutlook.ts` prints the projected season for all 32 teams.

**The benches that are still run.** These are not part of any build.
`boardShareEval.ts`, `walkWeeklyEval.ts` and `scorePredictionEval.ts`
are the three the scoreboard is scored on. The rest each back a
constant or a decision that is still in the model, and `src/README.md`
says which: `walkBandEval.ts`, `twoPointEval.ts`, `sourceCompare.ts`,
`knowableWeekEval.ts`, `mechanicsCarryEval.ts`, `walkWeekCache.ts`,
`jointProjectionEval.ts`, `playLayerEval.ts`, `estimateCorrelation.ts`,
`exemptCheck.ts`, `leverageUsageProbe.ts`, `marketPriceProbe.ts`,
`sleeperEval.ts`, `seasonShrinkEval.ts` and `simAgreement.ts`.

The findings follow, in the order they were written.

# Where the walk's kicking excess comes from

A kicker on the board takes 2.27 field goal attempts a game where his
side really takes about 2.0. The player evals that printed everything
below, under `DRIVE_CHECK=on`, have been deleted.

## What is not wrong

The fourth down model chooses correctly wherever the ball is:

```
inside 20  kick 70%  really 69%
21-30      kick 79%  really 73%
31-40      kick 47%  really 54%
41-50      kick  1%  really  3%
past 50    kick  0%  really  0%
```

Three plays or fewer ends 32.5% of drives against 33.7%, and the spread
of drive lengths matches. So drives do not fail too slowly, and the
staff does not kick when it should punt.

## What is wrong

A throw goes to a player drawn from his share, and the walk then tries to
draw one of his own plays. It gives up when he has fewer than 25 in
three seasons and falls back to a pooled draw.

That fallback takes **20.5%** of every throw. In life the players with
fewer than 25 targets over the same seasons take **4.9%** of them, so
the walk sends a fifth of its passing to the back of the roster.

The fallback gains badly as well. It draws from a cut averaging 5.22
with 44.2% of it going nowhere, where a targeted throw averages 7.33
and misses about 35% of the time. A fifth of throws come back worth
4.62, and the passing runs 10% short of the pool it samples.

Being short there is what hides the second one. `storePlays` keeps only
the plays a player was credited with:

```ts
const kept = rows.filter((r) => r.player);
```

A sack and a ball thrown away belong to no receiver, so neither is in
any pool. That is 10.2% of throws losing 4.40 yards, and what they cost
depends on where the ball is: 3.12 inside the ten against 4.72 past
midfield, because a side near the goal throws it away more than it gets
sacked and has less field to lose.

## Why fixing one alone makes it worse

Putting the sacks back at their true rate:

```
                    as it is   with sacks   really
drives a side          10.26        11.31     10.7
plays a drive           6.24         5.77     5.98
seconds a drive          177          161      171
punt                   31.0%        36.9%    35.7%
field goal             19.4%        19.3%    15.7%
touchdown              21.7%        17.3%    21.9%
kicks a side a game     2.33         2.51     1.97
```

Field position and punts come right. Touchdowns fall four points
because the passing was already 10% short and the sacks take it 6%
below life instead of 10% above. Fewer touchdowns means more drives
reach a fourth down, and drives get shorter so more of them fit in a
game, so the kicking gets worse rather than better.

## Where the flatness comes from

The shares handed to the walk give a side's five busiest players 59.9% of
its throws where a side gives them 74.2%. The walk's own leaning and
script multipliers push that back up to 71.8%, so the flatness is in
the projected shares and not in the walk.

Those shares divide a position's work by `Math.pow(standing, sharpness)`
and sharpness is 1. It was swept over 2024 and 1 came out best, .761
against .724 at .5 and .733 at 3. That sweep scored **ordering players**,
which is what the board reads. Picking who catches a particular ball is
a different job and wants a sharper number. The two uses pull opposite
ways on one model.

## What was tried, and what it cost

Sharpening only the walk's own targeting, leaving the projection alone:

```
sharpness   five busiest take   throws to players it cannot sample
   1              63.8%                  19.9%
   1.3            72.2%                  16.2%
   1.6            78.4%                  16.2%
   2              85.2%                    -
really            74.2%                   4.9%
```

It concentrates the throwing and does nothing for the yardage, because
the sampled path already gains 7.63 against a targeted throw's 7.33.
Sharpening to 1.3 and putting the sacks back together still gives
touchdowns 17.2% against a real 21.9%.

## Why it keeps failing

Touchdowns are hypersensitive to yards a play. Five percent off the
yardage costs a fifth of the touchdowns:

```
                 yards a play   touchdown
as it is             5.69         21.7%
with sacks           5.16         17.3%
really               5.41         21.9%
```

So every fix has to land the yardage almost exactly or it trades the
kicking error for a bigger scoring one. Nothing here can be moved on
its own.

## The retune, and what it settles

Three knobs, swept together over one week of 2024: how sharply the walk
picks who gets the ball, how many of the missing sacks come back, and a
scale on the clock. Eighteen combinations, scored on the squared
relative miss across yards a play, drives a side, and the three drive
endings that matter.

```
sharp wasted clock |  yds  drives   TD%   FG%  punt% |  error
  1.8      1  1.06 | 5.18  10.87  18.0  18.0   36.5 | 0.0557
  1.4      1  1.06 | 5.16  10.72  17.5  17.8   36.4 | 0.0608
  1.8    0.6     1 | 5.46  10.82  20.0  19.1   32.1 | 0.0648
    1      0     1 | 5.59  10.26  21.7  19.4   31.0 | 0.0758   <- as it ships
  1.8      0     1 | 5.72  10.18  22.3  20.9   28.7 | 0.1541
the target           5.41  10.70  21.9  15.7   35.7
```

Nothing reaches both. Every setting that brings the kicking down takes
the touchdowns with it, and every setting that keeps the touchdowns
leaves the kicking where it is. The best field goal rate anywhere in
the sweep is 17.8% against a real 15.7%, and it costs four points of
touchdown.

The lowest total error is not the one to ship. It buys 1.6 points of
field goal rate with 4 points of touchdown, and every player's points
on the board come off the touchdowns. What ships is close to the best
available on the thing that matters, and the kicking is what it costs.

So the parameters are not the problem. Something the walk does not
represent is, and the likeliest is the red zone: it reaches scoring
range and settles for three where a side goes and gets seven. No knob
here touches that.

## The structure

Conversion is right at every depth. Of drives reaching a spot, the
share that score a touchdown matches:

```
reached the 10   scores 68.3%   really 68.9%
reached the 20          56.5%          57.3%
reached the 30          48.2%          49.1%
reached the 40          42.5%          42.4%
reached the 50          37.2%          37.2%
```

So the red zone is not it. What is wrong is how many drives get there.
Reaching midfield is exact, 58.6% against 58.7%, and the walk creeps
ahead from there: +0.7 points at the 40, +2.6 at the 30, +3.1 at the
20, +3.6 at the 10. Drives that should stall around the forty reach the
twenty five and kick.

Yards a play, by where the ball is, says why:

```
              as it ships   with the sacks back   really
inside 10        1.82              1.58            1.80
11-20            3.95              3.38            4.09
21-30            5.23              4.67            5.13
31-50            6.29              5.65            5.80
51-70            6.80              6.08            5.99
past 70          6.74              5.96            6.03
```

As it ships, the walk is right near the goal and gains 12 to 14% too
much in the open field. Put the sacks back and the open field comes
exactly right while the goal line falls 12 to 17% short.

Both readings are the same error. Work out what a targeted play has to
gain for each band to come out right once the sacks are in it:

```
band        walk   needs    off by
inside 10   1.82   2.43    -25.2%
11-20       3.95   5.04    -21.6%
21-30       5.23   6.16    -15.1%
31-50       6.29   6.90     -8.9%
51-70       6.80   7.23     -6.0%
past 70     6.74   7.20     -6.4%
```

A targeted play is short everywhere, and worst near the goal. The
missing sacks were covering for it, and covering unevenly: they cost
4.72 yards in the open field and 3.12 near the goal, which is almost
exactly the shape of the shortfall. Two errors, opposite signs, and
they cancel band by band. That is why every aggregate looked fine, why
no parameter fixes it, and why putting the sacks in alone breaks the
scoring.

So the thing to fix is the sampled draw. It widens over the state in
three passes and the last one ignores where the ball is:

```ts
(i) => plays.down[i] === state.down && ... yardline within 20,
(i) => Math.abs(plays.yardline[i] - state.yardline) <= 25,
() => true,
```

A player drawn on the eight gets a play he made at midfield, capped at the
goal line. Getting that conditioning right, and then putting the sacks
back, is the fix. Everything else in here follows from it.

## The order to do it in

1. The target shares, so a fifth of throws stop going to players nobody
   throws to. Sharpening the walk alone gets part of it; the rest is
   that `among` carries 27 players where a side dresses about 11.
2. The pooled draw those fall back to, which gains 4.62 where a
   targeted throw gains 7.33.
3. The sacks and the balls thrown away, drawn from where the ball is.
4. Refit the clock, which will have moved.

Each one changes what the next is measured against, and the yardage has
to come out within a percent or two at the end of it, so they want
doing together with the box score evals beside them.

# Where the weekly points line has room left

`boxScoreWeekEval.ts` scored every way of guessing one player's week over
2024 and 2025, weeks 1 to 17, by position and split at week 4.
Everything is full PPR, because Sleeper's points column is PPR. The
script has been deleted and its row is in `docs/scoreboard.md`.

Two rows are the reason the bench exists. "Oracle: usage known" gets the
player's actual targets, carries and pass attempts and has to guess his
rates from his own history. "Oracle: rates known" gets the rates and has
to guess the usage. Together they say which half of a usage model has the
points in it.

Points per player per week, mae and bias:

```
  candidate                          QB wk1-4       RB wk1-4       WR wk1-4       TE wk1-4      QB wk5-17      RB wk5-17      WR wk5-17      TE wk5-17
  ours (shipped ridge)             6.45/+0.26     4.45/-0.17     4.75/+0.41     3.49/+0.37     6.29/-0.13     4.28/+0.24     4.29/+0.00     3.56/-0.26
  sleeper                          6.80/+3.65     4.09/-0.28     4.44/-0.04     3.40/+0.00     6.67/+2.69     4.26/-0.20     4.37/-0.16     3.66/-0.82
  blend 0.5                        6.33/+1.54     4.22/-0.25     4.64/+0.19     3.51/+0.26     6.22/+0.79     4.31/-0.00     4.38/-0.09     3.64/-0.56
  naive trailing 4                 6.92/+0.22     4.26/-0.48     4.83/-0.14     3.54/-0.14     6.53/-0.36     4.46/-0.02     4.45/-0.05     3.77/-0.22
  (a) component                    6.25/+0.52     4.18/-0.19     4.48/+0.11     3.36/+0.24     6.39/-0.06     4.33/-0.08     4.35/+0.07     3.61/-0.30
  (a) component, vegas lift        6.30/+0.77     4.20/-0.10     4.49/+0.21     3.38/+0.31     6.37/+0.26     4.33/+0.06     4.37/+0.21     3.62/-0.22
  (a) component, blend 0.5         6.30/+1.68     4.12/-0.27     4.54/+0.03     3.45/+0.17     6.31/+0.89     4.32/-0.15     4.39/-0.04     3.68/-0.57
  component wk1-4, blend 0.5       6.30/+1.68     4.12/-0.27     4.54/+0.03     3.45/+0.17     6.22/+0.79     4.31/-0.00     4.38/-0.09     3.64/-0.56
  same, QB debias 3                6.02/+0.18     4.12/-0.27     4.54/+0.03     3.45/+0.17     6.19/-0.71     4.31/-0.00     4.38/-0.09     3.64/-0.56
  same, fitted debias              6.02/+0.21     4.17/-0.16     4.55/+0.10     3.52/+0.48     6.20/-0.67     4.34/+0.11     4.40/-0.02     3.68/-0.24
  (c) early from prior season      6.50/+0.71     4.47/-0.00     4.74/+0.48     3.51/+0.50     6.29/-0.13     4.28/+0.24     4.29/+0.00     3.56/-0.26
  oracle: usage known              4.88/+0.61     2.75/+0.01     2.91/+0.19     1.89/+0.17     5.25/+0.01     2.94/-0.03     2.99/+0.07     2.31/-0.13
  oracle: rates known              4.27/+0.43     3.14/-0.20     3.41/+0.02     2.61/+0.06     4.12/+0.16     3.12/-0.17     3.28/+0.12     2.85/-0.03
```

The game simulator has only played the odd weeks, so its candidates are
reported again over that subset, where every line is worse than on the
full set because those weeks are a harder draw:

```
  candidate                          QB wk1-4       RB wk1-4       WR wk1-4       TE wk1-4      QB wk5-17      RB wk5-17      WR wk5-17      TE wk5-17
  ours (shipped ridge)             5.91/-0.00     4.98/+0.07     5.22/+0.20     4.16/+0.09     6.53/-1.13     4.45/+0.38     4.93/-0.06     4.42/-0.89
  blend 0.5                        5.89/+1.87     4.46/-0.01     4.93/-0.10     3.86/-0.10     6.48/+0.53     4.44/+0.16     4.87/-0.08     4.40/-1.10
  (a) component                    5.52/+0.70     4.66/-0.07     4.97/-0.19     4.10/-0.12     6.79/-0.85     4.63/+0.12     5.06/+0.18     4.52/-0.81
  (b) walk usage                   5.73/-0.50     4.64/-0.73     4.94/-0.29     3.86/-0.43     6.96/-1.53     4.52/-0.71     5.12/-0.17     4.46/-1.16
  (b) walk usage, half             5.58/+0.10     4.58/-0.40     4.86/-0.24     3.89/-0.28     6.83/-1.19     4.46/-0.30     4.96/+0.00     4.41/-0.98
  (b) walk points                  5.68/+0.13     4.75/-0.67     5.05/-1.21     3.61/-0.91     7.34/-0.74     4.53/-0.67     5.21/-0.86     4.49/-1.78
```

Targets and carries, mae per player per week, over every week:

```
  candidate                         QB tgt/car      RB tgt/car      WR tgt/car      TE tgt/car
  (a) component                      0.02/1.86       1.22/3.32       1.89/0.21       1.56/0.07
  (b) walk usage                     0.03/2.13       1.29/3.61       2.20/0.22       1.89/0.08
  (b) walk usage, half               0.03/1.84       1.25/3.44       2.07/0.23       1.85/0.08
```

Matchup Brier over the same random lineups, under a normal approximation
rather than the app's copula draws, so read the numbers against each
other and not against the shipped calibration bench:

```
  sleeper                                    0.2085
  component wk1-4, blend 0.5                 0.2112
  same, QB debias 3                          0.2112
  same, fitted debias                        0.2113
  (a) component, blend 0.5                   0.2125
  blend 0.5                                  0.2129
  ours (shipped ridge)                       0.2241
  (a) component                              0.2253
```

## Reading it

Most of what is left to win is usage, not efficiency, and it is not close
at running back and receiver. Handing the model a back's actual carries
and targets takes his error from 4.33 to 2.94, a third of it, where
handing it his actual yards per carry and touchdown rate takes it to
3.12. At receiver the same split is 4.35 down to 2.99 against 3.28. The
one position that goes the other way is quarterback, where knowing the
rates is worth more than knowing the attempts (4.12 against 5.25), which
fits a position whose points come from yards per attempt and touchdowns
rather than from how often he throws. So a better weekly line at the
skill positions means predicting touches, and the component model's own
usage error says where that work is: it misses a back's carries by 3.3 a
game and a receiver's targets by 1.9.

Sleeper gives a quarterback about three points a week more than he
scores, and half of that goes straight into the blend. Taking a flat three off his
quarterback number before the blend wins 0.31 of error in weeks 1 to 4
and 0.03 from week 5, and it takes the bias from +1.68 to +0.18 early.
Fitting a bias per position instead, on the other test season, comes to
3.38 for 2024 and 2.48 for 2025 at quarterback and under 0.7 everywhere
else, and it lands on the same quarterback error while giving back a
little at back and tight end. So the flat three ships and the fit does
not. The component line in weeks 1 to 4 with that de-bias is what the
site now writes: 6.02/4.12/4.54/3.45 against the shipped blend's
6.33/4.22/4.64/3.51, and the same numbers from week 5 on.

The site is built at half a point a catch and Sleeper publishes full
PPR, and until September 2026 the two were blended as they came, so
every receiver in the slate was three points or so too high for a half
PPR league and more for a standard one. Sleeper's three formats differ
only in what a catch pays, so his full PPR number less half a point a
catch is exactly his half PPR number, and the fetch now keeps his
catches so the build can do that sum. The slate ships those catches
too, along with what a catch paid, and the app moves every point figure
by the difference for the league it is showing. The board never had
this problem because it ships the parts of a game and scores them on
the way in.

The component model already beats the shipped ridge across the early
weeks, by 0.20 at quarterback, 0.27 at back, 0.27 at receiver and 0.13 at
tight end, and it loses by about a tenth from week 5 on. That is the
split to ship: the ridge has four weeks of in-season form to fit and
nothing before that, and a player's previous season put through per-touch
rates is a better guess in September than his season line is. Three
things that looked worth trying are not. Scaling a player's touches by his
side's implied total costs a tenth of a point everywhere, so Vegas is
already in the ridge and adding it again double counts. The game
simulator's touches are worse than his trailing four games at predicting
his own touches, at every position, and its points are biased a point
and a half low at quarterback and tight end, so it belongs nowhere near
the usage input until that bias is fixed. And splitting the residual
model into 10 or 20 buckets instead of 5 moves the Brier by 0.0004: it
does widen the top of the band, a back projected for 22 going from a
21.6-point eighty to 24.9, but nothing downstream notices.

## Playing out the rest of a game that is under way

The live pages price what a player still has to come by taking his whole
week line and multiplying it by the fraction of the game left, and then
the copula posterior pulls that toward what he has already done. Neither
of them knows the score, the clock or who has the ball. The game engine
does, now that `playGame` takes a starting state, so the third way to
answer the question is to play the rest of the game out snap by snap and
add up what each player gets.

`scripts/aggregateCheckpoints.ts` stops every played game at six snaps
and writes them to `data/curated/checkpoints-<season>.csv`: the end of
each of the first three quarters, the middle of the second quarter, the
first third down of the second quarter, and the first snap inside the
twenty in the third. Each one gives the state the engine takes over
from, what each player had scored by then, and what the rest of the game
gave him, all in PPR. 2024 gives 1595 of them over 272 games and
2025 gives 1602.

`liveRemainderEval.ts`, since deleted and with its row in
`docs/scoreboard.md`, scored the three ways against that, by position
and by checkpoint, for weeks 3, 6, 9, 12 and 15 of 2024 and
2025. It also scored the two sides' remaining points on their own, which
is the check on whether the engine is right about the game at all before
anybody argues about a receiver, and it pairs random lineups off the
week's pool to get a Brier score and an implied against realised spread,
each player's draws being what he has plus what the variant says is left.
The sim ships if it wins on error at every position at half time and at
the end of the third quarter and stays level with them on the Brier
score and the spread.

Week 9 of 2024 and 2025, 174 checkpoints, 60 runs a checkpoint. Each
cell is the mean absolute error in points and then the bias, so a
negative number means the variant said less than the player scored.

```
                  time scaled    copula posterior  remainder sim
endQ1    QB       5.44 / -0.92   6.24 / -2.51      6.53 / -2.91
         RB       4.60 /  0.36   4.67 /  0.50      4.64 / -0.42
         WR       4.71 / -0.87   5.21 / -2.24      5.19 / -1.79
         TE       4.78 / -1.11   5.68 / -1.88      4.88 / -1.89
thirdQ2  QB       5.47 / -1.01   6.39 / -2.51      6.58 / -2.86
         RB       4.67 /  0.20   4.80 /  0.23      4.79 / -0.61
         WR       4.64 / -0.80   5.21 / -2.00      5.00 / -1.73
         TE       4.79 / -0.96   5.61 / -1.57      4.68 / -1.32
midQ2    QB       5.45 / -1.36   6.93 / -2.67      6.54 / -2.58
         RB       4.46 / -0.03   4.63 / -0.19      4.53 / -0.45
         WR       4.37 / -0.76   5.21 / -1.64      4.45 / -1.32
         TE       4.43 / -1.07   5.25 / -1.52      4.63 / -1.38
half     QB       5.04 / -0.00   6.03 / -0.11      5.23 / -1.28
         RB       3.74 /  0.29   3.79 /  0.28      3.58 / -0.36
         WR       3.80 /  0.16   4.55 /  0.16      3.82 / -0.41
         TE       3.85 / -0.46   4.37 / -0.12      3.72 / -0.84
redQ3    QB       4.75 / -0.84   5.53 / -1.29      4.93 / -1.23
         RB       3.56 / -0.11   3.71 / -0.24      3.48 / -0.27
         WR       3.46 / -0.18   4.14 / -0.30      3.48 / -0.55
         TE       3.62 / -0.46   4.08 / -0.29      3.77 / -0.65
endQ3    QB       4.09 / -0.67   4.48 / -0.90      3.57 / -0.98
         RB       2.80 / -0.30   2.78 / -0.48      2.76 / -0.32
         WR       2.85 / -0.38   3.13 / -0.48      2.71 / -0.52
         TE       2.58 / -0.29   2.83 / -0.07      2.53 / -0.48
```

The two sides' remaining points, which is the sim answering for the game
rather than for anybody's fantasy team:

```
endQ1    MAE 6.15  bias -1.96
thirdQ2  MAE 6.31  bias -2.11
midQ2    MAE 6.28  bias -1.80
half     MAE 5.92  bias -0.54
redQ3    MAE 5.45  bias -0.59
endQ3    MAE 4.34  bias -0.53
```

And the paired lineups, about 150 pairs a checkpoint. The two spread
columns are the width the draws implied against the width that came
out, first for one side's total and then for the margin between two:

```
                  brier    side          margin
endQ1    time     0.2207   14.1 vs 16.8  19.3 vs 24.4
         copula   0.2306   11.4 vs 20.5  16.1 vs 26.0
         sim      0.2334   14.7 vs 20.3  20.6 vs 25.7
thirdQ2  time     0.2029   13.7 vs 15.7  18.6 vs 21.5
         copula   0.2021   10.8 vs 19.6  15.2 vs 22.8
         sim      0.2345   14.3 vs 19.9  20.2 vs 23.9
midQ2    time     0.2056   11.2 vs 16.3  15.3 vs 23.4
         copula   0.2475    8.0 vs 20.4  11.3 vs 26.7
         sim      0.2041   13.3 vs 18.2  18.6 vs 24.2
half     time     0.1429    9.4 vs 13.7  12.8 vs 19.7
         copula   0.1594    6.3 vs 15.6   8.8 vs 22.3
         sim      0.1501   12.0 vs 13.9  17.0 vs 20.0
redQ3    time     0.1367    7.7 vs 12.9  10.5 vs 18.4
         copula   0.1629    4.7 vs 14.9   6.6 vs 20.9
         sim      0.1329   11.1 vs 13.3  15.8 vs 18.6
endQ3    time     0.0968    4.7 vs 10.5   6.4 vs 14.7
         copula   0.1204    2.3 vs 11.6   3.2 vs 16.2
         sim      0.0980    8.8 vs 10.7  12.3 vs 14.4
```

## Reading the remainder

The sim clears the bar. It beats the copula posterior at all four
positions at half time (6.03 to 5.23 at quarterback, 3.79 to 3.58 at
back, 4.55 to 3.82 at receiver, 4.37 to 3.72 at tight end) and at all
four again at the end of the third quarter, where the quarterback gap is
4.48 to 3.57. It also beats it on the Brier score at both (0.1594 to
0.1501, and 0.1204 to 0.0980), so the matchup odds do not pay for the
per-player win.

The spread is where the copula is worst and the sim helps most. At half
time the copula's draws imply a side scores within 6.3 points of its
projection when sides actually land 15.6 away, and it implies an 8.8
point margin where the played one is 22.3. That is draws far too tight,
which is what makes a live matchup page too sure of the favourite. The
sim implies 12.0 against 13.9 and 17.0 against 20.0. It is still narrow,
but it is close enough to argue about rather than out by a factor of
two.

Early in a game the sim is the worst of the three, and the reason is
plain in the bias column: it is short 2.9 points on a quarterback at the
end of the first quarter and short 1.96 on a whole side's remaining
points. A game with three quarters left is nearly a whole game, so the
engine's own low scoring has three quarters to accumulate, where the
week line scaled by the clock inherits a projection that was fitted to
be unbiased. By half time the remaining bias is down to half a point a
side and the ordering flips. So the shipped answer should be the clock
scaling early and the sim from half time on, and the engine's scoring
bias is the thing to fix before it is trusted before half.

Two cautions. This is one week of each season, so a position cell is 59
to 159 players and a Brier cell about 150 pairs; the half time and third
quarter wins are consistent across all four positions, which is harder
to get by luck than any single one of them, but the size of each win is
not settled. And the time scaled variant uses the component line rebuilt
in process rather than the shipped slate, since only two slates were
ever written to `docs/data`.

The per-player rate reconciliation and the pass-catcher fallback both have
numbers now, in the next section. `matchupCalibration.ts`, now deleted,
was left alone: a lineup there needs all
seven players drawn, the walk has only played the odd weeks, and a Brier
over the subset of lineups where every slot has simulator runs cannot be
read against the 0.2112 the shipped bench reports.

## Reconciling the rates, and the fallback with the sacks

Two more walks, each played over the same odd weeks of 2024 and 2025 and
each written to its own file.

`VARIANT=component-rates` keeps the trailing shares and adds the per-player
rates. Every player gets one multiplier per call, his shrunk yards per
target over what his position averages, likewise per carry, likewise for
his touchdowns, and a quarterback gets the same per attempt he throws.
The pooled draw's level term is replaced by it outright, since both say
how good a player is at this. His own sampled plays get the smaller
correction of his history against what those plays already say. The
touchdown multiplier moves a drawn gain onto the goal line, or off it,
inside the twenty.

`VARIANT=component-full` adds the two the top of this file asks for
together: the sacks and the throwaways go into the depth pools the
pooled draw samples, and a player too thin to sample borrows the plays of
the busy players on his own side before he falls back to the crowd.

Targets and carries, mae per player per week:

```
  candidate                         QB tgt/car      RB tgt/car      WR tgt/car      TE tgt/car
  (a) component                      0.02/1.86       1.22/3.32       1.89/0.21       1.56/0.07
  sim, component shares              0.03/1.95       1.29/3.61       2.09/0.22       1.85/0.09
  sim, component-rates               0.03/1.93       1.29/3.58       2.12/0.22       1.86/0.09
  sim, component-full                0.03/1.95       1.29/3.59       2.10/0.22       1.86/0.09
```

Points, over the weeks the walk has played:

```
  candidate                          QB wk1-4       RB wk1-4       WR wk1-4       TE wk1-4      QB wk5-17      RB wk5-17      WR wk5-17      TE wk5-17
  (a) component                    5.52/+0.70     4.66/-0.07     4.97/-0.19     4.10/-0.12     6.79/-0.85     4.63/+0.12     5.06/+0.18     4.52/-0.81
  sleeper                          6.55/+3.74     4.27/-0.07     4.86/-0.36     3.63/-0.36     6.85/+2.27     4.44/-0.04     4.89/-0.09     4.42/-1.30
  sim, component shares            5.65/+0.16     4.70/-1.06     5.26/-0.45     3.78/-0.37     6.89/-1.31     4.70/-1.18     5.16/-0.39     4.72/-1.13
  sim, component-rates             5.59/+0.11     4.67/-1.03     5.26/-0.44     3.87/-0.32     6.87/-1.30     4.71/-1.13     5.21/-0.46     4.70/-1.12
  sim, component-full              5.69/+0.16     4.70/-1.03     5.28/-0.45     3.85/-0.37     6.88/-1.28     4.70/-1.12     5.18/-0.44     4.76/-1.14
  sim, component-rates: points     6.69/+1.45     4.65/-1.15     5.40/-1.20     3.92/-0.86     7.99/+0.36     4.78/-1.07     5.46/-0.88     4.83/-1.68
  sim, component-full: points      7.02/+1.40     4.81/-1.08     5.48/-1.19     3.88/-0.95     8.03/-0.11     4.81/-1.11     5.37/-1.02     4.87/-1.80
```

The run spread:

```
                component walk              component-rates            component-full
            run sd  week sd  cov  1.2   run sd  week sd  cov  1.2   run sd  week sd  cov  1.2
  QB          7.45     8.90 67.2 77.1     7.41     9.86 63.3 71.3     7.33     9.89 60.8 72.0
  RB          5.59     6.42 75.5 84.3     5.57     6.55 74.8 83.1     5.50     6.61 74.1 82.6
  WR          6.05     7.12 77.6 83.2     6.15     7.32 76.6 82.7     6.10     7.27 77.2 82.9
  TE          4.94     6.28 79.1 83.9     4.94     6.41 76.4 81.5     4.91     6.48 75.2 80.4
```

## Reading it

Neither one works. The gate was to beat `(a) component` at every
position in both splits, and no position is won in either split by
either walk: the touches still miss a back's carries by 3.58 against the
component line's 3.32 and a receiver's targets by 2.12 against 1.89, and
the points lose everywhere except tight end early, which the trailing
shares already won.

The rates were meant to take the low bias off back and tight end, and
they do not. A back's bias goes from -1.06 to -1.03 in weeks 1 to 4 and
from -1.18 to -1.13 from week 5, which is a twentieth of a point where
the gap to the component line is a point. So the bias is not in the
per-touch rates. Sharper shares hand a busy player more work and the work
itself is short; reconciling what he makes of a touch against his own
history does not lengthen it, because his history is measured over the
same short plays. The shortfall the top of this file works out, a
targeted play needing 15 to 25% more near the goal, is the thing to fix,
and it lives in how the sampled draw is conditioned rather than in any
per-player number.

Where the rates do bite is the walk's own points, and they bite the
wrong way: a quarterback's error goes from 5.90 to 6.69 early and from
7.28 to 7.99 from week 5. His passing yards are his receivers' catches,
so a throw is now multiplied twice, once for the receiver and once for
the passer, and the two compound. One multiplier per throw is what that
says, and the passer is the one to keep.

Putting the sacks in the depth pools and giving a thin player the busy
players' plays moves almost nothing, 2.10 receiver targets against 2.12 and
a bias inside a hundredth. The fallback was already much smaller than
the 20.5% at the top of this file: restricting `among` to the players with
trailing usage had taken most of it out, so there was little left for
the stand-in pool to catch, and the sacks on the pooled path arrive
where the sampled path already had them.

The runs get worse as a fit. `week sd` rises at every position on both
walks, a back's from 6.42 to 6.61 and a quarterback's from 8.90 to 9.89,
and coverage falls with it. So the reconciliation moves players further from
where their weeks land.

`DEALT_WIDER` stays at 1.2. The case for refitting it to about 1.05 was
read off the component walk, where the raw runs covered 75 to 79% on
their own. On these two they cover 61 to 77%, and with the 1.2 stretch
they come to 80.4% at tight end and 82.9% at receiver, which is close
enough to the target that the stretch is doing work again. Since neither
walk should ship, nothing downstream changes.

## The point a game the engine had no way to score

The engine scores a side's own drives and nothing else. Over 2022 to
2025 a side scored 22.39 points a game and its own drives produced
21.40, so a point a game comes from somewhere the walk cannot reach.
That is measured off `drives.csv` against the final scores, 2174 team
games.

The play by play says where it comes from, per side per game:

```
  pick six          0.064
  fumble return     0.033
  punt return       0.015
  kickoff return    0.011
  safety            0.026
```

which is 0.92 points a side a game. The rest is blocked kicks and
defensive conversions.

As rates on the thing that produces them: an interception comes back
for a touchdown 8.7% of the time and a lost fumble 6.4%, so 7.7% of
the takeaways the walk knows, since it does not tell the two apart. A
punt goes back 0.39% of the time and a kickoff after a score 0.25%. Of
the 60 safeties, 49 came on a drive that started at or inside the ten,
and 2019 drives started there, so 2.4% of those.

`gameFromDrives.ts` now draws all five. Either touchdown leaves the
side it was scored on receiving, so the ball does not change hands,
and a safety hands over the way a drive that ended any other way does.
`NO_RETURNS` turns the lot off, for telling this apart from what the
offence does.

The remainder bench has not been run since, so the only numbers for it
are still the ones above: MAE 6.15 and bias -1.96 on a side's remaining
points at the end of the first quarter. Three quarters of a game is
0.74 of the point a game, so that much of the -1.96 is what this
change can account for and the rest is the offence.

Why no bench saw it. `boxScoreEval.ts` scored a side's points against
the sum of its own drives' points, so a return was not in its truth and
never could be. `liveRemainderEval.ts` scored against the scoreboard,
which has every point on it, and that is the bench where the missing
point a game shows up as bias. Both scripts have been deleted and their
rows are in `docs/scoreboard.md`.

## Getting the sim into a static site

The site has no server, so the browser cannot ask the fitted model
anything. `scripts/buildSimTables.ts` asks it instead, on a grid, and
writes the answers to `docs/data/sim-<season>.json` as base64 bytes:
each side's run rate by down, distance, field position, score and
clock; who the ball goes to; each player's catch rate and sixteen gain
quantiles; and the league's kicks, punts, fourth downs, turnovers,
penalties and seconds a snap. A season is 201 KB on disk and 85 KB
gzipped. `app/lib/remainder.ts` is the same drive and game loop reading
those bytes, and it runs in a worker at 2000 replays of a half in about
180 ms, against 8 seconds for 60 replays in Node.

`scripts/buildSimTables.ts` reads the roster of one week, and a side on
its bye has none that week, so the four teams on bye are built from the
nearest week they played.

A season nobody has played yet has no games to fit anything on, so the
play behaviour, the team tendencies and the league rules all come from
last season and only the casts are this season's: who is on the roster
now, ordered by the carries and targets he saw last year, with the
quarterback being whoever threw most. The sides are the same franchises
either way, so a team's run rate is reused unchanged. The live page
also falls back to last season's file when this season has none, and a
player who has moved or arrived since is absent from it, which puts him
back on the copula rather than on nothing.

`scripts/simAgreement.ts` asks both engines about the same checkpoints.
Over 20 checkpoints of 2025 week 10 at 60 runs each, the browser engine
is 0.73 points a player away from Node with no bias, and 1.47 points a
side away, of which 0.65 is scoring sides high.

That side bias was 0.88 until the fourth down table learned the score
and the clock. The fitted model keys the choice on the score band and
the time band as well as the spot, and the table was sampled once at
nil apiece with twenty minutes left, so a side behind in the fourth got
the kicker where the staff would have gone for it. The remaining 0.65
is worth another look: with the per-player bias at -0.05, whatever is
still generous is not reaching anybody's fantasy line, which points at
the kicks rather than the gains.

## A defence gets a week of its own

The board projected a defence by dividing last season's box score by
seventeen, so every week said the same thing whatever the fixture. That
orders defences within a week no better than chance.

`defenceWeekEval.ts`, since deleted and with its row in
`docs/scoreboard.md`, scored each candidate against the actual
paid week over all 1088 defence weeks of 2024 and 2025 that Sleeper has
a projection for. Which defence to start is a question about the order
inside one week, so the number to read is the mean Spearman within a
week, with the mean absolute error and the bias beside it.

```
every week            MAE   bias   rank corr
  ours (the board)    4.32   0.54    0.065
  sleeper (pts_std)   4.08   0.79    0.314
  sleeper's parts     3.91   0.23    0.319
  rival               3.85  -0.12    0.341
  rival + sleeper     3.86   0.06    0.350
  what ships          3.84   0.06    0.357
  perfect             0.00   0.00    1.000
  constant            4.09  -0.00    0.000

weeks 1 to 4          MAE   bias   rank corr
  ours (the board)    4.02   0.45    0.167
  sleeper's parts     3.91   0.32    0.249
  rival               3.90  -0.13    0.198
  what ships          3.91   0.32    0.249

weeks 5 on            MAE   bias   rank corr
  ours (the board)    4.42   0.57    0.035
  sleeper's parts     3.91   0.20    0.339
  rival               3.84  -0.12    0.382
  what ships          3.82  -0.02    0.388
```

Nothing beats a flat constant by much on the error, which is how noisy
a defence week is. The ordering is where the difference is: the board
reads 0.035 from week 5 on, and the new line reads 0.388.

The rival is a four weight fit: the defence's own last six paid weeks,
the sacks the other side gives up a game, and what the betting line
expects that side to score. The opponent's giveaways were in it and
came out, because the weight would not settle (-0.58 fitting on 2025,
+0.59 fitting on 2024) and dropping it cost nothing. Fitted on one
season and scored on the other, both ways round.

So `src/features/defenceWeek.ts` ships the fit, on 2024 and 2025
together, and hands the week back as parts: a rate per event and a
chance of each points-allowed bracket, which a league pays under its
own ladder the way it pays the board. The points allowed come off the
line (-2.61 + 1.146 x the implied total, spread 8.9) and the counting
rates are the defence's own shrunk toward the league, then scaled so
the parts pay what the fit said.

Sleeper ranks the early weeks better, 0.249 against 0.202, because the
rival has no weeks of its own to read yet. So the slate's blend takes
Sleeper's number through week 4 and ours from week 5.

Sleeper's own `pts_std` runs 0.56 above its parts paid under our
ladder, because it pays a kick or punt return touchdown that a defence
ladder does not. Repaying its parts is both closer to our truth and
better ordered, so that is what the slate compares against.

One correctness fix came out of this. A defence's fumble recoveries
were read from `def_fumbles`, which is a defender losing one of his
own, about a tenth of a game. The recovery is `fumble_recovery_opp`, at
about 0.47 a game, so every actual defence week was a point and a half
light and the board's line with it. That is fixed in the board and in
this bench. `defenceForecastEval.ts` and `defenceMatchupEval.ts` still
read the old column, and both have since been deleted.

# What a part played game says about the rest of it

`partialGameProbe.ts` backs `RATE_SHARE` in `app/lib/copula.ts`. It cuts
every player game in `touches.csv` at a fifth, a third and half the game
clock, writes the pace before the cut as a normal off the player's own
season the way the live draws do, and regresses the points after the cut
on it, centred inside a player season so how good he is cannot stand in
for how his afternoon started.

The slope is slightly negative at every cut, from -0.024 at a tenth
played to -0.065 at half, and the correlation with it, -0.04 to -0.12
over 21885 player games in 2021 to 2025. A game with one play worth more
than half the early points is no different. So a pace over the first
half of a game says nothing about the rest of it that the player's own
week does not already say, and the weight the live draws used, the
fraction played itself, was a factor of four to ten too strong at the
cuts this path covers.

No positive rate share fits a negative slope, so `RATE_SHARE` is 0.1,
which is the most the measurement allows rather than a number read off
it. Leaving it at zero would delete the pace, and with it the
quarterback who is hot at half time lifting his receivers, which this
probe does not measure.

The width was checked the same way, on how often the middle 80% of a
predicted remainder contains what happened. The old draws covered 0.77
at a tenth played and 0.44 at half, because scaling a whole week down by
the fraction left understates how much the plays in a quarter vary. The
shipped width grows with what is left instead, and covers 0.79 and 0.71.

# How the season outlook rates a team

`seasonOutlook.ts` prints a projected regular season for all 32 teams:
expected wins, a 10th to 90th percentile win range, division and playoff
odds, and the record so far. Run it with `npx tsx
scripts/seasonOutlook.ts`, and add `--markdown` for tables you can paste
into a document. It reads `games.csv`, so refresh that first with `npx
tsx scripts/fetchData.ts --seasons 2026 --force`.

A rating is how many points a team would beat an average opponent by on
a neutral field. Two fits produce one, and both are least squares on the
same rows: one row per game, plus one for the home team and minus one
for the away team, with a ridge penalty pulling each rating toward a
prior.

The first fit reads scoring margins, capped at 21 points so a blowout
counts as a comfortable win rather than as proof, over last season
including the playoffs and this season to date. A game this season
counts two and a half times what a game last season does. Its prior is
zero, which is what shrinks a 4-13 team back toward the league.

The second fit reads the closing spread of every game this season with a
line posted. A spread is the market's own estimate of the gap between
two teams plus home field, so fitting ratings to it takes the market's
view directly. Its prior is the margin rating and its penalty is light,
so a team the market has priced follows the market and a team it has not
stays where its margins put it. That prior does the work early in a
season: one week of lines is 16 numbers for 32 ratings, which leaves a
whole ridge of equally good answers, and the penalty picks the one
closest to what the games say.

The printed rating is two thirds the line fit and one third the margin
fit. Home field comes from the average home margin over the three
completed seasons before the one being projected, about 2.2 points, and
a neutral site game gets none of it.

From there each remaining game is a coin weighted by the rating gap plus
home field, read off a normal with a standard deviation of 13.5 points
on the margin. The season runs 20000 times, the games already played are
added to every run, and wins, division titles and playoff berths are
counted. Seeds are fixed, so two runs of the same data agree.

Seeding uses win percentage, then head to head where two teams played,
then division record inside a division and conference record across two,
then a coin flip. Strength of victory, strength of schedule, common
games and net points are left out, and a three-way tie is settled by
those same pairwise comparisons rather than by the reduction the league
applies, so a division race that finishes level is a rough count rather
than an exact one.

# What weighting a touch by leverage is worth

`aggregateLeverage.ts` counts every target and every carry twice, once as
itself and once multiplied by how much the game was still in the balance,
into `data/curated/leverage.csv`. That is 55712 player weeks over 2015 to
2025 and 7.2 megabytes. Each row also keeps receptions, air yards, first
and second down work, and looks inside the twenty and inside the ten,
with the side's total for each of them beside it.

`src/model/leverage.ts` has two ways to put a number between zero and one
on the state a play was run from. `doubt` is 4p(1-p) on the win
probability the side with the ball had. `margin` tapers on the score
instead, from nine points in the fourth quarter down to nothing at
seventeen, with both thresholds scaled back through the rest of the game
by the square root of the time left, so nine points with a quarter to go
is eighteen at kickoff. Nine and seventeen are the thresholds the fourth
quarter probe behind `app/lib/remainder.ts` found, so `margin` stretches
that finding over the whole game rather than guessing again.

`leverageUsageProbe.ts` asks whether a player's share through week w
orders his points a game over weeks w+1 to w+4 better than his raw share
does. Weeks 4 to 13 of 2015 to 2025, in PPR, a player counting once he
has 20 targets and carries behind him and played two of the next four.
Weeks won is how many of the 110 season weeks the weighted share ordered
better in, and seasons is the same count over the eleven seasons, which
is the harder test because the ten weeks of one season share most of
their players.

```
position  measure       raw    leverage   within a week   weeks won  seasons  agree   pairs
RB        carry share   0.572  0.578     0.558 / 0.564     71/110     8/11  0.992    7307
RB        target share  0.475  0.493     0.458 / 0.475     82/110     9/11  0.976    7307
RB        work share    0.616  0.615     0.604 / 0.603     50/110     5/11  0.989    7307
TE        carry share   0.098  0.108     0.100 / 0.111     50/109     7/11  0.975    3283
TE        target share  0.525  0.529     0.452 / 0.458     66/109     7/11  0.985    3283
TE        work share    0.525  0.541     0.447 / 0.472     72/109     7/11  0.977    3283
WR        carry share   0.064  0.066     0.063 / 0.064     65/110     5/11  0.988    9319
WR        target share  0.583  0.581     0.553 / 0.554     57/110     5/11  0.985    9319
WR        work share    0.583  0.588     0.551 / 0.559     74/110     9/11  0.982    9319
```

The same again over only the players under 15% of their side's work,
which is where the idea should matter most:

```
position  measure       raw    leverage   within a week   weeks won  seasons  agree   pairs
RB        carry share   0.216  0.238     0.168 / 0.190     72/110     8/11  0.950    3153
RB        target share  0.183  0.194     0.154 / 0.173     61/110     5/11  0.949    3153
RB        work share    0.299  0.311     0.252 / 0.272     66/110     6/11  0.931    3153
TE        carry share   0.094  0.103     0.096 / 0.107     49/107     7/11  0.974    3221
TE        target share  0.511  0.514     0.438 / 0.443     64/107     7/11  0.984    3221
TE        work share    0.510  0.527     0.428 / 0.455     71/107     7/11  0.975    3221
WR        carry share   0.034  0.033     0.036 / 0.034     54/110     4/11  0.986    8073
WR        target share  0.510  0.508     0.464 / 0.469     61/110     5/11  0.979    8073
WR        work share    0.508  0.515     0.465 / 0.477     72/110     9/11  0.973    8073
```

`margin` is the shipped shape. It ordered better in 587 of the 987 season
weeks the first table counts where `doubt` managed 555, and the pooled
numbers differ by a few thousandths in both directions.

Read straight, the weighting does not beat raw share by enough to replace
it. The agree column says why: the two order the same players at .93 to
.99, so there was never much room for either to move. The cell it does
help is a back's target share, .475 raw against .493 weighted, 82 weeks
of 110 and 9 seasons of 11. A back catches passes when his side is
behind, which is where the score distorts usage most, so that is where
the idea had the most to find. A rotational back's carry share is the
other one, .216 against .238 over the 3153 weeks under 15% of a side's
work, 8 seasons of 11.

Everything else is inside the noise or the wrong way round. A back's work
share, his targets and carries together, which is the best single number
he has at .616, goes to .615 and wins 5 seasons of 11. A receiver's
target share goes .583 to .581 and also wins 5 of 11.

Nothing in the model reads the file, and on these numbers nothing should
read it in place of raw share. It still answers the question it was built
for, which is which backup is being worked into a role rather than
mopping up, and there it adds two hundredths of ordering on a rotational
back's carries.

The last block of the probe checks the trend `src/features/leverageUsage.ts`
reports, which is the last three weeks of share against everything before
them, pulled toward the position's mean by how many chances are behind
it. Against how a player's points a game actually moved, from the weeks
before the probe week to the four after it, the trend ranks .091 for a
back, .045 for a receiver on targets and .041 for a tight end. Positive
at every position, and small.
# What a draft price is worth

`marketPriceProbe.ts` prints all of this in about fourteen seconds. It
covers 1892 priced players over 2015 to 2025, PPR points a game, and
every season is scored against a curve fitted only on the seasons before
it.

The price is a good ordering and the hit rate is close to calibrated.
Points a game order at .70 Spearman against a curve that never saw the
season, and bucketing players by the chance the curve gave them lines up
with how often they finished inside the starter tier: 14.3% said against
15.6% really over 409 players, 36.9% against 36.6% over 254, 52.7%
against 52.8% over 235. The top bucket is the one that is off, 68.2%
said against 72.5% really, so an early pick hits slightly more often
than the curve admits.

## The two fits cannot be separated

Fitting points a game as a straight line on log price with one slope and
a position offset, against a windowed fit that pools neighbouring prices
until nothing rises with price, gives the same 3.78 points of error.
Each orders players better in four of the eight scored seasons, and no
season separates them by more than .02 of ordering. The windowed one
ships because the quantiles and the hit rate come off the same window,
so one thing is fitted rather than two.

## How wide the outcome runs at a cheap price

The outcome at a given price is close to symmetric. Measured as the mean
minus the median over the middle eight tenths, every position and price
band comes out inside ±0.08, and the season total says the same thing as
the rate. The cheapest back band is the most skewed on the board at 0.08
for points a game and 0.19 for the total, which is small.

What does move, and moves a lot, is the width. From the 10th to the 90th
percentile as a multiple of the median:

```
RB 1-12   0.67     RB 49-96  0.92     RB 97-160  1.44
WR 1-12   0.60     WR 49-96  0.82     WR 161+    1.35
QB 13-24  0.39     QB 49-96  0.46     QB 97-160  0.64
```

A cheap pick is the same shape of bet as an early one spread over twice
the range, and a quarterback is half the bet a back is at any price. A
ranking step should read the quantile width rather than reach for a skew
correction.

## What a wide pick spread says about a player

At a fixed price, cutting players into thirds by how wide their pick ran
across the sampled drafts, the right tail does not move: 11.4% of the
tightest third beat the 90th percentile for their price against 9.6% of
the widest, which is 1.0 standard errors and the wrong way round.

The hit rate does move, and also the wrong way round. 40.3% of the
tightest third finished inside the starter tier against 33.3% of the
widest, 2.5 standard errors apart. A room that cannot agree where a
player goes is telling you he is less likely to start, not that he has
more upside. How many drafts took him points the same way and does not
clear two standard errors, at 1.5.

The thirds are level on price, which is what makes them comparable: each
one averages .46 to .49 of the way through its own price window, where
half is dead level. The measure is a within-window rank, so a tenth
rounder whose pick moves four rounds is being compared against other
tenth rounders rather than against first rounders.

Nothing here is fed forward yet. The next thing to try is shading the hit
rate by the spread rather than shading the mean or the tail.

## What the numbers rest on

Two to three drafted players a season never appear in a stat line, and
they are kept at zero points a game rather than dropped. Nought to two
board names a season match nobody on any roster and are left out, so the
name join is close to complete. Every board from 2015 to 2025 has the
pick spread and the draft count on it. Boards pulled before September
2026 do not, because `pullAdp.ts` was dropping both fields on the way to
disk; it keeps them now, so the 2026 board has to be pulled again before
the disagreement measure can say anything about this season.

# Whether a sleeper score beats who is hot

`sleeperEval.ts` prints all of this in about ten seconds. At weeks 4, 6
and 8 of each season it takes the players priced past pick 100 or not
drafted at all, has every method pick its top twenty, and scores those
twenty on what they went on to average and on how many of them finished
inside the tier a league starts. That is 11529 player cuts over eight
seasons, 9110 of them cheap enough to be picked from, all in PPR.

`src/model/sleepers.ts` is the model. One ridge fit predicts points a
game over the rest of the season from the price curve's median and width,
the player's work share, the leverage lift on that share, his shrunk
trend, his points a game so far, his games played and how far his pick
moved across the sampled drafts. Its score is that number less the same
fit's number for a player at the same price and position whose form is
average for that position, so the price level comes out of it. The
reasons come back with the score: each one is a term's weight times how
far the player is from an average player at his position, and they add up
to the score exactly.

Points a game over the rest of a season divides by the games the player's
club played rather than by the ones he played, so a back who tore
something in November is worth what he was worth. Finishing inside the
tier is read off total points over the same weeks against every player at
the position, not only the cheap ones, which is why the oracle stops at
0.698 and not at 1: a player can be the best of the cheap ones and still
miss the top 24 receivers.

The bench covers 2019 to 2025 rather than 2016 to 2025. A price curve
wants three earlier boards and the first board on disk is 2015, so 2018
is the earliest season that has one, and 2018 is then the earliest season
with cuts, so there is nothing before it for a fit to read.

```
method                    ppg a pick   prec@10   prec@20   picks   worst season  median   best
the price itself            8.55     0.238     0.250     420           7.30    8.23   9.99
points a game so far       11.17     0.410     0.343     420           9.50   11.03  12.77
raw work share              8.24     0.319     0.288     420           7.69    8.19   9.18
the model                  10.02     0.438     0.398     420           8.98   10.11  10.93
the model over the curve    8.26     0.338     0.260     420           6.74    8.12   9.72
the model's own line       11.58     0.414     0.350     420          10.37   11.83  12.79
oracle: the rest known     15.45     0.852     0.698     420          13.87   15.59  16.67
```

What the 2018 to 2024 fit weighs, in points a game for each standard
deviation of a term:

```
  intercept               5.33     work share             0.60
  price median            0.14     leverage lift         -0.09
  price width             0.06     trend                  0.34
  price hit rate          0.81     points a game so far   2.22
  off the board          -0.73     games played           0.58
  is RB / WR / TE   -0.89 / -0.63 / -0.96
                                   pick spread            0.13
```

## Reading it

The score does not beat who is hot at finding the players who go on to
score the most. Its twenty average 10.02 points a game over the rest of
the season where points a game so far gets 11.17, and it wins one season
of the seven.

Where it does win is how many of its picks turn into somebody a league
starts. 0.398 of its top twenty finish inside the starter tier against
0.343, and 0.438 of its top ten against 0.410, and it beats points a game
so far on precision at twenty in five seasons of seven. Those are two
different questions and the score wins the second one. A league that
needs a startable flex every week cares about that one, and a league
chasing points at any position cares about the first.

The plain projection wins the points outright. "The model's own line" is
the same fit with nothing taken off, and it averages 11.58 a pick against
points a game so far's 11.17, five seasons of seven. So taking the price
off costs a point and a half a pick and buys five points of precision.
The players the board is highest on among the cheap are the ones already
scoring, and subtracting the price pushes them down in favour of players
whose share and trend say more than their box score does.

Taking the price curve's median off instead is the wrong subtraction.
That reads 8.26 a pick and 0.260 at twenty, which is the board's own order
and nothing more, and it loses to every other method in every season. The
curve's median is a whole season's points a game over the games a player
played and the target is a rest of season rate over the games his club
played. The gap between those two grows as the price falls, so the
subtraction puts an error that moves with the price into the ranking.

Points a game so far is most of the fit, at 2.22 of a point for each
deviation where nothing else clears 0.81. The work share is worth 0.60
and the trend 0.34, both positive, which is the first time either has
been read forward. The leverage lift comes out at -0.09, so weighting a
touch by how open the game still was adds nothing here, which is what the
leverage probe said about everybody outside the rotational cohort.

The pick spread comes out at +0.13 rather than negative. The disagreement
finding above is about the hit rate at a fixed price and this is points a
game with four to eight weeks of form already in the fit, so the two are
not measuring the same thing, and 0.13 of a point is small either way. A
wide spread on a player who has since taken a job is a room that was late
rather than a room that was right.

Centring the form terms on every position at once instead of on the
player's own makes the score prefer cheap quarterbacks, since a
quarterback outscores the average skill player at any price. That reads
11.17 a pick and 0.395 at twenty, and it gets there by handing a
quarterback a claim against the board he has not earned, so the per
position centre is what ships even though it scores worse on the points.

## What to try next

Three things, in the order they look most likely to pay.

Fit the rest of a season per position rather than pooled with position
offsets. Points a game so far is doing nearly all the work and its slope
almost certainly differs between a quarterback and a tight end, and one
pooled slope is why the score has to be re-centred per position after the
fact.

Score the thing the score is for. The fit predicts points a game and the
measure it wins on is whether a player clears his position's starter
tier, so fit that instead, as a probability, against the curve's own hit
rate at his price. The hit rate is already the best price term in the fit
at 0.81 and it is the only one pointing at the tier.

Put the player's own remaining schedule in. Nothing here knows who he
plays, and a cheap back with six soft fixtures left is a different bet
from one with six hard ones.

# What snap share and a short season are worth to the board

`seasonShrinkEval.ts` prints this in about eight minutes. It covers
2086 players over 2019 to 2025, PPR points a game, with the fit for
each season taught only on transitions that had finished before it.

The season model used to start from a player's own points a game and
never ask how many games that came off or how much of the offence he
was on the field for. Snap share reached the trees but not the level
the trees scale, and the two halves are averaged, so it moved a
projection barely at all.

Two changes, and the numbers with the model as it was beside them:

| | error | correlation | ordering | part time | under 11 games |
| --- | --- | --- | --- | --- | --- |
| his own last season | 2.795 | .802 | .795 | 2.406 | 2.649 |
| the model as it was | 2.485 | .834 | .824 | 2.201 | 2.223 |
| snaps read, short seasons shrunk | 2.453 | .838 | .831 | 2.157 | 2.178 |
| a reader who knew the answer | 0 | 1 | 1 | 0 | 0 |

Part time means a player who took under half his side's snaps. The
change wins six of the seven seasons and loses 2023 by .03.

## Where the level should pull toward

Toward what his snap share pays, not toward his position's mean. Both
were measured on the level alone, before the ridge and the trees. The
position mean is best at a shrinkage of two games and gets worse from
there, and it makes part time players worse, 2.396 against 2.356,
because it drags a rotational receiver up toward a starter. The snap
share line still wins at twenty games, and it is the part time players
it helps most.

Adding targets, carries and air yards to that line is worse than snap
share alone, 2.671 against 2.656. Volume per game is measured over the
same short season the points are, so it repeats the noise it was meant
to temper.

## How much to shrink

The fit picks it, so nothing is hand chosen: whichever shrinkage
predicts the training seasons best, over nothing to twenty games. Nine
seasons of players land on five, and the whole model scores 2.447 to
2.454 anywhere from two to eight, so the answer is not delicate.

## What to try next

Split the shrinkage by why the season was short. A player who was hurt
in week nine and a player who was inactive for eight weeks both come
out with nine games, and the first one's average is the better read of
him.

Take the same idea into the parts model. The board's own points a game
is the parts line scored by the league rules, and the parts are still
scaled off a short season at face value.
