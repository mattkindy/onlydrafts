# How the model is put together

One idea runs through all of it: work out the smallest thing, check it
against what happened, and let everything larger be those small things
in sequence. Nothing above a play is fitted. A drive is plays, a game is
drives, a season is games, and if a drive comes out wrong that points at
a factor rather than at a rule about drives.

## The levels, and what is decided at each

**A play** is a call, a player it goes to, and what he gains. Each is
conditioned on the same state: down, distance, field position, the
clock and the score. `playFactors.ts` says what the factors are and
`fitPlayFactors.ts` counts them against the exact state, widening only
when a thin state is asked about. Nothing is bucketed at the point of
fitting, because a bucket decides in advance what resolution every
question gets, and the two yard line scores six times as often as the
eighteen.

**A drive** is plays until it ends. `driveFromFactors.ts` walks them.
The things that end a drive without the offence choosing to, the fourth
down call, the kick, the punt, the clock, come in from outside because
they decide whether a play happens at all.

**A team's level** is a team and a season, and it does not come from the
plays. Trying to recover it a few dozen plays at a time put two team
games 1.29 points apart where the market puts them 3.82 and where they
really land 9.69 apart. It comes from the market in August, where the
market ranks a side at .28 and a belief starting from nothing manages
.26, and from the belief thereafter, which ranks at .33 by week seven
against the market's .24.

**A player's share** is what he wins against the players he plays with, not
something he owns and carries between teams. `shareCompetition.ts`
divides a position group's work by what each player has shown, a rookie
counting for what his draft round usually brings.

**A player's rates** come from his own plays where he has enough of
them and from what his attributes say where he does not.
`attributePriors.ts` mixes the two, and how much of each is fitted on a
season nobody is being judged on rather than chosen.

**A draft price** is what a room of drafters thought in August, and
`marketPrice.ts` fits what it went on to mean. For a position and an
average draft position it gives the points a game players bought there
have averaged, the 10th through 90th percentiles of where they landed,
and how often one of them finished inside the tier a league starts
every week. A later step can then rank players by how far the model
disagrees with the price rather than by the points it projects.

**A sleeper** is a player whose rest of season is worth far more than his
price says, and `model/sleepers.ts` scores one. It fits the rest of a
season on the curve, the player's share and his form so far, then takes
off what the same fit says about a player at that price and position with
average form, so the number left over is the claim against the board. It
ranks who becomes startable better than points a game so far does and it
ranks who scores the most worse, and `scripts/README.md` has the table.

Three decisions in there are worth knowing before reading the code.

The quantiles are counted off the players rather than taken from a
standard deviation around the mean, because the width of the outcome
moves a long way with the price while its shape barely does. From the
10th to the 90th percentile is two thirds of the median at the top of
the first round and one and a half times the median past pick 96, and
the mean comes out within a tenth of the median nearly everywhere. The
right tail people talk about at cheap prices is a wider distribution,
not a lopsided one, and it is the same story in season totals as in
points a game.

Every curve is monotone in price. A curve that said pick 40 was worth
less than pick 60 would be telling a drafter to reach past the player
he wants, so neighbouring prices that come out in the wrong order are
pooled until nothing rises with price. A neighbour is weighted by how
far off in price he is, because only two or three tight ends a year go
in the first four rounds: weighting them equally instead put the top
tight end at 13.4 points a game where those players really averaged
16.0, and the weighting closed 1.7 of that 2.6.

A drafted player who never played is kept at zero rather than dropped.
He is the pick somebody spent, and dropping him would make every price
look better than it was. There are two or three a season.

## Which way things are passed

Think of it as a stack that passes messages in three directions, since
that is what says which parts are missing rather than merely unwired.

**Upward** is plays into drives into games into seasons, and it now
runs the whole way. A drive comes out 5.9 plays against 5.9 with every
ending within a point or two. A game is two sides taking turns against
a shared clock in `gameFromDrives.ts`, so how many drives each gets,
where they start and the score during play all come out rather than
being handed in. `linesFrom` turns a played game into stat lines,
with the passing credited to the player who threw it.

**Sideways** is one thing against another at the same level, and the
parts that pay are wired. The competition for the ball divides each
player's carries and targets separately (`projectedShares.ts`,
`shareCompetition.ts`). The pairing of two sides is in the walk
through `matchupTable.ts`. A quarterback's ground habit is his own
rather than won from anybody.

**Downward** is a level constraining what happens beneath it, and
there is still none. `teamState.ts` and `gameSize.ts` know things the
walk never hears.

Played whole with the players in it, the simulation ordered the 2025
skill players adp had priced at .55 where adp managed .41, and inside
picks 61 to 120 adp carried nothing at all, -.00 against .36. That is
one season and a roster-based population, and it is the first version
to beat the market on its own.

Team games are another matter. The walk orders a side's points at
about .15 where the betting line gets .39, and the line is not
connected. What a team is worth is still known at the top and never
reaches the plays.

