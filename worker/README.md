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

## Getting the two cookies out of ESPN

Nothing outside espn.com can read them, and nothing outside a browser
can use them, which is why both this and a few steps by hand are
needed. The draft page walks you through it: choose espn, press the
espn sign in button, and it says where to look.

The short version: sign in at espn.com, open the developer tools,
Application then Cookies then espn.com, and copy `SWID` and `espn_s2`.

## What it will not do

There is no signing in to ESPN from here. Its accounts are Disney's,
behind a flow built to keep robots out, and taking somebody's password
to get around that is not worth building.

## Getting the two cookies out of ESPN

Nothing outside espn.com can read them. That is the rule which stops
any site reading your bank session, and it holds however the asking is
done: a worker only ever sees cookies addressed to itself, an iframe
cannot read across, and ESPN has no way to hand a token to somebody
else. So they have to come across by hand, from a page on espn.com.

Save this as a bookmark, with the whole thing as the address, then
sign in to espn.com and click it there. It copies both cookies, and
you paste them into the draft page.

```
javascript:(function(){var c=document.cookie,s=(c.match(/SWID=([^;]+)/)||[])[1],t=(c.match(/espn_s2=([^;]+)/)||[])[1];if(!s||!t){alert('Sign in to espn.com first, then click this there.');return}navigator.clipboard.writeText('SWID='+s+'; espn_s2='+t);alert('Copied. Paste it into the draft page.')})()
```

On a phone, make the bookmark first on a computer and let the browser
sync it, or copy the cookies there and send them to yourself.
