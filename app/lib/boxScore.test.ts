import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { statLinesFrom, statLineSays, type StatLine } from "./boxScore.ts";

const said = JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "fixtures", "espnSummaryBoxScore.json"),
  "utf8",
)) as Parameters<typeof statLinesFrom>[0];

const lines = statLinesFrom(said);

const lineFor = (key: string) => lines.get(key)!;

const bare: StatLine = {
  passCmp: 0, passAtt: 0, passYds: 0, passTd: 0, interceptions: 0,
  carries: 0, rushYds: 0, rushTd: 0,
  receptions: 0, targets: 0, recYds: 0, recTd: 0,
  fgm: 0, fga: 0, xpm: 0, xpa: 0, fumblesLost: 0,
};

const line = (some: Partial<StatLine>): StatLine => ({ ...bare, ...some });

describe("statLinesFrom", () => {
  it("keys a player the way the slate keys him", () => {
    expect([...lines.keys()]).toContain("derrickhenry");
  });

  it("folds a quarterback's passing, rushing and fumbles into one line", () => {
    expect(lineFor("lamarjackson")).toEqual(line({
      passCmp: 15, passAtt: 23, passYds: 301, passTd: 1,
      carries: 4, rushYds: 43, rushTd: 1, fumblesLost: 1,
    }));
  });

  it("reads a receiver's targets, which ESPN puts last", () => {
    expect(lineFor("zayflowers")).toEqual(line({
      receptions: 5, targets: 6, recYds: 150, recTd: 1,
    }));
  });

  it("splits a kicker's made and attempted pairs", () => {
    expect(lineFor("spencershrader")).toEqual(line({
      fgm: 1, fga: 1, xpm: 1, xpa: 2,
    }));
  });

  it("takes an interception off the passer, not off a defender", () => {
    expect(lineFor("danieljones").interceptions).toBe(1);
  });

  it("leaves out a player who has not touched the ball", () => {
    expect(statLinesFrom({
      boxscore: {
        players: [{
          statistics: [{
            name: "rushing",
            keys: ["rushingAttempts", "rushingYards", "rushingTouchdowns"],
            athletes: [{
              athlete: { displayName: "Nobody At All" },
              stats: ["0", "0", "0"],
            }],
          }],
        }],
      },
    }).size).toBe(0);
  });

  it("says nothing about a summary with no box score in it", () => {
    expect(statLinesFrom({}).size).toBe(0);
  });
});

describe("statLineSays", () => {
  it("gives a quarterback his passing and then his carries", () => {
    expect(statLineSays(lineFor("lamarjackson"), "QB"))
      .toBe("15/23, 301 yds, 1 TD · 4 car 43 yds, 1 TD · 1 FUM");
  });

  it("counts a quarterback's interception and leaves out his carries", () => {
    expect(statLineSays(lineFor("danieljones"), "QB"))
      .toBe("14/24, 110 yds, 1 INT");
  });

  it("gives a running back his carries", () => {
    expect(statLineSays(lineFor("derrickhenry"), "RB"))
      .toBe("18 car, 117 yds, 3 TD");
  });

  it("adds what a running back caught after what he ran for, targets aside", () => {
    expect(statLineSays(
      line({
        carries: 18, rushYds: 117, rushTd: 3,
        receptions: 5, targets: 7, recYds: 20,
      }),
      "RB",
    )).toBe("18 car, 117 yds, 3 TD · 5 rec, 20 yds");
  });

  it("gives a receiver his targets in brackets", () => {
    expect(statLineSays(lineFor("zayflowers"), "WR"))
      .toBe("5 rec (6 tgt), 150 yds, 1 TD");
  });

  it("adds a receiver's carries after what he caught", () => {
    expect(statLineSays(
      line({ receptions: 5, targets: 6, recYds: 150, carries: 1, rushYds: 12 }),
      "WR",
    )).toBe("5 rec (6 tgt), 150 yds · 1 car, 12 yds");
  });

  it("reads a tight end the way it reads a receiver", () => {
    expect(statLineSays(lineFor("markandrews"), "TE"))
      .toBe("3 rec (5 tgt), 36 yds");
  });

  it("gives a kicker his field goals and his extra points", () => {
    expect(statLineSays(lineFor("tylerloop"), "K")).toBe("1/1 FG, 5/5 XP");
  });

  it("shows a kicker the attempts he missed", () => {
    expect(statLineSays(lineFor("spencershrader"), "K"))
      .toBe("1/1 FG, 1/2 XP");
  });

  it("says nothing for a defence", () => {
    expect(statLineSays(line({ fumblesLost: 1 }), "DEF")).toBe("");
  });

  it("says nothing for a player nobody has a line for", () => {
    expect(statLineSays(undefined, "QB")).toBe("");
  });

  it("keeps a line inside the width a phone has for it", () => {
    for (const [key, his] of lines) {
      for (const position of ["QB", "RB", "WR", "TE", "K"]) {
        for (const piece of statLineSays(his, position).split(" · ")) {
          expect(piece.length, `${key} as a ${position}`)
            .toBeLessThanOrEqual(28);
        }
      }
    }
  });
});
