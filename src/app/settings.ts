/** localStorage wrapper (never throws; the app must work with storage disabled). */
const PREFIX = 'kekenik.';

export const STORAGE_KEYS = {
  layoutCurrent: 'layout.current',
  layoutsSaved: 'layout.saved',
  view: 'view',
} as const;

export function loadJSON(key: string): unknown {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full — ignore */
  }
}

