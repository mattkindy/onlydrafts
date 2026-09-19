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
- `playedSeason.ts` plays a whole season over every core and writes
  `data/kept/played-<season>.json`, which the board reads the walk's
  opinion of a player out of. Rerun it when the play layer changes.

**The benches that are still run.** These are not part of any build.
`boardShareEval.ts`, `walkWeeklyEval.ts` and `scorePredictionEval.ts`
are the three the scoreboard is scored on. The rest each back a
constant or a decision that is still in the model, and `src/README.md`
says which: `walkBandEval.ts`, `twoPointEval.ts`, `sourceCompare.ts`,
`knowableWeekEval.ts`, `mechanicsCarryEval.ts`, `walkWeekCache.ts`,
`jointProjectionEval.ts`, `playLayerEval.ts`, `estimateCorrelation.ts`,
`exemptCheck.ts`, `leverageUsageProbe.ts`, `marketPriceProbe.ts`,
`sleeperEval.ts`, `seasonShrinkEval.ts`, `inSeasonLevelEval.ts`,
`kickerSeasonEval.ts`, `kickerWeekEval.ts`, `walkVolumeEval.ts`,
`injuryStatusEval.ts` and `simAgreement.ts`.

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

## Step three, done on its own

The sacks and the balls thrown away are in the walk now, out of turn,
because what they were breaking was the line and not the drive. Two
things were wrong and only one of them is football.

`linesFrom` credited the passer with an attempt for every snap a flag
wiped out, 4.5 a team game, which is why the walk threw 40.7 times a
game where sides throw 33.7. That one is bookkeeping and costs nothing
to put right.

The other is that every pass play named a receiver, so the walk had no
sack and no ball thrown away and a receiver was credited with all of
it. How it is asked decides what it costs. Asked before the throw, the
way the sweep above asked it, a sack is an extra failed pass play and
the drives pay for it. Asked after the throw has already failed, it
takes its share of the failures the pools already produce: 26.9% of
failed pass plays had nobody on them, 59.4% of those were sacks, and a
sack cost 7.09 yards. Then the only new thing is the yards a sack
loses where the incompletion it replaces lost none.

```
                      before   asked before   asked after   2023   2025
drives a side          11.26         12.08         11.43     11.02  10.45
snaps a drive           5.54          5.22          5.47       5.88   6.04
punt                   34%           41%           40%        38%    34%
touchdown              23%           19%           20%        20%    23%
kicks a side a game     1.93           -            1.95       -     1.97
```

The three walk columns are 2025's world, the first two at two passes
through the season and the third at forty. Sides punted 38% of the
time in 2023 and 34% in 2025, and the walk learns its drives off the
four seasons before the one it plays, so which year it is being read
against moves the answer as much as the change does. Asked after the
throw it lands on 2023's endings and four points of punting above
2025's. The drives are still half a drive long either way, which is the
same half a drive the order above is about.

The volume, a team game, walk over what the season had:

```
              2023          2024          2025
          before after   before after   before after
passAtt     1.21  1.01     1.24  1.04     1.26  1.05
targets     1.13  1.02     1.15  1.04     1.17  1.05
receptions  1.02  1.03     1.03  1.04     1.06  1.06
carries     0.98  0.98     0.98  0.98     0.99  0.99
passYds     1.01  1.02     1.05  1.06     1.10  1.11
```

Per player the attempts come right where they were worst. A top twelve
quarterback threw 1.17, 1.20 and 1.20 times what he really threw and
now throws 1.00 in all three seasons; the next twelve go from 1.32,
1.37 and 1.35 to 1.14, 1.14 and 1.11. A top twelve receiver's targets
go from 1.31, 1.15 and 1.20 to 1.18, 1.03 and 1.08. The catches and
the yards barely move, which is the point: none of this was scoring.

What is left is the flatness, which is step one. A receiver's targets a
game over his own comes out at a median 1.07, 0.96 and 1.03 against
1.18, 1.06 and 1.12 before, but over the 24 men the walk throws at most
it is 1.26, 1.34 and 1.37 against 1.39, 1.51 and 1.53. The walk still
picks its own favourites and overfeeds them, and relabelling the sacks
does not touch that. Puka Nacua's 2026 goes from 256 targets to 218
over the same fifteen games it deals him.

