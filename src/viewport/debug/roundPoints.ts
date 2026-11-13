import { ShaderMaterial, type IUniform } from 'three';

/**
 * Round, constant-pixel-size points. `PointsMaterial` draws squares and (with size attenuation) vanishes with distance;
 * here `gl_PointSize` is a pixel value times the renderer pixel ratio, so the size is identical at any zoom, resolution
 * scale or supersampling level. All materials created here share one pixel-ratio uniform.
 */
const pixelRatio: IUniform<number> = { value: 1 };

export function setPointPixelRatio(ratio: number): void {
  pixelRatio.value = Math.max(0.25, ratio);
}

export interface RoundPointOptions {
  size: number;
  vertexColors?: boolean;
  color?: number;
  /** Draw through geometry (selection / debug on top). */
  depthTest?: boolean;
}

export function createRoundPointMaterial(o: RoundPointOptions): ShaderMaterial {
  const vc = o.vertexColors === true;
  const m = new ShaderMaterial({
    uniforms: { uSize: { value: o.size }, uRatio: pixelRatio, uColor: { value: [((o.color ?? 0xffffff) >> 16 & 255) / 255, ((o.color ?? 0xffffff) >> 8 & 255) / 255, ((o.color ?? 0xffffff) & 255) / 255] } },
    vertexShader: `uniform float uSize; uniform float uRatio; ${vc ? 'attribute vec3 color; varying vec3 vCol;' : ''}
      void main() { ${vc ? 'vCol = color;' : ''} gl_PointSize = uSize * uRatio; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uColor; ${vc ? 'varying vec3 vCol;' : ''}
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        vec3 c = ${vc ? 'vCol' : 'uColor'};
        float rim = smoothstep(0.38, 0.5, r);
        gl_FragColor = vec4(mix(c, c * 0.35, rim), 1.0);
      }`,
    depthTest: o.depthTest !== false,
    depthWrite: false,
    transparent: false,
  });
  return m;
}

export function setPointSize(m: ShaderMaterial, size: number): void {
  (m.uniforms.uSize as IUniform<number>).value = size;
}
