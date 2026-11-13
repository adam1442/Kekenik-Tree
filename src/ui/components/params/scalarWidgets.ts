import { getApp } from '@/app/context';
import type {
  AssetParamDef,
  BoolParamDef,
  EnumParamDef,
  ParamState,
  SeedParamDef,
  StringParamDef,
} from '@/contracts/params';
import type { AssetEntry } from '@/contracts/project';
import { uid } from '@/core/id';
import { h } from '../dom';
import { showMenu } from '../menu';
import type { ParamWidgetInstance, ParamWidgetMountOptions } from '../paramWidgetRegistry';
import { icon } from '../../icons/icons';
import { parseNumericInput } from './valueOps';

/** Boolean checkbox widget (`kt-check`). */
export function createBoolWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<BoolParamDef>,
): ParamWidgetInstance {
  let curState: ParamState = structuredClone(opts.state);
  let checked = typeof curState.value === 'boolean' ? curState.value : opts.def.default;
  let isMixed = Boolean(opts.mixed);

  const btn = h('button', 'kt-check');
  btn.type = 'button';
  btn.disabled = Boolean(opts.disabled);
  btn.setAttribute('role', 'checkbox');
  btn.setAttribute('aria-label', opts.def.label);

  const updateVisuals = (): void => {
    btn.classList.toggle('on', !isMixed && checked);
    btn.classList.toggle('mixed', isMixed);
    btn.setAttribute('aria-checked', isMixed ? 'mixed' : String(checked));
    if (isMixed) {
      btn.replaceChildren(icon('minus', 11));
    } else if (checked) {
      btn.replaceChildren(icon('check', 12));
    } else {
      btn.replaceChildren();
    }
  };

  updateVisuals();

  const toggle = (): void => {
    if (opts.disabled) return;
    const prevState = structuredClone(curState);
    checked = isMixed ? true : !checked;
    isMixed = false;
    curState = { ...curState, value: checked };
    updateVisuals();
    opts.onChange(structuredClone(curState), false);
    opts.onCommit?.(structuredClone(curState), prevState);
  };

  btn.addEventListener('click', toggle);
  btn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  });

  host.append(btn);

  return {
    element: btn,
    update(next: ParamState, mixed = false): void {
      curState = structuredClone(next);
      isMixed = mixed;
      if (typeof next.value === 'boolean') checked = next.value;
      updateVisuals();
    },
    focusInput(): void {
      btn.focus();
    },
    dispose(): void {
      btn.remove();
    },
  };
}

/** Enum dropdown widget (`kt-select`). */
export function createEnumWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<EnumParamDef>,
): ParamWidgetInstance {
  const { def } = opts;
  let curState: ParamState = structuredClone(opts.state);
  let curVal = typeof curState.value === 'string' ? curState.value : def.default;
  let isMixed = Boolean(opts.mixed);

  const getOptions = (): { value: string; label: string }[] => {
    const dyn = opts.resolveDynamicOptions?.(def.id);
    if (dyn && dyn.length > 0) return dyn;
    return def.options;
  };

  const labelSpan = h('span', 'kt-select-label');
  const btn = h('button', 'kt-select kt-param-select', labelSpan, icon('chevronDown', 12));
  btn.type = 'button';
  btn.disabled = Boolean(opts.disabled);
  btn.setAttribute('aria-label', def.label);

  const updateVisuals = (): void => {
    btn.classList.toggle('mixed', isMixed);
    if (isMixed) {
      labelSpan.textContent = '— Mixed —';
      return;
    }
    const list = getOptions();
    const match = list.find((o) => o.value === curVal || o.label.toLowerCase() === curVal.toLowerCase());
    labelSpan.textContent = match ? match.label : curVal || list[0]?.label || 'None';
  };

  updateVisuals();

  const selectValue = (val: string): void => {
    if (opts.disabled) return;
    const prevState = structuredClone(curState);
    curVal = val;
    isMixed = false;
    curState = { ...curState, value: val };
    updateVisuals();
    opts.onChange(structuredClone(curState), false);
    opts.onCommit?.(structuredClone(curState), prevState);
  };

  btn.addEventListener('click', () => {
    if (opts.disabled) return;
    const list = getOptions();
    showMenu(
      list.map((o) => ({
        label: o.label,
        checked: !isMixed && o.value === curVal,
        run: () => selectValue(o.value),
      })),
      btn,
    );
  });

  btn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (opts.disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const list = getOptions();
      if (list.length === 0) return;
      const idx = list.findIndex((o) => o.value === curVal);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const nextIdx = idx < 0 ? 0 : (idx + step + list.length) % list.length;
      const nextOpt = list[nextIdx];
      if (nextOpt) selectValue(nextOpt.value);
    }
  });

  host.append(btn);

  return {
    element: btn,
    update(next: ParamState, mixed = false): void {
      curState = structuredClone(next);
      isMixed = mixed;
      if (typeof next.value === 'string') curVal = next.value;
      updateVisuals();
    },
    focusInput(): void {
      btn.focus();
    },
    dispose(): void {
      btn.remove();
    },
  };
}

