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
  NeedsEspnCookies, listedPlayers, listedPlayersWith, PROVIDERS, sleeperPlayers,
  type League, type Matchup, type SleeperPlayers,
} from "./lib/providers.ts";
import type { Listed } from "./lib/availability.ts";
import { markedKeepers, saveMarkedKeepers } from "./lib/keepers.ts";
import { draftNow } from "./lib/draftWatch.ts";
import type { Player } from "./lib/scoring.ts";

import { PlayerSheet } from "./views/PlayerSheet.tsx";
import { Reading, Skeleton } from "./views/Reading.tsx";
import { EspnSheet } from "./views/EspnSheet.tsx";
import { Roster } from "./views/Roster.tsx";
import { DraftRating, MyDraftPicks } from "./views/DraftRating.tsx";
import { DraftView, type DraftNow } from "./views/Draft.tsx";
import { MyMatchup } from "./views/Matchup.tsx";
import { Matchups } from "./views/Matchups.tsx";
import { Standings, standingSays } from "./views/Standings.tsx";
import { Waivers } from "./views/Waivers.tsx";
import { LeagueWeek } from "./views/LeagueWeek.tsx";
import { useWeekPoll } from "./views/scoreboard.ts";
import {
  listedOnSlate, loadSlate, onTheBooks, rosterKeys, slateUnder, weekRefs,
  weekRowsOf,
  type Slate, type WeekRef,
} from "./lib/slate.ts";
import { gameStates, type GameState } from "./lib/matchups.ts";
import { readRecapWeek, weekBefore } from "./lib/recapWeek.ts";

export type Order = "war" | "rank" | "adp";

/**
 * What each ordering means, said once you have chosen it. The three
 * answer different questions and the same player moves a long way between
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
    "",
    "Win % is your chance of beating this week's opponent. Bench players show up only when starting them would raise it.",
  ],
  league: [
    "League",
    "",
    "Draft grades compare what each team got to what its picks were worth.",
  ],
  players: [
    "Players",
    "",
    "This week: what each add does to your win % in this week's game. Rest of season: the same over a full season of simulated weeks.",
  ],
  team: [
    "My team",
    "",
    "Tap a player for his season outlook. In keeper leagues, tap keep to price him.",
  ],
  draft: [
    "Draft",
    "",
    "Follows your league's draft live. Ranked by how much each player adds to your roster as it stands.",
  ],
};

/**
 * What each tab is called in the tab bar, which on a phone is five
 * buttons across 390px under an icon each, so "my" goes.
 */
const TAB_SAYS: Record<View, string> = {
  leagues: "leagues", matchup: "matchup", league: "league",
  players: "players", team: "team", draft: "draft",
};

/** one stroke drawing per tab, in the icon's 24 unit box */
const TAB_ICON: Record<View, string> = {
  leagues: "M4 6h16M4 12h16M4 18h16",
  // a scoreboard: two sides and the line between them
  matchup: "M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM12 5v14M7 10v4M17 10v4",
  // a cup
  league: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H5.5a2.5 2.5 0 0 0 2.6 3.6M16 6h2.5a2.5 2.5 0 0 1-2.6 3.6M12 13v4M8.5 20h7M10 17h4",
  // somebody to add
  players: "M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6",
  // a clipboard
  team: "M7 5H5.5A1.5 1.5 0 0 0 4 6.5v13A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 18.5 5H17M9 3h6v4H9zM8 12h8M8 16h5",
  // the board
  draft: "M4 4h16v16H4zM4 9.5h16M4 15h16M9.5 4v16M15 4v16",
};

function TabIcon({ view }: { view: View }) {
  return (
    <svg class="ticon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d={TAB_ICON[view]} fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round"
      />
    </svg>
  );
}

/** light, dark and the phone's own, drawn rather than left to a font */
const THEME_ICON: Record<"system" | "light" | "dark", string> = {
  system: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z",
  light: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  dark: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
};

/** what the keeper section is called, since it has its own heading */
const KEEPERS_SAY = "Enter what each keeper costs. Green means keep.";

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

/** before the scoreboard has answered, every game is still to kick off */
const NO_STATES = new Map<string, GameState>();

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
const sameSlot = (a: League | null, b: League | null) =>
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
const slotKey = (lg: League) => "slot." + lg.provider + "." + lg.leagueId;

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

