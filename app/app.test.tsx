/**
 * The views, rendered against the files the build ships.
 *
 * Everything else in here is checked by running the numbers in node,
 * which says nothing about whether a view draws them. One that throws
 * halfway through leaves a blank panel and no error anybody sees.
 *
 * Nothing is fetched. A league is built from the top of the board the
 * way a provider hands one back, so the views that need a roster have
 * one without the test depending on the network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact";
import { beforeEach, describe, expect, it } from "vitest";

import { rescore } from "./lib/board.ts";
import type { Player } from "./lib/scoring.ts";
import type { League } from "./lib/providers.ts";
import { Roster } from "./views/Roster.tsx";
import { Keepers } from "./views/Keepers.tsx";
import { DraftView } from "./views/Draft.tsx";
import { PlayerSheet } from "./views/PlayerSheet.tsx";

const DATA = join(import.meta.dirname, "..", "docs", "data");
const file = JSON.parse(readFileSync(join(DATA, "board-2026.json"), "utf8")) as {
  players: Player[];
};

const STANDARD = {
  pass_yd: 0.04, pass_td: 4, int: -2, rush_yd: 0.1, rush_td: 6,
  rec_yd: 0.1, rec_td: 6, fum_lost: -2,
};
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"];

function aLeague(named = "Mildred League XIV", team = "mattkindy"): League {
  const men = file.players.filter((p) => p.position !== "DEF").slice(0, 60);
  const mine = men.slice(0, 12);
  const others = ["tarpey", "brad", "jake", "conti", "brando"];
  const every = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

  return {
    provider: "sleeper",
    leagueId: "1315886179668729856",
    name: named,
    size: 12,
    pays: STANDARD,
    slots: SLOTS,
    userId: "u-kindy",
    team,
    members: { "u-kindy": team },
    draftSlot: 3,
    snake: true,
    myPicks: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    myRoster: mine.map((p) => ({ name: p.name, key: p.key, pos: p.position })),
    allRosters: [
      {
        owner: team,
        picks: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        keys: mine.map((p) => ({ name: p.name, key: p.key, pos: p.position })),
      },
      ...others.map((who, i) => ({
        owner: who,
        picks: every,
        keys: men.slice(12 + i * 8, 20 + i * 8)
          .map((p) => ({ name: p.name, key: p.key, pos: p.position })),
      })),
    ],
  };
}

const boardFor = (league: League) =>
  rescore(file.players, {
    teams: league.size, slots: league.slots, pays: league.pays,
  });

const NO_DRAFT = {
  taken: new Set<string>(), mine: new Set<string>(),
  teams: {}, rosteredBy: {}, grid: null,
};

let where: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  where = document.createElement("div");
  document.body.appendChild(where);
});

describe("the views", () => {
  const league = aLeague();
  const men = boardFor(league);
  const byKey = new Map(men.map((p) => [p.key, p]));

  it("draws your roster", () => {
    render(
      <Roster
        byKey={byKey} league={league} season={2026} perTeam={3}
        marked={{}} onMark={() => {}} onMore={() => {}}
      />,
      where,
    );
    expect(where.querySelectorAll(".card").length).toBeGreaterThan(5);
  });

  it("draws the keeper sheet", () => {
    render(
      <Keepers
        men={men} byKey={byKey} league={league} perTeam={3}
        onMore={() => {}} onChange={() => {}}
      />,
      where,
    );
    expect(where.querySelectorAll(".card").length).toBeGreaterThan(5);
  });

  it("only talks about men on your roster", () => {
    render(
      <Keepers
        men={men} byKey={byKey} league={league} perTeam={3}
        onMore={() => {}} onChange={() => {}}
      />,
      where,
    );
    const onMyRoster = new Set(league.myRoster.map((m) => m.name));

    for (const who of Array.from(where.querySelectorAll(".who"))) {
      expect(onMyRoster.has(who.textContent!.trim())).toBe(true);
    }
  });

  it("draws the draft board", () => {
    render(
      <DraftView
        men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order="rank" onMore={() => {}}
      />,
      where,
    );
    expect(where.querySelectorAll(".card").length).toBeGreaterThan(5);
    expect(where.querySelectorAll("table.ranks tbody tr").length)
      .toBe(men.length);
  });

  it("draws one man's card", () => {
    render(
      <PlayerSheet
        p={men[0]!} plus={["a factor"]} minus={[]} teams={12}
        kept={false} onKeep={() => {}} onClose={() => {}}
      />,
      where,
    );
    expect(where.textContent).toContain(men[0]!.name);
    expect(where.querySelectorAll(".wk").length).toBeGreaterThan(5);
  });
});

describe("the board in a league's terms", () => {
  it("gives the best value to whoever it has first", () => {
    const men = boardFor(aLeague())
      .filter((p) => !["K", "DEF"].includes(p.position));

    expect(men.length).toBeGreaterThan(20);

    /**
     * Value is read off the board's own order, so it falls down the
     * page. It did not always: the list to read it against was taken
     * before the sort, so Jonathan Taylor was shown worth more than
     * Bijan Robinson while sitting below him.
     */
    for (let i = 1; i < Math.min(80, men.length); i++) {
      expect(men[i]!.vor!, men[i]!.name)
        .toBeLessThanOrEqual(men[i - 1]!.vor! + 0.001);
    }
  });

  it("is put back in order when another league is chosen", () => {
    const first40 = (men: Player[]) =>
      men.slice(0, 40).map((p) => p.key).join(",");
    const standard = boardFor(aLeague());
    const ppr = rescore(file.players, {
      teams: 12,
      slots: SLOTS,
      pays: { ...STANDARD, rec: 1 },
    });

    expect(first40(ppr)).not.toEqual(first40(standard));
  });

  it("reads the same board twice the same way", () => {
    const once = boardFor(aLeague());
    const twice = boardFor(aLeague());

    expect(twice.map((p) => [p.key, p.vor]))
      .toEqual(once.map((p) => [p.key, p.vor]));
  });
});

