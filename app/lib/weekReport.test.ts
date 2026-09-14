import { describe, expect, it } from "vitest";

import type { GameState } from "./matchups.ts";
import type { Matchup, Side } from "./providers.ts";
import type { SlateRow } from "./slate.ts";
import {
  AWARD_SAYS, bestPointsFor, quantileSays, reportFor, type Award,
  type ReportInput,
} from "./weekReport.ts";

const row = (
  name: string, team: string, blend: number, position = "WR",
): SlateRow => ({
  playerId: name,
  name,
  position,
  team,
  opponent: "NE",
  home: true,
  ours: blend,
  sleeper: blend,
  blend,
  floor: blend * 0.4,
  ceiling: blend * 1.8,
  catches: 0,
  questionable: false,
  gamesMissedRecent: 0,
  absenceShare: 0,
});

/** one starter a piece at every slot the default lineup takes */
const LINEUP: [string, string, string][] = [
  ["QB", "QB", "BUF"],
  ["RB", "RB", "MIA"],
  ["RB2", "RB", "MIA"],
  ["WR", "WR", "BUF"],
  ["WR2", "WR", "BUF"],
  ["TE", "TE", "MIA"],
  ["FLEX", "WR", "BUF"],
];

const rows = new Map<string, SlateRow>();

/** every player in the fixture, named after the team that starts him */
function lineupFor(owner: string, points: number[], blend = 12) {
  return LINEUP.map(([slot, position, team], at) => {
    const key = owner + "-" + slot;

    rows.set(key, row(key, team, blend, position));

    return { key, slot, points: points[at] ?? 0 };
  });
}

function side(
  owner: string, points: number[], bench: [string, number, string][] = [],
): Side {
  return {
    owner,
    points: points.reduce((sum, n) => sum + n, 0),
    starters: lineupFor(owner, points),
    bench: bench.map(([name, scored, position]) => {
      const key = owner + "-" + name;

      rows.set(key, row(key, "MIA", 12, position));

      return { key, points: scored };
    }),
  };
}

/** everybody's game is over, which is what the awards need */
const OVER: GameState = { where: "post", left: 0 };

const IN_PLAY: GameState = { where: "in", left: 0.5 };

const teams = ["BUF", "MIA"];

const states = (of: Record<string, GameState> = {}) =>
  new Map<string, GameState>([
    ...teams.map((team) => [team, OVER] as [string, GameState]),
    ...Object.entries(of),
  ]);

const flat = (total: number) => Array(7).fill(total / 7) as number[];

/**
 * Three games. Ace beats Bea by a mile, Cy edges Dot, and Eli loses to
 * Fay with more points than she scored.
 */
const GAMES: Matchup[] = [
  { sides: [side("Ace", flat(140)), side("Bea", flat(70))] },
  { sides: [side("Cy", flat(100.5)), side("Dot", flat(100))] },
  {
    sides: [
      side("Eli", flat(120), [["super", 60, "WR"]]),
      side("Fay", flat(121)),
    ],
  },
];

const input = (over?: Partial<ReportInput>): ReportInput => ({
  league: "Dynasty Warriors",
  week: 3,
  games: GAMES,
  rows,
  states: states(),
  slots: null,
  ...over,
});

const awardIn = (report: ReturnType<typeof reportFor>, award: Award) =>
  report.awards.find((given) => given.award === award);

