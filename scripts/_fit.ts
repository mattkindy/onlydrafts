// Points against the weather, within a side's own season.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const rows = parseCsv(await readFile(join(import.meta.dirname,"..","data","raw","games.csv"),"utf8"));
interface S { team:string; season:number; points:number; indoors:boolean; temp?:number; wind?:number }
const sides: S[] = [];
for (const r of rows) {
  const season = Number(r["season"]);
  if (!(season >= 2015 && season <= 2025) || r["game_type"] !== "REG") continue;
  const roof = r["roof"] ?? "";
  const indoors = /dome|closed/i.test(roof);
  const t = Number(r["temp"]); const w = Number(r["wind"]);
  for (const [team, points] of [[r["home_team"], Number(r["home_score"])],[r["away_team"], Number(r["away_score"])]] as [string,number][]) {
    if (!team || !Number.isFinite(points)) continue;
    sides.push({ team, season, points, indoors,
      temp: Number.isFinite(t) && t !== 0 ? t : undefined,
      wind: Number.isFinite(w) ? w : undefined });
  }
}
// take each side's own season average out, so only the day is left
const avg = new Map<string, {sum:number;n:number}>();
for (const s of sides) { const k=s.team+"|"+s.season; const a=avg.get(k)??{sum:0,n:0}; a.sum+=s.points; a.n++; avg.set(k,a); }
const usable = sides.filter(s => s.indoors || (s.temp !== undefined && s.wind !== undefined));
const row = (s: S) => {
  const cold = s.indoors ? 0 : Math.max(0, 60 - (s.temp ?? 60)) / 30;
  const wind = s.indoors ? 0 : (s.wind ?? 0) / 15;
  return [1, s.indoors ? 1 : 0, cold, wind];
};
const y = usable.map(s => { const a = avg.get(s.team+"|"+s.season)!; return s.points - a.sum/a.n; });
const w = fitRidge(usable.map(row), y, 1);
console.log("points against a side's own season average");
console.log("  base (mild, outdoors)   ", w[0]!.toFixed(2));
console.log("  under a roof            ", (w[0]!+w[1]!).toFixed(2), " so the roof is worth", w[1]!.toFixed(2));
console.log("  30F colder than 60      ", w[2]!.toFixed(2));
console.log("  15mph of wind           ", w[3]!.toFixed(2));
console.log();
const at = (indoors:boolean,temp:number,wind:number) =>
  predictRidge(w, row({team:"",season:0,points:0,indoors,temp,wind}));
const base = at(false,60,5);
console.log("as a multiplier on a 21.4 point side, against a mild still afternoon outdoors");
for (const [what,i,t,wi] of [["under a roof",1,60,0],["mild, still",0,60,5],["50F, 10mph",0,50,10],["35F, 10mph",0,35,10],["20F, 15mph",0,20,15],["60F, 20mph",0,60,20]] as [string,number,number,number][])
  console.log("  "+what.padEnd(16), ((21.4 + at(!!i,t,wi) - base)/21.4).toFixed(3));
