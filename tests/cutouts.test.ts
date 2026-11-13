// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/viewport/viewport', async () => {
  const { Box3 } = await import('three');
  return {
    Viewport: class {
      camera = { fov: 35, position: { distanceTo: () => 1 } };
      scene = { add(): void {}, remove(): void {} };
      onFrame = null;
      addBeforeRender(): () => void {
        return () => undefined;
      }
      setAnimating(): void {}
      getBounds(): InstanceType<typeof Box3> {
        return new Box3();
      }
      setContent(): void {}
      setOptions(): void {}
      setSunDirection(): void {}
      setLighting(): void {}
      maxAnisotropy(): number {
        return 8;
      }
      setEnvironmentFile(): Promise<void> {
        return Promise.resolve();
      }
      frame(): void {}
      resetCamera(): void {}
      refreshContent(): void {}
      requestRender(): void {}
      dispose(): void {}
    },
  };
});

import { decodeProject, encodeProject } from '@/app/project/codec';
import { createProjectFile, defaultMeta } from '@/app/project/format';
import { buildLeafMesh, FULL_ATLAS, type LeafCard } from '@/geometry/leafMesher';
import {
  addAnchor,
  applyBrushStroke,
  applyTessellationSettings,
  buildCutoutGeometry,
  checkUvWarnings,
  clearOrFillPaintLayer,
  createDefaultCutoutMesh,
  createReferenceClusterCutout,
  generateCutoutOutline,
  linearizeStraighten,
  lodCounts,
  meshDataToObj,
  mirrorCutoutOutline,
  pointInTriangle,
  rebuildCutoutLods,
  resetAnchors,
  resetCutoutOutline,
  signedPolygonArea,
  triangulateCutout,
  triSignedArea,
  type Point2,
} from '@/materials/cutouts';
import { parseObj } from '@/geometry/meshImport';

describe('contour generation on synthetic masks', () => {
  it('traces a tight non-self-intersecting CCW polygon around a circular opaque mask', () => {
    const W = 64;
    const H = 64;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - 32;
        const dy = y - 32;
        if (dx * dx + dy * dy <= 18 * 18) {
          mask[y * W + x] = 255;
        }
      }
    }
    const outline = generateCutoutOutline(
      { width: W, height: H, data: mask, channels: 1 },
      { refineEdges: 0.3, opacityMargin: 0.1, opacityMarginEnabled: true, tessellation: 'Triangular' },
    );
    expect(outline.length).toBeGreaterThanOrEqual(5);
    expect(signedPolygonArea(outline)).toBeGreaterThan(0.05);
    for (const [u, v] of outline) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const warnings = checkUvWarnings({
      ...createDefaultCutoutMesh('c1', 'C1'),
      outline,
      interiorPoints: [],
    });
    expect(warnings.selfIntersectingEdges).toHaveLength(0);
    expect(warnings.outOfBoundsVertices).toHaveLength(0);
  });

  it('expands polygon area when opacityMargin is increased and respects Convex Hull mode', () => {
    const W = 64;
    const H = 64;
    const mask = new Uint8Array(W * H);
    for (let y = 20; y <= 44; y++) {
      for (let x = 24; x <= 40; x++) {
        mask[y * W + x] = 255;
      }
    }
    const tight = generateCutoutOutline(
      { width: W, height: H, data: mask, channels: 1 },
      { refineEdges: 0.4, opacityMargin: 0, opacityMarginEnabled: false },
    );
    const dilated = generateCutoutOutline(
      { width: W, height: H, data: mask, channels: 1 },
      { refineEdges: 0.4, opacityMargin: 0.8, opacityMarginEnabled: true },
    );
    expect(signedPolygonArea(dilated)).toBeGreaterThan(signedPolygonArea(tight));

    const hull = generateCutoutOutline(
      { width: W, height: H, data: mask, channels: 1 },
      { refineEdges: 0.2, tessellation: 'Convex Hull' },
    );
    expect(hull.length).toBeGreaterThanOrEqual(4);
    expect(signedPolygonArea(hull)).toBeGreaterThan(0);
  });
});

