import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import { countQuestionable } from "./injuries.js";

const report = parseCsv(
  "season,week,gsis_id,position,report_primary_injury,report_status\n" +
  '2026,3,00-1,WR,"Ankle, knee",Questionable\n' +
  "2026,3,00-2,RB,Hamstring,Questionable\n" +
  "2026,3,00-3,S,Knee,Questionable\n" +
  "2026,3,00-4,TE,Back,\n" +
  "2026,4,00-5,QB,Hand,Questionable\n",
);

describe("countQuestionable", () => {
  it("counts a row whose injury has a comma in it", () => {
    expect(countQuestionable(report, 3, ["WR", "RB", "TE"])).toBe(2);
  });

  it("leaves out other positions, other weeks and a blank status", () => {
    expect(countQuestionable(report, 3, ["TE"])).toBe(0);
    expect(countQuestionable(report, 4, ["QB"])).toBe(1);
  });
});
