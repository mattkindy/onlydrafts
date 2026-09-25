/**
 * Writing the files kept under data/kept, which several processes can be
 * reading and writing at once: the shares of one walk, or two builds raced
 * against each other on the same data folder.
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