/**
 * League and team names come from Sleeper and ESPN, which is to say
 * from whoever else is in the league. The old page put them into the
 * document as markup, which let a teammate run their own script here,
 * next to the cookies kept for espn.
 */
describe("a name somebody else chose", () => {
  const NASTY = '<img src=x onerror=alert(1)><script>alert(2)</script>';

  it("is drawn as text, not as markup", () => {
    const league = aLeague(NASTY, NASTY);
    const men = boardFor(league);

    render(
      <Roster
        byKey={new Map(men.map((p) => [p.key, p]))}
        league={league} season={2026} perTeam={3}
        marked={{}} onMark={() => {}} onMore={() => {}}
      />,
      where,
    );

    expect(where.querySelectorAll("script").length).toBe(0);
    expect(where.querySelectorAll("img").length).toBe(0);
    expect(where.textContent).toContain(NASTY);
  });
});

/**
 * The card shows a rate and orders by a season, and for a while the two
 * were drawn from different fields: the same man read 20.1 in the table
 * and 19.8 on his card. Expected games is what reconciles them, so it
 * has to be on screen in both places.
 */
describe("the rate and the season agree", () => {
  const league = aLeague();
  const men = boardFor(league);

  beforeEach(() => {
    render(
      <DraftView
        men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order="rank" onMore={() => {}}
      />,
      where,
    );
  });

  it("says the same points per game on the card and in the table", () => {
    const onCard = where.querySelector(".card .big")!.textContent!;
    const row = where.querySelector("table.ranks tbody tr")!;
    const inTable = row.children[2]!.textContent!;

    expect(onCard).toContain(inTable);
  });

  it("shows expected games next to both", () => {
    const first = men[0]!;
    const games = first.games!.toFixed(1);

    expect(where.querySelector(".card .note")!.textContent).toContain(games);
    expect(where.querySelector("table.ranks tbody tr")!.children[3]!.textContent)
      .toBe(games);
  });

  it("takes expected games from the simulation, not a flat season", () => {
    // every man at 17 games is what happens when nothing reads sim.games,
    // and it quietly changes every value on the board
    expect(men.some((p) => p.games !== 17)).toBe(true);
  });
});

