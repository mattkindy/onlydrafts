# The ESPN worker

ESPN keeps a private league behind the cookies your sign in leaves on
espn.com. A browser sends those only to a page on espn.com, and
javascript cannot set them by hand, so the draft page cannot read a
private league however it asks. This worker can, because a request made
from here can carry them.

It keeps nothing. The two cookies arrive on the request, go straight to
ESPN, and are gone when it answers.

## Where it is

    https://depth-chart-espn.matt-kindy-ii.workers.dev

To put a change up:

    cd worker
    npx wrangler deploy

The free plan covers this many times over: a hundred thousand requests
a day, where loading a league takes one.

## Using it

On the draft page, choose espn, then fill the three boxes: the worker
address, and your `SWID` and `espn_s2` cookies. Find those in your
browser on espn.com under application, storage, cookies. SWID looks
like `{AAAA-BBBB}` and espn_s2 is long. They live in your browser and
go to your worker and nowhere else, and ESPN expires them, so take them
again when a league stops opening.

A public league needs none of this.
