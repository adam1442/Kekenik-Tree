import type { InstanceKey } from './types';

/** 32-bit FNV-1a over a list of strings / integers. Deterministic and platform independent. */
export function hashParts(...parts: readonly (string | number)[]): number {
  let h = 0x811c9dc5;
  const feed = (code: number): void => {
    h ^= code & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  for (const part of parts) {
    const s = typeof part === 'number' ? `#${Math.trunc(part)}` : `s${part}`;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      feed(c);
      if (c > 0xff) feed(c >> 8);
    }
    feed(0x1f);
  }
  return h >>> 0;
}

/**
 * Stable key of an instance: independent of any parameter value, so an unrelated edit (length, gravity...) keeps all
 * keys. It only changes when the generator, the parent instance or the placement slot changes.
 * `subSeed` separates the sub-levels of a Branch node (level index) or other independent streams.
 */
export function instanceKey(nodeId: string, parentKey: InstanceKey, indexInParent: number, subSeed = 0): InstanceKey {
  return hashParts(nodeId, parentKey, indexInParent, subSeed);
}