/** String parameter widget (single-line input or multiline textarea). */
export function createStringWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<StringParamDef>,
): ParamWidgetInstance {
  const { def } = opts;
  let curState: ParamState = structuredClone(opts.state);
  let curVal = typeof curState.value === 'string' ? curState.value : def.default;
  let isMixed = Boolean(opts.mixed);
  let focusStartState: ParamState = structuredClone(curState);

  const el: HTMLInputElement | HTMLTextAreaElement = def.multiline
    ? h('textarea', 'kt-field kt-param-textarea')
    : h('input', 'kt-field kt-param-string');
  if (el instanceof HTMLInputElement) el.type = 'text';
  else el.rows = 2;
  const hostEl: HTMLElement = el;
  el.disabled = Boolean(opts.disabled);
  el.setAttribute('aria-label', def.label);

  const updateVisuals = (): void => {
    if (isMixed) {
      el.value = '';
      el.placeholder = '— Mixed —';
      el.classList.add('mixed');
    } else {
      el.placeholder = '';
      el.classList.remove('mixed');
      el.value = curVal;
    }
  };

  updateVisuals();

  el.addEventListener('focus', () => {
    focusStartState = structuredClone(curState);
  });

  el.addEventListener('input', () => {
    curVal = el.value;
    isMixed = false;
    curState = { ...curState, value: curVal };
    opts.onChange(structuredClone(curState), true);
  });

  const commit = (): void => {
    curVal = el.value;
    curState = { ...curState, value: curVal };
    opts.onCommit?.(structuredClone(curState), focusStartState);
  };

  el.addEventListener('change', commit);
  hostEl.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !def.multiline) {
      e.preventDefault();
      commit();
      el.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      curState = structuredClone(focusStartState);
      curVal = typeof curState.value === 'string' ? curState.value : def.default;
      updateVisuals();
      opts.onChange(structuredClone(curState), false);
      el.blur();
    }
  });

  host.append(el);

  return {
    element: el,
    update(next: ParamState, mixed = false): void {
      curState = structuredClone(next);
      isMixed = mixed;
      if (typeof next.value === 'string') curVal = next.value;
      if (document.activeElement !== el) updateVisuals();
    },
    focusInput(): void {
      el.focus();
      el.select();
    },
    dispose(): void {
      el.remove();
    },
  };
}