/**
 * The point of putting his line on the card is that the number beside
 * it can be checked. So it has to add up: what a league pays for the
 * line has to be what the card says he scores.
 */
describe("the line on the card adds up", () => {
  it("prints his own points under his own league's rules", async () => {
    const { payFor } = await import("./lib/scoring.ts");
    const at = (rec: number) => ({
      rec, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6,
      pass_yd: 0.04, pass_td: 4,
    });

    for (const rec of [0, 0.5, 1]) {
      const men = rescore(file.players, { teams: 12, slots: SLOTS, pays: at(rec) })
        .filter((p) => p.projected);

      for (const p of men.slice(0, 40)) {
        // the card's number is his line scored by his league, and
        // nothing else. It used to be whatever the value curve said at
        // his rank, which printed 18 for a man the league scores at 22.9
        expect(Math.abs(payFor(p.projected!, at(rec)) - (p.ppg ?? 0)), p.name)
          .toBeLessThan(0.06);
      }
    }
  });

  /**
   * Value is what a pick at his place on the board is worth, so it runs
   * down the board by construction. His own projected value is still
   * there as his games times his gap to a replacement, and the two
   * differ because the order is four opinions and his points are one.
   */
  it("reads value off the board's own order", () => {
    const men = boardFor(aLeague())
      .filter((p) => !["K", "DEF"].includes(p.position) && p.projected);

    for (let i = 1; i < Math.min(80, men.length); i++) {
      expect(men[i]!.vor!, men[i]!.name)
        .toBeLessThanOrEqual(men[i - 1]!.vor! + 0.001);
    }

    // his own is still worked out, and still checks against his line
    for (const p of men.slice(0, 20)) {
      expect((p.games ?? 17) * (p.perGameVor ?? 0)).toBeGreaterThan(-500);
    }
  });

  it("scores a season to the points a game beside it", async () => {
    const { lineOver } = await import("./lib/statLine.ts");
    const { payFor } = await import("./lib/scoring.ts");
    const league = aLeague();
    const men = boardFor(league).filter((p) => p.projected);

    expect(men.length).toBeGreaterThan(100);

    for (const p of men.slice(0, 60)) {
      // what a reader works out from the line on his card, scaled the
      // way the card scales it
      const { movedBy } = await import("./lib/statLine.ts");
      const scaled = Object.fromEntries(
        Object.entries(p.projected!).map(([k, v]) => [k, v * movedBy(p)]),
      );
      // the card shows a season, so a reader divides by the games shown
      // beside it to get back to the points a game
      const overASeason = Object.fromEntries(
        Object.entries(scaled).map(([k, v]) => [k, v * p.games!]),
      );
      const aGame = payFor(overASeason, league.pays) / p.games!;
      expect(Math.abs(aGame - (p.ppg ?? 0)), p.name).toBeLessThan(0.11);
    }
  });

  it("shows a season as the game line times the games", async () => {
    const { lineOver } = await import("./lib/statLine.ts");
    const men = boardFor(aLeague()).filter((p) => p.projected && p.games);
    const p = men[0]!;
    const aGame = lineOver(p.projected, p.position, 1);
    const aSeason = lineOver(p.projected, p.position, p.games!);

    expect(aSeason.length).toBe(aGame.length);

    for (let i = 0; i < aGame.length; i++) {
      expect(aSeason[i]!.value).toBeCloseTo(aGame[i]!.value * p.games!, 4);
    }
  });

  it("gives each position the categories it is read by", async () => {
    const { lineOver } = await import("./lib/statLine.ts");
    const men = boardFor(aLeague());
    const labels = (position: string) => {
      const p = men.find((m) => m.position === position && m.projected);

      return p ? lineOver(p.projected, position, 1).map((f) => f.label) : [];
    };

    expect(labels("QB")).toContain("pass yds");
    expect(labels("QB")).not.toContain("rec");
    expect(labels("RB")).toContain("rush yds");
    expect(labels("WR")).toContain("rec yds");
    expect(labels("WR")).not.toContain("pass yds");
  });
});

