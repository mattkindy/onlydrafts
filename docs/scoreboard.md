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
  week is his average so far. That yardstick is .340. Every weekly
  figure before September 2026 was read at ten draws a week, where a
  single reading has about .012 of noise and two settings differ by
  .018 on noise alone. The bench now runs forty draws and a reading is
  the mean of two WALK_SEED values, which takes the noise to about
  .004. Treat any weekly gap under .01 in the older rows as nothing.
- **game** is scripts/scorePredictionEval.ts, points off the margin
  over a season of fixtures, next to the betting line.

## Where it stands

| | board, season | board, first 24 | walk column, season | weekly, pooled |
|---|---|---|---|---|
| now | .7480 | .7128 | .7049 | .339 |

The .339 is a two seed mean at forty draws and is level with the
yardstick of a man's average so far, .340. The walk has not beaten
that yardstick on weeks; the readings that said it had were noise.
An early .343 did not reproduce: walkWeeklyEval seeds its rng off the
season, the week and the two sides, so it repeats to four figures, and
the build shipped at the time read .327 twice, because the kept files
still carried the formation counts a checkout had put back. The .343
the goal line change earned read .319 by early September, and a bisect
across the three walk commits in between spread the fall over all of
them, .004, .011 and .009. Every one of those gaps is inside the noise
of the ten draw bench, so nothing is known to have moved the weekly
figure since the goal line change.

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
| the fourth down, flag and goal fixes, judged on drives | | | | .319 at ten draws |
| a man's leaning believed by his own count | .7479 | .7128 | .7037 | .339 at forty |
| the goal line carry switched off | .7477 | .7128 | .7043 | .339 |
| the sacks taken out of the pooled throw | .7480 | .7128 | .7039 | .339 |
| both sides of the goal check on the same plays | .7476 | .7128 | .7031 | .339 |
| a sampled play that reached the line keeps its score | .7479 | .7128 | .7048 | flat, .368 against .3705 on 2025 alone |
| the live board reads last season's snap share instead of zero | .7480 | .7128 | .7049 | not run |
| the drawn pool stops reaching past the goal line | .7480 | .7128 | .7049 | .368 on 2025 alone |

The drawn pool row is the one measured on drives rather than on seasons.
A play from the eleven can gain at most eleven yards, so the window that
grew both ways to find forty comparable plays was handing a snap on the
fifteen a set of plays with the touchdowns clipped out of it. The window
now reaches no more than two yards nearer the goal. On the opening drive
of each half, 2023 to 2025, the walk scores a touchdown 22.6% of the time
where it scored 20.7% before and teams score 24.2%, and the band that
said 23.9% where 27.5% happened now says 24.2% against 24.2%. The board
does not move and neither does the weekly bench, which is what a fix
inside one drive should look like.

The snap share row is a fix to the live path only. The backtest already fed the season model last season's snap share, so the bench did not move; the 2026 board did, with ten receivers in the top 60 moving five or more places.

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

**The walk now picks the right man more often than last season's counts
do.** Those counts are the rival it has to beat, taking each man's share
of the same call a year ago:

| putting the right man top of the list | 2023 | 2024 | 2025 |
|---|---|---|---|
| the walk before LEAN_K | 29.4% | 29.1% | 29.6% |
| the walk as it ships | 34.3% | 35.0% | 34.9% |
| last season's share of the call | 33.4% | 34.6% | 31.6% |
| knowing this season, so nobody could do better | 40.5% | 40.7% | 40.1% |

What moved it was shrinking the leaning by how many times the walk has
actually seen that man in that spot, worked out below. That took the top
of the list past last season's counts in all three seasons.

There is a second measure, the share of the play the walk hands the man
who really got it, and the walk is behind on that one in 2023 and 2024,
22.6% and 22.7% against 24.2%. It is ahead in 2025, 23.0% against 22.7%.
The most anyone could give him is about 25.5%.

