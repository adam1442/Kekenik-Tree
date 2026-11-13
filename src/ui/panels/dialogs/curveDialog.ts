import { getApp } from '@/app/context';
import { cloneCurve, flatCurve, getCurvePreset, type Curve } from '@/core/curve';
import { getNodeDef } from '@/graph/registry';
import { mountCurveEditor, type CurveEditorInstance, type CurveEditorOptions } from '@/ui/components/curve';
import { FloatingWindow } from '@/ui/components/floatingWindow';

/**
 * Curve Editor floating dialog (`openCurveDialog`).
 * Uses the shared `FloatingWindow` primitive and mounts `mountCurveEditor`.
 * Integrates with `app.graph.setParam` (with gesture merging) and `app.undo`.
 */

export interface OpenCurveDialogOptions extends Omit<CurveEditorOptions, 'onChange' | 'onCommit'> {
  nodeId?: string;
  paramId?: string;
  onChange?: (curve: Curve) => void;
  onCommit?: (curve: Curve, previous: Curve) => void;
}

let openWin: FloatingWindow | null = null;
let openEditor: CurveEditorInstance | null = null;
let activePath = '';

const pathCurves = new Map<string, Curve>();
const pathListeners = new Set<(path: string, curve: Curve) => void>();

export function setStoredCurveForPath(path: string, curve: Curve): void {
  pathCurves.set(path, cloneCurve(curve));
  for (const fn of pathListeners) fn(path, cloneCurve(curve));
}

function resolveGraphTarget(path: string, explicitNodeId?: string, explicitParamId?: string): { nodeId: string; paramId: string } | null {
  try {
    const app = getApp();
    const selId = explicitNodeId ?? app.store.get().selection[0];
    if (!selId) return null;
    const node = app.graph.model.getNode(selId);
    if (!node) return null;

    if (explicitParamId && node.params[explicitParamId]) {
      return { nodeId: selId, paramId: explicitParamId };
    }

    const def = getNodeDef(node.type);
    const tail = (path.split(/[.:]/).pop() ?? '').trim().toLowerCase();
    if (!tail) return null;

    if (def) {
      const byId = def.params.find((p) => p.id.toLowerCase() === tail);
      if (byId) return { nodeId: selId, paramId: byId.id };
      const byLabel = def.params.find((p) => p.label.toLowerCase() === tail);
      if (byLabel) return { nodeId: selId, paramId: byLabel.id };
    }

    for (const key of Object.keys(node.params)) {
      if (key.toLowerCase() === tail) return { nodeId: selId, paramId: key };
    }
    return null;
  } catch {
    return null;
  }
}

function defaultCurveForPath(path: string): Curve {
  const existing = pathCurves.get(path);
  if (existing) return cloneCurve(existing);
  const lower = path.toLowerCase();
  if (lower.includes('weight')) return getCurvePreset('late-rise');
  if (lower.includes('droop')) return getCurvePreset('early-drop');
  if (lower.includes('drop time')) {
    const c = getCurvePreset('linear');
    c.points[0]!.y = 0.7;
    c.points[1]!.y = 1;
    c.level = 4;
    return c;
  }
  return flatCurve(1);
}

export function openCurveDialog(path: string, opts: OpenCurveDialogOptions = {}): void {
  const app = getApp();
  const target = resolveGraphTarget(path, opts.nodeId, opts.paramId);

  let initialCurve: Curve;
  let valueScale = opts.valueScale ?? 1;

  if (opts.curve) {
    initialCurve = cloneCurve(opts.curve);
  } else if (target) {
    const node = app.graph.model.getNode(target.nodeId);
    const paramState = node?.params[target.paramId];
    if (paramState?.curve) {
      initialCurve = cloneCurve(paramState.curve);
    } else {
      initialCurve = defaultCurveForPath(path);
    }
    if (typeof paramState?.value === 'number' && paramState.value !== 0) {
      valueScale = paramState.value;
    }
  } else {
    initialCurve = defaultCurveForPath(path);
  }

  activePath = path;

  if (openWin && openEditor) {
    openWin.setTitle(`Curve - ${path}`);
    openEditor.setCurve(initialCurve, true);
    if (opts.ghostCurve !== undefined) openEditor.setGhostCurve(opts.ghostCurve ?? null);
    if (opts.variance !== undefined) openEditor.setVariance(opts.variance);
    openWin.focus();
    return;
  }

  const layer = app.dialogLayer;
  const w = 620;
  const hgt = 360;
  const win = new FloatingWindow({
    title: `Curve - ${path}`,
    container: layer,
    rect: {
      x: Math.max(0, (layer.clientWidth - w) / 2),
      y: Math.max(0, layer.clientHeight - hgt - 60),
      w,
      h: hgt,
    },
    minSize: { w: 420, h: 240 },
    minimizable: false,
    maximizable: false,
    className: 'kt-curve-dialog',
    onClose: () => {
      openEditor?.dispose();
      openEditor = null;
      win.dispose();
      openWin = null;
    },
  });
  openWin = win;

  const editor = mountCurveEditor(win.body, {
    ...opts,
    curve: initialCurve,
    valueScale,
    onChange: (nextCurve) => {
      const curPath = activePath;
      setStoredCurveForPath(curPath, nextCurve);
      const tgt = resolveGraphTarget(curPath, opts.nodeId, opts.paramId);
      if (tgt) {
        const node = app.graph.model.getNode(tgt.nodeId);
        const curParam = node?.params[tgt.paramId];
        if (curParam) {
          app.graph.setParam(tgt.nodeId, tgt.paramId, { ...curParam, curve: cloneCurve(nextCurve) }, true);
        }
      }
      opts.onChange?.(cloneCurve(nextCurve));
    },
    onCommit: (nextCurve, prevCurve) => {
      const curPath = activePath;
      setStoredCurveForPath(curPath, nextCurve);
      const tgt = resolveGraphTarget(curPath, opts.nodeId, opts.paramId);
      if (tgt) {
        const node = app.graph.model.getNode(tgt.nodeId);
        const curParam = node?.params[tgt.paramId];
        if (curParam) {
          app.graph.setParam(tgt.nodeId, tgt.paramId, { ...curParam, curve: cloneCurve(nextCurve) }, true);
          app.graph.endGesture();
        }
      } else {
        const after = cloneCurve(nextCurve);
        const before = cloneCurve(prevCurve);
        app.undo.execute({
          label: `Edit Curve (${curPath})`,
          do: () => {
            setStoredCurveForPath(curPath, after);
            if (openEditor && activePath === curPath) openEditor.setCurve(after, true);
          },
          undo: () => {
            setStoredCurveForPath(curPath, before);
            if (openEditor && activePath === curPath) openEditor.setCurve(before, true);
          },
        });
      }
      opts.onCommit?.(cloneCurve(nextCurve), cloneCurve(prevCurve));
    },
  });
  openEditor = editor;
}
