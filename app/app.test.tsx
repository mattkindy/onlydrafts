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
        query="" byAdp={false} onMore={() => {}}
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
     * Value must fall as the board goes on. It did not: the list to
     * read the value curve against was taken before the board was
     * sorted, so Jonathan Taylor was shown worth more than Bijan
     * Robinson while sitting below him.
     */
    for (let i = 1; i < Math.min(80, men.length); i++) {
      expect(men[i]!.vor!).toBeLessThanOrEqual(men[i - 1]!.vor! + 0.001);
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
        query="" byAdp={false} onMore={() => {}}
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
  it("scores to the points beside it", async () => {
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
      // and it has to be the number printed beside it
      expect(Math.abs(payFor(scaled, league.pays) - (p.ppg ?? 0)), p.name)
        .toBeLessThan(0.11);
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
