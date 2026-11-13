import { VIEW_MODES, type AppState, type DocumentInfo, type ViewMode } from '@/contracts/app';
import { Store } from '@/core/store';
import { loadJSON, saveJSON, STORAGE_KEYS } from './settings';


type ViewPrefs = Pick<
  AppState,
  | 'viewMode'
  | 'showGrid'
  | 'showAxes'
  | 'showStats'
  | 'showGround'
  | 'showHuman'
  | 'showSkeletonPoints'
  | 'showSkeletonRadii'
  | 'showSkeletonFrames'
  | 'spinesOnTop'
  | 'showAttachmentFrames'
  | 'sunIntensity'
  | 'lodLevel'
>;

const DEFAULT_VIEW: ViewPrefs = {
  viewMode: 'shaded',
  showGrid: true,
  showAxes: true,
  showStats: true,
  showGround: true,
  showHuman: true,
  showSkeletonPoints: true,
  showSkeletonRadii: true,
  showSkeletonFrames: false,
  spinesOnTop: true,
  showAttachmentFrames: false,
  sunIntensity: 1.5,
  lodLevel: 'High',
};

function loadViewPrefs(): ViewPrefs {
  const raw = loadJSON(STORAGE_KEYS.view);
  if (typeof raw !== 'object' || raw === null) return DEFAULT_VIEW;
  const r = raw as Record<string, unknown>;
  const bool = (k: keyof ViewPrefs, d: boolean): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : d);
  return {
    viewMode: VIEW_MODES.includes(r.viewMode as ViewMode) ? (r.viewMode as ViewMode) : DEFAULT_VIEW.viewMode,
    showGrid: bool('showGrid', true),
    showAxes: bool('showAxes', true),
    showStats: bool('showStats', true),
    showGround: bool('showGround', true),
    showHuman: bool('showHuman', true),
    showSkeletonPoints: bool('showSkeletonPoints', true),
    showSkeletonRadii: bool('showSkeletonRadii', true),
    showSkeletonFrames: bool('showSkeletonFrames', false),
    spinesOnTop: bool('spinesOnTop', true),
    showAttachmentFrames: bool('showAttachmentFrames', false),
    sunIntensity: typeof r.sunIntensity === 'number' ? r.sunIntensity : DEFAULT_VIEW.sunIntensity,
    lodLevel: DEFAULT_VIEW.lodLevel,
  };
}

/** First document of a session; the project manager fills it (default graph or crash recovery). */
const DOCUMENTS: DocumentInfo[] = [{ id: 'doc-1', name: 'Untitled', seed: 1337 }];

export function createAppStore(): Store<AppState> {
  const store = new Store<AppState>({
    editMode: 'generator',
    instanceSelection: [],
    instanceHover: null,
    documents: DOCUMENTS.map((d) => ({ ...d })),
    activeDocumentId: 'doc-1',
    selection: [],
    selectionLabel: '',
    ...loadViewPrefs(),
    stats: { triangles: 0, vertices: 0, fps: 0, generationMs: 0, drawMs: 0, cameraDistance: 0 },
    message: '',
    evaluating: false,
    evaluationProgress: 0,
    evaluationPreview: false,
    dirty: false,
    canUndo: false,
    canRedo: false,
    undoLabel: '',
    redoLabel: '',
  });
  // Persist view preferences.
  store.subscribe((s, prev) => {
    const keys: (keyof ViewPrefs)[] = [
      'viewMode',
      'showGrid',
      'showAxes',
      'showStats',
      'showGround',
      'showHuman',
      'showSkeletonPoints',
      'showSkeletonRadii',
      'showSkeletonFrames',
      'spinesOnTop',
      'showAttachmentFrames',
      'sunIntensity',
    ];
    if (keys.some((k) => s[k] !== prev[k])) {
      saveJSON(STORAGE_KEYS.view, Object.fromEntries(keys.map((k) => [k, s[k]])));
    }
  });
  return store;
}

export function activeDocument(state: AppState): DocumentInfo {
  return state.documents.find((d) => d.id === state.activeDocumentId) ?? (state.documents[0] as DocumentInfo);
}
