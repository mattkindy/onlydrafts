# Backlog

What is designed but not built, and the leads left open by a
measurement that came out negative. Done work is in the commit history,
the numbers are in `docs/scoreboard.md`, and the write-ups behind most
of these are in `scripts/README.md`.

## Not built

- Chemistry between two players: pair tenure from overlapping stints,
  target-weighted pair efficiency with shrinkage, college teammate
  overlap. A player node has a `college` field and nothing reads it
  yet.
- OL continuity defined by snap counts. The roster-based version (share
  of last season's five most-used linemen still on the week-1 roster)
  learned the right direction in training and slightly hurt held-out
  scores, so it is out.
- Pluggable player-quality input beyond draft capital and snap counts:
  Approximate Value next, PFF grades behind a manual CSV import.
- A downward direction in the stack. `teamState.ts` and `gameSize.ts`
  know what a team is worth and the walk never hears it, which is why
  the walk orders a side's points at about .15 against the betting
  line's .39. See `src/README.md`.
- Collapsing the duplicated layers: three drive walks, two share
  models, two yardage models. Also in `src/README.md`.

## Leads left open

- **Touches inside one game are not independent.** The situational
  simulation gives big weeks 24% too often and quiet weeks 12% too
  often, and sweeping every knob says the tail is a mean slightly high
  rather than a spread too wide. Drawing each touch on its own is the
  suspect: a man who gets an early target gets the next one, and a team
  that is behind throws to him all afternoon. Modelling that would thin
  the tails and fill the middle at once. Sweeps in
  `scripts/fitWeekSettings.ts`.
- **Nothing predicts which of a man's own weeks is the big one.** Over
  2025, the weekly model scores .624 across players and -.023 within
  one. The simulation told what game it was playing (opponent, spread,
  total, wind) scores .0127 within a player. Two models with different
  information agree. So the advice is to start the better player, and
  what a page says about a soft matchup is decoration. The one matchup
  measure that carried over year to year was a defence's extra
  suppression of the opposing room leader, at .204 against .100 for its
  general suppression, and that has not been tried in the weekly model.
- **Same-team catcher pairs simulate at 0.07 correlation** where the
  data says 0. Needs a negative competition channel.
- **Concentration is predictable and does not help.** A ridge ranks a
  player's share of his season landing in his best quarter of weeks at
  .364 for 2024 and .517 for 2025, well past his own past
  concentration. Splitting the residual model into concentration bands
  made every quantile worse. `src/backtest/intervals.ts` stays as the
  harness. See `scripts/concentrationEval.ts` and
  `scripts/shapedIntervalEval.ts`.
- **A play's yards are predictable between configurations, not within
  one.** The same model scores .084 on single plays and .698 to .850 on
  cell means as the cells get bigger, which is what it should do when
  the play call is unobserved. Five model classes were compared on
  single plays and tied; comparing them on cell means might separate
  them and has not been done. See `scripts/cellMeansEval.ts`.
- **Letting a model find combinations does not pay.** Both
  `src/model/factorization.ts` and `src/model/entityNet.ts` come out
  level with adding the pieces up, on yards, run or pass, personnel and
  moving the chains. The interactions found by hand were one to one and
  a half standard errors, and a search with no prior cannot tell those
  from noise. Which cuts both ways: the hand-found ones may be fitted
  to the hypothesis somebody happened to pick. More seasons, rather
  than a cleverer model.
- **Third-down throwing depth belongs to the quarterback, not the
  play-caller.** It carries at .434 when the passer stays and .253 when
  he changes, and the play-caller split has no signal in it. The drive
  walk conditions a play's yards on down and distance and has no idea
  who is throwing. See `scripts/thirdDownDepthEval.ts`.
- **A new coordinator does not tell you to fade a back.** A player's
  own carry share carries at .671 under the same staff and .653 under a
  new one. Tight ends are the exception, at .737 against .484. See
  `scripts/roleCarryoverEval.ts`.
- **A corner's coverage is largely not measurable from the
  play-by-play.** Charging a tackle only to a corner leaves yards
  allowed a target carrying over at .112, which is nothing. Include
  safeties and it reads .430, but that number is the measure telling a
  safety from a corner rather than anything about coverage. What may
  still work is room-leader suppression, which is an outcome rather
  than an attribution. See `scripts/aggregateCoverage.ts`.

## Decided against, with reasons recorded

- Season-average snap share as a season-model feature; it measures
  inverse efficiency.
- Injury prediction. Evaluation scores per game played instead.
