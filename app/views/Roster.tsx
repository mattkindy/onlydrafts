/**
 * Your team, by position, read one of two ways. This week is what a
 * manager checks before setting a lineup: who plays whom, his line and
 * his range, and who is hurt or on bye. The season is what a trade or a
 * keeper turns on: what he scores a game, how many games he plays, where
 * he ranks at his position, and where the room drafted him. The two used
 * to share one card, which answered neither question cleanly.
 *
 * In a keeper league what he is worth keeping for opens on his own row
 * rather than in a second grid underneath. The two grids listed the same
 * twelve players, so every player on the page appeared twice.
 */

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import type { Listed } from "../lib/availability.ts";
import { hurtWord, type SlateRow } from "../lib/slate.ts";
import { injuryBadge } from "./Draft.tsx";
import { GoLink } from "./GoLink.tsx";
import { lineupLink, PROVIDER_NAME } from "../lib/deepLinks.ts";
import { KeeperRow, keeperDraft, keeperRounds } from "./Keepers.tsx";
import { asRound } from "../lib/picks.ts";
import { keep, stored } from "../lib/store.ts";
import { useState } from "preact/hooks";
import { Trade } from "./Trade.tsx";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF", "other"];

interface Props {
  byKey: Map<string, Player>;
  /** the whole board, which pricing a keeper against the draft needs */
  players: Player[];
  league: League;
  season: number;
  perTeam: number;
  marked: Record<string, string>;
  /** when the provider was last asked, for the line over the roster */
  readAt?: number | undefined;
  rereading?: boolean;
  onRefresh?: () => void;
  onMark: (p: Player) => void;
  onMore: (p: Player) => void;
  keeperLeague?: boolean;
  /** what keeping a player costs you, said once over the grid */
  keepersSay?: string;
  onKeeperChange?: () => void;
  /** who the injury report has listed, so a hurt player says so on his card */
  listed?: Map<string, Listed>;
  /** opens the league's settings, for a trade deadline nobody has said */
  onSettings?: () => void;
  /** the week coming up, so a player on bye in it is marked */
  week?: number | null;
  /** every player's line for that week, where it has loaded */
  rows?: Map<string, SlateRow>;
}

type Mode = "week" | "season" | "trade";

const MODES: [Mode, string][] = [["week", "this week"], ["season", "season"], ["trade", "trade"]];

