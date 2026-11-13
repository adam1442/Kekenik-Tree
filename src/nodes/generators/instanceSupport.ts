import type { NodeParams } from '@/contracts/params';
import type { InstanceHandle } from '@/instances/scope';
import { overrideSignature } from '@/instances/overrides';

/**
 * Per-instance spine configuration: a plain `compile(params)` of the instance's overridden params, cached by the
 * override's param signature so that many instances sharing one override compile once.
 */
export function createInstanceConfigResolver<C>(base: C, compile: (params: NodeParams) => C): (h: InstanceHandle) => C {
  const cache = new Map<string, C>();
  return (h) => {
    const o = h.override;
    if (!o || Object.keys(o.params).length === 0) return base;
    const sig = overrideSignature({ ...o, transform: undefined });
    let cfg = cache.get(sig);
    if (!cfg) {
      cfg = compile(h.params);
      cache.set(sig, cfg);
    }
    return cfg;
  };
}