describe("reportFor", () => {
  it("gives the awards out over the finished games", () => {
    const report = reportFor(input());

    expect(awardIn(report, "highest")?.owner).toBe("Ace");
    expect(awardIn(report, "highest")?.figure).toBe("140.00");
    expect(awardIn(report, "lowest")?.owner).toBe("Bea");
    expect(awardIn(report, "blowout")?.owner).toBe("Ace");
    expect(awardIn(report, "blowout")?.figure).toBe("70.00");
    expect(awardIn(report, "closest")?.owner).toBe("Cy");
    expect(awardIn(report, "closest")?.figure).toBe("0.50");
    expect(awardIn(report, "lucky")?.owner).toBe("Cy");
    expect(awardIn(report, "unlucky")?.owner).toBe("Eli");
  });

  it("says every award it gives in the league's own words", () => {
    const report = reportFor(input());

    for (const given of report.awards) {
      expect(AWARD_SAYS[given.award]).toBeTruthy();
    }
  });

  it("counts what a side left on its bench", () => {
    const report = reportFor(input());
    const bench = awardIn(report, "bench");

    // Eli sat a 60 point receiver behind starters on 120 / 7 each
    expect(bench?.owner).toBe("Eli");
    expect(bench?.figure).toBe("42.86");
    expect(awardIn(report, "manager")?.owner).not.toBe("Eli");
  });

  it("waits on the awards while a game is still going", () => {
    const report = reportFor(input({ states: states({ MIA: IN_PLAY }) }));

    expect(report.provisional).toBe(true);
    expect(report.finished).toBe(0);
    expect(report.awards).toEqual([]);
    expect(report.games).toBe(3);
  });

  it("counts the games that are over when one is not", () => {
    const late: Matchup[] = [
      ...GAMES.slice(0, 2),
      { sides: [side("Gus", flat(80)), side("Hal", flat(90))] },
    ];
    // Hal alone has somebody left on the field, so his game waits
    const still = new Map(rows);

    still.set("Hal-QB", row("Hal-QB", "DEN", 12, "QB"));

    const report = reportFor(input({
      games: late,
      rows: still,
      states: states({ DEN: IN_PLAY }),
    }));

    expect(report.provisional).toBe(true);
    expect(report.finished).toBe(2);
    expect(awardIn(report, "highest")?.owner).toBe("Ace");
  });

  it("picks an over and an under performer at each position", () => {
    const richer = new Map(rows);

    richer.set("Ace-QB", row("Ace-QB", "BUF", 8, "QB"));
    richer.set("Bea-QB", row("Bea-QB", "MIA", 30, "QB"));

    const report = reportFor(input({ rows: richer }));
    const qb = report.positions.find((pick) => pick.position === "QB");

    expect(qb?.over?.owner).toBe("Ace");
    expect(qb?.under?.owner).toBe("Bea");
    expect(qb?.over?.quantile).toBeGreaterThan(qb?.under?.quantile ?? 1);
    expect(report.positions.map((pick) => pick.position))
      .toEqual(["QB", "RB", "WR", "TE", "K", "DEF"]);
  });

  it("ranks a big week over a small one in the player's own terms", () => {
    const mixed = new Map(rows);

    // a receiver on a line of 4 who scores 20 beats a back on 20 who
    // scores 21, which raw points would have the other way round
    mixed.set("Ace-WR", row("Ace-WR", "BUF", 4, "WR"));
    mixed.set("Ace-RB", row("Ace-RB", "MIA", 20, "RB"));

    const games: Matchup[] = [
      { sides: [side("Ace", flat(140)), side("Bea", flat(70))] },
    ];
    const report = reportFor(input({ games, rows: mixed }));

    expect(report.best[0]?.name).toBe("Ace-WR");
    expect(report.best.map((note) => note.key))
      .not.toContain(report.worst[0]?.key);
  });

  it("leaves nothing out of the report for an empty week", () => {
    const report = reportFor(input({ games: [] }));

    expect(report.provisional).toBe(false);
    expect(report.awards).toEqual([]);
    expect(report.best).toEqual([]);
    expect(report.positions).toHaveLength(6);
  });
});

describe("reportFor, with the week as it looked pregame", () => {
  const pregame = [
    { odds: [0.8, 0.2] as [number, number], projected: [110, 90] as [number, number] },
    { odds: [0.2, 0.8] as [number, number], projected: [95, 130] as [number, number] },
    { odds: [0.5, 0.5] as [number, number], projected: [130, 118] as [number, number] },
  ];

  it("gives the stolen game to the winner nobody fancied", () => {
    const report = reportFor(input({ pregame }));

    // Cy was a 20% shot and won it
    expect(awardIn(report, "stolen")?.owner).toBe("Cy");
    expect(awardIn(report, "stolen")?.figure).toBe("20%");
    expect(awardIn(report, "stolen")?.fill).toBeCloseTo(0.2);
  });

  it("gives the choke to the favourite who lost", () => {
    const report = reportFor(input({ pregame }));

    expect(awardIn(report, "choke")?.owner).toBe("Dot");
    expect(awardIn(report, "choke")?.won).toBe(false);
  });

  it("measures a team against its own projection", () => {
    const report = reportFor(input({ pregame }));

    expect(awardIn(report, "beater")?.owner).toBe("Ace");
    expect(awardIn(report, "beater")?.figure).toBe("+30.00");
    expect(awardIn(report, "shortfall")?.owner).toBe("Dot");
    expect(report.manager?.owner).toBe("Ace");
  });
});