Every way of closing that share gap sells the top of the list to buy it.
Taking half the level off the counts that are conditioned on the state
reads 24.5% on 2024 and drops the top of the list to 31.4%; taking all
of it reads 23.3% and 27.1%. Taking the level off the same counts
without the state, which is what the rival does, reads 23.8% and 34.1%
at a quarter, 23.8% and 33.3% at a half, and 23.5% and 32.3% at seven
tenths. 2023 falls on the same line. Picking the right man is what the
board is built on, so the level stays on the projection. The share off
the call is behind FROM_CALLS, which is off.

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

## Who gets the ball, and what was spoiling it

The man a snap goes to is weighted by his projected share times a
leaning, which is his share of the plays counted in this state cell
divided by his share of plays overall. A man used on third down leans
that way. The section above had blamed stale counts for the walk
putting the wrong man top of the list, and that was wrong: the counts
set the level only for men the projection does not price. What spoils
the allocation is the leaning. It is the ratio of two thin shares, and
off two or three plays in a cell it can be ten to one either way.

scripts/playLayerEval.ts scores the allocation on its own, off the
plays that happened, with the walk built from what it knows at week one. Two
figures: how often the man it puts first was the man who took it, and
the average share it gave the man who took it.

| top of the list | 2023 | 2024 | 2025 |
|---|---|---|---|
| last season's counts | 33.4% | 34.6% | 31.6% |
| the leaning as it shipped | 29.6% | 29.4% | 29.6% |
| no leaning at all | 34.3% | 34.8% | 34.6% |
| believed by his own count, sixty plays | 34.3% | 35.0% | 34.9% |

The shipped walk was worse than last season's raw counts at naming the
man. Turning the leaning off beats the counts. Shrinking it instead, so
it is believed in proportion to his own plays in the cell, n over n
plus sixty, matches turning it off at the play layer and keeps some of
what the leaning knows about a man's role. His own count and not the
cell's, because a cell of four hundred plays says nothing about a man
who took three of them. Sixty is the default.

The weekly bench cannot tell these apart. At ten draws it read .319
shipped, .345 with no leaning and .344 at sixty, and those gaps looked
like the point of the change. At forty draws and two seeds the walk
with the leaning believed in full reads .336 and the walk at sixty
reads .339, a gap inside the .004 the bench moves on its own. The
position rows at ten draws (tight ends .282 at sixty against .238 with
no leaning, quarterbacks worse at five and twenty than at sixty) were
read off the same noise and are not claims. The evidence for the change
is the play layer above and the season replays below.

On a season, replayed forty times, the priced men gain in all three
seasons and the whole list gives some back in two of them, because the
leaning had been ordering the deep, unpriced men the board never
shows.

| 2023 to 2025, 40 runs | shipped | sixty | sixty, goal lift off |
|---|---|---|---|
| the whole list, 2023 / 2024 / 2025 | .730 / .724 / .731 | .737 / .712 / .725 | .737 / .714 / .728 |
| the men ADP priced | .617 / .554 / .673 | .637 / .569 / .671 | .631 / .568 / .673 |
| the first 60 picks | .482 / .336 / .503 | .484 / .437 / .545 | .473 / .427 / .536 |

The board's first 24 goes from .6961 to .7128, the largest move that
column has had, the walk's own column to .7043, and the season gives
back .0015. The seat was swept again and stays at twenty percent: the
season is best at fifty, .7522, but the first 24 is best at twenty and
falls from there. The last column is what ships: the kept files were
replayed with the goal line carry off, and every figure moved less
than the .006 a single forty-run reading moves on its own.

The drive check reads 5.47 yards a play against 5.41 played, once the
snaps wiped out by a flag are left out of the divisor (the older
readings of 5.08 and 5.10 counted them as plays for no yards). The
walk at sixty still gives up on 12% of midfield throws where the
shipped one gave up on 8.6%, because more targets go to men too thin
to sample and the pooled draw is shorter. Passes inside the ten score
30.6% drawn against 39.3% played. The pooled draw being short is fixed
in the next section.