describe('triangulation validity (no overlaps or inversions)', () => {
  it('triangulates a concave L-shaped / star-like polygon with interior Steiner points without inversions', () => {
    const concaveOutline: Point2[] = [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.45],
      [0.55, 0.45],
      [0.85, 0.9],
      [0.45, 0.65],
      [0.15, 0.9],
      [0.3, 0.45],
    ];
    const interior: Point2[] = [
      [0.45, 0.3],
      [0.45, 0.5],
    ];
    const { vertices, indices } = triangulateCutout(concaveOutline, interior, 'Triangular');
    expect(vertices.length).toBe(concaveOutline.length + interior.length);
    expect(indices.length % 3).toBe(0);
    expect(indices.length / 3).toBeGreaterThanOrEqual(concaveOutline.length - 2);

    const polyArea = Math.abs(signedPolygonArea(concaveOutline));
    let sumTriArea = 0;

    const faces: [Point2, Point2, Point2][] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const a = vertices[indices[t] as number] as Point2;
      const b = vertices[indices[t + 1] as number] as Point2;
      const c = vertices[indices[t + 2] as number] as Point2;
      const area = triSignedArea(a, b, c);
      // Every triangle must have strictly positive CCW signed area (no inversion)
      expect(area).toBeGreaterThan(1e-7);
      sumTriArea += area;
      faces.push([a, b, c]);
    }

    // Total triangle area must match polygon area
    expect(sumTriArea).toBeCloseTo(polyArea, 4);

    // Centroids of each triangle must not lie strictly inside any other triangle (no overlaps)
    for (let i = 0; i < faces.length; i++) {
      const [a, b, c] = faces[i]!;
      const centroid: Point2 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
      for (let j = 0; j < faces.length; j++) {
        if (i === j) continue;
        const [p, q, r] = faces[j]!;
        expect(pointInTriangle(centroid, p, q, r)).toBe(false);
      }
    }
  });
});

describe('LOD simplification & decreasing vertex counts', () => {
  it('produces High >= Med >= Low vertex and face counts and supports step adjustments', () => {
    const cutout = createReferenceClusterCutout('ref1', 'Oak_English_Cluster_1', 'cluster', 2);
    const high = lodCounts(cutout.lods.high);
    const med = lodCounts(cutout.lods.med);
    const low = lodCounts(cutout.lods.low);

    // Expected counts (High V:8 F:7, Med V:7 F:6, Low V:5 F:3)
    expect(high).toEqual({ vertices: 8, faces: 7 });
    expect(med).toEqual({ vertices: 7, faces: 6 });
    expect(low).toEqual({ vertices: 5, faces: 3 });

    expect(high.vertices).toBeGreaterThanOrEqual(med.vertices);
    expect(med.vertices).toBeGreaterThanOrEqual(low.vertices);
    expect(low.vertices).toBeGreaterThanOrEqual(3);

    // Stepping Med further down reduces its vertex count
    cutout.lods.med.step += 1;
    rebuildCutoutLods(cutout);
    expect(lodCounts(cutout.lods.med).vertices).toBeLessThan(med.vertices);
  });
});