/**
 * A week says what it is worth and how far that could be out, and does
 * not say a stat line. A defence keeps about a fifth of itself into the
 * next, so the weeks cannot be told apart in August and printing a
 * line for each would invent a difference.
 */
describe("a week row keeps its shape", () => {
  it("says the week, the opponent, the bar and the points", async () => {
    const { PlayerSheet } = await import("./views/PlayerSheet.tsx");
    const men = boardFor(aLeague());
    const p = men.find((m) => (m.weeks?.length ?? 0) > 0 && m.projected)!;

    render(
      <PlayerSheet
        p={p} plus={[]} minus={[]} teams={12} kept={false}
        onKeep={() => {}} onClose={() => {}}
      />,
      where,
    );

    const row = where.querySelector(".wk")!;
    expect(Array.from(row.children).map((k) => k.className || "plain"))
      .toEqual(["plain", "plain", "bar", "wkpts"]);
    expect(where.querySelector(".wkline")).toBeNull();

    // the average barely moves, so the row has to say the swing as well
    const said = row.querySelector(".wkpts")!;
    expect(said.querySelector("em")!.textContent).toMatch(/\d+ to \d+/);
  });
});

/**
 * A league paying nothing for a catch and no league at all both score
 * the same way, so the board has to say which it is. Matt had to work
 * out from a stat line whether his own league had been read.
 */
describe("the scoring in play is on screen", () => {
  it("names it from what the league pays", async () => {
    const { roomFor } = await import("./lib/board.ts");

    expect(roomFor({ rec: 0, rec_yd: 0.1 })).toBe("standard");
    expect(roomFor({ rec: 0.5, rec_yd: 0.1 })).toBe("half");
    expect(roomFor({ rec: 1, rec_yd: 0.1 })).toBe("ppr");
    // nothing connected reads as standard, which is why it is shown
    expect(roomFor({})).toBe("standard");
  });

  it("scores a man by what his league pays and not by a guess", async () => {
    const { payFor } = await import("./lib/scoring.ts");
    const line = { rushYds: 116.5, rushTd: 0.64, receptions: 4.53, recYds: 42.49, recTd: 0.15 };

    expect(payFor(line, { rec: 0, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6 }))
      .toBeCloseTo(20.65, 1);
    expect(payFor(line, { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6 }))
      .toBeCloseTo(25.18, 1);
  });
});

/**
 * A league saved in a browser by an older build may have no scoring on
 * it. Reading it used to throw while drawing the league list, and a
 * throw in Preact leaves the page on whatever it drew last, which was
 * "reading the board" and looked exactly like the site being down.
 */
describe("a league saved by an older build", () => {
  it("does not bring the page down", async () => {
    const { roomFor } = await import("./lib/board.ts");

    expect(roomFor(undefined)).toBe("standard");
    expect(roomFor(null)).toBe("standard");
    expect(roomFor({})).toBe("standard");
  });

  it("still scores a board when the league says nothing", () => {
    const men = rescore(file.players, { teams: 12, slots: SLOTS, pays: {} });

    expect(men.length).toBeGreaterThan(500);
    expect(men[0]!.ppg).toBeGreaterThan(0);
  });
});

describe("a render that throws", () => {
  it("says so instead of leaving the page where it was", async () => {
    const { Component } = await import("preact");

    // the boundary is a class component with getDerivedStateFromError,
    // which is what turns a throw into a message rather than a freeze
    const main = readFileSync(join(import.meta.dirname, "main.tsx"), "utf8");
    expect(main).toContain("getDerivedStateFromError");
    expect(main).toContain("forget and start over");
    expect(Component).toBeTruthy();
  });
});

/**
 * What a card calls value is what a pick at his place on the board is
 * worth, so the list in that order runs down it. His points stay his
 * own and are not touched by this, which is what the old curve got
 * wrong when it moved both.
 */