Blending the projected level toward what a man has taken lately, his
shares in the current season weighted by weeks over weeks plus four,
did not help at ten draws (.317 a week at a quarter and .311 at a half,
against .344) and stays off behind RECENT_LEVEL. Those gaps are larger
than the noise, so the result is probably right, though it was not
re-run at forty.

## The pooled throw paid for the sack twice

A pass is drawn one of two ways. A man with enough plays behind him
has a whole play sampled from his own record; a thinner man falls back
to a pool of passes at his depth, drawn from everyone. Both paths
first draw whether the throw went nowhere, a sack or a ball thrown
away, at about 10.5% of passes. The pools were built from every pass
row with air yards, and the 10,637 passes credited to nobody all have
air yards, so the sacks were in the pool as well. A throw that fell
back paid for them twice. A sampled throw paid once.

Measured on the 2025 throws, against what those plays gained:

| the pooled path | played | before | after |
|---|---|---|---|
| yards a throw | 6.50 | 4.47 | 5.53 |
| went nowhere | 39.2% | 48.9% | 42.0% |
| caught | 64.8% | 53.6% | 59.6% |

Once a pooled throw went anywhere it was already right, 10.61 drawn
against 10.85 played, so the whole shortfall was the nothing rate and
the catch rate followed it. The pools now keep only the passes
somebody was credited with. POOL_WASTE=1 puts the sacks back.

The drive check moves from 5.47 yards a play to 5.60 against 5.41
played, and a pass from short to a little long, 6.42 against 6.09.
Drives reaching the ten score 70.6% against 68.9% played, from 69.3%.
The play layer does not move, the week reads .370 both ways on a
matched forty-draw pair, and the seasons are within noise except 2023's
priced men, .631 to .642. The board reads .7480, .7128 and .7039. It
ships because it is a correction, and the parts downstream of it are
now measured on the right draw.

| 2023 to 2025, 40 runs | sixty, goal lift off | and the pool without sacks |
|---|---|---|
| the whole list, 2023 / 2024 / 2025 | .737 / .714 / .728 | .741 / .712 / .727 |
| the men ADP priced | .631 / .568 / .673 | .642 / .569 / .673 |
| the first 60 picks | .473 / .427 / .536 | .485 / .429 / .534 |

Two things came out of it and were not fixed. A level for thin men,
pulled toward one by the touch count, moved the pooled draw at
midfield from 6.38 to 6.30 at full trust, so whatever makes those men
worse than league is not in their prior yards. And inside the ten the
gap that is left is on the sampled path, 30.7% touchdowns drawn on
throws where those plays scored 39.3%, which is what GOAL_LIFT was
aimed at. That one is the next section.

## Both sides of the goal line check, measured the same way

The gap above is smaller than 30.7 against 39.3 makes it look. The
39.3% is over throws that reached a man, and one throw in nine of the
walk's is drawn as a sack or a ball thrown away before anybody is
asked for a play, so a walk that had the rate exactly right would draw
about 35% on those plays. Two things were still wrong, and both are
one side of a comparison being counted over a different set of plays
from the other.

The pooled draw was cut against a rate that counted the sacks. The
pools stopped keeping them in the section above, so the pool's
crossing share is over throws that reached somebody while the
yardline's score rate was still over every throw of the call. The rate
now has the sacks taken out of it as well, which is what the sampled
path had been doing all along.

And a man was cut against his own crossing share. Moving a play in
from further out is what makes a draw cross too often, since five
yards gained at the nine is a touchdown at the four, and that happens
to everybody's plays alike. Cutting each man by his own share instead
pinned every man above the league rate down onto it and left the men
below it alone, which both flattens the men and lands the whole thing
under the rate it settles to. The cut is now the one factor the
yardline needs, everybody's plays moved in through the same window
against how often sides score from here, so a goal line tight end
stays above a receiver. GOAL_CUT_HIS_OWN=1 puts the old cut back.

