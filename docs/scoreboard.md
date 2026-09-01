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
| now | .7492 | .6961 | .7004 | .343 |

This .343 is the first time the walk has beaten saying every week is a
man's average so far, which reads .340. An earlier .343 in this table
did not reproduce. walkWeeklyEval seeds its rng off the season, the
week and the two sides, so it repeats to four figures, and the build
that was shipped at the time read .327 twice. That older number had
been measured while the kept files still carried the formation counts,
which a checkout put back. This one is the goal line change and it
reproduces.

The walk's seat on the board is twenty percent. It is swept after every
change, and swept out to the whole board below.

## How it moved

| what changed | board season | first 24 | walk column | weekly |
|---|---|---|---|---|
| before this work | .7546 | not yet cut | .6754 | .331 |
| the fourth quarter conditioned properly | .7510 | .6961 | .6946 | |
| injuries lived as spells, a share made a role | .7488 | .6948 | .6692 | |
| the market settles a room's pecking order | .7510 | .6961 | .6946 | |
| the walk's seat cut to twenty percent | .7482 | .7035 | .6946 | .331 |
| what a side's formation does to a play | .7487 | .7050 | .6971 | .327 |
| room asked of the depth pools near the line | .7497 | .7012 | .6981 | .331 |
| the goal line asking for five plays a man | .7492 | .6961 | .7004 | .343 |

The walk's own column is the best it has been on a season, .7004, and
on every place worth less than the one above, .7070. The board's first
24 is .009 below where the day started, which is the cost of this and
worth watching.

Its seat was swept again and stays at twenty percent, but the shape of
the sweep changed. The first 24 used to fall as the seat grew and now
reads .6961 at twenty, twenty five and thirty alike. Thirty wins a
season by .0026 and loses the first 36 and the first 72 by about .008
each, so twenty is still the choice. The thing that had capped the seat
is loosening.

The last row is the first change in a while to move the walk and the
weekly bench the same way. The walk's own column goes up on six of the
board's eight cuts, the first 24 among them, .5794 to .5845. The board
loses .004 on that same cut, which is the blend not being a simple
function of how good its parts are.

The board barely moves while the walk moves a lot, and that is
arithmetic rather than disappointment: the walk is one voice of four
at a fifth of the say, so a gain of .07 in its own column arrives at
the board as .014.

## Which part of a snap the walk gets wrong

A snap is three decisions and the walk is scored end to end, so a bad
week never said which of the three caused it. scripts/playLayerEval.ts
asks each one against the 35,050 plays of 2024, with a plain answer
beside it.

**The call is at the ceiling.** The walk misses it by .2067 where
saying the league rate every time misses by .2450. A ridge fitted on
the 106,386 plays of the three seasons before, reading the same down,
distance, field position, score and clock, gets .2063. It has no team
identity in it at all and still ties, so a side's own tendency adds
nearly nothing once the situation is known. First and second down are
close to a coin flip, .2326 and .2139 against .2614 and .2419, and only
third down is properly callable at .1430. There is no room here.

**Who gets the ball is where it loses.** Against last season's share of
that same call, which is the rival it has to beat:

| putting the right man top of the list | 2023 | 2024 | 2025 |
|---|---|---|---|
| the walk | 29.4% | 29.1% | 29.6% |
| last season's share of the call | 33.4% | 34.6% | 31.6% |
| knowing this season, so nobody could do better | 40.5% | 40.7% | 40.1% |

It loses to last season's counts by four or five points every season,
and on the average share too, 22.9% against 24.2%. goesTo builds its
weight as the projected share times a leaning, so the level comes
entirely from the shrunk preseason projection and the counts only lean
it toward the downs a man is used on. Moving the level onto the counts
lifts the average share to 24.0% and drops the top of the list to
28.4%, because the counts the walk has are conditioned on the state and
faded over several seasons, so a man who started two years ago
still has weight at 0.7 squared. Stale rather than wrong, and that is
the lead worth following.

