/**
 * The page, rendered against the files the build ships.
 *
 * Everything else in here is checked by running the numbers in node,
 * which says nothing about whether the page draws them. A view that
 * throws halfway through leaves a blank panel and no error anybody
 * sees, and the draft is the one day there is no time to debug it.
 *
 * Sleeper is not called. A league is written into storage the way the
 * app writes one after a lookup, so the views that need a roster have
 * one without the test depending on the network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const PAGE = join(ROOT, "docs", "weekly", "index.html");
const DATA = join(ROOT, "docs", "weekly", "data");

const board = JSON.parse(
  readFileSync(join(DATA, "board-2026.json"), "utf8"),
) as { players: { name: string; key: string; position: string }[] };

/**
 * The same shape a provider hands back, with rosters taken off the top
 * of the board. It used to be filled from a keeper sheet, which no
 * longer ships, since prices belong to one league and this serves any.
 */
function aLeague() {
  const men = board.players.filter((p) => p.position !== "DEF").slice(0, 60);
  const mine = men.slice(0, 12).map((p) => ({ ...p, player: p.name }));
  const others = ["tarpey", "brad", "jake", "conti", "brando"];

  return {
    leagueId: "1315886179668729856",
    name: "Mildred League XIV",
    size: 12,
    userId: "u-kindy",
    team: "mattkindy",
    season: "2026",
    draftSlot: 3,
    snake: true,
    members: { "u-kindy": "mattkindy" },
    myPicks: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    myRoster: mine.map((e) => ({ name: e.player, key: e.key })),
    allRosters: [
      {
        owner: "mattkindy",
        picks: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        keys: mine.map((e) => ({ name: e.player, key: e.key, pos: "WR" })),
      },
      ...others.map((team) => ({
        owner: team,
        picks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        keys: men.slice(12 + others.indexOf(team) * 8, 20 + others.indexOf(team) * 8)
          .map((p) => ({ name: p.name, key: p.key, pos: p.position })),
      })),
    ],
  };
}

async function openPage(withLeague: boolean) {
  const dom = new JSDOM(readFileSync(PAGE, "utf8"), {
    runScripts: "outside-only",
    url: "https://example.test/weekly/",
  });
  const { window } = dom;
  const store: Record<string, string> = {};

  if (withLeague) {
    const league = aLeague();
    // the app prefixes everything it saves
    store["dc.leagues"] = JSON.stringify([league]);
    store["dc.active"] = JSON.stringify(league);
  }

  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
    },
  });

  // The files the build wrote, and empty answers for Sleeper, so a
  // view that reaches out draws whatever it draws with nothing back
  // rather than the test depending on the network.
  window.fetch = (async (url: string) => {
    const address = String(url);

    if (address.includes("api.sleeper.app")) {
      const empty = address.includes("/players/") ? {} : [];
      return { ok: true, json: async () => empty };
    }

    const name = address.split("/").pop()!.split("?")[0]!;

    try {
      // read it now, so a file that is not there is caught here rather
      // than thrown later out of json()
      const text = readFileSync(join(DATA, name), "utf8");
      return { ok: true, json: async () => JSON.parse(text) };
    } catch {
      return { ok: false, json: async () => null };
    }
  }) as never;

  const failures: string[] = [];
  window.addEventListener("error", (e: any) => failures.push(String(e.message)));

  const script = readFileSync(PAGE, "utf8")
    .split("<script>")[1]!.split("</script>")[0]!;
  // the page keeps its own names to itself, so hand out the few this
  // needs rather than reaching into a scope that is not ours
  window.eval(
    script +
      "\nwindow.__page = { ready, setView, renderView, " +
      "theBoard: () => board, setLeague: (lg) => { active = lg; " +
      "rescoreBoard(); return active; } };",
  );
  // boot() is started at the end of the script and the page is not
  // usable until it settles
  await (window as any).__page.ready;
  await new Promise((done) => window.setTimeout(done, 50));

  return { window, failures };
}

