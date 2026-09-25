/**
 * A player's stat line, read off the same record his league scores him
 * from. The Sleeper fixture is the week 3 stats feed during Falcons at
 * Packers on a Thursday night in 2026, and the ESPN one is roster entries
 * from a public league at the same moment, plus a defence from week 2.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  defenceLineSays, espnStatsOf, sleeperStatsOf, statLineSays, statsSay,
  type StatLine, type StatRecord,
} from "./boxScore.ts";

const fixture = <T>(name: string) => JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "fixtures", name), "utf8")) as T;

const sleeper = fixture<Record<string, StatRecord>>("sleeperStatsWeek3.json");

interface Entry {
  playerPoolEntry: {
    player: {
      fullName: string;
      stats: { statSourceId: number; stats: StatRecord }[];
    };
  };
}

const espn = fixture<{ week3: Entry[]; week2: Entry[] }>(
  "espnRosterEntries.json");

/** what ESPN says a player actually did, which is stat source 0 */
const espnDid = (entries: Entry[], name: string) => entries
  .find((entry) => entry.playerPoolEntry.player.fullName === name)!
  .playerPoolEntry.player.stats
  .find((record) => record.statSourceId === 0)!.stats;

const bare: StatLine = {
  passCmp: 0, passAtt: 0, passYds: 0, passTd: 0, interceptions: 0,
  carries: 0, rushYds: 0, rushTd: 0,
  receptions: 0, targets: 0, recYds: 0, recTd: 0,
  fgm: 0, fga: 0, xpm: 0, xpa: 0, fumblesLost: 0,
};

const line = (some: Partial<StatLine>): StatLine => ({ ...bare, ...some });

describe("sleeperStatsOf", () => {
  it("reads a receiver's catches, targets and yards off his record", () => {
    expect(sleeperStatsOf(sleeper["8112"]!, "WR")).toEqual({
      kind: "player",
      line: line({ receptions: 8, targets: 9, recYds: 154 }),
    });
  });

  it("reads a quarterback's passing", () => {
    const said = sleeperStatsOf(sleeper["6804"]!, "QB");

    expect(said.kind).toBe("player");
    expect(said.line).toMatchObject({
      passCmp: 22, passAtt: 41, passYds: 250, passTd: 2,
    });
  });

  it("reads a kicker's makes and attempts", () => {
    expect(sleeperStatsOf(sleeper["650"]!, "K")).toEqual({
      kind: "player", line: line({ fgm: 2, fga: 2, xpm: 3, xpa: 3 }),
    });
  });

  it("reads a defence off the record under its team code", () => {
    expect(sleeperStatsOf(sleeper["ATL"]!, "DEF")).toEqual({
      kind: "defence",
      line: { allowed: 13, sacks: 1, picks: 0, recovered: 0, defTd: 0 },
    });
    expect(sleeperStatsOf(sleeper["GB"]!, "DEF").line)
      .toMatchObject({ allowed: 27, picks: 1 });
  });

  it("takes a lost fumble off fum_lost", () => {
    expect(sleeperStatsOf({ rush_att: 12, rush_yd: 40, fum_lost: 1 }, "RB"))
      .toEqual({
        kind: "player",
        line: line({ carries: 12, rushYds: 40, fumblesLost: 1 }),
      });
  });

  it("reads a null in the feed as none", () => {
    expect(sleeperStatsOf({ rec: null, rec_yd: 12 }, "WR").line)
      .toMatchObject({ receptions: 0, recYds: 12 });
  });
});

describe("espnStatsOf", () => {
  it("reads the same receiver the same way off ESPN's numbers", () => {
    expect(espnStatsOf(espnDid(espn.week3, "Drake London"), "WR")).toEqual({
      kind: "player",
      line: line({ receptions: 8, targets: 9, recYds: 154 }),
    });
  });

  it("reads a quarterback's passing and leaves a fumble he kept off", () => {
    expect(espnStatsOf(espnDid(espn.week3, "Jordan Love"), "QB")).toEqual({
      kind: "player",
      line: line({ passCmp: 22, passAtt: 41, passYds: 249, passTd: 2, carries: 1 }),
    });
  });

  it("reads a kicker who has missed his one field goal", () => {
    expect(statsSay(espnStatsOf(espnDid(espn.week3, "Trey Smack"), "K"), "K"))
      .toEqual(["0/1 FG, 2/2 XP"]);
  });

  it("reads a defence, a fumble return touchdown included", () => {
    expect(espnStatsOf(espnDid(espn.week2, "Patriots D/ST"), "DEF")).toEqual({
      kind: "defence",
      line: { allowed: 3, sacks: 4, picks: 1, recovered: 1, defTd: 1 },
    });
  });
});

