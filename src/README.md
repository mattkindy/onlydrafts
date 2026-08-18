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

**Upward** is plays into drives into games into seasons. The walk is
all of this and it works: drives come out 6.1 plays long against 5.9,
and a third of them end in three plays or fewer against a third really.

**Sideways** is one thing against another at the same level. Players
compete with their team-mates for the ball, in `shareCompetition.ts`,
and an offence meets a defence, in `againstDefence.ts` and
`interactionNet.ts`. Both are built and measured and neither is
connected to the walk.

**Downward** is a level constraining what happens beneath it, and there
is none of it. `teamState.ts` knows what an offence is worth and cannot
tell a drive. `gameSize.ts` knows how big an afternoon looks and is not
in the walk.

That is why the model comes out calibrated and knows nothing about a
particular game. Passing upward alone gives the right spread of
outcomes across a season and no way to tell two sides apart: it puts
two team games 1.29 points apart where the market puts them 3.82 and
where they really land 9.69 apart. A team's quality is known at the top
and never reaches the plays.

It also says why working the level out from the plays failed. The level
is not down there to be found. It is up here to be sent down.

## The rules that keep it honest

Everything shrinks toward something, and what it shrinks toward is
fitted rather than picked. A constant in a per player slot is an error
the moment it meets a particular man: `yardSwing` sat at 0.35 for
everybody where men really swing 1.26.

A quantity is asked about at the level it lives at. Team strength is a
team and a season. A share is a roster. A yardage is a play.

A description of a man comes from his last so many games, crossing
seasons where it has to, so it is right in week six as well as in
August and so a fit from it can never contain the answer.

Each piece is scored on its own before anything is composed, and scored
where it lives: an opening level on the first three weeks, an updating
rule on week seven onward, a matchup on cell means, a share on a season.

## What is still doubled up

Three drive walks exist. `drive.ts` came first and takes yards from a
pool with no players in it. `playerDrive.ts` put the players in.
`driveFromFactors.ts` is the one that follows from the decomposition
above. The first two are superseded and the evals that use them are
kept only as a comparison.

Two share models exist. `fitRoles.ts` divides a season into four
situations, which is what the older walks want. `fitPlayFactors.ts`
works off the state. The four situations lose real differences: a back
takes 17% of the work on third and seven and 39% on third and twenty.

Two yardage models exist for the same reason, `driveRules.ts` for the
older walks and `fitPlayFactors.ts` for the newer.

None of this is a design. It is the older layers left standing while
the newer ones were measured, and it should collapse to one of each.
