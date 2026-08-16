/**
 * Replacement level: what you get at a position once every team in the
 * league has filled its lineup. Value over replacement is only as good
 * as this number, so it is worth computing rather than guessing.
 *
 * Flex is the reason it needs computing. A league with two flex slots
 * does not start a fixed number of backs and a fixed number of
 * receivers, it starts whoever is better, and the split moves year to
 * year with which position is deeper. So this fills every dedicated
 * slot in the league, then fills the flex slots from the best players
 * left at any eligible position, and reads replacement off whoever is
 * still on the board. Pass the pool that survives a keeper round to get
 * value against the players you can actually draft.
 */

export interface StarterSlots {
  teams: number;
  /** dedicated slots per team */
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  /** slots per team open to a back, receiver, or tight end */
  flex: number;
  /** slots per team a quarterback can also fill */
  superFlex: number;
}

export interface ReplacementPlayer {
  position: string;
  ppg: number;
}

export interface ReplacementResult {
  /** points a game for the best player at each position nobody starts */
  levels: Record<string, number>;
  /** how many at each position ended up starting somewhere */
  starters: Record<string, number>;
}

const POSITIONS = ["QB", "RB", "WR", "TE"];
const FLEX_POSITIONS = ["RB", "WR", "TE"];

/** the 12-team, 1QB, 2RB, 3WR, 1TE, 2FLEX setup most redraft leagues use */
export const DEFAULT_SLOTS: StarterSlots = {
  teams: 12,
  QB: 1,
  RB: 2,
  WR: 3,
  TE: 1,
  flex: 2,
  superFlex: 0,
};

export function replacementLevels<T extends ReplacementPlayer>(
  players: T[],
  slots: StarterSlots,
): ReplacementResult {
  const remaining = new Map<string, T[]>();
  const starters: Record<string, number> = {};

  for (const position of POSITIONS) {
    remaining.set(
      position,
      players.filter((p) => p.position === position).sort((a, b) => b.ppg - a.ppg),
    );
    starters[position] = 0;
  }

  const draw = (eligible: string[], count: number) => {
    for (let i = 0; i < count; i++) {
      const best = eligible
        .filter((position) => remaining.get(position)!.length > 0)
        .sort((a, b) => remaining.get(b)![0]!.ppg - remaining.get(a)![0]!.ppg)[0];

      if (!best) {
        return;
      }

      remaining.get(best)!.shift();
      starters[best]!++;
    }
  };

  for (const position of POSITIONS) {
    draw([position], slots[position as "QB"] * slots.teams);
  }

  draw(FLEX_POSITIONS, slots.flex * slots.teams);
  draw(POSITIONS, slots.superFlex * slots.teams);

  const levels: Record<string, number> = {};

  for (const position of POSITIONS) {
    levels[position] = remaining.get(position)![0]?.ppg ?? 0;
  }

  return { levels, starters };
}
