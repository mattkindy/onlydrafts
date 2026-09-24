# Curated data

Files here are compiled by hand or aggregated from the raw downloads.
The aggregated ones are reproducible: run the script named in the
header comment and they come back identical.

The hand-compiled ones are not, and they carry the risk that goes with
that. `coaches.csv` and `coordinators.csv` were written from knowledge
rather than pulled from a source, because nflverse publishes head
coaches in `games.csv` and nothing else. A wrong name in either file
does not fail loudly; it produces a coaching change that never
happened, or hides one that did, and every measurement downstream
inherits it silently.

So before leaning on a finding that turns on a particular staff, check
that staff. The ones this repo has leaned on so far are the 2026
offensive coordinators, used for draft advice, and the 2022 to 2025
staffs, used for the measurements of what a coordinator carries with
him.

`sleeperWeekly.csv` comes from someone else's live API rather than from
the raw downloads, so `scripts/fetchSleeperProjections.ts` reproduces it
only as long as Sleeper keeps serving those weeks. Sleeper projects
about 350 men a week at the four positions, which is fewer than play, so
anything scored against it has to say what share of the slate it covered.

Every week of the season is fetched, including the ones nobody has
played, because the player card shows a line for each week ahead.
Sleeper revises a week as it nears, and each run overwrites the row with
what Sleeper says now. A run rewrites every week it fetched, so a player
Sleeper has stopped projecting leaves this file and shows up in
`sleeperQuiet.csv` instead. A stored row for a week already played is
Sleeper's last word before kickoff and nothing here remembers what it
said a month out. Anything measuring how good Sleeper is weeks in
advance has to be collected as the season runs; it cannot be read back
out of this file.

`adp/` has the draft boards for the season being played, taken before it
started. Sleeper and Fantasy Football Calculator both serve only the
drafts of the last few days, so a board pulled in October describes a
different room from the one the league drafted in, and the weekly build
has no copy of its own. `scripts/pullSleeperAdp.ts` and
`scripts/pullAdp.ts` write here and will not replace a board without
`--force`. The loaders read this folder first and fall back to
`data/raw`, which is where an older season's board still comes from:
the mocks site serves a past season's preseason board on request.

For 2026, the Sleeper board was pulled on 22 August, eighteen days before
the first game on 9 September. The two Fantasy Football Calculator
boards cover drafts from 7 to 14 September, so most of those drafts
happened after kickoff. They are the only 2026 copies there are, since
the site serves only the last week. Pull the next season's boards in the
week before it starts.