/**
 * The views that read the week's lines without pricing a game, so they
 * load the slate but leave the scoreboard alone.
 */
const SLATE_VIEWS: View[] = [...WEEK_VIEWS, "team", "leagues"];

/** how old a read can be before one of those views asks the provider again */
const STALE_AFTER = 2 * 60 * 1000;

/**
 * Work that freezes the page until it is done, held back a frame so the
 * tab you tapped paints first.
 *
 * The draft grades replay twelve rosters over six thousand drawn weeks,
 * which is a second or so of a blocked main thread. Tapping league used to
 * do nothing at all until that finished, so the tap read as dropped.
 */
function AfterPaint(
  { saying, children }: { saying: string; children: ComponentChildren },
) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const soon = requestAnimationFrame(() => setReady(true));

    return () => cancelAnimationFrame(soon);
  }, []);

  if (!ready) {
    return <Reading>{saying}</Reading>;
  }

  return <>{children}</>;
}

function App() {
  const [season, setSeason] = useState<number | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [leagues, setLeagues] = useState<League[]>(() => stored<League[]>("leagues", []));
  const [active, setActive] = useState<League | null>(() => stored<League | null>("active", null));
  // a reload lands back on the tab you were on, in the league you had open
  const [view, setView] = useState<View>(() =>
    stored<League | null>("active", null) ? stored<View>("view", "leagues") : "leagues");
  const [who, setWho] = useState(() => stored("username", ""));
  const [provider, setProvider] = useState(() => stored("provider", "sleeper"));
  const [perTeamSaid, setPerTeam] = useState(() => stored("keepn", 3));
  const perTeam = active?.keepersPerTeam ?? perTeamSaid;
  const [posFilter, setPosFilter] = useState("ALL");
  /**
   * The players tab filters on its own. It shared the draft board's,
   * so a hole filled from the matchup tab left the draft board showing
   * quarterbacks only the next time it opened.
   */
  const [playersPos, setPlayersPos] = useState("ALL");
  const [theme, setTheme] = useState<Theme>(() => stored<Theme>("theme", "system"));
  const [query, setQuery] = useState("");
  /** whether the longer answer behind the tab row's question mark is open */
  const [asking, setAsking] = useState(false);
  /** and whether your own draft is being replayed under your roster */
  const [myDraft, setMyDraft] = useState(false);
  const [everyTeam, setEveryTeam] = useState(false);
  /** whether the league tab's draft grades are open; shut until asked */
  const [gradesAsked, setGrades] = useState<boolean | null>(null);
  // the weeks he wins you leads, because ordering that way beat ordering
  // by value over replacement in 26 of 36 slots across three seasons
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
  // one poll for the whole page: each scoreboard read moves `tick`, and
  // the league's points are read again on it, so the two never drift apart
  // the league list prices each league's game too, once there are leagues
  const openWeek = week &&
    (WEEK_VIEWS.includes(view) || (view === "leagues" && leagues.length > 0))
    ? week : null;
  const scoreboard = useWeekPoll(
    openWeek?.season, openWeek?.week, active?.provider);
  const gamesKey = useRef("");
  const [rereading, setRereading] = useState(false);
  /** who the injury report has listed, for the week's pages as well as the draft */
  const [allListed, setAllListed] = useState<Map<string, Listed>>(() => new Map());
  /** the player file that list came from, so the same file is not listed twice */
  const listedFrom = useRef<SleeperPlayers | null>(null);
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

    // the browser's own bars follow the page rather than the phone, once
    // somebody has picked one
    const bars: Record<Theme, [string, string]> = {
      system: ["#EFF1F4", "#10141C"], light: ["#EFF1F4", "#EFF1F4"],
      dark: ["#10141C", "#10141C"],
    };

    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta, at) => { meta.content = bars[theme][at] ?? meta.content; });
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
      .catch((e: Error) => setStatus("could not load the board: " + e.message));
  }, []);

  /**
   * The injury report's list, asked for again each time the league's games
   * are. Sleeper's file is kept for as long as it is good, so most asks cost
   * nothing, and a newer file is what brings a Sunday ruling in. A read that
   * fails keeps the list it had.
   */
  useEffect(() => {
    let stale = false;

    sleeperPlayers()
      .then((all) => {
        if (!stale && all !== listedFrom.current) {
          listedFrom.current = all;
          setAllListed(listedPlayers(all));
        }
      })
      .catch(() => undefined);

    return () => { stale = true; };
  }, [scoreboard.tick]);

  /** the week itself is only fetched once you ask for a tab that reads one */
  useEffect(() => {
    if (!SLATE_VIEWS.includes(view) || !week) {
      return;
    }

    let stale = false;

    setSlate(null);
    setWeekStatus("");
    loadSlate(week.file)
      .then((got) => { if (!stale) { setSlate(got); } })
      .catch((e: Error) => {
        if (!stale) {
          setWeekStatus("could not load week " + week.week + ": " + e.message);
        }
      });

    return () => { stale = true; };
  }, [view, week]);

  /**
   * The league's own games, which only the provider knows. The same read
   * brings each player's stats, so his points and his line never come
   * from two different moments. It is read again on every scoreboard
   * read, so the points and the game clock come from the same minute.
   */
  useEffect(() => {
    if (!active || !openWeek) {
      return;
    }

    const asks = PROVIDERS[active.provider]!.matchupsFor;

    if (!asks) {
      setGamesStatus(active.provider + " does not share this week's games.");

      return;
    }

    let stale = false;

    // a re-read of the same week keeps the cards up rather than blanking them
    const key = [active.provider, active.leagueId, active.userId, openWeek.week]
      .join("/");

    if (gamesKey.current !== key) {
      gamesKey.current = key;
      setGames([]);
      setGamesStatus("");
    }

    asks(active, openWeek.week)
      .then((got) => {
        if (stale) {
          return;
        }

        setGames(got);
        // an empty answer looks the same as one still loading, and the
        // two want different things from whoever is reading it
        setGamesStatus(got.length === 0
          ? `${active.provider} has no week ${openWeek.week} games for this ` +
            "league yet. If your league has them, tell me and I will look."
          : "");
      })
      .catch((e: Error) => {
        if (!stale) {
          setGamesStatus("could not load this week's games: " + e.message);
        }
      });

    return () => { stale = true; };
  }, [openWeek, active, scoreboard.tick]);

  /**
   * The week in this league's scoring. The build scored it once, and
   * a league that pays a catch differently moves every player by his
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
   * Every player's week, for the free agents the week in review picks out.
   * A provider that will not say leaves the section out altogether.
   */
  const weekPointsFor = useMemo(() => {
    const asks = active && PROVIDERS[active.provider]?.weekPointsFor;

    if (!active || !asks || !week) {
      return undefined;
    }

    return () => asks(active, week.week);
  }, [active, week]);

  /**
   * Sleeper covers every player in the game, and an ESPN league adds only
   * what its own rosters say about players Sleeper had nothing on.
   */
  const listed = useMemo(
    () => active ? listedPlayersWith(
      allListed, [active.myRoster, ...active.allRosters.map((r) => r.keys)],
    ) : allListed,
    [allListed, active],
  );

  /**
   * The week's projections, under the same key a lineup uses for a player,
   * with a zero where the injury report says he is not playing. Every page that
   * prices a week reads this map, so the ruling is applied once here
   * rather than in each of them.
   */
  const books = useMemo(
    () => onTheBooks(
      board?.players ?? [],
      active ? [active.myRoster, ...active.allRosters.map((r) => r.keys)] : [],
    ),
    [board, active],
  );

  // today's injury list is about the coming week; a week already played
  // keeps the lines it had, or a player hurt since reads as a zero then
  const comingWeek = weeks.length > 0 && week?.week === weeks[weeks.length - 1]!.week;
  const slateRows = useMemo(
    () => weekRowsOf(slate, books, board?.schedule, comingWeek ? listed : undefined),
    [slate, books, board, listed, comingWeek],
  );

  /**
   * What the waiver page prices injuries by. Sleeper's file, read here, is
   * the newer word; until it arrives, or when it cannot be read, the
   * build's reading of the same statuses stands in, so a man on reserve
   * is not priced as healthy because a fetch failed.
   */
  const reported = useMemo(() => {
    if (allListed.size > 0 || !comingWeek || !slate) {
      return listed;
    }

    return new Map([...listedOnSlate(slate), ...listed]);
  }, [allListed, listed, comingWeek, slate]);

  /**
   * The week before the one on screen, read in full for the league tab's
   * recap while the week on screen has no finished games yet. Today's
   * injury list is left off its rows, since it is about the coming week.
   */
  const lastWeek = useMemo(() => {
    const before = week && weekBefore(weeks, week);
    const asks = active && PROVIDERS[active.provider];

    if (!before || !active || !asks?.matchupsFor) {
      return undefined;
    }

    const matchupsFor = asks.matchupsFor;
    const pointsFor = asks.weekPointsFor;

    return () => readRecapWeek(before, {
      matchupsFor: (at) => matchupsFor(active, at),
      readGames: (season, at) => gameStates(season, at, active.provider),
      loadSlate: async (file) => {
        const got = await loadSlate(file);

        return active.pays ? slateUnder(got, active.pays["rec"] ?? 0) : got;
      },
      rowsOf: (got) => weekRowsOf(got, books, board?.schedule),
      weekPointsFor: pointsFor && ((at) => pointsFor(active, at)),
    });
  }, [week, weeks, active, books, board]);

  /**
   * The board in this league's terms. Nothing here needs the model to
   * have been run for the league, since what each player does in a game
   * travels with the board and the scoring is applied on the way in.
   */
  const players = useMemo(() => {
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

  const byKey = useMemo(() => new Map(players.map((p) => [p.key, p])), [players]);
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
          hurt: Object.fromEntries(listedPlayers(all)),
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
      const again = found.find((lg) => sameSlot(lg, active));

      if (again) {
        setActive(again);
        keep("active", again);
      }

      setStatus(found.length ? "" : "no leagues found for that name");
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
   * snapshot taken when you looked it up, so a player added off waivers is
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
    const again = found?.find((lg) => sameSlot(lg, active));

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
    const picked = stored(slotKey(lg), "");

    return !picked || picked === lg.userId;
  }), [leagues, everyTeam, active]);

  /**
   * Opening a league rescores the whole board and draws every player's
   * weeks before the draft view can paint, which freezes the page for a
   * second or two. The loader is painted first, and the work starts on
   * the frame after.
   */
  const open = (lg: League) => {
    setOpening(lg.team);
    setTimeout(() => {
      setActive(lg);
      keep("active", lg);
      keep(slotKey(lg), lg.userId);
      setEveryTeam(false);
      // once weeks are being played the draft is over, so a league opens
      // on your matchup rather than on pricing the whole board
      setView(weeks.length ? "matchup" : "draft");
      setOpening(null);
    }, 50);
  };

  /**
   * A player's sheet, opened off his key. The lineup views only ever have a
   * key, and every name on the page opens the same sheet, so the lookup
   * belongs here rather than in each of them.
   */
  const openKey = (key: string) => {
    const p = byKey.get(key);

    if (p) {
      setShowing(p);
    }
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

  // the answer belongs to the tab it was opened on, so moving off it
  // closes it rather than carrying it over to a page it does not explain
  useEffect(() => setAsking(false), [view]);

  useEffect(() => keep("view", view), [view]);

  /**
   * A new tab starts at its top. The league tab runs to several screens,
   * and leaving it from the bottom used to open the next tab halfway down
   * a page that was not that long, or past the end of one that was.
   */
  const firstView = useRef(true);

  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;

      return;
    }

    window.scrollTo(0, 0);
  }, [view]);

  /** a hole in your lineup, taken to the free agents who could fill it */
  const findAt = (position: string) => {
    setPlayersPos(position);
    setView("players");
  };

  /**
   * Whether this league keeps players. Sleeper and ESPN both say, but
   * an older saved league does not, and then the reader is asked once
   * and it is remembered.
   */
  const keeperLeague = active
    ? active.keepers ?? stored(keeperKey(active), false)
    : false;

  const grades = gradesAsked ?? weeks.length <= 1;
  const [title, blurb, legend] = COPY[view];
  const asks = PROVIDERS[provider]!;

  return (
    <div class="wrap">
      <nav>
        <span class="brand" onClick={() => setView("leagues")}>
          only<b>drafts</b>
        </span>
        <button
          class="theme"
          aria-label={"theme: " + theme}
          title="light, dark, or whatever your phone is set to"
          onClick={() => setTheme(NEXT_THEME[theme])}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d={THEME_ICON[theme]} stroke="currentColor" stroke-width="1.7"
              stroke-linecap="round" stroke-linejoin="round" fill="none"
            />
            {/* the phone's own setting is half of each */}
            {theme === "system" && (
              <path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" />
            )}
          </svg>
        </button>
      </nav>

      {active && view !== "leagues" && (
        <div id="crumb">
          <button
            class="back"
            aria-label="all leagues"
            onClick={() => setView("leagues")}
          >
            ‹
          </button>
          <b>{active.name}</b>
          {/* what the numbers are scored by, since standard and a board
              with no league connected look the same on screen */}
          <span class="pays" title={scoringSettings(active.pays)}>
            {SCORING_NAME[roomFor(active.pays)]}
          </span>
          {legend && (
            <button
              class={"whatis" + (asking ? " on" : "")}
              aria-label="how this works"
              aria-expanded={asking}
              onClick={() => setAsking((on) => !on)}
            >
              ?
            </button>
          )}
        </div>
      )}

      {/* the tabs: along the top on a wide screen, and on a phone a bar
          along the bottom, where a thumb already is and where it stays
          put however far down a page you have scrolled */}
      {view !== "leagues" && (
        <div id="subnav" role="navigation" aria-label="sections">
          {tabs.map((v) => (
            <button
              key={v}
              class={v === view ? "on" : ""}
              aria-current={v === view ? "page" : undefined}
              onClick={() => setView(v)}
            >
              <TabIcon view={v} />
              <span>{TAB_SAYS[v]}</span>
            </button>
          ))}
        </div>
      )}

      <div id="explain">
        {view === "leagues" && <h1>{title}</h1>}
        {blurb && <p>{blurb}</p>}
        {legend && asking && <p class="legend">{legend}</p>}
      </div>

      {/* every other view leaves this bar with nothing in it, and an
          empty one still draws as a white strip across the page */}
      <div
        class="controls"
        hidden={!["leagues", "draft"].includes(view)}
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

        {view === "draft" && keeperLeague && !active?.keepersPerTeam && (
          <label>
            keepers per team{" "}
            <input
              type="number" min="0" max="6" style={{ width: "3.2rem" }}
              value={perTeamSaid}
              onInput={(e) => {
                setPerTeam(Number(e.currentTarget.value));
                keep("keepn", Number(e.currentTarget.value));
              }}
            />
          </label>
        )}

        {view === "draft" && (
          <>
            <span class="chips">
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
            {/* the filter is its own thing: it hides players you cannot start
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
        <Reading>updating your roster...</Reading>
      )}

      <div id="out">
        {!board && <Skeleton saying="loading the board" lead={view !== "leagues"} />}

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
                  <Reading>scoring players for {opening}</Reading>
                )}
                <div class="cards">
                  {shown.map((lg) => (
                    <div
                      key={lg.leagueId + lg.userId}
                      class={"card league-card" +
                        (sameSlot(active, lg) ? " mine" : "")}
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
                          tooltip rather than a second line. Beside it,
                          where you sit, which is what you would open the
                          league to find out first. */}
                      <div class="sub standing">
                        <b>{standingSays(lg.allRosters ?? [], lg.team)}</b>
                        <span
                          class="pays"
                          title={scoringSettings(lg.pays)}
                        >
                          {SCORING_NAME[roomFor(lg.pays)]}
                        </span>
                      </div>
                      {built && comingWeek && board && (
                        <LeagueWeek
                          league={lg}
                          slate={built}
                          board={board.players}
                          boardPerCatch={board.perCatch}
                          schedule={board.schedule}
                          listed={allListed}
                          states={scoreboard.states ?? NO_STATES}
                          tick={scoreboard.tick}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </>
            )
        )}

        {board && active && view === "team" && season && (
          <>
            <Roster
              key={marks}
              byKey={byKey}
              players={players}
              league={active}
              season={season}
              perTeam={perTeam}
              marked={marked}
              readAt={active.readAt}
              rereading={rereading}
              onRefresh={() => void reread(true)}
              onMark={markKeeper}
              onMore={setShowing}
              keeperLeague={keeperLeague}
              keepersSay={KEEPERS_SAY}
              onKeeperChange={() => setMarks((n) => n + 1)}
              listed={listed}
              week={weeks.length ? weeks[weeks.length - 1]!.week : null}
              // the roster is this week's roster, so it only takes the
              // lines of the week coming up, whatever week the matchup
              // tab was last left on
              rows={comingWeek ? slateRows : undefined}
            />

            {active.keepers === undefined || active.keepers === null
              ? (
                <p class="hint">
                  <button
                    class="quiet"
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

            {/* closed until asked, since replaying the draft is a second
                of work nobody wants on the way to a roster */}
            <button
              class="fold"
              aria-expanded={myDraft}
              onClick={() => setMyDraft((on) => !on)}
            >
              <h2>your draft, pick by pick</h2>
              <svg
                class={"chev" + (myDraft ? " open" : "")}
                viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
              >
                <path
                  d="M4 6l4 4 4-4" fill="none" stroke="currentColor"
                  stroke-width="1.8" stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            {myDraft && (
              <AfterPaint saying="replaying your draft">
                <MyDraftPicks
                  board={players}
                  byKey={byKey}
                  league={active}
                  made={draft.made ?? []}
                />
              </AfterPaint>
            )}
          </>
        )}

        {board && view === "draft" && (
          <DraftView
            players={players}
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
            games={games}
            rows={slateRows}
            players={players}
            listed={listed}
            mine={active?.team ?? null}
            mineId={active?.userId ?? null}
            slots={active?.slots ?? null}
            league={active?.name}
            pays={active?.pays ?? {}}
            boardPerCatch={board?.perCatch}
            provider={active?.provider}
            scoreboard={scoreboard}
            status={gamesStatus || weekStatus}
            onMore={openKey}
            teams={active?.allRosters ?? []}
            onFind={findAt}
            leagueOf={active}
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
                  players={players}
                  mine={active.team}
                  slots={active.slots ?? null}
                  pays={active.pays ?? {}}
                  boardPerCatch={board.perCatch}
                  provider={active.provider}
                  scoreboard={scoreboard}
                  season={week.season}
                  week={week.week}
                  league={active.name}
                  status={gamesStatus || weekStatus}
                  rosters={active.allRosters}
                  weekPointsFor={weekPointsFor}
                  lastWeek={lastWeek}
                  picker={{ weeks, picked: week, onWeek: setWeek }}
                  onMore={openKey}
                />
              )
              : <p class="hint">No week has been built yet.</p>}

            {/* open while the draft is fresh, and behind a tap once weeks
                are being played: grading every draft is a second of work
                that used to land on every visit to this tab */}
            <button
              class="fold"
              aria-expanded={grades}
              onClick={() => setGrades((on) => !on)}
            >
              <h2>draft grades</h2>
              <svg
                class={"chev" + (grades ? " open" : "")}
                viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
              >
                <path
                  d="M4 6l4 4 4-4" fill="none" stroke="currentColor"
                  stroke-width="1.8" stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            {grades && (
              <AfterPaint saying="grading every team's draft">
                <DraftRating
                  board={players}
                  byKey={byKey}
                  league={active}
                  made={draft.made ?? []}
                />
              </AfterPaint>
            )}
          </>
        )}

        {board && active && view === "players" && (
          <Waivers
            players={players}
            league={active}
            posFilter={playersPos}
            onPosFilter={setPlayersPos}
            rows={slateRows}
            games={games}
            schedule={board.schedule ?? null}
            season={week?.season ?? null}
            week={week?.week ?? null}
            slate={slate}
            boardPerCatch={board.perCatch}
            scoreboard={scoreboard}
            roster={rosterKeys(active.myRoster)}
            listed={reported}
            gamesStatus={gamesStatus}
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
          pays={active?.pays ?? {}}
          boardPerCatch={board?.perCatch}
          thisWeek={slate
            ? { week: slate.week, row: slateRows.get(showing.key) }
            : undefined}
          onClose={() => setShowing(null)}
        />
      )}

      {espnHelp && (
        <EspnSheet
          onClose={() => setEspnHelp(false)}
          onKept={() => {
            setEspnHelp(false);
            setStatus("Saved. Try the league again.");
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
        <h1>Something went wrong</h1>
        <div class="empty">
          <b>{this.state.blew.message}</b>
          <br />
          Your browser may have saved data from an older version of this
          page. Clearing it and finding your leagues again usually fixes
          this.
          <div class="row">
            <button
              class="act"
              onClick={() => {
                localStorage.clear();
                location.reload();
              }}
            >
              clear saved data and start over
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
