import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryKeyValueStore } from '@/app/project/kvStore';
import { DEFAULT_PREFERENCES, sanitizePreferences } from '@/app/preferences';
import { formatCrashReport } from '@/app/crash';
import { hasTranslation, translate } from '@/i18n';
import { listNodeDefs, registerDiscoveredNodes } from '@/graph/registry';
import { PARAM_HELP_ENTRIES } from '@/graph/registry/paramHelp';
import { builtinPresets, filterPresets, PresetCatalog } from '@/presets/catalog';
import { SPECIES } from '@/presets/species';
import { buildSpeciesProject } from '@/presets/builder';
import { resolveNavMode } from '@/viewport/navScheme';

beforeAll(() => registerDiscoveredNodes());

describe('parameter help', () => {
  it('gives every ParamDef (and list sub-field) a tooltip', () => {
    const missing: string[] = [];
    for (const d of listNodeDefs()) {
      for (const p of d.params) {
        if (!p.tooltip) missing.push(`${d.type}.${p.id}`);
        if (p.kind === 'list') for (const f of p.fields) if (!f.tooltip) missing.push(`${d.type}.${p.id}.${f.id}`);
      }
    }
    expect(missing).toEqual([]);
    expect(PARAM_HELP_ENTRIES).toBeGreaterThan(200);
  });
});

describe('preset catalog', () => {
  it('filters by text and category', () => {
    const all = builtinPresets();
    expect(filterPresets(all, 'oak', 'All').map((p) => p.id)).toContain('oak');
    expect(filterPresets(all, '', 'Conifer').every((p) => p.category === 'Conifer')).toBe(true);
    expect(filterPresets(all, 'tropical frond', 'All').map((p) => p.id)).toEqual(['palm']);
    expect(filterPresets(all, 'zzzz', 'All')).toHaveLength(0);
  });

  it('stores, lists, exports and deletes user presets', async () => {
    const catalog = new PresetCatalog(new MemoryKeyValueStore());
    const def = SPECIES[0]!;
    const entry = await catalog.saveUser('My Oak', buildSpeciesProject(def));
    expect(entry.category).toBe('User');
    expect((await catalog.all()).length).toBe(SPECIES.length + 1);
    const out = await catalog.exportBytes(entry);
    expect(out.name).toBe('My Oak.ktree');
    const imported = await catalog.importBytes('Copy.ktree', out.bytes);
    expect(imported.name).toBe('Copy');
    expect((await entry.load()).graph.nodes.length).toBe(buildSpeciesProject(def).graph.nodes.length);
    await catalog.deleteUser(entry.id);
    expect((await catalog.userPresets()).map((p) => p.name)).toEqual(['Copy']);
    await expect(catalog.importBytes('bad.ktree', new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

describe('preferences, navigation, i18n, crash report', () => {
  it('sanitizes untrusted preferences', () => {
    expect(sanitizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    const p = sanitizePreferences({ uiScale: 9, navScheme: 'x', autosaveSeconds: -4, language: 'fa', performanceMode: 'yes' });
    expect(p.uiScale).toBe(1.6);
    expect(p.navScheme).toBe('kekenik');
    expect(p.autosaveSeconds).toBe(1);
    expect(p.language).toBe('fa');
    expect(p.performanceMode).toBe(false);
  });

  it('maps pointer events per navigation scheme', () => {
    const e = (button: number, mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}) => ({ button, shiftKey: false, altKey: false, ctrlKey: false, ...mods });
    expect(resolveNavMode('kekenik', e(0))).toBe('orbit');
    expect(resolveNavMode('kekenik', e(0, { shiftKey: true }))).toBe('pan');
    expect(resolveNavMode('kekenik', e(2))).toBe('dolly');
    expect(resolveNavMode('maya', e(0))).toBeNull();
    expect(resolveNavMode('maya', e(0, { altKey: true }))).toBe('orbit');
    expect(resolveNavMode('maya', e(2, { altKey: true }))).toBe('dolly');
    expect(resolveNavMode('blender', e(1))).toBe('orbit');
    expect(resolveNavMode('blender', e(1, { shiftKey: true }))).toBe('pan');
    expect(resolveNavMode('blender', e(0))).toBeNull();
  });

  it('translates with fallback and variables', () => {
    expect(translate('Library', 'fa')).not.toBe('Library');
    expect(translate('Unknown key', 'fa')).toBe('Unknown key');
    expect(translate('Hello {name}', 'en', { name: 'Ada' })).toBe('Hello Ada');
    expect(hasTranslation('Library', 'fa')).toBe(true);
  });

  it('formats a crash report with message, stack and log', () => {
    const r = formatCrashReport(new Error('boom'), ['[warn] engine: slow']);
    expect(r).toContain('Error: boom');
    expect(r).toContain('[warn] engine: slow');
  });
});
