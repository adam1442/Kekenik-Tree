import { commandItem } from '@/app/menus';
import type { AppContext } from '@/app/context';
import type { AddNodeOptions } from '@/app/graphSession';
import type { NodeDef } from '@/contracts/nodes';
import type { Pt } from './viewTransform';
import { matchPorts } from '@/graph/ports';
import { listNodeDefs } from '@/graph/registry';
import type { MenuItem } from '../../components/menu';
import { CATEGORY_LABELS, CATEGORY_ORDER, sortDefs } from './addNodePopup';

/** What the menus need from the graph view (implemented by GraphCanvas). */
export interface MenuHost {
  readonly app: AppContext;
  /** Open the searchable add popup at a screen position, optionally anchored/placed. */
  openAddNode(screen: Pt, anchor?: AddNodeOptions['anchor'], world?: Pt): void;
  startRename(nodeId: string): void;
  startEditAnnotation(annId: string): void;
}

const ANN_COLORS = ['blue', 'green', 'yellow', 'red', 'gray'];

/** Node types that may be added, restricted to those that can connect to the anchor node (auto side). */
export function compatibleDefs(app: AppContext, anchorId?: string): NodeDef[] {
  const model = app.graph.model;
  const anchor = anchorId ? model.getNode(anchorId) : undefined;
  const adef = anchor && model.getDef(anchor);
  return listNodeDefs().filter((d) => {
    if (!app.graph.canAdd(d.type)) return false;
    if (!adef) return true;
    const hier = d.ports.some((p) => p.edge === 'hierarchy');
    return hier ? matchPorts(adef, d, 'hierarchy') !== null : matchPorts(d, adef, 'attachment') !== null;
  });
}

function defItems(defs: NodeDef[], run: (def: NodeDef) => void): MenuItem[] {
  return sortDefs(defs).map((d) => ({ label: d.label, run: () => run(d) }));
}

/** Categorised "Add" submenu content. */
export function addMenuItems(host: MenuHost, defs: NodeDef[], anchor: AddNodeOptions['anchor'] | undefined, world: Pt | undefined, screen: Pt): MenuItem[] {
  const items: MenuItem[] = [{ label: 'Search…', shortcut: 'Tab', run: () => host.openAddNode(screen, anchor, world) }];
  const sorted = sortDefs(defs);
  const cats = CATEGORY_ORDER.filter((c) => sorted.some((d) => d.category === c));
  if (cats.length > 0) items.push({ separator: true });
  for (const cat of cats) {
    items.push({
      label: CATEGORY_LABELS[cat],
      submenu: defItems(
        sorted.filter((d) => d.category === cat),
        (d) => void host.app.graph.addNode(d.type, { anchor, x: world?.x, y: world?.y, exact: world !== undefined }),
      ),
    });
  }
  return items;
}

export function nodeContextMenu(host: MenuHost, nodeId: string, screen: Pt): MenuItem[] {
  const { app } = host;
  const g = app.graph;
  const c = (id: string, label?: string): MenuItem => commandItem(app, id, label);
  const node = g.model.getNode(nodeId);
  if (!node) return [];
  if (!g.getSelection().includes(nodeId)) g.select([nodeId]);
  const hasChildren = g.model.childrenOf(nodeId).length > 0;
  const addable = compatibleDefs(app, nodeId);
  return [
    { label: 'Add Child', disabled: addable.length === 0, submenu: addMenuItems(host, addable, { nodeId }, undefined, screen) },
    { separator: true },
    c('graph.rename'),
    c('edit.duplicate'),
    c('edit.copy'),
    c('edit.cut'),
    c('edit.delete'),
    c('graph.deleteKeepChildren'),
    { separator: true },
    c('graph.toggleEnabled', node.enabled ? 'Disable' : 'Enable'),
    c('graph.toggleBypass', node.bypass ? 'Remove Bypass' : 'Bypass'),
    c('graph.toggleSolo', node.solo ? 'Unsolo' : 'Solo'),
    { ...c('graph.toggleCollapse', node.collapsed ? 'Expand Branch' : 'Collapse Branch'), disabled: !hasChildren && !node.collapsed },
    c('graph.toggleLock', node.locked ? 'Unlock' : 'Lock'),
    { separator: true },
    { label: 'Select', submenu: [c('graph.selectParent'), c('graph.selectChildren'), c('graph.selectSubtree')] },
    c('graph.layoutSelection'),
    c('graph.frame'),
  ];
}