## What it cost, and which half cost it

Three arms, each with its own forty pass played season and both benches
read off it: the walk before any of this, the walk with both halves,
and the walk with the sacks left in the state pools. Per season, 2023,
2024 and 2025.

```
                                before        both halves    sacks left in
board, season                .7519 .761 .723 .771   .7530 .762 .723 .773   .7529 .761 .724 .773
board, first 24              .7147 .667 .734 .744   .6989 .666 .687 .744   .6989 .666 .687 .744
the walk's column, season    .7143 .730 .671 .742   .7117 .729 .662 .745   .7122 .727 .665 .744
the walk's column, first 24  .6266 .619 .525 .735   .5059 .572 .381 .565   .4993 .566 .382 .549
weekly, 2025, two seeds      .365                   .358                   .3635
```

The rivals read the same in all three, .7141 and .6083 for where adp
had him and .6468 and .6589 for the walk at nothing, so the arms are
comparable.

The two halves are separable and the pools are not what costs the
first 24. The volume comes out the same either way, to two decimals on
every line, so the whole of it is the flag attempts and the sack draw.
And the first 24 reads .6989 with the sacks in the pools and .6989 with
them out, with the walk's own column a shade worse for keeping them.
Leaving them in buys nothing and charges a fallback throw for the sack
twice, so both halves ship.

What the first 24 costs is the sack itself. The board's fall is one
season, 2024, from .734 to .687, with 2023 and 2025 unmoved; the walk's
own column falls in all three. The walk keeps twenty percent of a seat
on the board, which is why the board only feels a fifth of it. A sack
now takes seven yards off a drive where the incompletion it replaces
took none, and the men the first 24 is ordered on are bunched tightly
enough that a small change in points reorders them. That is the price
of having sacks at all, and the plays say sides take 2.3 of them a
game.

Nothing was tuned to make this look better. The volume is what the fix
was for and the volume came right.

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

`sleeperEval.ts` prints all of this in about twenty seconds. At weeks 4, 6
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

Every method is scored under two readings of what happened after the cut,
because the first one pays a ranking for durability nobody could see in
week 6.

The first reading is the one this bench has always used. Points a game
divides by the games the player's club played rather than by the ones he
played, and the starter tier is taken on total points, so a back who tore
something in November falls out of the tier.

The second reading divides by the games he played and takes the tier on
that rate, among the candidates who played at least four games after the
cut. Four is the floor because the rest of a season runs ten to fourteen
weeks from these cuts: two big afternoons off a bench would otherwise
land a player inside a tier, and six would throw away most of the players
the reading exists to keep. 6776 of the 9110 cheap candidates clear it.
Moving the floor to two or to six leaves every ordering below unchanged.

The two readings agree about most players. 412 cheap candidates are
inside the tier both ways, 146 only on the total, and 99 only on the
rate.

Either way the tier is read against every player at the position, not
only the cheap ones, which is why the oracle stops at 0.698 and not at 1:
a player can be the best of the cheap ones and still miss the top 24
receivers.

The bench covers 2019 to 2025 rather than 2016 to 2025. A price curve
wants three earlier boards and the first board on disk is 2015, so 2018
is the earliest season that has one, and 2018 is then the earliest season
with cuts, so there is nothing before it for a fit to read.

```
                         club games, on the total  games played, on the rate
method                       ppg  p@10   p@20  h@20    ppg  p@10   p@20  h@20   picks
the price itself            8.55  0.238  0.250  105  10.07  0.229  0.236   99     420
points a game so far       11.17  0.410  0.343  144  13.43  0.410  0.329  138     420
raw work share              8.24  0.319  0.288  121   9.68  0.267  0.231   97     420
the in-season level        11.06  0.376  0.312  131  13.56  0.357  0.295  124     420
the role level             10.60  0.290  0.269  113  13.09  0.276  0.233   98     420
the model                  10.02  0.438  0.398  167  11.65  0.405  0.364  153     420
the model over the curve    8.26  0.338  0.260  109   9.77  0.310  0.236   99     420
the model's own line       11.58  0.414  0.350  147  13.73  0.438  0.345  145     420
the model plus in-season   10.02  0.438  0.393  165  11.69  0.395  0.355  149     420
plus in-season, own line   11.48  0.414  0.338  142  13.67  0.443  0.336  141     420
usage, no points            9.00  0.386  0.343  144  10.46  0.343  0.310  130     420
usage plus role             9.45  0.405  0.360  151  11.07  0.357  0.310  130     420
usage, split trend          9.04  0.376  0.345  145  10.47  0.338  0.310  130     420
usage, own line            10.96  0.338  0.321  135  12.74  0.376  0.312  131     420
oracle: the rest known     15.45  0.852  0.698  293  16.23  0.762  0.626  263     420
oracle: the rate known     13.99  0.686  0.562  236  17.14  0.790  0.586  246     420
```

