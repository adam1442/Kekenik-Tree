import type { Rect } from '@/core/math';

/** Serializable dock layout model. */
export type SplitDir = 'row' | 'column';
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

export interface DockGroup {
  kind: 'group';
  id: string;
  panels: string[];
  active: string;
  /** Header-only (only honoured inside column splits). */
  collapsed?: boolean;
}

export interface DockSplit {
  kind: 'split';
  dir: SplitDir;
  children: DockNode[];
  /** Fractions, same length as children, sum ~ 1. */
  sizes: number[];
}

export type DockNode = DockGroup | DockSplit;

export interface FloatingPanel {
  id: string;
  panelId: string;
  rect: Rect;
  minimized: boolean;
  maximized: boolean;
  /** Where to dock back to (best effort). */
  home?: { groupId: string; index: number };
}

export interface DockLayout {
  version: 1;
  root: DockNode | null;
  floating: FloatingPanel[];
  maximizedGroup: string | null;
}

export const LAYOUT_VERSION = 1;
