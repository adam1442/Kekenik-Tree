import type { CutoutMesh } from '@/contracts/material';
import { norm, rotate, type V3 } from '@/geometry/math3';
import { frameBasis } from '@/geometry/rigid';
import {
  anchorFrameInPose,
  attachmentWarnings,
  axisStatus,
  baseFrameInPose,
  buildCutoutFrame,
  cardPoseFor,
  uvToLocal,
  type Point2,
} from '@/materials/cutouts';
import { h } from '@/ui/components/dom';

/** Edit Mesh helpers for the attachment data: canvas overlay, anchor inspector, status and 3D-ish preview. */

type Uv2Canvas = (uv: Point2, W: number, H: number) => [number, number];

const BASE_COLOR = '#ffd400';
const AXIS_COLOR = '#f08a1c';

/** Axis base marker ("attach here"), tip arrow and anchor direction arrows + index labels on the 2D canvas. */
export function drawAttachmentOverlay(g: CanvasRenderingContext2D, W: number, H: number, cutout: CutoutMesh, uvToCanvas: Uv2Canvas, selected: number): void {
  const axis = cutout.straightenAxis;
  if (axis.length >= 2) {
    // tip arrow
    const [bx, by] = uvToCanvas(axis[axis.length - 2] as Point2, W, H);
    const [tx, ty] = uvToCanvas(axis[axis.length - 1] as Point2, W, H);
    const a = Math.atan2(ty - by, tx - bx);
    g.fillStyle = AXIS_COLOR;
    g.beginPath();
    g.moveTo(tx + Math.cos(a) * 10, ty + Math.sin(a) * 10);
    g.lineTo(tx + Math.cos(a + 2.5) * 9, ty + Math.sin(a + 2.5) * 9);
    g.lineTo(tx + Math.cos(a - 2.5) * 9, ty + Math.sin(a - 2.5) * 9);
    g.closePath();
    g.fill();
    // base marker: diamond with a ring, distinct from vertices (round) and anchors (green)
    const [x, y] = uvToCanvas(axis[0] as Point2, W, H);
    g.strokeStyle = '#000000';
    g.lineWidth = 3;
    g.fillStyle = BASE_COLOR;
    g.beginPath();
    g.moveTo(x, y - 9);
    g.lineTo(x + 9, y);
    g.lineTo(x, y + 9);
    g.lineTo(x - 9, y);
    g.closePath();
    g.stroke();
    g.fill();
    g.fillStyle = '#000000';
    g.font = '600 10px Inter, sans-serif';
    g.textAlign = 'left';
    g.fillText('attach', x + 12, y - 6);
  }
  cutout.anchors.forEach((anc, idx) => {
    const [ax, ay] = uvToCanvas(anc.uv, W, H);
    const [hx, hy] = uvToCanvas(anc.handleUv, W, H);
    const a = Math.atan2(hy - ay, hx - ax);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(hx + Math.cos(a) * 9, hy + Math.sin(a) * 9);
    g.lineTo(hx + Math.cos(a + 2.6) * 6, hy + Math.sin(a + 2.6) * 6);
    g.lineTo(hx + Math.cos(a - 2.6) * 6, hy + Math.sin(a - 2.6) * 6);
    g.closePath();
    g.fill();
    if (idx === selected) {
      g.strokeStyle = BASE_COLOR;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(ax, ay, 9, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#12d600';
    g.font = '700 11px Inter, sans-serif';
    g.textAlign = 'center';
    g.fillText(String(idx + 1), ax, ay + 18);
  });
}

/** Footer text: base coordinates, axis direction, anchor count and warnings. */
export function attachmentStatus(cutout: CutoutMesh): { text: string; warnings: string[] } {
  const s = axisStatus(cutout);
  const warnings = attachmentWarnings(cutout);
  return {
    text: `Base ${s.base[0].toFixed(3)}, ${s.base[1].toFixed(3)}   Axis ${s.angleDeg.toFixed(1)}°   Anchors ${cutout.anchors.length}`,
    warnings,
  };
}

const num = (value: number, step: string, onInput: (v: number) => void): HTMLInputElement => {
  const el = h('input', 'kt-em-num') as HTMLInputElement;
  el.type = 'number';
  el.step = step;
  el.value = String(Math.round(value * 100) / 100);
  el.addEventListener('change', () => {
    const v = Number(el.value);
    if (Number.isFinite(v)) onInput(v);
  });
  return el;
};

export interface AnchorInspector {
  el: HTMLElement;
  sync(): void;
}

/** "Anchor" inspector row: angle (relative to the axis up), roll and scale of the selected anchor. */
export function createAnchorInspector(opts: {
  getCutout: () => CutoutMesh;
  getSelected: () => number;
  /** Called before a numeric edit so the dialog can push its undo state. */
  beforeEdit: () => void;
  changed: () => void;
}): AnchorInspector {
  const row = h('div', 'kt-em-anchor-row');
  const render = (): void => {
    row.replaceChildren();
    const c = opts.getCutout();
    const i = opts.getSelected();
    const a = c.anchors[i];
    if (!a) {
      row.append(h('span', 'kt-em-anchor-label', 'Anchor: none selected'));
      return;
    }
    const dx = a.handleUv[0] - a.uv[0];
    const dy = a.handleUv[1] - a.uv[1];
    const angle = (Math.atan2(dx, dy) * 180) / Math.PI;
    const len = Math.max(0.05, Math.hypot(dx, dy));
    const apply = (fn: () => void): void => {
      opts.beforeEdit();
      fn();
      opts.changed();
    };
    row.append(
      h('span', 'kt-em-anchor-label', `Anchor ${i + 1}`),
      h('span', 'kt-em-anchor-label', 'Angle'),
      num(angle, '1', (v) => apply(() => {
        const r = (v * Math.PI) / 180;
        a.handleUv = [Math.min(1, Math.max(0, a.uv[0] + Math.sin(r) * len)), Math.min(1, Math.max(0, a.uv[1] + Math.cos(r) * len))];
      })),
      h('span', 'kt-em-anchor-label', 'Roll'),
      num(a.roll ?? 0, '1', (v) => apply(() => { a.roll = v; })),
      h('span', 'kt-em-anchor-label', 'Scale'),
      num(a.scale ?? 1, '0.05', (v) => apply(() => { a.scale = Math.max(0.01, v); })),
    );
  };
  render();
  return { el: row, sync: render };
}

export interface AttachmentPreview {
  el: HTMLElement;
  setVisible(v: boolean): void;
  draw(cutout: CutoutMesh): void;
}

/** Small preview: the cutout planted on a sample stem with the base pivot touching it, axis triads and child cards. */
export function createAttachmentPreview(): AttachmentPreview {
  const canvas = h('canvas', 'kt-em-attach-canvas') as HTMLCanvasElement;
  canvas.width = 220;
  canvas.height = 180;
  const el = h('div', 'kt-em-attach', h('div', 'kt-em-attach-title', 'Attachment preview'), canvas);
  el.hidden = true;
  const yaw = 0.6;
  const pitch = 0.35;
  const project = (p: V3): [number, number] => {
    const x = p[0] * Math.cos(yaw) - p[1] * Math.sin(yaw);
    const y = p[0] * Math.sin(yaw) + p[1] * Math.cos(yaw);
    return [110 + x * 150, 150 - (p[2] * Math.cos(pitch) + y * Math.sin(pitch)) * 150];
  };
  const draw = (cutout: CutoutMesh): void => {
    const g = canvas.getContext('2d');
    if (!g || el.hidden) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#1b1b1b';
    g.fillRect(0, 0, canvas.width, canvas.height);
    // sample stem: vertical cylinder
    const stemTop: V3 = [0, 0, 0.9];
    g.strokeStyle = '#8a6a48';
    g.lineWidth = 9;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(...project([0, 0, 0]));
    g.lineTo(...project(stemTop));
    g.stroke();
    const metric = { w: 0.45, h: 0.55 };
    const frame = buildCutoutFrame(cutout, metric);
    const grow = norm(rotate([0, 0, 1], [0, 1, 0], 0.7));
    const side: V3 = [0, 1, 0];
    const origin: V3 = [0, 0, 0.55];
    const pose = cardPoseFor(frame, { origin, axis: grow, side }, { bend: 0.4 });
    // outline
    const baseF = baseFrameInPose(pose);
    const { x: bx, y: by } = frameBasis(baseF);
    g.strokeStyle = '#00e5ff';
    g.lineWidth = 1.5;
    g.beginPath();
    cutout.outline.forEach((uv, i) => {
      const l = uvToLocal(frame, uv);
      const p: V3 = [origin[0] + bx[0] * l[0] + by[0] * l[1], origin[1] + bx[1] * l[0] + by[1] * l[1], origin[2] + bx[2] * l[0] + by[2] * l[1]];
      const [x, y] = project(p);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.closePath();
    g.stroke();
    const triad = (p: V3, d: V3, up: V3, len: number): void => {
      const b = frameBasis({ position: p, direction: d, up });
      const [px, py] = project(p);
      const axes: [V3, string][] = [[b.x, '#ff4040'], [b.y, '#40ff40'], [b.z, '#4080ff']];
      for (const [v, col] of axes) {
        g.strokeStyle = col;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(...project([p[0] + v[0] * len, p[1] + v[1] * len, p[2] + v[2] * len]));
        g.stroke();
      }
    };
    triad(origin, baseF.direction, baseF.up, 0.12);
    for (const a of frame.anchors) {
      const f = anchorFrameInPose(pose, a);
      triad(f.position, f.direction, f.up, 0.07);
      // placeholder child card along the anchor direction
      const tip: V3 = [f.position[0] + f.direction[0] * 0.16, f.position[1] + f.direction[1] * 0.16, f.position[2] + f.direction[2] * 0.16];
      g.strokeStyle = '#12d600';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(...project(f.position));
      g.lineTo(...project(tip));
      g.stroke();
    }
  };
  return {
    el,
    setVisible(v) {
      el.hidden = !v;
    },
    draw,
  };
}
