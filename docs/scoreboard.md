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

The pattern across them: a multiplier bolted onto one decision does
not carry a matchup, and a decision that turns on a dense situation
belongs to the cells. What has worked is either fixing something the
walk had wrong, or handing it a fact it did not have.
