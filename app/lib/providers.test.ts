/**
 * ESPN's scoring read off a league as ESPN actually sent it.
 *
 * The earlier tests were written from a reading of ESPN's stat ids, so
 * they agreed with that reading whether or not it was right, and it was
 * wrong three times: the kicking ids were shifted a band, the plain
 * price was read where ESPN had put the defence's own beside it, and a
 * quarterback's interception was paid as a defence's. The fixture is
 * the scoring block of a league that runs ESPN's standard PPR with a
 * gentler points allowed ladder, so every line here is a number a
 * commissioner could check against the league settings page.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { espnPays, type EspnScoringItem } from "./providers.ts";

const items = JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "fixtures", "espnScoringItems.json"), "utf8",
)) as EspnScoringItem[];

describe("a standard PPR league on ESPN", () => {
  const pays = espnPays(items);

  it("pays passing, rushing and receiving the standard way", () => {
    expect(pays).toMatchObject({
      pass_yd: 0.04, pass_td: 4, pass_int: -2,
      rush_yd: 0.1, rush_td: 6,
      rec: 1, rec_yd: 0.1, rec_td: 6,
      fum_lost: -2, rush_2pt: 2,
    });
  });

  it("pays a kicker by distance, with a point off for a miss", () => {
    expect(pays).toMatchObject({
      xpm: 1,
      fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4,
      fgm_50_59: 5, fgm_60p: 6,
      fgmiss_0_19: -1, fgmiss_20_29: -1, fgmiss_30_39: -1,
      fgmiss_40_49: -1, fgmiss_50_59: -1, fgmiss_60p: -1,
    });
    // this league does not dock a missed extra point
    expect(pays.xpmiss).toBeUndefined();
  });

  it("pays a defence for what it does, not only for scoring", () => {
    expect(pays).toMatchObject({
      sack: 1, int: 2, fum_rec: 2, blk_kick: 2, safe: 2, def_td: 6,
    });
  });

  /**
   * ESPN steps at 14-17 and 18-21 where the board has one step at
   * 14-20, and this league pays the first a point and leaves the second
   * out. A step left out of a priced ladder is nought, so the board's
   * step is the mean of one and nought.
   */
  it("reads the points allowed ladder, blanks included", () => {
    expect(pays).toMatchObject({
      pts_allow_0: 5, pts_allow_1_6: 4, pts_allow_7_13: 3,
      pts_allow_14_20: 0.5, pts_allow_21_27: 0,
      pts_allow_28_34: -1, pts_allow_35p: -4,
    });
  });

  it("does not pay a quarterback for a defence's interception", () => {
    expect(pays.int).toBe(2);
    expect(pays.pass_int).toBe(-2);
  });
});