/** Seed parameter widget (integer input + Randomize dice button). */
export function createSeedWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<SeedParamDef>,
): ParamWidgetInstance {
  const { def } = opts;
  let curState: ParamState = structuredClone(opts.state);
  let curSeed = typeof curState.value === 'number' ? Math.round(curState.value) : def.default;
  let isMixed = Boolean(opts.mixed);
  let scrubStart = curSeed;
  let gestureStartState = structuredClone(curState);

  const input = h('input', 'kt-num kt-seed-num');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.disabled = Boolean(opts.disabled);
  input.setAttribute('aria-label', def.label);

  const diceBtn = h('button', 'kt-icon-btn kt-seed-dice', icon('dice', 14));
  diceBtn.type = 'button';
  diceBtn.title = 'Randomize seed';
  diceBtn.disabled = Boolean(opts.disabled);

  const updateVisuals = (): void => {
    if (isMixed) {
      input.value = '';
      input.placeholder = '—';
      input.classList.add('mixed');
    } else {
      input.placeholder = '';
      input.classList.remove('mixed');
      input.value = String(curSeed);
    }
  };

  updateVisuals();

  const emitSeed = (nextSeed: number, merge: boolean): void => {
    const clamped = Math.max(0, Math.min(999_999_999, Math.round(nextSeed)));
    const prevState = structuredClone(curState);
    curSeed = clamped;
    isMixed = false;
    curState = { ...curState, value: clamped };
    updateVisuals();
    opts.onChange(structuredClone(curState), merge);
    if (!merge) {
      opts.onCommit?.(structuredClone(curState), prevState);
    }
  };

  diceBtn.addEventListener('click', () => {
    if (opts.disabled) return;
    // Generate a new random integer seed in [1, 999999]
    const nextSeed = Math.floor(Math.random() * 999_999) + 1;
    emitSeed(nextSeed, false);
  });

  let focusStart = curSeed;
  input.addEventListener('focus', () => {
    focusStart = curSeed;
    if (isMixed) input.value = String(curSeed);
    input.select();
  });

  input.addEventListener('change', () => {
    const parsed = parseNumericInput(input.value, curSeed);
    emitSeed(parsed, false);
  });

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const parsed = parseNumericInput(input.value, curSeed);
      emitSeed(parsed, false);
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      curSeed = focusStart;
      updateVisuals();
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      emitSeed(curSeed + (e.key === 'ArrowUp' ? step : -step), false);
      input.select();
    }
  });

  const wrapper = h('div', 'kt-param-seed', input, diceBtn);
  host.append(wrapper);

  return {
    element: wrapper,
    update(next: ParamState, mixed = false): void {
      curState = structuredClone(next);
      isMixed = mixed;
      if (typeof next.value === 'number') curSeed = Math.round(next.value);
      updateVisuals();
    },
    scrubBegin(): void {
      gestureStartState = structuredClone(curState);
      scrubStart = curSeed;
    },
    scrubBy(dxPixels: number, mod?: { shiftKey?: boolean; ctrlKey?: boolean }): void {
      if (opts.disabled) return;
      const mult = mod?.shiftKey ? 0.25 : mod?.ctrlKey ? 10 : 1;
      const next = Math.max(0, Math.round(scrubStart + (dxPixels * mult) / 3));
      scrubStart = next;
      emitSeed(next, true);
    },
    scrubCommit(): void {
      opts.onCommit?.(structuredClone(curState), gestureStartState);
    },
    focusInput(): void {
      input.focus();
      input.select();
    },
    dispose(): void {
      wrapper.remove();
    },
  };
}