describe("reportFor, on the lineups", () => {
  it("finds the one swap that would have won the game", () => {
    const report = reportFor(input());
    const swap = awardIn(report, "swap");

    // Eli lost by one with a 60 point receiver on his bench
    expect(swap?.owner).toBe("Eli");
    expect(swap?.note).toContain("Eli-super");
    expect(swap?.figure).toBe("41.86");
  });

  it("says who started somebody who scored nothing", () => {
    const games: Matchup[] = [{
      sides: [
        {
          ...side("Ida", [20, 20, 20, 20, 20, 20, 0]),
          points: 120,
        },
        side("Jo", flat(100)),
      ],
    }];
    const report = reportFor(input({ games }));

    expect(report.zeroes).toEqual([{ owner: "Ida", names: ["Ida-FLEX"] }]);
  });

  it("names the best player on anybody's bench at each position", () => {
    const report = reportFor(input());

    expect(report.benched.map((his) => his.name)).toEqual(["Eli-super"]);
    expect(report.benched[0]?.owner).toBe("Eli");
    expect(report.benched[0]?.position).toBe("WR");
  });

  it("sorts every score with the middle of the week", () => {
    const report = reportFor(input());

    expect(report.scores.map((s) => s.owner))
      .toEqual(["Ace", "Fay", "Eli", "Cy", "Dot", "Bea"]);
    expect(report.scores[0]?.won).toBe(true);
    expect(report.median).toBeCloseTo(110.25);
  });

  it("finds a quarterback and his receiver both over their lines", () => {
    const report = reportFor(input());

    // Ace's quarterback and his BUF receivers all beat a line of 12
    expect(report.stack?.owner).toBe("Ace");
    expect(report.stack?.team).toBe("BUF");
    expect(report.stack?.names[0]).toBe("Ace-QB");
  });
});

describe("reportFor, on the players nobody had", () => {
  const weeks = [
    {
      key: "Free Man", name: "Free Man", position: "WR", team: "BUF",
      points: 31.4, scoredBy: "league" as const,
    },
    {
      key: "Ace-QB", name: "Ace-QB", position: "QB", team: "BUF",
      points: 40, scoredBy: "league" as const,
    },
    {
      key: "Spare Kicker", name: "Spare Kicker", position: "K", team: "MIA",
      points: 9, scoredBy: "league" as const,
    },
  ];

  it("leaves out everybody somebody in the league has", () => {
    const report = reportFor(input({
      weeks, rostered: new Set(["Ace-QB"]),
    }));

    expect(report.freeAgents?.top?.name).toBe("Free Man");
    expect(report.freeAgents?.scoredBy).toBe("league");
    expect(
      report.freeAgents?.positions.find((its) => its.position === "K")?.top?.name,
    ).toBe("Spare Kicker");
    expect(
      report.freeAgents?.positions.find((its) => its.position === "QB")?.top,
    ).toBe(null);
  });

  it("says nothing about free agents where the provider will not say", () => {
    expect(reportFor(input()).freeAgents).toBe(null);
  });
});

describe("bestPointsFor", () => {
  it("starts a spare quarterback in a superflex", () => {
    const of = side("Ivy", flat(70), [["spare", 30, "QB"]]);
    const best = bestPointsFor(
      of, ["QB", "RB", "WR", "SUPER_FLEX"], rows, undefined);

    // the 30 point quarterback and three of the 10 point starters
    expect(best).toBeCloseTo(30 + 10 * 3);
  });

  it("takes the lineup it was given over the usual one", () => {
    const of = side("Jem", flat(70));

    expect(bestPointsFor(of, ["QB"], rows, undefined)).toBeCloseTo(10);
  });
});

describe("quantileSays", () => {
  it("reads a share of a spread as an ordinal", () => {
    expect(quantileSays(0.96)).toBe("96th");
    expect(quantileSays(0.21)).toBe("21st");
    expect(quantileSays(0.02)).toBe("2nd");
    expect(quantileSays(0.13)).toBe("13th");
    expect(quantileSays(0)).toBe("1st");
    expect(quantileSays(1)).toBe("99th");
  });
});