**What he makes with it is level with the average**, 5.55 yards out
against 5.40. That first read 7.42 and it was wrong: the walk draws a
gain rather than predicting one, so a single draw has the whole spread
of the distribution in it and scores worse than a point estimate even
when the distribution is exactly right. Averaging twelve draws gives
5.55.

## The touchdowns, which is where a week is won

Better yards a carry ought to mean better weeks and it does not, and
this is why. scripts/pointsFromEval.ts takes a week apart for men
averaging ten or more, over 2024 and 2025:

| | how wide, against the week's own spread | orders the week |
|---|---|---|
| yards | 0.53 | .84 |
| catches | 0.33 | .17 |
| touchdowns | 0.72 | .77 |

Scores are the widest part of a week, wider than yards, and for backs
alone they are 0.57 against 0.53. They are not the luck of a Sunday
either. Splitting each man's weeks in two, his halves agree .721 on
scores where they agree .807 on yards and .617 on the week itself. A
man's scoring is nearly as much his own as his yardage is.

The walk orders backs' touchdowns at .042 and tight ends' at .036,
where saying every week is his average so far gets .204 and .184. So
one half of a week it does reasonably and the other half, which is
wider, it produces at random. A gain in yards a carry is swallowed by
that.

Inside the ten it loses to last season's counts at naming who gets it:

| top of the list, inside the ten | 2023 | 2024 | 2025 |
|---|---|---|---|
| runs, the walk | 41.1% | 42.1% | 39.1% |
| runs, last season's counts | 45.1% | 51.2% | 37.9% |
| passes, the walk | 23.2% | 17.8% | 21.7% |
| passes, last season's counts | 27.0% | 21.3% | 24.6% |

A goal line bucket was tried before and reverted, which is in the list
below. It was tried without this measurement, against the board, where
a change worth a point of goal line allocation cannot be seen. The
measurement to aim at is this table.

## Where the touchdowns go missing

scripts/scoreLayerEval.ts takes a touchdown apart. A man's scores are
how often he gets the ball times how often that reaches the end zone,
so the truth is put into each slot in turn and whichever swap fixes the
ordering is the one that was breaking it. Over 2024:

| ordering 200 men by the scores they made | |
|---|---|
| the walk, both parts its own | .306 |
| the truth about who got the ball | .588 |
| the truth about whether it scored | .389 |
| how often he touched it at all | .601 |
| how often he touched it inside the ten | .672 |

Who gets it is worth .282 and whether it scores .083, so allocation is
most of it. But the last row is the one to sit with. Counting a man's
goal line touches orders his touchdowns better than the walk manages
when it is handed perfect allocation, so the conversion is taking
information away rather than adding any.

Underneath both, the walk makes 1143 touchdowns where 1430 happened,
20% short, and only 11.0% of them come from outside the twenty where
24.8% of the ones that happened do.

Where it scores from is wrong in both directions:

| a play from here scores | the walk | really |
|---|---|---|
| the one | 58.7% | 57.7% |
| inside the three | 39.3% | 41.9% |
| inside the five | 29.4% | 36.7% |
| inside the ten | 19.9% | 22.7% |
| inside the twenty | 7.9% | 9.0% |
| further out | 0.5% | 1.3% |

Close in it is right. From four yards out it is short, and from beyond
the twenty it scores at a third of the rate sides really do, which is
the whole of the problem.

Those rows had the walk far too sure of itself from two and three yards
out until the two point tries came out of them. A try is a play from
the two with no down, it cannot be a touchdown however it goes, and
there were 148 of them in 2024. Left in, they drag 41.9% down to 33.5%
and make the walk look badly over confident where it is close to right.

