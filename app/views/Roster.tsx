/**
 * Your team, by position, with what each player is projected to do.
 *
 * In a keeper league what he is worth keeping for opens on his own card
 * rather than in a second grid underneath. The two grids listed the same
 * twelve players, so every player on the page appeared twice.
 */

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import type { Listed } from "../lib/availability.ts";
import { hurtWord, type SlateRow } from "../lib/slate.ts";
import { injuryBadge, WORRYING } from "./Draft.tsx";
import { SeasonCard, seasonScale } from "./Card.tsx";
import { KeeperRow, keeperDraft, keeperRounds } from "./Keepers.tsx";

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
  /** the week coming up, so a player on bye in it is marked */
  week?: number | null;
  /** every player's line for that week, where it has loaded */
  rows?: Map<string, SlateRow>;
}

export function Roster(props: Props) {
  const { league, marked, players } = props;
  const rowOf = (key: string) => props.rows?.get(key);
  /**
   * Once a week has loaded, each position reads in the order you would
   * start it this week; before then, by what he is worth over the
   * season. The two part ways for a player who is hurt or on bye, and
   * that week is when the order matters.
   */
  const weekly = Boolean(props.rows?.size);
  const mine = league.myRoster
    .map((r) => ({ r, p: props.byKey.get(r.key) ?? null }))
    .sort((a, b) => weekly
      ? (rowOf(b.r.key)?.blend ?? -1) - (rowOf(a.r.key)?.blend ?? -1)
      : (b.p?.vor ?? -99) - (a.p?.vor ?? -99));
  const kept = Object.keys(marked).filter((k) => marked[k] === league.team).length;
  const max = seasonScale(mine.map((x) => x.p).filter((p): p is Player => Boolean(p)));
  const draft = props.keeperLeague
    ? keeperDraft(league, props.byKey, props.perTeam)
    : null;
  const rounds = draft ? keeperRounds(players, mine, draft) : new Map<string, number>();

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

      {props.keeperLeague && props.keepersSay && (
        <p class="hint">{props.keepersSay}</p>
      )}

      {POSITIONS.filter((where) => byPosition.has(where)).map((where) => (
        <div key={where}>
          <h2>{where}</h2>
          <div class="cards">
            {byPosition.get(where)!.map(({ r, p }) => {
              if (!p) {
                return (
                  <div class="card plain" key={r.key}>
                    <div class="nm"><span class="who">{r.name}</span></div>
                    <div class="sub">
                      {/* he is on last season's roster and nobody has
                          signed him for this one */}
                      <span>no NFL team in {props.season}, so no projection</span>
                    </div>
                  </div>
                );
              }

              const isKept = Boolean(marked[p.key]);
              const row = rowOf(p.key);

              return (
                <SeasonCard
                  key={p.key}
                  p={p}
                  max={max}
                  slim
                  teams={props.league.size || 12}
                  kept={isKept}
                  badge={isKept ? "keeper" : ""}
                  onMore={() => props.onMore(p)}
                  {...(row && !row.bye
                    ? { thisWeek: { label: "proj", value: row.blend.toFixed(1) } }
                    : {})}
                >
                  {row && !row.bye && (
                    <div class="weekline">
                      <span>week {props.week}</span>
                      <span>{row.home ? "v" : "@"} {row.opponent}</span>
                      {/* a range from nothing to nothing says less than
                          the badge under it already does */}
                      {row.ceiling > 0 && (
                        <span>{row.floor.toFixed(1)} to {row.ceiling.toFixed(1)}</span>
                      )}
                    </div>
                  )}
                  <Status his={hurtOf(p.key)} bye={onByeNow(p) ? props.week! : null} />
                  {draft && (
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
                  )}
                </SeasonCard>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/** what is wrong with him this week, if anything, on one line of his card */
function Status(
  { his, bye }: {
    his: { status: string; part?: string; note?: string } | undefined;
    bye: number | null;
  },
) {
  const badge = injuryBadge(his);

  if (!badge && bye === null) {
    return null;
  }

  return (
    <div class="status">
      {badge && (
        <span class={"badge " + badge.badgeHow} title={badge.badgeTitle}>
          {badge.badge}
        </span>
      )}
      {his?.part && <span>{his.part.toLowerCase()}</span>}
      {his && WORRYING.has(his.status) && his.note && (
        <span class="note">{his.note}</span>
      )}
      {bye !== null && <span class="badge even">bye week {bye}</span>}
    </div>
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