The four in-season rows are written up further down and the four usage
rows after them. The script also prints every method at each cut on its
own under both readings, the spread across seasons, where by position its
picks went, and how close each line comes to the rest of the season over
the same candidates.

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

Some of that lead was the outcome and most of it was not. Taking the tier
on the rate over the games each player played, the score reads 0.364
against 0.329, so the gap narrows from 5.5 points of precision to 3.5 and
the score still wins, four seasons of seven rather than five. The same
happens to every method that ranks on who is scoring: points a game so
far loses 6 of its 144 hits when a player is no longer punished for
missing December, and the score loses 14 of its 167. So the score was
being paid a little for picking players who stayed healthy, and it keeps
the win without that.

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

## Whether the in-season update helps

It does not. The update is the rest of season level from
`src/features/inSeasonLevel.ts`: a preseason anchor moved by what a
player's usage says his role pays and by his points a game so far. On
this bench the anchor is the price curve's median at his price, and both
the role level and the update weights are fitted on seasons before the
one being scored. The candidates, the cuts and the definition of a hit
are the ones above, untouched, and every number for the old methods comes
out where it was.

Three ways of adding it, all in the table above. The update on its own
reads 11.06 a pick and 0.312 at twenty, so it beats the price and loses
to points a game so far on both. The role level on its own, which is what
the usage pays with the player's own scoring rate left out, reads 10.60
and 0.269. Adding the two to the model as terms leaves it where it was:
10.02 a pick either way, 165 hits against 167, 0.393 against 0.398. Each
cut reads the same way: the pair is 54 hits against 56 after week 4,
level at 55 after week 6, and level at 56 after week 8.

The weights say why. Points a game so far falls from 2.22 to 1.83 and the
work share from 0.60 to 0.50 when the two new terms arrive at 0.34 and
0.22. The update is made of usage and points a game so far, the fit
already reads both, so the terms take weight off what they are made of
and the order barely moves.

On the question the update was built for it does beat points a game so
far over these candidates, and loses to the fit's own line, which is the
measure that matters here since that line is what the ranking comes off:

```
rest of season over the cheap candidates, MAE then correlation
                               week 4      week 6      week 8
the price median            5.51 0.331   5.73 0.302   5.94 0.269
points a game so far        2.83 0.632   2.70 0.643   2.65 0.647
the in-season level         2.72 0.653   2.71 0.653   2.70 0.652
the role level              2.76 0.633   2.76 0.626   2.74 0.625
the model's own line        2.25 0.669   2.24 0.673   2.29 0.678
plus in-season, own line    2.24 0.671   2.24 0.674   2.28 0.679
```

## Who the update finds and who it likes by mistake

The update on its own and the role level on its own rank on points a game
with nothing taken off, so they fill up on quarterbacks: 313 and 346 of
their 420 picks, against the model's 68. That does open the blind spot.
Between them they add 53 and 59 hits the model's top twenty never had,
and the first dozen are all passers: Justin Herbert in 2020, Trevor
Lawrence and Matthew Stafford in 2025, Ryan Tannehill in 2020, Bo Nix in
2024, Justin Fields in 2022.

It costs more than it pays. The same two orders add 198 and 240 misses,
and those are passers too: Andy Dalton at 23.5 points a game in relief
and nothing after it, Marcus Mariota, Jameis Winston, Joe Flacco, Dwayne
Haskins, Deshaun Watson, Dorian Thompson-Robinson on a role level of 17.8
off 1.2 points a game. Pass attempts pay a quarterback level whatever he
does with them, and most of these lost the job or the season inside a
week or two. They drop 89 and 113 hits to make room, among them Justin
Jefferson in 2020 at every cut, Brian Thomas Jr. in 2024, Brock Bowers,
Bucky Irving and Hunter Renfrow.

