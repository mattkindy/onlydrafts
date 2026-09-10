// The weekly refresh, in order: pull this season's nflverse files, pull
// Sleeper's projections, count this season's touches, build the site.
// Run: npm run week [-- --season 2026]

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentSeason } from "../src/data/nflverse.js";

interface Step {
  what: string;
  script: string;
  args: string[];
}

const TSX = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

function run(step: Step): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        TSX,
        fileURLToPath(new URL(step.script, import.meta.url)),
        ...step.args,
      ],
      { stdio: "inherit" },
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${step.what} exited ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--season");
  const season = flag === -1
    ? currentSeason()
    : Number(process.argv[flag + 1]);
  const rest = process.argv.slice(2).filter(
    (a, i, all) => a !== "--season" && all[i - 1] !== "--season",
  );

  const steps: Step[] = [
    {
      what: "the season's nflverse files",
      script: "fetchData.ts",
      args: ["--seasons", String(season), "--force"],
    },
    {
      what: "Sleeper's projections",
      script: "fetchSleeperProjections.ts",
      args: ["--seasons", String(season)],
    },
    {
      what: "the touches table",
      script: "aggregateTouches.ts",
      args: ["--seasons", String(season)],
    },
    { what: "the site", script: "buildSite.ts", args: ["--season", String(season), ...rest] },
  ];

  const started = Date.now();

  for (const step of steps) {
    console.log(`\n=== ${step.what} ===`);
    const at = Date.now();
    await run(step);
    console.log(`${step.what}: ${((Date.now() - at) / 1000).toFixed(1)}s`);
  }

  console.log(
    `\nweek ${season} refreshed in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
