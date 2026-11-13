import { applyQualityPreset, getQuality } from '@/viewport/quality/qualitySettings';
import { setNavScheme } from '@/viewport/navScheme';
import type { AppContext } from './context';
import { getPreferences, onPreferencesChange, type Preferences } from './preferences';

/** Applies preferences to the live app (UI zoom, camera scheme, autosave delay, quality) and keeps them in sync. */
export function installPreferences(app: AppContext): () => void {
  const apply = (p: Preferences, prev: Preferences | null): void => {
    document.body.style.zoom = p.uiScale === 1 ? '' : String(p.uiScale);
    document.documentElement.lang = p.language;
    document.documentElement.dir = p.language === 'fa' ? 'rtl' : 'ltr';
    setNavScheme(p.navScheme);
    app.project.setAutosaveMs(p.autosaveSeconds * 1000);
    if (!prev || prev.performanceMode !== p.performanceMode) {
      if (p.performanceMode) applyQualityPreset('low');
      else if (prev && getQuality().preset === 'low') applyQualityPreset('high');
    }
  };
  apply(getPreferences(), null);
  const off = onPreferencesChange(apply);
  return () => {
    off();
    document.body.style.zoom = '';
  };
}
