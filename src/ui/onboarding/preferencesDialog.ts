import type { AppContext } from '@/app/context';
import { getPreferences, setPreferences, type Language } from '@/app/preferences';
import { t } from '@/i18n';
import { NAV_SCHEMES, type NavScheme } from '@/viewport/navScheme';
import { showInfoDialog } from '../components/dialogs';
import { h } from '../components/dom';

/** Edit > Preferences…: every change applies immediately and is stored in localStorage. */
export function showPreferences(app: AppContext): void {
  const p = getPreferences();
  const row = (label: string, control: HTMLElement, hint?: string): HTMLElement => h('div', 'kt-prefs-row', h('label', '', label), control, hint ? h('small', '', hint) : null);

  const scale = h('select');
  for (const v of [0.85, 1, 1.15, 1.3, 1.5]) {
    const o = h('option', '', `${Math.round(v * 100)}%`);
    o.value = String(v);
    o.selected = Math.abs(v - p.uiScale) < 0.01;
    scale.append(o);
  }
  scale.addEventListener('change', () => setPreferences({ uiScale: Number(scale.value) }));

  const nav = h('select');
  for (const s of NAV_SCHEMES) {
    const o = h('option', '', s.label);
    o.value = s.id;
    o.selected = s.id === p.navScheme;
    nav.append(o);
  }
  const navHelp = h('small', '', NAV_SCHEMES.find((s) => s.id === p.navScheme)?.help ?? '');
  nav.addEventListener('change', () => {
    setPreferences({ navScheme: nav.value as NavScheme });
    navHelp.textContent = NAV_SCHEMES.find((s) => s.id === nav.value)?.help ?? '';
  });

  const autosave = h('input');
  autosave.type = 'number';
  autosave.min = '1';
  autosave.max = '600';
  autosave.value = String(p.autosaveSeconds);
  autosave.addEventListener('change', () => setPreferences({ autosaveSeconds: Number(autosave.value) }));

  const perf = h('input');
  perf.type = 'checkbox';
  perf.checked = p.performanceMode;
  perf.addEventListener('change', () => setPreferences({ performanceMode: perf.checked }));

  const lang = h('select');
  for (const [id, label] of [['en', 'English'], ['fa', 'فارسی (partial)']] as const) {
    const o = h('option', '', label);
    o.value = id;
    o.selected = id === p.language;
    lang.append(o);
  }
  lang.addEventListener('change', () => {
    setPreferences({ language: lang.value as Language });
    app.notify('Language applies to panels opened from now on; reload to translate everything.');
  });

  const welcome = h('input');
  welcome.type = 'checkbox';
  welcome.checked = p.showWelcome;
  welcome.addEventListener('change', () => setPreferences({ showWelcome: welcome.checked }));

  const body = h(
    'div',
    'kt-prefs',
    row(t('UI scale'), scale, 'Zooms the whole interface.'),
    row(t('Navigation'), nav),
    navHelp,
    row(t('Autosave delay (s)'), autosave, 'Seconds after your last edit before crash-recovery data is written.'),
    row(t('Performance mode'), perf, 'Uses the Low viewport quality preset (no MSAA/TAA, 1× pixel ratio).'),
    row(t('Language'), lang),
    row(t('Show this window at startup'), welcome),
  );
  showInfoDialog(app.dialogLayer, t('Preferences'), body, { w: 460, h: 420 });
}
