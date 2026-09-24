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

  const rowOf = rowMaker(header);
  const result: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;

    if (cells.length === 1 && cells[0] === "") {
      continue;
    }

    result.push(rowOf(cells));
  }

  return result;
}

/** one row keyed by the header, by setting each column in turn */
const rowByColumn = (header: string[]) => (cells: string[]) => {
  const row: Record<string, string> = {};

  for (let c = 0; c < header.length; c++) {
    row[header[c]!] = cells[c] ?? "";
  }

  return row;
};

/**
 * The same row built from one object literal with the header's column
 * names written into it. Every row then has the same shape, which is
 * quicker to build and to read than an object grown a column at a time.
 * A column called `__proto__` would set the prototype in a literal, so a
 * header with one is built a column at a time.
 */
const rowMaker = (
  header: string[],
): ((cells: string[]) => Record<string, string>) => {
  if (header.includes("__proto__")) {
    return rowByColumn(header);
  }

  const columns = header
    .map((name, c) => `${JSON.stringify(name)}: cells[${c}] ?? ""`)
    .join(",\n");

  return new Function("cells", `return {\n${columns}\n};`) as
    (cells: string[]) => Record<string, string>;
};

const QUOTE = 34;
const COMMA = 44;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

/**
 * The cells of every line. Plain characters are taken a run at a time
 * rather than one by one, and a quote starts or ends quoting wherever it
 * falls, as it always has.
 */
function tokenize(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  /** where the run of plain characters not yet added to the cell starts */
  let from = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text.charCodeAt(i);

    if (inQuotes) {
      if (ch !== QUOTE) {
        i++;
        continue;
      }

      cell += text.slice(from, i);

      if (text.charCodeAt(i + 1) === QUOTE) {
        cell += '"';
        i += 2;
        from = i;
        continue;
      }

      inQuotes = false;
      i++;
      from = i;
      continue;
    }

    if (ch === QUOTE) {
      cell += text.slice(from, i);
      inQuotes = true;
      i++;
      from = i;
      continue;
    }

    if (ch === COMMA) {
      row.push(cell + text.slice(from, i));
      cell = "";
      i++;
      from = i;
      continue;
    }

    if (ch === LINE_FEED || ch === CARRIAGE_RETURN) {
      row.push(cell + text.slice(from, i));
      cell = "";
      rows.push(row);
      row = [];
      i += ch === CARRIAGE_RETURN && text.charCodeAt(i + 1) === LINE_FEED
        ? 2
        : 1;
      from = i;
      continue;
    }

    i++;
  }

  row.push(cell + text.slice(from));
  rows.push(row);
  return rows;
}

/**
 * One line of a CSV into its cells. Reading a big file a line at a time
 * needs this on its own, separate from parseCsv, since a whole
 * play-by-play season does not want to be held in memory at once.
 *
 * A quoted field containing a newline would be split across two lines
 * and come out wrong here, which no nflverse release does.
 */
export function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }

  cells.push(cell);
  return cells;
}
