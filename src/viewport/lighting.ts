import {
  BackSide,
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  LinearFilter,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

/** Lighting / environment settings of the viewport (Lighting panel). */
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high' | 'ultra';
export type ToneMappingName = 'ACES' | 'AgX' | 'Neutral' | 'Linear' | 'None';

export interface LightingSettings {
  sunAzimuth: number;
  sunElevation: number;
  sunColor: string;
  sunIntensity: number;
  skyColor: string;
  horizonColor: string;
  groundColor: string;
  /** Hemisphere (ambient) light multiplier. */
  ambient: number;
  /** Image based lighting strength (procedural gradient or imported HDR). */
  envIntensity: number;
  shadowQuality: ShadowQuality;
  /** PCF kernel radius of the sun shadow (texels, 0 = hard). */
  shadowSoftness: number;
  /** Strength of the sun glow / disc in the image-based lighting and haze (0..2). */
  sunGlow: number;
  /** Colour the fog towards the horizon colour instead of the mid background colour. */
  fogFollowsHorizon: boolean;
  exposure: number;
  toneMapping: ToneMappingName;
  fog: boolean;
  fogDensity: number;
  bgTop: string;
  bgMid: string;
  bgBottom: string;
}

export const SHADOW_SIZES: Record<ShadowQuality, number> = { off: 0, low: 512, medium: 1024, high: 2048, ultra: 4096 };

const DAY: LightingSettings = {
  sunAzimuth: 0.9,
  sunElevation: 0.95,
  sunColor: '#fff0dc',
  sunIntensity: 1.5,
  skyColor: '#dfe8f5',
  horizonColor: '#c9cfd6',
  groundColor: '#6b6a45',
  ambient: 0.6,
  envIntensity: 0.5,
  shadowQuality: 'high',
  shadowSoftness: 2.5,
  sunGlow: 1,
  fogFollowsHorizon: false,
  exposure: 0.95,
  toneMapping: 'ACES',
  fog: true,
  fogDensity: 0.004,
  bgTop: '#c4c6c8',
  bgMid: '#a9aaa5',
  bgBottom: '#7a7c4c',
};

export const LIGHTING_PRESETS: Record<string, LightingSettings> = {
  Day: DAY,
  'Golden Hour': { ...DAY, sunAzimuth: 1.4, sunElevation: 0.32, sunColor: '#ffc78a', sunIntensity: 2.1, skyColor: '#a9c2e6', horizonColor: '#f3c9a0', groundColor: '#5a4a2e', ambient: 0.5, envIntensity: 0.55, exposure: 0.9, shadowSoftness: 3, sunGlow: 1.3, bgTop: '#8fa6c8', bgMid: '#e0bd9a', bgBottom: '#6b5a3a', fogDensity: 0.005 },
  Overcast: { ...DAY, sunIntensity: 0.55, sunColor: '#e6ebf2', skyColor: '#d4d9df', horizonColor: '#c4c9cf', ambient: 0.9, envIntensity: 0.8, exposure: 1.05, shadowSoftness: 6, sunGlow: 0.2, bgTop: '#b9bcc0', bgMid: '#a6a9ac', bgBottom: '#868a7a', fogDensity: 0.007 },
  'Foggy Morning': { ...DAY, sunAzimuth: 0.4, sunElevation: 0.35, sunColor: '#fff1d8', sunIntensity: 0.9, skyColor: '#d9dfe3', horizonColor: '#e3e5e2', groundColor: '#6f7358', ambient: 0.8, envIntensity: 0.7, exposure: 1.0, shadowSoftness: 5, sunGlow: 0.8, fogDensity: 0.016, fogFollowsHorizon: true, bgTop: '#d0d4d6', bgMid: '#dcdedb', bgBottom: '#a5a98d' },
  Sunset: { ...DAY, sunAzimuth: 2.3, sunElevation: 0.22, sunColor: '#ffb26b', sunIntensity: 1.9, skyColor: '#f2b88c', horizonColor: '#f0905a', groundColor: '#4d3a2c', ambient: 0.45, envIntensity: 0.45, sunGlow: 1.5, bgTop: '#7f8fb8', bgMid: '#d9a27c', bgBottom: '#6a5440', fogDensity: 0.006 },
  Moonlight: { ...DAY, sunAzimuth: 3.6, sunElevation: 0.7, sunColor: '#9db6ff', sunIntensity: 0.38, skyColor: '#1d2a4a', horizonColor: '#33436a', groundColor: '#10151f', ambient: 0.55, envIntensity: 0.5, exposure: 1.35, shadowSoftness: 3, sunGlow: 0.3, bgTop: '#0c1224', bgMid: '#1b2742', bgBottom: '#0d1219', fogDensity: 0.006 },
  Studio: { ...DAY, sunAzimuth: 0.6, sunElevation: 1.0, sunColor: '#ffffff', sunIntensity: 1.2, skyColor: '#ffffff', horizonColor: '#e8e8e8', groundColor: '#7a7a7a', ambient: 0.8, envIntensity: 0.9, fog: false, shadowSoftness: 4, sunGlow: 0.4, bgTop: '#5b5b5b', bgMid: '#4a4a4a', bgBottom: '#383838' },
};

const STORAGE_KEY = 'kekenik.lighting.v1';

function load(): LightingSettings {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DAY, ...(JSON.parse(raw) as Partial<LightingSettings>) };
  } catch {
    /* ignore corrupted storage */
  }
  return { ...DAY };
}

