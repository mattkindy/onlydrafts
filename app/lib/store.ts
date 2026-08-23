/** What this browser remembers. Nothing here leaves the machine. */

const PREFIX = "dc.";

export function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);

    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

export function keep(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // a browser with storage turned off still works, it just forgets
  }
}

export function forget(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // nothing to do about it
  }
}

export const normalizeName = (name: string | null | undefined) =>
  (name ?? "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/, "")
    .replace(/[^a-z]/g, "");
