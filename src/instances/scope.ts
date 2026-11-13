import type { NodeParams } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { hashParts, instanceKey } from './keys';
import { applyParamOverrides, readOverrides } from './overrides';
import { FLAG_HIDDEN, type InstanceKey, type InstanceOverride, type InstanceTable } from './types';

/** The two counters of a skeleton builder that the scope needs (StructureSkeletonBuilder satisfies it). */
export interface BuilderCounters {
  readonly branchCount: number;
  readonly pointCount: number;
}

export interface SpawnArgs {
  /** Branch id in the PARENT skeleton (for sub-levels of a Branch node: in the previous level), -1 for roots. */
  parentBranch: number;
  /** Placement slot among the children of that parent. */
  index: number;
  /** Sub-level inside a multi-generation Branch node (0 = grows on the node's parent input). */
  level?: number;
  /** Procedural position along the parent (0..1) before overrides. */
  baseU?: number;
}

/** What a generator needs to know about the instance it is about to grow. */
export interface InstanceHandle {
  readonly key: InstanceKey;
  readonly parentKey: InstanceKey;
  readonly index: number;
  readonly level: number;
  readonly parentRow: number;
  readonly parentBranch: number;
  readonly baseU: number;
  readonly override: InstanceOverride | null;
  readonly pruned: boolean;
  readonly hidden: boolean;
  /** Node params with the instance's param overrides applied (same object when there are none). */
  readonly params: NodeParams;
  readonly positionOffset: number;
  readonly rotationOffsetRad: number;
  readonly rollOffsetDeg: number;
  readonly lengthScale: number;
  readonly radiusScale: number;
  branchStart: number;
  pointStart: number;
}

interface Record_ {
  handle: InstanceHandle;
  branchCount: number;
  pointCount: number;
}

const DEG = Math.PI / 180;

/**
 * Per-evaluation bookkeeping of the instances a generator spawns: derives stable keys, looks up overrides and records
 * the compact `InstanceTable`. Pure (no three.js, no DOM). One scope per `evaluate()` call.
 */
export class InstanceScope {
  private readonly overrides = new Map<number, InstanceOverride>();
  private readonly records: Record_[] = [];
  private readonly prunedKeys: number[] = [];
  /** level -> (branch id inside that level) -> record row. */
  private readonly levelBranchRow = new Map<number, Map<number, number>>();
  private readonly paramsCache = new Map<string, NodeParams>();

  constructor(
    readonly nodeId: string,
    private readonly params: NodeParams,
    private readonly parentTable: InstanceTable | null = null,
  ) {
    for (const o of readOverrides(params)) this.overrides.set(o.key, o);
  }

  get hasOverrides(): boolean {
    return this.overrides.size > 0;
  }

  /** Derive the instance's key and resolve its override. Call right before growing it. */
  spawn(args: SpawnArgs, builder: BuilderCounters): InstanceHandle {
    const level = args.level ?? 0;
    let parentRow = -1;
    let parentKey = 0;
    if (level > 0) {
      parentRow = this.levelBranchRow.get(level - 1)?.get(args.parentBranch) ?? -1;
      parentKey = parentRow >= 0 ? ((this.records[parentRow] as Record_).handle.key as number) : hashParts('lvl', level, args.parentBranch);
    } else if (args.parentBranch >= 0) {
      const t = this.parentTable;
      parentRow = t ? (t.branchToInstance[args.parentBranch] ?? -1) : -1;
      parentKey = t && parentRow >= 0 ? (t.key[parentRow] as number) : hashParts('branch', args.parentBranch);
    }
    const key = instanceKey(this.nodeId, parentKey, args.index, level);
    const override = this.overrides.get(key) ?? null;
    const t = override?.transform;
    let params = this.params;
    if (override && Object.keys(override.params).length > 0) {
      const sig = JSON.stringify(override.params);
      let cached = this.paramsCache.get(sig);
      if (!cached) {
        cached = applyParamOverrides(this.params, override.params);
        this.paramsCache.set(sig, cached);
      }
      params = cached;
    }
    const handle: InstanceHandle = {
      key,
      parentKey,
      index: args.index,
      level,
      parentRow,
      parentBranch: args.parentBranch,
      baseU: args.baseU ?? 0,
      override,
      pruned: override?.pruned === true,
      hidden: override?.hidden === true,
      params,
      positionOffset: t?.positionAlongParent ?? 0,
      rotationOffsetRad: (t?.rotation ?? 0) * DEG,
      rollOffsetDeg: t?.roll ?? 0,
      lengthScale: t?.lengthScale ?? 1,
      radiusScale: t?.radiusScale ?? 1,
      branchStart: builder.branchCount,
      pointStart: builder.pointCount,
    };
    if (handle.pruned) this.prunedKeys.push(key);
    return handle;
  }

