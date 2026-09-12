# Where the walk's kicking excess comes from

A kicker on the board takes 2.27 field goal attempts a game where his
side really takes about 2.0. Run any of the player eval with
`DRIVE_CHECK=on` and it prints everything below.

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

A throw goes to a man drawn from his share, and the walk then tries to
draw one of his own plays. It gives up when he has fewer than 25 in
three seasons and falls back to a pooled draw.

That fallback takes **20.5%** of every throw. In life the men with
fewer than 25 targets over the same seasons take **4.9%** of them, so
the walk sends a fifth of its passing to the back of the roster.

The fallback gains badly as well. It draws from a cut averaging 5.22
with 44.2% of it going nowhere, where a targeted throw averages 7.33
and misses about 35% of the time. A fifth of throws come back worth
4.62, and the passing runs 10% short of the pool it samples.

Being short there is what hides the second one. `storePlays` keeps only
the plays a man was credited with:

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

The shares handed to the walk give a side's five busiest men 59.9% of
its throws where a side gives them 74.2%. The walk's own leaning and
script multipliers push that back up to 71.8%, so the flatness is in
the projected shares and not in the walk.

Those shares divide a position's work by `Math.pow(standing, sharpness)`
and sharpness is 1. It was swept over 2024 and 1 came out best, .761
against .724 at .5 and .733 at 3. That sweep scored **ordering men**,
which is what the board reads. Picking who catches a particular ball is
a different job and wants a sharper number. The two uses pull opposite
ways on one model.

## What was tried, and what it cost

Sharpening only the walk's own targeting, leaving the projection alone:

```
sharpness   five busiest take   throws to men it cannot sample
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

A man drawn on the eight gets a play he made at midfield, capped at the
goal line. Getting that conditioning right, and then putting the sacks
back, is the fix. Everything else in here follows from it.

## The order to do it in

1. The target shares, so a fifth of throws stop going to men nobody
   throws to. Sharpening the walk alone gets part of it; the rest is
   that `among` carries 27 men where a side dresses about 11.
2. The pooled draw those fall back to, which gains 4.62 where a
   targeted throw gains 7.33.
3. The sacks and the balls thrown away, drawn from where the ball is.
4. Refit the clock, which will have moved.

Each one changes what the next is measured against, and the yardage has
to come out within a percent or two at the end of it, so they want
doing together with the box score evals beside them.

# Where the weekly points line has room left

`npx tsx scripts/boxScoreWeekEval.ts` scores every way of guessing one
man's week over 2024 and 2025, weeks 1 to 17, by position and split at
week 4. It runs in about twenty seconds. Everything is full PPR, because
Sleeper's points column is PPR.

Two rows are the reason the bench exists. "Oracle: usage known" gets the
man's actual targets, carries and pass attempts and has to guess his
rates from his own history. "Oracle: rates known" gets the rates and has
to guess the usage. Together they say which half of a usage model has the
points in it.

Points per man per week, mae and bias:

```
  candidate                          QB wk1-4       RB wk1-4       WR wk1-4       TE wk1-4      QB wk5-17      RB wk5-17      WR wk5-17      TE wk5-17
  ours (shipped ridge)             6.45/+0.26     4.45/-0.17     4.75/+0.41     3.49/+0.37     6.29/-0.13     4.28/+0.24     4.29/+0.00     3.56/-0.26
  sleeper                          6.80/+3.65     4.09/-0.28     4.44/-0.04     3.40/+0.00     6.67/+2.69     4.26/-0.20     4.37/-0.16     3.66/-0.82
  blend 0.5                        6.33/+1.54     4.22/-0.25     4.64/+0.19     3.51/+0.26     6.22/+0.79     4.31/-0.00     4.38/-0.09     3.64/-0.56
  naive trailing 4                 6.92/+0.22     4.26/-0.48     4.83/-0.14     3.54/-0.14     6.53/-0.36     4.46/-0.02     4.45/-0.05     3.77/-0.22
  (a) component                    6.25/+0.52     4.18/-0.19     4.48/+0.11     3.36/+0.24     6.39/-0.06     4.33/-0.08     4.35/+0.07     3.61/-0.30
  (a) component, vegas lift        6.30/+0.77     4.20/-0.10     4.49/+0.21     3.38/+0.31     6.37/+0.26     4.33/+0.06     4.37/+0.21     3.62/-0.22
  (a) component, blend 0.5         6.30/+1.68     4.12/-0.27     4.54/+0.03     3.45/+0.17     6.31/+0.89     4.32/-0.15     4.39/-0.04     3.68/-0.57
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

Targets and carries, mae per man per week, over every week:

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

The component model already beats the shipped ridge across the early
weeks, by 0.20 at quarterback, 0.27 at back, 0.27 at receiver and 0.13 at
tight end, and it loses by about a tenth from week 5 on. That is the
split to ship: the ridge has four weeks of in-season form to fit and
nothing before that, and a man's previous season put through per-touch
rates is a better guess in September than his season line is. Three
things that looked worth trying are not. Scaling a man's touches by his
side's implied total costs a tenth of a point everywhere, so Vegas is
already in the ridge and adding it again double counts. The game
simulator's touches are worse than his trailing four games at predicting
his own touches, at every position, and its points are biased a point
and a half low at quarterback and tight end, so it belongs nowhere near
the usage input until that bias is fixed. And splitting the residual
model into 10 or 20 buckets instead of 5 moves the Brier by 0.0004: it
does widen the top of the band, a back projected for 22 going from a
21.6-point eighty to 24.9, but nothing downstream notices.