**The walk does not play a conversion at all.** Every touchdown it
scores is worth exactly seven, and it made none of the 148 tries. That
costs a little on a game's margin and a little on the men who take them
in, and it is the next thing to build. The counting side is already
sound: ring widens the distance and the yardline but never the down, so
a cell of tries can only be reached by asking about a try, and nothing
asks. That last one has a candidate cause: a gain is capped
by the spot it came from, so a catch on the five never made more than
five yards, and the pools are full of those. Asking room of the depth
pools near the line is worth a hundred touchdowns, 1143 to 1245, and
reads .331 a week against .327. It does nothing for the long ones,
11.0% to 11.1%, so the distance problem is untouched and open.

Asked further out it gives the week back, .319 at the forty and .316
everywhere, because out at a side's own twenty five the throws with the
whole field in front of them are throws from a side's own end and those
are different plays. Twenty five ships.

**A warning about measuring this.** The drive engine rounds what comes
back from the draw, so the walk has always dealt in whole yards, and a
bench that asks the draw directly and checks whether the gain reached
the line is scoring a simulation that does not ship. Read unrounded,
the walk appears to make 931 touchdowns rather than 1143 and to score
more often from the three than from the one, which is not something
football or the walk does. Two benches here were reading it that way.
The draw rounds at the source now.

## Letting the goal line ask for less

A cell is asked for forty plays a man, so nine men on the field ask for
three hundred and sixty. Near the line there are not that many, so the
spot widens: ring reaches out through 0, 1, 2, 3, 5, 8, 12, 20, 35, 60
and 99 yards, and a play from the three fills itself from the twenty
three and the thirty eight. The man who gets it from the three is not
the man who gets it from the thirty eight, so the demand is heaviest
exactly where the data is thinnest and the role sharpest.

Asking for five inside the ten instead of forty:

| asked for | week | week, RB | week, TE | top of the list inside the ten, run |
|---|---|---|---|---|
| forty | .331 | .327 | .213 | 42.1% |
| five | .343 | .375 | .272 | 45.1% |
| two | .335 | .351 | .317 | 47.5% |
| one | | | | 47.7% |

The goal line keeps getting better all the way down and receivers start
paying for it below five, .260 at two against .280 at five. Five ships,
and it is the first configuration to beat saying every week is a man's
average so far, .343 against .340, with backs at .375 and receivers at
.280 against their own .343 and .221.

Backs' touchdowns order .129 at two where they ordered .042 before any
of this, and tight ends' .086 where they ordered .036.

## The walk's seat, swept to the whole board

| seat | a season | first 24 | every place worth less than the one above |
|---|---|---|---|
| 20% | .7485 | .6976 | .7913 |
| 30% | .7513 | .6976 | .7890 |
| 40% | .7529 | .6890 | .7831 |
| 50% | .7531 | .6889 | .7827 |
| 65% | .7523 | .6767 | .7665 |
| 80% | .7499 | .6234 | .7492 |
| 100% | .7450 | .5858 | .7205 |

Ordering a whole season peaks at half and falls away after. The first
24 picks stays where it is up to thirty and then gives way, and by four
fifths it has lost seven hundredths. The last column falls from twenty all the way
down. So the two ends of the board want opposite things: the walk knows
most about the men the market has thought about least, and the market
knows most about the men taken first. Twenty stays.

## Two ways of asking who takes it in near the line

The goal line cell asks for five plays a man. Asked separately by call,
a run can go tighter than a throw without the throw paying for it:

| | top of the list, run | top of the list, throw |
|---|---|---|
| both ask five | 45.1% | 21.5% |
| runs ask two | 47.5% | 21.5% |
| runs ask one | 47.7% | 21.5% |

The throw looks far worse than the run and mostly is not. Thirteen men
are on the field, five of whom can catch it and two of whom can run it,
and the most anyone could manage knowing how the season went is 58.4%
on a run and 32.8% on a throw. Against that the walk is at 77% of what
can be had on a run and 66% on a throw, and last season's counts alone
get 51.2% and 21.3%. So the throw is already at its rival and the run
is six points behind one, which is the opposite of how it reads.

## A throw saying less of a man's level

