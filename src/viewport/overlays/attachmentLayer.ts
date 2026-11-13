import { BufferAttribute, BufferGeometry, Group, LineSegments, ShaderMaterial, type PerspectiveCamera } from 'three';
import type { AttachmentSet } from '@/contracts/attachment';
import { frameBasis } from '@/geometry/rigid';

/**
 * "Show > Attachment frames" overlay: an axis triad (X red, Y green = growth, Z blue = card normal) at the
 * base of every placed cutout instance and at each of its anchors. The triad length is constant in SCREEN space: the
 * vertex shader converts a pixel length into world units with the distance to the camera.
 */
const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aDir;
attribute float aEnd;
attribute float aPx;
attribute vec3 color;
uniform float uHeight;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(aOrigin, 1.0);
  float worldPerPixel = abs(mv.z) * 2.0 / (projectionMatrix[1][1] * max(uHeight, 1.0));
  vec3 p = aOrigin + aDir * aEnd * aPx * worldPerPixel;
  vColor = color;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
}
`;
const FRAG = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }
`;

export class AttachmentLayer {
  private lines: LineSegments | null = null;
  private readonly material = new ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { uHeight: { value: 600 } }, depthTest: false, transparent: true });
  frameCount = 0;

  constructor(private readonly group: Group) {}

  setViewportHeight(px: number, _camera?: PerspectiveCamera): void {
    this.material.uniforms.uHeight!.value = px;
  }

  rebuild(sets: readonly { nodeId: string; attachments: AttachmentSet }[], selected: ReadonlySet<string>, enabled: boolean): void {
    this.clear();
    if (!enabled) return;
    const origin: number[] = [];
    const dir: number[] = [];
    const end: number[] = [];
    const px: number[] = [];
    const col: number[] = [];
    let frames = 0;
    const triad = (p: ArrayLike<number>, o: number, d: [number, number, number], up: [number, number, number], len: number): void => {
      const b = frameBasis({ position: [p[o] as number, p[o + 1] as number, p[o + 2] as number], direction: d, up });
      const axes: [number[], number[]][] = [[b.x, [1, 0.25, 0.25]], [b.y, [0.25, 1, 0.25]], [b.z, [0.3, 0.55, 1]]];
      for (const [v, c] of axes) {
        for (const e of [0, 1]) {
          origin.push(p[o] as number, p[o + 1] as number, p[o + 2] as number);
          dir.push(v[0] as number, v[1] as number, v[2] as number);
          end.push(e);
          px.push(len);
          col.push(c[0] as number, c[1] as number, c[2] as number);
        }
      }
      frames += 1;
    };
    for (const { nodeId, attachments: a } of sets) {
      const sel = selected.has(nodeId);
      const baseLen = sel ? 40 : 24;
      for (let i = 0; i < a.instanceCount; i++) {
        const m = a.instanceTransform;
        triad(m, i * 16 + 12, [m[i * 16 + 4] as number, m[i * 16 + 5] as number, m[i * 16 + 6] as number], [m[i * 16 + 8] as number, m[i * 16 + 9] as number, m[i * 16 + 10] as number], baseLen);
        const s = a.frameStart[i] as number;
        for (let f = s; f < s + (a.frameCount[i] as number); f++) {
          triad(a.position, f * 3, [a.direction[f * 3] as number, a.direction[f * 3 + 1] as number, a.direction[f * 3 + 2] as number], [a.up[f * 3] as number, a.up[f * 3 + 1] as number, a.up[f * 3 + 2] as number], baseLen * 0.6);
        }
      }
    }
    if (origin.length === 0) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(origin), 3));
    g.setAttribute('aOrigin', new BufferAttribute(new Float32Array(origin), 3));
    g.setAttribute('aDir', new BufferAttribute(new Float32Array(dir), 3));
    g.setAttribute('aEnd', new BufferAttribute(new Float32Array(end), 1));
    g.setAttribute('aPx', new BufferAttribute(new Float32Array(px), 1));
    g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
    this.lines = new LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 995;
    this.group.add(this.lines);
    this.frameCount = frames;
  }

  private clear(): void {
    if (this.lines) {
      this.group.remove(this.lines);
      this.lines.geometry.dispose();
      this.lines = null;
    }
    this.frameCount = 0;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
