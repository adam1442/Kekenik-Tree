import { getApp } from '@/app/context';
import type { MaterialDef, MaterialSlotValue, TextureSlot } from '@/contracts/material';
import type { RGBA } from '@/contracts/params';
import { cloneCurve, flatCurve } from '@/core/curve';
import { defaultPreviewView, getPreviewRenderer, type PreviewView } from '@/materials/preview';
import { MAX_RES_OPTIONS, SLOT_INFO, maxResToLabel, maxResToValue, slotInfo } from '@/materials/shadingMath';
import { getTextureManager } from '@/textures/textureManager';
import { h } from '../components/dom';
import { mountMiniCurve } from '../components/curve';
import { createSelect } from '../components/select';
import { showMenu } from '../components/menu';
import { showInfoDialog } from '../components/dialogs';
import { slider } from '../components/paramWidgets';
import type { PanelInstance } from '../docking/panelRegistry';
import { icon } from '../icons/icons';
import type { UVAreaDef } from '@/contracts/material';
import { lodCounts, renderCutout2DThumbnail } from '@/materials/cutouts';
import { openCurveDialog } from './dialogs/curveDialog';
import { openEditMeshDialog } from './dialogs/editMeshDialog';
import { mountAssetPanel, type AssetPanelContext } from './assets/assetPanel';
import { card, checkbox, colorSwatch, numberField, row, textField, valueSelect } from './assets/widgets';

/** Materials panel: preview (sphere / cut-out card), Settings groups and the texture-map slot grid. */

let slotClipboard: MaterialSlotValue | null = null;
const TABS = ['Settings', 'Cutouts/Meshes', 'UV Areas'] as const;
type Tab = (typeof TABS)[number];
let activeTab: Tab = 'Settings';
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif';

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

const fmtBytes = (n: number): string => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Draw a decoded asset (cover-fit, un-flipped) into a thumbnail canvas. */
async function drawThumb(canvas: HTMLCanvasElement, assetId: string): Promise<void> {
  const img = await getTextureManager().decoded(assetId, 256);
  if (!img) return;
  const w = (canvas.width = 176);
  const hh = (canvas.height = 144);
  const g = canvas.getContext('2d');
  if (!g) return;
  const s = Math.max(w / img.width, hh / img.height);
  g.save();
  g.translate(w / 2, hh / 2);
  g.scale(s, -s); // the bitmap is stored flipped for GPU upload
  g.drawImage(img.bitmap, -img.width / 2, -img.height / 2);
  g.restore();
}

