import type { InstanceRef } from '@/instances/types';
/** Undo/redo command + global application state shape. */

export interface Command {
  /** Human readable, shown in Edit menu ("Undo Randomize"). */
  label: string;
  do(): void;
  undo(): void;
  /** Optionally merge a following command (slider drags). Return true if merged. */
  merge?(next: Command): boolean;
}

/** Toolbar Mode switch: global parameters, per-instance editing, hand-drawn (not available yet). */
export type EditMode = 'generator' | 'node' | 'freehand';

/**
 * Viewport view modes. `skeleton` = generation-coloured skeleton lines, `points` = round constant-size vertices and
 * skeleton samples, `normals` = shaded surface + vertex-normal lines, `normalColors` = normal-as-colour shading,
 * `vertexColor` = baked vertex colours only (the Tree > Vertex Color packing), `vertexColorR / G / B` = one channel of it as grey (Kekenik packing: R branch tint, G height, B ambient occlusion; `ao` shows the analytic AO), `windWeights` = wind weights w0 / w1 / w2 (trunk / branch / leaf) as R / G / B, `alpha` = alpha-coverage diagnostic of cut-out materials, `lightmapDensity` = texel density of the lightmap UVs (UV1) against the Tree > Lightmap target (green = ideal, blue = too low, red = too high).
 */
export type ViewMode = 'shaded' | 'wireframe' | 'shadedWire' | 'flat' | 'skeleton' | 'points' | 'normals' | 'uv' | 'vertexColor' | 'vertexColorR' | 'vertexColorG' | 'vertexColorB' | 'normalColors' | 'ao' | 'windWeights' | 'alpha' | 'lightmapDensity';

/** All view modes in menu order (single source of truth for state, commands and the toolbar). */
export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  shaded: 'Shaded',
  wireframe: 'Wireframe',
  shadedWire: 'Shaded + Wireframe',
  flat: 'Unlit / Flat',
  skeleton: 'Skeleton Lines',
  points: 'Points',
  normals: 'Normals (lines)',
  uv: 'UV checker',
  vertexColor: 'Vertex color',
  vertexColorR: 'Vertex color: R channel',
  vertexColorG: 'Vertex color: G channel',
  vertexColorB: 'Vertex color: B channel',
  normalColors: 'Normals (colour)',
  ao: 'Ambient occlusion',
  windWeights: 'Wind weights',
  alpha: 'Alpha coverage',
  lightmapDensity: 'Lightmap density',
};

export const VIEW_MODES: readonly ViewMode[] = ['shaded', 'wireframe', 'shadedWire', 'flat', 'skeleton', 'points', 'normals', 'uv', 'vertexColor', 'normalColors', 'ao', 'windWeights', 'alpha', 'vertexColorR', 'vertexColorG', 'vertexColorB', 'lightmapDensity'];

export interface DocumentInfo {
  id: string;
  name: string;
  seed: number;
}

export interface FrameStats {
  triangles: number;
  vertices: number;
  fps: number;
  generationMs: number;
  drawMs: number;
  cameraDistance: number;
}

export interface AppState {
  editMode: EditMode;
  /** Instances selected in the viewport (Node mode). */
  instanceSelection: InstanceRef[];
  instanceHover: InstanceRef | null;
  /** Spine overlays are drawn through geometry (Show menu). */
  spinesOnTop: boolean;
  /** Show > Attachment frames: axis triads at cutout instance bases and anchors. */
  showAttachmentFrames: boolean;
  documents: DocumentInfo[];
  activeDocumentId: string;
  /** Selected graph node ids. */
  selection: string[];
  selectionLabel: string;
  viewMode: ViewMode;
  showGrid: boolean;
  showAxes: boolean;
  showStats: boolean;
  showGround: boolean;
  showHuman: boolean;
  showSkeletonPoints: boolean;
  showSkeletonRadii: boolean;
  showSkeletonFrames: boolean;
  showOpenEnds: boolean;
  sunIntensity: number;
  lodLevel: 'Highest' | 'High' | 'Medium' | 'Low';
  stats: FrameStats;
  /** Transient status-bar message. */
  message: string;
  /** The evaluation engine is currently computing (status bar progress). */
  evaluating: boolean;
  /** 0..1 progress of the running evaluation pass. */
  evaluationProgress: number;
  /** The current result is the quick low-detail preview; a refined pass follows. */
  evaluationPreview: boolean;
  /** Active document has unsaved changes (derived from the undo stack). */
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
}
