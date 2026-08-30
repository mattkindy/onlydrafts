# The scoreboard

What the benches said, in the order the changes landed, so a later
change can be judged against the one before it rather than against a
number somebody remembers.

Every row is the same three instruments:

- **board** is scripts/boardShareEval.ts over 2023, 2024 and 2025,
  walk forward, in the configuration that ships (unpriced men set back
  a hundred, rookies at their draft slot). Two numbers are worth
  watching, ordering a whole season and the share of the value in the
  first 24 picks, which is the first two rounds of a twelve team
  draft. The walk's own column is scored beside them.
- **weekly** is scripts/walkWeeklyEval.ts over 2024 and 2025, men
  averaging ten points or more, against the yardstick of saying every
  week is his average so far. That yardstick is .340.
- **game** is scripts/scorePredictionEval.ts, points off the margin
  over a season of fixtures, next to the betting line.

## Where it stands

| | board, season | board, first 24 | walk column, season | weekly, pooled |
|---|---|---|---|---|
| now | .7487 | .7050 | .6971 | .343 |

The walk's seat on the board is twenty percent. It is swept after
every change; through all of the below it has stayed there, because
the heavier seat keeps winning a whole season by about .003 and
losing the first two rounds by about .007.

## How it moved

| what changed | board season | first 24 | walk column | weekly |
|---|---|---|---|---|
| before this work | .7546 | not yet cut | .6754 | .331 |
| the fourth quarter conditioned properly | .7510 | .6961 | .6946 | |
| injuries lived as spells, a share made a role | .7488 | .6948 | .6692 | |
| the market settles a room's pecking order | .7510 | .6961 | .6946 | |
| the walk's seat cut to twenty percent | .7482 | .7035 | .6946 | .331 |
| what a side's formation does to a play | .7487 | .7050 | .6971 | .343 |

The board barely moves while the walk moves a lot, and that is
arithmetic rather than disappointment: the walk is one voice of four
at a fifth of the say, so a gain of .07 in its own column arrives at
the board as .014.

## Which part of a snap the walk gets wrong

A snap is three decisions and the walk is scored end to end, so a bad
week never said which of the three caused it. scripts/playLayerEval.ts
asks each one against the 35,050 plays of 2024, with a plain answer
beside it.

| the decision | the walk | a plain answer |
|---|---|---|
| run or pass | .2067 | .2450, saying the league rate every time |
| who gets the ball | 22.9% of the play to the man who got it | 16.1% from his own season share |
| and putting him top of the list | 29.1% | 32.1% |
| what he makes with it | 5.55 yards out | 5.40 for the call's average |

The call is much the strongest of the three and the yards are level
with the average. The plain answers in the last three rows are all read
off the same season they are scored against, so they know things the
walk cannot, and being level with them is better than it looks.

The yards first read 7.42 against 5.40, and that was wrong. The walk
draws a gain rather than predicting one, so a single draw has the whole
spread of the distribution in it and scores worse than a point estimate
even when the distribution is exactly right. Averaging twelve draws
gives 5.55.

## How often the walk hands it to him

Volume decides most of a back's week and none of it came from the walk.
The walk counts every carry, target, attempt and completion it deals
out, and the script that writes a played season to disk listed ten
parts and dropped those four. So a card showed a back's rushing yards
from the walk with no carries beside them, and the board's share seat,
its second heaviest at .3, was the share projection on its own. Adding
those four to the list is the whole fix.

scripts/volumeOrderEval.ts then asks whether the walk's allocation
deserves the seat. It reads the walk's shares off the plays that really
happened, so both are asked about the same plays and only the
allocation is judged.

| | the walk | the projection |
|---|---|---|
| 2023, 323 men | .707 | .642 |
| 2024, 322 men | .697 | .623 |
| 2025, 327 men | .673 | .625 |

The walk is ahead in eight of the nine position and season cuts, the
exception being 2025 tight ends. Only men both of them price are
counted. The projection says nothing at all about quarterbacks, and
leaving them in let every quarterback tie at nothing and handed the
walk the row.

The walk gives a side's busiest man 23.3% to 24.3% of the work where
the busiest man really took about 31%, in all three seasons. That looks
like an allocation far too flat, and it is not. The busiest man of a
season is picked knowing how the season went. Ask instead what the man
the walk itself puts first went on to take, and the walk gives him
24.3% where he took 23.9% in 2023, and 23.9% against 24.9% in 2024. It
is short only in 2025, 23.3% against 27.0%, and 2025 is the season
still being played, so its work has had less time to be spread around
by injuries.

