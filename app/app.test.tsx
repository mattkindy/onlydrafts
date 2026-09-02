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
    season: 2026,
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

/**
 * The whole board opens as cards, so a test that wants the table has to
 * ask for it the way a reader does.
 */
const showTable = (at: HTMLElement) => {
  const button = Array.from(at.querySelectorAll(".how button"))
    .find((b) => b.textContent === "table") as HTMLButtonElement | undefined;

  button?.click();
};

/** the board itself, apart from the cards of your own drafted men */
const shortlist = (at: HTMLElement) => at.querySelector(".cards")!;

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

  it("draws the draft board", async () => {
    render(
      <DraftView
        men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order="rank" onMore={() => {}}
      />,
      where,
    );
    expect(where.querySelectorAll(".card").length).toBeGreaterThan(5);

    // the whole board is cards now, and the table is still a click away.
    // preact batches the redraw, so it lands on the next tick.
    showTable(where);
    await Promise.resolve();

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

  /**
   * The cards and the table are the same list drawn two ways now, so
   * only one is on screen at a time and a test that compares them has
   * to read the card, then ask for the table.
   */
  const firstRow = async () => {
    showTable(where);
    await Promise.resolve();

    return where.querySelector("table.ranks tbody tr")!;
  };

  it("says the same points per game on the card and in the table", async () => {
    // the pick leads the card now, so his rate is down among the facts
    const onCard = shortlist(where).querySelector(".facts")!.textContent!;
    const inTable = (await firstRow()).children[2]!.textContent!;

    expect(onCard).toContain(inTable);
  });

  it("leads the card with the pick the list is ordered by", async () => {
    const big = shortlist(where).querySelector(".big")!.textContent!;
    const first = (await firstRow()).children[0]!.textContent!;

    expect(big).toContain(first);
  });

  it("shows expected games next to both", async () => {
    const games = men[0]!.games!.toFixed(1);
    const onCard = shortlist(where).querySelector(".note")!.textContent!;

    expect(onCard).toContain(games);
    expect((await firstRow()).children[3]!.textContent).toBe(games);
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
        // the number is the line the card shows scored by his league,
        // not whatever the value curve said at his rank
        expect(
          Math.abs(payFor(p.simulated ?? p.projected!, at(rec)) - (p.ppg ?? 0)),
          p.name,
        ).toBeLessThan(0.06);
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
      const shown = p.simulated ?? p.projected!;
      const scaled = Object.fromEntries(
        Object.entries(shown).map(([k, v]) => [k, v * movedBy(p)]),
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

    /**
     * Each list on its own. The whole board is drawn as cards under the
     * shortlist and starts again from the best man, so reading every
     * card on the page as one run says Bijan Robinson comes after a
     * fiftieth pick.
     */
    for (const list of Array.from(where.querySelectorAll(".cards"))) {
      const shown = Array.from(list.querySelectorAll(".who"))
        .map((n) => n.textContent!);

      for (let i = 1; i < shown.length; i++) {
        expect(worth.get(shown[i]!)!, shown[i])
          .toBeLessThanOrEqual(worth.get(shown[i - 1]!)!);
      }
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

/**
 * Twelve teams start twelve defences, so twelve of them clear the last
 * starter at the position every year whatever happens. Reading a
 * defence that way and everybody else off the curve put +47 on a
 * defence at pick 128 next to -4 on the skill players around it, and
 * the card called both of them value.
 */
describe("a defence costs what the pick costs", () => {
  const men = boardFor(aLeague());

  it("never puts a later pick above an earlier one", () => {
    const inOrder = [...men]
      .filter((p) => p.rank !== undefined)
      .sort((a, b) => a.rank! - b.rank!);

    for (let i = 1; i < inOrder.length; i++) {
      const here = inOrder[i]!;
      const before = inOrder[i - 1]!;

      expect(here.vor!, `${here.position} ${here.name} at ${here.rank}`)
        .toBeLessThanOrEqual(before.vor!);
    }
  });

  it("keeps what he beats the last starter by as his own", () => {
    const defences = men
      .filter((p) => p.position === "DEF")
      .sort((a, b) => (b.ownVor ?? 0) - (a.ownVor ?? 0));

    // the one signal worth having about a defence, which is why it
    // survives the curve rather than being replaced by it
    expect(defences[0]!.ownVor!).toBeGreaterThan(0);
    expect(defences[0]!.ownVor!)
      .toBeGreaterThan(defences[defences.length - 1]!.ownVor!);
  });
});

/**
 * The two draft-night controls do different jobs and are easy to
 * conflate: one hides men you cannot start, the other reorders by what
 * a man adds to the lineup you have left.
 */
describe("drafting for what you still need", () => {
  const league = aLeague();
  const men = boardFor(league);
  const backs = men.filter((p) => p.position === "RB").slice(0, 4);
  const mine = new Set(backs.map((p) => p.key));

  const withMine = {
    ...NO_DRAFT,
    mine,
    taken: new Set(mine),
    grid: { teams: 12, rounds: 15, mySlot: 3, cells: {} },
    clock: { who: "you", mine: true, overall: 27, untilMine: 0 },
  };

  /**
   * The shortlist only. The page draws your own drafted men further
   * down in cards of their own, and counting those made the filter look
   * broken: the four backs it had correctly hidden from the shortlist
   * were still on screen, because you drafted them.
   */
  const namesIn = (where: HTMLElement) =>
    Array.from(where.querySelector(".cards")?.querySelectorAll(".who") ?? [])
      .map((n) => n.textContent!);

  it("says which slots are open and what the room has taken", () => {
    render(
      <DraftView men={men} state={withMine} teams={12} snake posFilter="ALL"
        query="" order="rank" slots={league.slots} onMore={() => {}} />,
      where,
    );

    expect(where.querySelector(".needs")).toBeTruthy();
    expect(where.textContent).toContain("you still need");
  });

  it("hides a position once you cannot start another of them", () => {
    render(
      <DraftView men={men} state={withMine} teams={12} snake posFilter="ALL"
        query="" order="rank" slots={league.slots} needOnly
        onMore={() => {}} />,
      where,
    );
    const shown = new Set(
      namesIn(where).map((name) => men.find((p) => p.name === name)?.position),
    );

    // four backs drafted fills both slots and the flexes, so a fifth
    // cannot start and the filter should have taken him out
    expect(shown.has("RB")).toBe(false);
    expect(shown.size).toBeGreaterThan(0);
  });

  it("reorders when weighted by need, and leaves the board alone otherwise", () => {
    render(
      <DraftView men={men} state={withMine} teams={12} snake posFilter="ALL"
        query="" order="rank" slots={league.slots} onMore={() => {}} />,
      where,
    );
    const byBoard = namesIn(where);

    const other = document.createElement("div");
    document.body.appendChild(other);
    render(
      <DraftView men={men} state={withMine} teams={12} snake posFilter="ALL"
        query="" order="war" slots={league.slots}
        onMore={() => {}} />,
      other,
    );
    const byWins = namesIn(other);

    expect(byWins.length).toBe(byBoard.length);
    expect(byWins).not.toEqual(byBoard);
  });
});

/**
 * The board had no idea who was hurt, which is the one fact a drafter
 * checks before every pick and the one the page could not answer.
 */
describe("who the league office has listed", () => {
  const league = aLeague();
  const men = boardFor(league);
  const hurtOne = men[2]!;
  const outOne = men[4]!;

  const state = {
    ...NO_DRAFT,
    hurt: {
      [hurtOne.key]: { status: "Questionable", part: "Hamstring" },
      [outOne.key]: { status: "IR", part: "Achilles" },
    },
  };

  it("puts the word on his card and the detail on the hover", () => {
    render(
      <DraftView men={men} state={state} teams={12} snake posFilter="ALL"
        query="" order="rank" slots={league.slots} onMore={() => {}} />,
      where,
    );
    const badges = Array.from(where.querySelectorAll(".card .badge"));
    const said = badges.map((b) => b.textContent);

    expect(said).toContain("questionable");
    expect(said).toContain("ir");
    expect(badges.find((b) => b.textContent === "questionable")
      ?.getAttribute("title")).toBe("Questionable, Hamstring");
  });

  /** questionable on a Sunday and out for the year read differently */
  it("tells a knock apart from a season ending one", () => {
    render(
      <DraftView men={men} state={state} teams={12} snake posFilter="ALL"
        query="" order="rank" slots={league.slots} onMore={() => {}} />,
      where,
    );
    const classOf = (word: string) =>
      Array.from(where.querySelectorAll(".card .badge"))
        .find((b) => b.textContent === word)?.className ?? "";

    expect(classOf("questionable")).toContain("warn");
    expect(classOf("ir")).toContain("bad");
  });

  it("says nothing about a man with nothing wrong with him", () => {
    render(
      <DraftView men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order="rank" slots={league.slots} onMore={() => {}} />,
      where,
    );

    expect(where.querySelectorAll(".card .badge").length).toBe(0);
  });
});

/**
 * The card was a per-game number and two rows of chips. At a draft the
 * question is where he goes and how he could finish, so the pick leads,
 * the bar under it is picks rather than points, and the categories
 * share one set of headings instead of repeating them.
 */
describe("the card reads like a draft card", () => {
  const league = aLeague();
  const men = boardFor(league);

  const draw = (order: "rank" | "adp") => {
    const at = document.createElement("div");
    document.body.appendChild(at);
    render(
      <DraftView men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order={order} slots={league.slots} onMore={() => {}} />,
      at,
    );

    return at;
  };

  it("leads with whichever pick the list is sorted by", () => {
    const byOurs = draw("rank").querySelector(".card .big")!.textContent!;
    const byRoom = draw("adp").querySelector(".card .big")!.textContent!;

    expect(byOurs).toContain("ours");
    expect(byOurs).toContain("adp");
    expect(byRoom.indexOf("adp")).toBeLessThan(byRoom.indexOf("ours"));
  });

  it("draws the room's range and our pick on one scale of picks", () => {
    const at = draw("rank");
    const board = at.querySelector(".card .board")!;

    expect(board.querySelector(".room")).toBeTruthy();
    expect(board.querySelector(".ours")).toBeTruthy();
    // and no points spread beside it, which is the thing it replaced
    expect(at.querySelector(".card .range")).toBeNull();
  });

  it("says how he could finish at his position", () => {
    const at = draw("rank");

    expect(at.querySelector(".card .finish")!.textContent)
      .toContain("could finish");
  });

  it("gives the two stat rows one set of headings", () => {
    const at = draw("rank");
    const table = at.querySelector(".card table.line")!;
    const rows = Array.from(table.querySelectorAll("tbody tr"));

    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.children[0]!.textContent))
      .toEqual(["season", "a game"]);
    expect(table.querySelectorAll("thead th").length)
      .toBe(rows[0]!.children.length);
  });
});

/**
 * The whole board was a table because seven hundred cards at once is
 * slow. A page at a time is not, and a row of numbers cannot say what a
 * card says.
 */
describe("the whole board as cards", () => {
  const league = aLeague();
  const men = boardFor(league);

  const draw = () => {
    const at = document.createElement("div");
    document.body.appendChild(at);
    render(
      <DraftView men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order="rank" slots={league.slots} onMore={() => {}} />,
      at,
    );

    return at;
  };

  it("opens as cards, without waiting to be asked", () => {
    const at = draw();

    expect(at.querySelectorAll(".cards").length).toBe(1);
    expect(at.querySelector("table.ranks")).toBeNull();
  });

  /**
   * One list and not two. A shortlist of the next two dozen used to sit
   * above this saying the same men in the same order, from when cards
   * were the only place a man was drawn properly.
   */
  it("draws a page of them rather than the whole file", () => {
    const at = draw();

    expect(at.querySelectorAll(".card").length).toBe(60);
    expect(at.textContent).toContain("show 60 more");
  });

  it("takes the next page when asked", async () => {
    const at = draw();
    const more = Array.from(at.querySelectorAll("button"))
      .find((b) => b.textContent!.startsWith("show ")) as HTMLButtonElement;

    more.click();
    await Promise.resolve();

    expect(at.querySelectorAll(".card").length).toBe(120);
  });

  it("still has the table for looking a man up", async () => {
    const at = draw();

    showTable(at);
    await Promise.resolve();

    expect(at.querySelectorAll("table.ranks tbody tr").length).toBe(men.length);
  });
});

/**
 * You have to start a kicker and a defence, so what a pick at their
 * place on the board is worth answers a question nobody is asking:
 * there is no lineup without one. Every kicker read a negative value
 * next to a positive one labelled ours alone, twenty one points apart.
 */
describe("a slot you cannot leave empty", () => {
  const league = aLeague();
  const men = boardFor(league);

  const cardFor = (position: string) => {
    const at = document.createElement("div");
    document.body.appendChild(at);
    render(
      <DraftView men={men} state={NO_DRAFT} teams={12} snake
        posFilter={position} query="" order="rank" slots={league.slots}
        onMore={() => {}} />,
      at,
    );

    return at.querySelector(".card")!;
  };

  it("leads a kicker and a defence with what he beats the wire by", () => {
    for (const position of ["K", "DEF"]) {
      const card = cardFor(position);

      expect(card.textContent, position).toContain("over the wire");
      expect(card.textContent, position).not.toContain("value here");
    }
  });

  it("says it once, not twice", () => {
    for (const position of ["K", "DEF"]) {
      expect(cardFor(position).textContent, position)
        .not.toContain("ours alone");
    }
  });

  it("leaves everybody else on what the pick is worth", () => {
    const card = cardFor("RB");

    expect(card.textContent).toContain("value here");
    expect(card.textContent).not.toContain("over the wire");
  });
});

/**
 * The board ships a few men at a tenth of a point a game, and the
 * spread on the card is moved by the ratio of what he scores here to
 * what the file had. Off a tenth that ratio runs away: Travis Homer
 * came out with a sixty seven point week, a season low of minus a
 * hundred and fifty six, and a claim on finishing second among backs.
 */
describe("a man too thin to have a spread", () => {
  const league = aLeague();
  const men = boardFor(league);

  it("is given no spread rather than an enormous one", () => {
    const thin = men.filter((p) => (p.ppg ?? 0) > 0 && (p.ppg ?? 0) < 3);

    expect(thin.length).toBeGreaterThan(0);

    /**
     * The shape of a spread survives the scaling, since every figure
     * moves by the same ratio, so this is the file's own opinion of how
     * a man varies. Fifteen passes the widest we ship, which is a
     * fringe receiver at fourteen, and catches Homer at fifty six.
     */
    for (const p of men) {
      if (!p.game?.["ev"]) {
        continue;
      }

      expect(p.game["high"]! / p.game["ev"]!, p.name).toBeLessThan(15);
    }
  });

  it("never claims a season worth minus a hundred points", () => {
    for (const p of men) {
      if (p.sim) {
        expect(p.sim["low"]!, p.name).toBeGreaterThan(-100);
      }
    }
  });
});

/**
 * Two men on the same average are not the same bet. Brock Purdy's
 * simulated seasons run 15 to 262 where C.J. Stroud's run 114 to 324,
 * and a single number cannot say so. His are skewed too, so his average
 * is a figure he beats less than half the time.
 */
describe("what a man is worth, over the middle of his seasons", () => {
  const men = boardFor(aLeague());

  it("gives a band that contains its own middle", () => {
    const withBands = men.filter((p) => p.par);

    expect(withBands.length).toBeGreaterThan(100);

    for (const p of withBands) {
      expect(p.par!.low, p.name).toBeLessThanOrEqual(p.par!.mid);
      expect(p.par!.mid, p.name).toBeLessThanOrEqual(p.par!.high);
    }
  });

  /**
   * A man who misses half a year is a wider bet than one who does not,
   * whatever the two averages say, and that is the thing the band is
   * for.
   */
  it("is wider for a man the simulation is less sure of", () => {
    const wide = men
      .filter((p) => p.par && (p.games ?? 17) < 11 && (p.ppg ?? 0) > 12);
    const sure = men
      .filter((p) => p.par && (p.games ?? 17) > 15 && (p.ppg ?? 0) > 12);

    expect(wide.length).toBeGreaterThan(0);
    expect(sure.length).toBeGreaterThan(0);

    const spread = (its: typeof men) =>
      its.reduce((sum, p) => sum + (p.par!.high - p.par!.low), 0) / its.length;

    expect(spread(wide)).toBeGreaterThan(spread(sure));
  });

  it("draws it on the card next to the number it qualifies", () => {
    render(
      <DraftView men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order="rank" slots={aLeague().slots} onMore={() => {}} />,
      where,
    );

    expect(where.querySelector(".card .facts")!.textContent)
      .toContain("over a season");
  });
});

/**
 * Whatever the list is sorted by has to lead the card. Ordering by the
 * weeks a man wins you while the card led with his place on our board
 * put Puka Nacua top of the list with 1.08 beside him, which reads as a
 * broken sort.
 */
describe("the card leads with the order it is in", () => {
  const league = aLeague();
  const men = boardFor(league);

  const draw = (order: "war" | "rank" | "adp") => {
    const at = document.createElement("div");
    document.body.appendChild(at);
    render(
      <DraftView men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order={order} slots={league.slots} onMore={() => {}} />,
      at,
    );

    return at.querySelector(".card .big")!.textContent!;
  };

  it("leads with the weeks he wins you when that is the order", () => {
    const big = draw("war");

    expect(big).toContain("weeks won");
    expect(big).toContain("%");
    // and his place on our board goes underneath, small
    expect(big).toContain("ours");
  });

  it("leads with our own place when that is the order", () => {
    const big = draw("rank");

    expect(big).toContain("ours");
    expect(big).not.toContain("weeks won");
  });

  it("leads with the room's place when that is the order", () => {
    const big = draw("adp");

    expect(big.indexOf("adp")).toBeLessThan(big.indexOf("ours"));
  });

  it("puts the man it leads with at the top of the list", () => {
    const at = document.createElement("div");
    document.body.appendChild(at);
    render(
      <DraftView men={men} state={NO_DRAFT} teams={12} snake posFilter="ALL"
        query="" order="war" slots={league.slots} onMore={() => {}} />,
      at,
    );
    const shown = Array.from(at.querySelectorAll(".cards .card .big"))
      .slice(0, 6)
      .map((n) => Number(n.textContent!.match(/([\d.]+)%/)?.[1] ?? 0));

    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]!).toBeLessThanOrEqual(shown[i - 1]!);
    }
  });
});
