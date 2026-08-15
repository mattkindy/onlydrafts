/**
 * Snap counts identify players by Pro Football Reference name, while
 * stats and rosters use gsis ids, so joining across them happens on a
 * normalized name. Collisions are possible; joins that use this should
 * also match on team.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/i, "")
    .replace(/[^a-z]/g, "");
}
