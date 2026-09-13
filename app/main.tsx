/**
 * The page: which league you are looking at, which view, and the board
 * put in that league's terms.
 *
 * Everything a league changes is applied when it is read, so switching
 * one recomputes the whole board rather than showing numbers built for
 * somebody else's rules.
 */

import { Component, render, type ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import "./style.css";

import { loadBoard, loadMeta, type Board } from "./lib/data.ts";
import { rescore, roomFor } from "./lib/board.ts";
import { keep, stored, normalizeName } from "./lib/store.ts";
import {
  NeedsEspnCookies, officeList, officeListWith, PROVIDERS, sleeperPlayers,
  type League, type Matchup,
} from "./lib/providers.ts";
import type { Listed } from "./lib/availability.ts";
import { markedKeepers, saveMarkedKeepers } from "./lib/keepers.ts";
import { draftNow } from "./lib/draftWatch.ts";
import type { Player } from "./lib/scoring.ts";

import { PlayerSheet } from "./views/PlayerSheet.tsx";
import { Reading } from "./views/Reading.tsx";
import { EspnSheet } from "./views/EspnSheet.tsx";
import { Roster } from "./views/Roster.tsx";
import { DraftRating } from "./views/DraftRating.tsx";
import { Keepers } from "./views/Keepers.tsx";
import { DraftView, type DraftNow } from "./views/Draft.tsx";
import { MyMatchup } from "./views/Matchup.tsx";
import { Matchups } from "./views/Matchups.tsx";
import { Standings } from "./views/Standings.tsx";
import { Waivers } from "./views/Waivers.tsx";
import {
  loadSlate, rosterKeys, slateUnder, weekRefs, withOutMenZeroed,
  type Slate, type WeekRef,
} from "./lib/slate.ts";

export type Order = "war" | "rank" | "adp";

/**
 * What each ordering means, said once you have chosen it. The three
 * answer different questions and the same man moves a long way between
 * them, so a reader wondering why Puka Nacua is top of one list and
 * eighth on another should not have to work it out.
 */
const ORDER_MEANS: Record<Order, string> = {
  war: "what he adds over the player you would otherwise end up with in that slot",
  rank: "where we rank him whoever drafts him",
  adp: "where he usually goes, so who lasts until your next pick",
};

type View = "leagues" | "matchup" | "league" | "players" | "team" | "draft";

/**
 * What each view is called, the one line under it, and the longer
 * answer behind "how this works".
 *
 * The line under the title is what a reader needs before they look at
 * the page. Everything else is what they ask once, so it waits behind a
 * tap rather than standing between them and the numbers.
 */
const COPY: Record<View, [string, string, string]> = {
  leagues: [
    "My leagues",
    "Pick your platform and enter your username.",
    "",
  ],
  matchup: [
    "My matchup",
    "Your lineup for the week, and the game you are setting it for.",
    "Every bench player is priced by what starting him would do to your win probability, and only the swaps that gain you something are listed. Win probability counts the part of each game still to play, so a lead with everybody done is the whole thing.",
  ],
  league: [
    "League",
    "The standings, every other game this week, and how the draft went.",
    "Each game's win probability comes from the week's projections for whatever is still to play. The draft grades rate a team by what it took rather than by where it picked, so the team with the third pick is not rewarded for having it.",
  ],
  players: [
    "Players",
    "Free agents worth adding, and what dropping one of yours costs.",
    "This week prices each move against the lineup you would set and the team you actually play. Rest of season runs a year of simulated weeks against an average opponent, which is why a bench player can cost nothing this week and something over the season.",
  ],
  team: [
    "My team",
    "Your roster, with this season's projection for each player.",
    "Before a keeper draft this is last season's roster until the league clears it. Tap a player for his season outlook and to mark a keeper.",
  ],
  draft: [
    "Draft",
    "Live board for draft night, ranked by what your roster still needs.",
    "It watches your league's draft and takes players off the board as they go. The order leads with what a player adds to the weeks you win, given the roster you would end up with.",
  ],
};

/** what the keeper section is called, since it has its own heading */
const KEEPERS_SAY =
  "Keeping a player costs you that pick, so he is worth it only if he " +
  "beats whoever you would draft there.";

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "DEF", "ROOKIES"];

