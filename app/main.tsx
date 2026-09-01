/**
 * The page: which league you are looking at, which view, and the board
 * put in that league's terms.
 *
 * Everything a league changes is applied when it is read, so switching
 * one recomputes the whole board rather than showing numbers built for
 * somebody else's rules.
 */

import { Component, render, type ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import "./style.css";

import { loadBoard, loadMeta, type Board } from "./lib/data.ts";
import { rescore, roomFor } from "./lib/board.ts";
import { keep, stored, normalizeName } from "./lib/store.ts";
import {
  NeedsEspnCookies, PROVIDERS, sleeperPlayers, type League,
} from "./lib/providers.ts";
import { markedKeepers, saveMarkedKeepers } from "./lib/keepers.ts";
import { draftNow } from "./lib/draftWatch.ts";
import type { Player } from "./lib/scoring.ts";

import { PlayerSheet } from "./views/PlayerSheet.tsx";
import { EspnSheet } from "./views/EspnSheet.tsx";
import { Roster } from "./views/Roster.tsx";
import { DraftRating } from "./views/DraftRating.tsx";
import { Keepers } from "./views/Keepers.tsx";
import { DraftView, type DraftNow } from "./views/Draft.tsx";

type View = "leagues" | "roster" | "keepers" | "draft" | "rating" | "start" | "waivers";

const COPY: Record<View, [string, string, string]> = {
  leagues: [
    "My leagues",
    "Choose where your league lives, name yourself, then tap a league to open it. Draft help, lineups, and waivers all live inside a league.",
    "",
  ],
  roster: [
    "My roster",
    "Everyone your league currently has on your team, with this season's projection for each.",
    "Before a keeper draft this is last season's roster until the league clears it. Tap a player for the season distribution and to mark a keeper.",
  ],
  keepers: [
    "Keeper value",
    "The most a player is worth keeping for. Paying a round for him means giving up that pick, so he is worth it only while he beats whoever you could take with it.",
    "Type what your league charges and each card says whether to keep him. A player worth a 5th and costing a 9th is a bargain; one costing a 2nd is not.",
  ],
  draft: [
    "Draft help",
    "Live board for draft night. It watches your league's draft, removes players as they go, and ranks who is left by what your roster still needs.",
    "The big number is value over a replacement starter. Players stay on the board until they are actually kept or drafted.",
  ],
  rating: [
    "How the draft went",
    "Every team against what its own picks were worth, so the team that drafted third is not rewarded for drafting third. Then your own draft, pick by pick.",
    "Where the room was taking a man leads and our own value over a replacement starter follows, since the board orders kickers and defences by nothing much.",
  ],
  start: [
    "Who to start",
    "Your roster for one week, ranked by projected points, so you can set a lineup.",
    "",
  ],
  waivers: [
    "Who to add",
    "Your players next to the best available at each position, so you can see whether a pickup is an upgrade.",
    "",
  ],
};

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "DEF", "ROOKIES"];

/** the few a reader would check, spelled out on hover */
function payDescription(pays: Record<string, number> | null | undefined): string {
  const said = [
    ["a catch", pays?.["rec"] ?? 0],
    ["a receiving yard", pays?.["rec_yd"] ?? 0.1],
    ["a rushing yard", pays?.["rush_yd"] ?? 0.1],
    ["a touchdown", pays?.["rush_td"] ?? 6],
    ["a passing yard", pays?.["pass_yd"] ?? 0.04],
    ["a passing touchdown", pays?.["pass_td"] ?? 4],
  ];

  return "this league pays " +
    said.map(([what, n]) => `${n} for ${what}`).join(", ");
}

const NOTHING: DraftNow = {
  taken: new Set(), mine: new Set(), teams: {}, rosteredBy: {}, grid: null,
};

function SeasonNotStarted() {
  return (
    <div class="empty">
      <b>The season has not kicked off yet.</b> Weekly projections need a
      few games of this year's snaps and targets, so they turn on about a
      month in. Until then use <b>draft help</b> and <b>my roster</b>.
    </div>
  );
}

