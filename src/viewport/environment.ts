import {
  Box3,
  CanvasTexture,
  CircleGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Shape,
  ShadowMaterial,
  ShapeGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { SHADOW_SIZES, type LightingSettings } from './lighting';

/** Procedural lighting, shadow-catcher ground, contact disc and 1.8 m human scale reference. No external assets. */
export interface Environment {
  group: Group;
  sun: DirectionalLight;
  setSunDirection(azimuth: number, elevation: number): void;
  setSunIntensity(value: number): void;
  applyLighting(s: LightingSettings): void;
  fit(bounds: Box3): void;
  setGroundVisible(v: boolean): void;
  setHumanVisible(v: boolean): void;
  faceCamera(azimuth: number): void;
  dispose(): void;
}

function discTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(30,30,10,0.55)');
  grad.addColorStop(0.7, 'rgba(30,30,10,0.35)');
  grad.addColorStop(1, 'rgba(30,30,10,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function humanGeometry(): ShapeGeometry {
  const body = new Shape();
  const pts: [number, number][] = [
    [-0.05, 1.5], [-0.22, 1.46], [-0.3, 0.82], [-0.24, 0.8], [-0.16, 1.12], [-0.17, 0],
    [-0.03, 0], [0, 0.85], [0.03, 0], [0.17, 0], [0.16, 1.12], [0.24, 0.8], [0.3, 0.82], [0.22, 1.46], [0.05, 1.5],
  ];
  pts.forEach(([x, y], i) => (i === 0 ? body.moveTo(x, y) : body.lineTo(x, y)));
  body.closePath();
  const head = new Shape();
  head.absarc(0, 1.64, 0.11, 0, Math.PI * 2, false);
  const geo = new ShapeGeometry([body, head]);
  geo.rotateX(Math.PI / 2); // stand the XY shape up into the XZ plane (Z-up)
  return geo;
}

export function createEnvironment(): Environment {
  const group = new Group();

  const hemi = new HemisphereLight(0xdfe8f5, 0x6b6a45, 1.15);
  hemi.position.set(0, 0, 50);
  hemi.up.set(0, 0, 1);
  group.add(hemi);

  const sun = new DirectionalLight(0xfff0dc, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  const cam = sun.shadow.camera;
  cam.left = -24;
  cam.right = 24;
  cam.top = 24;
  cam.bottom = -24;
  cam.near = 1;
  cam.far = 160;
  group.add(sun, sun.target);

  const shadowGeo = new PlaneGeometry(600, 600);
  // Ground decals (shadow catcher, contact disc, human, grid) never write depth and are ordered by renderOrder, so
  // they cannot z-fight each other; polygon offset (towards the camera, scales with depth precision) keeps them clear of
  // the tree base.
  const shadowMat = new ShadowMaterial({ opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const shadowCatcher = new Mesh(shadowGeo, shadowMat);
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 0;
  group.add(shadowCatcher);

  const discTex = discTexture();
  const discGeo = new CircleGeometry(1, 48);
  const discMat = new MeshBasicMaterial({ map: discTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const disc = new Mesh(discGeo, discMat);
  disc.position.z = 0;
  disc.renderOrder = 1;
  group.add(disc);

  const humanGeo = humanGeometry();
  const humanMat = new MeshBasicMaterial({ color: 0x1b1a12, transparent: true, opacity: 0.6, side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 });
  const human = new Mesh(humanGeo, humanMat);
  human.position.set(2.4, -0.4, 0);
  human.renderOrder = 2;
  group.add(human);

  const center = new Vector3(0, 0, 0);
  let shadowSize = 2048;
  let az = 0.9;
  let el = 0.95;
  const place = (): void => {
    const d = 70;
    sun.position.set(center.x + d * Math.cos(el) * Math.cos(az), center.y + d * Math.cos(el) * Math.sin(az), center.z + d * Math.sin(el));
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
  };
  place();

  return {
    group,
    sun,
    setSunDirection(azimuth, elevation) {
      az = azimuth;
      el = Math.min(1.5, Math.max(0.1, elevation));
      place();
    },
    setSunIntensity(v) {
      sun.intensity = v * 1.6;
      hemi.intensity = 0.55 + v * 0.4;
    },
    applyLighting(l) {
      sun.color.set(l.sunColor);
      sun.intensity = l.sunIntensity * 1.6;
      hemi.color.set(l.skyColor);
      hemi.groundColor.set(l.groundColor);
      hemi.intensity = (0.55 + l.sunIntensity * 0.4) * l.ambient;
      sun.shadow.radius = l.shadowSoftness;
      const size = SHADOW_SIZES[l.shadowQuality];
      sun.castShadow = size > 0;
      if (size > 0 && size !== shadowSize) {
        shadowSize = size;
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      az = l.sunAzimuth;
      el = Math.min(1.5, Math.max(0.1, l.sunElevation));
      place();
    },
    fit(bounds) {
      if (bounds.isEmpty()) return;
      const size = bounds.getSize(new Vector3());
      bounds.getCenter(center);
      center.z = bounds.min.z + size.z * 0.4;
      const r = Math.max(size.x, size.y, size.z) * 0.75 + 2;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.far = r * 6 + 40;
      cam.updateProjectionMatrix();
      const rad = Math.max(size.x, size.y) * 0.5 * 0.85;
      disc.scale.setScalar(Math.max(1, rad));
      human.position.set(rad + 1.2, -0.4, 0);
      place();
    },
    setGroundVisible(v) {
      shadowCatcher.visible = v;
      disc.visible = v;
    },
    setHumanVisible(v) {
      human.visible = v;
    },
    faceCamera(azimuth) {
      human.rotation.z = azimuth + Math.PI / 2;
    },
    dispose() {
      [shadowGeo, discGeo, humanGeo].forEach((g) => g.dispose());
      [shadowMat, discMat, humanMat].forEach((m) => m.dispose());
      discTex.dispose();
      sun.shadow.map?.dispose();
    },
  };
}
