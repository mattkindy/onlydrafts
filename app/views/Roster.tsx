/** Your team, by position, with what each man is projected to do. */

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import { SeasonCard, seasonScale } from "./Card.tsx";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF", "other"];

interface Props {
  byKey: Map<string, Player>;
  league: League;
  season: number;
  perTeam: number;
  marked: Record<string, string>;
  onMark: (p: Player) => void;
  onMore: (p: Player) => void;
}

export function Roster(props: Props) {
  const { league, marked } = props;
  const mine = league.myRoster
    .map((r) => ({ r, p: props.byKey.get(r.key) ?? null }))
    .sort((a, b) => (b.p?.vor ?? -99) - (a.p?.vor ?? -99));
  const kept = Object.keys(marked).filter((k) => marked[k] === league.team).length;
  const max = seasonScale(mine.map((x) => x.p).filter((p): p is Player => Boolean(p)));

  const byPosition = new Map<string, typeof mine>();

  for (const entry of mine) {
    const position = entry.p?.position ?? "other";
    byPosition.set(position, [...(byPosition.get(position) ?? []), entry]);
  }

  return (
    <>
      <div class="empty">
        <b>{mine.length} players</b> on {league.team} in {league.name}
        {kept
          ? `, ${kept} marked as keepers`
          : ", none marked as keepers yet"}
      </div>

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
                      <span>no club for {props.season}, so no projection</span>
                    </div>
                  </div>
                );
              }

              const isKept = Boolean(marked[p.key]);

              return (
                <SeasonCard
                  key={p.key}
                  p={p}
                  max={max}
                  teams={props.league.size || 12}
                  kept={isKept}
                  badge={isKept ? "keeper" : ""}
                  tag={isKept
                    ? `counts against your ${props.perTeam} keeper slots`
                    : ""}
                  onMore={() => props.onMore(p)}
                >
                  <button
                    class={"keepbtn" + (isKept ? " on" : "")}
                    onClick={(e) => { e.stopPropagation(); props.onMark(p); }}
                  >
                    {isKept ? "kept" : "mark keeper"}
                  </button>
                </SeasonCard>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
