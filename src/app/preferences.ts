import { NAV_SCHEMES, type NavScheme } from '@/viewport/navScheme';
import { loadJSON, saveJSON } from './settings';

export type Language = 'en' | 'fa';

export interface Preferences {
  /** Whole-UI zoom factor (0.8 .. 1.6). */
  uiScale: number;
  navScheme: NavScheme;
  /** Seconds after the last edit before the recovery autosave runs (1 .. 600). */
  autosaveSeconds: number;
  /** Low viewport quality preset for weak GPUs. */
  performanceMode: boolean;
  language: Language;
  showWelcome: boolean;
  tourDone: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  uiScale: 1,
  navScheme: 'kekenik',
  autosaveSeconds: 2,
  performanceMode: false,
  language: 'en',
  showWelcome: true,
  tourDone: false,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Validates untrusted JSON (localStorage / imported) and fills defaults. */
export function sanitizePreferences(raw: unknown): Preferences {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PREFERENCES;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  return {
    uiScale: clamp(num(r.uiScale, d.uiScale), 0.8, 1.6),
    navScheme: NAV_SCHEMES.some((s) => s.id === r.navScheme) ? (r.navScheme as NavScheme) : d.navScheme,
    autosaveSeconds: clamp(Math.round(num(r.autosaveSeconds, d.autosaveSeconds)), 1, 600),
    performanceMode: typeof r.performanceMode === 'boolean' ? r.performanceMode : d.performanceMode,
    language: r.language === 'fa' ? 'fa' : 'en',
    showWelcome: typeof r.showWelcome === 'boolean' ? r.showWelcome : d.showWelcome,
    tourDone: typeof r.tourDone === 'boolean' ? r.tourDone : d.tourDone,
  };
}

let current: Preferences = sanitizePreferences(loadJSON('preferences'));
const listeners = new Set<(p: Preferences, prev: Preferences) => void>();

export const getPreferences = (): Preferences => current;

export function setPreferences(patch: Partial<Preferences>): void {
  const prev = current;
  current = sanitizePreferences({ ...current, ...patch });
  saveJSON('preferences', current);
  listeners.forEach((l) => l(current, prev));
}

export function onPreferencesChange(fn: (p: Preferences, prev: Preferences) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
