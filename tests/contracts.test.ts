import { describe, expect, it } from 'vitest';
import { evaluateCurve, flatCurve, linearPoint, type Curve } from '@/contracts/curve';
import { emptyMeshData, mergeMeshData, meshTriangleCount, type MeshData } from '@/contracts/mesh';
import {
  clampParam,
  defaultParams,
  evalCondition,
  getNumber,
  type NodeParams,
  type ParamDef,
} from '@/contracts/params';
import { migrateProject, PROJECT_VERSION } from '@/contracts/project';
import { SkeletonBuilder } from '@/contracts/skeleton';
import { registerNode, getNodeDef, listNodeDefs, unregisterNode } from '@/graph/registry';
import { formatShortcut, matchesShortcut, parseShortcut } from '@/app/shortcuts';

const defs: ParamDef[] = [
  { id: 'number', kind: 'int', label: 'Number', group: 'Generation', default: 3, min: 0, max: 10, variance: { default: 0.1 }, curveAllowed: true },
  { id: 'mode', kind: 'enum', label: 'Mode', group: 'Generation', default: 'absolute', options: [{ value: 'absolute', label: 'Absolute' }, { value: 'relative', label: 'Relative' }] },
  { id: 'spacing', kind: 'float', label: 'Spacing', group: 'Generation', default: 1, visibleIf: { param: 'mode', value: 'relative' } },
];

describe('params', () => {
  it('builds default states incl. variance and curve slots', () => {
    const p = defaultParams(defs);
    expect(p.number).toEqual({ value: 3, variance: 0.1, curve: null });
    expect(getNumber(p, 'spacing')).toBe(1);
  });

  it('evaluates visibility conditions', () => {
    const p: NodeParams = defaultParams(defs);
    expect(evalCondition(defs[2]?.visibleIf, p)).toBe(false);
    (p.mode as { value: string }).value = 'relative';
    expect(evalCondition(defs[2]?.visibleIf, p)).toBe(true);
    expect(evalCondition({ any: [{ param: 'mode', value: 'x' }, { param: 'mode', op: 'in', value: ['relative'] }] }, p)).toBe(true);
  });

  it('clamps and rounds ints', () => {
    expect(clampParam(defs[0] as ParamDef, 12.4)).toBe(10);
    expect(clampParam(defs[0] as ParamDef, 2.6)).toBe(3);
  });
});

describe('curve', () => {
  it('interpolates linearly and clamps', () => {
    const c: Curve = { points: [linearPoint(0, 0), linearPoint(1, 2)], xRange: [0, 1], yRange: [0, 2], wrap: 'clamp' };
    expect(evaluateCurve(c, 0.5)).toBeCloseTo(1);
    expect(evaluateCurve(c, -1)).toBe(0);
    expect(evaluateCurve(c, 5)).toBe(2);
    expect(evaluateCurve(flatCurve(0.3), 0.7)).toBeCloseTo(0.3);
  });

  it('loops', () => {
    const c: Curve = { points: [linearPoint(0, 0), linearPoint(1, 1)], xRange: [0, 1], yRange: [0, 1], wrap: 'loop' };
    expect(evaluateCurve(c, 1.25)).toBeCloseTo(0.25);
  });
});

describe('skeleton builder', () => {
  it('builds SoA buffers with parent links, t and branch lengths', () => {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    sb.addPoint(0, 0, 0, 0.3);
    sb.addPoint(0, 0, 1, 0.2);
    const top = sb.addPoint(0, 0, 2, 0.1);
    sb.endBranch();
    sb.beginBranch(0, top - 1, 1);
    sb.addPoint(0, 0, 1, 0.05);
    sb.addPoint(1, 0, 1, 0.02);
    sb.endBranch();
    const sk = sb.build();
    expect(sk.count).toBe(5);
    expect(sk.branches).toHaveLength(2);
    expect(sk.branches[0]?.length).toBeCloseTo(2);
    expect(sk.t[2]).toBeCloseTo(1);
    expect(sk.parent[0]).toBe(-1);
    expect(sk.parent[1]).toBe(0);
    expect(sk.parent[3]).toBe(1); // first point of branch 1 connects to parent point
    expect(sk.generation[4]).toBe(1);
    expect(sk.direction[2 * 3 + 2]).toBeCloseTo(1);
  });

  it('requires begin/end pairing', () => {
    const sb = new SkeletonBuilder();
    expect(() => sb.addPoint(0, 0, 0, 1)).toThrow();
    sb.beginBranch(-1, -1, 0);
    expect(() => sb.beginBranch(-1, -1, 0)).toThrow();
  });
});

describe('mesh data', () => {
  const quad = (): MeshData => ({
    positions: new Float32Array(12),
    normals: new Float32Array(12),
    uv0: new Float32Array(8),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    slots: [{ materialId: 'a', indexStart: 0, indexCount: 6 }],
  });

  it('merges with index/slot offsets and drops partial channels', () => {
    const a = quad();
    const b = { ...quad(), colors: new Float32Array(16) };
    const m = mergeMeshData([a, b]);
    expect(meshTriangleCount(m)).toBe(4);
    expect(m.indices[6]).toBe(4);
    expect(m.slots[1]?.indexStart).toBe(6);
    expect(m.colors).toBeUndefined();
    expect(mergeMeshData([])).toEqual(emptyMeshData());
  });
});

describe('project file', () => {
  it('migrates valid files and rejects newer/invalid ones', () => {
    const file = { version: 1, name: 'x', graph: { nodes: [], edges: [] }, settings: {}, materials: [], forces: [], assets: [] };
    expect(migrateProject(file).version).toBe(PROJECT_VERSION);
    expect(() => migrateProject({ ...file, version: PROJECT_VERSION + 1 })).toThrow();
    expect(() => migrateProject('nope')).toThrow();
  });
});

describe('node registry', () => {
  it('registers, lists and rejects duplicates / duplicate ports', () => {
    registerNode({ type: 'test.node', category: 'utility', label: 'T', icon: 'stub', color: 'red', ports: [], params: [], evaluate: () => ({}) });
    expect(getNodeDef('test.node')?.label).toBe('T');
    expect(listNodeDefs('utility').length).toBeGreaterThan(0);
    expect(() => registerNode({ type: 'test.node', category: 'utility', label: 'T', icon: 'stub', color: 'red', ports: [], params: [], evaluate: () => ({}) })).toThrow();
    const port = { id: 'p', label: 'P', kind: 'Scalar' as const, direction: 'in' as const, edge: 'hierarchy' as const };
    expect(() => registerNode({ type: 'test.dup', category: 'utility', label: 'D', icon: 'stub', color: 'red', ports: [port, port], params: [], evaluate: () => ({}) })).toThrow();
    unregisterNode('test.node');
  });
});

describe('shortcuts', () => {
  it('parses, matches and formats', () => {
    const s = parseShortcut('Mod+Shift+Z');
    expect(matchesShortcut({ key: 'Z', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, s)).toBe(true);
    expect(matchesShortcut({ key: 'z', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false }, s)).toBe(false);
    expect(matchesShortcut({ key: ' ', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false }, parseShortcut('Shift+Space'))).toBe(true);
    expect(formatShortcut('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(formatShortcut('Mod+Shift+Z', true)).toBe('⇧⌘Z');
    expect(formatShortcut('Home', false)).toBe('Home');
  });
});
