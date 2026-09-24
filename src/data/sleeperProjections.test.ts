import { describe, expect, it } from "vitest";
import {
  joinProjectionsToGsis,
  parseQuiet,
  parseWeekly,
  projectionKey,
  projectionsToCsv,
  quietFromKey,
  quietToCsv,
  replaceFetchedWeeks,
  sleeperPointsUnder,
  weekKey,
  withoutQuiet,
  type SleeperProjectionRow,
} from "./sleeperProjections.js";

const crosswalk = new Map([
  ["1479", "00-0030279"],
  ["11576", "00-0039794"],
]);

function row(
  playerId: string,
  stats: SleeperProjectionRow["stats"],
  position = "RB",
): SleeperProjectionRow {
  return { player_id: playerId, player: { position }, stats };
}

describe("joinProjectionsToGsis", () => {
  it("keys a projection by the gsis id the crosswalk gives", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("11576", { pts_ppr: 5.4, rec_tgt: 1.4, rush_att: 5.8, rec: 1.1 })],
      crosswalk,
    );

    expect(joined.projected).toEqual([
      {
        season: 2024,
        week: 3,
        gsisId: "00-0039794",
        position: "RB",
        points: 5.4,
        targets: 1.4,
        carries: 5.8,
        catches: 1.1,
      },
    ]);
  });

  it("drops a player the crosswalk does not know", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("99999", { pts_ppr: 12 })],
      crosswalk,
    );

    expect(joined.projected).toEqual([]);
    expect(joined.quiet).toEqual([]);
  });

  it("sets a matched row with no ppr projection aside as quiet", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("1479", { rec_tgt: 4 })],
      crosswalk,
    );

    expect(joined.projected).toEqual([]);
    expect(joined.quiet).toEqual([
      { season: 2024, week: 3, gsisId: "00-0030279" },
    ]);
  });

  it("splits a week into the projected players and the quiet ones", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("1479", { pts_ppr: 14 }), row("11576", {}), row("99999", {})],
      crosswalk,
    );

    expect(joined.projected.map((p) => p.gsisId)).toEqual(["00-0030279"]);
    expect(joined.quiet.map((q) => q.gsisId)).toEqual(["00-0039794"]);
  });

  it("treats a missing target or carry count as none", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("1479", { pts_ppr: 9 }, "WR")],
      crosswalk,
    );

    expect(joined.projected[0]!.targets).toBe(0);
    expect(joined.projected[0]!.carries).toBe(0);
  });

  it("builds the same key from a season, week and player", () => {
    expect(projectionKey(2025, 7, "00-0030279")).toBe("2025|7|00-0030279");
  });
});

describe("the quiet file", () => {
  const rows = [
    { season: 2026, week: 2, gsisId: "00-0039794" },
    { season: 2026, week: 1, gsisId: "00-0030279" },
  ];

  it("writes a header and sorts by season, week and player", () => {
    expect(quietToCsv(rows)).toBe(
      "season,week,gsisId\n" +
      "2026,1,00-0030279\n" +
      "2026,2,00-0039794\n",
    );
  });

  it("reads back the keys the projections are looked up under", () => {
    const keys = parseQuiet(quietToCsv(rows));

    expect(keys.has(projectionKey(2026, 1, "00-0030279"))).toBe(true);
    expect(keys.has(projectionKey(2026, 2, "00-0039794"))).toBe(true);
    expect(keys.size).toBe(2);
  });

  it("writes a player listed twice in a week once", () => {
    expect(quietToCsv([...rows, rows[0]!])).toBe(quietToCsv(rows));
  });

  it("is empty where the file has never been written", () => {
    expect(parseQuiet("").size).toBe(0);
  });
});

describe("a fetch written over what is on disk", () => {
  const caleb = "00-0039918";
  const chase = "00-0036900";
  const projected = (week: number, gsisId: string, points: number) => ({
    season: 2026, week, gsisId, position: "QB",
    points, targets: 0, carries: 3, catches: 0,
  });
  const onDisk = parseWeekly(projectionsToCsv([
    projected(2, caleb, 18.4),
    projected(3, caleb, 17.9),
    projected(3, chase, 16.2),
  ]));

  // Sleeper has since blanked him for week 3, the way it does a player
  // who turns doubtful, and still projects everybody else
  const week3 = joinProjectionsToGsis(
    2026, 3,
    [row("11560", { adp_dd_ppr: 1000 }), row("7564", { pts_ppr: 16.8 })],
    new Map([["11560", caleb], ["7564", chase]]),
  );
  const fetchedWeeks = new Set([weekKey(2026, 3)]);
  const weekly = replaceFetchedWeeks(
    onDisk.values(), week3.projected, fetchedWeeks,
  );
  const quiet = replaceFetchedWeeks([], week3.quiet, fetchedWeeks);

  it("drops a projection Sleeper has withdrawn", () => {
    const written = parseWeekly(projectionsToCsv(weekly));

    expect(written.has(projectionKey(2026, 3, caleb))).toBe(false);
    expect(quiet).toEqual([{ season: 2026, week: 3, gsisId: caleb }]);
  });

  it("takes the new number for a player still projected", () => {
    const written = parseWeekly(projectionsToCsv(weekly));

    expect(written.get(projectionKey(2026, 3, chase))?.points).toBe(16.8);
    expect(written.size).toBe(2);
  });

  it("leaves a week that was not fetched as it was", () => {
    const written = parseWeekly(projectionsToCsv(weekly));

    expect(written.get(projectionKey(2026, 2, caleb))?.points).toBe(18.4);
  });

  it("keeps a player who was quiet and now has a number out of the quiet file", () => {
    const again = replaceFetchedWeeks(
      quiet,
      joinProjectionsToGsis(
        2026, 3, [row("11560", { pts_ppr: 15 })], new Map([["11560", caleb]]),
      ).quiet,
      fetchedWeeks,
    );

    expect(again).toEqual([]);
  });

  it("reads a player-week in both files as quiet", () => {
    const both = withoutQuiet(
      onDisk, parseQuiet(quietToCsv([{ season: 2026, week: 3, gsisId: caleb }])),
    );

    expect(both.has(projectionKey(2026, 3, caleb))).toBe(false);
    expect(both.has(projectionKey(2026, 2, caleb))).toBe(true);
    expect(both.has(projectionKey(2026, 3, chase))).toBe(true);
  });
});

describe("quietFromKey", () => {
  it("turns a key back into the row it was built from", () => {
    expect(quietFromKey(projectionKey(2026, 3, "00-0039918"))).toEqual({
      season: 2026, week: 3, gsisId: "00-0039918",
    });
  });
});

describe("sleeperPointsUnder", () => {
  const chase = joinProjectionsToGsis(
    2026, 1, [row("1479", { pts_ppr: 20, rec: 6 }, "WR")], crosswalk,
  ).projected[0]!;

  it("takes the difference a catch pays off the full PPR number", () => {
    expect(sleeperPointsUnder(chase, 0.5)).toBe(17);
    expect(sleeperPointsUnder(chase, 0)).toBe(14);
    expect(sleeperPointsUnder(chase, 1)).toBe(20);
  });

  it("leaves a row fetched before catches were kept as published", () => {
    const older = { ...chase, catches: undefined };

    expect(sleeperPointsUnder(older, 0)).toBe(20);
  });
});