let current: LightingSettings = load();
const listeners = new Set<(s: LightingSettings) => void>();

export const getLighting = (): LightingSettings => current;

export function setLighting(patch: Partial<LightingSettings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage may be unavailable */
  }
  listeners.forEach((l) => l(current));
}

export function applyLightingPreset(name: string): void {
  const p = LIGHTING_PRESETS[name];
  if (p) setLighting({ ...p });
}

export function onLightingChange(fn: (s: LightingSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Procedural sky / horizon / ground gradient converted to a PMREM environment (caller owns the returned texture). */
export function buildGradientEnvironment(renderer: WebGLRenderer, sky: string, horizon: string, ground: string, sunColor = '#ffffff', sunDir: [number, number, number] = [0.5, 0.5, 0.7], glow = 1): Texture {
  const scene = new Scene();
  const geo = new SphereGeometry(10, 32, 16);
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      uSky: { value: new Color(sky) },
      uHorizon: { value: new Color(horizon) },
      uGround: { value: new Color(ground) },
      uSun: { value: new Color(sunColor) },
      uSunDir: { value: sunDir },
      uGlow: { value: glow },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vDir; uniform vec3 uSky; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSun; uniform vec3 uSunDir; uniform float uGlow;
      void main(){
        vec3 d = normalize(vDir);
        float z = d.z;
        float cs = max(dot(d, normalize(uSunDir)), 0.0);
        // Sky: horizon -> zenith, with a haze band that hugs the horizon.
        vec3 sky = mix(uHorizon, uSky, pow(clamp(z, 0.0, 1.0), 0.5));
        sky = mix(sky, uHorizon * 1.04, exp(-abs(z) * 7.0) * 0.55);
        // Ground bounce: sunlit ground colour fades in below the horizon.
        vec3 ground = mix(uHorizon * 0.85, uGround, smoothstep(0.0, 0.45, -z));
        vec3 c = z >= 0.0 ? sky : ground;
        // Mie forward scattering around the sun + glow + disc.
        float mie = pow(cs, 4.0) * 0.12 + pow(cs, 24.0) * 0.35 + pow(cs, 220.0) * 2.0;
        float disc = smoothstep(0.9995, 0.99985, cs) * 18.0;
        c += uSun * (mie + disc) * uGlow * (z >= -0.05 ? 1.0 : 0.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new Mesh(geo, mat));
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  geo.dispose();
  mat.dispose();
  return target.texture;
}

/** Decode a user HDR (.hdr) or OpenEXR (.exr) file into a PMREM environment (caller owns the returned texture). */
export async function buildEnvironmentFromFile(renderer: WebGLRenderer, file: File): Promise<Texture> {
  const buf = await file.arrayBuffer();
  const isExr = /\.exr$/i.test(file.name);
  const parsed = isExr ? new EXRLoader().parse(buf) : new RGBELoader().parse(buf);
  const tex = new DataTexture(parsed.data, parsed.width, parsed.height, 'format' in parsed ? parsed.format : undefined, parsed.type);
  tex.mapping = EquirectangularReflectionMapping;
  tex.magFilter = tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  const pmrem = new PMREMGenerator(renderer);
  const out = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return out;
}
