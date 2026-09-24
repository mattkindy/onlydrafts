import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import { seededRng } from "../sim/rng.js";

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

  it("starts quoting at a quote in the middle of a field", () => {
    expect(parseCsv('a,b\nx"y,z"w,2')).toEqual([{ a: "xy,zw", b: "2" }]);
  });

});

/** the reader as it was, one character at a time, for comparing against */
const parsedAsBefore = (text: string): Record<string, string>[] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }

      if (ch === '"') {
        inQuotes = false;
        i++;
        continue;
      }

      cell += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }

    cell += ch;
    i++;
  }

  row.push(cell);
  rows.push(row);

  const header = rows[0]!;
  const result: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;

    if (cells.length === 1 && cells[0] === "") {
      continue;
    }

    const keyed: Record<string, string> = {};

    for (let c = 0; c < header.length; c++) {
      keyed[header[c]!] = cells[c] ?? "";
    }

    result.push(keyed);
  }

  return result;
};

describe("parseCsv against the reader it replaced", () => {
  it("reads every scrambled file the same, keys in the same order", () => {
    const uniform = seededRng(3);
    const pieces = [
      "a", "b", "7", "é", ",", ",", '"', '""', "\n", "\r", "\r\n", " ",
      "season", "2024",
    ];
    let rows = 0;

    for (let file = 0; file < 400; file++) {
      const length = Math.floor(uniform() * 80);
      let text = "";

      for (let k = 0; k < length; k++) {
        text += pieces[Math.floor(uniform() * pieces.length)];
      }

      const read = parseCsv(text);
      const before = parsedAsBefore(text);
      expect(JSON.stringify(read.map((row) => Object.entries(row))))
        .toBe(JSON.stringify(before.map((row) => Object.entries(row))));
      rows += before.length;
    }

    expect(rows).toBeGreaterThan(200);
  });

  it("treats a column called __proto__ as it always did", () => {
    const text = "__proto__,b\n1,2\n";
    const [row] = parseCsv(text);

    expect(Object.entries(row!)).toEqual(Object.entries(parsedAsBefore(text)[0]!));
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
});
