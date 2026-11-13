import { defaultParamState, type NodeParams, type ParamDef, type ParamState } from '@/contracts/params';
import { formatParamNumber } from './valueOps';

/**
 * In-memory + JSON clipboard for individual parameter states and whole sections,
 * plus rich tooltip text formatting.
 */

export interface ParamClipboardEntry {
  kind: ParamDef['kind'];
  paramId: string;
  state: ParamState;
}

let paramClipboard: ParamClipboardEntry | null = null;
let sectionClipboard: Record<string, ParamState> | null = null;

export function copyParamToClipboard(def: ParamDef, state: ParamState): void {
  paramClipboard = {
    kind: def.kind,
    paramId: def.id,
    state: structuredClone(state),
  };
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(JSON.stringify(paramClipboard));
    }
  } catch {
    // Ignore browser clipboard permission errors in sandboxed/headless environments
  }
}

export function canPasteParamFromClipboard(def: ParamDef): boolean {
  if (!paramClipboard) return false;
  if (paramClipboard.kind === def.kind) return true;
  if (
    (paramClipboard.kind === 'float' || paramClipboard.kind === 'int') &&
    (def.kind === 'float' || def.kind === 'int')
  ) {
    return true;
  }
  return false;
}

export function getParamFromClipboard(def: ParamDef): ParamState | null {
  if (!canPasteParamFromClipboard(def) || !paramClipboard) return null;
  const cloned = structuredClone(paramClipboard.state);
  if (def.kind === 'int' && typeof cloned.value === 'number') {
    cloned.value = Math.round(cloned.value);
  }
  return cloned;
}

export function copySectionToClipboard(defs: readonly ParamDef[], params: NodeParams): void {
  const payload: Record<string, ParamState> = {};
  for (const def of defs) {
    payload[def.id] = structuredClone(params[def.id] ?? defaultParamState(def));
  }
  sectionClipboard = payload;
}

export function getSectionClipboard(): Record<string, ParamState> | null {
  return sectionClipboard ? structuredClone(sectionClipboard) : null;
}

/** Build a descriptive tooltip for a parameter label/row. */
export function buildParamTooltip(def: ParamDef, state?: ParamState, mixed = false): string {
  const lines: string[] = [];
  const header = `${def.label} (${def.id})`;
  lines.push(header);
  if (def.tooltip) lines.push(def.tooltip);

  const details: string[] = [];
  if (def.kind === 'float' || def.kind === 'int') {
    const unit = def.unit ? ` ${def.unit}` : '';
    details.push(`Default: ${formatParamNumber(def.default, def.step, def.kind === 'int')}${unit}`);
    if (def.min !== undefined || def.max !== undefined) {
      const lo = def.min !== undefined ? String(def.min) : '-∞';
      const hi = def.max !== undefined ? String(def.max) : '+∞';
      details.push(`Range: [${lo}, ${hi}]${unit}`);
    }
    if (def.kind === 'float' && (def.softMin !== undefined || def.softMax !== undefined)) {
      const sLo = def.softMin ?? def.min ?? 0;
      const sHi = def.softMax ?? def.max ?? 1;
      details.push(`Slider: [${sLo}, ${sHi}]`);
    }
  } else if (def.kind === 'bool') {
    details.push(`Default: ${def.default ? 'On' : 'Off'}`);
  } else if (def.kind === 'enum') {
    const opt = def.options.find((o) => o.value === def.default);
    details.push(`Default: ${opt?.label ?? def.default}`);
  } else if (def.kind === 'range') {
    details.push(`Default: [${def.default[0]}, ${def.default[1]}] · Range: [${def.min}, ${def.max}]`);
  } else if (def.kind === 'vec2' || def.kind === 'vec3') {
    details.push(`Default: (${def.default.join(', ')})`);
  }
  if (mixed) details.push('Mixed values across selected nodes');
  else if (state && typeof state.variance === 'number' && state.variance > 0) {
    details.push(`Variance: ±${state.variance}`);
  }
  if (details.length > 0) lines.push(details.join(' · '));
  lines.push('Drag label to scrub (Shift=fine, Ctrl=coarse) · Double-click to reset · Right-click for menu');
  return lines.join('\n');
}