/** the short label for a league's scoring, as people say it */
const SCORING_NAME: Record<"ppr" | "half" | "standard", string> = {
  ppr: "ppr", half: "half ppr", standard: "standard",
};

/** the settings a reader would check, spelled out on hover */
function scoringSettings(
  pays: Record<string, number> | null | undefined,
): string {
  const said = [
    ["reception", pays?.["rec"] ?? 0],
    ["receiving yard", pays?.["rec_yd"] ?? 0.1],
    ["rushing yard", pays?.["rush_yd"] ?? 0.1],
    ["TD", pays?.["rush_td"] ?? 6],
    ["passing yard", pays?.["pass_yd"] ?? 0.04],
    ["passing TD", pays?.["pass_td"] ?? 4],
  ];

  return "scoring: " + said.map(([what, n]) => `${n} per ${what}`).join(", ");
}

const NOTHING: DraftNow = {
  taken: new Set(), mine: new Set(), teams: {}, rosteredBy: {}, grid: null,
};

/**
 * One team in one league.
 *
 * ESPN will not say which of the teams is yours unless you are signed
 * in to it, so it offers every one and they all carry the same league
 * number. Which team it is has to be part of telling two of them apart.
 */
const sameSeat = (a: League | null, b: League | null) =>
  Boolean(a && b && a.provider === b.provider &&
    a.leagueId === b.leagueId && a.userId === b.userId);

/**
 * Light, dark, or whatever the phone is set to. The page follows the
 * system until somebody says otherwise, and the button walks around
 * the three so either choice can be undone.
 */
type Theme = "system" | "light" | "dark";

const NEXT_THEME: Record<Theme, Theme> = {
  system: "light", light: "dark", dark: "system",
};

/** where the team you picked in a league is remembered */
const seatKey = (lg: League) => "seat." + lg.provider + "." + lg.leagueId;

/** and where your answer lives when the provider will not say */
const keeperKey = (lg: League) => "keepers." + lg.provider + "." + lg.leagueId;

/**
 * The views where your own roster is part of the answer, so a player
 * added off waivers since the league was read would show as missing.
 */
const ROSTER_VIEWS: View[] = ["matchup", "league", "players", "team", "draft"];

/**
 * The views that price this week, so they need the slate and the league's
 * own games for it. The players page needs both to say what a move does to
 * the game you are actually playing.
 */
const WEEK_VIEWS: View[] = ["matchup", "league", "players"];

/** how old a read can be before one of those views asks the provider again */
const STALE_AFTER = 2 * 60 * 1000;

/**
 * How fresh the roster on screen is. It hangs off the refresh button
 * rather than taking a line of its own, since the button is where a
 * reader who cares about the time is already looking.
 */