const VIEWS = ["leagues", "roster", "keepers", "draft", "start", "waivers"];

describe("the weekly page", () => {
  let page: Awaited<ReturnType<typeof openPage>>;

  beforeEach(async () => {
    page = await openPage(true);
  });

  it("boots without throwing and shows a toolbar", async () => {
    expect(page.failures).toEqual([]);
    expect(page.window.document.getElementById("out")).not.toBeNull();
  });

  for (const view of VIEWS) {
    it(`draws the ${view} view`, async () => {
      const { window } = page;
      const ui = (window as any).__page;
      ui.setView(view);
      await ui.renderView();
      await new Promise((done) => window.setTimeout(done, 200));

      const out = window.document.getElementById("out")!;
      const status = window.document.getElementById("status")!;
      expect(page.failures).toEqual([]);
      // the page marks a failure by colouring the status line, and
      // leaves plain progress messages uncoloured
      expect(`${view}: ${status.className} ${status.textContent}`.trim())
        .not.toContain("bad");
      expect(out.innerHTML.length).toBeGreaterThan(0);
    });
  }

  it("prices every keeper against a man at his own position", async () => {
    const { window } = page;
    const ui = (window as any).__page;
    ui.setView("keepers");
    await ui.renderView();
    await new Promise((done) => window.setTimeout(done, 400));

    const notes = [...window.document.querySelectorAll(".note")]
      .map((n) => n.textContent ?? "");
    expect(notes.length).toBeGreaterThan(0);

    // the sheet decides who is eligible, so a man it leaves out must
    // not turn up on the page at all
    const shown = [...window.document.querySelectorAll(".who")]
      .map((n) => n.textContent ?? "");
    // whoever is on your roster is who the keeper page may talk about
    const onMyRoster = new Set(aLeague().myRoster.map((m) => m.name));

    for (const name of shown) {
      expect(onMyRoster.has(name.replace(/\s*\(.*\)$/, "").trim())).toBe(true);
    }
  });

  it("sends you to the league list when none is chosen", async () => {
    const bare = await openPage(false);
    expect(bare.failures).toEqual([]);
    expect(bare.window.document.getElementById("subnav")!.hidden).toBe(true);
  });

  it("gives the best value to whoever the board has first", async () => {
    const { window } = page;
    const ui = (window as any).__page;
    ui.setView("draft");
    await ui.renderView();
    await new Promise((done) => window.setTimeout(done, 400));

    /**
     * Value must fall as the board goes on. It did not: the list of
     * men to read the value curve against was taken before the board
     * was sorted, so Jonathan Taylor was shown worth more than Bijan
     * Robinson while sitting below him.
     */
    const skill = ui.theBoard().players
      .filter((p: { position: string }) => !["K", "DEF"].includes(p.position));

    expect(skill.length).toBeGreaterThan(20);

    for (let i = 1; i < Math.min(80, skill.length); i++) {
      expect(skill[i].vor).toBeLessThanOrEqual(skill[i - 1].vor + 0.001);
    }
  });

  it("puts the board back in order when another league is chosen", async () => {
    const { window } = page;
    const ui = (window as any).__page;
    ui.setView("draft");
    await ui.renderView();
    await new Promise((done) => window.setTimeout(done, 300));

    const orderNow = () => ui.theBoard().players.slice(0, 40)
      .map((p: { key: string }) => p.key).join(",");
    const standard = orderNow();

    // the same board read by a league that pays a point a catch
    const active = (window as any).__page.setLeague({
      leagueId: "ppr", name: "ppr", size: 12,
      scoring: { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6 },
      slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"],
      team: "me", members: {}, myRoster: [], myPicks: [], allRosters: [],
    });
    await ui.renderView();
    await new Promise((done) => window.setTimeout(done, 300));

    expect(active).not.toBeNull();
    expect(orderNow()).not.toEqual(standard);
  });
});
