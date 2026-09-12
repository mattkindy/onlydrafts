/**
 * A played game stopped at a snap, so a projection can be asked what
 * the rest of it is worth.
 *
 * Every checkpoint is one snap in the released play by play. The state
 * is what the two sides faced before that snap, in the form playGame
 * takes over from. Each man's afternoon is split at the same snap:
 * what he had already, and what the plays from there on gave him. All
 * of it is scored in PPR, the presets.ppr rules.
 *
 * A season's play by play is around 98 MB, so the file is read a line
 * at a time and one game's rows are gathered before it is measured.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { splitLine } from "../data/csv.js";
import {
  emptyStatLine, fantasyPoints, presets, type StatLine,
} from "../scoring/fantasyPoints.js";
import type { GameStart } from "../model/gameFromDrives.js";

/** which snap a checkpoint stopped at */
export type CheckpointLabel =
  | "endQ1" | "half" | "endQ3" | "midQ2" | "thirdQ2" | "redQ3";

export interface CheckpointMan {
  playerId: string;
  player: string;
  team: string;
  /** PPR points from the plays before the checkpoint snap */
  soFar: number;
  /** and from that snap to the end of the game, overtime included */
  toCome: number;
}

export interface Checkpoint {
  season: number;
  week: number;
  gameId: string;
  home: string;
  away: string;
  label: CheckpointLabel;
  state: GameStart;
  /** the final score, so the remaining team points are known */
  finalPoints: Record<string, number>;
  men: CheckpointMan[];
}

/** the columns a checkpoint needs out of the release */
const WANTED = [
  "game_id", "season", "season_type", "week", "home_team", "away_team",
  "posteam", "defteam",
  "yardline_100", "down", "ydstogo", "game_seconds_remaining", "qtr",
  "total_home_score", "total_away_score", "posteam_timeouts_remaining",
  "defteam_timeouts_remaining", "fixed_drive", "play_type",
  "passer_player_id", "passer_player_name", "passing_yards", "pass_touchdown",
  "interception", "receiver_player_id", "receiver_player_name",
  "receiving_yards", "complete_pass", "rusher_player_id",
  "rusher_player_name", "rushing_yards", "rush_touchdown",
  "fumbled_1_player_id", "fumbled_1_player_name", "fumble_lost",
  "two_point_attempt", "two_point_conv_result",
] as const;

type Field = (typeof WANTED)[number];

/** one play, keyed by the columns the release writes */
export type PbpRow = Record<Field, string>;
type Row = PbpRow;

const num = (text: string) => {
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
};

const isSnap = (row: Row) =>
  row.posteam !== "" && num(row.down) >= 1 && num(row.down) <= 4 &&
  num(row.yardline_100) >= 1 && num(row.qtr) <= 4;

/**
 * The two minute warning has not come yet when more than two minutes
 * of the current half are left.
 */
function warningLeft(secondsLeft: number): boolean {
  const inThisHalf = secondsLeft > 1800 ? secondsLeft - 1800 : secondsLeft;

  return inThisHalf > 120;
}

/** the men who touched the ball on one play, with what it gave them */
function credit(
  row: Row, lines: Map<string, StatLine>, names: Map<string, string>,
  teams: Map<string, string>,
): void {
  const lineOf = (playerId: string, player: string, team: string) => {
    const already = lines.get(playerId) ?? emptyStatLine();
    lines.set(playerId, already);
    names.set(playerId, player);
    teams.set(playerId, team);
    return already;
  };
  const offence = row.posteam;
  const twoPoint = num(row.two_point_attempt) === 1 &&
    row.two_point_conv_result === "success";

  if (row.rusher_player_id) {
    const his = lineOf(row.rusher_player_id, row.rusher_player_name, offence);
    his.rushYds += num(row.rushing_yards);
    his.rushTd += num(row.rush_touchdown);
    if (twoPoint) his.twoPointConversions += 1;
  }

  if (row.receiver_player_id && num(row.complete_pass) === 1) {
    const his =
      lineOf(row.receiver_player_id, row.receiver_player_name, offence);
    his.receptions += 1;
    his.recYds += num(row.receiving_yards);
    his.recTd += num(row.pass_touchdown);
    if (twoPoint) his.twoPointConversions += 1;
  }

  if (row.passer_player_id) {
    const his = lineOf(row.passer_player_id, row.passer_player_name, offence);
    his.passYds += num(row.passing_yards);
    his.passTd += num(row.pass_touchdown);
    his.interceptions += num(row.interception);
    if (twoPoint && num(row.complete_pass) === 1) his.twoPointConversions += 1;
  }

  if (row.fumbled_1_player_id && num(row.fumble_lost) === 1) {
    const his =
      lineOf(row.fumbled_1_player_id, row.fumbled_1_player_name, offence);
    his.fumblesLost += 1;
  }
}