describe('mirror, straighten, anchors, paint & UV warnings', () => {
  it('mirrors an asymmetric outline symmetrically about the pivot vertical axis', () => {
    const cutout = createDefaultCutoutMesh('m1', 'Asym');
    cutout.pivot = [0.5, 0.05];
    cutout.outline = [
      [0.5, 0.05],
      [0.85, 0.4],
      [0.5, 0.95],
      [0.12, 0.7],
      [0.08, 0.3],
    ];
    cutout.interiorPoints = [[0.25, 0.5]];
    mirrorCutoutOutline(cutout, 0.5);

    expect(signedPolygonArea(cutout.outline)).toBeGreaterThan(0);
    // Every vertex [u, v] in the mirrored outline must have a matching symmetric counterpart [1 - u, v]
    for (const [u, v] of cutout.outline) {
      const mirroredU = 1 - u;
      const hasMatch = cutout.outline.some(
        ([ou, ov]) => Math.abs(ou - mirroredU) < 1e-4 && Math.abs(ov - v) < 1e-4,
      );
      expect(hasMatch).toBe(true);
    }
    // Interior point at u=0.25 must also have a twin at u=0.75
    expect(cutout.interiorPoints.some(([u, v]) => Math.abs(u - 0.75) < 1e-4 && Math.abs(v - 0.5) < 1e-4)).toBe(true);
  });

  it('detects out-of-bounds UV vertices, self-intersecting edges, and overlapping cutouts', () => {
    const a = createDefaultCutoutMesh('a', 'A', 'leaf');
    expect(checkUvWarnings(a).hasWarnings).toBe(false);

    // Push a vertex outside [0, 1]
    a.outline[1] = [1.18, 0.2];
    const report1 = checkUvWarnings(a);
    expect(report1.hasWarnings).toBe(true);
    expect(report1.outOfBoundsVertices).toContain(1);

    // Create a self-intersecting bowtie outline
    resetCutoutOutline(a);
    a.outline = [
      [0.1, 0.1],
      [0.9, 0.9],
      [0.9, 0.1],
      [0.1, 0.9],
    ];
    const report2 = checkUvWarnings(a);
    expect(report2.hasWarnings).toBe(true);
    expect(report2.selfIntersectingEdges.length).toBeGreaterThan(0);

    // Overlap with another mesh of the same material
    resetCutoutOutline(a);
    const b = createDefaultCutoutMesh('b', 'B', 'leaf');
    b.outline = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
    ];
    const report3 = checkUvWarnings(b, [a]);
    expect(report3.hasWarnings).toBe(true);
    expect(report3.overlappingVertices.length).toBe(4);
  });

  it('applies straighten linearization, anchors, and paint brush strokes', () => {
    const cutout = createReferenceClusterCutout('c', 'C', 'leaf', 2);
    cutout.straightenAxis = [
      [0.47, 0],
      [0.62, 0.5],
      [0.47, 1],
    ];
    linearizeStraighten(cutout);
    expect(cutout.straightenLinear).toBe(true);
    expect(cutout.straightenAxis).toEqual([
      [0.47, 0],
      [0.47, 1],
    ]);

    addAnchor(cutout, [0.5, 0.8]);
    expect(cutout.anchors).toHaveLength(3);
    resetAnchors(cutout);
    expect(cutout.anchors).toHaveLength(2);

    clearOrFillPaintLayer(cutout, 'mask', false);
    expect(cutout.paint.vertexMask.every((v) => v === 0)).toBe(true);
    applyBrushStroke(cutout, cutout.outline[0]!, 0.3, 0.2, 'mask', false);
    expect(cutout.paint.vertexMask[0]).toBeGreaterThan(0.8);

    applyBrushStroke(cutout, cutout.outline[0]!, 0.3, 0.2, 'section', false, { sectionId: 5 });
    expect(cutout.paint.vertexSection[0]).toBe(5);
  });
});