export function canvasContextMenu(host: MenuHost, screen: Pt, world: Pt): MenuItem[] {
  const { app } = host;
  const c = (id: string, label?: string): MenuItem => commandItem(app, id, label);
  return [
    { label: 'Add Node', submenu: addMenuItems(host, compatibleDefs(app), undefined, world, screen) },
    { separator: true },
    { ...c('edit.paste'), run: () => app.graph.paste(world) },
    c('edit.selectAll'),
    { separator: true },
    { label: 'Add Group', run: () => void app.graph.addGroup(world) },
    { label: 'Add Comment', run: () => void app.graph.addComment(world) },
    { separator: true },
    c('graph.autoLayout'),
    c('graph.fit'),
  ];
}

export function edgeContextMenu(host: MenuHost, edgeId: string): MenuItem[] {
  return [{ label: 'Delete Link', shortcut: 'Del', run: () => host.app.graph.removeEdges([edgeId]) }];
}

export function annotationContextMenu(host: MenuHost, annId: string): MenuItem[] {
  const g = host.app.graph;
  const a = g.model.getAnnotation(annId);
  if (!a) return [];
  return [
    { label: a.kind === 'group' ? 'Rename Group' : 'Edit Comment', run: () => host.startEditAnnotation(annId) },
    {
      label: 'Color',
      submenu: ANN_COLORS.map((color) => ({
        label: color.charAt(0).toUpperCase() + color.slice(1),
        checked: a.color === color,
        run: () => g.patchAnnotation(annId, { color }, undefined, 'Annotation Color'),
      })),
    },
    { separator: true },
    { label: a.kind === 'group' ? 'Delete Group' : 'Delete Comment', run: () => g.removeAnnotation(annId) },
  ];
}

/** "Actions" toolbar menu. */
export function actionsMenu(host: MenuHost): MenuItem[] {
  const c = (id: string, label?: string): MenuItem => commandItem(host.app, id, label);
  return [
    c('graph.autoLayout'),
    c('graph.layoutSelection'),
    { separator: true },
    c('graph.fit'),
    c('graph.frame'),
    { separator: true },
    {
      label: 'Align',
      submenu: ['left', 'right', 'top', 'bottom', 'centerX', 'centerY'].map((m) => c(`graph.align.${m}`)),
    },
    { label: 'Distribute', submenu: [c('graph.distribute.x'), c('graph.distribute.y')] },
    { separator: true },
    { label: 'Select', submenu: [c('edit.selectAll'), c('graph.clearSelection'), c('graph.selectParent'), c('graph.selectChildren'), c('graph.selectSubtree')] },
    c('graph.group'),
    { separator: true },
    c('graph.toggleEnabled'),
    c('graph.toggleBypass'),
    c('graph.toggleSolo'),
    c('graph.toggleCollapse'),
    c('graph.toggleLock'),
  ];
}

/** Gear menu: view options. */
export function settingsMenu(host: MenuHost): MenuItem[] {
  const g = host.app.graph;
  const st = g.settings;
  return [
    { label: 'Show Grid', checked: st.showGrid, run: () => g.updateSettings({ showGrid: !st.showGrid }) },
    { label: 'Snap to Grid', checked: st.snapToGrid, run: () => g.updateSettings({ snapToGrid: !st.snapToGrid }) },
    { separator: true },
    { label: 'Show Node Names', checked: st.showLabels, run: () => g.updateSettings({ showLabels: !st.showLabels }) },
    { label: 'Show Link Counts', checked: st.showEdgeLabels, run: () => g.updateSettings({ showEdgeLabels: !st.showEdgeLabels }) },
  ];
}
