/**
 * One week, ranked, so you can look a man up.
 *
 * The table is everybody the model has a number for, not only your own
 * men. Your own are marked and there is a switch to hide the rest.
 *
 * Compare mode is for the question people actually ask, which is not
 * "how many points" but "which of these two". The bands it reports come
 * from the pair bench and are printed with the answer, so a two point
 * gap is not read as if it settled anything.
 */

import { useMemo, useState } from "preact/hooks";

import {
  isSplit, onRoster, splitBy, splitNote, verdict, SPLIT_AT, STARTER_OUT_AT,
  type Slate, type SlateRow,
} from "../lib/slate.ts";
import { normalizeName } from "../lib/store.ts";

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE"];

interface Props {
  slate: Slate | null;
  /** the men on your team, or nothing when no league is connected */
  roster: Set<string> | null;
}

/** what the league office and his side's injuries say about one man */
function Chips({ row }: { row: SlateRow }) {
  return (
    <>
      {row.questionable && (
        <span class="badge warn" title="listed questionable this week">
          questionable
        </span>
      )}
      {row.gamesMissedRecent > 0 && (
        <span
          class="badge even"
          title={`he has missed ${row.gamesMissedRecent} of the last few games`}
        >
          missed {row.gamesMissedRecent}
        </span>
      )}
      {row.absenceShare >= STARTER_OUT_AT && (
        <span
          class="badge even"
          title={`about ${Math.round(row.absenceShare * 100)}% of his side's ` +
            "usual work is missing, so there is more of it for him"}
        >
          starter out
        </span>
      )}
    </>
  );
}

/** floor to ceiling, with what he is projected for marked inside it */
function Spread({ row, max }: { row: SlateRow; max: number }) {
  const pct = (v: number) => Math.max(0, Math.min(100, (v / max) * 100));

  return (
    <span
      class="fc"
      title={`${row.floor.toFixed(1)} in a bad week, ` +
        `${row.ceiling.toFixed(1)} in a good one`}
    >
      <u style={{ left: pct(row.floor) + "%", right: (100 - pct(row.ceiling)) + "%" }} />
      <b style={{ left: pct(row.blend) + "%" }} />
    </span>
  );
}

function Compare({ pair }: { pair: [SlateRow, SlateRow] }) {
  const [a, b] = pair;
  const call = verdict(a, b);

  return (
    <div class="clock">
      <div class="big">{call.says}</div>
      <div class="sub">
        {call.gap.toFixed(1)} points between them
        {call.start ? `, ${call.start.name} ahead` : ""}
      </div>
      <table class="line">
        <thead>
          <tr>
            <th />
            <th>opp</th>
            <th>ours</th>
            <th>sleeper</th>
            <th>blend</th>
            <th>floor</th>
            <th>ceiling</th>
          </tr>
        </thead>
        <tbody>
          {pair.map((row) => (
            <tr key={row.playerId}>
              <th>{row.name}</th>
              <td>{row.home ? "" : "@"}{row.opponent}</td>
              <td>{row.ours.toFixed(1)}</td>
              <td>{row.sleeper === null ? "-" : row.sleeper.toFixed(1)}</td>
              <td><b>{row.blend.toFixed(1)}</b></td>
              <td>{row.floor.toFixed(1)}</td>
              <td>{row.ceiling.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WeekRanks({ slate, roster }: Props) {
  const [posFilter, setPosFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [picks, setPicks] = useState<SlateRow[]>([]);

  const rows = useMemo(() => {
    const all = slate?.rows ?? [];
    const wanted = query.trim();

    return all
      .filter((row) => posFilter === "ALL" || row.position === posFilter)
      .filter((row) => !mineOnly || onRoster(roster, row))
      .filter((row) => !wanted ||
        normalizeName(row.name).includes(normalizeName(wanted)))
      .sort((a, b) => b.blend - a.blend);
  }, [slate, posFilter, mineOnly, query, roster]);

  const max = Math.max(1, ...rows.map((row) => row.ceiling));

  /**
   * Two men, and only two men at the same position. Picking somebody
   * else's position starts the comparison over on him rather than
   * refusing the click, since a refusal with no explanation reads as a
   * broken button.
   */
  const pick = (row: SlateRow) => {
    setPicks((held) => {
      if (held.some((h) => h.playerId === row.playerId)) {
        return held.filter((h) => h.playerId !== row.playerId);
      }

      const first = held[0];

      if (!first || first.position !== row.position) {
        return [row];
      }

      return [first, row];
    });
  };

  const pair: [SlateRow, SlateRow] | null =
    picks.length === 2 ? [picks[0]!, picks[1]!] : null;

  return (
    <>
      <div class="controls">
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
          find{" "}
          <input
            size={12} placeholder="a name" value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>

        {roster && (
          <label>
            <input
              type="checkbox" checked={mineOnly}
              onChange={(e) => setMineOnly(e.currentTarget.checked)}
            />{" "}
            my roster only
          </label>
        )}

        {picks.length > 0 && (
          <button onClick={() => setPicks([])}>clear the comparison</button>
        )}
      </div>

      {!slate && <div class="empty">reading the week...</div>}

      {pair && <Compare pair={pair} />}

      {picks.length === 1 && (
        <p class="hint">
          Now pick another {picks[0]!.position} to compare against{" "}
          {picks[0]!.name}.
        </p>
      )}

      {slate && (
        <>
          <p class="hint">
            Ranked by the blend of our number and Sleeper's. A row in
            amber is one where the two disagree by {SPLIT_AT} points or more;
            hover it to see which way. Press compare on two men at the
            same position for a straight answer.
          </p>

          <div class="scroll">
            <table class="ranks">
              <thead>
                <tr>
                  <th>player</th>
                  <th>team</th>
                  <th>opp</th>
                  <th class="n">ours</th>
                  <th class="n">sleeper</th>
                  <th class="n">blend</th>
                  <th>floor to ceiling</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const chosen = picks.some((h) => h.playerId === row.playerId);

                  return (
                    <tr
                      key={row.playerId}
                      class={[
                        onRoster(roster, row) ? "mine" : "",
                        isSplit(row) ? "split" : "",
                        chosen ? "picked" : "",
                      ].filter(Boolean).join(" ")}
                      title={isSplit(row) ? splitNote(row) : undefined}
                      onClick={() => pick(row)}
                    >
                      <td>
                        <span class="who">{row.name}</span>{" "}
                        <span class="pos">{row.position}</span>
                        <Chips row={row} />
                      </td>
                      <td>{row.team}</td>
                      <td>{row.home ? "" : "@"}{row.opponent}</td>
                      <td class="n">{row.ours.toFixed(1)}</td>
                      <td class="n">
                        {row.sleeper === null ? "-" : row.sleeper.toFixed(1)}
                        {isSplit(row) && (
                          <span class={"chip " + (splitBy(row) > 0 ? "up" : "down")}>
                            {splitBy(row) > 0 ? "+" : ""}
                            {splitBy(row).toFixed(1)}
                          </span>
                        )}
                      </td>
                      <td class="n"><b>{row.blend.toFixed(1)}</b></td>
                      <td><Spread row={row} max={max} /></td>
                      <td class="mark">{chosen ? "•" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {rows.length === 0 && (
            <div class="empty">Nobody here matches that.</div>
          )}
        </>
      )}
    </>
  );
}
