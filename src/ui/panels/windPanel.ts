import { getApp } from '@/app/context';
import type { WindSettings } from '@/contracts/material';
import { getWindSystem } from '@/viewport/wind/windSystem';
import { WIND_PARAM_RANGES, windParamsFromSettings, writeWindParam, type WindNumericKey } from '@/viewport/wind/windParams';
import { h } from '../components/dom';
import { createSelect } from '../components/select';
import type { PanelContext, PanelInstance } from '../docking/panelRegistry';
import { icon, registerIcon } from '../icons/icons';

registerIcon('play', '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>');
registerIcon('pause', '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>');

interface RowHandle {
  sync(): void;
}

/** Wind & animation timeline panel (registered under the `timeline` id): playback, scrubbing and the project wind. */
export function createWindPanel(host: HTMLElement, _ctx: PanelContext): PanelInstance {
  const app = getApp();
  const wind = getWindSystem();
  host.classList.add('kt-wind');

  const settings = (): WindSettings | null => app.project.metaOf(app.store.get().activeDocumentId)?.settings.wind ?? null;
  const rows: RowHandle[] = [];

  const row = (label: string, ...controls: HTMLElement[]): HTMLElement => h('div', 'kt-wind-row', h('label', 'kt-wind-label', label), ...controls);
  const check = (get: () => boolean, set: (v: boolean) => void): { el: HTMLInputElement } & RowHandle => {
    const el = h('input', 'kt-wind-check');
    el.type = 'checkbox';
    el.addEventListener('change', () => set(el.checked));
    return { el, sync: () => (el.checked = get()) };
  };
  const slider = (min: number, max: number, step: number, get: () => number, set: (v: number) => void): { wrap: HTMLElement } & RowHandle => {
    const range = h('input', 'kt-wind-range');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    const num = h('input', 'kt-wind-num');
    num.type = 'number';
    num.step = String(step);
    range.addEventListener('input', () => {
      num.value = range.value;
      set(Number(range.value));
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) {
        range.value = String(v);
        set(v);
      }
    });
    return {
      wrap: h('div', 'kt-wind-slider', range, num),
      sync: () => {
        const v = get();
        if (document.activeElement !== num) num.value = String(Math.round(v * 1000) / 1000);
        range.value = String(v);
      },
    };
  };

  const commit = (key: WindNumericKey | 'enabled', value: number | boolean): void => {
    const s = settings();
    if (!s) return;
    if (key === 'enabled') s.enabled = Boolean(value);
    else writeWindParam(s, key, Number(value));
    app.undo.markDirty();
    wind.syncProject(s);
    sync();
  };

  // --- Preview section
  const enabled = check(() => wind.params.enabled, (v) => commit('enabled', v));
  const playBtn = h('button', 'kt-wind-btn');
  playBtn.type = 'button';
  playBtn.addEventListener('click', () => wind.patchState({ playing: !wind.state.playing }));
  const timeScale = slider(0, 4, 0.05, () => wind.state.timeScale, (v) => wind.patchState({ timeScale: v }));
  const time = slider(0, wind.state.loopLength, 0.01, () => wind.state.clock % wind.state.loopLength, (v) => wind.scrub(v));
  const loop = check(() => wind.state.loop, (v) => wind.patchState({ loop: v }));
  const arrow = check(() => wind.state.showArrow, (v) => wind.patchState({ showArrow: v }));
  const quality = createSelect({ options: ['High', 'Low'], value: wind.state.quality === 'high' ? 'High' : 'Low', width: 80, onChange: (v) => wind.patchState({ quality: v === 'High' ? 'high' : 'low' }) });
  const note = h('div', 'kt-wind-note', '');
  rows.push(enabled, timeScale, time, loop, arrow);

  const preview = h(
    'div',
    'kt-wind-section',
    h('div', 'kt-wind-title', 'Preview'),
    row('Wind', enabled.el, playBtn),
    row('Time scale', timeScale.wrap),
    row('Timeline (s)', time.wrap),
    row('Loop', loop.el),
    row('Quality', quality),
    row('Wind arrow', arrow.el),
    note,
  );

  // --- Parameter sections
  const sections = new Map<string, HTMLElement>();
  for (const r of WIND_PARAM_RANGES) {
    let sec = sections.get(r.group);
    if (!sec) {
      sec = h('div', 'kt-wind-section', h('div', 'kt-wind-title', r.group));
      sections.set(r.group, sec);
    }
    const s = slider(r.min, r.softMax, r.step, () => windParamsFromSettings(settings())[r.key], (v) => commit(r.key, v));
    rows.push(s);
    sec.append(row(r.unit ? `${r.label} (${r.unit})` : r.label, s.wrap));
  }

  host.append(preview, ...sections.values());

  const sync = (): void => {
    rows.forEach((r) => r.sync());
    playBtn.replaceChildren(icon(wind.state.playing ? 'pause' : 'play', 14), h('span', '', wind.state.playing ? 'Pause' : 'Play'));
    note.textContent = wind.overridden ? 'A Wind node attached to the Tree overrides the project wind settings.' : '';
  };
  sync();
  const unsub = wind.onChange(sync);
  const unStore = app.store.select((s) => s.activeDocumentId, () => sync());
  return {
    onShow: sync,
    dispose: () => {
      unsub();
      unStore();
    },
  };
}
