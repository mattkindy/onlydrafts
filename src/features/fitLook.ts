/**
 * What the defence puts on the field, drawn against the formation.
 *
 * A defence replies to the look it is shown, and the reply decides a
 * great deal: a run from the gun against dime makes 7.05 yards and
 * one against base makes 4.67, while a throw from the gun against
 * base makes 7.28 and against dime 6.06. The two calls do not order
 * the shells the same way, so no single number for how stout a
 * defence is can carry it. The walk draws the look here, and the
 * target and the gain are asked of the pair.
 */

export interface LookRow {
  offence: string;
  defence: string;
  down: number;
  toGo: number;
  yardline: number;
  shotgun: boolean;
  shell: string;
  manZone: string;
}

export interface Look {
  /** which shell shows up here, drawn */
  shellFor: (
    state: { down: number; toGo: number; yardline: number },
    shotgun: boolean, defence: string | undefined, uniform: () => number,
  ) => string;
  /** and how often it is man once the shell is on */
  manRate: (shell: string, defence?: string) => number;
  learnedFrom: number;
}

const SHELLS = ["base", "nickel", "dime"];
const bandOf = (
  shotgun: boolean, down: number, toGo: number, yardline: number,
) =>
  `${shotgun ? "gun" : "centre"}|${Math.min(3, down)}|` +
  `${toGo <= 2 ? "short" : toGo <= 6 ? "medium" : "long"}|` +
  `${yardline <= 20 ? "close" : "out"}`;
/** a defence's own habit is pulled toward the league by this much */
const SETTLES_AT = 400;

export function fitLook(rows: LookRow[]): Look {
  const league = new Map<string, Map<string, number>>();
  const byDefence = new Map<string, Map<string, number>>();
  const man = new Map<string, { man: number; all: number }>();

  for (const row of rows) {
    if (!SHELLS.includes(row.shell)) {
      continue;
    }

    const band = bandOf(row.shotgun, row.down, row.toGo, row.yardline);
    const here = league.get(band) ?? new Map<string, number>();
    here.set(row.shell, (here.get(row.shell) ?? 0) + 1);
    league.set(band, here);
    const his = byDefence.get(row.defence) ?? new Map<string, number>();
    his.set(row.shell, (his.get(row.shell) ?? 0) + 1);
    byDefence.set(row.defence, his);

    if (row.manZone === "man" || row.manZone === "zone") {
      for (const key of [row.shell, `${row.defence}|${row.shell}`]) {
        const seen = man.get(key) ?? { man: 0, all: 0 };
        seen.all++;
        if (row.manZone === "man") seen.man++;
        man.set(key, seen);
      }
    }
  }

  const everyShell = new Map<string, number>();
  let everyPlay = 0;

  for (const his of byDefence.values()) {
    for (const [shell, n] of his) {
      everyShell.set(shell, (everyShell.get(shell) ?? 0) + n);
      everyPlay += n;
    }
  }

  return {
    learnedFrom: byDefence.size,
    shellFor: (state, shotgun, defence, uniform) => {
      const here = league.get(
        bandOf(shotgun, state.down, state.toGo, state.yardline),
      );

      if (!here) {
        return "nickel";
      }

      const all = [...here.values()].reduce((a, b) => a + b, 0);
      const his = defence ? byDefence.get(defence) : undefined;
      const hisAll = his ? [...his.values()].reduce((a, b) => a + b, 0) : 0;
      const trust = hisAll / (hisAll + SETTLES_AT);
      // his own habit as a leaning on the situation's rate, so a side
      // that lives in nickel takes it everywhere without losing what
      // the down and the distance say
      const weights = SHELLS.map((shell) => {
        const base = (here.get(shell) ?? 0) / Math.max(1, all);
        const leaning = his && everyPlay > 0
          ? ((his.get(shell) ?? 0) / Math.max(1, hisAll)) /
            Math.max(0.01, (everyShell.get(shell) ?? 0) / everyPlay)
          : 1;

        return base * (trust * leaning + (1 - trust));
      });
      const total = weights.reduce((a, b) => a + b, 0);
      let left = uniform() * total;

      for (let i = 0; i < SHELLS.length; i++) {
        left -= weights[i]!;

        if (left <= 0) {
          return SHELLS[i]!;
        }
      }

      return "nickel";
    },
    manRate: (shell, defence) => {
      const all = man.get(shell);
      const base = all && all.all > 0 ? all.man / all.all : 0.45;
      const his = defence ? man.get(`${defence}|${shell}`) : undefined;

      if (!his || his.all < 100) {
        return base;
      }

      const trust = his.all / (his.all + 300);

      return Math.max(0.05, Math.min(0.95,
        trust * (his.man / his.all) + (1 - trust) * base));
    },
  };
}
