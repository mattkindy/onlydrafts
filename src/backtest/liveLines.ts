/**
 * A week's men as the site priced them before kickoff, cached.
 *
 * The component line, the Sleeper blend and the residual quantiles come
 * off a fit over eight seasons, which no eval wants to repeat in every
 * share of a run.
 */

import { splitLine } from "../data/csv.js";

export const LINE_COLUMNS = [
  "season", "week", "playerId", "position", "team", "opponent",
  "ours", "sleeper", "blend", "floor", "q1", "q3", "ceiling",
];

export interface LiveLine {
  season: number;
  week: number;
  playerId: string;
  position: string;
  team: string;
  opponent: string;
  ours: number;
  sleeper: number | null;
  blend: number;
  /** the ten, twenty five, fifty, seventy five and ninety, in order */
  five: number[];
}

export function linesFromCache(text: string): LiveLine[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const header = splitLine(lines[0] ?? "");
  const at = (field: string) => header.indexOf(field);

  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const cell = (field: string) => cells[at(field)] ?? "";
    const num = (field: string) => Number(cell(field));
    const blend = num("blend");

    return {
      season: num("season"),
      week: num("week"),
      playerId: cell("playerId"),
      position: cell("position"),
      team: cell("team"),
      opponent: cell("opponent"),
      ours: num("ours"),
      sleeper: cell("sleeper") === "" ? null : num("sleeper"),
      blend,
      five: [num("floor"), num("q1"), blend, num("q3"), num("ceiling")],
    };
  });
}
