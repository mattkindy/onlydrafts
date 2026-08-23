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

Anyone can use it, and it keeps nothing for anybody. A public ESPN
league opens on its id alone. A private one needs the two cookies your
own sign in leaves on espn.com: find them under application, storage,
cookies, where `SWID` looks like `{AAAA-BBBB}` and `espn_s2` is long.
Paste them on the draft page. They stay in your browser, ride along on
each request, and are gone once ESPN answers.

Everyone brings their own. One sign in kept here would mean one
person's leagues opening for everybody else, and a pile of other
people's credentials sitting on a server, neither of which is worth
doing for a draft board.

ESPN expires the cookies eventually, so take them again when a league
stops opening.

## What it will not do

There is no signing in to ESPN from here. Its accounts are Disney's,
behind a flow built to keep robots out, and taking somebody's password
to get around that is not worth building.

## On a phone

A phone browser will not let you at those cookies. Copy them on a
computer and put them into the draft page there, or send them to
yourself and paste them in on the phone.