function rosterRead(league: League): string {
  if (!league.readAt) {
    return "read, but the page did not note when";
  }

  const at = new Date(league.readAt)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return "read at " + at;
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
  const [theme, setTheme] = useState<Theme>(() => stored<Theme>("theme", "system"));
  const [query, setQuery] = useState("");
  const [everyTeam, setEveryTeam] = useState(false);
  /**
   * The weeks he wins you leads, because ordering that way beat
   * ordering by value over replacement in 26 of 36 seats across three
   * finished seasons, by about five points of weekly win rate. It used
   * to be a checkbox called weight by need, which described the measure
   * it replaced rather than this one and quietly overrode the order
   * chosen here.
   */
  const [order, setOrder] = useState<Order>(() => stored<Order>("order", "war"));
  const [needOnly, setNeedOnly] = useState(false);
  const [manual, setManual] = useState(() => stored("manual", ""));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  /** the team being opened, while its board is scored */
  const [opening, setOpening] = useState<string | null>(null);
  const [showing, setShowing] = useState<Player | null>(null);
  const [espnHelp, setEspnHelp] = useState(false);
  const [draft, setDraft] = useState<DraftNow>(NOTHING);
  const [watching, setWatching] = useState(false);
  // bumped whenever a keeper price or a mark changes, since those live
  // in storage rather than in state
  const [marks, setMarks] = useState(0);
  const [weeks, setWeeks] = useState<WeekRef[]>([]);
  const [week, setWeek] = useState<WeekRef | null>(null);
  const [built, setSlate] = useState<Slate | null>(null);
  const [weekStatus, setWeekStatus] = useState("");
  const [games, setGames] = useState<Matchup[]>([]);
  const [gamesStatus, setGamesStatus] = useState("");
  const [rereading, setRereading] = useState(false);
  /** who the league office has listed, for the week's pages as well as the draft */
  const [office, setOffice] = useState<Map<string, Listed>>(() => new Map());
  // the guard has to be the same object every render, since two reads
  // started from different effects would otherwise not see each other
  const reading = useRef(false);

  useEffect(() => {
    if (theme === "system") {
      delete document.documentElement.dataset["theme"];
    } else {
      document.documentElement.dataset["theme"] = theme;
    }

    keep("theme", theme);
  }, [theme]);

  useEffect(() => {
    loadMeta()
      .then((meta) => {
        setSeason(meta.boardSeason);

        const built = weekRefs(meta.weeks, meta.boardSeason);

        setWeeks(built);
        // the week you want on opening it is the newest one built
        setWeek(built[built.length - 1] ?? null);

        return loadBoard(meta.boardSeason);
      })
      .then(setBoard)
      .catch((e: Error) => setStatus("could not read the board: " + e.message));
  }, []);

  /**
   * The office's list, read once. Sleeper's file is the same file the
   * draft view reads and is kept for a day either way, so asking for it
   * here costs nothing. A read that fails leaves the list empty, and then
   * every man projects the way he did before, which is the old bug rather
   * than a new one.
   */
  useEffect(() => {
    sleeperPlayers()
      .then((all) => setOffice(officeList(all)))
      .catch(() => setOffice(new Map()));
  }, []);

  /** the week itself is only fetched once you ask for a tab that prices one */
  useEffect(() => {
    if (!WEEK_VIEWS.includes(view) || !week) {
      return;
    }

    let stale = false;

    setSlate(null);
    setWeekStatus("");
    loadSlate(week.file)
      .then((got) => { if (!stale) { setSlate(got); } })
      .catch((e: Error) => {
        if (!stale) {
          setWeekStatus("could not read week " + week.week + ": " + e.message);
        }
      });

    return () => { stale = true; };
  }, [view, week]);

  /** the league's own games, which only the provider knows */
  useEffect(() => {
    if (!WEEK_VIEWS.includes(view) || !active || !week) {
      return;
    }

    const asks = PROVIDERS[active.provider]!.matchupsFor;

    if (!asks) {
      setGamesStatus(active.provider + " will not say what this week's games are.");

      return;
    }

    let stale = false;

    setGames([]);
    setGamesStatus("");
    asks(active, week.week)
      .then((got) => { if (!stale) { setGames(got); } })
      .catch((e: Error) => {
        if (!stale) {
          setGamesStatus("could not read this week's games: " + e.message);
        }
      });

    return () => { stale = true; };
  }, [view, week, active]);

  /**
   * The week in this league's scoring. The build scored it once, and
   * a league that pays a catch differently moves every man by his
   * catches. Without a league, or one saved before its scoring was
   * kept, it reads as built.
   */
  const slate = useMemo(() => {
    if (!built || !active?.pays) {
      return built;
    }

    return slateUnder(built, active.pays["rec"] ?? 0);
  }, [built, active]);

  /**
   * Sleeper covers every man in the game, and an ESPN league adds only
   * what its own rosters say about men Sleeper had nothing on.
   */
  const listed = useMemo(
    () => active ? officeListWith(
      office, [active.myRoster, ...active.allRosters.map((r) => r.keys)],
    ) : office,
    [office, active],
  );

  /**
   * The week's projections, under the same key a lineup uses for a man,
   * with a nought where the office says he is not playing. Every page that
   * prices a week reads this map, so the ruling is applied once here
   * rather than in each of them.
   */
  const slateRows = useMemo(
    () => withOutMenZeroed(
      new Map((slate?.rows ?? []).map((r) => [normalizeName(r.name), r])),
      listed,
    ),
    [slate, listed],
  );

  /**
   * The board in this league's terms. Nothing here needs the model to
   * have been run for the league, since what each man does in a game
   * travels with the board and the scoring is applied on the way in.
   */
  const men = useMemo(() => {
    if (!board) {
      return [];
    }

    return rescore(
      board.players,
      {
        teams: active?.size ?? 12,
        slots: active?.slots ?? null,
        pays: active?.pays ?? {},
      },
      board.schedule,
    );
  }, [board, active]);

  const byKey = useMemo(() => new Map(men.map((p) => [p.key, p])), [men]);
  const marked = active ? markedKeepers(active.leagueId) : {};

  /**
   * The draft is read as soon as a league is opened, so the board knows
   * who is gone and the tabs know whether the draft is still to come.
   * Watching only decides whether it keeps asking.
   */
  useEffect(() => {
    if (!active) {
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
          teamFor: (id) => all[id]?.t ?? "",
          hurt: Object.fromEntries(officeList(all)),
        }))
        .then(setDraft)
        .catch((e: Error) => setStatus(e.message));
    };

    look();

    if (!watching || view !== "draft") {
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

      // looking again is how you pick up a draft order drawn since, or
      // a roster that has moved on, so the league you are on is
      // replaced by the one this read returned
      const again = found.find((lg) => sameSeat(lg, active));

      if (again) {
        setActive(again);
        keep("active", again);
      }

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

  /**
   * The league you are on, read again.
   *
   * Nothing else notices a roster that moved on: the league is a
   * snapshot taken when you looked it up, so a man added off waivers is
   * missing from the lineup pages until somebody asks the provider
   * again. This asks quietly, leaves the page as it is while it waits,
   * and a read that fails changes nothing, ESPN wanting cookies
   * included.
   */
  const reread = async (force: boolean) => {
    if (!active || reading.current) {
      return;
    }

    if (!force && Date.now() - (active.readAt ?? 0) < STALE_AFTER) {
      return;
    }

    reading.current = true;
    setRereading(true);

    const found = await PROVIDERS[active.provider]!
      .leaguesFor(who.trim(), season ?? active.season)
      .catch(() => null);
    const again = found?.find((lg) => sameSeat(lg, active));

    if (found) {
      setLeagues(found);
      keep("leagues", found);
    }

    if (again) {
      setActive(again);
      keep("active", again);
    }

    reading.current = false;
    setRereading(false);
  };

  useEffect(() => {
    if (!active || !ROSTER_VIEWS.includes(view)) {
      return;
    }

    void reread(false);

    const back = () => {
      if (document.visibilityState === "visible") {
        void reread(false);
      }
    };

    document.addEventListener("visibilitychange", back);

    return () => document.removeEventListener("visibilitychange", back);
  }, [active, view, who, season]);

  /**
   * Every team in a league where only one of them is yours. Once you
   * have said which, the others are put away until you ask for them.
   */
  const shown = useMemo(() => everyTeam ? leagues : leagues.filter((lg) => {
    const picked = stored(seatKey(lg), "");

    return !picked || picked === lg.userId;
  }), [leagues, everyTeam, active]);

  /**
   * Opening a league rescores the whole board and draws every man's
   * weeks before the draft view can paint, which freezes the page for a
   * second or two. The loader is painted first, and the work starts on
   * the frame after.
   */
  const open = (lg: League) => {
    setOpening(lg.team);
    setTimeout(() => {
      setActive(lg);
      keep("active", lg);
      keep(seatKey(lg), lg.userId);
      setEveryTeam(false);
      // once weeks are being played the draft is over, so a league opens
      // on your matchup rather than on pricing the whole board
      setView(weeks.length ? "matchup" : "draft");
      setOpening(null);
    }, 50);
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

  /**
   * Whether the draft is still to come. The provider says so outright
   * while it runs; a league already playing weeks with nothing to say
   * about a draft has had one.
   */
  const drafting = draft.status
    ? draft.status !== "complete"
    : weeks.length === 0;

  /**
   * Draft night comes first while there is one, and the tab goes away
   * once it is over, since the grades live under the league from then
   * on.
   */
  const tabs: View[] = drafting
    ? ["draft", "matchup", "league", "players", "team"]
    : ["matchup", "league", "players", "team"];

  useEffect(() => {
    if (view !== "leagues" && !tabs.includes(view)) {
      setView(tabs[0]!);
    }
  }, [drafting, view]);

  /**
   * Whether this league keeps players. Sleeper and ESPN both say, but
   * an older saved league does not, and then the reader is asked once
   * and it is remembered.
   */
  const keeperLeague = active
    ? active.keepers ?? stored(keeperKey(active), false)
    : false;

  const [title, blurb, legend] = COPY[view];
  const asks = PROVIDERS[provider]!;

  return (
    <div class="wrap">
      <nav>
        <span class="brand" onClick={() => setView("leagues")}>
          only<b>drafts</b>
        </span>
        {active && view !== "leagues" && (
          <span id="crumb">
            <button onClick={() => setView("leagues")}>all leagues</button>
            <b>{active.name}</b>
            <button
              disabled={rereading}
              title={"roster " + rosterRead(active)}
              onClick={() => void reread(true)}
            >
              refresh roster
            </button>
            <span>you: {active.team}</span>
            {/* what the numbers are scored by, since standard and a
                board with no league connected look the same on screen */}
            <span class="pays" title={scoringSettings(active.pays)}>
              {SCORING_NAME[roomFor(active.pays)]}
            </span>
          </span>
        )}
        <button
          class="theme"
          title="light, dark, or whatever your phone is set to"
          onClick={() => setTheme(NEXT_THEME[theme])}
        >
          {theme}
        </button>
      </nav>

      {view !== "leagues" && (
        <div id="subnav">
          {tabs.map((v) => (
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
        {legend && (
          <details class="asked">
            <summary>how this works</summary>
            <p>{legend}</p>
          </details>
        )}
      </div>

      {/* every other view leaves this bar with nothing in it, and an
          empty one still draws as a white strip across the page */}
      <div
        class="controls"
        hidden={!["leagues", "draft"].includes(view) &&
          !(view === "team" && keeperLeague)}
      >
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

        {(view === "draft" || (view === "team" && keeperLeague)) && (
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
                onChange={(e) => {
                  setOrder(e.currentTarget.value as Order);
                  keep("order", e.currentTarget.value);
                }}
              >
                <option value="war">weeks won</option>
                <option value="rank">our ranking</option>
                <option value="adp">adp</option>
              </select>
            </label>
            <span class="says">{ORDER_MEANS[order]}</span>
            {/* the filter is its own thing: it hides men you cannot start
                rather than changing the order of the ones you can */}
            <label>
              <input
                type="checkbox" checked={needOnly}
                onChange={(e) => setNeedOnly(e.currentTarget.checked)}
              />{" "}
              only positions I still need
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
          <label class="hint">
            extra players to mark as drafted, one name per line
          </label>
          <textarea
            value={manual}
            onInput={(e) => {
              setManual(e.currentTarget.value);
              keep("manual", e.currentTarget.value);
            }}
          />
        </div>
      )}

      {active && rereading && ROSTER_VIEWS.includes(view) && (
        <Reading>reading your roster again...</Reading>
      )}

      <div id="out">
        {!board && <Reading>reading the board...</Reading>}

        {board && view === "leagues" && (
          leagues.length === 0
            ? (
              <div class="empty">
                Sleeper or ESPN, then your {asks.wants} above. Your leagues
                show up as cards, and you tap one to open it.
              </div>
            )
            : (
              <>
                {leagues.length > shown.length && (
                  <p class="hint">
                    Showing the team you picked.{" "}
                    <button onClick={() => setEveryTeam(true)}>
                      pick a different one
                    </button>
                  </p>
                )}
                {opening && (
                  <Reading>scoring the board for {opening}</Reading>
                )}
                <div class="cards">
                  {shown.map((lg) => (
                    <div
                      key={lg.leagueId + lg.userId}
                      class={"card league-card" +
                        (sameSeat(active, lg) ? " mine" : "")}
                      onClick={() => open(lg)}
                    >
                      <div class="nm">{lg.name}</div>
                      <div class="sub">
                        <span>{lg.size} teams</span>
                        <span>you: {lg.team}</span>
                      </div>
                      {/* which scoring, since picking the wrong league
                          of two is otherwise silent. What it pays a
                          catch is the same fact, so it is the chip's
                          tooltip rather than a second line. */}
                      <div class="sub">
                        <span
                          class="pays"
                          title={scoringSettings(lg.pays)}
                        >
                          {SCORING_NAME[roomFor(lg.pays)]}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )
        )}

        {board && active && view === "team" && season && (
          <>
            <Roster
              byKey={byKey}
              league={active}
              season={season}
              perTeam={perTeam}
              marked={marked}
              onMark={markKeeper}
              onMore={setShowing}
            />

            {active.keepers === undefined || active.keepers === null
              ? (
                <p class="hint">
                  <button
                    onClick={() => {
                      keep(keeperKey(active), !keeperLeague);
                      setMarks((n) => n + 1);
                    }}
                  >
                    {keeperLeague
                      ? "not a keeper league"
                      : "this is a keeper league"}
                  </button>
                </p>
              )
              : null}

            {keeperLeague && (
              <>
                <h2>keepers</h2>
                <p class="hint">{KEEPERS_SAY}</p>
                <Keepers
                  key={marks}
                  men={men}
                  byKey={byKey}
                  league={active}
                  perTeam={perTeam}
                  onMore={setShowing}
                  onChange={() => setMarks((n) => n + 1)}
                />
              </>
            )}
          </>
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
            onMore={setShowing}
          />
        )}

        {view === "matchup" && (
          <MyMatchup
            weeks={weeks}
            picked={week}
            onWeek={setWeek}
            slate={slate}
            roster={active ? rosterKeys(active.myRoster) : null}
            games={games}
            rows={slateRows}
            men={men}
            listed={listed}
            mine={active?.team ?? null}
            slots={active?.slots ?? null}
            pays={active?.pays ?? {}}
            status={gamesStatus || weekStatus}
          />
        )}

        {board && active && view === "league" && (
          <>
            <Standings league={active} />

            <h2>around the league</h2>
            {week
              ? (
                <Matchups
                  games={games}
                  rows={slateRows}
                  men={men}
                  mine={active.team}
                  slots={active.slots ?? null}
                  pays={active.pays ?? {}}
                  season={week.season}
                  week={week.week}
                  status={gamesStatus || weekStatus}
                  withoutMine
                />
              )
              : <p class="hint">No week has been built yet.</p>}

            <h2>draft grades</h2>
            <DraftRating
              board={men}
              byKey={byKey}
              league={active}
              made={draft.made ?? []}
            />
          </>
        )}

        {board && active && view === "players" && (
          <Waivers
              men={men}
              league={active}
              posFilter={posFilter}
              onPosFilter={setPosFilter}
              rows={slateRows}
              games={games}
              schedule={board.schedule ?? null}
              season={week?.season ?? null}
              week={week?.week ?? null}
            onMore={setShowing}
          />
        )}
      </div>

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