Over the 2025 snaps inside the ten, drawn ten times each against what
those plays did:

| inside the ten | played | shipped | the rate fixed | and the one factor |
|---|---|---|---|---|
| touchdowns on a throw | 39.3% | 31.6% | 31.8% | 33.8% |
| on the sampled path | | 30.7% | 30.7% | 33.2% |
| on the pooled path | | 34.8% | 35.9% | 35.9% |
| touchdowns on a run | 28.9% | 27.9% | 27.9% | 28.6% |

The bands further out move the same way: from the eleven to the twenty
a throw goes from 10.3% drawn to 11.2% against 15.4% played, and a run
from 3.7% to 4.2% against 4.6%.

The drive check cannot resolve either one. Its goal line line moves
2.2 points between two seeds at two runs, which is as large as
anything here: drives reaching the ten score 70.6% shipped, 68.4% and
70.6% with the rate fixed, 71.0% twice with both, against 68.9%
played. The touchdown share of drives is 22.1% shipped and 21.6% to
22.0% either way. The week is flat, .3705 shipped and .3705 with both,
over two seeds at forty draws, with tight ends the one row down in
both seeds, .360 to .344 on 86 weeks of a man. The play layer does not
move at all. Both changes ship on the argument above rather than on a
bench: each puts two numbers that are compared on the same footing.

The seasons, replayed forty times, sit within noise of the row before:
the whole list .737 / .708 / .728, the priced men .641 / .568 / .670,
the first 60 .489 / .435 / .536 for 2023, 2024 and 2025. The board
reads .7476 on the season, .7128 over the first 24 and .7031 on the
walk's column.

Tight ends near the goal are still short, 28.2% against 33.8% on
throws from the six to the ten and 10.9% against 18.8% from the eleven
to the twenty.

## The tilts were taking back touchdowns

The walk drew 6.5% of its touchdowns from past the 40 where 9.8% of
the played ones came from, and 11.1% from the 21 to the 40 against
15.5%. The mean gain out there was right, so the top of the sampled
distribution was being cut, and a probe over the 2025 snaps by band,
call and path found where. A man's own play that the end zone cut off gained exactly the
yards to the line, so his sampled gains have a spike sitting on the
goal. The situation and formation tilts land either side of one, and
multiplying that spike by them dropped it short about half the time.
Inside the twenty the goal line settling already returned early on a
draw that crossed; beyond the twenty nothing did. Past the 41 the tail
was already right, because few draws there reach the line at all.

hisOwnPlay now returns the touchdown when the sampled play already
reached the line, before the tilts. TILTS_TAKE_SCORES=1 puts the
shaving back. Over the 2025 snaps the season's drawn touchdowns go
from 1021 to 1059 against 1273 played, throws from the 21 to the 40
cross 3.5% instead of 2.8% against 5.3%, and yards a play is 5.51
either way, so nothing was inflated to buy it. On the drive check
every scoring rate by field position moves toward played: drives
reaching the ten score 69.9% from 71.0% against 68.9%, the twenty
58.8% from 59.5% against 57.3%, the fifty 37.1% from 37.8% against
37.2%. The play layer is byte-identical. The seasons replayed forty
times are within noise, .738 / .712 / .729 on the whole list, and the
board reads .7479, .7128 and .7048.

What is left out there is a compression of the whole sampled
distribution as the goal comes into reach: from the 21 to the 40 a
throw that gains something averages 10.21 drawn against 11.58 played,
and from the 41 out the two match. The lever is CLOSER, which lets a
source play be drawn from up to eight yards nearer the goal than the
spot it is drawn for; those plays were cut off by their own end zone
and cannot reach this one. At 2 the drawn touchdowns go to about 1100
and yards a play to 5.54, and 0, 2 and 4 all land near there. That is
a tuning choice and wants the weekly and drive benches before the
default moves. Excluding a man's cut-off plays when drawing from
further out was tried and makes everything worse, 5.51 to 5.33 a play,
because out at the 60 those are his long plays.

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

