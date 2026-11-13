import type { NodeOutputs } from '@/contracts/nodes';
import type { PortValue } from '@/contracts/ports';

/** Deterministic, order-independent serialisation of plain data (object keys sorted). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** Two independent 32-bit FNV-1a style streams -> 16 hex chars (collision odds are negligible for cache keys). */
export class Hasher {
  private a = 0x811c9dc5;
  private b = 0x9747b28c;

  byte(v: number): void {
    this.a = Math.imul(this.a ^ v, 0x01000193);
    this.b = Math.imul(this.b + v + 0x9e3779b9, 0x85ebca6b) ^ (this.b >>> 13);
  }

  string(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c & 0xff);
      this.byte(c >>> 8);
    }
    this.byte(0xff);
  }

  typed(arr: ArrayBufferView): void {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < bytes.length; i++) this.byte(bytes[i] as number);
    this.byte(0xfe);
  }

  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}

export function hashString(s: string): string {
  const h = new Hasher();
  h.string(s);
  return h.hex();
}

/** Content hash of a port value (typed-array bytes included). Used by tests and the determinism checker. */
export function hashPortValue(v: PortValue): string {
  const h = new Hasher();
  h.string(v.kind);
  switch (v.kind) {
    case 'Structure': {
      const s = v.value.skeleton;
      h.typed(s.position);
      h.typed(s.radius);
      h.typed(s.parent);
      h.typed(s.branchId);
      h.string(stableStringify(s.branches));
      if (v.value.placement) h.string(stableStringify(v.value.placement));
      break;
    }
    case 'Mesh': {
      const m = v.value;
      h.typed(m.positions);
      h.typed(m.normals);
      h.typed(m.uv0);
      h.typed(m.indices);
      if (m.colors) h.typed(m.colors);
      h.string(stableStringify(m.slots));
      break;
    }
    default:
      h.string(stableStringify(v.value));
  }
  return h.hex();
}

export function hashOutputs(outputs: NodeOutputs): string {
  const h = new Hasher();
  for (const key of Object.keys(outputs).sort()) {
    h.string(key);
    const v = outputs[key];
    if (v) h.string(hashPortValue(v));
  }
  return h.hex();
}