A throw is drawn from the pool at his own depth and from the long end
at his own rate of breaking one, so his level on top is a third helping
and the walk spreads receivers by what would have to be .29 times as
far to be right. Halving it reads .344 a week against .343 and no
position loses. The board says no: the first 36 goes .7276 to .7179 and
the first 72 .7984 to .7869, for .0015 on the first 24. Ten times the
gain, given up. It is behind LEVEL_ON_PASS and switched off.

## It barely tells one man from another

Half the point of playing a season out is that a good back gains more
than a poor one from the same place. Among men given the same thing,
over 2024 and men with sixty touches or more, the walk orders them by
what they make of a touch at .224 for the ones who mostly run and .305
for the ones who mostly catch.

Pooling everyone gives .765, and that is a fourth artifact of the same
family. A catch gains more than a carry, so most of the pooled number
is the gap between the two groups, which is a fact about roles the walk
gets for free. The same goes for the spread. Pooled, it says men differ
by 1.10 yards a touch where 1.81 of the difference is really theirs, so
the walk looks like it is speaking too quietly by a third. Within a
group it is speaking too loudly, wanting 0.70 and 0.51 rather than 1.33.

A man's level is his yards a touch against the league's, times
`(leagueLongRate / hisLongRate) ** 0.5` to keep the long ones from
being counted twice, since the draw has already decided whether this is
one of his. That correction is what does the damage:

| | backs | receivers | spread, against 1.81 theirs | wants |
|---|---|---|---|---|
| his level and the correction | .138 | .267 | 1.10 | 1.33x |
| his level alone | .282 | .390 | 1.75 | 0.84x |
| no level at all | .224 | .305 | 1.12 | 1.41x |

His level is worth having and the correction is worth less than
nothing, taking backs below what no level at all manages. Dividing by a
man's own rate of breaking a long one is unstable where that rate is
small: one long gain in sixty touches against a league five in a
hundred is a multiplier of 1.73 on nothing but noise.

Taking it off is not a win yet, though. It leaves the weekly bench at
.323 against .327, and the board's first 24 picks at .6961 against
.7050, while a whole season stays level at .7490 against .7487. So the
per-play physics gets clearly better and the fantasy ordering slightly
worse, which usually means the accuracy is being swamped by the
variance it adds. It is behind NO_LONG_SHAPE, switched off.

A Rate now keeps the yards those long ones made, so the level can be
worked out over a man's ordinary touches with the long ones out of both
sides of it. That is the right shape, since whether this is one of his
long ones is settled before the level is applied, and it shows:

| | backs | receivers | spread, against 1.81 theirs | wants |
|---|---|---|---|---|
| the level with the long ones in it | .207 | .246 | 1.14 | 1.35x |
| over his ordinary touches | .281 | .210 | 1.42 | 1.04x |

Backs go up by a third and the spread between men lands where it should,
1.04 times what it says. Receivers go the other way, .210 against .246,
and a week reads .339 against .343, backs .382 against .375. So it is
behind ORDINARY_LEVEL and switched off until the receivers are
understood. Whatever is wrong with them is likely the same thing that
puts the right receiver top of the list inside the ten 21.5% of the
time where the right back is top 47.7% of the time.

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
against .343 for the shipped walk, which is the bar that no longer
reproduces, so read the four against each other and not against .327.

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

## What a defence is worth, and what it is worth knowing

Every number here is measured, and most of what was tried came back
null. The two that did not are at the bottom.

A defence had no spread at all. Every other position shipped five
figures describing how its weeks vary; a defence shipped rates and
nothing around them, so a card drew no range and nothing could ask how
its bad weeks looked. Its weeks are drawn now from the counting rates
and the bracket frequencies.

Replacement level was the wrong question for the two positions nobody
keeps. A back you draft you keep, so the last man the league starts is
who you would be playing instead of him. A kicker or a defence you
replace any week you like, so the comparison is the wire. Playing that
out over 2021 to 2025, one choice a week from the men nobody rosters:

