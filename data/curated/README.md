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
