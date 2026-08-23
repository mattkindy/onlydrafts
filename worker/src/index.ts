/**
 * A way through to a private ESPN league, for whoever is asking.
 *
 * ESPN keeps a private league behind two cookies your sign in leaves
 * on espn.com. A browser sends those only to espn.com and cannot set
 * them by hand, so the draft page cannot read such a league however it
 * asks. A request from here can.
 *
 * It keeps nothing. Everyone brings their own two cookies, which live
 * in their own browser, ride along on the request, and are gone when
 * ESPN answers. Anything else would mean one person's sign in reading
 * another person's leagues, or this holding a pile of other people's
 * credentials, and neither is worth doing.
 *
 * There is no signing in to ESPN from here either. Its accounts are
 * Disney's, behind a flow built to keep robots out.
 */

const ESPN = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

/** the views the draft page reads, so a caller cannot ask for more */
const VIEWS = ["mTeam", "mSettings", "mRoster", "mDraftDetail"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "x-espn-swid,x-espn-s2",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const asked = new URL(request.url);
    const leagueId = asked.pathname.split("/").filter(Boolean).pop() ?? "";

    const season = asked.searchParams.get("season") ?? "";

    if (!/^\d+$/.test(leagueId) || !/^\d{4}$/.test(season)) {
      return answer({ error: "give me a league id and a season" }, 400);
    }

    const swid = request.headers.get("x-espn-swid") ?? "";
    const s2 = request.headers.get("x-espn-s2") ?? "";
    const at = `${ESPN}/${season}/segments/0/leagues/${leagueId}` +
      "?" + VIEWS.map((view) => `view=${view}`).join("&");
    const said = await fetch(at, {
      headers: swid && s2 ? { cookie: `SWID=${swid}; espn_s2=${s2}` } : {},
    });

    if (said.status === 401) {
      return answer({
        error: "ESPN refused. A private league needs both of your cookies, " +
          "and they go stale, so take them fresh from espn.com.",
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