| what a team does with the slot | points a game |
|---|---|
| takes one at random | 4.99 |
| keeps the best one left | 5.31 |
| chooses each week on the betting line | 7.61 |
| drafts one and streams over him | 8.04 |
| chooses each week with hindsight | 15.77 |

Hindsight is the ceiling and not a strategy. A first pass used it as
the replacement level and priced the wire at 9.15, which would have
deleted both positions from the board.

Streaming crowds. Only one team takes the softest matchup and the rest
work down the list, so what it pays depends on how many are at it: 2.30
a game alone, 1.43 with six, 0.43 with all twelve. Six is what the app
uses. A kicker gains nothing at any number, so he keeps the plain bar.

Drafting a defence is worth about seven points across a season, which
is the option of starting him in the weeks he beats the wire. That is
one good week from a receiver.

### Forecasting a defence: mostly null

Per part, how much is still there next season, 128 team pairs: points
allowed .259, fumble recoveries .195, sacks .160, interceptions .083,
blocked kicks -.038, defensive touchdowns -.121, safeties -.135. The
last three are anti-persistent and the build projects all of them by
carrying last year's count forward whole.

Forecasting next season's points a game:

| built from | reads |
|---|---|
| repeat last year, which is what we do | .233 |
| points allowed alone | .280 |
| each part shrunk by what it measured | .271 |
| the same with the dead parts dropped | .277 |
| sacks alone | .106 |
| who they play next year | .044 |

Throwing most of the box score away beats using it. The ceiling is
about .28 either way.

Continuity does not rescue it. Splitting 128 team seasons by the share
of last year's defensive snaps still on the roster gives .255 / .073 /
.362, and weighting those men by what they did gives .270 / .122 /
.285. Non-monotone both ways, and with 42 teams a cell the standard
error is about .15, so the whole spread is noise. Shrinking last season
toward the league by who left reads .260 against .259 for doing
nothing.

Nor does the coach. Splitting 317 team seasons by whether the head
coach was the same man gives .250 when he stayed and .210 when he did
not, and the smaller cell has 74 teams, where the standard error is
about .12. Pooled it reads .300, above both halves, which is what
happens when the groups differ in level.

The coordinator is untested rather than null. coaches.csv has only
head coaches and offensive coordinators across seasons, and
coordinators.csv is 33 rows for 2024. Defensive scheme is the one term
on the list that has never had a fair go, and the blocker is data.

### Weekly is a different question, and answerable

Out of sample, half the weeks fitting and half scoring, predicting a
defence's week: the betting line alone .376, the line with the
opponent's sacks allowed and giveaways .385. Against .280 for the best
season forecast.

That gap is the whole point. A season averages seventeen matchups and
the matchup is most of the signal, which is also why the season-long
schedule reads .044 while the weekly line is worth 2.3 points a game.

Opponent tendencies add .009 over the line. About three standard errors
at 2238 weeks, so it is there, and it is small: the line already prices
them. Team-level features will not beat the market.

### Penalties belong to the man

The drive rules fit penalties per offence, so a defender who interferes
every week is credited to whoever he played that day.

A man's flag rate reads .520 from one season to the next over 2608
pairs, and .565 among the 1054 who played fifteen games in both. It is
the most
persistent thing measured anywhere in this file: four times team points
allowed, three times sacks.

Who drew the flag is not in this data. Interference comes on an
incomplete pass and receiver_player_id is empty there, so five seasons
turn up four men with one flag each. It needs the play description
parsed.

What does not follow from any of that is a better team forecast.
Predicting a side's flags next season from the men who will be playing
for it reads .191 by their rates and .172 by their counts, against .152
for the side's own last season. With 128 teams the standard error is
about .09, so the three are the same number. Most of a squad stays put,
so a team's own history already knows what its men do, and a roster
list counts a backup the same as a starter.

So the habit is the man's, and moving it between shirts buys nothing
measurable at the team level. If it pays anywhere it is inside the
walk, where the defenders on the field are known one at a time and
nothing has to be aggregated. That is untested.