/** Asset picker widget (image/mesh upload, drag-drop, thumbnail preview, clear). */
export function createAssetWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<AssetParamDef>,
): ParamWidgetInstance {
  const { def } = opts;
  let curState: ParamState = structuredClone(opts.state);
  let curAssetId: string | null = typeof curState.value === 'string' && curState.value ? curState.value : def.default;
  let isMixed = Boolean(opts.mixed);

  const getProjectAssets = (): AssetEntry[] => {
    try {
      const app = getApp();
      const docId = app.store.get().activeDocumentId;
      const meta = app.project.metaOf(docId);
      return meta?.assets.filter((a) => a.kind === def.assetKind) ?? [];
    } catch {
      return [];
    }
  };

  const addProjectAsset = (entry: AssetEntry): void => {
    try {
      const app = getApp();
      const docId = app.store.get().activeDocumentId;
      const meta = app.project.metaOf(docId);
      if (meta) {
        meta.assets.push(entry);
        app.undo.markDirty();
      }
    } catch {
      // Standalone widget in tests without app context
    }
  };

  // Thumbnail box (shows image preview or mesh glyph)
  const thumbBox = h('div', 'kt-asset-thumb checker');
  const labelSpan = h('span', 'kt-select-label');
  const selectBtn = h('button', 'kt-select kt-asset-select', labelSpan, icon('chevronDown', 12));
  selectBtn.type = 'button';
  selectBtn.disabled = Boolean(opts.disabled);

  const uploadBtn = h('button', 'kt-icon-btn kt-sq-btn', icon('plus', 13));
  uploadBtn.type = 'button';
  uploadBtn.title = `Import ${def.assetKind} file (or drag & drop here)`;
  uploadBtn.disabled = Boolean(opts.disabled);

  const clearBtn = h('button', 'kt-icon-btn kt-sq-btn', icon('close', 13));
  clearBtn.type = 'button';
  clearBtn.title = 'Clear asset';
  clearBtn.disabled = Boolean(opts.disabled);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = def.assetKind === 'image' ? 'image/*' : '.obj,.gltf,.glb,.json,model/*';
  fileInput.hidden = true;

  // Keep a local fallback map in case widget runs in isolated unit tests without ProjectManager
  const localAssets = new Map<string, AssetEntry>();

  const findAsset = (id: string | null): AssetEntry | undefined => {
    if (!id) return undefined;
    return localAssets.get(id) ?? getProjectAssets().find((a) => a.id === id);
  };

  const updateVisuals = (): void => {
    const asset = findAsset(curAssetId);
    clearBtn.disabled = Boolean(opts.disabled) || (!curAssetId && !isMixed);
    thumbBox.replaceChildren();

    if (isMixed) {
      labelSpan.textContent = '— Mixed —';
      thumbBox.append(h('span', 'kt-asset-badge', '?'));
      return;
    }

    if (!curAssetId) {
      labelSpan.textContent = 'None';
      thumbBox.append(icon(def.assetKind === 'image' ? 'toolPaint' : 'cube', 14));
      return;
    }

    labelSpan.textContent = asset?.name ?? curAssetId;
    if (def.assetKind === 'image' && asset?.data && asset.data.startsWith('data:image')) {
      const img = document.createElement('img');
      img.className = 'kt-asset-img';
      img.src = asset.data;
      img.alt = asset.name;
      thumbBox.append(img);
    } else {
      thumbBox.append(icon(def.assetKind === 'image' ? 'toolPaint' : 'cube', 14));
    }
  };

  updateVisuals();

  const emitAsset = (nextId: string | null): void => {
    if (opts.disabled) return;
    const prevState = structuredClone(curState);
    curAssetId = nextId;
    isMixed = false;
    curState = { ...curState, value: nextId };
    updateVisuals();
    opts.onChange(structuredClone(curState), false);
    opts.onCommit?.(structuredClone(curState), prevState);
  };

  const handleFile = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const entry: AssetEntry = {
        id: uid('asset'),
        kind: def.assetKind,
        name: file.name,
        mime: file.type || (def.assetKind === 'image' ? 'image/png' : 'application/octet-stream'),
        data: dataUrl,
      };
      localAssets.set(entry.id, entry);
      addProjectAsset(entry);
      emitAsset(entry.id);
    };
    reader.readAsDataURL(file);
  };

  selectBtn.addEventListener('click', () => {
    if (opts.disabled) return;
    const assets = getProjectAssets();
    const merged = [...assets];
    for (const a of localAssets.values()) {
      if (!merged.some((m) => m.id === a.id)) merged.push(a);
    }
    showMenu(
      [
        { label: 'None', checked: !isMixed && curAssetId === null, run: () => emitAsset(null) },
        ...merged.map((a) => ({
          label: a.name,
          checked: !isMixed && curAssetId === a.id,
          run: () => emitAsset(a.id),
        })),
        { separator: true },
        { label: `Import ${def.assetKind}…`, run: () => fileInput.click() },
      ],
      selectBtn,
    );
  });

  uploadBtn.addEventListener('click', () => {
    if (!opts.disabled) fileInput.click();
  });

  clearBtn.addEventListener('click', () => {
    if (!opts.disabled && (curAssetId !== null || isMixed)) emitAsset(null);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleFile(file);
    fileInput.value = '';
  });

  const wrapper = h('div', 'kt-param-asset', thumbBox, selectBtn, uploadBtn, clearBtn, fileInput);

  // Drag & drop file onto the asset picker
  wrapper.addEventListener('dragover', (e) => {
    if (opts.disabled) return;
    e.preventDefault();
    wrapper.classList.add('drag-over');
  });
  wrapper.addEventListener('dragleave', () => {
    wrapper.classList.remove('drag-over');
  });
  wrapper.addEventListener('drop', (e) => {
    if (opts.disabled) return;
    e.preventDefault();
    wrapper.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  host.append(wrapper);

  return {
    element: wrapper,
    update(next: ParamState, mixed = false): void {
      curState = structuredClone(next);
      isMixed = mixed;
      curAssetId = typeof next.value === 'string' && next.value ? next.value : null;
      updateVisuals();
    },
    focusInput(): void {
      selectBtn.focus();
    },
    dispose(): void {
      wrapper.remove();
    },
  };
}