## Rules the model follows

Everything shrinks toward something, and what it shrinks toward is
fitted rather than picked. A constant in a per player slot is an error
the moment it meets a particular player: `yardSwing` sat at 0.35 for
everybody where players really swing 1.26.

A quantity is asked about at the level it lives at. Team strength is a
team and a season. A share is a roster. A yardage is a play.

A ratio has no reason to average one, so anything that multiplies a
draw is centred on what it averages over the touches it is put on.
The players who get the ball are better than the average of everyone who
ever touched it, and before centring, that alone put two points a
game on the board that nobody scored.

A change is judged against the same code with the change off, run at
the same time, never against a number remembered from before other
things moved. And nothing under a fifth of a point is quoted off one
seed: the season eval moves about .03 of ordering between two seeds
of the same code.

A description of a player comes from his last so many games, crossing
seasons where it has to, so it is right in week six as well as in
August and so a fit from it can never contain the answer.

Each piece is scored on its own before anything is composed, and scored
where it lives: an opening level on the first three weeks, an updating
rule on week seven onward, a matchup on cell means, a share on a season.

## Benches behind the constants

Several numbers in here were measured by a script rather than chosen.
The comments say why each number is what it is; this is where to look
when you want to measure it again.

| The constant or decision | Where it lives | What measured it |
| --- | --- | --- |
| `DEALT_WIDER`, how much wider a player's week runs than the walk deals it | `features/walkWeek.ts` | `scripts/walkBandEval.ts` |
| `SLEEPER_QB_BIAS`, and the blend weight beside it | `features/sleeperBlend.ts` | the Sleeper blend finding in `scripts/README.md` |
| The two point and extra point tables | `features/afterTouchdown.ts` | `scripts/twoPointEval.ts` |
| Which board source ships, the fitted one or the walked one | `features/boardSource.ts` | `scripts/sourceCompare.ts` |
| Which parts of a week's setting survive, the roof and the kickoff time | `features/weekSetting.ts` | `scripts/knowableWeekEval.ts` |
| `KEEPS`, how much of each mechanic a player takes into next season | `features/mechanicsProjection.ts` | `scripts/mechanicsCarryEval.ts` |
| The walk's weekly numbers being cached on disk at all | `features/walkWeeklyCache.ts` | written by `scripts/walkWeekCache.ts` |
| `COMPONENT_THROUGH_WEEK`, where the component line hands over to the ridge | `features/componentWeek.ts` | the component week finding in `scripts/README.md` |
| `SHIPPED_FIT`, whether the price curve is windowed or a line on log price | `features/marketPrice.ts` | `scripts/marketPriceProbe.ts` |
| The game script effects being pooled over a side's fixtures | `features/gameScript.ts` | `scripts/aggregateGameScript.ts` |
| Fitting every part of a player's season in one model | `features/jointParts.ts` | `scripts/jointProjectionEval.ts` |
| `HOW_FAR`, `NO_LONG_SHAPE` and `FROM_COUNTS`, all off | `features/fitPlayFactors.ts` | `scripts/playLayerEval.ts` |
| `GAME_LOADING` and the QB loading beside it | `sim/season.ts` | `scripts/estimateCorrelation.ts` |
| Sleeper being the source for who is exempt today | `data/nflverse.ts` | `scripts/exemptCheck.ts` |
| `SHIPPED_SHAPE`, which way a play is weighted by how much the game was still in the balance | `model/leverage.ts` | `scripts/leverageUsageProbe.ts` |
| Leverage weighted share not replacing raw share anywhere | `features/leverageUsage.ts` | the leverage finding in `scripts/README.md` |
| The sleeper score taking the price off at all, and the form terms being centred per position | `model/sleepers.ts` | `scripts/sleeperEval.ts` |
| Game script being left out of the week's setting | `scripts/buildSite.ts` | deleted, see `docs/scoreboard.md` |
| The browser engine agreeing with the Node simulator | `app/lib/remainder.test.ts` | `scripts/simAgreement.ts` |

## What is still doubled up

Three drive walks exist. `drive.ts` came first and takes yards from a
pool with no players in it. `playerDrive.ts` put the players in.
`driveFromFactors.ts` with `gameFromDrives.ts` on top is the one that
follows from the decomposition above, and the only one that plays
whole games. The first two are superseded and the evals that use them
are kept only as a comparison.

Two share models exist. `fitRoles.ts` divides a season into four
situations, which is what the older walks want. `fitPlayFactors.ts`
works off the state. The four situations lose real differences: a back
takes 17% of the work on third and seven and 39% on third and twenty.

Two yardage models exist for the same reason, `driveRules.ts` for the
older walks and `fitPlayFactors.ts` for the newer.

None of this is a design. It is the older layers left standing while
the newer ones were measured, and it should collapse to one of each.
