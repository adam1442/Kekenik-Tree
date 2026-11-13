import type { AppContext } from '@/app/context';
import type { NodeCategory } from '@/contracts/nodes';
import type { GraphNode } from '@/graph/model/types';
import { ATTACHMENT_CATEGORIES } from '@/graph/ports';
import { listNodeDefs } from '@/graph/registry';
import { h } from '../../components/dom';
import { showMenu, type MenuItem } from '../../components/menu';
import { icon } from '../../icons/icons';
import { CATEGORY_LABELS, sortDefs } from './addNodePopup';

interface FooterSpec {
  category: NodeCategory;
  icon: string;
  title: string;
}

/**
 * Footer counters of the Generation panel, (magnet, materials, camera, meshes, path).
 * Attachment nodes (Force / Material / Mesh / Wind ...) are not drawn on the canvas: they live here.
 */
const SPECS: FooterSpec[] = [
  { category: 'force', icon: 'magnet', title: 'Forces' },
  { category: 'material', icon: 'materials', title: 'Materials' },
  { category: 'utility', icon: 'camera', title: 'Utilities' },
  { category: 'mesh', icon: 'meshList', title: 'Meshes' },
  { category: 'wind', icon: 'path', title: 'Wind' },
];

export interface GraphFooter {
  el: HTMLElement;
  dispose(): void;
}

export function createGraphFooter(app: AppContext): GraphFooter {
  const g = app.graph;
  const counters = new Map<NodeCategory, { btn: HTMLButtonElement; num: HTMLElement }>();
  const el = h('div', 'kt-graph-footer');

  /** Single selected hierarchy node (the attach target), if any. */
  const target = (): GraphNode | undefined => {
    const sel = g.getSelection();
    const n = sel.length === 1 ? g.model.getNode(sel[0] as string) : undefined;
    return n && g.model.isHierarchyNode(n) ? n : undefined;
  };

  const menuFor = (category: NodeCategory): MenuItem[] => {
    const tgt = target();
    const nodes = g.attachmentSummary().find((s) => s.category === category)?.nodes ?? [];
    const items: MenuItem[] = nodes.map((n) => {
      const attached = tgt ? g.model.attachmentTargets(n.id).some((t) => t.id === tgt.id) : false;
      const sub: MenuItem[] = [{ label: 'Select', run: () => g.select([n.id]) }];
      if (tgt) sub.push({ label: attached ? `Detach from ${tgt.name}` : `Attach to ${tgt.name}`, run: () => (attached ? g.detach(n.id, tgt.id) : void g.attach(n.id, tgt.id)) });
      sub.push(
        { label: 'Rename…', run: () => {
          g.select([n.id]);
          g.view?.startRename(n.id);
        } },
        { separator: true },
        { label: 'Delete', run: () => {
          g.select([n.id]);
          g.deleteSelection();
        } },
      );
      return { label: n.name, checked: attached, submenu: sub };
    });
    if (items.length > 0) items.push({ separator: true });
    const defs = sortDefs(listNodeDefs(category));
    items.push({
      label: `Add ${CATEGORY_LABELS[category].replace(/s$/, '')}`,
      disabled: defs.length === 0,
      submenu: defs.map((d) => ({ label: d.label, run: () => void g.addNode(d.type, { anchor: tgt ? { nodeId: tgt.id } : undefined }) })),
    });
    return items;
  };

  for (const spec of SPECS) {
    if (!ATTACHMENT_CATEGORIES.includes(spec.category)) continue;
    const num = h('span', 'kt-graph-zero', '0');
    const btn = h('button', 'kt-graph-counter has-menu', icon(spec.icon, 17), num);
    btn.type = 'button';
    btn.title = `${spec.title} - click to list, attach or add`;
    btn.setAttribute('aria-label', spec.title);
    btn.addEventListener('click', () => showMenu(menuFor(spec.category), btn));
    counters.set(spec.category, { btn, num });
    el.append(btn);
  }

  let raf = 0;
  const refresh = (): void => {
    raf = 0;
    for (const s of g.attachmentSummary()) {
      const c = counters.get(s.category);
      if (!c) continue;
      c.num.textContent = String(s.count);
      c.num.className = s.count > 0 ? 'kt-graph-badge' : 'kt-graph-zero';
    }
  };
  const schedule = (): void => {
    if (raf === 0) raf = window.setTimeout(refresh, 30);
  };
  refresh();
  const unsubs = [
    app.events.on('graph:changed', schedule),
    g.events.on('selectionChanged', schedule),
    g.events.on('modelSwapped', schedule),
  ];
  return {
    el,
    dispose: () => {
      window.clearTimeout(raf);
      unsubs.forEach((u) => u());
    },
  };
}