function App() {
  const [season, setSeason] = useState<number | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [leagues, setLeagues] = useState<League[]>(() => stored<League[]>("leagues", []));
  const [active, setActive] = useState<League | null>(() => stored<League | null>("active", null));
  const [view, setView] = useState<View>("leagues");
  const [who, setWho] = useState(() => stored("username", ""));
  const [provider, setProvider] = useState(() => stored("provider", "sleeper"));
  const [perTeam, setPerTeam] = useState(() => stored("keepn", 3));
  const [posFilter, setPosFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<"rank" | "adp">("rank");
  const [needOnly, setNeedOnly] = useState(false);
  const [byNeed, setByNeed] = useState(false);
  const [manual, setManual] = useState(() => stored("manual", ""));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [showing, setShowing] = useState<Player | null>(null);
  const [espnHelp, setEspnHelp] = useState(false);
  const [draft, setDraft] = useState<DraftNow>(NOTHING);
  const [watching, setWatching] = useState(false);
  // bumped whenever a keeper price or a mark changes, since those live
  // in storage rather than in state
  const [marks, setMarks] = useState(0);

  useEffect(() => {
    loadMeta()
      .then((meta) => {
        setSeason(meta.boardSeason);

        return loadBoard(meta.boardSeason);
      })
      .then(setBoard)
      .catch((e: Error) => setStatus("could not read the board: " + e.message));
  }, []);

  /**
   * The board in this league's terms. Nothing here needs the model to
   * have been run for the league, since what each man does in a game
   * travels with the board and the scoring is applied on the way in.
   */
  const men = useMemo(() => {
    if (!board) {
      return [];
    }

    return rescore(board.players, {
      teams: active?.size ?? 12,
      slots: active?.slots ?? null,
      pays: active?.pays ?? {},
    });
  }, [board, active]);

  const byKey = useMemo(() => new Map(men.map((p) => [p.key, p])), [men]);
  const marked = active ? markedKeepers(active.leagueId) : {};

  /**
   * The draft is read as soon as you open the tab, so the board knows
   * who is gone without being asked. Watching only decides whether it
   * keeps asking.
   */
  useEffect(() => {
    if (!active || view !== "draft") {
      return;
    }

    const look = () => {
      sleeperPlayers()
        .then((all) => draftNow({
          league: active,
          marked: markedKeepers(active.leagueId),
          manual,
          nameFor: (id) => all[id]?.n ?? "",
          positionFor: (id) => all[id]?.p ?? "",
          /**
           * Keyed the way the board keys a man, since the page looks
           * him up by name and not by whatever id a provider uses.
           */
          hurt: Object.values(all).reduce<
            Record<string, { status: string; part?: string }>
          >((so, man) => {
            if (man.hurt) {
              so[normalizeName(man.n)] = {
                status: man.hurt, ...(man.part ? { part: man.part } : {}),
              };
            }

            return so;
          }, {}),
        }))
        .then(setDraft)
        .catch((e: Error) => setStatus(e.message));
    };

    look();

    if (!watching) {
      return;
    }

    const every = setInterval(look, 10000);

    return () => clearInterval(every);
  }, [watching, active, view, manual, marks]);

  const findLeagues = async () => {
    setBusy(true);
    setStatus("looking...");

    try {
      const found = await PROVIDERS[provider]!.leaguesFor(who.trim(), season ?? 2026);
      setLeagues(found);
      keep("leagues", found);
      keep("username", who);
      keep("provider", provider);
      setStatus(found.length ? "" : "no leagues there");
    } catch (e) {
      if (e instanceof NeedsEspnCookies) {
        setEspnHelp(true);
      }

      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = (lg: League) => {
    setActive(lg);
    keep("active", lg);
    setView("draft");
  };

  const markKeeper = (p: Player) => {
    if (!active) {
      return;
    }

    const map = markedKeepers(active.leagueId);

    if (map[p.key]) {
      delete map[p.key];
    } else {
      map[p.key] = active.team;
    }

    saveMarkedKeepers(active.leagueId, map);
    setMarks((n) => n + 1);
  };

  const [title, blurb, legend] = COPY[view];
  const asks = PROVIDERS[provider]!;

  return (
    <div class="wrap">
      <nav>
        <span class="brand" onClick={() => setView("leagues")}>
          depth<b>chart</b>
        </span>
        {active && view !== "leagues" && (
          <span id="crumb">
            <button onClick={() => setView("leagues")}>all leagues</button>
            <b>{active.name}</b>
            <span>you: {active.team}</span>
            {/* what the numbers are scored by, since standard and a
                board with no league connected look the same on screen */}
            <span class="pays" title={payDescription(active.pays)}>
              {roomFor(active.pays)}
            </span>
          </span>
        )}
      </nav>

      {view !== "leagues" && (
        <div id="subnav">
          {(["roster", "keepers", "draft", "rating", "start", "waivers"] as View[]).map((v) => (
            <button
              key={v}
              class={v === view ? "on" : ""}
              onClick={() => setView(v)}
            >
              {COPY[v][0].toLowerCase()}
            </button>
          ))}
        </div>
      )}

      <div id="explain">
        <h1>{title}</h1>
        <p>{blurb}</p>
      </div>

      <div class="controls">
        {view === "leagues" && (
          <>
            <label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.currentTarget.value)}
              >
                <option value="sleeper">sleeper</option>
                <option value="espn">espn</option>
              </select>{" "}
              <input
                size={12}
                value={who}
                placeholder={asks.wants}
                onInput={(e) => setWho(e.currentTarget.value)}
              />
            </label>
            <button class="act" disabled={busy} onClick={findLeagues}>
              {leagues.length ? "look again" : "find my leagues"}
            </button>
            {provider === "espn" && (
              <button onClick={() => setEspnHelp(true)}>espn sign in</button>
            )}
          </>
        )}

        {(view === "keepers" || view === "draft") && (
          <label>
            keepers per team{" "}
            <input
              type="number" min="0" max="6" style={{ width: "3.2rem" }}
              value={perTeam}
              onInput={(e) => {
                setPerTeam(Number(e.currentTarget.value));
                keep("keepn", Number(e.currentTarget.value));
              }}
            />
          </label>
        )}

        {view === "draft" && (
          <>
            <span id="posfilter">
              {POSITIONS.map((where) => (
                <button
                  key={where}
                  class={where === posFilter ? "on" : ""}
                  onClick={() => setPosFilter(where)}
                >
                  {where.toLowerCase()}
                </button>
              ))}
            </span>
            <label>
              order by{" "}
              <select
                value={order}
                onChange={(e) =>
                  setOrder(e.currentTarget.value as "rank" | "adp")}
              >
                <option value="rank">our value</option>
                <option value="adp">adp</option>
              </select>
            </label>
            {/* A filter and a sort, kept apart: one hides men you cannot
                start, the other reorders by what they add to the lineup
                you have left. */}
            <label>
              <input
                type="checkbox" checked={needOnly}
                onChange={(e) => setNeedOnly(e.currentTarget.checked)}
              />{" "}
              only what I still need
            </label>
            <label>
              <input
                type="checkbox" checked={byNeed}
                onChange={(e) => setByNeed(e.currentTarget.checked)}
              />{" "}
              weight by need
            </label>
            <label>
              find{" "}
              <input
                size={12} placeholder="a name" value={query}
                onInput={(e) => setQuery(normalizeName(e.currentTarget.value))}
              />
            </label>
            <button class="act" onClick={() => setWatching((on) => !on)}>
              {watching ? "pause watching" : "start watching the draft"}
            </button>
          </>
        )}

        <span id="status">{status}</span>
      </div>

      {view === "draft" && (
        <div class="controls">
          <label class="hint">extra names to mark as taken, one per line</label>
          <textarea
            value={manual}
            onInput={(e) => {
              setManual(e.currentTarget.value);
              keep("manual", e.currentTarget.value);
            }}
          />
        </div>
      )}

      <div id="out">
        {!board && <div class="empty">reading the board...</div>}

        {board && view === "leagues" && (
          leagues.length === 0
            ? (
              <div class="empty">
                <b>Start here.</b>
                <div class="step"><span>1</span><span>Pick where your league lives, then type your {asks.wants} above.</span></div>
                <div class="step"><span>2</span><span>Press find. Your leagues appear as cards.</span></div>
                <div class="step"><span>3</span><span>Tap a league, then use draft help or keeper value.</span></div>
              </div>
            )
            : (
              <>
                <h2>your leagues</h2>
                <p class="hint">
                  A league you joined since you last looked will not be
                  here until you look again.
                </p>
                <div class="cards">
                  {leagues.map((lg) => (
                    <div
                      key={lg.leagueId + lg.userId}
                      class={"card league-card" +
                        (active?.leagueId === lg.leagueId ? " mine" : "")}
                      onClick={() => open(lg)}
                    >
                      <div class="nm">{lg.name}</div>
                      <div class="sub">
                        <span>{lg.size} teams</span>
                        <span>you: {lg.team}</span>
                      </div>
                      {/* which scoring, since picking the wrong league
                          of two is otherwise silent */}
                      <div class="sub">
                        <span class="pays">{roomFor(lg.pays)}</span>
                        <span>{lg.pays?.["rec"] ?? 0} a catch</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )
        )}

        {board && active && view === "roster" && season && (
          <Roster
            byKey={byKey}
            league={active}
            season={season}
            perTeam={perTeam}
            marked={marked}
            onMark={markKeeper}
            onMore={setShowing}
          />
        )}

        {board && active && view === "keepers" && (
          <Keepers
            key={marks}
            men={men}
            byKey={byKey}
            league={active}
            perTeam={perTeam}
            onMore={setShowing}
            onChange={() => setMarks((n) => n + 1)}
          />
        )}

        {board && view === "draft" && (
          <DraftView
            men={men}
            state={draft}
            teams={active?.size ?? 12}
            snake={active?.snake ?? true}
            posFilter={posFilter}
            query={query}
            order={order}
            slots={active?.slots ?? null}
            needOnly={needOnly}
            byNeed={byNeed}
            onMore={setShowing}
          />
        )}

        {board && active && view === "rating" && (
          <DraftRating
            board={men}
            byKey={byKey}
            league={active}
            made={draft.made ?? []}
          />
        )}

        {(view === "start" || view === "waivers") && <SeasonNotStarted />}
      </div>

      <p class="hint">{legend}</p>

      {showing && season && (
        <PlayerSheet
          p={showing}
          plus={board?.plusMinus.get(showing.key)?.plus ?? []}
          minus={board?.plusMinus.get(showing.key)?.minus ?? []}
          teams={active?.size ?? 12}
          kept={Boolean(marked[showing.key])}
          onKeep={() => { markKeeper(showing); setShowing(null); }}
          onClose={() => setShowing(null)}
        />
      )}

      {espnHelp && (
        <EspnSheet
          onClose={() => setEspnHelp(false)}
          onKept={() => {
            setEspnHelp(false);
            setStatus("kept. Try the league again.");
          }}
        />
      )}
    </div>
  );
}

/**
 * Somewhere for a render to fail loudly.
 *
 * Preact stops updating when a render throws, so the page keeps
 * whatever it drew last. A league saved without its scoring did that
 * once: the board loaded, drawing the league list threw, and the page
 * sat on "reading the board" looking for all the world like the site
 * was down. Better to say what happened and offer the way out.
 */
class Caught extends Component<
  { children: ComponentChildren }, { blew: Error | null }
> {
  state = { blew: null as Error | null };

  static getDerivedStateFromError(blew: Error) {
    return { blew };
  }

  render() {
    if (!this.state.blew) {
      return this.props.children;
    }

    return (
      <div class="wrap">
        <h1>The page stopped</h1>
        <div class="empty">
          <b>{this.state.blew.message}</b>
          <br />
          Something the browser remembered may be from an older version
          of this page. Forgetting it and looking your leagues up again
          usually clears it.
          <div class="row">
            <button
              class="act"
              onClick={() => {
                localStorage.clear();
                location.reload();
              }}
            >
              forget and start over
            </button>
          </div>
        </div>
      </div>
    );
  }
}

render(
  <Caught>
    <App />
  </Caught>,
  document.getElementById("app")!,
);
