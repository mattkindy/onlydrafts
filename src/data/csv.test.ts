import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("keys rows by the header line", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("reads quoted fields containing commas and escaped quotes", () => {
    expect(parseCsv('name,team\n"Smith, Jr. ""JJ""",DET')).toEqual([
      { name: 'Smith, Jr. "JJ"', team: "DET" },
    ]);
  });

  it("reads quoted fields containing newlines", () => {
    expect(parseCsv('note\n"line one\nline two"')).toEqual([
      { note: "line one\nline two" },
    ]);
  });

  it("handles CRLF line endings and trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
  });

  it("fills short rows with empty strings", () => {
    expect(parseCsv("a,b,c\n1,2")).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("returns no rows for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