describe('runtime geometry builder, LeafCard integration & serialization round-trip', () => {
  it('builds MeshData with positions, UVs, wind weights, paint attributes, and valid OBJ export', () => {
    const cutout = createReferenceClusterCutout('cut1', 'Oak_Cutout', 'leaf', 2);
    cutout.settings.tessAmount = 0.4;
    applyTessellationSettings(cutout);

    const highMesh = buildCutoutGeometry(cutout, 'high');
    const lowMesh = buildCutoutGeometry(cutout, 'low');

    expect(highMesh.positions.length / 3).toBeGreaterThan(lowMesh.positions.length / 3);
    expect(highMesh.indices.length / 3).toBeGreaterThan(lowMesh.indices.length / 3);
    expect(highMesh.wind?.pivot.length).toBe(highMesh.positions.length);
    expect(highMesh.wind?.weights.length).toBe((highMesh.positions.length / 3) * 4);
    expect(highMesh.cutoutSection?.length).toBe(highMesh.positions.length / 3);
    expect(highMesh.cutoutMask?.length).toBe(highMesh.positions.length / 3);
    expect(highMesh.bendWeights?.length).toBe(highMesh.positions.length / 3);

    // Export to OBJ and re-parse
    const objText = meshDataToObj(highMesh, 'Oak_Cutout');
    const reparsed = parseObj(objText, 'leaf');
    expect(reparsed.positions.length).toBe(highMesh.positions.length);
    expect(reparsed.indices.length).toBe(highMesh.indices.length);
  });

  it('integrates with buildLeafMesh to replace quad cards with tight cutout polygons', () => {
    const cutout = createReferenceClusterCutout('cut_leaf', 'Leaf_Cutout', 'leaf', 2);
    const baseCard: LeafCard = {
      origin: [0, 0, 1],
      axis: [0, 1, 0],
      side: [1, 0, 0],
      length: 0.5,
      width: 0.3,
      bend: 0.3,
      fold: 0.1,
      curl: 0.05,
      twist: 0.1,
      segLength: 1,
      segWidth: 1,
      outline: 'rect',
      color: [0.3, 0.6, 0.2],
      ao: 0.9,
      atlas: FULL_ATLAS,
      materialId: 'leaf',
      pivot: [0, 0, 1],
      wind: [0.1, 0.2, 0.3, 0.4],
    };

    const quadMesh = buildLeafMesh([baseCard], { defaultMaterial: 'leaf' });
    const cutoutMesh = buildLeafMesh([{ ...baseCard, cutout, lod: 0 }], { defaultMaterial: 'leaf' });

    expect(quadMesh.positions.length / 3).toBe(4);
    expect(cutoutMesh.positions.length / 3).toBe(8);
    expect(cutoutMesh.indices.length / 3).toBe(7);
  });

  it('round-trips cutoutMeshes and uvAreas through ProjectFile encode/decode', () => {
    const meta = defaultMeta(42);
    const cutout = createReferenceClusterCutout('c_rt', 'Saved_Cutout', 'leaf', 2);
    meta.cutoutMeshes = [cutout];
    meta.uvAreas = [
      {
        id: 'uva_1',
        name: 'TopHalf',
        materialId: 'leaf',
        shape: 'rect',
        rect: [0, 0.5, 1, 1],
        pivot: [0.5, 0.5],
        usage: 'leaf',
        weight: 2,
      },
    ];
    const file = createProjectFile({ name: 'CutoutTree', graph: { nodes: [], edges: [] }, meta, seed: 42 });
    const bytes = encodeProject(file);
    const decoded = decodeProject(bytes);

    expect(decoded.cutoutMeshes).toHaveLength(1);
    expect(decoded.cutoutMeshes?.[0]?.name).toBe('Saved_Cutout');
    expect(decoded.cutoutMeshes?.[0]?.outline).toEqual(cutout.outline);
    expect(decoded.cutoutMeshes?.[0]?.lods.low.indices).toEqual(cutout.lods.low.indices);
    expect(decoded.uvAreas).toHaveLength(1);
    expect(decoded.uvAreas?.[0]?.name).toBe('TopHalf');
    expect(decoded.uvAreas?.[0]?.rect).toEqual([0, 0.5, 1, 1]);
  });

  it('mounts the Meshes panel and Edit Mesh dialog in jsdom and commits edits on Done', async () => {
    class RO {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy(
        {},
        {
          get: (_t, p) =>
            p === 'createImageData'
              ? (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
              : p === 'getImageData'
                ? (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
                : p === 'createRadialGradient'
                  ? () => ({ addColorStop: () => undefined })
                  : () => undefined,
        },
      )) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const { createMeshesPanel } = await import('@/ui/panels/meshesPanel');
    const { getMaterialLibrary } = await import('@/materials/library');
    const { openEditMeshDialog } = await import('@/ui/panels/dialogs/editMeshDialog');
    const { bootstrap } = await import('@/app/bootstrap');

    const root = document.createElement('div');
    document.body.append(root);
    const dispose = bootstrap(root);
    try {
      const lib = getMaterialLibrary();
      expect(lib.cutoutMeshes().length).toBeGreaterThanOrEqual(1);
      expect(lib.cutoutMeshes()[0]?.name).toBe('Needle_Cluster_1 Cutout');

      // Mount Meshes panel directly into a test container and verify Geometry, Transform, Wind direction, Scale cards
      const meshHost = document.createElement('div');
      const meshPanel = createMeshesPanel(meshHost);
      expect(meshHost.textContent).toContain('Geometry');
      expect(meshHost.textContent).toContain('Edit Mesh...');
      expect(meshHost.textContent).toContain('Transform');
      expect(meshHost.textContent).toContain('Wind direction');
      expect(meshHost.textContent).toContain('Scale');
      meshPanel.dispose?.();

      // Open Edit Mesh dialog for 'leaf' material
      const win = openEditMeshDialog({ materialId: 'leaf', materialName: 'Oak_English_Cluster_1 Spring' });
      expect(win.body.querySelector('.kt-em-toolbar')).not.toBeNull();
      expect(win.body.querySelector('.kt-em-vf')?.textContent).toContain('V:8');

      // Click Mirror tool button
      const mirrorBtn = Array.from(win.body.querySelectorAll('.kt-em-tool')).find((b) =>
        b.textContent?.includes('Mirror'),
      ) as HTMLButtonElement | undefined;
      expect(mirrorBtn).toBeDefined();
      mirrorBtn?.click();

      // Click Done button to commit to library
      const doneBtn = Array.from(win.body.querySelectorAll('.kt-em-btn')).find((b) =>
        b.textContent?.includes('Done'),
      ) as HTMLButtonElement | undefined;
      expect(doneBtn).toBeDefined();
      doneBtn?.click();

      expect(lib.cutoutsForMaterial('leaf').length).toBeGreaterThanOrEqual(1);
    } finally {
      dispose();
      root.remove();
    }
  });
});
