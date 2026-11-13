import { getApp } from '@/app/context';
import type { CutoutMesh, LodLevel, TessellationMode } from '@/contracts/material';
import type { RGBA } from '@/contracts/params';
import { uid } from '@/core/id';
import {
  addAnchor,
  applyBrushStroke,
  applyTessellationSettings,
  checkUvWarnings,
  clearOrFillPaintLayer,
  createReferenceClusterCutout,
  defaultCutoutPreviewCamera,
  ensureCCW,
  generateCutoutOutline,
  generateProceduralBotanicalTexture,
  linearizeStraighten,
  lodCounts,
  mirrorCutoutOutline,
  pointInPolygon,
  pointToSegment,
  rebuildCutoutLods,
  removeAnchor,
  renderCutout3DPreview,
  resetAnchors,
  resetCutoutOutline,
  resetStraighten,
  snapUvPoint,
  syncPaintArrays,
  updateCutoutBounds,
  type CutoutPreviewCamera,
  type MaskInput,
  type Point2,
} from '@/materials/cutouts';
import { getMaterialLibrary } from '@/materials/library';
import { ensureCutoutAttachmentData } from '@/materials/cutouts/frame';
import { attachmentStatus, createAnchorInspector, createAttachmentPreview, drawAttachmentOverlay, type AnchorInspector, type AttachmentPreview } from './attachmentTools';
import { getTextureManager } from '@/textures/textureManager';
import { openColorPickerPopup } from '@/ui/components/colorPicker';
import { h } from '@/ui/components/dom';
import { FloatingWindow } from '@/ui/components/floatingWindow';
import { showMenu } from '@/ui/components/menu';
import { slider } from '@/ui/components/paramWidgets';
import { createCheckbox, createSelect } from '@/ui/components/select';
import { icon } from '@/ui/icons/icons';

export type EditMeshTarget =
  | string
  | {
      materialId?: string;
      cutoutId?: string;
      materialName?: string;
    };

type ActiveTool =
  | 'points.add'
  | 'points.select'
  | 'points.remove'
  | 'straighten.edit'
  | 'anchors.add'
  | 'anchors.remove'
  | 'paint.mask'
  | 'paint.color'
  | 'paint.section';

const SECTION_COLORS: readonly string[] = [
  '#e0533f',
  '#4a8ff0',
  '#6fcf4a',
  '#f0b33a',
  '#a47df0',
  '#36c5f0',
  '#ff6b8b',
  '#ffe66d',
];

let activeWindow: FloatingWindow | null = null;

/** Cached procedural botanical fallback texture (256x256). */
let fallbackTexCache: ReturnType<typeof generateProceduralBotanicalTexture> | null = null;
function getFallbackBotanicalTex(): ReturnType<typeof generateProceduralBotanicalTexture> {
  fallbackTexCache ??= generateProceduralBotanicalTexture(256, 256, 7);
  return fallbackTexCache;
}

