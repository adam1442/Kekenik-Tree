import type { MaterialDef } from '@/contracts/material';
import type { NodeDef } from '@/contracts/nodes';
import { getBool, getNumber, getString, type RGBA } from '@/contracts/params';
import { PORT } from '@/graph/ports';
import { section } from '../shared/builders';
import { attachOut } from '../shared/ports';

/** Parameter layout mirrors the Materials panel "Settings" tab: Main / Variations / Back / Atlas / Other. */
const main = section('Settings', 'Main');
const vars = section('Settings', 'Variations');
const back = section('Settings', 'Back');
const atlas = section('Settings', 'Atlas');
const other = section('Settings', 'Other');
const colorOf = (v: unknown, fallback: RGBA): RGBA => (Array.isArray(v) && v.length === 4 ? (v as RGBA) : fallback);

/** `Default / Cutout / Mesh / Force out` (stored lower-case) -> contract value. */
export function atlasHandlingOf(v: string): MaterialDef['atlas']['handling'] {
  const k = v.toLowerCase();
  return k === 'cutout' ? 'cutout' : k === 'mesh' ? 'mesh' : k.startsWith('force') ? 'forceOut' : 'default';
}

export const nodeDefs: NodeDef[] = [
  {
    type: 'material.standard',
    category: 'material',
    label: 'Material',
    icon: 'nodeMaterial',
    color: 'var(--kt-node-material)',
    description: 'Surface material.',
    ports: [attachOut('Material')],
    params: [
      main.bool('twoSided', 'Two-sided', false),
      main.float('season', 'Season', 0, { min: 0, max: 1, curve: true }),
      vars.color('variation1', 'Variation 1', [0.3, 0.38, 0.05, 1]),
      vars.color('variation2', 'Variation 2', [0.57, 0.74, 0.28, 1]),
      vars.color('variation3', 'Variation 3', [0.43, 0.55, 0.43, 1]),
      vars.float('variationAmount', 'Amount', 0.5, { min: 0, max: 1 }),
      back.string('backMaterial', 'Material', ''),
      back.float('backSpacing', 'Spacing', 0.001, { min: 0, max: 1, step: 0.001 }),
      atlas.float('atlasScale', 'Scale', 1, { min: 0.01, max: 100 }),
      atlas.enumOf('atlasHandling', 'Handling', 'Default', ['Default', 'Cutout', 'Mesh', 'Force out'], { tooltip: 'How the material takes part in atlases. Default / Cutout / Mesh: as before. Force out: the material is never cut apart or repacked: no V-tiling remap, no lightmap re-unwrap (its UVs are exported untouched).' }),
      atlas.float('unwrapScale', 'Unwrap scale', 1, { min: 0.01, max: 100, tooltip: 'Lightmap unwrap scale of the pieces that use this material (Tree > Lightmap): 2 = twice the texel density of the others.' }),
      atlas.string('atlasName', 'Name', ''),
      other.enumOf('maxRes', 'Max res.', 'None', ['None', '256', '512', '1024', '2048', '4096']),
      other.string('userData', 'User data', ''),
    ],
    evaluate: (ctx, _inputs, p) => {
      const mat: MaterialDef = {
        id: ctx.nodeId,
        name: ctx.name,
        meshes: [],
        twoSided: getBool(p, 'twoSided'),
        season: null,
        variations: [colorOf(p.variation1?.value, [1, 1, 1, 1]), colorOf(p.variation2?.value, [1, 1, 1, 1]), colorOf(p.variation3?.value, [1, 1, 1, 1])],
        variationAmount: getNumber(p, 'variationAmount', 0.5),
        slots: {},
        atlas: { scale: getNumber(p, 'atlasScale', 1), handling: atlasHandlingOf(getString(p, 'atlasHandling', 'default')), name: getString(p, 'atlasName'), unwrapScale: getNumber(p, 'unwrapScale', 1) },
        maxResolution: getString(p, 'maxRes', 'none') === 'none' ? null : Number(getString(p, 'maxRes')),
        backMaterialId: getString(p, 'backMaterial') || null,
        backSpacing: getNumber(p, 'backSpacing', 0.001),
        userData: getString(p, 'userData'),
      };
      return { [PORT.out]: { kind: 'Material', value: mat } };
    },
  },
];
