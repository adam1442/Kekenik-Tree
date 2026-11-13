import {
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { CancellationSource } from '@/contracts/nodes';
import type { SceneModel } from '@/contracts/engine';
import type { ProjectFile } from '@/contracts/project';
import { IndexedDbKeyValueStore, type KeyValueStore } from '@/app/project/kvStore';
import { GraphModel } from '@/graph/model/graphModel';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { meshDataToGeometry } from '@/viewport/meshDataToGeometry';
import type { PresetEntry } from './types';

export const THUMB_SIZE = 128;

/** Inline SVG shown while a thumbnail renders or when WebGL is unavailable. */
export const PLACEHOLDER_THUMB =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#4a4a4a"/><circle cx="64" cy="50" r="28" fill="#5d7f4a"/><rect x="60" y="70" width="8" height="38" fill="#7a5a3c"/></svg>',
  );

type MaterialColors = Map<string, Color>;

function materialColors(project: ProjectFile): MaterialColors {
  const out: MaterialColors = new Map();
  for (const m of project.materials) {
    const v = m.variations[1];
    out.set(m.id, new Color(v[0], v[1], v[2]));
  }
  return out;
}

/** Orthographic side view of an evaluated scene (Z-up) rendered into an offscreen canvas. Returns a PNG data URL. */
export function renderSceneThumbnail(renderer: WebGLRenderer, scene: SceneModel, colors: MaterialColors, size = THUMB_SIZE): string {
  const three = new Scene();
  const disposables: { dispose(): void }[] = [];
  const mats = new Map<string, Material>();
  const materialFor = (id: string): Material => {
    let m = mats.get(id);
    if (!m) {
      m = new MeshStandardMaterial({ color: colors.get(id) ?? new Color(0.35, 0.5, 0.25), roughness: 0.85, metalness: 0, side: DoubleSide });
      mats.set(id, m);
      disposables.push(m);
    }
    return m;
  };
  for (const e of scene.entries) {
    if (e.mesh.indices.length === 0) continue;
    const geo: BufferGeometry = meshDataToGeometry(e.mesh);
    disposables.push(geo);
    geo.clearGroups();
    const ids: string[] = [];
    for (const slot of e.mesh.slots) {
      ids.push(slot.materialId);
      geo.addGroup(slot.indexStart, slot.indexCount, ids.length - 1);
    }
    const material = ids.length > 0 ? ids.map(materialFor) : materialFor('');
    const inst = e.mesh.instanced;
    if (inst) {
      const im = new InstancedMesh(geo, material, inst.count);
      im.instanceMatrix.array.set(inst.matrices);
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      three.add(im);
    } else {
      const mesh = new Mesh(geo, material);
      mesh.frustumCulled = false;
      three.add(mesh);
    }
  }
  const box = new Box3();
  for (const e of scene.entries) {
    const p = e.mesh.positions;
    const inst = e.mesh.instanced;
    const tmp = new Vector3();
    const m4 = new Matrix4();
    const stride = Math.max(1, Math.floor(p.length / 3 / 400));
    for (let k = 0; k < (inst?.count ?? 1); k += inst ? Math.max(1, Math.floor(inst.count / 300)) : 1) {
      if (inst) m4.fromArray(inst.matrices, k * 16);
      for (let i = 0; i < p.length / 3; i += stride) {
        tmp.set(p[i * 3] as number, p[i * 3 + 1] as number, p[i * 3 + 2] as number);
        if (inst) tmp.applyMatrix4(m4);
        box.expandByPoint(tmp);
      }
    }
  }
  if (box.isEmpty()) box.set(new Vector3(-1, -1, 0), new Vector3(1, 1, 2));
  const center = box.getCenter(new Vector3());
  const dims = box.getSize(new Vector3());
  const half = Math.max(dims.z, Math.max(dims.x, dims.y), 0.1) * 0.58;
  const cam = new OrthographicCamera(-half, half, half, -half, 0.01, 1000);
  cam.up.set(0, 0, 1);
  const dir = new Vector3(0.35, -1, 0.18).normalize();
  cam.position.copy(center).addScaledVector(dir, 200);
  cam.lookAt(center.x, center.y, center.z - (dims.z > dims.x ? 0 : 0));
  const key = new DirectionalLight(0xffffff, 2.4);
  key.position.set(-0.6, -0.8, 1.2);
  three.add(key, new AmbientLight(0xbfd0e6, 1.1));
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x4a4a4a, 1);
  renderer.render(three, cam);
  const url = renderer.domElement.toDataURL('image/png');
  disposables.forEach((d) => d.dispose());
  three.clear();
  return url;
}

interface CacheRecord {
  rev: string;
  url: string;
}

const isCacheRecord = (v: unknown): v is CacheRecord => typeof v === 'object' && v !== null && typeof (v as CacheRecord).rev === 'string' && typeof (v as CacheRecord).url === 'string';

/**
 * Renders preset thumbnails one at a time from the real graph (evaluated at LOD 1 for speed) and caches the PNGs in
 * IndexedDB keyed by preset id + revision. One WebGL context is shared and released when the queue drains.
 */
export class ThumbnailService {
  private renderer: WebGLRenderer | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly memory = new Map<string, string>();

  constructor(private readonly kv: KeyValueStore = new IndexedDbKeyValueStore()) {}

  /** Cached or freshly rendered thumbnail (never rejects: falls back to the placeholder). */
  get(entry: PresetEntry): Promise<string> {
    const memKey = `${entry.id}:${entry.revision}`;
    const hit = this.memory.get(memKey);
    if (hit) return Promise.resolve(hit);
    this.pending++;
    const job = this.chain.then(async () => {
      try {
        const cached = await this.kv.get(`thumb:${entry.id}`);
        if (isCacheRecord(cached) && cached.rev === entry.revision) return cached.url;
        const url = await this.render(entry);
        await this.kv.set(`thumb:${entry.id}`, { rev: entry.revision, url } satisfies CacheRecord);
        return url;
      } catch {
        return PLACEHOLDER_THUMB;
      }
    });
    this.chain = job.then(() => undefined);
    return job.then((url) => {
      if (url !== PLACEHOLDER_THUMB) this.memory.set(memKey, url);
      if (--this.pending === 0) this.releaseRenderer();
      return url;
    });
  }

  private async render(entry: PresetEntry): Promise<string> {
    const project = await entry.load();
    const model = GraphModel.fromJSON(project.graph);
    const result = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: project.settings.seed, lod: 1, token: new CancellationSource().token, budgetMs: 30 });
    if (!this.renderer) {
      const canvas = document.createElement('canvas');
      this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(1);
    }
    return renderSceneThumbnail(this.renderer, result.scene, materialColors(project));
  }

  private releaseRenderer(): void {
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }

  /** Drop a stored thumbnail (preset deleted / replaced). */
  async forget(id: string): Promise<void> {
    await this.kv.delete(`thumb:${id}`);
  }
}

let service: ThumbnailService | null = null;
export function getThumbnailService(): ThumbnailService {
  service ??= new ThumbnailService();
  return service;
}
