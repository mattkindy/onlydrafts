/**
 * The weekly roster file comes out a few days behind the games, so the
 * week being asked about is often missing from it. Anything reading a
 * club's roster for a week reads the latest week the file has up to that
 * one, since last week's roster is a better guess than an empty one.
 */
export function rosterWeekFor(weeks: Iterable<number>, wanted: number): number {
  let best = 0;

  for (const week of weeks) {
    if (week <= wanted && week > best) {
      best = week;
    }
  }

  return best || wanted;
}