Added to the model as terms, where the score is centred inside a position
again, the two change almost nobody: 20 swaps out of 420. It adds
Courtland Sutton after week 4 of 2024 and Zach Ertz after week 8, both
hits, and drops Jefferson in 2020, Brock Purdy in 2023, Cole Kmet and Pat
Freiermuth. The other 20 it adds all miss, and most are the same
caretaker passers. So the earlier read is unchanged: the model still
finds its hits through work share at back and tight end, 88 of its 167,
still takes only 68 quarterbacks, and its worst calls are still one good
game and a job that was never his.

## Taking the points back out of the terms

Points a game so far is the biggest term in the shipped fit, and a player
can score well and then get hurt or score badly on work that pays in
December. So three more fits drop it. "usage, no points" is the shipped
set without it. "usage plus role" adds the role level back, which is what
his usage pays with his own scoring rate left out. "usage, split trend"
is the first one with the trend split into the target trend and the carry
trend it was summed from.

None of them ship. Against the shipped 0.398 at twenty they read 0.343,
0.360 and 0.345, and on the rate against 0.364 all three read 0.310. The
per-game outcome was where they had the best case and it does not arrive.
They lose the points a pick too, 9.00 and 9.45 against 10.02.

Splitting the trend changes nothing: 0.345 against 0.343, with the target
trend at 0.19 and the carry trend at 0.30 where the sum was 0.38.

With the points gone the work share takes the weight, 1.68 against 0.60,
the price hit rate goes to 1.16 and games played to 0.78. The usage set
swaps 167 of the model's 420 picks. It adds 37 hits and 130 misses and
drops 60 hits and 107 misses, so it is not finding a different kind of
player so much as a worse-ordered one. What it adds are backs whose share
arrived before the points did, Bucky Irving in 2024 at weeks 4 and 6 and
Courtland Sutton in 2024, and what it drops are quarterbacks who were
already scoring and went on scoring, Josh Allen in 2020, Baker Mayfield
in 2024 at three cuts, Dak Prescott in 2019 at all three.

That is the finding underneath. The worry is a player whose points so far
are a lie, and the fit's own answer is that most of the time they are
not. A cheap player scoring 20 a game in week 6 usually keeps a good part
of it, and the four to eight weeks the cut reads are long enough that
this is true more often than it is false. Dropping the term to avoid the
Andy Daltons costs more Dak Prescotts than it saves.

The role level is the closest thing to a usage-only term that works, at
0.360, and it gets there by being made of usage: a 2.00 weight on it in
the usage fit against the 0.22 it takes beside the points. It is still
under the shipped 0.398.

The script prints the top ten after week 6 of 2025 under all three sets,
so the swap can be read player by player. The shipped set leads with
Javonte Williams, Rico Dowdle, Cam Skattebo, Jake Ferguson and Dallas
Goedert, the first two on points a game so far. The usage set keeps
Dowdle, Williams and Skattebo, all of them on work share, drops both
tight ends, and brings in Jordan Mason, Kenny Gainwell and Jacory
Croskey-Merritt. Adding the role level puts Goedert and Ferguson back.

## What to try next

Four things, in the order they look most likely to pay.

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

Ask whether the player still has the job in December. Most of what the
in-season update added were passers who scored well and then stopped
playing, and the model's own worst calls are the same story at back. A
term for how likely he is to keep the work would help both, where a
better read of the level did not.

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

# Updating the level once the season is running

The board's preseason number never moved on its own. Weeks 1 and 2 came
off usage times rates, weeks 3 to 5 faded between that and the preseason
projection, and from week 6 the preseason projection had the line to
itself. So by October the model was saying August was right whatever the
player had done since.

`inSeasonLevelEval.ts` asks the question that settles it. Standing at the
end of week W, how well does each reader predict a player's points a game
from week W plus 1 to week 18? Marked over 2019 to 2025, QB, RB, WR and
TE, everyone with a game before the cut and at least three after it.
Every fit, the anchor included, is trained on seasons before the one it
predicts.

Mean absolute error, points a game:

| after week | anchor | season to date | the update | oracle | players |
| --- | --- | --- | --- | --- | --- |
| 2 | 2.730 | 3.723 | 2.500 | 0 | 2292 |
| 4 | 2.803 | 3.130 | 2.474 | 0 | 2482 |
| 6 | 2.888 | 2.903 | 2.496 | 0 | 2524 |
| 8 | 2.980 | 2.867 | 2.541 | 0 | 2501 |
| 10 | 3.103 | 2.883 | 2.619 | 0 | 2417 |

Correlation with what happened:

| after week | anchor | season to date | the update |
| --- | --- | --- | --- |
| 2 | .797 | .720 | .832 |
| 4 | .783 | .771 | .833 |
| 6 | .769 | .787 | .827 |
| 8 | .753 | .795 | .823 |
| 10 | .734 | .791 | .811 |

The anchor gets worse every week it is left alone, which is the bug. A
player's average so far starts far worse and catches the anchor at week
6. The update beats both at every cut, and beats the better of the two by
between .23 and .33 points a game.

The quarter of players whose usage says the furthest from where August
had them is where it matters. Error on them, points a game:

| after week | anchor | season to date | the update |
| --- | --- | --- | --- |
| 2 | 3.206 | 4.033 | 2.573 |
| 4 | 3.405 | 3.382 | 2.558 |
| 6 | 3.431 | 3.126 | 2.566 |
| 8 | 3.541 | 2.996 | 2.525 |
| 10 | 3.719 | 2.969 | 2.623 |

Correlation on that quarter goes from .46 for the anchor at week 6 to
.73 for the update, and at week 10 from .37 to .72.

## What each part is worth

Usage first, points second. The usage term takes half its weight after
one to three games and the points term after five, fitted separately
every season and landing in the same place each time. Switching the
usage term off costs .055 at week 2, .018 at week 4 and .009 at week 6,
and by week 10 it is worth nothing at all, 2.620 without it against
2.619 with it. So the role reading pays for itself in September and
stops mattering once there are enough games for the points to speak.

Recency and the changepoint barely earn their keep. A decay of 0.9 on
the latest game is picked every season, and the break threshold is only
picked from 2025 on. Switching both off costs nothing before week 6 and
.027 at week 10. They stay because they are what makes the update move
fast when a role changes outright, which is the case it is for, but the
pooled number does not see it.

## Travis Hunter

He is the case that started this. His rows in the weekly file are filed
at cornerback, so the season model never sees him and his board number
comes from the rookie model, which has him at 15.5 in 2025 and 14.7 in
2026 and never moves. What the update says, reading his usage under the
receiver role model:

| cut | games | snap share | to date | role says | update | what happened |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 2 | .61 | 7.1 | 11.8 | 13.2 | 9.9 |
| 4 | 4 | .58 | 6.1 | 8.7 | 10.7 | 13.0 |
| 6 | 6 | .63 | 6.6 | 8.6 | 9.9 | 24.1 |

The rest of season figure at week 6 is off the two games he played
before he was hurt, so it is not much of a target. The point is the
anchor sat at 15.5 all year while his snaps and targets said a ten point
receiver. In 2026 he played four offensive snaps in week 1, seven per
cent, and the update takes him from 14.7 to 11.3 off that one game.

## What to try next

Read the team as well as the player. A receiver whose own share is
steady on a side that has started throwing forty times a game is a
different player from one on a side that has stopped, and nothing here
sees that.

Fit the role model on the horizon instead of the same games. It learns
what a role paid over the season it was measured in, which is the right
thing to point at a three game window but not obviously the right thing
to predict the next twelve weeks with.

Split the shrinkage by why a player's games are short, the same way the
season model still wants. A player back from a four week absence and a
player who has been rotational all year both come out at six games.

# How much the kicker model is worth

The kicker model had never been measured. `kickerSeasonEval.ts` and
`kickerWeekEval.ts` measure it two ways: how well it predicts a kicker's
points a game over a season, which is the draft question, and how well
it predicts one week of his, which is the start or sit question.

Both score under a middle of the road ladder: three for a field goal,
four from forty, five from fifty, a point an extra point and a point off
a miss, with nothing paid for yardage. The board itself pays a tenth a
yard, which roughly doubles the spread between kickers and is what makes
a long kicking club's kicker look worth reaching for.

## Over a season

