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
