/**
 * Who was on the field for every play since participation data began,
 * counted by the aggregateOnField script from the play by play and the
 * participation files.
 *
 * It is committed with the curated data because the weekly refresh does
 * not download old play by play, and the matchup table reads it on every
 * build. It changes once a season, when a new participation file is out.
 */

import { join } from "node:path";

export const ON_FIELD_CSV = join(
  import.meta.dirname, "..", "..", "data", "curated", "onField.csv",
);
