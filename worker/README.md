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

## Leaving your sign in with it

Open the worker's own address in a browser and it shows a small page
asking for three things: the key, and the two cookies. Find the cookies
on espn.com under application, storage, cookies: `SWID` looks like
`{AAAA-BBBB}` and `espn_s2` is long. They are kept in the worker's own
store and used for later requests, so this is done once from a machine
where you can get at them.

The key is a secret set on the worker:

    npx wrangler secret put PORTAL_KEY

After that, the draft page needs only that key, which is why a phone
works: nothing there ever sees a cookie.

ESPN expires the cookies eventually. When a league stops opening, go
back to the worker's page and leave them again.

A public league needs none of this.

## What it will not do

There is no signing in to ESPN from here. Its accounts are Disney's,
behind a flow built to keep robots out, and taking somebody's password
to get around that is not worth building.

## On a phone

A phone browser will not let you at the cookies, and it will not send
espn.com's own to another site either, so neither route works there.
Pull the league once from a machine that has them and the answer ships
with the site:

    ESPN_SWID='{...}' ESPN_S2='...' npx tsx scripts/pullEspnLeague.ts 829178711

That writes `docs/weekly/data/league-espn-829178711.json`. Commit it,
push, and the league opens on any device with nothing typed. Rosters
are as they were when you pulled, so pull again when they change.
