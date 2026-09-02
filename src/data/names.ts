/**
 * Snap counts identify players by Pro Football Reference name, while
 * stats and rosters use gsis ids, so joining across them happens on a
 * normalized name. Collisions are possible; joins that use this should
 * also match on team.
 */
export function normalizeName(name: string): string {
  // accents come off before the letters are kept, so Estimé and Estime
  // are one man rather than two spellings. The site's own copy of this
  // has to agree, since it looks board keys up by the same rule.
  return name
    .normalize("NFD")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/i, "")
    .replace(/[^a-z]/g, "");
}
