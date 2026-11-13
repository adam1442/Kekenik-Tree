import type { Box3, Object3D } from 'three';
import type { ViewMode } from '@/contracts/app';

export type { ViewMode };

export interface ContentStatGroup {
  label: string;
  triangles: number;
}

export interface ContentStats {
  groups: ContentStatGroup[];
  triangles: number;
  vertices: number;
  bones: number;
  skeletonBranches?: number;
  skeletonPoints?: number;
}

/**
 * What the viewport displays. Produced by the evaluation engine.
 * The viewport takes ownership: it calls dispose() when the content is replaced.
 */
export interface ViewportContent {
  root: Object3D;
  /** Optional line representation shown in 'skeleton' view mode. */
  skeleton?: Object3D;
  bounds: Box3;
  stats: ContentStats;
  dispose(): void;
}

export interface ViewportOptions {
  viewMode: ViewMode;
  showGrid: boolean;
  showGround: boolean;
  showHuman: boolean;
  sunIntensity: number;
}

export interface FrameInfo {
  fps: number;
  drawMs: number;
  distance: number;
}