## After the touchdown

Every touchdown scored seven. Sides make 95.2% of extra points and go
for two after 9.5% of touchdowns over 2022 to 2025, 81% of the time
when the six leaves them down two and 88% when it puts them up one,
three times as often inside the last five minutes, and they convert
47.4%. The game now draws the kick or the try off the margin and the
clock, so the late margins that decide play calling are right by a
point, and a converted try is credited to the man who got the ball and
to the passer. The drive check moved within noise, which is what it
should do. It was not benched on the board or on weeks, because two
point conversions are too rare to move either.

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
- Moving a man's projected share toward what he has taken this season
  (RECENT_LEVEL). It costs weeks at every strength tried.
- Turning the state leaning off outright rather than shrinking it. The
  same play layer gain, but tight ends lose and the pooled draw is
  asked more often.

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

## Drafting by wins against drafting by points

Two drafters take the same seat in the same room off the same
projection, one ordering by value over replacement and one by what a
man adds to the weeks you win. Both sides are then scored on what
actually happened, against the other eleven teams, week by week.

The projection is last season played forward for both, so what is
measured is the ordering and not the model. The room drafts on the
real draft position for that year, which is a better projection than
either rule is given, which is why both sit under half.

| season | points only | with roster sense | by war | war, projected side | war ahead |
|---|---|---|---|---|---|
| 2023 | 15.0% | 49.0% | 55.9% | 52.4% | 9 of 12 |
| 2024 | 38.7% | 45.9% | 50.8% | 53.1% | 7 of 12 |
| 2025 | 35.6% | 46.3% | 51.8% | 55.7% | 10 of 12 |

The fourth column is what the page does. It measures a man against the
side you would finish with rather than the handful you have, which was
added to stop every candidate reading nought on the first pick. It
averages 53.7 against 52.8 for the plainer version, so the change costs
nothing and is worth about a point.

Points alone is not a rule anybody uses and is there to show why: it
takes ten quarterbacks, since they score the most, and eight of them
cannot start. With roster sense is the fair comparison.

Wins beat points by 6.9, 4.9 and 5.5 across the three, and in 26 of the
36 seats. A coin flip gives 26 or better about once in two hundred.

What this does not settle: only the skill positions are drafted, and
both rules are handed a crude projection. Whether the same gap holds
when the ordering runs on the blended board rather than on last season
is untested.

## Start and sit

scripts/pairEval.ts takes every pair of same-position men who both
played, asks how often the man a method liked better outscored the
other, and reports the slate Spearman beside it. Our weekly ridge is
fitted per position now, and Sleeper's own weekly projection is scored
next to it on the 96% of player-weeks Sleeper covers.

Slate Spearman, one position on one week being the set a manager
chooses within:

| | 2024 all | 2024 wk 1-17 | 2025 all | 2025 wk 1-17 |
|---|---|---|---|---|
| QB, ours | .367 | .378 | .251 | .260 |
| QB, sleeper | .365 | .368 | .285 | .290 |
| QB, half and half | .391 | .392 | .274 | .284 |
| RB, ours | .657 | .665 | .654 | .666 |
| RB, sleeper | .674 | .678 | .676 | .684 |
| RB, half and half | .675 | .680 | .677 | .685 |
| WR, ours | .576 | .579 | .535 | .550 |
| WR, sleeper | .582 | .586 | .572 | .583 |
| WR, half and half | .591 | .595 | .566 | .579 |
| TE, ours | .606 | .609 | .533 | .538 |
| TE, sleeper | .610 | .611 | .545 | .555 |
| TE, half and half | .618 | .619 | .551 | .558 |
| all, ours | .551 | .557 | .493 | .503 |
| all, sleeper | .558 | .561 | .520 | .528 |
| all, half and half | .569 | .571 | .517 | .526 |