Pulling the shares apart before they are normalised, to undo some of
the shrinking a projection does, costs ordering at every strength and
in every season: 1.1 takes 2024 from .697 to .692, 1.25 to .685, and
1.5 to .671, with the same slope in the other two. It does not buy
calibration either, since there was little to buy.

Both numbers that looked alarming here were artifacts of how they were
measured, and both were the same mistake: comparing a draw, or a
ranking, against something that already knows the answer. Measure what
the model actually claims.

## The snap chain, four ways

Drawing the formation and the defence's shell before the call, so the
call, the man and the yards all answer to one snap. It is how football
works and it has not paid yet. Each row is a week of a man's scoring
against .343 for the shipped walk.

| how it was built | reads |
|---|---|
| a table of its own, keyed on yardline deciles | .314 |
| the same cells as everything else, widened the same | .328 |
| plus recency in those cells, and less widening | .336 |
| as a leaning on the pooled rate rather than a rate | .327 |

The call from a formation asked 40.5% run where the plays it was
fitted on were 41.8%, and taking that apart is most of what was
learned. The bias sat evenly across every formation and down, which
is a level shift rather than a broken cell. Two things make it up.
How often a side runs at all has been flat for years, so pooling
seasons costs the ordinary call nothing, while running from the gun
went 27.0% in 2021 to 30.6% in 2023 and lining up in it went 66% to
72%. And keying the formation halves every cell, so a thin one
reaches further and smooths toward its neighbours: asking for eighty
plays before a cell speaks gives 41.0%, forty gives 41.2%, twenty
gives 41.4%.

The last row is the one to remember. As a leaning the call is better
calibrated and orders worse. Calibration and ordering are different
targets and only the second is what a board is scored on.

## Nine ways at the same wall

The thing every attempt has wanted is a matchup: what this defence
costs this receiver, rather than what it costs receivers. Six of them
were multipliers bolted onto one decision of a play, and three were
nets. scripts/interactionEval.ts scores the last three on the plays
themselves: descriptions added up rmse .743 and rank .761, averaged
together .754 and .749, kept apart and multiplied 1.289 and .742, and
on single plays all three are the same to three figures. entityNet
learned free numbers for each man and came out level with adding the
pieces up, which is what happens when there is not enough data to
learn a representation.

So the term that would carry a matchup is not in four seasons of this
data, whichever way it is asked for. Treat it as settled rather than
unlucky.

## What did not work, so nobody tries it twice

Each of these was built, measured and reverted or left switched off.

- Fading old weeks in the live share blend.
- A goal line bucket in the usage scripts, and a goal line leaning
  multiplied into the shares.
- Season fading the usage maps the way the play draws fade.
- Bending a play's outcome by what a defence concedes to a position.
- Moving the target share toward what a defence concedes to a
  position.
- Leaning a room's standings toward the order the market drafts them,
  and toward the share a draft price implies.
- Per team drive rules, at every strength of shrinkage. The walk
  already carries a side through its players and the market lift, so
  a third read off a thin sample only adds noise.
- Drawing the call from the formation. The pools already read how much
  a side runs off its own plays at those cells.
- The level model calling the play. A call turns on sharp steps in the
  distance, which the cells reproduce and a tree of that depth smooths
  across.
- Moving the target share by how much of his usual slice a receiver
  takes against man rather than zone. It lifts receivers and tight
  ends and costs passers and backs, .336 against .343.
- What a man is paid. A deal signed before the season orders his share
  of the work at .536 on its own and explains what the projection
  missed at .005, .058 and .064 over three seasons, so the counts
  already know it.
- Pulling a play's shares apart before they are normalised, at 1.1,
  1.25 and 1.5. It costs ordering at every strength in every season,
  and the concentration it was meant to fix was mostly hindsight in
  how it had been measured.
- Giving the formation model more seasons. Its thinnest cell already
  has 1,541 plays and most have four to twenty two thousand, so the
  extra history buys nothing and costs staleness.

Nor do they help each other. Three pairs have been tried, the
coverage lean with the look tilt, the whole snap chain with the
coverage lean, and the after catch half with the coverage lean. Each
landed at or below the better of its two halves, and in the last one
every position tracked whichever piece was worse for it while the
pool fell under both. Pieces that each add variance to a simulation
do not cancel by being added together.

The pattern across them: a multiplier bolted onto one decision does
not carry a matchup, and a decision that turns on a dense situation
belongs to the cells. What has worked is either fixing something the
walk had wrong, or handing it a fact it did not have.
