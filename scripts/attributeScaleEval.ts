/**
 * Are the descriptions on a comparable scale?
 *
 * Each attribute is centred and divided by a spread, and I typed both
 * from memory. If a spread is too small the attribute shouts over the
 * others in every comparison; too large and it says nothing. This
 * measures what they really are.
 *
 * Run: npx tsx scripts/attributeScaleEval.ts
 */

import { buildPlayerVectors, ATTRIBUTES } from "../src/features/playerVector.js";

const SEASONS = [2022, 2023, 2024];

async function main(): Promise<void> {
  const players: { position: string; values: Float64Array }[] = [];

  for (const season of SEASONS) {
    for (const player of (await buildPlayerVectors(season)).values()) {
      players.push({ position: player.position, values: player.values });
    }
  }

  console.log(`${players.length} player-seasons\n`);
  console.log("after centring and scaling, each attribute should sit near");
  console.log("nothing and spread about one\n");
  console.log("attribute            found   middle   spread   verdict");

  for (let i = 0; i < ATTRIBUTES.length; i++) {
    // only men the attribute applies to, so a kicker's zero for catch
    // rate does not drag the receivers' spread down
    const seen = players.map((p) => p.values[i]!).filter((v) => v !== 0);

    if (seen.length < 50) {
      console.log("  " + ATTRIBUTES[i]!.padEnd(20) + "too few to say");
      continue;
    }

    const centre = seen.reduce((a, b) => a + b, 0) / seen.length;
    const spread = Math.sqrt(
      seen.reduce((a, b) => a + (b - centre) ** 2, 0) / seen.length,
    );
    // a spread of one is right; far off either way distorts a comparison
    const verdict = spread > 1.6 ? "shouts"
      : spread < 0.6 ? "whispers"
      : Math.abs(centre) > 0.6 ? "off centre"
      : "fine";

    console.log(
      "  " + ATTRIBUTES[i]!.padEnd(20) +
      String(seen.length).padStart(6) +
      centre.toFixed(2).padStart(9) +
      spread.toFixed(2).padStart(9) +
      "   " + verdict,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
