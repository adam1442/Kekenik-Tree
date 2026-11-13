import { listPanelDefs } from '@/ui/docking/panelRegistry';
import { parseLayout, type ParseOptions } from '@/ui/docking/layoutSerializer';
import type { DockLayout } from '@/ui/docking/types';
import { loadJSON, saveJSON, STORAGE_KEYS } from './settings';

/** Persistence of the current layout and of user-named layouts (localStorage, validated on load). */
function parseOptions(): ParseOptions {
  const defs = listPanelDefs();
  return {
    known: new Set(defs.map((d) => d.id)),
    required: defs.filter((d) => d.closable === false).map((d) => d.id),
  };
}

export function loadCurrentLayout(): DockLayout | null {
  return parseLayout(loadJSON(STORAGE_KEYS.layoutCurrent), parseOptions());
}

export function saveCurrentLayout(layout: DockLayout): void {
  saveJSON(STORAGE_KEYS.layoutCurrent, layout);
}

function savedMap(): Record<string, unknown> {
  const raw = loadJSON(STORAGE_KEYS.layoutsSaved);
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

export function listSavedLayouts(): string[] {
  return Object.keys(savedMap()).sort();
}

export function saveNamedLayout(name: string, layout: DockLayout): void {
  saveJSON(STORAGE_KEYS.layoutsSaved, { ...savedMap(), [name]: layout });
}

export function loadNamedLayout(name: string): DockLayout | null {
  return parseLayout(savedMap()[name], parseOptions());
}

export function deleteNamedLayout(name: string): void {
  const map = savedMap();
  delete map[name];
  saveJSON(STORAGE_KEYS.layoutsSaved, map);
}
