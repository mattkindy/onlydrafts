/**
 * The wire sorted into claim, stash, stream, rising and fluke.
 */

import { describe, expect, it } from "vitest";

import type { Listed } from "./availability.ts";
import type { Player } from "./scoring.ts";
import type { SlateRow } from "./slate.ts";
import type { Add } from "./waivers.ts";
import { groupsFor } from "./waiverGroups.ts";

const PAYS = { rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1, rec_td: 6 };

type Use = [number, number, number, number];

const aMan = (
  key: string, position: string, extra: Partial<Player> = {},
): Player => ({ name: key, key, position, ...extra }) as Player;

const anAdd = (p: Player, added: number): Add => ({
  p, added, starts: 0.5, brings: 1, before: 0.5, after: 0.5 + added,
  displaced: null, why: null,
});

const aLine = (key: string, blend: number, extra: Partial<SlateRow> = {}) =>
  [key, { playerId: key, blend, opponent: "CAR", ruledOut: false, ...extra }] as
    [string, SlateRow];

/** weeks of work, with the same points in each played week */
const worked = (uses: Use[], rushYds = 50) => ({
  weeks: uses.map((use, i) => ({
    w: i + 1, opp: "v NE", of: 1, use, played: { rushYds },
  })),
});

const NOBODY = new Map<string, Listed>();

describe("the wire, grouped", () => {
  it("splits the season's adds into those who play this week and those who wait", () => {
    const playing = aMan("playing", "WR");
    const onBye = aMan("onbye", "RB", { bye: 8 });
    const hurt = aMan("hurt", "RB");
    const done = aMan("done", "RB");
    const listed = new Map<string, Listed>([
      ["hurt", { name: "hurt", status: "IR" }],
      ["done", { name: "done", status: "IR", note: "torn ACL" }],
    ]);
    const said = groupsFor(
      [anAdd(playing, 0.03), anAdd(onBye, 0.025), anAdd(hurt, 0.02),
        anAdd(done, 0.02), anAdd(aMan("small", "WR"), 0.005)],
      8, new Map(), listed, PAYS,
    );

    // nothing to wait for on a torn ACL, so he is in neither
    expect(said.claim.map((g) => g.p.key)).toEqual(["playing"]);
    expect(said.stash.map((g) => g.p.key)).toEqual(["onbye", "hurt"]);
    expect(said.stash[0]!.why).toBe("on bye, +2.5% win chance over the season");
    expect(said.stash[1]!.why).toBe("IR, +2.0% win chance over the season");
  });

  it("streams the best line this week at the positions a lineup streams", () => {
    const wire = [
      anAdd(aMan("te1", "TE"), 0), anAdd(aMan("te2", "TE"), 0),
      anAdd(aMan("te3", "TE"), 0), anAdd(aMan("qb", "QB"), 0),
      anAdd(aMan("wr", "WR"), 0), anAdd(aMan("out", "TE"), 0),
    ];
    const rows = new Map([
      aLine("te1", 6.1), aLine("te2", 8.9), aLine("te3", 7.4),
      aLine("qb", 17.5), aLine("wr", 20), aLine("out", 12, { ruledOut: true }),
    ]);
    const said = groupsFor(wire, 8, rows, NOBODY, PAYS);

    expect(said.stream.map((g) => g.p.key)).toEqual(["qb", "te2", "te3"]);
    expect(said.stream[1]!.why).toBe("8.9 vs CAR this week");
  });

  it("finds a role that moved, and not one this week says is over", () => {
    const jump: Use[] = [[40, 6, 1, 0], [45, 7, 1, 0], [80, 15, 2, 1],
      [84, 16, 3, 2], [88, 17, 2, 1]];
    const said = groupsFor(
      [anAdd(aMan("risen", "RB", worked(jump)), 0),
        anAdd(aMan("backupqb", "QB", worked(jump)), 0),
        anAdd(aMan("steady", "RB", worked(
          [[60, 9, 1, 0], [62, 9, 1, 0], [61, 9, 1, 0], [63, 9, 1, 0]])), 0)],
      8, new Map([aLine("risen", 11), aLine("backupqb", 0)]), NOBODY, PAYS,
    );

    expect(said.rising.map((g) => g.p.key)).toEqual(["risen"]);
    expect(said.rising[0]!.why).toBe("snaps 43% → 84%");
  });

  it("leaves out a bigger role that does not pay", () => {
    const jump: Use[] = [[10, 0, 1, 0], [12, 0, 0, 0], [70, 0, 2, 0],
      [72, 1, 2, 0], [75, 0, 1, 0]];
    const said = groupsFor(
      [anAdd(aMan("decoy", "WR", worked(jump)), 0),
        anAdd(aMan("onbye", "WR", { ...worked(jump), bye: 8 }), 0)],
      8, new Map([aLine("decoy", 2.8)]), NOBODY, PAYS,
    );

    expect(said.rising).toEqual([]);
  });

  it("calls big points on a part-time role a fluke", () => {
    const part: Use[] = [[30, 6, 1, 1], [32, 7, 1, 2], [34, 6, 0, 2]];
    const said = groupsFor(
      [anAdd(aMan("lucky", "RB", worked(part, 140)), 0),
        anAdd(aMan("quiet", "RB", worked(part, 30)), 0)],
      8, new Map(), NOBODY, PAYS,
    );

    expect(said.fluke.map((g) => g.p.key)).toEqual(["lucky"]);
    expect(said.fluke[0]!.why).toBe("14.0 a game on 32% of snaps");
  });
});
