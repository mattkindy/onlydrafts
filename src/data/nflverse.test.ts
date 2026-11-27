import { describe, expect, it } from "vitest";
import { easternDate, onceAndCopied } from "./nflverse.js";

const rowsOnce = () => {
  let reads = 0;

  return {
    load: async () => {
      reads++;

      return [
        { playerId: "A", week: 1, statLine: { rushYds: 12.5 }, college: undefined },
        { playerId: "B", week: 2, statLine: { rushYds: -0 }, college: "Ohio" },
      ];
    },
    reads: () => reads,
  };
};

describe("rows read once and handed out as copies", () => {
  it("reads the file once while its stamp holds, and again when it moves",
    async () => {
      const source = rowsOnce();
      const first = await onceAndCopied("once-a", "1", source.load);
      const second = await onceAndCopied("once-a", "1", source.load);

      expect(source.reads()).toBe(1);
      expect(second).toEqual(first);
      expect(Object.keys(second[0]!)).toEqual(Object.keys(first[0]!));
      expect(Object.is(second[1]!.statLine.rushYds, -0)).toBe(true);

      await onceAndCopied("once-a", "2", source.load);
      expect(source.reads()).toBe(2);
    });

  it("hands every caller its own rows, so a change stays with the caller",
    async () => {
      const source = rowsOnce();
      const first = await onceAndCopied("once-b", "1", source.load);
      first[0]!.statLine.rushYds = 99;
      first.push({ ...first[0]!, playerId: "C" });

      const second = await onceAndCopied("once-b", "1", source.load);

      expect(second).toHaveLength(2);
      expect(second[0]!.statLine.rushYds).toBe(12.5);
    });

  it("reads again after a read that failed", async () => {
    let tries = 0;
    const load = async () => {
      tries++;

      if (tries === 1) {
        throw new Error("not there yet");
      }

      return [{ playerId: "A" }];
    };

    await expect(onceAndCopied("once-c", "1", load)).rejects.toThrow();
    expect(await onceAndCopied("once-c", "1", load)).toEqual([{ playerId: "A" }]);
    expect(tries).toBe(2);
  });
});

describe("easternDate", () => {
  it("is the date on the east coast, not in UTC", () => {
    // a Thursday night game at 8:15pm ET is 01:15 on Friday in UTC
    expect(easternDate(new Date("2026-11-27T01:15:00Z"))).toBe("2026-11-26");
    expect(easternDate(new Date("2026-11-27T05:30:00Z"))).toBe("2026-11-27");
  });

  it("follows daylight saving", () => {
    expect(easternDate(new Date("2026-09-25T03:30:00Z"))).toBe("2026-09-24");
    expect(easternDate(new Date("2026-09-25T04:30:00Z"))).toBe("2026-09-25");
  });
});
