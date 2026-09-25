/**
 * Writing the files kept under data/kept, which several processes can be
 * reading and writing at once: the shares of one walk, or two builds raced
 * against each other on the same data folder.
 */

import {
  mkdir, readdir, rename, stat, unlink, writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writes the text beside the file and then moves it into place, so a
 * process reading the file while another writes it finds all of it or
 * none of it. A failed write leaves nothing behind.
 */
export async function writeAside(at: string, text: string): Promise<void> {
  const part = `${at.replace(/\.json$/, "")}.${process.pid}.part.json`;
  await mkdir(dirname(at), { recursive: true }).catch(() => undefined);
  await writeFile(part, text)
    .then(() => rename(part, at))
    .catch(() => unlink(part).catch(() => undefined));
}

/**
 * Deletes the older files of the same kind as the one just written, but
 * keeps the newest of them, so two are left. A process that started before
 * the play file changed may still be about to read that one, and a process
 * that already has an older file open reads it to the end even after it
 * is deleted. Anything that cannot be listed or deleted is left alone.
 */
export async function pruneOlder(
  at: string, sameKind: (name: string) => boolean,
): Promise<void> {
  const folder = dirname(at);
  const names = await readdir(folder).catch((): string[] => []);
  const older = await Promise.all(names
    .filter((name) => name !== basename(at) && sameKind(name))
    .map(async (name) => ({
      name,
      changed: await stat(join(folder, name)).then((s) => s.mtimeMs, () => -1),
    })));

  older.sort((a, b) => b.changed - a.changed);

  for (const { name } of older.slice(1)) {
    await unlink(join(folder, name)).catch(() => undefined);
  }
}
