import { describe, expect, it } from "vitest";
import type { PlayedWeek } from "./inSeasonLevel.js";
import {
  positionGroup,
  readRise,
  roomsFrom,
  standingAt,
  type RoomWeek,
} from "./riseReason.js";

function played(shares: number[]): PlayedWeek[] {
  return shares.map((snapShare, i) => ({
    week: i + 1,
    points: 8,
    snapShare,
    targets: 3,
    carries: 8,
    airYards: 10,
    passAttempts: 0,
  }));
}

function room(
  playerId: string, week: number, over: Partial<RoomWeek> = {},
): RoomWeek {
  return {
    playerId,
    teamId: "CLE",
    position: "RB",
    week,
    status: "ACT",
    snapShare: 0,
    listed: false,
    ...over,
  };
}

/** a backup at a fifth of the snaps for three games, then most of them */
const BACKUP = [0.2, 0.2, 0.2, 0.7, 0.7, 0.7];

/**
 * The backup's own rows beside the starter's, the starter at seven in ten
 * for three games and then whatever each test says of weeks 4 to 6.
 */
function club(starter: (week: number) => Partial<RoomWeek> | null): RoomWeek[] {
  const rows: RoomWeek[] = [];

  for (let week = 1; week <= 7; week++) {
    rows.push(room("ford", week, { snapShare: BACKUP[week - 1] ?? 0.7 }));

    const his = week <= 3 ? { snapShare: 0.7 } : starter(week);

    if (his) {
      rows.push(room("chubb", week, his));
    }
  }

  return rows;
}

const rise = (rows: RoomWeek[], cut = 6) =>
  readRise(roomsFrom(rows), "ford", played(BACKUP).filter((w) => w.week <= cut), cut);

describe("readRise", () => {
  it("reads a starter gone to injured reserve as a promotion", () => {
    const read = rise(club(() => ({ status: "RES", statusCode: "R01" })));

    expect(read).toEqual({
      reason: "promotion", fromWeek: 4, detail: "reserve list", teammate: "chubb",
    });
  });

  it("reads a starter dropped from the roster as released", () => {
    expect(rise(club((week) => week === 4 ? { status: "CUT" } : null))?.detail)
      .toBe("released");
    expect(rise(club(() => null))?.detail).toBe("released");
  });

  it("reads a starter on another club as traded", () => {
    expect(rise(club(() => ({ teamId: "NYJ", snapShare: 0.6 })))).toMatchObject({
      reason: "promotion", detail: "traded",
    });
  });

  it("reads a starter listed hurt and still on the roster as a fill-in", () => {
    const read = rise(club(() => ({ status: "INA", listed: true })));

    expect(read).toMatchObject({ reason: "fill-in", detail: "listed" });
  });

  it("reads a COVID list stint as short, where other reserve lists are long", () => {
    const read = rise(club(() => ({ status: "RES", statusCode: "R59" })));

    expect(read).toMatchObject({ reason: "fill-in", detail: "short reserve" });
  });

  it("reads a starter who missed a game and has played since as back", () => {
    const read = rise(club((week) => ({ snapShare: week === 4 ? 0 : 0.4 })));

    expect(read).toMatchObject({ reason: "fill-in", detail: "back" });
  });

  it("reads a starter still playing, only less, as the depth chart moving", () => {
    const read = rise(club(() => ({ snapShare: 0.4 })));

    expect(read).toMatchObject({ reason: "depth", detail: "playing less" });
  });

  it("reads a healthy starter who has stopped dressing as benched", () => {
    const read = rise(club(() => ({ status: "INA" })));

    expect(read).toMatchObject({ reason: "depth", detail: "benched" });
  });

  it("reads a rise nobody at his position lost as a depth change", () => {
    const read = rise(club(() => ({ snapShare: 0.7 })));

    expect(read).toEqual({
      reason: "depth", fromWeek: 4, detail: "nobody lost them",
    });
  });

  it("does not read a teammate at another position", () => {
    const rows = club(() => ({ status: "RES" }))
      .map((r) => r.playerId === "chubb" ? { ...r, position: "WR" } : r);

    expect(rise(rows)?.detail).toBe("nobody lost them");
  });

  it("reads nothing where his snaps did not rise or he has three games", () => {
    const flat = club(() => ({ status: "RES" }));
    const rooms = roomsFrom(flat);

    expect(readRise(rooms, "ford", played([0.2, 0.2, 0.2, 0.2, 0.3, 0.2]), 6))
      .toBeUndefined();
    expect(readRise(rooms, "ford", played([0.2, 0.7, 0.7]), 3)).toBeUndefined();
  });

  it("reads nothing where the rosters do not have him", () => {
    expect(readRise(roomsFrom([]), "ford", played(BACKUP), 6)).toBeUndefined();
  });

  it("never reads a roster from after the cut", () => {
    // listed out through week 6 and put on injured reserve for week 7,
    // which the end of week 6 has not seen
    const rows = club((week) =>
      week <= 6 ? { status: "INA", listed: true } : { status: "RES" });

    expect(rise(rows, 6)).toMatchObject({ reason: "fill-in", detail: "listed" });
    expect(readRise(roomsFrom(rows), "ford", played([...BACKUP, 0.7]), 7))
      .toMatchObject({ reason: "promotion", detail: "reserve list" });
  });

  it("takes the games he rose in from the first of his last three over", () => {
    const shares = [0.2, 0.2, 0.2, 0.25, 0.25, 0.7];
    const rows = club((week) => week === 6 ? { status: "RES" } : { snapShare: 0.7 })
      .map((r) => r.playerId === "ford" && r.week <= 6
        ? { ...r, snapShare: shares[r.week - 1]! } : r);

    expect(readRise(roomsFrom(rows), "ford", played(shares), 6)).toMatchObject({
      reason: "promotion", fromWeek: 6,
    });
  });
});

describe("standingAt", () => {
  it("reads a man on the club's latest roster, active or not dressed, as with it", () => {
    const rooms = roomsFrom([room("chubb", 1), room("chubb", 2, { status: "INA" })]);

    expect(standingAt(rooms, "chubb", "CLE", 2)).toMatchObject({ gone: false });
  });

  it("reads a man missing from the club's latest roster as gone", () => {
    const rooms = roomsFrom([room("chubb", 1), room("ford", 2)]);

    expect(standingAt(rooms, "chubb", "CLE", 2)).toEqual({
      gone: true, detail: "released",
    });
  });

  it("reads the practice squad as released, and a reserve list as gone", () => {
    const rooms = roomsFrom([
      room("chubb", 1), room("chubb", 2, { status: "DEV" }),
      room("hunt", 1), room("hunt", 2, { status: "RES" }),
    ]);

    expect(standingAt(rooms, "chubb", "CLE", 2)).toEqual({
      gone: true, detail: "released",
    });
    expect(standingAt(rooms, "hunt", "CLE", 2)).toEqual({
      gone: true, detail: "reserve list",
    });
  });
});

describe("positionGroup", () => {
  it("keeps a fullback out of the tailbacks' room", () => {
    expect(positionGroup("RB", "FB")).toBe("FB");
    expect(positionGroup("RB", "RB")).toBe("RB");
    expect(positionGroup("WR")).toBe("WR");
    expect(positionGroup("T")).toBeUndefined();
  });
});