/**
 * The snaps this game is stopped at. Three come off the clock, and
 * three are picked out of the middle of a drive by what the offence
 * faced, so the same game always gives the same six.
 */
function chosenSnaps(snaps: Row[]): Map<CheckpointLabel, number> {
  const at = new Map<CheckpointLabel, number>();
  const firstOf = (quarter: number) =>
    snaps.findIndex((row) => num(row.qtr) === quarter);
  const byQuarter: Record<number, CheckpointLabel> = {
    2: "endQ1", 3: "half", 4: "endQ3",
  };

  for (const [quarter, label] of Object.entries(byQuarter)) {
    const found = firstOf(Number(quarter));

    if (found >= 0) {
      at.set(label, found);
    }
  }

  const inQ2 = snaps
    .map((row, index) => ({ row, index }))
    .filter((one) => num(one.row.qtr) === 2);
  const middleOfQ2 = inQ2[Math.floor(inQ2.length / 2)];

  if (middleOfQ2) {
    at.set("midQ2", middleOfQ2.index);
  }

  const thirdDown = inQ2.find((one) => num(one.row.down) === 3);

  if (thirdDown) {
    at.set("thirdQ2", thirdDown.index);
  }

  const nearGoal = snaps.findIndex(
    (row) => num(row.qtr) === 3 && num(row.yardline_100) <= 20,
  );

  if (nearGoal >= 0) {
    at.set("redQ3", nearGoal);
  }

  return at;
}

/** every checkpoint one game gives, in the order the snaps came */
export function checkpointsOf(rows: Row[]): Checkpoint[] {
  const first = rows[0];

  if (!first) {
    return [];
  }

  const home = first.home_team;
  const away = first.away_team;
  const snaps = rows.filter(isSnap);
  const receivedFirst = first.posteam || snaps[0]?.posteam || home;
  const finalPoints = {
    [home]: Math.max(...rows.map((row) => num(row.total_home_score))),
    [away]: Math.max(...rows.map((row) => num(row.total_away_score))),
  };
  /** the running line of each man over every play, in order */
  const overall = new Map<string, StatLine>();
  const names = new Map<string, string>();
  const teams = new Map<string, string>();
  const picked = chosenSnaps(snaps);
  const bySnap = new Map<number, CheckpointLabel[]>();

  for (const [label, index] of picked) {
    bySnap.set(index, [...(bySnap.get(index) ?? []), label]);
  }

  const soFarAt = new Map<CheckpointLabel, Map<string, number>>();
  const stateAt = new Map<CheckpointLabel, GameStart>();
  const pointsBefore = { [home]: 0, [away]: 0 };
  let rowAt = 0;
  let snapAt = 0;

  while (rowAt < rows.length) {
    const row = rows[rowAt]!;

    if (isSnap(row)) {
      for (const label of bySnap.get(snapAt) ?? []) {
        const withBall = row.posteam;
        const other = withBall === home ? away : home;
        stateAt.set(label, {
          points: { ...pointsBefore },
          secondsLeft: num(row.game_seconds_remaining),
          withBall,
          yardline: num(row.yardline_100),
          down: num(row.down),
          toGo: Math.max(1, num(row.ydstogo)),
          timeouts: {
            [withBall]: num(row.posteam_timeouts_remaining),
            [other]: num(row.defteam_timeouts_remaining),
          },
          warningLeft: warningLeft(num(row.game_seconds_remaining)),
          secondHalf: num(row.qtr) >= 3,
          receivedFirst,
        });
        soFarAt.set(
          label,
          new Map([...overall].map(([who, line]) => [
            who, fantasyPoints(line, presets.ppr),
          ])),
        );
      }

      snapAt++;
    }

    credit(row, overall, names, teams);
    pointsBefore[home] = num(row.total_home_score);
    pointsBefore[away] = num(row.total_away_score);
    rowAt++;
  }

  const finalFor = new Map(
    [...overall].map(([who, line]) => [who, fantasyPoints(line, presets.ppr)]),
  );
  const order: CheckpointLabel[] =
    ["endQ1", "thirdQ2", "midQ2", "half", "redQ3", "endQ3"];

  return order.flatMap((label) => {
    const state = stateAt.get(label);
    const soFar = soFarAt.get(label);

    if (!state || !soFar) {
      return [];
    }

    const men = [...finalFor].map(([playerId, whole]) => ({
      playerId,
      player: names.get(playerId) ?? "",
      team: teams.get(playerId) ?? "",
      soFar: soFar.get(playerId) ?? 0,
      toCome: Math.round((whole - (soFar.get(playerId) ?? 0)) * 100) / 100,
    }));

    return [{
      season: num(first.season) || num(first.game_id.slice(0, 4)),
      week: num(first.week),
      gameId: first.game_id,
      home, away, label, state, finalPoints, men,
    }];
  });
}