Each season is predicted from the one before. The rates come from last
season's kicking, the kicks a club is expected to take come from the
walk it ran for the coming season, and nothing reads the season being
predicted. 79 kicker seasons over 2023, 2024 and 2025, averaging 8.14
points a game.

```
method                     MAE    corr    bias   spread
the model                 1.11   0.458   -0.06   0.87
last season, his own      1.34   0.130   -0.17   1.25
the mean kicker           1.15  -0.000   -0.17   0.00
an oracle                 0.00   1.000    0.00   1.54
```

The model beats looking up last year and it is not close: 0.458 against
0.130 on ordering, and a fifth off the error. It does not beat calling
every kicker average by anything that matters, 1.11 against 1.15 over 79
seasons, because a kicker's points a game only vary by 1.54 to begin
with and most of that is luck.

Which reading is right depends on what you are asking. If the question
is how many points he will score, assuming every kicker is average costs
you almost nothing. If the question is which kicker to take, the mean
has nothing to say and the model does.

The ceiling puts the 0.458 in proportion. A kicker's first half season
against his second reads 1.83 and 0.268, which by Spearman and Brown
makes a full season's reliability about 0.42. The model correlates 0.458
with a season it has not seen, which is at or above the reliability of
the thing being predicted. There is not much left to win here.

A leak check, since that number is higher than the ceiling suggests it
should be. The walk's projected kick volume for a club correlates with
the club's own kicking the season **before** more than with the season
being projected, in all three seasons (0.21 against -0.09 for 2023, 0.30
against 0.26 for 2024, 0.47 against 0.27 for 2025). The walk is
projecting forward, not peeking.

## Over one week

2174 kicker weeks over 2022 to 2025, averaging 8.08 points. The line
reads three things: what he has paid over his own recent weeks, what the
line expects his side to score, and how willing a staff at that ground
is to send him out.

```
method                       MAE    corr
the shipped line            3.70   0.101
the fit, held out           3.71   0.081
his own recent weeks        4.11   0.046
the mean kicker             3.72  -0.000
his own season, hindsight   3.52   0.326
an oracle                   0.00   1.000
```

Nothing about a kicker's week can be told in advance. Held out by
season the fit reads 0.081 and saves a hundredth of a point of error
against calling every kicker average. Even hindsight, his own average
over the whole season including the week being predicted, only manages
0.326.

The line ships anyway, because a kicker on the slate gets a fixture, a
floor, a ceiling and a score for a week already played, where before he
fell through to a flat eight point week with none of those. It should
not be read as ranking kickers.

One number in the fit looks wrong and is not. Expecting a side to score
more **costs** its kicker points, at 0.11 a point of implied total, and
the column on its own reads -0.091 against what he goes on to kick. A
drive that reaches the end zone pays him one and a drive that stalls in
range pays him three.

## What the flat 15.3 games is doing

Every kicker on the board is given 15.3 games. Over the same three
seasons the kickers who held a job in the spring played 15.0 on average,
so the level is right, but the shape is not: the median one played all
17, a quarter played 15 or fewer and a tenth played 9 or fewer. It is
two populations, the kicker who keeps the job and the kicker who loses
it, and 15.3 is the point between them.

Nothing available in the spring separates them. Last season's accuracy
barely moves it:

```
                    made   games played   under twelve
least accurate third  79%          14.6         6 of 27
middle third          88%          14.5         5 of 27
most accurate third   95%          15.9         1 of 28
```

Age moves it less, at -0.136 against games played over 112 job holders.
The kickers 34 and over played 14.5 games against 15.4 for everyone
else, and the four oldest to hold a job played 15, 16, 17 and 14.

So 15.3 stays. What the flat number was actually hiding was simpler and
worse: a kicker with no job at all was getting it. Matt Prater was
Buffalo's kicker on the 2026 board and Brandon McManus was Green Bay's,
and neither is on an NFL roster. The job read now asks the roster file
first, which drops both and picks up the five clubs whose kicker is new.

## What to try next

The board's make rate. Kickers really make about 84% of their attempts
and the board has them at 87.9%. Attempt volume is right, 1.96 a game
against 1.97 in life, so the excess is in the makes, which points at the
distances the walk generates being short of life rather than at anybody's
accuracy.

Two seasons of kicking rather than one. A kicker who missed last season
has no record at all, which is why Tyler Bass reads as a kicker with
nothing behind him after a year out.

