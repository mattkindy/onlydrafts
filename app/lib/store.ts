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

// accents come off before the letters are kept, so Estimé and Estime
// are one man rather than two spellings
export const normalizeName = (name: string | null | undefined) =>
  (name ?? "")
    .normalize("NFD")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/, "")
    .replace(/[^a-z]/g, "");
