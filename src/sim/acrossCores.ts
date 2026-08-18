/**
 * The same script run over several cores at once.
 *
 * A season of games is a few hundred jobs that do not depend on each
 * other, and a fair number of simulations costs an hour on one core.
 * Worker threads cannot load TypeScript here, so each share of the
 * work is a separate run of the same script, told which share it has.
 * The few seconds each spends setting itself up is nothing against
 * what it saves.
 */

import { spawn } from "node:child_process";
import { cpus } from "node:os";

export interface ShareRequest {
  /** the script to run, which must read the two below out of its env */
  script: string;
  /** how many shares to cut the work into */
  shares?: number;
  /** anything else the runs need in their environment */
  env?: Record<string, string>;
  /** told what each share printed, as it finishes */
  asTheyLand?: (share: number, printed: string) => void;
}

/** how many shares to cut the work into, leaving room to breathe */
export const roomFor = (): number => Math.max(1, cpus().length - 2);

/**
 * What each share printed on its last line, in share order. A script
 * is expected to print its answer as one line of JSON at the end, and
 * anything else it says goes to the caller's own error stream.
 */
export async function acrossCores(request: ShareRequest): Promise<string[]> {
  const shares = request.shares ?? roomFor();

  return Promise.all(
    Array.from({ length: shares }, (_, share) =>
      new Promise<string>((resolve, reject) => {
        const run = spawn(
          "npx",
          ["tsx", request.script],
          {
            env: {
              ...process.env, ...request.env,
              SHARE: String(share), SHARES: String(shares),
            },
            stdio: ["ignore", "pipe", "inherit"],
          },
        );
        let printed = "";
        run.stdout.on("data", (chunk: Buffer) => { printed += chunk.toString(); });
        run.on("error", reject);
        run.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`share ${share} stopped with ${code}`));
            return;
          }

          const lines = printed.trim().split("\n");
          const last = lines[lines.length - 1] ?? "";
          request.asTheyLand?.(share, last);
          resolve(last);
        });
      }),
    ),
  );
}

/** which jobs this run should take, when it is one share of several */
export function myShare<T>(items: T[]): T[] {
  const share = Number(process.env["SHARE"] ?? -1);
  const shares = Number(process.env["SHARES"] ?? 0);

  if (share < 0 || shares <= 0) {
    return items;
  }

  return items.filter((_, i) => i % shares === share);
}
