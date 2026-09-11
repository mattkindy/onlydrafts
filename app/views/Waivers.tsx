/**
 * Who to add and who to drop, both in points of win chance.
 *
 * Adds are everybody no team in the league has, priced by what putting
 * him on your roster does to how often you win a week. Drops are your
 * own men, priced by what taking him off costs. The two are the same
 * number in opposite directions, so a pickup is worth making when the
 * best add beats the cheapest drop.
 */

import { useMemo } from "preact/hooks";

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import { roomFor } from "../lib/draftShare.ts";
import { addsFor, dropsFor, type Add, type Drop } from "../lib/waivers.ts";
import { matchesFilter } from "./Draft.tsx";

/**
 * Fewer draws than the draft board takes, because the wire is the whole
 * board and every add is one subtraction a week against one baseline.
 */
const WEEKS_DRAWN = 2000;

interface Props {
  men: Player[];
  league: League;
  posFilter: string;
  onMore: (p: Player) => void;
}

function signed(share: number, places = 1): string {
  const text = (100 * share).toFixed(places);

  return share > 0 ? `+${text}` : text;
}

function pct(share: number): string {
  return `${(100 * share).toFixed(0)}%`;
}

function AddRow({ row, onMore }: { row: Add; onMore: () => void }) {
  return (
    <tr onClick={onMore}>
      <td>{row.p.name}</td>
      <td>{row.p.position}</td>
      <td>{row.p.team ?? ""}</td>
      <td>{(row.p.ppg ?? 0).toFixed(1)}</td>
      <td>{pct(row.starts)}</td>
      <td><b>{signed(row.added)}</b></td>
    </tr>
  );
}

function DropRow({ row, onMore }: { row: Drop; onMore: () => void }) {
  return (
    <tr onClick={onMore}>
      <td>{row.p.name}</td>
      <td>{row.p.position}</td>
      <td>{(row.p.ppg ?? 0).toFixed(1)}</td>
      <td>{pct(row.starts)}</td>
      <td><b>{signed(row.costs)}</b></td>
    </tr>
  );
}

export function Waivers(props: Props) {
  const { men, league, posFilter } = props;

  const { adds, drops } = useMemo(() => {
    const rostered = new Set(
      league.allRosters.flatMap((r) => r.keys.map((m) => m.key)),
    );
    const mine = league.myRoster
      .map((m) => men.find((p) => p.key === m.key))
      .filter((p): p is Player => Boolean(p));
    const pool = men.filter((p) => !rostered.has(p.key));
    const room = roomFor(men, league.slots, league.size || 12, WEEKS_DRAWN);

    return {
      adds: addsFor(mine, pool, league.slots, room),
      drops: dropsFor(mine, league.slots, room),
    };
  }, [men, league]);

  const shown = adds.filter((row) => matchesFilter(row.p, posFilter));
  const best = shown[0] ?? null;
  const cheapest = drops[drops.length - 1] ?? null;

  if (!drops.length) {
    return (
      <div class="empty">
        <b>Nobody on your roster yet.</b> Once your league has a team for
        you, this page says what each man on the wire would add.
      </div>
    );
  }

  return (
    <>
      <h2>who to add</h2>
      <table class="line">
        <thead>
          <tr>
            <th>player</th>
            <th>pos</th>
            <th>team</th>
            <th>ppg</th>
            <th>starts</th>
            <th>win chance</th>
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, 60).map((row) => (
            <AddRow
              key={row.p.key}
              row={row}
              onMore={() => props.onMore(row.p)}
            />
          ))}
        </tbody>
      </table>

      <h2>what dropping each of yours costs</h2>
      <table class="line">
        <thead>
          <tr>
            <th>player</th>
            <th>pos</th>
            <th>ppg</th>
            <th>starts</th>
            <th>win chance</th>
          </tr>
        </thead>
        <tbody>
          {drops.map((row) => (
            <DropRow
              key={row.p.key}
              row={row}
              onMore={() => props.onMore(row.p)}
            />
          ))}
        </tbody>
      </table>

      {best && cheapest && (
        <p class="hint">
          Adding <b>{best.p.name}</b> ({signed(best.added)}) and dropping{" "}
          <b>{cheapest.p.name}</b> ({signed(cheapest.costs)}) leaves you{" "}
          <b>{signed(best.added - cheapest.costs)}</b> points of win chance
          better off.
        </p>
      )}
    </>
  );
}
