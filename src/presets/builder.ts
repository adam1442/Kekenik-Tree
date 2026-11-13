import type { ParamValue } from '@/contracts/params';
import type { AssetEntry, ProjectFile } from '@/contracts/project';
import type { MaterialDef } from '@/contracts/material';
import { createProjectFile, defaultMeta } from '@/app/project/format';
import { GraphModel } from '@/graph/model/graphModel';
import { H_SPACING, tidyTreeLayout } from '@/graph/model/layout';
import { defaultMaterials } from '@/materials/library';
import { bytesToBase64, fnvHash } from '@/textures/bytes';
import { encodePng, makeTexture } from './procTextures';
import type { MaterialSpec, NodeSpec, SpeciesDef } from './types';

/** Build a graph from a flat spec list. The node registry must be populated by the caller (`registerDiscoveredNodes`). */
export function buildSpeciesGraph(specs: readonly NodeSpec[]): GraphModel {
  const model = new GraphModel();
  for (const s of specs) {
    const node = model.addNode({ id: s.id, type: s.type, ...(s.name ? { name: s.name } : {}) });
    for (const [pid, raw] of Object.entries(s.params ?? {})) {
      const cur = node.params[pid];
      if (!cur) throw new Error(`Unknown parameter ${s.type}.${pid}`);
      const isObj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'value' in raw;
      node.params[pid] = isObj ? { ...cur, ...(raw as { value: ParamValue; variance?: number }) } : { ...cur, value: raw as ParamValue };
    }
  }
  for (const s of specs) {
    if (!s.parent) continue;
    const pair = model.findPortPair(s.parent, s.id, 'hierarchy');
    if (!pair) throw new Error(`Cannot connect ${s.parent} -> ${s.id}`);
    model.insertEdge(model.makeEdge(pair.from, pair.to, `e-${s.parent}-${s.id}`));
  }
  const links = specs.filter((s) => s.parent).map((s) => ({ parent: s.parent as string, child: s.id }));
  for (const [id, p] of tidyTreeLayout(specs.map((s) => ({ id: s.id, x: 0, y: 0 })), links, H_SPACING)) model.patchNode(id, { x: p.x, y: p.y });
  return model;
}

const rgba = (c: readonly [number, number, number]): [number, number, number, number] => [c[0], c[1], c[2], 1];

function hueShift(c: readonly [number, number, number], k: readonly [number, number, number]): [number, number, number, number] {
  return [Math.min(1, c[0] * k[0]), Math.min(1, c[1] * k[1]), Math.min(1, c[2] * k[2]), 1];
}

/** Material + embedded placeholder colour map for one slot of a species. */
function buildMaterial(base: MaterialDef, spec: MaterialSpec, speciesId: string, seed: number): { material: MaterialDef; asset: AssetEntry } {
  const png = encodePng(makeTexture(spec.texture, spec.color, seed));
  const asset: AssetEntry = { id: `preset-${speciesId}-${spec.id}`, kind: 'image', name: `${spec.name} (placeholder).png`, mime: 'image/png', data: bytesToBase64(png), hash: fnvHash(png) };
  const material: MaterialDef = structuredClone(base);
  material.name = spec.name;
  material.twoSided = spec.twoSided ?? material.twoSided;
  material.slots.color = { color: [1, 1, 1, 1], texture: { assetId: asset.id } };
  material.slots.gloss = { scalar: spec.gloss ?? 0.1 };
  material.variations = [hueShift(spec.color, [1.12, 1.05, 0.85]), rgba(spec.color), hueShift(spec.color, [0.85, 1.0, 1.12])];
  material.variationAmount = spec.variation ?? 0;
  return { material, asset };
}

/** Evaluate-ready `ProjectFile` of a built-in species (graph + materials + embedded placeholder maps). */
export function buildSpeciesProject(def: SpeciesDef): ProjectFile {
  const model = buildSpeciesGraph(def.nodes);
  const windId = 'wind';
  model.addNode({ id: windId, type: 'wind.settings', name: 'Wind', x: 0, y: 0 });
  for (const [pid, value] of Object.entries(def.wind)) {
    const node = model.getNode(windId);
    const cur = node?.params[pid];
    if (node && cur) node.params[pid] = { ...cur, value };
  }
  const pair = model.findPortPair(windId, 'tree', 'attachment');
  if (pair) model.insertEdge(model.makeEdge(pair.from, pair.to, `a-${windId}-tree`));

  const meta = defaultMeta(def.seed);
  const library = defaultMaterials();
  const assets: AssetEntry[] = [];
  const materials = library.map((m) => {
    const spec = def.materials.find((s) => s.id === m.id);
    if (!spec) return m;
    const built = buildMaterial(m, spec, def.id, def.seed + (spec.id === 'bark' ? 1 : 2));
    assets.push(built.asset);
    return built.material;
  });
  return createProjectFile({ name: def.name, graph: model.toJSON(), meta: { ...meta, materials, assets }, seed: def.seed });
}
