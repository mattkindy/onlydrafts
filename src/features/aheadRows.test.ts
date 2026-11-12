import { describe, expect, it } from "vitest";
import {
  ageOn, clubNow, finished, outcomeOf, rowsAt, standingOf, trendOf,
  type Line, type Person, type SeasonRead,
} from "./aheadRows.js";

/** a season built by hand: each line is `id, week, team, position, points, work` */
function aSeason(
  season: number,
  lines: [string, number, string, string, number, number][],
  roster: [string, number, string, string, string][] = [],
  lastPlayed = 18,
): SeasonRead {
  const read: SeasonRead = {
    season,
    lines: new Map(), clubWork: new Map(), clubWeeks: new Map(),
    snaps: new Map(), roster: new Map(), rosterWeeks: new Map(),
    lastPlayed,
  };

  for (const [id, week, team, position, points, work] of lines) {
    const his = read.lines.get(id) ?? new Map<number, Line>();
    his.set(week, { team, position, points, work });
    read.lines.set(id, his);

    const club = read.clubWork.get(`${team}|${week}`) ?? { backs: 0, targets: 0, throws: 0 };

    if (position === "RB") {
      club.backs += work;
    } else if (position === "QB") {
      club.throws += work;
    } else {
      club.targets += work;
    }

    read.clubWork.set(`${team}|${week}`, club);
    read.clubWeeks.set(team, new Set([...(read.clubWeeks.get(team) ?? []), week]));
  }

  for (const [id, week, team, position, status] of roster) {
    const his = read.roster.get(id) ?? new Map();
    his.set(week, { team, position, status });
    read.roster.set(id, his);
    read.rosterWeeks.set(team, new Set([...(read.rosterWeeks.get(team) ?? []), week]));
  }

  return read;
}

const people = new Map<string, Person>([
  ["back", {
    name: "A Back", position: "RB", birthDate: "2005-05-31", entry: 2026,
    drafted: { season: 2026, round: 1, overall: 3 },
  }],
  ["vet", {
    name: "A Veteran", position: "RB", birthDate: "2000-04-15", entry: 2022,
    drafted: { season: 2022, round: 5, overall: 151 },
  }],
]);

describe("ageOn", () => {
  it("is his age on the first of September, to one decimal", () => {
    expect(ageOn("2005-05-31", 2026)).toBe(21.3);
    expect(ageOn("1995-09-01", 2026)).toBe(31);
  });

  it("says nothing without a usable birth date", () => {
    expect(ageOn(undefined, 2026)).toBeUndefined();
    expect(ageOn("not a date", 2026)).toBeUndefined();
  });
});

describe("standingOf", () => {
  it("reads the roster codes as four standings", () => {
    expect(standingOf("ACT")).toBe("active");
    expect(standingOf("INA")).toBe("active");
    expect(standingOf("RES")).toBe("reserve");
    expect(standingOf("PUP")).toBe("reserve");
    expect(standingOf("DEV")).toBe("practice");
    expect(standingOf("CUT")).toBe("off");
    expect(standingOf(undefined)).toBe("off");
  });
});

describe("trendOf", () => {
  it("is the last three against the rest", () => {
    expect(trendOf([0.6, 0.6, 0.3, 0.3, 0.3])).toBeCloseTo(-0.3);
  });

  it("is nought until there are five to read", () => {
    expect(trendOf([0.9, 0.1, 0.1, 0.1])).toBe(0);
  });
});

describe("clubNow", () => {
  it("files a moved club under the name the box scores use", () => {
    expect(clubNow("OAK")).toBe("LV");
    expect(clubNow("SD")).toBe("LAC");
    expect(clubNow("ARI")).toBe("ARI");
  });
});

describe("outcomeOf", () => {
  it("puts a sixteen game season on seventeen", () => {
    const read = aSeason(2019, [["back", 1, "ARI", "RB", 10, 15], ["back", 2, "ARI", "RB", 6, 10]]);

    expect(outcomeOf(read, "back")).toEqual({ games: 2 * 17 / 16, points: 16 * 17 / 16 });
  });

  it("is nothing for a season nobody has read", () => {
    expect(outcomeOf(undefined, "back")).toBeUndefined();
  });
});

describe("rowsAt", () => {
  const now = aSeason(2026, [
    ["back", 1, "ARI", "RB", 12, 15],
    ["vet", 1, "ARI", "RB", 8, 15],
    ["back", 2, "ARI", "RB", 6, 10],
    ["vet", 2, "ARI", "RB", 10, 10],
    ["vet", 3, "ARI", "RB", 9, 20],
    // a week past the cut, which nothing may read
    ["back", 4, "ARI", "RB", 30, 30],
  ], [
    ["back", 3, "ARI", "RB", "RES"],
    ["vet", 3, "ARI", "RB", "ACT"],
  ], 4);
  const next = aSeason(2027, [["back", 1, "ARI", "RB", 20, 20]]);
  const rows = rowsAt(2026, 4, new Map([[2026, now], [2027, next]]), people);
  const back = rows.find((row) => row.playerId === "back")!;
  const vet = rows.find((row) => row.playerId === "vet")!;

  it("reads only the weeks before the cut", () => {
    expect(back.games).toBe(2);
    expect(back.points).toBe(18);
    expect(back.clubGames).toBe(3);
  });

  it("takes his share of the room's work over the games he played", () => {
    expect(back.share).toBeCloseTo(0.5);
    expect(vet.share).toBeCloseTo((0.5 + 0.5 + 1) / 3);
  });

  it("says where he stands and who else is in his room", () => {
    expect(back.standing).toBe("reserve");
    expect(vet.standing).toBe("active");
    // the veteran took 45 of the 70 carries and targets the club handed out
    expect(back.roomTopShare).toBeCloseTo(45 / 70);
    expect(vet.roomYoungPick).toBe(3);
    expect(back.roomYoungPick).toBeUndefined();
  });

  it("carries his age, his seasons and his draft", () => {
    expect(back.age).toBe(21.3);
    expect(back.experience).toBe(0);
    expect(back.drafted).toEqual({ season: 2026, round: 1, overall: 3 });
    expect(vet.experience).toBe(4);
  });

  it("reads a season ahead only once it has finished", () => {
    expect(finished(next)).toBe(true);
    expect(back.ahead[0]).toEqual({ games: 1, points: 20 });
    expect(back.ahead[1]).toBeUndefined();
  });

  it("reads a man missing from his club's latest roster week as off it", () => {
    const later = aSeason(2026, [["vet", 1, "ARI", "RB", 8, 15]], [
      ["vet", 1, "ARI", "RB", "ACT"],
      ["back", 2, "ARI", "RB", "ACT"],
    ], 4);
    const [cut] = rowsAt(2026, 4, new Map([[2026, later]]), people)
      .filter((row) => row.playerId === "vet");

    expect(cut!.standing).toBe("off");
  });
});
