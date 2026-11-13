import { getPreferences } from '@/app/preferences';
import { FA } from './fa';

/** Tiny i18n scaffold: English strings live in code (the key IS the English text); other languages override by key. */
const TABLES: Record<string, Record<string, string>> = { fa: FA };

export function translate(key: string, lang: string, vars?: Record<string, string | number>): string {
  const text = TABLES[lang]?.[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? `{${name}}`)) : text;
}

/** Translate `key` into the language selected in Preferences. */
export const t = (key: string, vars?: Record<string, string | number>): string => translate(key, getPreferences().language, vars);

export const hasTranslation = (key: string, lang: string): boolean => lang === 'en' || Boolean(TABLES[lang]?.[key]);