Week 18 is in the first and third columns and out of the second and
fourth. Every number goes up when it is dropped, by about .005, which
is the week half the league rests its starters and nobody is choosing
between these men anyway.

An even average of the two is the ranking number the app and
scripts/start.ts ship. It wins 2024 outright and loses 2025 by .003 to
Sleeper alone, and it wins every position on 2024 and every position
but quarterback and receiver on 2025. Fitting the weight per position
on the other season instead reads .565 and .517, which is the same
number with a knob attached, so the knob is not there.

### Inside two points nobody knows anything

Pairs are split by how far apart the two projections were. In the
0 to 2 point band, over 2024 and 2025:

| method | 2024, 0-2 apart | 2025, 0-2 apart |
|---|---|---|
| his average so far | 54.0% | 53.9% |
| our ridge | 55.6% | 54.6% |
| sleeper | 54.4% | 54.4% |
| half and half | 55.3% | 54.4% |

Nothing measured here beats a coin flip by more than a point and a half
in that band, and a man's own average is within a point of the best of
them. Past five points apart the same
methods run 82% to 85%. So the answer to a close start/sit call is that
it is close, and start.ts says so rather than pretending the tenth of a
point means something.

Where the two methods pick different men, our ridge was right 49.2% of
the time in 2024 and 45.4% in 2025. It gets worse the wider the split:
in the two to five point band Sleeper takes 53% and 58%, and past five
points 66% and 68%. A split of three points or more is worth telling
the reader about, and start.ts prints one, with the roughly 55% that
says which way to lean.

### Where each side is wrong

Sleeper runs hot. It projects quarterbacks 2.2 points a game over what
they score, and every man it puts over fifteen points by 1.5 to 2. Our
ridge is within .4 of the outcome in every band and at every position,
which is what fitting on the outcome buys you. That is why the floor
and the ceiling on a card come off our residuals and not off Sleeper's
number, and why the average of the two is a ranking number rather than
a points forecast.

### The man whose job changed

The case the weekly model exists for is the back whose starter is out,
and it is the case both methods handle worst. Predicting a running
back's carries in the coming week:

| built from | 2024 | 2025 |
|---|---|---|
| his last four games | -.09 | .28 |
| our volume adjusted for who is out | .55 | .64 |
| sleeper | .70 | .74 |

His last four games is worthless here, which is the point: the four
games are the ones before the job changed. Handing the model the men
his club ruled out this week recovers most of the gap and still leaves
Sleeper ahead by .15 and .10. Sleeper is reading a beat writer and we
are reading a status report, and the beat writer is faster.

This is the one place where a better input is clearly available and we
do not have it. Until we do, the average of the two is how the man
whose job changed gets a sane number.

## One drive at a time, against the drive that happened

Every bench above scores a season of totals, where a walk that is too
averaged still lands in the right place. scripts/gameRealismEval.ts
scores single drives instead. It takes the state nobody can argue
about, the opening drive of each half, puts the walk at that field
position and plays the drive two hundred times: 1,710 drives over
2023, 2024 and 2025. The walk's rules are fitted on all four seasons
and its two rivals never see the season they are scored on, so any
edge below runs the walk's way. What is scored is the drive engine
with the offence's own rules, before any of it is handed to named
players.

**How the drive ends**, over touchdown, field goal, punt, turnover and
the twenty play cap:

| how the drive ended | brier | log |
|---|---|---|
| the walk | .6993 | 1.3002 |
| base rates by field position and half | .7049 | 1.3110 |
| a softmax on field position, spread and total | .6912 | 1.2813 |

