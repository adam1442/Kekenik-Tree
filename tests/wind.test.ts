import { describe, expect, it } from 'vitest';
import type { WindSettings } from '@/contracts/material';
import { defaultWindSettings } from '@/contracts/material';
import { meshTriangleCount } from '@/contracts/mesh';
import { buildTubeMesh } from '@/geometry/tubeMesher';
import { attachSkeletonWind } from '@/geometry/windAttributes';
import { SkeletonBuilder } from '@/contracts/skeleton';
import { describeWindRuntime, validateWindAttributes, WIND_VERTEX_LAYOUT } from '@/viewport/wind/windExport';
import { clampWindParams, defaultWindParams, windParamsFromSettings, writeWindParam, WIND_PARAM_RANGES } from '@/viewport/wind/windParams';
import { WIND_GLSL_APPLY, WIND_GLSL_DECLARATIONS, WIND_GLSL_FUNCTION } from '@/viewport/wind/windShader';
import { WindSystem } from '@/viewport/wind/windSystem';
import { nodeDefs as windNodes } from '@/nodes/wind';
import { defaultParams } from '@/contracts/params';
import { tubeOptionsFromParams } from '@/nodes/generators/common';

function tree() {
  const b = new SkeletonBuilder();
  b.beginBranch(-1, -1, 0);
  for (let i = 0; i < 10; i++) b.addPoint(0, 0, i * 0.5, 0.12 * (1 - i / 12));
  b.endBranch();
  b.beginBranch(0, 5, 1);
  for (let i = 0; i < 6; i++) b.addPoint(i * 0.3, 0, 2.5 + i * 0.15, 0.03);
  b.endBranch();
  return b.build();
}

describe('wind parameters', () => {
  it('round-trips through the persisted WindSettings contract', () => {
    const s: WindSettings = defaultWindSettings();
    writeWindParam(s, 'strength', 2.5);
    writeWindParam(s, 'turbulence', 0.7);
    writeWindParam(s, 'gustStrength', 0.9);
    const p = windParamsFromSettings(s);
    expect(p.strength).toBe(2.5);
    expect(p.turbulence).toBe(0.7);
    expect(p.gustStrength).toBe(0.9);
  });

  it('clamps extreme and non-finite values', () => {
    const p = clampWindParams({ ...defaultWindParams(), strength: 1e9, damping: -5, ripple: NaN, directionDeg: Infinity });
    for (const r of WIND_PARAM_RANGES) {
      expect(p[r.key]).toBeGreaterThanOrEqual(r.min);
      expect(p[r.key]).toBeLessThanOrEqual(r.max);
    }
  });

  it('Wind node evaluates to full settings', async () => {
    const def = windNodes[0]!;
    const out = await def.evaluate({} as never, {}, defaultParams(def.params));
    const v = out.out;
    expect(v?.kind).toBe('Wind');
    if (v?.kind === 'Wind') expect(windParamsFromSettings(v.value).branchResponse).toBe(1);
  });
});

describe('wind vertex data', () => {
  it('generated tube meshes carry valid wind attributes in 0..1', () => {
    const sk = tree();
    attachSkeletonWind(sk, null, 7);
    const mesh = buildTubeMesh(sk, tubeOptionsFromParams(defaultParams([]), 0, null, 'bark', 7));
    expect(meshTriangleCount(mesh)).toBeGreaterThan(0);
    expect(mesh.wind).toBeDefined();
    expect(validateWindAttributes(mesh)).toEqual({ ok: true, issues: [] });
    expect(mesh.wind!.weights.length).toBe((mesh.positions.length / 3) * 4);
  });

  it('flags out-of-range weights', () => {
    const sk = tree();
    attachSkeletonWind(sk, null, 1);
    const mesh = buildTubeMesh(sk, tubeOptionsFromParams(defaultParams([]), 0, null, 'bark', 1));
    mesh.wind!.weights[2] = 3;
    expect(validateWindAttributes(mesh).ok).toBe(false);
  });
});

describe('wind runtime description', () => {
  it('documents layout, uniforms and reference shader', () => {
    const d = describeWindRuntime(defaultWindParams(), 12);
    expect(d.uniforms.map((u) => u.name)).toEqual(['uWindA', 'uWindB', 'uWindC', 'uWindD', 'uWindMesh']);
    expect(d.vertexLayout).toBe(WIND_VERTEX_LAYOUT);
    for (const u of d.uniforms) expect(WIND_GLSL_DECLARATIONS).toContain(`uniform vec4 ${u.name}`);
    expect(WIND_GLSL_FUNCTION).toContain('ktWindLocal');
    expect(WIND_GLSL_APPLY).toContain('ktWindLocal(');
  });
});

describe('WindSystem', () => {
  it('advances the clock only while playing and enabled, and drives uniforms', () => {
    const w = new WindSystem();
    let tick: ((dt: number) => void) | null = null;
    const host = {
      setAnimating: () => undefined,
      requestRender: () => undefined,
      addBeforeRender: (fn: (dt: number) => void) => {
        tick = fn;
        return () => undefined;
      },
    };
    w.bind(host);
    const s = defaultWindSettings();
    s.enabled = true;
    s.strength = 2;
    s.directionDeg = 90;
    w.syncProject(s);
    tick!(0.5);
    expect(w.state.clock).toBeCloseTo(0.5, 5);
    expect(w.uniforms.a.value.z).toBe(2);
    expect(w.uniforms.a.value.y).toBeCloseTo(1, 5);
    w.patchState({ playing: false });
    tick!(0.5);
    expect(w.state.clock).toBeCloseTo(0.5, 5);
    w.scrub(3);
    expect(w.uniforms.d.value.y).toBe(3);
    s.enabled = false;
    w.syncProject(s);
    expect(w.uniforms.a.value.z).toBe(0);
  });
});