function buildPreview(ctx: AssetPanelContext<MaterialDef>): HTMLElement {
  const renderer = getPreviewRenderer();
  const view: PreviewView = defaultPreviewView();
  let pan = false;
  const canvas = h('canvas', 'kt-mat-canvas');
  const hand = h('button', 'kt-mat-hand', icon('hand', 18));
  hand.type = 'button';
  hand.title = 'Hand tool: drag to pan (off: drag to rotate)';
  hand.addEventListener('click', () => {
    pan = !pan;
    hand.classList.toggle('active', pan);
  });
  const el = h('div', 'kt-mat-preview checker', canvas, hand);
  let raf = 0;
  const draw = (): void => {
    raf = 0;
    if (!ctx.entry || !el.isConnected) return;
    const w = Math.max(40, el.clientWidth);
    const hh = Math.max(40, el.clientHeight);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hh}px`;
    renderer.render(canvas, ctx.entry.id, w, hh, view);
  };
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(draw);
  };
  const ro = new ResizeObserver(schedule);
  ro.observe(el);
  const off = renderer.onInvalidate(schedule);
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    let lx = e.clientX;
    let ly = e.clientY;
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - lx;
      const dy = ev.clientY - ly;
      lx = ev.clientX;
      ly = ev.clientY;
      if (pan) {
        view.panX += dx / 160;
        view.panY -= dy / 160;
      } else {
        view.yaw += dx * 0.01;
        view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch + dy * 0.01));
      }
      schedule();
    };
    const up = (): void => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.zoom = Math.max(0.3, Math.min(4, view.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    schedule();
  }, { passive: false });
  const observer = new MutationObserver(() => {
    if (!el.isConnected) {
      ro.disconnect();
      off();
      observer.disconnect();
    }
  });
  queueMicrotask(() => {
    if (el.parentElement) observer.observe(el.parentElement, { childList: true });
    schedule();
  });
  return el;
}

function slotCard(ctx: AssetPanelContext<MaterialDef>, mat: MaterialDef, slot: TextureSlot, onChanged: () => void): HTMLElement {
  const app = getApp();
  const tm = getTextureManager();
  const info = slotInfo(slot);
  const value = mat.slots[slot] ?? {};
  const setSlot = (patch: (s: MaterialSlotValue) => void, label: string, key?: string): void => {
    ctx.edit(label, (m) => {
      const s = { ...(m.slots[slot] ?? {}) };
      patch(s);
      m.slots[slot] = s;
    }, key);
  };

  const control =
    info.mode === 'color'
      ? colorSwatch(value.color ?? [1, 1, 1, 1], (c: RGBA) => setSlot((s) => (s.color = c), `Set ${info.title}`, `${slot}-color`), 'kt-slot-color')
      : numberField({
          value: value.scalar ?? info.defaultScalar,
          empty: value.scalar === undefined,
          placeholder: 'Number',
          step: 0.05,
          onChange: (v) => setSlot((s) => (s.scalar = v), `Set ${info.title}`, `${slot}-scalar`),
          onClear: () => setSlot((s) => delete s.scalar, `Clear ${info.title} value`),
        });
  if (info.mode === 'number') control.classList.add('kt-slot-num');

  const canvas = h('canvas', 'kt-thumb-canvas');
  const thumb = h('div', `kt-thumb checker${value.texture ? ' filled' : ''}`, value.texture ? canvas : null);
  thumb.title = value.texture ? 'Click to replace · right-click for options' : 'Click or drop an image';
  if (value.texture) void drawThumb(canvas, value.texture.assetId);

  const assign = async (file: File | null): Promise<void> => {
    if (!file) return;
    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)) {
      app.notify(`${file.name}: unsupported format (PNG, JPG, WebP, GIF, BMP, AVIF).`);
      return;
    }
    const asset = await tm.importFile(file);
    setSlot((s) => (s.texture = { assetId: asset.id }), `Import ${info.title} map`);
    onChanged();
  };
  thumb.addEventListener('click', () => void pickFile(IMAGE_ACCEPT).then(assign));
  thumb.addEventListener('dragover', (e) => {
    e.preventDefault();
    thumb.classList.add('drop');
  });
  thumb.addEventListener('dragleave', () => thumb.classList.remove('drop'));
  thumb.addEventListener('drop', (e) => {
    e.preventDefault();
    thumb.classList.remove('drop');
    void assign(e.dataTransfer?.files?.[0] ?? null);
  });
  thumb.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const tex = value.texture;
    showMenu(
      [
        { label: 'Replace…', run: () => void pickFile(IMAGE_ACCEPT).then(assign) },
        { label: 'Clear', disabled: !tex, run: () => { setSlot((s) => delete s.texture, `Clear ${info.title} map`); onChanged(); } },
        {
          label: 'Reveal info',
          disabled: !tex,
          run: () => {
            if (!tex) return;
            void tm.info(tex.assetId).then((i) => {
              if (!i) return;
              showInfoDialog(app.dialogLayer, `${info.title} map`, h('div', 'kt-info-content', `${i.name}`, h('br'), `${i.width} × ${i.height} px · ${i.mime} · ${fmtBytes(i.bytes)}${i.hasAlpha ? ' · alpha' : ''}`), { w: 360, h: 160 });
            });
          },
        },
        { label: 'Reload', disabled: !tex, run: () => { if (tex) { tm.invalidate(tex.assetId); onChanged(); } } },
        { separator: true },
        { label: 'Copy slot', run: () => (slotClipboard = structuredClone(value)) },
        { label: 'Paste slot', disabled: !slotClipboard, run: () => { const c = slotClipboard; if (c) { setSlot((s) => Object.assign(s, structuredClone(c)), `Paste ${info.title}`); onChanged(); } } },
      ],
      { x: e.clientX, y: e.clientY },
    );
  });
  return h('div', 'kt-slot', h('div', 'kt-slot-title', info.title), control, thumb);
}

function settingsTab(ctx: AssetPanelContext<MaterialDef>, mat: MaterialDef, rebuild: () => void): HTMLElement {
  const lib = ctx.lib;
  const others = (): { value: string; label: string }[] => [{ value: '', label: 'None' }, ...lib.materials().filter((m) => m.id !== mat.id).map((m) => ({ value: m.id, label: m.name }))];

  const seasonHost = h('div', 'kt-season-host');
  const mini = mountMiniCurve(seasonHost, {
    curve: mat.season ?? flatCurve(1),
    width: 42,
    height: 20,
    path: `Material.${mat.name}:Season`,
    onChange: (c) => ctx.edit('Edit season curve', (m) => (m.season = cloneCurve(c)), 'season'),
    onOpenEditor: (c) =>
      openCurveDialog(`Material.${mat.name}:Season`, {
        curve: c,
        onChange: (next) => {
          mini.setCurve(next);
          ctx.edit('Edit season curve', (m) => (m.season = cloneCurve(next)), 'season');
        },
      }),
  });

  const amount = slider({ value: mat.variationAmount, min: 0, max: 1, ticks: false, onChange: (v) => ctx.edit('Variation amount', (m) => (m.variationAmount = v), 'amount') });
  const swatches = h(
    'div',
    'kt-var-swatches',
    ...mat.variations.map((c, i) => colorSwatch(c, (n) => ctx.edit('Variation color', (m) => (m.variations[i] = n), `var${i}`))),
  );

  const left = h(
    'div',
    'kt-mat-col',
    card('Main', row('Two-sided', checkbox(mat.twoSided, (v) => ctx.edit('Two-sided', (m) => (m.twoSided = v)))), row('Season', seasonHost)),
    card('Variations', swatches, row('Amount', amount.el)),
    card(
      'Back',
      row('Material', valueSelect(others, mat.backMaterialId ?? '', (v) => ctx.edit('Back material', (m) => (m.backMaterialId = v || null)), 'kt-sel-sm').el),
      row('Spacing', numberField({ value: mat.backSpacing, min: 0, step: 0.001, onChange: (v) => ctx.edit('Back spacing', (m) => (m.backSpacing = v), 'spacing') })),
    ),
  );
  const edit = h('button', 'kt-btn kt-btn-wide', 'Edit mesh');
  edit.type = 'button';
  edit.addEventListener('click', () => {
    getApp().events.emit('material:editMesh', { materialId: mat.id });
    openEditMeshDialog({ materialId: mat.id, materialName: mat.name });
  });
  const right = h(
    'div',
    'kt-mat-col',
    card(
      'Atlas',
      row('Scale', numberField({ value: mat.atlas.scale, min: 0.001, onChange: (v) => ctx.edit('Atlas scale', (m) => (m.atlas.scale = v), 'atlas') })),
      row('Handling', createSelect({ options: ['Default', 'Cutout', 'Mesh'], value: { default: 'Default', cutout: 'Cutout', mesh: 'Mesh' }[mat.atlas.handling], width: 92, className: 'kt-sel-sm', onChange: (v) => ctx.edit('Atlas handling', (m) => (m.atlas.handling = v.toLowerCase() as MaterialDef['atlas']['handling'])) })),
      row('Name', textField(mat.atlas.name, (v) => ctx.edit('Atlas name', (m) => (m.atlas.name = v)))),
    ),
    card(
      'Other',
      row('Max res.', createSelect({ options: [...MAX_RES_OPTIONS], value: maxResToLabel(mat.maxResolution), width: 92, className: 'kt-sel-sm', onChange: (v) => ctx.edit('Max resolution', (m) => (m.maxResolution = maxResToValue(v))) })),
      row('User data', textField(mat.userData, (v) => ctx.edit('User data', (m) => (m.userData = v)))),
      edit,
    ),
  );
  const slots = h('div', 'kt-slots', ...SLOT_INFO.map((s) => slotCard(ctx, mat, s.slot, rebuild)));
  const tm = getTextureManager();
  const memory = h('div', 'kt-mat-memory');
  const paint = (): void => {
    memory.textContent = `Textures in GPU memory: ${tm.poolSize()} · ${fmtBytes(tm.memoryBytes())}`;
  };
  paint();
  const off = tm.onChange(() => (memory.isConnected ? paint() : off()));
  return h('div', 'kt-mat-settings', h('div', 'kt-mat-cols', left, right), slots, memory);
}

function cutoutsTab(ctx: AssetPanelContext<MaterialDef>, mat: MaterialDef, rebuild: () => void): HTMLElement {
  const lib = ctx.lib;
  const cutouts = lib.cutoutsForMaterial(mat.id);

  const addBtn = h('button', 'kt-btn', icon('plus', 14), h('span', '', 'Add Cutout'));
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    lib.add('meshes', mat.id);
    rebuild();
  });

  const editBtn = h('button', 'kt-btn', 'Edit Mesh…');
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => {
    openEditMeshDialog({ materialId: mat.id, materialName: mat.name });
  });

  const toolbar = h('div', 'kt-cutouts-toolbar', addBtn, editBtn);

  const listEl = h('div', 'kt-cutouts-grid');
  if (cutouts.length === 0) {
    listEl.append(
      h(
        'div',
        'kt-prop-empty',
        'No cutouts assigned to this material yet. Click "Add Cutout" or "Edit Mesh…" to author one.',
      ),
    );
  } else {
    for (const c of cutouts) {
      const thumbCanvas = h('canvas', 'kt-cutout-thumb-canvas');
      const thumbWrap = h('div', 'kt-cutout-thumb checker', thumbCanvas);
      queueMicrotask(() => renderCutout2DThumbnail(thumbCanvas, c, 72, 72));

      const nameInp = textField(c.name, (next) => {
        lib.rename('meshes', c.id, next);
        rebuild();
      });
      nameInp.classList.add('kt-cutout-name');

      const counts = lodCounts(c.lods?.high ?? { level: 'high', step: 0, vertices: [], indices: [], sourceName: 'Embedded' });
      const metaLabel = h('div', 'kt-cutout-meta', `V:${counts.vertices}  F:${counts.faces}  A:${c.anchors.length}`);

      const openBtn = h('button', 'kt-btn kt-btn-sm', 'Edit');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => openEditMeshDialog({ cutoutId: c.id, materialId: mat.id, materialName: mat.name }));

      const dupBtn = h('button', 'kt-btn kt-btn-icon', icon('copy', 13));
      dupBtn.type = 'button';
      dupBtn.title = 'Duplicate cutout';
      dupBtn.addEventListener('click', () => {
        lib.duplicate('meshes', c.id);
        rebuild();
      });

      const delBtn = h('button', 'kt-btn kt-btn-icon', icon('close', 13));
      delBtn.type = 'button';
      delBtn.title = 'Delete cutout';
      delBtn.disabled = lib.cutoutMeshes().length <= 1;
      delBtn.addEventListener('click', () => {
        lib.remove('meshes', c.id);
        rebuild();
      });

      const itemCard = h(
        'div',
        'kt-cutout-card',
        thumbWrap,
        h('div', 'kt-cutout-info', nameInp, metaLabel, h('div', 'kt-cutout-actions', openBtn, dupBtn, delBtn)),
      );
      itemCard.draggable = true;
      itemCard.title = 'Drag onto a Leaf node or Type > Mesh field to assign';
      itemCard.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('application/x-kekenik-cutout', c.id);
        e.dataTransfer?.setData('text/plain', c.name);
      });
      listEl.append(itemCard);
    }
  }

  return h('div', 'kt-mat-cutouts-tab', toolbar, listEl);
}

let selectedUvAreaId: string | null = null;

function uvAreasTab(ctx: AssetPanelContext<MaterialDef>, mat: MaterialDef, rebuild: () => void): HTMLElement {
  const lib = ctx.lib;
  const areas = lib.uvAreasForMaterial(mat.id);
  if (selectedUvAreaId && !areas.some((a) => a.id === selectedUvAreaId)) {
    selectedUvAreaId = areas[0]?.id ?? null;
  } else if (!selectedUvAreaId && areas.length > 0) {
    selectedUvAreaId = areas[0]!.id;
  }

  const addBtn = h('button', 'kt-btn', icon('plus', 14), h('span', '', 'Add UV Area'));
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    selectedUvAreaId = lib.add('uvAreas', mat.id);
    rebuild();
  });

  const dupBtn = h('button', 'kt-btn', 'Duplicate');
  dupBtn.type = 'button';
  dupBtn.disabled = !selectedUvAreaId;
  dupBtn.addEventListener('click', () => {
    if (!selectedUvAreaId) return;
    const copy = lib.duplicate('uvAreas', selectedUvAreaId);
    if (copy) selectedUvAreaId = copy;
    rebuild();
  });

  const delBtn = h('button', 'kt-btn', 'Delete');
  delBtn.type = 'button';
  delBtn.disabled = !selectedUvAreaId;
  delBtn.addEventListener('click', () => {
    if (!selectedUvAreaId) return;
    lib.remove('uvAreas', selectedUvAreaId);
    selectedUvAreaId = null;
    rebuild();
  });

  const toolbar = h('div', 'kt-cutouts-toolbar', addBtn, dupBtn, delBtn);

  // Interactive 2D Atlas Canvas
  const atlasCanvas = h('canvas', 'kt-uv-atlas-canvas');
  const atlasWrap = h('div', 'kt-uv-atlas-wrap checker', atlasCanvas);

  const drawAtlas = (): void => {
    const W = Math.max(120, atlasWrap.clientWidth || 220);
    const H = 170;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    atlasCanvas.width = Math.round(W * dpr);
    atlasCanvas.height = Math.round(H * dpr);
    atlasCanvas.style.width = `${W}px`;
    atlasCanvas.style.height = `${H}px`;
    const g = atlasCanvas.getContext('2d');
    if (!g) return;
    g.save();
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);

    const pad = 10;
    const size = Math.min(W - pad * 2, H - pad * 2);
    const x0 = (W - size) * 0.5;
    const y0 = (H - size) * 0.5;

    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillRect(x0, y0, size, size);
    g.strokeStyle = '#565656';
    g.strokeRect(x0, y0, size, size);

    const curAreas = lib.uvAreasForMaterial(mat.id);
    for (const area of curAreas) {
      const [u0, v0, u1, v1] = area.rect;
      const rx = x0 + Math.min(u0, u1) * size;
      const ry = y0 + (1 - Math.max(v0, v1)) * size;
      const rw = Math.abs(u1 - u0) * size;
      const rh = Math.abs(v1 - v0) * size;
      const isSel = area.id === selectedUvAreaId;

      g.fillStyle = isSel ? 'rgba(236, 213, 49, 0.16)' : 'rgba(0, 232, 255, 0.12)';
      g.strokeStyle = isSel ? '#ecd531' : '#00e8ff';
      g.lineWidth = isSel ? 1.8 : 1.2;
      g.fillRect(rx, ry, rw, rh);
      g.strokeRect(rx, ry, rw, rh);

      g.fillStyle = isSel ? '#ecd531' : '#d6d6d6';
      g.font = '600 10px Inter, sans-serif';
      g.fillText(area.name, rx + 4, ry + 12);

      // Pivot marker
      const px = x0 + area.pivot[0] * size;
      const py = y0 + (1 - area.pivot[1]) * size;
      g.fillStyle = '#12d600';
      g.beginPath();
      g.arc(px, py, 3.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  };

  atlasCanvas.addEventListener('pointerdown', (e) => {
    const rect = atlasCanvas.getBoundingClientRect();
    const W = Math.max(120, rect.width || 220);
    const H = Math.max(120, rect.height || 170);
    const pad = 10;
    const size = Math.min(W - pad * 2, H - pad * 2);
    const x0 = (W - size) * 0.5;
    const y0 = (H - size) * 0.5;
    const toUv = (ev: PointerEvent): [number, number] => [
      Math.max(0, Math.min(1, (ev.clientX - rect.left - x0) / size)),
      Math.max(0, Math.min(1, 1 - (ev.clientY - rect.top - y0) / size)),
    ];

    const [uStart, vStart] = toUv(e);
    const curAreas = lib.uvAreasForMaterial(mat.id);
    const hit = curAreas.find(
      (a) => uStart >= a.rect[0] && uStart <= a.rect[2] && vStart >= a.rect[1] && vStart <= a.rect[3],
    );
    if (!hit) return;
    selectedUvAreaId = hit.id;
    drawAtlas();

    const startRect: [number, number, number, number] = [...hit.rect];
    const onMove = (ev: PointerEvent): void => {
      const [uNow, vNow] = toUv(ev);
      const du = uNow - uStart;
      const dv = vNow - vStart;
      const wSpan = startRect[2] - startRect[0];
      const hSpan = startRect[3] - startRect[1];
      const nu0 = Math.max(0, Math.min(1 - wSpan, startRect[0] + du));
      const nv0 = Math.max(0, Math.min(1 - hSpan, startRect[1] + dv));
      lib.edit(
        'Move UV Area',
        'uvAreas',
        () => {
          const target = lib.uvAreas().find((a) => a.id === hit.id);
          if (target) {
            target.rect = [
              Math.round(nu0 * 1000) / 1000,
              Math.round(nv0 * 1000) / 1000,
              Math.round((nu0 + wSpan) * 1000) / 1000,
              Math.round((nv0 + hSpan) * 1000) / 1000,
            ];
            target.pivot = [(target.rect[0] + target.rect[2]) * 0.5, target.rect[1]];
          }
        },
        `uvarea:${hit.id}`,
      );
      drawAtlas();
    };
    const onUp = (): void => {
      atlasCanvas.removeEventListener('pointermove', onMove);
      atlasCanvas.removeEventListener('pointerup', onUp);
      rebuild();
    };
    atlasCanvas.addEventListener('pointermove', onMove);
    atlasCanvas.addEventListener('pointerup', onUp);
  });

  const listEl = h('div', 'kt-uv-areas-list');
  if (areas.length === 0) {
    listEl.append(h('div', 'kt-prop-empty', 'No UV areas defined. Click "Add UV Area" to partition the atlas.'));
  } else {
    for (const area of areas) {
      const isSel = area.id === selectedUvAreaId;
      const editArea = (label: string, fn: (a: UVAreaDef) => void, key?: string): void => {
        lib.edit(
          label,
          'uvAreas',
          () => {
            const target = lib.uvAreas().find((x) => x.id === area.id);
            if (target) fn(target);
          },
          key ? `uva:${area.id}:${key}` : undefined,
        );
        drawAtlas();
      };

      const nameField = textField(area.name, (v) => {
        lib.rename('uvAreas', area.id, v);
        drawAtlas();
      });
      const usageSel = createSelect({
        options: ['any', 'leaf', 'bark', 'cap', 'frond'],
        value: area.usage,
        width: 78,
        className: 'kt-sel-sm',
        onChange: (v) => editArea('UV Area usage', (a) => (a.usage = v as UVAreaDef['usage'])),
      });
      const weightNum = numberField({
        value: area.weight,
        min: 0,
        max: 100,
        step: 0.1,
        onChange: (v) => editArea('UV Area weight', (a) => (a.weight = v), 'weight'),
      });

      const boundField = (idx: 0 | 1 | 2 | 3, lbl: string): HTMLElement =>
        row(
          lbl,
          numberField({
            value: area.rect[idx],
            min: 0,
            max: 1,
            step: 0.05,
            onChange: (v) =>
              editArea(
                `UV Area ${lbl}`,
                (a) => {
                  a.rect[idx] = v;
                  a.pivot = [(a.rect[0] + a.rect[2]) * 0.5, a.rect[1]];
                },
                lbl,
              ),
          }),
        );

      const areaCard = h(
        'div',
        `kt-uv-area-card${isSel ? ' active' : ''}`,
        row('Name', nameField),
        row('Usage', usageSel),
        row('Weight', weightNum),
        h('div', 'kt-uv-bounds-grid', boundField(0, 'U0'), boundField(1, 'V0'), boundField(2, 'U1'), boundField(3, 'V1')),
      );
      areaCard.addEventListener('click', () => {
        selectedUvAreaId = area.id;
        drawAtlas();
      });
      listEl.append(areaCard);
    }
  }

  queueMicrotask(drawAtlas);
  return h('div', 'kt-mat-uv-tab', toolbar, atlasWrap, listEl);
}

export function createMaterialsPanel(host: HTMLElement): PanelInstance {
  getTextureManager();
  return mountAssetPanel<MaterialDef>(host, {
    kind: 'materials',
    noun: 'material',
    className: 'kt-mat',
    alsoKinds: ['meshes', 'uvAreas'],
    beforeBody: (ctx) => (ctx.entry ? buildPreview(ctx) : null),
    build(ctx) {
      const mat = ctx.entry;
      if (!mat) return;
      const tabsEl = h('div', 'kt-mat-tabs');
      const body = h('div', 'kt-mat-body');
      const render = (): void => {
        const fresh = ctx.lib.material(mat.id) ?? mat;
        body.replaceChildren(
          activeTab === 'Settings'
            ? settingsTab(ctx, fresh, render)
            : activeTab === 'Cutouts/Meshes'
              ? cutoutsTab(ctx, fresh, render)
              : uvAreasTab(ctx, fresh, render),
        );
      };
      for (const t of TABS) {
        const b = h('button', `kt-mat-tab${t === activeTab ? ' active' : ''}`, t);
        b.type = 'button';
        b.addEventListener('click', () => {
          activeTab = t;
          tabsEl.querySelectorAll('.kt-mat-tab').forEach((x) => x.classList.toggle('active', x === b));
          render();
        });
        tabsEl.append(b);
      }
      ctx.body.append(tabsEl, body);
      render();
    },
  });
}