describe("the draft list runs down the value", () => {
  const men = boardFor(aLeague());
  const state = {
    taken: new Set<string>(), mine: new Set<string>(),
    teams: {}, rosteredBy: {}, grid: null,
  };

  it("never puts a bigger value below a smaller one", () => {
    render(
      <DraftView men={men} state={state} teams={12} snake posFilter="ALL"
        query="" order="rank" onMore={() => {}} />,
      where,
    );
    const worth = new Map(men.map((p) => [p.name, p.vor ?? 0]));
    const shown = Array.from(where.querySelectorAll(".card .who"))
      .map((n) => n.textContent!);

    for (let i = 1; i < shown.length; i++) {
      expect(worth.get(shown[i]!)!, shown[i])
        .toBeLessThanOrEqual(worth.get(shown[i - 1]!)!);
    }
  });
});

/**
 * The keeper sheet works in both the season figure and the game one.
 * What a pick buys and what a man is worth against it come off the
 * season; which alternative to show comes off the game. Leaving one his
 * own and the other the board's let the two disagree about the same
 * player, so both are the board's and they have to still relate.
 */
describe("the keeper sheet works on one scale", () => {
  it("keeps the season figure and the game one in step", () => {
    const men = boardFor(aLeague())
      .filter((p) => !["K", "DEF"].includes(p.position));

    for (const p of men.slice(0, 200)) {
      expect(Math.abs((p.perGameVor ?? 0) * (p.games ?? 17) - (p.vor ?? 0)), p.name)
        .toBeLessThan(2);
    }
  });

  it("adds up on the sheet", async () => {
    const { keeperSums, pickForRound } = await import("./lib/picks.ts");
    const men = boardFor(aLeague());
    const draft = {
      teams: 12, slot: 3, snake: true, myRounds: null, taken: new Set<string>(),
    };
    const p = men.find((m) => m.projected)!;
    const costPick = pickForRound(3, draft);
    const sums = keeperSums(men, p, costPick, draft);

    // keeping gains is what he is worth less what the pick buys
    expect(sums.roi).toBeCloseTo((p.vor ?? 0) - sums.rate, 1);
    // and what it is worth keeping him is that, less waiting for him
    expect(sums.net).toBeCloseTo(sums.roi - sums.wait.gain, 1);
  });
});

/**
 * The big value is what a pick at his place on the board is worth, and
 * the board is four opinions of which his projection is the smallest.
 * So the top card can show a number that belongs to the man below it.
 * Both are on the card now, and the chip says which is his.
 */
describe("a card shows both values when they disagree", () => {
  it("keeps his own beside the board's", () => {
    const men = boardFor(aLeague())
      .filter((p) => !["K", "DEF"].includes(p.position));

    // his own is worked out from his own points, so a man who scores
    // more than another at his position is worth more by it
    const backs = men.filter((p) => p.position === "RB" && p.projected)
      .slice(0, 30);

    for (const p of backs) {
      expect(p.ownVor, p.name).toBeDefined();
    }

    const byPoints = [...backs].sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0));
    const byOwn = [...backs].sort((a, b) => (b.ownVor ?? 0) - (a.ownVor ?? 0));
    // not identical, because games played come into it as well
    expect(byOwn[0]!.ownVor!).toBeGreaterThan(byOwn[byOwn.length - 1]!.ownVor!);
    expect(byPoints.length).toBe(byOwn.length);

    // and they do disagree, which is the whole reason to show both
    const apart = men.slice(0, 40)
      .filter((p) => Math.abs((p.ownVor ?? 0) - (p.vor ?? 0)) >= 10);
    expect(apart.length).toBeGreaterThan(3);
  });

  it("draws the chip on a man the room and the model disagree about", () => {
    const men = boardFor(aLeague());
    const p = men.find((m) =>
      Math.abs((m.ownVor ?? 0) - (m.vor ?? 0)) >= 10 && m.projected)!;

    render(
      <DraftView men={[p, ...men.filter((m) => m !== p)]} state={NO_DRAFT}
        teams={12} snake posFilter="ALL" query="" order="rank" onMore={() => {}} />,
      where,
    );

    expect(where.textContent).toContain("ours alone");
  });
});
