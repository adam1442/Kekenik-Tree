import { describe, expect, it } from 'vitest';
import { BUILTIN_LAYOUTS, defaultLayout } from '@/ui/docking/layoutPresets';
import {
  allPanelIds,
  collectGroups,
  detachPanel,
  findGroup,
  insertIntoGroup,
  newGroup,
  prune,
  splitGroup,
} from '@/ui/docking/layoutOps';
import { parseLayout, serializeLayout } from '@/ui/docking/layoutSerializer';
import type { DockLayout, DockSplit } from '@/ui/docking/types';

const known = new Set(['viewport', 'graph', 'properties', 'materials', 'material-library', 'meshes', 'masks', 'timeline', 'library']);
const opts = { known, required: ['viewport'] };

describe('layoutOps', () => {
  it('detaching the last panel of a group prunes it and collapses the split', () => {
    const l = defaultLayout();
    detachPanel(l, 'graph');
    expect(findGroup(l, 'graph')).toBeNull();
    const left = (l.root as DockSplit).children[0];
    expect(left?.kind).toBe('group'); // column split with a single child collapsed
  });

  it('splitGroup creates a new group on the requested side', () => {
    const l = defaultLayout();
    detachPanel(l, 'masks');
    const target = findGroup(l, 'viewport');
    expect(target).not.toBeNull();
    splitGroup(l, 'masks', target!, 'bottom');
    const g = findGroup(l, 'masks');
    expect(g?.panels).toEqual(['masks']);
    const ids = allPanelIds(l);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('splitGroup in the same direction inserts as sibling and halves the size', () => {
    const l: DockLayout = {
      version: 1,
      root: { kind: 'split', dir: 'row', children: [newGroup(['a']), newGroup(['b'])], sizes: [0.5, 0.5] },
      floating: [],
      maximizedGroup: null,
    };
    const root = l.root as DockSplit;
    splitGroup(l, 'c', root.children[0] as never, 'right');
    const after = l.root as DockSplit;
    expect(after.children).toHaveLength(3);
    expect(after.sizes.reduce((s, v) => s + v, 0)).toBeCloseTo(1);
    expect(after.sizes[0]).toBeCloseTo(0.25);
  });

  it('insertIntoGroup activates the panel at the index', () => {
    const g = newGroup(['a', 'b']);
    insertIntoGroup(g, 'c', 1);
    expect(g.panels).toEqual(['a', 'c', 'b']);
    expect(g.active).toBe('c');
  });

  it('prune flattens nested splits of equal direction', () => {
    const node = prune({
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [newGroup(['a']), newGroup(['b'])] },
        newGroup(['c']),
      ],
    }) as DockSplit;
    expect(node.children).toHaveLength(3);
    expect(node.sizes[0]).toBeCloseTo(0.25);
  });

  it('collectGroups returns every group', () => {
    expect(collectGroups(defaultLayout().root)).toHaveLength(4);
  });
});

describe('layout serializer', () => {
  it('round-trips all built-in layouts', () => {
    for (const preset of BUILTIN_LAYOUTS) {
      const layout = preset.build();
      const parsed = parseLayout(JSON.parse(serializeLayout(layout)), opts);
      expect(parsed).not.toBeNull();
      expect(allPanelIds(parsed as DockLayout).sort()).toEqual(allPanelIds(layout).sort());
    }
  });

  it('rejects unknown versions and garbage', () => {
    expect(parseLayout({ version: 99, root: null, floating: [] }, opts)).toBeNull();
    expect(parseLayout('nope', opts)).toBeNull();
    expect(parseLayout(null, opts)).toBeNull();
  });

  it('drops unknown/duplicate panels and re-adds required ones', () => {
    const raw = {
      version: 1,
      root: { kind: 'group', id: 'g1', panels: ['graph', 'ghost', 'graph'], active: 'ghost' },
      floating: [{ id: 'f', panelId: 'graph', rect: { x: 1, y: 2, w: 300, h: 200 } }],
      maximizedGroup: 'missing',
    };
    const parsed = parseLayout(raw, opts) as DockLayout;
    expect(parsed.floating).toHaveLength(0); // graph already docked
    const g = collectGroups(parsed.root)[0];
    expect(g?.panels).toEqual(['graph', 'viewport']);
    expect(g?.active).toBe('graph');
    expect(parsed.maximizedGroup).toBeNull();
  });

  it('keeps floating panels with sanitised rects', () => {
    const raw = {
      version: 1,
      root: null,
      floating: [{ id: 'f', panelId: 'graph', rect: { x: 'bad', y: 5, w: 10, h: 10 }, minimized: true }],
      maximizedGroup: null,
    };
    const parsed = parseLayout(raw, opts) as DockLayout;
    expect(parsed.floating[0]?.rect.x).toBe(40);
    expect(parsed.floating[0]?.rect.w).toBe(120);
    expect(parsed.floating[0]?.minimized).toBe(true);
    expect(allPanelIds(parsed)).toContain('viewport');
  });
});
