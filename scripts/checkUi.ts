/**
 * Catch the mistakes the page can only find by crashing in a browser.
 *
 * The draft tool is one html file with its script inline, so nothing
 * ever typechecked it, and twice in a day it shipped a name that did
 * not exist and a name used a line before it was made.
 *
 * Only the errors that mean the page will throw count as failures. The
 * dom types have plenty to say about `$("x").value`, which is right
 * about the types and wrong about the code.
 *
 * Run: npx tsx scripts/checkUi.ts
 */

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

/** the codes that mean it throws, rather than that a type is loose */
const THROWS = new Set([
  "TS2304", // cannot find name
  "TS2448", // used before its declaration
  "TS2454", // used before being assigned
  "TS2451", // redeclared
  "TS2393", // duplicate function
  "TS1005", // syntax
  "TS1128",
  "TS1308", // await outside an async function
  "TS2304",
  "TS2552", // cannot find name, did you mean
  "TS7027", // unreachable
]);

async function main(): Promise<void> {
  const page = join(import.meta.dirname, "..", "tools", "ui", "index.html");
  const html = await readFile(page, "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];

  if (!blocks.length) {
    console.error("no script in the page");
    process.exit(1);
  }

  const where = await mkdtemp(join(tmpdir(), "uicheck-"));
  const file = join(where, "page.js");
  await writeFile(file, blocks.map((b) => b[1]).join("\n"));
  let said = "";

  try {
    execFileSync("npx", [
      "tsc", "--allowJs", "--checkJs", "--noEmit", "--target", "es2022",
      "--lib", "es2022,dom", "--strict", "false", "--noImplicitAny", "false",
      file,
    ], { encoding: "utf8" });
  } catch (error) {
    said = String((error as { stdout?: string }).stdout ?? "");
  }

  await rm(where, { recursive: true, force: true });
  const bad = said.split("\n").filter((line) => {
    const code = line.match(/error (TS\d+):/);

    return code && THROWS.has(code[1]!);
  });

  if (bad.length) {
    console.error("the page will throw:");

    for (const line of bad) {
      console.error("  " + line.replace(/^.*page\.js/, "index.html script"));
    }

    process.exit(1);
  }

  console.log("nothing in the page will throw for a name it cannot find");
}

await main();
