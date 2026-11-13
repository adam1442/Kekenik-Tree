import { Color, Mesh, PlaneGeometry, ShaderMaterial, SRGBColorSpace, Vector3 } from 'three';
import { AXIS_ALPHA, AXIS_WIDTH_PX, GRID_FIRST_EXPONENT, GRID_LEVELS, MAJOR_ALPHA, MAJOR_WIDTH_PX, MINOR_ALPHA, MINOR_WIDTH_PX, effectiveFadeEnd } from './quality/gridMath';
import { gridCellMeters, type QualitySettings } from './quality/qualitySettings';

/**
 * Analytic ground grid (Z-up, plane z = 0), evaluated per pixel in the fragment shader.
 *
 * Every line is a distance-to-line test in *screen pixels* (world distance divided by the screen-space gradient of the
 * coordinate), so lines keep a constant 1 / 1.5 / 2 px width and an anti-aliased edge at any distance and viewing
 * angle - including the two axis lines towards the horizon. Grid levels (cell * 10^-2 .. 10^3) are cross-faded by their
 * on-screen spacing, which removes moire and merging lines; the whole grid fades with distance and at grazing angles.
 * GLSL helpers mirror the pure functions in `quality/gridMath.ts`.
 */
const VERTEX = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vPos = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vPos;
  uniform vec3 uCam;
  uniform float uCell;
  uniform float uFadeEnd;
  uniform float uShowAxes;
  uniform vec3 uColor;
  uniform vec3 uAxisX;
  uniform vec3 uAxisY;

  const float MINOR_ALPHA = ${MINOR_ALPHA.toFixed(3)};
  const float MAJOR_ALPHA = ${MAJOR_ALPHA.toFixed(3)};
  const float AXIS_ALPHA = ${AXIS_ALPHA.toFixed(3)};
  const float MINOR_W = ${MINOR_WIDTH_PX.toFixed(2)};
  const float MAJOR_W = ${MAJOR_WIDTH_PX.toFixed(2)};
  const float AXIS_W = ${AXIS_WIDTH_PX.toFixed(2)};

  float spacingWeight(float px) { return smoothstep(5.0, 20.0, px); }
  float lineCoverage(float distPx, float widthPx) { return clamp(widthPx * 0.5 + 0.5 - distPx, 0.0, 1.0); }
  // World units per screen pixel measured along the gradient of a world coordinate.
  float unitsPerPixel(float c) { return max(length(vec2(dFdx(c), dFdy(c))), 1e-6); }

  void main() {
    float gx = unitsPerPixel(vPos.x); // lines of constant x
    float gy = unitsPerPixel(vPos.y); // lines of constant y

    float a = 0.0;
    float finerX = 0.0;
    float finerY = 0.0;
    for (int i = 0; i < ${GRID_LEVELS}; i++) {
      float s = uCell * pow(10.0, float(i) + (${GRID_FIRST_EXPONENT}.0));
      float wx = spacingWeight(s / gx);
      float wy = spacingWeight(s / gy);
      if (wx > 0.0) {
        float d = abs(fract(vPos.x / s + 0.5) - 0.5) * s / gx;
        a = max(a, lineCoverage(d, mix(MINOR_W, MAJOR_W, finerX)) * wx * mix(MINOR_ALPHA, MAJOR_ALPHA, finerX));
      }
      if (wy > 0.0) {
        float d = abs(fract(vPos.y / s + 0.5) - 0.5) * s / gy;
        a = max(a, lineCoverage(d, mix(MINOR_W, MAJOR_W, finerY)) * wy * mix(MINOR_ALPHA, MAJOR_ALPHA, finerY));
      }
      finerX = wx;
      finerY = wy;
    }

    float covX = lineCoverage(abs(vPos.y) / gy, AXIS_W); // X axis lies on y = 0
    float covY = lineCoverage(abs(vPos.x) / gx, AXIS_W); // Y axis lies on x = 0
    float axisA = max(covX, covY) * AXIS_ALPHA * uShowAxes;

    vec3 toCam = uCam - vPos;
    float dist = length(toCam);
    float fade = 1.0 - smoothstep(uFadeEnd * 0.2, uFadeEnd, dist);
    float graze = smoothstep(0.015, 0.2, abs(toCam.z) / max(dist, 1e-4));

    vec3 col = uColor;
    if (axisA > a) {
      a = axisA;
      col = covX >= covY ? uAxisX : uAxisY;
    }
    a *= fade * graze;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export class Grid {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;

  constructor() {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Pull the grid slightly towards the camera in depth-buffer units so it never z-fights with the tree base.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      uniforms: {
        uCam: { value: new Vector3() },
        uCell: { value: 1 },
        uFadeEnd: { value: 420 },
        uShowAxes: { value: 1 },
        uColor: { value: new Color(0x1d1d1d) },
        uAxisX: { value: new Color().setRGB(0.85, 0.28, 0.22, SRGBColorSpace) },
        uAxisY: { value: new Color().setRGB(0.35, 0.72, 0.25, SRGBColorSpace) },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), material);
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
  }

  /** Re-centre the quad under the camera (infinite look) and push the user settings into the shader. */
  update(camera: Vector3, q: QualitySettings, cameraDistance: number): void {
    const u = this.mesh.material.uniforms;
    const fadeEnd = effectiveFadeEnd(q.gridFadeDistance, cameraDistance);
    (u.uCam?.value as Vector3).copy(camera);
    if (u.uCell) u.uCell.value = gridCellMeters(q);
    if (u.uFadeEnd) u.uFadeEnd.value = fadeEnd;
    if (u.uShowAxes) u.uShowAxes.value = q.showGridAxes ? 1 : 0;
    this.mesh.position.set(camera.x, camera.y, 0);
    this.mesh.scale.setScalar(fadeEnd * 2.4);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