/**
 * One season's checkpoints, a game at a time. The release writes a
 * game's rows together, so a game is done the moment its id changes.
 */
export async function* seasonCheckpoints(
  path: string,
): AsyncGenerator<Checkpoint> {
  const reader = createInterface({ input: createReadStream(path) });
  let at: Partial<Record<Field, number>> | undefined;
  let gameId = "";
  let rows: Row[] = [];
  const asRow = (cells: string[]): Row => {
    const row = {} as Row;

    for (const field of WANTED) {
      row[field] = cells[at![field]!] ?? "";
    }

    return row;
  };

  for await (const line of reader) {
    if (!at) {
      const header = splitLine(line);
      at = {};

      for (const field of WANTED) {
        at[field] = header.indexOf(field);
      }

      continue;
    }

    if (line.trim() === "") {
      continue;
    }

    const row = asRow(splitLine(line));

    if (row.season_type !== "REG") {
      continue;
    }

    if (row.game_id !== gameId) {
      if (rows.length) {
        yield* checkpointsOf(rows);
      }

      gameId = row.game_id;
      rows = [];
    }

    rows.push(row);
  }

  if (rows.length) {
    yield* checkpointsOf(rows);
  }
}

const CACHE_COLUMNS = [
  "season", "week", "gameId", "home", "away", "label", "secondsLeft",
  "withBall", "yardline", "down", "toGo", "homePoints", "awayPoints",
  "homeTimeouts", "awayTimeouts", "warningLeft", "secondHalf",
  "receivedFirst", "homeFinal", "awayFinal", "playerId", "player", "team",
  "soFar", "toCome",
];

export const cacheHeader = () => CACHE_COLUMNS.join(",");

/** one row per man per checkpoint, which is what the eval reads back */
export function cacheRows(one: Checkpoint): string[] {
  const { state } = one;
  const head = [
    one.season, one.week, one.gameId, one.home, one.away, one.label,
    state.secondsLeft, state.withBall ?? "", state.yardline ?? "",
    state.down ?? "", state.toGo ?? "",
    state.points[one.home] ?? 0, state.points[one.away] ?? 0,
    state.timeouts[one.home] ?? 3, state.timeouts[one.away] ?? 3,
    state.warningLeft ? 1 : 0, state.secondHalf ? 1 : 0,
    state.receivedFirst ?? "",
    one.finalPoints[one.home] ?? 0, one.finalPoints[one.away] ?? 0,
  ];

  return one.men.map((man) => [
    ...head, man.playerId, man.player.replaceAll(",", " "), man.team,
    man.soFar, man.toCome,
  ].join(","));
}

/** the checkpoints back out of the cache, gathered by game and label */
export function fromCache(text: string): Checkpoint[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const header = splitLine(lines[0] ?? "");
  const at = (field: string) => header.indexOf(field);
  const byKey = new Map<string, Checkpoint>();

  for (const line of lines.slice(1)) {
    const cells = splitLine(line);
    const cell = (field: string) => cells[at(field)] ?? "";
    const key = `${cell("gameId")}|${cell("label")}`;
    const home = cell("home");
    const away = cell("away");
    const already = byKey.get(key) ?? {
      season: num(cell("season")),
      week: num(cell("week")),
      gameId: cell("gameId"),
      home, away,
      label: cell("label") as CheckpointLabel,
      state: {
        points: { [home]: num(cell("homePoints")), [away]: num(cell("awayPoints")) },
        secondsLeft: num(cell("secondsLeft")),
        withBall: cell("withBall"),
        yardline: num(cell("yardline")),
        down: num(cell("down")),
        toGo: num(cell("toGo")),
        timeouts: {
          [home]: num(cell("homeTimeouts")), [away]: num(cell("awayTimeouts")),
        },
        warningLeft: cell("warningLeft") === "1",
        secondHalf: cell("secondHalf") === "1",
        receivedFirst: cell("receivedFirst"),
      },
      finalPoints: {
        [home]: num(cell("homeFinal")), [away]: num(cell("awayFinal")),
      },
      men: [],
    };
    byKey.set(key, already);
    already.men.push({
      playerId: cell("playerId"),
      player: cell("player"),
      team: cell("team"),
      soFar: num(cell("soFar")),
      toCome: num(cell("toCome")),
    });
  }

  return [...byKey.values()];
}
