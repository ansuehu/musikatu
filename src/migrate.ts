/**
 * The app used to be called "Earwork": move its saved preferences, shortcuts and (browser-mode)
 * projects from the old `earwork.*` localStorage keys to `musikatu.*`, once. Runs before anything reads them.
 */
export function migrateStorageKeys(): void {
  try {
    const old: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('earwork.')) old.push(k)
    }
    for (const k of old) {
      const nk = 'musikatu.' + k.slice('earwork.'.length)
      if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k) ?? '')
      localStorage.removeItem(k)
    }
  } catch {
    /* storage unavailable: nothing to migrate */
  }
}
