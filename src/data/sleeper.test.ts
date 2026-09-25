import { describe, expect, it } from "vitest";
import { injuryStatuses } from "./sleeper.js";

describe("injuryStatuses", () => {
  const gsis = new Map([
    ["11560", "00-0039918"],
    ["11256", "00-0038416"],
    ["9999", "00-0000001"],
    ["8888", "00-0000002"],
    ["12000", "00-0039918"],
  ]);

  it("keys each status by gsis id with the club Sleeper has him on", () => {
    const statuses = injuryStatuses({
      "11560": { team: "CHI", injury_status: "Doubtful" },
      "11256": { team: "CHI", injury_status: "Questionable" },
    }, gsis);

    expect(statuses.get("00-0039918")).toEqual({ status: "Doubtful", team: "CHI" });
    expect(statuses.get("00-0038416")?.status).toBe("Questionable");
  });

  it("leaves out a healthy player, a free agent and a player with no gsis id", () => {
    const statuses = injuryStatuses({
      "9999": { team: "CHI", injury_status: null },
      "8888": { team: null, injury_status: "IR" },
      "5555": { team: "CHI", injury_status: "Out" },
    }, gsis);

    expect(statuses.size).toBe(0);
  });

  it("keeps the first status when two Sleeper ids share a gsis id", () => {
    const statuses = injuryStatuses({
      "11560": { team: "CHI", injury_status: "Doubtful" },
      "12000": { team: "CHI", injury_status: "Out" },
    }, gsis);

    expect(statuses.get("00-0039918")?.status).toBe("Doubtful");
  });
});
