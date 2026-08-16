/**
 * The football facts, and the rules that build on them.
 *
 * Every analysis so far re-derived things like "a week he was rostered
 * and did not play" inside whichever script needed it, and one of them
 * counted the playoffs as an injury because that script forgot to say
 * which weeks count. Stating it once, here, is the point: a definition
 * lives in one rule and every question reads the same one.
 *
 * Facts are what the files say. Rules are what follows.
 */

import {
  constant, lit, notLit, rule, variable as v, type Rule,
} from "@suss/datalog";

/**
 * Base relations, as asserted from the data files:
 *
 *   countingWeek(season, week)        a week that counts, so not the playoffs
 *   rostered(player, team, season, week)
 *   played(player, season, week)      he took a snap
 *   snapOf(snapId, season, week, offense, defense)
 *   blocked(snapId, player)           on the field trying to protect
 *   rushed(snapId, player)            on the field trying to get through
 *   pressured(snapId)                 the pocket broke
 *   coached(team, season, role, person)
 *   position(player, season, pos)
 */
export const BASE_RELATIONS = [
  "countingWeek", "rostered", "played", "snapOf",
  "blocked", "rushed", "pressured", "coached", "position",
] as const;

/** who was missing, and when they came back */
export const ABSENCE_RULES: Rule[] = [
  // he was on the roster for a week that counts and did not take a snap
  rule("missed", [v("p"), v("s"), v("w")], [
    lit("rostered", v("p"), v("t"), v("s"), v("w")),
    lit("countingWeek", v("s"), v("w")),
    notLit("played", v("p"), v("s"), v("w")),
  ]),

  // the week before he missed one, he was playing
  rule("wentOut", [v("p"), v("s"), v("w")], [
    lit("missed", v("p"), v("s"), v("w")),
    lit("previousWeek", v("s"), v("before"), v("w")),
    lit("played", v("p"), v("s"), v("before")),
  ]),

  // the week he first played again
  rule("cameBack", [v("p"), v("s"), v("w")], [
    lit("played", v("p"), v("s"), v("w")),
    lit("previousWeek", v("s"), v("before"), v("w")),
    lit("missed", v("p"), v("s"), v("before")),
  ]),

];

/** the shape of a receiving room and the defence it met */
export const ROOM_RULES: Rule[] = [
  // two men on the same side of the same snap
  rule("blockedWith", [v("a"), v("b"), v("snap")], [
    lit("blocked", v("snap"), v("a")),
    lit("blocked", v("snap"), v("b")),
  ]),

  // a blocker and a rusher who met
  rule("faced", [v("blocker"), v("rusher"), v("snap")], [
    lit("blocked", v("snap"), v("blocker")),
    lit("rushed", v("snap"), v("rusher")),
  ]),

  // the snaps where the pocket broke, with who was there
  rule("beatenOn", [v("blocker"), v("rusher"), v("snap")], [
    lit("faced", v("blocker"), v("rusher"), v("snap")),
    lit("pressured", v("snap")),
  ]),

  // a team whose play-caller changed between seasons
  rule("newVoice", [v("team"), v("s"), v("role")], [
    lit("coached", v("team"), v("s"), v("role"), v("now")),
    lit("previousSeason", v("s"), v("before")),
    lit("coached", v("team"), v("before"), v("role"), v("then")),
    notLit("sameName", v("now"), v("then")),
  ]),

  // a man on a team that changed its play-caller
  rule("underNewVoice", [v("p"), v("s"), v("team")], [
    lit("rostered", v("p"), v("team"), v("s"), v("w")),
    lit("newVoice", v("team"), v("s"), constant("OC")),
  ]),

  // he was somewhere else last season
  rule("moved", [v("p"), v("s"), v("from"), v("to")], [
    lit("rostered", v("p"), v("to"), v("s"), v("w")),
    lit("previousSeason", v("s"), v("before")),
    lit("rostered", v("p"), v("from"), v("before"), v("earlier")),
    notLit("sameName", v("from"), v("to")),
  ]),

  // the man his room threw to most, and the men behind him
  rule("roomLeader", [v("p"), v("team"), v("s")], [
    lit("targetRank", v("p"), v("team"), v("s"), constant(1)),
  ]),

  rule("roomSecond", [v("p"), v("team"), v("s")], [
    lit("targetRank", v("p"), v("team"), v("s"), constant(2)),
  ]),

  rule("roomThird", [v("p"), v("team"), v("s")], [
    lit("targetRank", v("p"), v("team"), v("s"), constant(3)),
  ]),

  // he played, and this is the defence he played against
  rule("facedDefence", [v("p"), v("d"), v("s"), v("w")], [
    lit("played", v("p"), v("s"), v("w")),
    lit("rostered", v("p"), v("team"), v("s"), v("w")),
    lit("met", v("s"), v("w"), v("team"), v("d")),
  ]),

  // the week a room's best receiver met a secondary
  rule("leaderMet", [v("p"), v("d"), v("s"), v("w")], [
    lit("roomLeader", v("p"), v("team"), v("s")),
    lit("facedDefence", v("p"), v("d"), v("s"), v("w")),
  ]),

  // and the same for whoever plays behind him, as the comparison
  rule("supportMet", [v("p"), v("d"), v("s"), v("w")], [
    lit("roomSecond", v("p"), v("team"), v("s")),
    lit("facedDefence", v("p"), v("d"), v("s"), v("w")),
  ]),

  rule("supportMet", [v("p"), v("d"), v("s"), v("w")], [
    lit("roomThird", v("p"), v("team"), v("s")),
    lit("facedDefence", v("p"), v("d"), v("s"), v("w")),
  ]),
];