The walk beats knowing nothing about the teams by .0056 of Brier,
where the fitted read beats it by .0137. So it picks up two fifths of
what anyone can know before a drive starts, and there is little there:
the whole distance from the league rate to the betting line is
fourteen thousandths.

Where the endings go is the finding:

| | touchdown | field goal | punt | turnover | hit the cap |
|---|---|---|---|---|---|
| the walk | 20.7% | 19.9% | 39.7% | 19.4% | 0.3% |
| what happened | 24.2% | 16.7% | 42.6% | 16.5% | 0.0% |

Three and a half points of touchdown go missing and come back as field
goals and giveaways. Drives get down the field and stop short. The
calibration table says the same thing at every level the walk uses:

| the walk said | it said | it happened | drives |
|---|---|---|---|
| 5 to 10% | 8.3% | 14.8% | 27 |
| 10 to 15% | 12.9% | 15.0% | 227 |
| 15 to 20% | 17.4% | 21.8% | 550 |
| 20 to 30% | 23.9% | 27.5% | 814 |
| 30 to 50% | 34.1% | 31.8% | 88 |

It is under on touchdowns in every band with more than a hundred
drives in it. The cap is the other thing to note: 0.3% of walked
drives run to twenty snaps and stop, and no opening drive of a half in
2022 to 2025 ever ended with the clock.

**How long the drive is.** Each drive's plays and yards are read as a
percentile inside the two hundred walks of it, which comes out flat
when the spread is the right width, piles into the tails when it is
too narrow, and piles into the middle when it is too wide:

| | mean, played | mean, simulated | sd, played | sd, simulated | in the tails | in the middle |
|---|---|---|---|---|---|---|
| plays, the walk | 6.29 | 5.93 | 3.39 | 3.19 | 10.2% | 18.0% |
| plays, base rates | 6.29 | 6.28 | 3.39 | 3.41 | 11.5% | 20.7% |
| yards, the walk | 34.05 | 33.28 | 28.46 | 27.54 | 11.5% | 17.5% |
| yards, base rates | 34.05 | 34.22 | 28.46 | 29.23 | 10.6% | 21.5% |

Flat is 10.0% in the tails and 20.0% in the middle. The walk matches
both, so its drive length spread is the right width. What is off is
the level: it is a third of a play and three quarters of a yard short,
and that shows up as a tilt rather than a pinch, with 13.1% of drives
in the top tenth of the walk's plays against 8.1% in the bottom.

**The first snap.** Which way it was called, and what it gained:

| the first snap of a drive | says run | brier on the call |
|---|---|---|
| the walk | 51.9% | .2464 |
| base rates by field position and half | 57.3% | .2487 |
| a softmax on field position, spread and total | 57.0% | .2449 |

| | mean, played | mean, simulated | sd, played | sd, simulated | in the tails |
|---|---|---|---|---|---|
| yards on the first snap, the walk | 5.61 | 5.98 | 8.30 | 8.95 | 9.1% |

Teams run the opening snap 57.0% of the time and the walk runs it
51.9%, which is five points too eager to throw. The gain it draws is
within a third of a yard on the mean and slightly wide on the spread,
and the percentiles come out nearly flat, so the pool a snap is drawn
from is the part of the walk that is in good shape.

**What this settles.** At the level of one drive the walk is not too
averaged. Its plays and its yards have the spread the game has, within
six percent on both, and the yards a single snap gains are close to
right. Two things are wrong and both are levels rather than widths:
the walk scores touchdowns on 20.7% of opening drives where offences
score on 24.2%, and it throws the first snap five points too often.

That also puts the ceiling eval's finding somewhere. The walk moves a
man 2.05 points from week to week where he really moves 4.95, and the
drive he plays in is not where that spread is lost, since the drive's
own spread is right. It goes missing further down, in how a drive's
snaps get shared out among the men on the field. The touchdown
shortfall is the piece of it that this bench can see, and 3.5 points
of drives on a 24.2% base is a seventh of all scoring.
