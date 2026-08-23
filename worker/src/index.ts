/**
 * A way through to a private ESPN league, and somewhere to keep the
 * sign in so a phone never has to.
 *
 * ESPN keeps a private league behind two cookies your sign in leaves
 * on espn.com. A browser sends those only to espn.com and cannot set
 * them by hand, so the draft page cannot read such a league however it
 * asks. A request from here can. Paste the two cookies once, on a
 * machine where you can get at them, and everything after that needs
 * only the key.
 *
 * There is no signing in to ESPN from here. Its accounts are Disney's,
 * behind a flow built to keep robots out, and taking a password to
 * work around that is not something worth building.
 */

interface Held {
  ESPN: KVNamespace;
  PORTAL_KEY: string;
}

const ESPN = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

/** the views the draft page reads, so a caller cannot ask for more */
const VIEWS = ["mTeam", "mSettings", "mRoster", "mDraftDetail"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,OPTIONS",
  "access-control-allow-headers": "x-espn-swid,x-espn-s2,x-key,content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request: Request, held: Held): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const asked = new URL(request.url);
    const key = request.headers.get("x-key") ?? asked.searchParams.get("key") ?? "";
    const path = asked.pathname.replace(/\/+$/, "");

    if (path === "" || path === "/") {
      return new Response(PORTAL, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (!held.PORTAL_KEY || key !== held.PORTAL_KEY) {
      return answer({ error: "wrong key" }, 401);
    }

    if (path === "/session" && request.method === "PUT") {
      const said = await request.json().catch(() => null) as
        { swid?: string; s2?: string } | null;

      if (!said?.swid || !said?.s2) {
        return answer({ error: "give me both cookies" }, 400);
      }

      await held.ESPN.put("session", JSON.stringify({
        swid: said.swid, s2: said.s2, at: new Date().toISOString(),
      }));

      return answer({ kept: true }, 200);
    }

    const leagueId = path.split("/").filter(Boolean).pop() ?? "";
    const season = asked.searchParams.get("season") ?? "";

    if (!/^\d+$/.test(leagueId) || !/^\d{4}$/.test(season)) {
      return answer({ error: "give me a league id and a season" }, 400);
    }

    // whatever came with the request, else whatever was left here
    const kept = await held.ESPN.get("session", "json") as
      { swid: string; s2: string } | null;
    const swid = request.headers.get("x-espn-swid") || kept?.swid || "";
    const s2 = request.headers.get("x-espn-s2") || kept?.s2 || "";
    const at = `${ESPN}/${season}/segments/0/leagues/${leagueId}` +
      "?" + VIEWS.map((view) => `view=${view}`).join("&");
    const said = await fetch(at, {
      headers: swid && s2 ? { cookie: `SWID=${swid}; espn_s2=${s2}` } : {},
    });

    if (said.status === 401) {
      return answer({
        error: "ESPN refused. The cookies here have gone stale, so paste " +
          "them again at the worker's own page.",
      }, 401);
    }

    if (!said.ok) {
      return answer({ error: `ESPN answered ${said.status}` }, said.status);
    }

    return answer(await said.json(), 200);
  },
};

function answer(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

const PORTAL = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESPN session</title>
<style>
 body{background:#10141C;color:#E8ECF2;font:16px/1.5 system-ui,sans-serif;
   margin:0;padding:2rem 1.25rem;max-width:34rem}
 h1{font-size:1.3rem;margin:0 0 .3rem}
 p{color:#8B95A5;font-size:.92rem}
 label{display:block;margin:.9rem 0 .2rem;font-size:.72rem;
   letter-spacing:.06em;text-transform:uppercase;color:#5B6575}
 input{width:100%;padding:.55rem .7rem;border-radius:8px;
   border:1px solid #2A3342;background:#1A2029;color:inherit;font:inherit}
 button{margin-top:1.1rem;padding:.55rem 1.2rem;border:0;border-radius:999px;
   background:#35C06F;color:#0C1117;font:inherit;font-weight:700;cursor:pointer}
 #said{margin-top:1rem;font-size:.9rem}
 code{background:#1A2029;padding:.1rem .3rem;border-radius:4px}
</style>
<h1>ESPN session</h1>
<p>Sign in at espn.com, then copy <code>SWID</code> and <code>espn_s2</code>
from its cookies and leave them here. The draft page then reads your
private leagues with only the key, on any device.</p>
<label>key</label><input id="key" type="password">
<label>SWID</label><input id="swid" placeholder="{AAAA-BBBB}">
<label>espn_s2</label><input id="s2">
<button id="go">keep it</button>
<div id="said"></div>
<script>
document.getElementById("go").addEventListener("click", async () => {
  const said = document.getElementById("said");
  said.textContent = "keeping...";
  const answered = await fetch("/session", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-key": document.getElementById("key").value.trim(),
    },
    body: JSON.stringify({
      swid: document.getElementById("swid").value.trim(),
      s2: document.getElementById("s2").value.trim(),
    }),
  }).then((r) => r.json()).catch(() => null);
  said.textContent = answered && answered.kept
    ? "kept. The draft page can read your leagues now."
    : "no: " + ((answered && answered.error) || "that did not go through");
});
</script>`;