describe("statLineSays", () => {
  it("gives a quarterback his passing and then his rushing, fumble included", () => {
    expect(statLineSays(line({
      passCmp: 15, passAtt: 23, passYds: 301, passTd: 1,
      carries: 4, rushYds: 43, rushTd: 1, fumblesLost: 1,
    }), "QB")).toEqual(["15/23, 301 yds, 1 TD", "4 car, 43 yds, 1 TD, 1 FUM"]);
  });

  it("counts a quarterback's interception and leaves out his carries", () => {
    expect(statLineSays(line({
      passCmp: 14, passAtt: 24, passYds: 110, interceptions: 1, carries: 1,
    }), "QB")).toEqual(["14/24, 110 yds, 1 INT"]);
  });

  it("adds what a running back caught after what he ran for", () => {
    expect(statLineSays(
      line({
        carries: 18, rushYds: 117, rushTd: 3,
        receptions: 5, targets: 7, recYds: 20,
      }),
      "RB",
    )).toEqual(["18 car, 117 yds, 3 TD", "5/7 rec, 20 yds"]);
  });

  it("adds a receiver's carries after what he caught", () => {
    expect(statLineSays(
      line({ receptions: 5, targets: 6, recYds: 150, carries: 1, rushYds: 12 }),
      "WR",
    )).toEqual(["5/6 rec, 150 yds", "1 car, 12 yds"]);
  });

  it("puts a receiver's lost fumble on his receiving line when he never ran", () => {
    expect(statLineSays(
      line({ receptions: 4, targets: 5, recYds: 40, fumblesLost: 1 }),
      "WR",
    )).toEqual(["4/5 rec, 40 yds, 1 FUM"]);
  });

  it("reads a tight end the way it reads a receiver", () => {
    expect(statLineSays(line({ receptions: 3, targets: 5, recYds: 36 }), "TE"))
      .toEqual(["3/5 rec, 36 yds"]);
  });

  it("shows a kicker the attempts he missed", () => {
    expect(statLineSays(line({ fgm: 1, fga: 1, xpm: 1, xpa: 2 }), "K"))
      .toEqual(["1/1 FG, 1/2 XP"]);
  });

  it("says nothing for a defence", () => {
    expect(statLineSays(line({ fumblesLost: 1 }), "DEF")).toEqual([]);
  });

  it("says nothing for a player nobody has a line for", () => {
    expect(statLineSays(undefined, "QB")).toEqual([]);
  });

  it("keeps a line inside the width a phone has for it", () => {
    for (const [id, record] of Object.entries(sleeper)) {
      for (const position of ["QB", "RB", "WR", "TE", "K"]) {
        const said = sleeperStatsOf(record, position);

        for (const piece of statsSay(said, position)) {
          expect(piece.length, `${id} as a ${position}`)
            .toBeLessThanOrEqual(28);
        }
      }
    }
  });
});

describe("defenceLineSays", () => {
  it("says what it allowed and then what it took", () => {
    expect(statsSay(sleeperStatsOf(sleeper["GB"]!, "DEF"), "DEF"))
      .toEqual(["27 allowed", "1 INT"]);
    expect(defenceLineSays(undefined)).toEqual([]);
  });

  it("says one sack in the singular", () => {
    expect(defenceLineSays({
      allowed: 0, sacks: 1, picks: 0, recovered: 0, defTd: 1,
    })).toEqual(["0 allowed", "1 sack, 1 TD"]);
  });
});

describe("statsSay", () => {
  it("says nothing before a player has a record", () => {
    expect(statsSay(undefined, "WR")).toEqual([]);
  });

  it("reads a defence as a defence whatever position it is asked for", () => {
    expect(statsSay(sleeperStatsOf(sleeper["ATL"]!, "DEF"), undefined))
      .toEqual(["13 allowed", "1 sack"]);
  });
});
