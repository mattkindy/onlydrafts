import { afterEach, describe, expect, it, vi } from "vitest";
import { freshOrCached, injuryStatuses } from "./sleeper.js";

describe("freshOrCached", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the download when it works and leaves the copy on disk unread", async () => {
    const readCached = vi.fn(async () => "old");

    await expect(freshOrCached(async () => "new", readCached, "crosswalk"))
      .resolves.toBe("new");
    expect(readCached).not.toHaveBeenCalled();
  });

  it("falls back to the copy on disk with a warning when the download fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = await freshOrCached(
      async () => {
        throw new Error("crosswalk returned 503");
      },
      async () => "sleeper_id,gsis_id\n11560,00-0039918\n",
      "crosswalk",
    );

    expect(text).toContain("00-0039918");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("throws the download's error when there is no copy on disk", async () => {
    const failed = freshOrCached(
      async () => {
        throw new Error("crosswalk returned 503");
      },
      async () => {
        throw new Error("ENOENT");
      },
      "crosswalk",
    );

    await expect(failed).rejects.toThrow("crosswalk returned 503");
  });

  it("treats an empty copy on disk as no copy", async () => {
    const failed = freshOrCached(
      async () => {
        throw new Error("crosswalk returned 503");
      },
      async () => "",
      "crosswalk",
    );

    await expect(failed).rejects.toThrow("crosswalk returned 503");
  });
});

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
