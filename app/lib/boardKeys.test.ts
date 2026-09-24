import { describe, expect, it } from "vitest";

import { boardKeyOf, boardPositionOf, boardTeamOf } from "./boardKeys.ts";

describe("boardKeyOf", () => {
  it("finds the players the week 3 slate had no Sleeper match for", () => {
    expect(boardKeyOf("Joshua Palmer", "WR", "BUF")).toBe("joshpalmer");
    expect(boardKeyOf("Drew Ogletree", "TE", "IND")).toBe("andrewogletree");
    expect(boardKeyOf("Zonovan Knight", "RB", "ARI")).toBe("bamknight");
    expect(boardKeyOf("Matt Hibner", "TE", "BAL")).toBe("matthewhibner");
  });

  it("keys a defence by its team, in the board's code", () => {
    expect(boardKeyOf("LAR", "DEF", "LAR")).toBe("la");
    expect(boardKeyOf("WSH", "DEF", "WSH")).toBe("was");
    expect(boardKeyOf("KC", "DEF")).toBe("kc");
  });

  it("leaves everybody else as his normalized name", () => {
    expect(boardKeyOf("Brian Thomas Jr.", "WR", "JAX")).toBe("brianthomas");
  });
});

describe("boardTeamOf", () => {
  it("renames the codes the board spells differently", () => {
    expect(boardTeamOf("LAR")).toBe("LA");
    expect(boardTeamOf("wsh")).toBe("WAS");
    expect(boardTeamOf("JAX")).toBe("JAX");
  });
});

describe("boardPositionOf", () => {
  it("counts a fullback as a back", () => {
    expect(boardPositionOf("patrickricard", "FB")).toBe("RB");
    expect(boardPositionOf("djherman", "LB")).toBe("RB");
    expect(boardPositionOf("justinjefferson", "LB")).toBe("LB");
  });
});