Sleeper's kicker projections. `fetchSleeperProjections.ts` asks for the
skill positions and the defences and never for kickers, so a kicker's
slate row ships no rival number beside ours. Sleeper beat our defence
line through week four and it would be worth knowing whether it beats a
kicker line that reads 0.08.

# What a word on the injury report is worth

`injuryStatusEval.ts` counts the nflverse injury reports for 2018 to
2025 against what the player then did, at QB, RB, WR, TE and K. 6,499
listings, taking the last report of each player's week. He counts as
having played if he has a stat row or an offensive snap.

```
status         listings  played
Out                2637   0.001
Doubtful            417   0.012
Questionable       3445   0.639
```

Doubtful is out. Twelve of the 417 doubtful players in eight seasons
took a snap, which is close enough to zero that the app now prices it
there. Questionable is the word that decides a lineup, and about a third
of the players carrying it do not play.

Who it hits depends on the position. A questionable quarterback plays
43% of the time, where a receiver plays 68%:

```
pos           Out      Doubtful  Questionable
QB     0.00 (265)     0.00 (44)    0.43 (264)
RB     0.00 (603)    0.02 (119)    0.60 (878)
WR    0.00 (1125)    0.02 (163)    0.68 (1571)
TE     0.00 (580)     0.00 (79)    0.67 (633)
K       0.00 (64)     0.00 (12)     0.68 (99)
```

Practice splits questionable nearly in half:

```
practice   listings  played
DNP             533   0.432
Limited        2222   0.657
Full            638   0.745
```

A questionable player who does play scores 86% of what the same player
averaged over his weeks that season with nothing said about him, 7.1
points against 8.3, over 1,997 weeks. Whether that belongs on a
projection as a second discount, past what `playChance` already prices
in, is measured below.

Four rules for the chance he plays, fitted on 2018 to 2022 and scored by
Brier score on 2023 to 2025, against an oracle that knew the scoring
seasons' own rates:

```
rule                                    brier
A  the app today (Q 1.00, D 1.00)       0.2598
B  priors (Q 0.60, D 0.00)              0.1234
C  measured by status (Q 0.65, D 0.01)  0.1241
D  measured by status and practice      0.1224
   ceiling: the same seasons' own rates 0.1233
```

Treating everybody not ruled out as certain to play is twice as wrong as
anything else here. Past that there is almost nothing in it: Matt's
priors, the measured rates and the oracle all land within a thousandth
of each other, and practice participation buys a further 0.001. The app
ships the measured rates by status, since the live providers send the
status word and never say who practised.

## Whether the 0.86 belongs on a line

`questionablePlayedEval.ts` measured the two lines against what a
questionable player who played then scored, PPR, for 2024 to 2026, the
seasons `data/curated/sleeperWeekly.csv` covers. 382 questionable
listings matched both a stat row and a Sleeper number; 8,082 unlisted
players the same weeks are the control.

```
line        factor 1.0   0.86        fit factor   ceiling
ours             4.686       4.620    4.620 (0.86)     4.611 (0.9)
sleeper          4.651       4.548    4.546 (0.88)    4.546 (0.88)
```

Multiplying either line by 0.86 does lower its error. It also lowers the
control group's error by nearly as much: 0.86 knocks 0.066 points of MAE
off the questionable group's ridge line and 0.063 off the control
group's, and it knocks 0.103 off questionable's Sleeper line against
0.143 off control's. A skewed week of fantasy points rewards any
across-the-board discount, and the control group has nothing wrong with
it, so most of what 0.86 buys is that skew rather than anything about
being questionable. Netting the control group's own drop out of the
questionable group's leaves 0.003 of MAE for the ridge line and -0.039
for Sleeper's, both inside noise. Split by practice, questionable's own
ridge ratio runs from 0.82 at DNP to 1.00 at Limited to 0.87 at Full,
which does not look like a rate a single factor should chase either.

Neither line gets a `QUESTIONABLE_PLAYED_SHARE` constant. `playChance`
already prices how often he plays; the app does not fold a second
discount into what he scores when he does.

## What to try next

Practice participation from a live source. It is worth 0.001 on the
Brier score, which is nothing, but the split is wide: 43% for a player
who did not practise against 75% for one who practised in full. Sleeper
and ESPN both send only the status word.
