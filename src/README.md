# How the model is put together

One idea runs through all of it: work out the smallest thing, check it
against what happened, and let everything larger be those small things
in sequence. Nothing above a play is fitted. A drive is plays, a game is
drives, a season is games, and if a drive comes out wrong that points at
a factor rather than at a rule about drives.

## The levels, and what is decided at each

**A play** is a call, a man it goes to, and what he gains. Each is
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

**A player's share** is what he wins against the men he plays with, not
something he owns and carries between teams. `shareCompetition.ts`
divides a position group's work by what each man has shown, a rookie
counting for what his draft round usually brings.

**A player's rates** come from his own plays where he has enough of
them and from what his attributes say where he does not.
`attributePriors.ts` mixes the two, and how much of each is fitted on a
season nobody is being judged on rather than chosen.

## Which way things are passed

Think of it as a stack that passes messages in three directions, since
that is what says which parts are missing rather than merely unwired.

**Upward** is plays into drives into games into seasons, and it now
runs the whole way. A drive comes out 5.9 plays against 5.9 with every
ending within a point or two. A game is two sides taking turns against
a shared clock in `gameFromDrives.ts`, so how many drives each gets,
where they start and the score during play all come out rather than
being handed in. `linesFrom` turns a played game into stat lines,
with the passing credited to the man who threw it.

**Sideways** is one thing against another at the same level, and the
parts that pay are wired. The competition for the ball divides each
man's carries and targets separately (`projectedShares.ts`,
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

## The rules that keep it honest

Everything shrinks toward something, and what it shrinks toward is
fitted rather than picked. A constant in a per player slot is an error
the moment it meets a particular man: `yardSwing` sat at 0.35 for
everybody where men really swing 1.26.

A quantity is asked about at the level it lives at. Team strength is a
team and a season. A share is a roster. A yardage is a play.

A ratio has no reason to average one, so anything that multiplies a
draw is centred on what it averages over the touches it is put on.
The men who get the ball are better than the average of everyone who
ever touched it, and before centring, that alone put two points a
game on the board that nobody scored.

A change is judged against the same code with the change off, run at
the same time, never against a number remembered from before other
things moved. And nothing under a fifth of a point is quoted off one
seed: the season eval moves about .03 of ordering between two seeds
of the same code.

A description of a man comes from his last so many games, crossing
seasons where it has to, so it is right in week six as well as in
August and so a fit from it can never contain the answer.

Each piece is scored on its own before anything is composed, and scored
where it lives: an opening level on the first three weeks, an updating
rule on week seven onward, a matchup on cell means, a share on a season.

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