export function openEditMeshDialog(target: EditMeshTarget): FloatingWindow {
  const app = getApp();
  if (activeWindow) {
    activeWindow.focus();
    return activeWindow;
  }

  const lib = getMaterialLibrary();
  const tm = getTextureManager();

  // Resolve initial material and cutout mesh
  let currentMaterialId = 'leaf';
  let displayMaterialName: string;
  let initialCutout: CutoutMesh | undefined;

  if (typeof target === 'string') {
    const matByName = lib.materials().find((m) => m.name === target || m.id === target);
    if (matByName) {
      currentMaterialId = matByName.id;
      displayMaterialName = matByName.name;
      initialCutout = lib.cutoutsForMaterial(matByName.id)[0] ?? lib.cutoutMeshes()[0];
    } else {
      const cutByName = lib.cutoutMeshes().find((c) => c.name === target || c.id === target);
      if (cutByName) {
        initialCutout = cutByName;
        currentMaterialId = cutByName.materialId;
        displayMaterialName = lib.material(currentMaterialId)?.name ?? target;
      } else {
        displayMaterialName = target;
        currentMaterialId = lib.materials()[0]?.id ?? 'leaf';
        initialCutout = lib.cutoutMeshes()[0];
      }
    }
  } else {
    if (target.cutoutId) {
      initialCutout = lib.cutoutMesh(target.cutoutId);
    }
    if (target.materialId) {
      currentMaterialId = target.materialId;
      initialCutout ??= lib.cutoutsForMaterial(target.materialId)[0];
    } else if (initialCutout) {
      currentMaterialId = initialCutout.materialId;
    }
    const mat = lib.material(currentMaterialId);
    displayMaterialName = target.materialName ?? mat?.name ?? initialCutout?.name ?? 'Oak_English_Cluster_1 Spring';
  }

  // Working clone of the cutout mesh (committed only when user clicks Done)
  const isExistingInLib = Boolean(initialCutout && lib.cutoutMeshes().some((c) => c.id === initialCutout!.id));
  let working: CutoutMesh = initialCutout
    ? structuredClone(initialCutout)
    : createReferenceClusterCutout(uid('cut'), `${displayMaterialName} Cutout`, currentMaterialId, 2);

  // If the working mesh was a default 4-point quad, initialize it with the 8-vertex reference cutout so V:8 F:7 matches
  if (!initialCutout) {
    working.materialId = currentMaterialId;
  }
  rebuildCutoutLods(working);

  // Dialog-local undo/redo stack
  const undoStack: CutoutMesh[] = [];
  const redoStack: CutoutMesh[] = [];
  const pushUndoState = (snap: CutoutMesh = working): void => {
    undoStack.push(structuredClone(snap));
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
  };
  const performUndo = (): void => {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(structuredClone(working));
    working = prev;
    selectedVertices.clear();
    syncControlsFromModel();
    requestDraw();
  };
  const performRedo = (): void => {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(structuredClone(working));
    working = next;
    selectedVertices.clear();
    syncControlsFromModel();
    requestDraw();
  };

  // Dialog state
  let activeTool: ActiveTool = 'points.add';
  let brushErase = false;
  let brushSizeType: 'Absolute' | 'Relative' = 'Absolute';
  let brushSize = 0.4;
  let brushFalloff = 0.25;
  let paintColor: RGBA = [0.45, 0.85, 0.3, 1];
  let activeSectionId = 1;
  let uvWarningsOn = false;
  let showAllMeshes = false;
  let showColor = true;
  let showOpacity = true;
  let showHeight = false;
  let sidePanelsCollapsed = false;

  // Selection & interaction state
  // Vertex index convention: 0 .. outline.length-1 are boundary vertices; outline.length .. total-1 are interior points
  const selectedVertices = new Set<number>();
  let hoveredVertex = -1;
  let hoveredAnchor = -1;
  let selectedAnchor = -1;
  let anchorInspector: AnchorInspector | null = null;
  let attachPreview: AttachmentPreview | null = null;
  let statusEl: HTMLElement | null = null;
  let marqueeRect: { u0: number; v0: number; u1: number; v1: number } | null = null;
  let pointerUv: Point2 | null = null;
  let baseOutlineBeforeAngle: Point2[] | null = null;

  // 2D Canvas pan/zoom state
  let panX = 0;
  let panY = 0;
  let zoom = 1;

  // Decoded material bitmaps (if material has real imported textures)
  let colorImageData: ImageData | null = null;
  let opacityImageData: ImageData | null = null;
  let heightImageData: ImageData | null = null;
  let compositeOffscreen: HTMLCanvasElement | null = null;
  let compositeDirty = true;

  const loadMaterialTextures = async (matId: string): Promise<void> => {
    colorImageData = null;
    opacityImageData = null;
    heightImageData = null;
    compositeDirty = true;
    const mat = lib.material(matId);
    if (!mat || typeof document === 'undefined') {
      requestDraw();
      return;
    }
    const decodeSlot = async (assetId: string | undefined): Promise<ImageData | null> => {
      if (!assetId) return null;
      const dec = await tm.decoded(assetId, 512);
      if (!dec) return null;
      const c = document.createElement('canvas');
      c.width = dec.width;
      c.height = dec.height;
      const ctx2d = c.getContext('2d');
      if (!ctx2d) return null;
      ctx2d.save();
      ctx2d.translate(0, dec.height);
      ctx2d.scale(1, -1); // unflip bitmap
      ctx2d.drawImage(dec.bitmap, 0, 0);
      ctx2d.restore();
      return ctx2d.getImageData(0, 0, dec.width, dec.height);
    };
    const [cImg, oImg, hImg] = await Promise.all([
      decodeSlot(mat.slots.color?.texture?.assetId),
      decodeSlot(mat.slots.opacity?.texture?.assetId),
      decodeSlot(mat.slots.height?.texture?.assetId),
    ]);
    colorImageData = cImg;
    opacityImageData = oImg;
    heightImageData = hImg;
    compositeDirty = true;
    requestDraw();
  };

  const getMaskInputForGenerate = (): MaskInput => {
    if (opacityImageData) {
      return { width: opacityImageData.width, height: opacityImageData.height, data: opacityImageData.data, channels: 4 };
    }
    if (colorImageData) {
      return { width: colorImageData.width, height: colorImageData.height, data: colorImageData.data, channels: 4 };
    }
    const fb = getFallbackBotanicalTex();
    return { width: 256, height: 256, data: fb.alphaMask, channels: 1 };
  };

  // Build FloatingWindow
  const layer = app.dialogLayer;
  const w = Math.min(980, Math.max(760, (layer.clientWidth || 1024) - 40));
  const hh = Math.min(640, Math.max(460, (layer.clientHeight || 720) - 40));
  const win = new FloatingWindow({
    title: `Edit Mesh - ${displayMaterialName}`,
    container: layer,
    rect: { x: Math.max(0, ((layer.clientWidth || 1024) - w) / 2), y: Math.max(0, ((layer.clientHeight || 720) - hh) / 2), w, h: hh },
    minSize: { w: 760, h: 460 },
    modal: true,
    minimizable: false,
    className: 'kt-editmesh',
    onClose: () => {
      win.dispose();
      activeWindow = null;
    },
  });
  activeWindow = win;

  // ---- Top Toolbar (A) ------------------------------------------------------------------------------------------
  const toolButtons = new Map<ActiveTool, HTMLButtonElement>();
  let brushCardEl: HTMLElement | null = null;
  let clearFillBtn: HTMLButtonElement | null = null;
  let sectionLabelSpan: HTMLElement | null = null;

  const isPaintTool = (t: ActiveTool): boolean =>
    t === 'paint.mask' || t === 'paint.color' || t === 'paint.section';

  const setActiveTool = (nextTool: ActiveTool): void => {
    activeTool = nextTool;
    for (const [k, btn] of toolButtons) {
      btn.classList.toggle('active', k === activeTool);
    }
    const painting = isPaintTool(activeTool);
    brushCardEl?.classList.toggle('dim', !painting);
    if (clearFillBtn) {
      clearFillBtn.classList.toggle('disabled', !painting);
    }
    requestDraw();
  };

  const makeModeBtn = (
    toolId: ActiveTool,
    ic: string,
    label: string,
    extraClass = '',
    onContextOrMenu?: (btn: HTMLButtonElement) => void,
  ): HTMLButtonElement => {
    const lblSpan = h('span', '', label);
    if (toolId === 'paint.section') sectionLabelSpan = lblSpan;
    const b = h(
      'button',
      `kt-em-tool${activeTool === toolId ? ' active' : ''}${extraClass ? ` ${extraClass}` : ''}`,
      icon(ic, 18),
      lblSpan,
    );
    b.type = 'button';
    b.addEventListener('click', (e) => {
      if (onContextOrMenu && extraClass.includes('has-menu')) {
        const rect = b.getBoundingClientRect();
        if (e.clientX > rect.right - 14 && e.clientY > rect.bottom - 14) {
          onContextOrMenu(b);
          return;
        }
      }
      setActiveTool(toolId);
    });
    if (onContextOrMenu) {
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        onContextOrMenu(b);
      });
    }
    toolButtons.set(toolId, b);
    return b;
  };

  const makeActionBtn = (
    ic: string,
    label: string,
    onClick: (btn: HTMLButtonElement, e: MouseEvent) => void,
    opts: { disabled?: boolean; hasMenu?: boolean; onMenu?: (btn: HTMLButtonElement) => void } = {},
  ): HTMLButtonElement => {
    const cls = `kt-em-tool${opts.disabled ? ' disabled' : ''}${opts.hasMenu ? ' has-menu' : ''}`;
    const b = h('button', cls, icon(ic, 18), h('span', '', label));
    b.type = 'button';
    b.addEventListener('click', (e) => {
      if (b.classList.contains('disabled')) return;
      if (opts.hasMenu && opts.onMenu) {
        const rect = b.getBoundingClientRect();
        if (e.clientX > rect.right - 14 && e.clientY > rect.bottom - 14) {
          opts.onMenu(b);
          return;
        }
      }
      onClick(b, e);
    });
    if (opts.onMenu) {
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!b.classList.contains('disabled')) opts.onMenu!(b);
      });
    }
    return b;
  };

  const runGenerateOutline = (overrideMode?: TessellationMode): void => {
    pushUndoState();
    if (overrideMode) working.settings.tessellation = overrideMode;
    const maskInput = getMaskInputForGenerate();
    working.outline = generateCutoutOutline(maskInput, working.settings);
    baseOutlineBeforeAngle = working.outline.map((p): Point2 => [p[0], p[1]]);
    // Set pivot to bottom-most vertex
    let bottomV = Infinity;
    let bottomU = 0.5;
    for (const [u, v] of working.outline) {
      if (v < bottomV) {
        bottomV = v;
        bottomU = u;
      }
    }
    working.pivot = [bottomU, bottomV];
    applyTessellationSettings(working);
    updateCutoutBounds(working, lib.material(currentMaterialId)?.atlas.scale ?? 1);
    selectedVertices.clear();
    syncControlsFromModel();
    requestDraw();
  };

  const removeBtn = makeModeBtn('points.remove', 'removeDiamond', 'Remove');
  removeBtn.addEventListener('click', () => {
    if (selectedVertices.size > 0) {
      deleteSelectedVertices();
    }
  });

  const generateBtn = makeActionBtn(
    'generate',
    'Generate',
    () => runGenerateOutline(),
    {
      hasMenu: true,
      onMenu: (btn) =>
        showMenu(
          [
            { label: 'Generate from Opacity / Alpha', run: () => runGenerateOutline() },
            { label: 'Generate Convex Hull', run: () => runGenerateOutline('Convex Hull') },
            {
              label: 'Reset to 8-Vertex Cluster',
              run: () => {
                pushUndoState();
                const ref = createReferenceClusterCutout(working.id, working.name, working.materialId, 2);
                working.outline = ref.outline;
                working.interiorPoints = ref.interiorPoints;
                working.pivot = ref.pivot;
                rebuildCutoutLods(working);
                requestDraw();
              },
            },
          ],
          btn,
        ),
    },
  );

  const sectionBtn = makeModeBtn('paint.section', 'brush', `Section [${activeSectionId}]`, 'has-menu', (btn) => {
    showMenu(
      Array.from({ length: 8 }, (_, idx) => {
        const sId = idx + 1;
        return {
          label: `Section [${sId}]`,
          checked: activeSectionId === sId,
          run: () => {
            activeSectionId = sId;
            if (sectionLabelSpan) sectionLabelSpan.textContent = `Section [${sId}]`;
            setActiveTool('paint.section');
          },
        };
      }),
      btn,
    );
  });

  const colorToolBtn = makeModeBtn('paint.color', 'toolPaint', 'Color', '', (btn) => {
    openColorPickerPopup(btn, {
      value: paintColor,
      onChange: (c) => {
        paintColor = c;
        setActiveTool('paint.color');
      },
    });
  });

  const activePaintChannel = (): 'mask' | 'color' | 'section' =>
    activeTool === 'paint.color' ? 'color' : activeTool === 'paint.section' ? 'section' : 'mask';

  clearFillBtn = makeActionBtn(
    'clearFill',
    'Clear/Fill',
    (btn) => {
      showMenu(
        [
          {
            label: 'Fill Active Layer',
            run: () => {
              pushUndoState();
              clearOrFillPaintLayer(working, activePaintChannel(), true, {
                color: paintColor,
                sectionId: activeSectionId,
              });
              requestDraw();
            },
          },
          {
            label: 'Clear Active Layer',
            run: () => {
              pushUndoState();
              clearOrFillPaintLayer(working, activePaintChannel(), false, {
                color: paintColor,
                sectionId: activeSectionId,
              });
              requestDraw();
            },
          },
        ],
        btn,
      );
    },
    {
      disabled: true,
      hasMenu: true,
    },
  );

  const shrinkBtn = h('button', 'kt-icon-btn kt-em-shrink', icon('shrink', 18));
  shrinkBtn.type = 'button';
  shrinkBtn.title = 'Toggle side panels / Fit canvas';

  const group = (title: string, ...tools: HTMLElement[]): HTMLElement =>
    h('div', 'kt-em-group', h('div', 'kt-em-group-title', title), h('div', 'kt-em-tools', ...tools));

  const toolbar = h(
    'div',
    'kt-em-toolbar',
    group(
      'Points',
      makeModeBtn('points.add', 'addCircle', 'Add'),
      makeModeBtn('points.select', 'selectBox', 'Select'),
      removeBtn,
      makeActionBtn('reset', 'Reset', () => {
        pushUndoState();
        resetCutoutOutline(working);
        selectedVertices.clear();
        requestDraw();
      }),
      makeActionBtn('mirror', 'Mirror', () => {
        pushUndoState();
        mirrorCutoutOutline(working);
        selectedVertices.clear();
        requestDraw();
      }),
      generateBtn,
    ),
    group(
      'Straighten',
      makeModeBtn('straighten.edit', 'editNodes', 'Edit'),
      makeActionBtn('linear', 'Linear', () => {
        pushUndoState();
        linearizeStraighten(working);
        requestDraw();
      }),
      makeActionBtn('reset', 'Reset', () => {
        pushUndoState();
        resetStraighten(working);
        requestDraw();
      }),
    ),
    group(
      'Anchors',
      makeModeBtn('anchors.add', 'addCircle', 'Add'),
      makeModeBtn('anchors.remove', 'removeDiamond', 'Remove'),
      makeActionBtn('reset', 'Reset', () => {
        pushUndoState();
        resetAnchors(working);
        requestDraw();
      }),
    ),
    group(
      'Paint',
      makeModeBtn('paint.mask', 'brush', 'Mask'),
      colorToolBtn,
      sectionBtn,
      clearFillBtn,
    ),
    shrinkBtn,
  );

  // ---- Left Column: Mesh options, Brush, Material ---------------------------------------------------------------
  const rowEl = (label: string, control: HTMLElement): HTMLElement =>
    h('div', 'kt-em-row', h('label', '', label), control);

  // Angle slider (0..1 where 0.5 = 0 deg, or 0..1 normalized)
  const angleSlider = slider({
    value: (working.settings.angle + 180) / 360,
    min: 0,
    max: 1,
    ticks: true,
    onChange: (v) => {
      if (!baseOutlineBeforeAngle) {
        baseOutlineBeforeAngle = working.outline.map((p): Point2 => [p[0], p[1]]);
      }
      const deg = (v - 0.5) * 360;
      working.settings.angle = deg;
      const rad = (deg * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      working.outline = ensureCCW(
        baseOutlineBeforeAngle.map(([u, pv]): Point2 => [
          Math.max(0, Math.min(1, 0.5 + (u - 0.5) * c - (pv - 0.5) * s)),
          Math.max(0, Math.min(1, 0.5 + (u - 0.5) * s + (pv - 0.5) * c)),
        ]),
      );
      rebuildCutoutLods(working);
      requestDraw();
    },
  });
  const angleResetBtn = h('button', 'kt-icon-btn', icon('history', 16));
  angleResetBtn.type = 'button';
  angleResetBtn.title = 'Reset angle';
  angleResetBtn.addEventListener('click', () => {
    pushUndoState();
    working.settings.angle = 0;
    angleSlider.setValue(0);
    if (baseOutlineBeforeAngle) {
      working.outline = baseOutlineBeforeAngle.map((p): Point2 => [p[0], p[1]]);
      baseOutlineBeforeAngle = null;
      rebuildCutoutLods(working);
    }
    requestDraw();
  });
  // Set visual thumb position to 0
  angleSlider.setValue(0);

  const tessSelect = createSelect({
    options: ['Triangular', 'Quad', 'Convex Hull', 'None'],
    value: working.settings.tessellation,
    onChange: (v) => {
      pushUndoState();
      working.settings.tessellation = v as TessellationMode;
      applyTessellationSettings(working);
      requestDraw();
    },
  });

  const tessAmountSlider = slider({
    value: working.settings.tessAmount,
    min: 0,
    max: 1,
    ticks: false,
    onChange: (v) => {
      working.settings.tessAmount = v;
      applyTessellationSettings(working);
      requestDraw();
    },
  });

  const refineEdgesSlider = slider({
    value: working.settings.refineEdges,
    min: 0,
    max: 1,
    ticks: false,
    onChange: (v) => {
      working.settings.refineEdges = v;
      const maskInput = getMaskInputForGenerate();
      working.outline = generateCutoutOutline(maskInput, working.settings);
      applyTessellationSettings(working);
      requestDraw();
    },
  });

  const snapThresholdSlider = slider({
    value: working.settings.snapThreshold,
    min: 0,
    max: 1,
    ticks: false,
    onChange: (v) => {
      working.settings.snapThreshold = v;
    },
  });

  const doubleSidedCheck = createCheckbox(working.doubleSided, (v) => {
    pushUndoState();
    working.doubleSided = v;
    working.settings.doubleSided = v;
  });

  // Brush controls
  const markBtn = h('button', 'active', 'Mark');
  markBtn.type = 'button';
  const eraseBtn = h('button', '', 'Erase');
  eraseBtn.type = 'button';
  markBtn.addEventListener('click', () => {
    brushErase = false;
    markBtn.classList.add('active');
    eraseBtn.classList.remove('active');
  });
  eraseBtn.addEventListener('click', () => {
    brushErase = true;
    eraseBtn.classList.add('active');
    markBtn.classList.remove('active');
  });

  const sizeTypeSelect = createSelect({
    options: ['Absolute', 'Relative'],
    value: brushSizeType,
    onChange: (v) => {
      brushSizeType = v as 'Absolute' | 'Relative';
    },
  });

  const brushSizeSlider = slider({
    value: brushSize,
    min: 0.02,
    max: 1,
    ticks: false,
    onChange: (v) => {
      brushSize = v;
      requestDraw();
    },
  });

  const brushFalloffSlider = slider({
    value: brushFalloff,
    min: 0,
    max: 1,
    ticks: false,
    onChange: (v) => {
      brushFalloff = v;
      requestDraw();
    },
  });

  const opacityMarginCheck = createCheckbox(working.settings.opacityMarginEnabled, (v) => {
    working.settings.opacityMarginEnabled = v;
  });
  const opacityMarginSlider = slider({
    value: working.settings.opacityMargin,
    min: 0,
    max: 1,
    ticks: false,
    onChange: (v) => {
      working.settings.opacityMargin = v;
    },
  });

  brushCardEl = h(
    'div',
    'kt-em-card dim',
    h('div', 'kt-em-card-title', 'Brush'),
    h('div', 'kt-em-seg', markBtn, eraseBtn),
    rowEl('Size type', sizeTypeSelect),
    rowEl('Size', brushSizeSlider.el),
    rowEl('Falloff', brushFalloffSlider.el),
    rowEl('Opacity margin', h('div', 'kt-em-margin-ctrl', opacityMarginCheck, opacityMarginSlider.el)),
  );

  // Material card
  const matDisplayLabel = displayMaterialName.replace(' Spring', ' spring');
  const matNames = [
    matDisplayLabel,
    ...lib
      .materials()
      .map((m) => m.name)
      .filter((n) => n !== matDisplayLabel),
  ];
  const matSelect = createSelect({
    options: matNames,
    value: matDisplayLabel,
    onChange: (selectedName) => {
      const found = lib.materials().find((m) => m.name === selectedName);
      if (found) {
        currentMaterialId = found.id;
        working.materialId = found.id;
        void loadMaterialTextures(found.id);
      }
    },
  });

  const uvWarnSelect = createSelect({
    options: ['Off', 'On'],
    value: 'Off',
    onChange: (v) => {
      uvWarningsOn = v === 'On';
      requestDraw();
    },
  });

  const showAllCheck = createCheckbox(showAllMeshes, (v) => {
    showAllMeshes = v;
    requestDraw();
  });
  const showColorCheck = createCheckbox(showColor, (v) => {
    showColor = v;
    compositeDirty = true;
    requestDraw();
  });
  const showOpacityCheck = createCheckbox(showOpacity, (v) => {
    showOpacity = v;
    compositeDirty = true;
    requestDraw();
  });
  const showHeightCheck = createCheckbox(showHeight, (v) => {
    showHeight = v;
    compositeDirty = true;
    requestDraw();
  });

  const leftCol = h(
    'div',
    'kt-em-left',
    h(
      'div',
      'kt-em-card',
      h('div', 'kt-em-card-title', 'Mesh options'),
      rowEl('Angle', h('div', 'kt-em-angle', angleSlider.el, angleResetBtn)),
      rowEl('Tessellation', tessSelect),
      rowEl('Tess. amount', tessAmountSlider.el),
      rowEl('Refine edges', refineEdgesSlider.el),
      rowEl('Snap threshold', snapThresholdSlider.el),
      rowEl('Double-sided', doubleSidedCheck),
    ),
    brushCardEl,
    h(
      'div',
      'kt-em-card',
      h('div', 'kt-em-card-title', 'Material'),
      matSelect,
      rowEl('UV warnings', uvWarnSelect),
      rowEl('Show all meshes', showAllCheck),
      rowEl('Show color', showColorCheck),
      rowEl('Show opacity', showOpacityCheck),
      rowEl('Show height', showHeightCheck),
    ),
  );

  function syncControlsFromModel(): void {
    tessAmountSlider.setValue(working.settings.tessAmount);
    refineEdgesSlider.setValue(working.settings.refineEdges);
    snapThresholdSlider.setValue(working.settings.snapThreshold);
    opacityMarginSlider.setValue(working.settings.opacityMargin);
  }

  // ---- Right Column (D): High / Med / Low LOD Previews ----------------------------------------------------------
  const lodCameras: Record<LodLevel, CutoutPreviewCamera> = {
    high: defaultCutoutPreviewCamera(),
    med: defaultCutoutPreviewCamera(),
    low: defaultCutoutPreviewCamera(),
  };
  const lodCanvases = new Map<LodLevel, HTMLCanvasElement>();
  const lodVfEls = new Map<LodLevel, HTMLElement>();

  const makeLodCard = (level: LodLevel, title: string): HTMLElement => {
    const prevBtn = h('button', 'kt-icon-btn kt-em-lod-arrow', icon('arrowLeft', 16));
    prevBtn.type = 'button';
    prevBtn.title = `Simplify ${title} LOD (fewer triangles)`;
    prevBtn.addEventListener('click', () => {
      pushUndoState();
      working.lods[level].step = Math.min(24, (working.lods[level].step ?? 0) + 1);
      rebuildCutoutLods(working);
      requestDraw();
    });

    const nextBtn = h('button', 'kt-icon-btn kt-em-lod-arrow', icon('arrowRight', 16));
    nextBtn.type = 'button';
    nextBtn.title = `Refine ${title} LOD (more triangles)`;
    nextBtn.addEventListener('click', () => {
      pushUndoState();
      working.lods[level].step = Math.max(-4, (working.lods[level].step ?? 0) - 1);
      rebuildCutoutLods(working);
      requestDraw();
    });

    const c = h('canvas', 'kt-em-lod-canvas');
    lodCanvases.set(level, c);

    // Interactive orbit on each mini 3D LOD viewport
    c.addEventListener('pointerdown', (e) => {
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* ignore in jsdom */
      }
      let lx = e.clientX;
      let ly = e.clientY;
      const cam = lodCameras[level];
      const onMove = (ev: PointerEvent): void => {
        cam.yaw += (ev.clientX - lx) * 0.015;
        cam.pitch = Math.max(-1.4, Math.min(1.4, cam.pitch + (ev.clientY - ly) * 0.015));
        lx = ev.clientX;
        ly = ev.clientY;
        requestDraw();
      };
      const onUp = (): void => {
        c.removeEventListener('pointermove', onMove);
        c.removeEventListener('pointerup', onUp);
      };
      c.addEventListener('pointermove', onMove);
      c.addEventListener('pointerup', onUp);
    });

    const thumbWrap = h('div', 'kt-em-lod-thumb checker', c);
    const vf = h('div', 'kt-em-lod-vf', 'V:8  F:7');
    lodVfEls.set(level, vf);

    return h(
      'div',
      'kt-em-lod',
      h('div', 'kt-em-lod-title', title),
      h('div', 'kt-em-lod-body', h('div', 'kt-em-lod-arrows', prevBtn, nextBtn), thumbWrap),
      vf,
    );
  };

  const rightCol = h(
    'div',
    'kt-em-right',
    makeLodCard('high', 'High'),
    makeLodCard('med', 'Med'),
    makeLodCard('low', 'Low'),
  );

  // ---- Center 2D Canvas (B) & Footer (C) ------------------------------------------------------------------------
  const canvas = h('canvas', 'kt-em-canvas');
  const centerWrap = h('div', 'kt-em-center checker', canvas);

  const footerVf = h('div', 'kt-em-vf', 'V:8  F:7');
  statusEl = h('div', 'kt-em-attach-status', '');
  anchorInspector = createAnchorInspector({
    getCutout: () => working,
    getSelected: () => selectedAnchor,
    beforeEdit: () => pushUndoState(),
    changed: () => {
      rebuildCutoutLods(working);
      requestDraw();
    },
  });
  attachPreview = createAttachmentPreview();
  const previewToggle = h('input') as HTMLInputElement;
  previewToggle.type = 'checkbox';
  previewToggle.addEventListener('change', () => {
    attachPreview?.setVisible(previewToggle.checked);
    requestDraw();
  });
  const previewLabel = h('label', 'kt-em-attach-toggle', previewToggle, 'Attachment preview');
  centerWrap.append(attachPreview.el);
  const cancelBtn = h('button', 'kt-em-btn', 'Cancel');
  cancelBtn.type = 'button';
  const doneBtn = h('button', 'kt-em-btn primary', 'Done');
  doneBtn.type = 'button';

  cancelBtn.addEventListener('click', () => win.close());
  doneBtn.addEventListener('click', () => {
    // axis / anchors / mesh edits are committed together below (one undo step): order anchors, sync the pivot
    ensureCutoutAttachmentData(working);
    syncPaintArrays(working);
    rebuildCutoutLods(working);
    updateCutoutBounds(working, lib.material(currentMaterialId)?.atlas.scale ?? 1);
    lib.edit('Edit Mesh', 'meshes', () => {
      const list = lib.cutoutMeshes();
      const idx = list.findIndex((c) => c.id === working.id);
      if (idx >= 0 && isExistingInLib) {
        list[idx] = structuredClone(working);
      } else {
        // Also check if there is already a cutout for this material to update or append
        const existingForMatIdx = list.findIndex((c) => c.materialId === working.materialId);
        if (existingForMatIdx >= 0 && !isExistingInLib) {
          list[existingForMatIdx] = structuredClone({ ...working, id: list[existingForMatIdx]!.id });
        } else {
          list.push(structuredClone(working));
        }
      }
    });
    app.events.emit('tree:regenerate', undefined);
    win.close();
  });

  const footer = h('div', 'kt-em-footer', footerVf, statusEl, h('div', 'kt-em-spacer'), previewLabel, cancelBtn, doneBtn);
  win.body.append(toolbar, h('div', 'kt-em-main', leftCol, centerWrap, rightCol), anchorInspector.el, footer);

  shrinkBtn.addEventListener('click', () => {
    sidePanelsCollapsed = !sidePanelsCollapsed;
    leftCol.hidden = sidePanelsCollapsed;
    rightCol.hidden = sidePanelsCollapsed;
    requestDraw();
  });

  // ---- Coordinate conversions between 2D Canvas and UV space [0..1, 0..1] --------------------------------------
  // UV square is centered inside the canvas with aspect 1:1 so side checkerboard margins are visible.
  const getUvSquareRect = (W: number, H: number): { x0: number; y0: number; size: number } => {
    const baseSize = Math.max(64, Math.min(W * 0.92, H) * zoom);
    const x0 = (W - baseSize) * 0.5 + panX;
    const y0 = (H - baseSize) * 0.5 + panY;
    return { x0, y0, size: baseSize };
  };

  const uvToCanvas = (uv: Point2, W: number, H: number): [number, number] => {
    const { x0, y0, size } = getUvSquareRect(W, H);
    return [x0 + uv[0] * size, y0 + (1 - uv[1]) * size];
  };

  const canvasToUv = (cx: number, cy: number, W: number, H: number): Point2 => {
    const { x0, y0, size } = getUvSquareRect(W, H);
    return [(cx - x0) / size, 1 - (cy - y0) / size];
  };

  const allVerticesUv = (): Point2[] => [...working.outline, ...working.interiorPoints];

  const deleteSelectedVertices = (): void => {
    if (selectedVertices.size === 0) return;
    pushUndoState();
    const sortedDesc = [...selectedVertices].sort((a, b) => b - a);
    const outLen = working.outline.length;
    for (const idx of sortedDesc) {
      if (idx >= outLen) {
        working.interiorPoints.splice(idx - outLen, 1);
      } else if (working.outline.length > 3) {
        working.outline.splice(idx, 1);
      }
    }
    selectedVertices.clear();
    syncPaintArrays(working);
    rebuildCutoutLods(working);
    requestDraw();
  };

  // ---- Texture Composite Builder --------------------------------------------------------------------------------
  const ensureCompositeCanvas = (): HTMLCanvasElement | null => {
    if (typeof document === 'undefined') return null;
    if (!compositeDirty && compositeOffscreen) return compositeOffscreen;
    compositeDirty = false;

    const fb = getFallbackBotanicalTex();
    const srcColor = colorImageData?.data ?? fb.colorRgba;
    const srcOpacity = opacityImageData?.data ?? fb.opacityRgba;
    const srcHeight = heightImageData?.data ?? fb.heightRgba;
    const tw = colorImageData?.width ?? opacityImageData?.width ?? heightImageData?.width ?? 256;
    const th = colorImageData?.height ?? opacityImageData?.height ?? heightImageData?.height ?? 256;

    const off = compositeOffscreen ?? document.createElement('canvas');
    off.width = tw;
    off.height = th;
    compositeOffscreen = off;
    const ctx2d = off.getContext('2d');
    if (!ctx2d) return off;

    const imgData = ctx2d.createImageData(tw, th);
    const dst = imgData.data;
    const len = tw * th;

    for (let i = 0; i < len; i++) {
      const p = i * 4;
      const alphaMask =
        opacityImageData || !colorImageData
          ? (srcOpacity[p] ?? 255)
          : (srcColor[p + 3] ?? 255);
      const aNorm = alphaMask / 255;

      let r = 0, g = 0, b = 0;
      if (showHeight) {
        const hv = srcHeight[p] ?? 128;
        r = hv;
        g = hv;
        b = hv;
      } else if (showColor && showOpacity) {
        r = Math.round((srcColor[p] ?? 0) * aNorm);
        g = Math.round((srcColor[p + 1] ?? 0) * aNorm);
        b = Math.round((srcColor[p + 2] ?? 0) * aNorm);
      } else if (showColor) {
        r = srcColor[p] ?? 0;
        g = srcColor[p + 1] ?? 0;
        b = srcColor[p + 2] ?? 0;
      } else if (showOpacity) {
        r = alphaMask;
        g = alphaMask;
        b = alphaMask;
      }
      dst[p] = r;
      dst[p + 1] = g;
      dst[p + 2] = b;
      dst[p + 3] = 255;
    }
    ctx2d.putImageData(imgData, 0, 0);
    return off;
  };

  // ---- Render Loop (on-demand via rAF) --------------------------------------------------------------------------
  let rafId = 0;
  const drawAll = (): void => {
    rafId = 0;
    if (!canvas.isConnected) return;

    // Update V/F readouts & 3D LOD previews
    const highCounts = lodCounts(working.lods.high);
    footerVf.textContent = `V:${highCounts.vertices}  F:${highCounts.faces}`;

    for (const lv of ['high', 'med', 'low'] as LodLevel[]) {
      const vfEl = lodVfEls.get(lv);
      const counts = lodCounts(working.lods[lv]);
      if (vfEl) vfEl.textContent = `V:${counts.vertices}  F:${counts.faces}`;
      const lodCanvas = lodCanvases.get(lv);
      if (lodCanvas && lodCanvas.parentElement) {
        const pw = Math.max(60, lodCanvas.parentElement.clientWidth || 100);
        const ph = Math.max(50, lodCanvas.parentElement.clientHeight || 84);
        lodCanvas.style.width = `${pw}px`;
        lodCanvas.style.height = `${ph}px`;
        renderCutout3DPreview(lodCanvas, working, pw, ph, {
          lod: lv,
          camera: lodCameras[lv],
          showAlignment: true,
          showAnchors: true,
        });
      }
    }

    // Draw central 2D canvas
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, rect.width || 520);
    const H = Math.max(1, rect.height || 520);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    const g = canvas.getContext('2d');
    if (!g) return;

    g.save();
    g.scale(dpr, dpr);
    // Clear so CSS checkerboard shows outside the [0,1]x[0,1] UV square
    g.clearRect(0, 0, W, H);

    const sq = getUvSquareRect(W, H);
    // Draw black UV square + texture composite
    g.fillStyle = '#000000';
    g.fillRect(sq.x0, sq.y0, sq.size, sq.size);

    if (showColor || showOpacity || showHeight) {
      const comp = ensureCompositeCanvas();
      if (comp) {
        g.drawImage(comp, sq.x0, sq.y0, sq.size, sq.size);
      }
    }

    // Optional: Show all meshes of the same material in faded cyan
    if (showAllMeshes) {
      const others = lib.cutoutsForMaterial(currentMaterialId).filter((c) => c.id !== working.id);
      g.strokeStyle = 'rgba(0, 255, 255, 0.35)';
      g.lineWidth = 1.25;
      for (const other of others) {
        const oHigh = other.lods?.high;
        if (!oHigh) continue;
        for (let t = 0; t + 2 < oHigh.indices.length; t += 3) {
          const a = oHigh.indices[t] as number;
          const b = oHigh.indices[t + 1] as number;
          const c = oHigh.indices[t + 2] as number;
          const [ax, ay] = uvToCanvas([oHigh.vertices[a * 2] as number, oHigh.vertices[a * 2 + 1] as number], W, H);
          const [bx, by] = uvToCanvas([oHigh.vertices[b * 2] as number, oHigh.vertices[b * 2 + 1] as number], W, H);
          const [cx, cy] = uvToCanvas([oHigh.vertices[c * 2] as number, oHigh.vertices[c * 2 + 1] as number], W, H);
          g.beginPath();
          g.moveTo(ax, ay);
          g.lineTo(bx, by);
          g.lineTo(cx, cy);
          g.closePath();
          g.stroke();
        }
      }
    }

    // Draw Cyan triangulation and polygon outline
    const high = working.lods.high;
    g.strokeStyle = '#00ffff';
    g.lineWidth = 1.8;
    for (let t = 0; t + 2 < high.indices.length; t += 3) {
      const a = high.indices[t] as number;
      const b = high.indices[t + 1] as number;
      const c = high.indices[t + 2] as number;
      const [ax, ay] = uvToCanvas([high.vertices[a * 2] as number, high.vertices[a * 2 + 1] as number], W, H);
      const [bx, by] = uvToCanvas([high.vertices[b * 2] as number, high.vertices[b * 2 + 1] as number], W, H);
      const [cx, cy] = uvToCanvas([high.vertices[c * 2] as number, high.vertices[c * 2 + 1] as number], W, H);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.lineTo(cx, cy);
      g.closePath();
      g.stroke();
    }

    // Also stroke the outer boundary ring in cyan if Tessellation === 'None'
    if (working.outline.length >= 2) {
      g.beginPath();
      working.outline.forEach((pt, idx) => {
        const [x, y] = uvToCanvas(pt, W, H);
        if (idx === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
      g.stroke();
    }

    // UV warnings overlay when enabled
    const warnReport = uvWarningsOn
      ? checkUvWarnings(working, lib.cutoutsForMaterial(currentMaterialId))
      : null;
    if (warnReport && warnReport.selfIntersectingEdges.length > 0) {
      g.strokeStyle = '#ffcc00';
      g.lineWidth = 3;
      const n = working.outline.length;
      for (const [e1] of warnReport.selfIntersectingEdges) {
        const [x1, y1] = uvToCanvas(working.outline[e1] as Point2, W, H);
        const [x2, y2] = uvToCanvas(working.outline[(e1 + 1) % n] as Point2, W, H);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
      }
    }

    // Draw Orange Straighten Axis (extending from top to bottom of the UV square)
    if (working.straightenAxis.length >= 2) {
      g.strokeStyle = '#f08a1c';
      g.lineWidth = 2.2;
      g.beginPath();
      working.straightenAxis.forEach((pt, idx) => {
        const [x, y] = uvToCanvas(pt, W, H);
        if (idx === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();

      if (activeTool === 'straighten.edit') {
        for (const pt of working.straightenAxis) {
          const [x, y] = uvToCanvas(pt, W, H);
          g.fillStyle = '#f08a1c';
          g.strokeStyle = '#ffffff';
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(x, y, 5, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }
      }
    }

    // Draw Green/White Anchor points (with connecting white stem and green index label)
    working.anchors.forEach((anc, idx) => {
      const [ax, ay] = uvToCanvas(anc.uv, W, H);
      const [hx, hy] = uvToCanvas(anc.handleUv, W, H);

      // Connecting line between green anchor and white handle
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(hx, hy);
      g.stroke();

      // White handle dot
      g.fillStyle = '#dcdcdc';
      g.strokeStyle = '#222222';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(hx, hy, 4.2, 0, Math.PI * 2);
      g.fill();
      g.stroke();

      // Green anchor circle
      g.fillStyle = '#12d600';
      g.strokeStyle = hoveredAnchor === idx ? '#ffffff' : '#0a3500';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(ax, ay, 5.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();

      // Index label below the green anchor
      g.fillStyle = '#12d600';
      g.font = '600 11px Inter, sans-serif';
      g.textAlign = 'center';
    });
    drawAttachmentOverlay(g, W, H, working, uvToCanvas, selectedAnchor);

    // Draw Red Vertices (with white pivot ring on the base pivot vertex and selection / paint rings)
    const verts = allVerticesUv();
    let pivotVertIdx = 0;
    let bestPivotDist = Infinity;
    verts.forEach((pt, idx) => {
      const d = Math.hypot(pt[0] - working.pivot[0], pt[1] - working.pivot[1]);
      if (d < bestPivotDist) {
        bestPivotDist = d;
        pivotVertIdx = idx;
      }
    });

    verts.forEach((pt, idx) => {
      const [x, y] = uvToCanvas(pt, W, H);

      // Paint visualization halo when in a Paint tool
      if (isPaintTool(activeTool)) {
        syncPaintArrays(working);
        if (activeTool === 'paint.mask') {
          const mVal = working.paint.vertexMask[idx] ?? 1;
          g.fillStyle = `rgba(240, 138, 28, ${mVal * 0.55})`;
        } else if (activeTool === 'paint.color') {
          const r = Math.round((working.paint.vertexColor[idx * 4] ?? 1) * 255);
          const gr = Math.round((working.paint.vertexColor[idx * 4 + 1] ?? 1) * 255);
          const bl = Math.round((working.paint.vertexColor[idx * 4 + 2] ?? 1) * 255);
          g.fillStyle = `rgba(${r}, ${gr}, ${bl}, 0.65)`;
        } else {
          const sec = working.paint.vertexSection[idx] ?? 1;
          g.fillStyle = `${SECTION_COLORS[(sec - 1) % SECTION_COLORS.length]}aa`;
        }
        g.beginPath();
        g.arc(x, y, 11, 0, Math.PI * 2);
        g.fill();
      }

      // Pivot vertex outer white ring
      if (idx === pivotVertIdx) {
        g.strokeStyle = '#e6e6e6';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, 7.5, 0, Math.PI * 2);
        g.stroke();
      }

      const isWarn =
        warnReport &&
        (warnReport.outOfBoundsVertices.includes(idx) || warnReport.overlappingVertices.includes(idx));
      const isSelected = selectedVertices.has(idx);

      g.fillStyle = isWarn ? '#ffcc00' : '#c92a1d';
      g.beginPath();
      g.arc(x, y, 5.2, 0, Math.PI * 2);
      g.fill();

      if (isSelected || hoveredVertex === idx) {
        g.strokeStyle = isSelected ? '#ecd531' : '#ffffff';
        g.lineWidth = 1.8;
        g.beginPath();
        g.arc(x, y, 7, 0, Math.PI * 2);
        g.stroke();
      }
    });

    // Marquee selection box
    if (marqueeRect) {
      const [x0, y0] = uvToCanvas([marqueeRect.u0, marqueeRect.v0], W, H);
      const [x1, y1] = uvToCanvas([marqueeRect.u1, marqueeRect.v1], W, H);
      const rx = Math.min(x0, x1);
      const ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0);
      const rh = Math.abs(y1 - y0);
      g.fillStyle = 'rgba(74, 127, 200, 0.22)';
      g.strokeStyle = '#6c9be0';
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.fillRect(rx, ry, rw, rh);
      g.strokeRect(rx, ry, rw, rh);
      g.setLineDash([]);
    }

    // Brush cursor when in Paint mode
    if (isPaintTool(activeTool) && pointerUv) {
      const [bx, by] = uvToCanvas(pointerUv, W, H);
      const rPx = brushSize * 0.25 * sq.size;
      const innerPx = rPx * Math.max(0, 1 - brushFalloff);
      g.strokeStyle = brushErase ? '#ff6b6b' : '#ffffff';
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(bx, by, rPx, 0, Math.PI * 2);
      g.stroke();
      if (brushFalloff > 0.02) {
        g.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        g.setLineDash([3, 3]);
        g.beginPath();
        g.arc(bx, by, innerPx, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
      }
    }

    g.restore();
    refreshAttachmentUi();
  };

  function refreshAttachmentUi(): void {
    if (statusEl) {
      const st = attachmentStatus(working);
      statusEl.textContent = st.warnings.length ? `${st.text}   \u26A0 ${st.warnings.join(' ')}` : st.text;
      statusEl.classList.toggle('warn', st.warnings.length > 0);
    }
    attachPreview?.draw(working);
  }

  function requestDraw(): void {
    if (!rafId) rafId = requestAnimationFrame(drawAll);
  }

  // ---- Canvas Pointer & Keyboard Gestures -----------------------------------------------------------------------
  const hitTestVertex = (cx: number, cy: number, W: number, H: number): number => {
    const verts = allVerticesUv();
    let best = -1;
    let bestD = 11;
    for (let i = 0; i < verts.length; i++) {
      const [vx, vy] = uvToCanvas(verts[i] as Point2, W, H);
      const d = Math.hypot(cx - vx, cy - vy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const hitTestAnchor = (cx: number, cy: number, W: number, H: number): { index: number; handle: boolean } | null => {
    for (let i = 0; i < working.anchors.length; i++) {
      const anc = working.anchors[i]!;
      const [hx, hy] = uvToCanvas(anc.handleUv, W, H);
      if (Math.hypot(cx - hx, cy - hy) < 9) return { index: i, handle: true };
      const [ax, ay] = uvToCanvas(anc.uv, W, H);
      if (Math.hypot(cx - ax, cy - ay) < 10) return { index: i, handle: false };
    }
    return null;
  };

  let spaceHeld = false;

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, rect.width || 520);
    const H = Math.max(1, rect.height || 520);
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    pointerUv = canvasToUv(cx, cy, W, H);
    const hv = hitTestVertex(cx, cy, W, H);
    const ha = hitTestAnchor(cx, cy, W, H)?.index ?? -1;
    if (hv !== hoveredVertex || ha !== hoveredAnchor || isPaintTool(activeTool)) {
      hoveredVertex = hv;
      hoveredAnchor = ha;
      requestDraw();
    }
  });

  canvas.addEventListener('pointerleave', () => {
    pointerUv = null;
    if (hoveredVertex !== -1 || hoveredAnchor !== -1 || isPaintTool(activeTool)) {
      hoveredVertex = -1;
      hoveredAnchor = -1;
      requestDraw();
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, rect.width || 520);
    const H = Math.max(1, rect.height || 520);
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const uv = canvasToUv(cx, cy, W, H);

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore in jsdom */
    }

    // Pan gesture (MMB, RMB, or Space+LMB)
    if (e.button === 1 || e.button === 2 || spaceHeld) {
      let lx = e.clientX;
      let ly = e.clientY;
      const onMove = (ev: PointerEvent): void => {
        panX += ev.clientX - lx;
        panY += ev.clientY - ly;
        lx = ev.clientX;
        ly = ev.clientY;
        requestDraw();
      };
      const onUp = (): void => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      return;
    }

    if (e.button !== 0) return;

    // 1. Paint tools
    if (isPaintTool(activeTool)) {
      pushUndoState();
      const ch = activePaintChannel();
      const paintAt = (pt: Point2): void => {
        applyBrushStroke(working, pt, brushSize * 0.25, brushFalloff, ch, brushErase, {
          color: paintColor,
          sectionId: activeSectionId,
        });
        requestDraw();
      };
      paintAt(uv);
      const onMove = (ev: PointerEvent): void => {
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        pointerUv = canvasToUv(mx, my, W, H);
        paintAt(pointerUv);
      };
      const onUp = (): void => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      return;
    }

    // 2. Anchors tools
    if (activeTool === 'anchors.remove') {
      const hitA = hitTestAnchor(cx, cy, W, H);
      if (hitA) {
        pushUndoState();
        removeAnchor(working, working.anchors[hitA.index]?.id);
        requestDraw();
      }
      return;
    }

    const hitA = hitTestAnchor(cx, cy, W, H);
    if (hitA && (activeTool === 'anchors.add' || activeTool === 'points.select')) {
      selectedAnchor = hitA.index;
      anchorInspector?.sync();
      pushUndoState();
      const anc = working.anchors[hitA.index]!;
      const onMove = (ev: PointerEvent): void => {
        const mUv = canvasToUv(ev.clientX - rect.left, ev.clientY - rect.top, W, H);
        if (hitA.handle) {
          anc.handleUv = [Math.max(0, Math.min(1, mUv[0])), Math.max(0, Math.min(1, mUv[1]))];
        } else {
          const du = mUv[0] - anc.uv[0];
          const dv = mUv[1] - anc.uv[1];
          anc.uv = [Math.max(0, Math.min(1, mUv[0])), Math.max(0, Math.min(1, mUv[1]))];
          anc.handleUv = [
            Math.max(0, Math.min(1, anc.handleUv[0] + du)),
            Math.max(0, Math.min(1, anc.handleUv[1] + dv)),
          ];
        }
        requestDraw();
      };
      const onUp = (): void => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      return;
    }

    if (activeTool === 'anchors.add') {
      pushUndoState();
      addAnchor(working, uv);
      requestDraw();
      return;
    }

    // 3. Straighten > Edit tool
    if (activeTool === 'straighten.edit') {
      pushUndoState();
      // Check if clicking near an existing straighten control point
      let hitCtrl = -1;
      for (let i = 0; i < working.straightenAxis.length; i++) {
        const [sx, sy] = uvToCanvas(working.straightenAxis[i] as Point2, W, H);
        if (Math.hypot(cx - sx, cy - sy) < 11) {
          hitCtrl = i;
          break;
        }
      }
      if (hitCtrl < 0) {
        // Insert a new control point sorted by v
        working.straightenAxis.push([Math.max(0, Math.min(1, uv[0])), Math.max(0, Math.min(1, uv[1]))]);
        working.straightenAxis.sort((a, b) => a[1] - b[1]);
        hitCtrl = working.straightenAxis.findIndex((p) => Math.hypot(p[0] - uv[0], p[1] - uv[1]) < 1e-4);
      }
      const onMove = (ev: PointerEvent): void => {
        if (hitCtrl < 0 || hitCtrl >= working.straightenAxis.length) return;
        const mUv = canvasToUv(ev.clientX - rect.left, ev.clientY - rect.top, W, H);
        working.straightenAxis[hitCtrl] = [
          Math.max(0, Math.min(1, mUv[0])),
          Math.max(0, Math.min(1, mUv[1])),
        ];
        requestDraw();
      };
      const onUp = (): void => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      return;
    }

    // 4. Points > Remove tool
    const hitV = hitTestVertex(cx, cy, W, H);
    if (activeTool === 'points.remove') {
      if (hitV >= 0) {
        selectedVertices.clear();
        selectedVertices.add(hitV);
        deleteSelectedVertices();
      }
      return;
    }

    // 5. Points > Add tool
    if (activeTool === 'points.add') {
      pushUndoState();
      let dragIdx = hitV;
      if (dragIdx < 0) {
        // Check if clicking near an outline edge to split it
        const n = working.outline.length;
        const { size } = getUvSquareRect(W, H);
        let bestEdge = -1;
        let bestDistPx = 12;
        for (let i = 0; i < n; i++) {
          const seg = pointToSegment(uv, working.outline[i] as Point2, working.outline[(i + 1) % n] as Point2);
          const distPx = seg.dist * size;
          if (distPx < bestDistPx) {
            bestDistPx = distPx;
            bestEdge = i;
          }
        }
        if (bestEdge >= 0 || !pointInPolygon(uv, working.outline)) {
          // Insert into closest boundary edge
          let insertAfter = bestEdge;
          if (insertAfter < 0) {
            let minD = Infinity;
            for (let i = 0; i < n; i++) {
              const seg = pointToSegment(uv, working.outline[i] as Point2, working.outline[(i + 1) % n] as Point2);
              if (seg.dist < minD) {
                minD = seg.dist;
                insertAfter = i;
              }
            }
          }
          working.outline.splice(insertAfter + 1, 0, [uv[0], uv[1]]);
          dragIdx = insertAfter + 1;
        } else {
          // Click is inside the polygon -> add an interior Steiner point
          working.interiorPoints.push([uv[0], uv[1]]);
          dragIdx = working.outline.length + working.interiorPoints.length - 1;
        }
        syncPaintArrays(working);
        rebuildCutoutLods(working);
      }
      selectedVertices.clear();
      selectedVertices.add(dragIdx);
      requestDraw();

      const onMove = (ev: PointerEvent): void => {
        const mUv = canvasToUv(ev.clientX - rect.left, ev.clientY - rect.top, W, H);
        const others = allVerticesUv().filter((_, idx) => idx !== dragIdx);
        const snapped = snapUvPoint(mUv, working.settings.snapThreshold, others, working.straightenAxis);
        if (dragIdx < working.outline.length) {
          working.outline[dragIdx] = snapped;
        } else {
          working.interiorPoints[dragIdx - working.outline.length] = snapped;
        }
        rebuildCutoutLods(working);
        requestDraw();
      };
      const onUp = (): void => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      return;
    }

    // 6. Points > Select tool (click/drag vertex or marquee box)
    if (hitV >= 0) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (selectedVertices.has(hitV)) selectedVertices.delete(hitV);
        else selectedVertices.add(hitV);
      } else if (!selectedVertices.has(hitV)) {
        selectedVertices.clear();
        selectedVertices.add(hitV);
      }
      requestDraw();

      pushUndoState();
      const startUv: Point2 = [uv[0], uv[1]];
      const startOutline = working.outline.map((p): Point2 => [p[0], p[1]]);
      const startInterior = working.interiorPoints.map((p): Point2 => [p[0], p[1]]);
      const outLen = startOutline.length;

      const onMove = (ev: PointerEvent): void => {
        const mUv = canvasToUv(ev.clientX - rect.left, ev.clientY - rect.top, W, H);
        const du = mUv[0] - startUv[0];
        const dv = mUv[1] - startUv[1];
        const unselected = allVerticesUv().filter((_, idx) => !selectedVertices.has(idx));
        for (const idx of selectedVertices) {
          if (idx < outLen) {
            const orig = startOutline[idx] as Point2;
            working.outline[idx] = snapUvPoint(
              [orig[0] + du, orig[1] + dv],
              working.settings.snapThreshold,
              unselected,
              working.straightenAxis,
            );
          } else {
            const orig = startInterior[idx - outLen] as Point2;
            working.interiorPoints[idx - outLen] = snapUvPoint(
              [orig[0] + du, orig[1] + dv],
              working.settings.snapThreshold,
              unselected,
              working.straightenAxis,
            );
          }
        }
        rebuildCutoutLods(working);
        requestDraw();
      };
      const onUp = (): void => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
    } else {
      // Marquee selection
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) selectedVertices.clear();
      marqueeRect = { u0: uv[0], v0: uv[1], u1: uv[0], v1: uv[1] };
      requestDraw();
      const onMove = (ev: PointerEvent): void => {
        const mUv = canvasToUv(ev.clientX - rect.left, ev.clientY - rect.top, W, H);
        if (marqueeRect) {
          marqueeRect.u1 = mUv[0];
          marqueeRect.v1 = mUv[1];
        }
        requestDraw();
      };
      const onUp = (): void => {
        if (marqueeRect) {
          const minU = Math.min(marqueeRect.u0, marqueeRect.u1);
          const maxU = Math.max(marqueeRect.u0, marqueeRect.u1);
          const minV = Math.min(marqueeRect.v0, marqueeRect.v1);
          const maxV = Math.max(marqueeRect.v0, marqueeRect.v1);
          const verts = allVerticesUv();
          verts.forEach(([u, v], idx) => {
            if (u >= minU && u <= maxU && v >= minV && v <= maxV) {
              selectedVertices.add(idx);
            }
          });
          marqueeRect = null;
        }
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        requestDraw();
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom = Math.max(0.4, Math.min(5, zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
      requestDraw();
    },
    { passive: false },
  );

  // Dialog-scoped keyboard shortcuts (Undo/Redo, Delete, Fit view, tool hotkeys)
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!win.body.isConnected) return;
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      spaceHeld = true;
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) performRedo();
      else performUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      e.stopPropagation();
      performRedo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedVertices.size > 0) {
        e.preventDefault();
        deleteSelectedVertices();
      }
      return;
    }
    if (e.key === 'f' || e.key === 'F' || e.key === 'Home') {
      panX = 0;
      panY = 0;
      zoom = 1;
      requestDraw();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') spaceHeld = false;
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  const ro = new ResizeObserver(requestDraw);
  ro.observe(canvas);
  for (const c of lodCanvases.values()) {
    if (c.parentElement) ro.observe(c.parentElement);
  }

  void loadMaterialTextures(currentMaterialId);
  queueMicrotask(drawAll);

  const origDispose = win.dispose.bind(win);
  win.dispose = () => {
    if (rafId) cancelAnimationFrame(rafId);
    ro.disconnect();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    origDispose();
  };

  return win;
}
