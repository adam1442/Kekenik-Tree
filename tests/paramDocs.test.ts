import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ParamDef } from '@/contracts/params';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { STRUCTURE_TABS, TREE_TABS } from '@/ui/panels/properties/inspectorState';

beforeAll(() => registerDiscoveredNodes());

const fmt = (v: unknown): string => {
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (v && typeof v === 'object') return 'curve';
  return String(v);
};

function range(d: ParamDef): string {
  switch (d.kind) {
    case 'float':
    case 'int': {
      const hard = `${d.min ?? '-∞'}..${d.max ?? '∞'}`;
      const soft = d.softMax !== undefined || d.softMin !== undefined ? ` (slider ${d.softMin ?? d.min ?? 0}..${d.softMax ?? d.max})` : '';
      return hard + soft + (d.unit ? ` ${d.unit}` : '');
    }
    case 'enum':
      return d.options.map((o) => o.label).join(' / ');
    case 'range':
      return `${d.min}..${d.max}`;
    default:
      return d.kind;
  }
}

function table(type: string): string {
  const def = getNodeDef(type);
  if (!def) throw new Error(type);
  const tabs = type === 'output.tree' ? TREE_TABS : STRUCTURE_TABS;
  const lines: string[] = [`## ${def.label} (\`${type}\`)`, '', def.description ?? '', ''];
  for (const tab of tabs) {
    if (tab.id === 'All') continue;
    const defs = def.params.filter((p) => p.group === tab.id);
    lines.push(`### Tab: ${tab.label}${defs.length === 0 ? ' _(not implemented yet - shown disabled)_' : ''}`, '');
    if (defs.length === 0) continue;
    lines.push('| Section | Parameter | id | Range | Default | Var | Curve | Meaning |', '|---|---|---|---|---|---|---|---|');
    for (const p of defs) {
      const meaning = (p.tooltip ?? '').replace(/\|/g, '/');
      lines.push(`| ${p.subgroup ?? ''} | ${p.label} | \`${p.id}\` | ${range(p)} | ${fmt(p.default)} | ${p.variance ? 'yes' : ''} | ${p.curveAllowed ? 'yes' : ''} | ${meaning} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const LEAF_NOTES = [
  '### Leaves tab - how the pieces fit together',
  '',
  'Existing Leaf tabs (Generation, Skin, Forces, Orientation, Material, Lighting, Wind, Post) are unchanged. The *Leaves* tab adds placement and orientation:',
  '',
  '* **Frame.** A leaf has local X = across the blade, Y = growth (base to tip), Z = face (`X × Y`). Angles are shown in degrees; the 0..1 values are blend amounts.',
  '* **Order.** The Orientation tab builds the starting pose (angle to parent, facing, droop, roll). Then, in this order: 3D anchor style, Unification, Sky influence, Fold, Align, Face, Sensitivity → Parent (Amount, then Sky), and last the Final adjustments (Up, Right, Out as one group, rotating about the original local axes).',
  '* **3D anchor style.** *Match parent* uses the parent\'s own frame (incl. twist) for the outward direction; *Legacy* uses a world-up based frame (use it for leaves on leaves).',
  '* **Anchors** (Unification, Sensitivity → Parent). Chain = base positions of the ancestors, highest first, ending with the parent: *Global* = first entry (where the highest ancestor meets the ground), *Deep* = second entry, *Intermediate* = middle entry, *Local* = the parent\'s base, *None* = off. Chains travel with the structure (`StructureData.lineage`, published by Trunk / Branch / Root / Spine / Split / Knot / Leaf); without it the chain only holds the parent.',
  '* **Unification** turns the leaf axis fully to the direction anchor → attachment point, replacing the Orientation-tab angle; Fold, Align and the rest then adjust it.',
  '* **Size.** The card / mesh is a unit mesh of Width × Height; Size scales it, *+% of parent* adds that share of the parent branch length to Size. *Use actual size* ignores both and uses the cutout mesh at its authored size (cards keep Width × Height).',
  '* **Weld** moves the base from the parent\'s spine onto its skin (radius at the attachment, in the leaf\'s outward direction). Parents thinner than 1.5 mm (leaves, fronds) have no skin: the weld fails and *Keep failed welds* decides whether the leaf stays on the spine or is dropped.',
  '* **Cross** adds a copy of every card turned 90° about the leaf axis at the same position.',
  '* **Flip / Initial orientation.** Flip mirrors a random half of the leaves across local Y. With Flip off, *Classic* mirrors leaves on the left side of the parent; *Synchronized* (default, identical to older projects) never mirrors. The side (±1) comes from this node\'s Interval / Phyllotaxy placement (alternating per slot), else from the parent\'s `side` skeleton attribute (written by Branch placed with Interval / Phyllotaxy), else it is random per leaf. Mirrored leaves get reversed winding; *Fix winding* flips triangles that disagree with their normals after all deformation.',
  '* **Back-compat.** The former Skin › Size *Scale* is now Leaves › *Size* (`leafSize`, migrated on load); the *Type* list (`leafTypes`) moved from Material › Leaves to Leaves › Type. Every new parameter defaults to a neutral value.',
  '',
].join('\n');

function leafTab(): string {
  const def = getNodeDef('generator.leaf');
  if (!def) throw new Error('generator.leaf');
  const lines: string[] = [`## ${def.label} (\`generator.leaf\`) - Leaves tab`, '', '| Section | Parameter | id | Range | Default | Var | Curve | Meaning |', '|---|---|---|---|---|---|---|---|'];
  for (const p of def.params.filter((d) => d.group === 'Leaves')) {
    const meaning = (p.tooltip ?? '').replace(/\|/g, '/');
    const shown = p.kind === 'list' ? 'rows of Material / Mesh / Weight' : range(p);
    lines.push(`| ${p.subgroup ?? ''} | ${p.label} | \`${p.id}\` | ${shown} | ${p.kind === 'list' ? 'one row' : fmt(p.default)} | ${p.variance ? 'yes' : ''} | ${p.curveAllowed ? 'yes' : ''} | ${meaning} |`);
  }
  lines.push('');
  return lines.join('\n') + '\n' + LEAF_NOTES;
}

describe('PARAMETERS.md', () => {
  it('lists every tab / section / parameter of Tree, Trunk, Branch and Spine', () => {
    const header = [
      '# Parameters',
      '',
      'Generated from the node registry by `WRITE_PARAM_DOCS=1 npx vitest run tests/paramDocs.test.ts` - do not edit by hand.',
      '',
      '* **Var** = the row has the "%" variance toggle (blue variance field). **Curve** = a curve may drive the value along the parent / spine (green mini-curve).',
      '* Values typed in the number field are accepted up to the hard max; the slider only covers the soft range.',
      '* Counts above `warnAbove` (1000 for `Number`) show a yellow "!" performance badge next to the label.',
      '* Curves on a parameter are evaluated along the *parent* (0 = base, 1 = tip) for placement params, and along the *spine* for shape params.',
      '',
    ].join('\n');
    const doc = [header, ...['output.tree', 'generator.trunk', 'generator.branch', 'generator.spine'].map(table), leafTab()].join('\n');
    expect(doc).toContain('Tree placement');
    expect(doc).toContain('Sensitivity → Parent');
    if (process.env.WRITE_PARAM_DOCS) writeFileSync('docs/PARAMETERS.md', doc);
  });
});
