/**
 * A small CSV reader for the nflverse flat files: comma-separated,
 * double-quoted fields with "" escapes, quoted fields may contain
 * commas and newlines. Rows come back keyed by the header line, and
 * short rows leave their missing columns as empty strings.
 */

export function parseCsv(text: string): Record<string, string>[] {
  const rows = tokenize(text);
  const header = rows[0];

  if (!header) {
    return [];
  }

  const result: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;

    if (cells.length === 1 && cells[0] === "") {
      continue;
    }

    const row: Record<string, string> = {};

    for (let c = 0; c < header.length; c++) {
      row[header[c]!] = cells[c] ?? "";
    }

    result.push(row);
  }

  return result;
}

function tokenize(text: string): string[][] {
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
  return rows;
}
