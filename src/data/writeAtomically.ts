import { rename, writeFile } from "node:fs/promises";

/**
 * Writes the file beside itself and moves it into place, so a run that
 * dies partway through leaves the old file whole rather than half of a
 * new one. A download that is skipped once it exists would otherwise
 * keep a truncated copy for good.
 */
export async function writeAtomically(
  path: string, data: string | Uint8Array,
): Promise<void> {
  const part = `${path}.part`;

  await writeFile(part, data);
  await rename(part, path);
}
