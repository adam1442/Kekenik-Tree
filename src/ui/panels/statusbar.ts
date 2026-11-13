import type { AppState } from '@/contracts/app';
import type { Store } from '@/core/store';
import { h } from '../components/dom';

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Status bar: message · selection · triangles · vertices · generation time · FPS. */
export function createStatusBar(store: Store<AppState>): { el: HTMLElement; dispose(): void } {
  const msg = h('div', 'kt-statusbar-msg', '');
  const sel = h('span', '', '');
  const tris = h('span', '', '');
  const verts = h('span', '', '');
  const gen = h('span', '', '');
  const fps = h('span', '', '');
  const cell = (label: string, v: HTMLElement): HTMLElement => h('div', '', `${label} `, v);
  const render = (s: AppState): void => {
    msg.textContent = s.message || (s.evaluating ? `${s.evaluationPreview ? 'Refining' : 'Generating'}… ${Math.round(s.evaluationProgress * 100)}%` : '');
    sel.textContent = s.selection.length > 0 ? s.selectionLabel : 'None';
    tris.textContent = fmt(s.stats.triangles);
    verts.textContent = fmt(s.stats.vertices);
    gen.textContent = `${s.stats.generationMs.toFixed(1)} ms${s.evaluationPreview ? ' (preview)' : ''}`;
    fps.textContent = s.stats.fps > 0 ? String(Math.round(s.stats.fps)) : '–';
  };
  for (const v of [sel, tris, verts, gen, fps]) v.style.fontWeight = '500';
  const el = h('div', 'kt-statusbar', msg, cell('Selection:', sel), cell('Triangles:', tris), cell('Vertices:', verts), cell('Generation:', gen), cell('FPS:', fps));
  render(store.get());
  const unsub = store.subscribe((s) => render(s));
  return { el, dispose: unsub };
}