  /** Record the branches / points the instance produced (call after growing it; skip for pruned instances). */
  finish(handle: InstanceHandle, builder: BuilderCounters): void {
    const branchCount = builder.branchCount - handle.branchStart;
    if (branchCount <= 0) return;
    const row = this.records.length;
    this.records.push({ handle, branchCount, pointCount: builder.pointCount - handle.pointStart });
    let map = this.levelBranchRow.get(handle.level);
    if (!map) {
      map = new Map();
      this.levelBranchRow.set(handle.level, map);
    }
    for (let b = 0; b < branchCount; b++) map.set(handle.branchStart + b, row);
  }

  /**
   * Build the table. For multi-level Branch nodes pass the per-level skeleton sizes: levels are concatenated in order,
   * so branch / point indices of level L are offset by the sizes of the levels before it.
   */
  table(levels?: readonly { branches: number; points: number }[]): InstanceTable {
    const n = this.records.length;
    const branchOff: number[] = [0];
    const pointOff: number[] = [0];
    for (const l of levels ?? []) {
      branchOff.push((branchOff[branchOff.length - 1] as number) + l.branches);
      pointOff.push((pointOff[pointOff.length - 1] as number) + l.points);
    }
    const table: InstanceTable = {
      nodeId: this.nodeId,
      count: n,
      key: new Uint32Array(n),
      parentKey: new Uint32Array(n),
      index: new Int32Array(n),
      parentInstance: new Int32Array(n),
      parentBranch: new Int32Array(n),
      branchStart: new Int32Array(n),
      branchCount: new Int32Array(n),
      pointStart: new Int32Array(n),
      pointCount: new Int32Array(n),
      baseU: new Float32Array(n),
      flags: new Uint8Array(n),
      bounds: new Float32Array(n * 6),
      branchToInstance: new Int32Array(0),
      pruned: Uint32Array.from(this.prunedKeys),
    };
    let totalBranches = 0;
    for (let i = 0; i < n; i++) {
      const r = this.records[i] as Record_;
      const h = r.handle;
      table.key[i] = h.key;
      table.parentKey[i] = h.parentKey;
      table.index[i] = h.index;
      table.parentInstance[i] = h.parentRow;
      table.parentBranch[i] = h.parentBranch;
      table.branchStart[i] = h.branchStart + (branchOff[h.level] ?? 0);
      table.branchCount[i] = r.branchCount;
      table.pointStart[i] = h.pointStart + (pointOff[h.level] ?? 0);
      table.pointCount[i] = r.pointCount;
      table.baseU[i] = h.baseU;
      table.flags[i] = h.hidden ? FLAG_HIDDEN : 0;
      totalBranches = Math.max(totalBranches, (table.branchStart[i] as number) + r.branchCount);
    }
    const map = new Int32Array(totalBranches).fill(-1);
    for (let i = 0; i < n; i++) {
      const s = table.branchStart[i] as number;
      for (let b = 0; b < (table.branchCount[i] as number); b++) map[s + b] = i;
    }
    return { ...table, branchToInstance: map };
  }
}

/** Fill `table.bounds` (padded by the point radii) from the final skeleton. */
export function fillTableBounds(table: InstanceTable, sk: Skeleton): void {
  for (let i = 0; i < table.count; i++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    const s = table.pointStart[i] as number;
    const e = Math.min(sk.count, s + (table.pointCount[i] as number));
    for (let p = s; p < e; p++) {
      const r = sk.radius[p] as number;
      const x = sk.position[p * 3] as number;
      const y = sk.position[p * 3 + 1] as number;
      const z = sk.position[p * 3 + 2] as number;
      if (x - r < x0) x0 = x - r;
      if (y - r < y0) y0 = y - r;
      if (z - r < z0) z0 = z - r;
      if (x + r > x1) x1 = x + r;
      if (y + r > y1) y1 = y + r;
      if (z + r > z1) z1 = z + r;
    }
    if (x0 === Infinity) x0 = y0 = z0 = x1 = y1 = z1 = 0;
    table.bounds.set([x0, y0, z0, x1, y1, z1], i * 6);
  }
}
