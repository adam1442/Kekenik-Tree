import { newGroup } from './layoutOps';
import type { DockLayout, DockNode } from './types';

/** Built-in layouts. Panel ids must match the registrations in src/ui/panels/registerPanels.ts. */

export const PANEL = {
  viewport: 'viewport',
  graph: 'graph',
  properties: 'properties',
  materials: 'materials',
  materialLibrary: 'material-library',
  meshes: 'meshes',
  masks: 'masks',
  displacements: 'displacements',
  lighting: 'lighting',
  viewportQuality: 'viewport-quality',
  timeline: 'timeline',
  library: 'library',
} as const;

const wrap = (root: DockNode): DockLayout => ({ version: 1, root, floating: [], maximizedGroup: null });

/** Default layout: Generation + Properties on the left, viewport centre, Materials tabs on the right. */
export function defaultLayout(): DockLayout {
  return wrap({
    kind: 'split',
    dir: 'row',
    sizes: [0.2, 0.62, 0.18],
    children: [
      {
        kind: 'split',
        dir: 'column',
        sizes: [0.38, 0.62],
        children: [newGroup([PANEL.graph]), newGroup([PANEL.properties])],
      },
      newGroup([PANEL.viewport]),
      newGroup([PANEL.materials, PANEL.materialLibrary, PANEL.meshes, PANEL.masks]),
    ],
  });
}

export function graphFocusedLayout(): DockLayout {
  return wrap({
    kind: 'split',
    dir: 'column',
    sizes: [0.62, 0.38],
    children: [
      {
        kind: 'split',
        dir: 'row',
        sizes: [0.58, 0.42],
        children: [newGroup([PANEL.graph]), newGroup([PANEL.viewport])],
      },
      {
        kind: 'split',
        dir: 'row',
        sizes: [0.55, 0.45],
        children: [
          newGroup([PANEL.properties]),
          newGroup([PANEL.materials, PANEL.materialLibrary, PANEL.meshes, PANEL.masks]),
        ],
      },
    ],
  });
}

export function viewportFocusedLayout(): DockLayout {
  return wrap({
    kind: 'split',
    dir: 'row',
    sizes: [0.78, 0.22],
    children: [
      newGroup([PANEL.viewport]),
      {
        kind: 'split',
        dir: 'column',
        sizes: [0.34, 0.66],
        children: [
          newGroup([PANEL.graph]),
          newGroup([PANEL.properties, PANEL.materials, PANEL.materialLibrary, PANEL.meshes, PANEL.masks]),
        ],
      },
    ],
  });
}

export interface LayoutPreset {
  id: string;
  label: string;
  build(): DockLayout;
}

/** Default layout with the preset Library as the first tab of the right-hand group (good for new users). */
export function libraryLayout(): DockLayout {
  return wrap({
    kind: 'split',
    dir: 'row',
    sizes: [0.2, 0.55, 0.25],
    children: [
      {
        kind: 'split',
        dir: 'column',
        sizes: [0.38, 0.62],
        children: [newGroup([PANEL.graph]), newGroup([PANEL.properties])],
      },
      newGroup([PANEL.viewport]),
      newGroup([PANEL.library, PANEL.materials, PANEL.materialLibrary, PANEL.meshes]),
    ],
  });
}

export const BUILTIN_LAYOUTS: LayoutPreset[] = [
  { id: 'default', label: 'Default', build: defaultLayout },
  { id: 'library', label: 'Library (presets)', build: libraryLayout },
  { id: 'graph', label: 'Graph-focused', build: graphFocusedLayout },
  { id: 'viewport', label: 'Viewport-focused', build: viewportFocusedLayout },
];
