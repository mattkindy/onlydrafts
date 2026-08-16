/**
 * One vocabulary for game situations, so the aggregator and the model
 * do not each invent their own and need a table to translate.
 *
 * The play-by-play is cut finely, because the fine cuts are what let
 * us measure which splits are worth keeping. The model uses fewer,
 * because a split only earns its place if a player's share in it says
 * something his season usage does not. The rollup below is the single
 * place that says which fine cut belongs to which coarse one.
 */

/** how a play is labelled when the play-by-play is read */
export const FINE_SITUATIONS = [
  "goalLine", "insideTen", "redZone",
  "thirdAndShort", "thirdAndMedium", "thirdAndLong", "fourthDown",
  "chasingLate", "aheadLate", "earlyAndLong", "earlyDown",
] as const;

export type FineSituation = (typeof FINE_SITUATIONS)[number];

/** what the model draws for, after the splits that did not pay are merged */
export const SITUATIONS = [
  "openField", "thirdAndShort", "thirdAndLong", "nearGoal",
] as const;

export type Situation = (typeof SITUATIONS)[number];

/**
 * Third down and the goal line stay separate because a man's share in
 * them predicts next season at .423 and .340 where his overall share
 * manages .241 and .138. The red zone at large does not, .579 against
 * .591, so it merges into what happens near the goal.
 */
export const ROLLS_UP_TO: Record<FineSituation, Situation> = {
  goalLine: "nearGoal",
  insideTen: "nearGoal",
  redZone: "nearGoal",
  thirdAndShort: "thirdAndShort",
  thirdAndMedium: "thirdAndLong",
  thirdAndLong: "thirdAndLong",
  fourthDown: "thirdAndShort",
  chasingLate: "openField",
  aheadLate: "openField",
  earlyAndLong: "openField",
  earlyDown: "openField",
};

/**
 * The situations a play-caller treats differently, read off one play.
 *
 * Third down splits three ways because they are three different
 * calls: one or two yards is a push, three to six is an ordinary
 * down, seven or more is a passing down and everyone knows it. Fourth
 * down is its own thing, since a team that runs a play there has
 * decided to go for it.
 */
export function situationOf(
  down: number, toGo: number, yard: number, behind: number, secondsLeft: number,
): FineSituation {
  if (yard <= 3) return "goalLine";
  if (yard <= 10) return "insideTen";
  if (yard <= 20) return "redZone";
  if (down === 4) return "fourthDown";
  if (down === 3 && toGo <= 2) return "thirdAndShort";
  if (down === 3 && toGo <= 6) return "thirdAndMedium";
  if (down === 3) return "thirdAndLong";
  if (secondsLeft <= 240 && behind > 0) return "chasingLate";
  if (secondsLeft <= 240 && behind < -7) return "aheadLate";
  if (toGo >= 8) return "earlyAndLong";
  return "earlyDown";
}

export const zeroBySituation = (): Record<Situation, number> =>
  ({ openField: 0, thirdAndShort: 0, thirdAndLong: 0, nearGoal: 0 });
