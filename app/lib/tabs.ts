/**
 * The tab a page lands on. A reload asks for the tab you were on, and
 * keeps it unless the league has no such tab: the stats tab while the
 * draft is still to come, or the draft once weeks are being played.
 *
 * Whether the draft is still to come is not known until the season's
 * weeks have been read. Before that every league looks like it is
 * drafting, so a decision then would send a reload on the stats tab
 * away to the draft, and on to the matchup once the weeks came in.
 */
export function landingTab<T extends string>(
  asked: T, tabs: readonly T[], known: boolean, outside: T,
): T {
  if (!known || asked === outside || tabs.includes(asked)) {
    return asked;
  }

  return tabs[0] ?? asked;
}