export function Roster(props: Props) {
  const { league, marked, players } = props;
  const rowOf = (key: string) => props.rows?.get(key);
  const weekly = Boolean(props.rows?.size);
  // the season until a week has loaded, since a week with no lines in it
  // is a page of blanks; after that whichever way you last read it
  const [chosen, setChosen] = useState<Mode>(() => stored<Mode>("teamMode", "week"));
  const mode: Mode = !weekly && chosen === "week" ? "season" : chosen;
  const modes = MODES.filter(([which]) => weekly || which !== "week");
  const choose = (which: Mode) => {
    setChosen(which);
    keep("teamMode", which);
  };
  /**
   * Read for the week, each position is in the order you would start it;
   * read for the season, by what he is worth over it. The two part ways
   * for a player who is hurt or on bye, and that week is when it matters.
   */
  const mine = league.myRoster
    .map((r) => ({ r, p: props.byKey.get(r.key) ?? null }))
    .sort((a, b) => mode === "week"
      ? (rowOf(b.r.key)?.blend ?? -1) - (rowOf(a.r.key)?.blend ?? -1)
      : (b.p?.vor ?? -99) - (a.p?.vor ?? -99));
  const kept = Object.keys(marked).filter((k) => marked[k] === league.team).length;
  const teams = league.size || 12;
  const draft = props.keeperLeague
    ? keeperDraft(league, props.byKey, props.perTeam)
    : null;
  const rounds = draft ? keeperRounds(players, mine, draft) : new Map<string, number>();
  // where we have him at his position: RB12 says more in November than
  // the overall pick he would have gone at in August
  const positionRank = new Map<string, number>();

  for (const position of new Set(players.map((p) => p.position))) {
    players
      .filter((p) => p.position === position && p.rank)
      .sort((a, b) => a.rank! - b.rank!)
      .forEach((p, i) => positionRank.set(p.key, i + 1));
  }

  // the same word the matchup tab gives, so the two tabs never disagree
  // about who is out
  const hurtOf = (key: string) => hurtWord(props.listed?.get(key), rowOf(key));
  const hurt = mine.filter(({ r }) => hurtOf(r.key)).length;
  const onByeNow = (p: Player | null) =>
    Boolean(p && (rowOf(p.key)?.bye || (props.week && p.bye === props.week)));
  const resting = mine.filter(({ p }) => onByeNow(p)).length;

  const byPosition = new Map<string, typeof mine>();

  for (const entry of mine) {
    const position = entry.p?.position ?? "other";
    byPosition.set(position, [...(byPosition.get(position) ?? []), entry]);
  }

  const head = mode === "week"
    ? <><i class="c-proj">proj</i><i class="c-range">range</i></>
    : (
      <>
        <i class="c-ppg">pts/g</i>
        <i class="c-games" title="games he is projected to play">games</i>
        <i class="c-rank" title="where we rank him at his position">rank</i>
        <i class="c-adp" title="average draft position, as round and pick">adp</i>
      </>
    );

  return (
    <>
      <div class="rosterhead">
        <b>{league.team}</b>
        <span>{props.readAt === undefined ? "" : rosterRead(props.readAt)}</span>
        {props.onRefresh && (
          <button
            class="quiet"
            disabled={props.rereading}
            onClick={props.onRefresh}
          >
            {props.rereading ? "refreshing..." : "refresh"}
          </button>
        )}
      </div>

      <div class="rostermode">
        {(
          <span class="seg" role="tablist">
            {modes.map(([which, said]) => (
              <button
                key={which}
                role="tab"
                aria-selected={mode === which}
                class={mode === which ? "on" : ""}
                onClick={() => choose(which)}
              >
                {said}
              </button>
            ))}
          </span>
        )}
        <GoLink href={lineupLink(league)}>
          open in {PROVIDER_NAME[league.provider]}
        </GoLink>
      </div>

      {mode === "trade" && (
        <Trade
          league={league} players={players} coming={props.week ?? 1}
          listed={props.listed ?? new Map()} {...(props.onSettings ? { onSettings: props.onSettings } : {})}
          keeperLeague={Boolean(props.keeperLeague)} perTeam={props.perTeam}
        />
      )}

      {mode !== "trade" && (<>
      {/* the roster in one line: how many, and how many of them are a
          problem this week, which is what a reader opens the tab to check */}
      <div class="tally">
        <span><b>{mine.length}</b> players</span>
        {hurt > 0 && (
          <span class="bad"><b>{hurt}</b> on the injury report</span>
        )}
        {resting > 0 && (
          <span class="warn"><b>{resting}</b> on bye in week {props.week}</span>
        )}
        {props.keeperLeague && (
          <span>
            {kept ? <><b>{kept}</b> marked as keepers</> : "no keepers marked yet"}
          </span>
        )}
      </div>

      {props.keeperLeague && props.keepersSay && mode === "season" && (
        <p class="hint">{props.keepersSay}</p>
      )}

      <div class={"tlist " + mode}>
        <div class="trow tcols" aria-hidden="true">
          <i class="c-name" />
          {head}
        </div>
        {POSITIONS.filter((where) => byPosition.has(where)).map((where) => (
          <section class="tgroup" key={where}>
            <h3>{where}</h3>
            {byPosition.get(where)!.map(({ r, p }) => {
              if (!p) {
                return (
                  <div class="trow" key={r.key}>
                    <span class="tname"><span class="who">{r.name}</span></span>
                    {/* he is on last season's roster and nobody has
                        signed him for this one */}
                    <span class="tmeta">no NFL team in {props.season}</span>
                  </div>
                );
              }

              const row = rowOf(p.key);
              const isKept = Boolean(marked[p.key]);
              const bye = onByeNow(p);
              const his = hurtOf(p.key);
              const badge = injuryBadge(his);
              const part = his?.part;
              const meta = [
                `${p.position} · ${p.team ?? "FA"}`,
                mode === "week" && row && !row.bye ? `${row.home ? "v" : "@"} ${row.opponent}` : "",
                mode === "week" && bye ? "bye" : "",
                part ? part.toLowerCase() : "",
              ].filter(Boolean).join(" · ");

              return (
                <div class={"trow" + (isKept ? " kept" : "")} key={p.key}>
                  <span class="tname">
                    <button
                      class="who link"
                      onClick={(e) => { e.stopPropagation(); props.onMore(p); }}
                    >
                      {p.name}
                    </button>
                    {badge && (
                      <span class={"badge " + badge.badgeHow} title={badge.badgeTitle}>
                        {badge.badge}
                      </span>
                    )}
                    {isKept && <span class="badge">keeper</span>}
                  </span>
                  <span class="tmeta">{meta}</span>
                  {mode === "week"
                    ? (
                      <>
                        <b class="c-proj">{!row || row.bye ? "–" : row.blend.toFixed(1)}</b>
                        <span class="c-range">
                          {row && !row.bye && row.ceiling > 0
                            ? `${row.floor.toFixed(1)}–${row.ceiling.toFixed(1)}`
                            : ""}
                        </span>
                      </>
                    )
                    : (
                      <>
                        <b class="c-ppg">{(p.game?.["ev"] ?? p.ppg ?? 0).toFixed(1)}</b>
                        <span class="c-games">{p.games !== undefined ? p.games.toFixed(1) : "–"}</span>
                        <span class="c-rank">
                          {positionRank.has(p.key) ? `${p.position}${positionRank.get(p.key)}` : "–"}
                        </span>
                        <span class="c-adp">{p.adpRank ? asRound(p.adpRank, teams) : "–"}</span>
                      </>
                    )}
                  {draft && mode === "season" && (
                    <div class="tkeep">
                      <KeeperRow
                        players={players}
                        p={p}
                        league={league}
                        perTeam={props.perTeam}
                        round={rounds.get(p.key) ?? null}
                        kept={isKept}
                        onMark={() => props.onMark(p)}
                        onChange={props.onKeeperChange ?? (() => {})}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      </>)}
    </>
  );
}

/** how fresh the roster is, in the words somebody checking would use */
export function rosterRead(readAt: number): string {
  if (!readAt) {
    return "roster updated, time unknown";
  }

  const mins = Math.floor((Date.now() - readAt) / 60000);

  if (mins < 1) {
    return "roster updated a moment ago";
  }

  if (mins < 60) {
    return `roster updated ${mins} min ago`;
  }

  return "roster updated at " + new Date(readAt)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
