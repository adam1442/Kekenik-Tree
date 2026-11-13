import type { NodeOutputs } from '@/contracts/nodes';
import type { NodeMessage } from '@/contracts/engine';

export interface CacheEntry {
  key: string;
  nodeId: string;
  outputs: NodeOutputs;
  /** Set when evaluate() threw: errors are cached too (the function is deterministic, retrying is pointless). */
  error?: string;
  messages: NodeMessage[];
  ms: number;
  triangles: number;
  instances: number;
  branches?: number;
  points?: number;
  bytes: number;
}

/** Estimated heap size of the typed arrays held by `outputs`. */
export function estimateBytes(outputs: NodeOutputs): number {
  let total = 256;
  for (const v of Object.values(outputs)) {
    if (v.kind === 'Structure') {
      const s = v.value.skeleton;
      total += s.position.byteLength + s.radius.byteLength + s.direction.byteLength + s.tangent.byteLength + s.generation.byteLength + s.parent.byteLength + s.branchId.byteLength + s.t.byteLength + s.age.byteLength + s.branches.length * 64;
      for (const attr of s.attributes.values()) total += attr.byteLength;
    } else if (v.kind === 'Mesh') {
      const m = v.value;
      total += m.positions.byteLength + m.normals.byteLength + m.uv0.byteLength + m.indices.byteLength + (m.colors?.byteLength ?? 0) + (m.tangents?.byteLength ?? 0) + (m.uv1?.byteLength ?? 0);
    } else total += 64;
  }
  return total;
}

/** Content-addressed LRU cache of node results, bounded by an estimated byte budget. */
export class EvalCache {
  private readonly map = new Map<string, CacheEntry>();
  private bytes = 0;
  hits = 0;
  misses = 0;

  constructor(private readonly maxBytes = 384 * 1024 * 1024) {}

  get(key: string): CacheEntry | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(entry: CacheEntry): void {
    const old = this.map.get(entry.key);
    if (old) {
      this.bytes -= old.bytes;
      this.map.delete(entry.key);
    }
    this.map.set(entry.key, entry);
    this.bytes += entry.bytes;
    // Evict least-recently-used entries, but never the one just inserted.
    for (const [k, e] of this.map) {
      if (this.bytes <= this.maxBytes || k === entry.key) break;
      this.map.delete(k);
      this.bytes -= e.bytes;
    }
  }

  /** Drop entries of nodes that no longer exist. */
  retainNodes(ids: ReadonlySet<string>): void {
    for (const [k, e] of this.map) {
      if (!ids.has(e.nodeId)) {
        this.map.delete(k);
        this.bytes -= e.bytes;
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get byteSize(): number {
    return this.bytes;
  }
}
