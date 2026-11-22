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

const DEFORM_NOTES = [
  '### Deformation and Resolution tabs - how the pieces fit together',
  '',
  '* **Frame.** Deformation works on the vertices of the chosen mesh (or card) in the leaf\'s local frame: X across the blade, Y along the growth axis, Z the face. Every step maps the pivot (attachment point) to itself, so welds, anchors and children stay attached. Order: Height, Scale, Fold, Twist, Curl, Vertex noise.',
  '* **Height** pushes vertices along their normals by (map − 0.5) × amount metres, sampled at the vertex UV from the **Height** texture of the leaf\'s material (Materials panel). Without a Height texture it does nothing and the node shows a warning. It fades in over the first 10 % of the leaf so the pivot stays put.',
  '* **Fold** rotates both halves about Y (+ up toward the face, − down). **Curl** bends the blade around X into a circular arc whose total angle is the value. **Twist** rotates about Y by an angle that grows linearly with the distance from the X axis (value = angle at the tip).',
  '* **Vertex** adds a 3D simplex-noise offset to every vertex in local space. *Amount* is in metres, *Noise* is the tightness (cycles per leaf length, higher = more localized), *Seed* picks the pattern. Each leaf samples its own place in the noise field (deterministic).',
  '* **Scale** X / Y / Z scale each leaf along its local axes.',
  '* **Variance / curves.** Each value gets its optional ± variance and is multiplied by its curve along the parent. Variance of a value that is 0 uses a fixed span (Height 0.05 m, Fold 45°, Curl 90°, Twist 180°, Vertex 0.05 m, Scale 0.5) so it still has an effect.',
  '* **Sparse meshes.** At the high LODs (0 and 1) meshes with fewer than ~24 vertices are subdivided (midpoints, up to three passes) before deforming, so folds and curls are visible on a plain quad. Normals are recomputed from the deformed surface (the Lighting tab edits them afterwards).',
  '* **Anchors.** Attachment frames of cutout meshes go through the same deformation (without Height): position by the deformation, direction / up by its local derivative.',
  '* **Resolution.** The *LOD* axis of both curves is the active LOD (viewport LOD selector, export LODs, 0 = highest … 3 = lowest) divided by 3. *Size increase %* multiplies the leaf size by 1 + y/100 (default curve 0 % → 36 %, the growth older projects had). *Mesh LOD* picks the mesh slot (0 High, 1 Medium, 2 Low, rounded; default curve = High at LOD 0, Medium at 1, Low from 2). *Mesh LOD offset* shifts it and is clamped to High..Low; it needs two or more filled mesh LOD slots (otherwise it is ignored with a warning). An empty slot falls back to the nearest filled one. Plain cards (no mesh) only follow the existing segment reduction.',
  '',
].join('\n');

const LIGHTING_NOTES = [
  '### Lighting tab - how the pieces fit together',
  '',
  '* **Style.** *Global* (default) reads the shared leaf lighting on the **Tree** node (Lighting tab, same parameters as Local, handed down the hierarchy as `StructureData.lighting`); *Local* uses this generator\'s own values. Defaults are neutral, so older projects look the same. The former *Spherize* / *Bend* controls did nothing and were removed (the ambient-occlusion section is unchanged).',
  '* **Pass.** A normal-only pass runs after deformation, mirroring and the winding fix, per leaf (`applyLeafLighting`, reused by the Frond later). Geometry never moves; tangents are re-orthogonalised to the new normals. Order: Smooth → Parent puffiness → Unify → Adjustments → Puffiness → World up.',
  '* **Smooth** blends the original normals toward area-weighted face-averaged normals computed from the deformed mesh.',
  '* **Parent puffiness.** *Amount* blends each normal toward the direction anchor → vertex (1 = fully aligned). *Anchor*: Global / Deep / Intermediate / Local are ancestor base points (as in the Leaves tab); *Height* = the Global ancestor dropped to the ground (z = 0); *Surface X / Y / Z* use the parent\'s normal / binormal / tangent at the attachment as one fixed direction; *None* = off.',
  '* **Anchor shift.** *Amount* is the length (m) of the straight-up range the anchor can move through and *Position* (0..1) picks the spot inside it, so Position does nothing while Amount is 0. It applies to every point anchor (not to Surface / None).',
  '* **Unify** blends all normals of a leaf toward their average. **Adjustments** (Up / Right / Out, with ± variance per leaf) rotate the normals about the leaf\'s local X / Y / Z. **Puffiness** spherizes the normals around the centre of each leaf after all other edits. **World up** blends toward straight up (+Z) and overrides puffiness and the adjustments.',
  '',
].join('\n');

const BATCHED_NOTES = [
  '### Batched Leaf (`generator.batchedLeaf`)',
  '',
  'Same tabs and parameters as Leaf (placement, orientation, type, deformation, resolution, lighting) except **Mesh LOD offset**, the vertex-noise **Seed**, **Unify** and **World up**, which do not exist. It does not follow the viewport / export LOD (it always builds at the highest detail; the Resolution curves are read at LOD 0). All leaves are merged into **one slot per material** (`mergeByMaterial`), and `MeshData.parts` is an index table (source key, skeleton branch, vertex and index ranges per leaf, sorted by index) so a triangle can be resolved back to the leaf that produced it.',
  '',
].join('\n');

function leafTab(): string {
  const def = getNodeDef('generator.leaf');
  if (!def) throw new Error('generator.leaf');
  const lines: string[] = [];
  for (const group of ['Leaves', 'Deformation', 'Resolution', 'Lighting']) {
    lines.push(`## ${def.label} (\`generator.leaf\`) - ${group} tab`, '', '| Section | Parameter | id | Range | Default | Var | Curve | Meaning |', '|---|---|---|---|---|---|---|---|');
    for (const p of def.params.filter((d) => d.group === group)) {
      const meaning = (p.tooltip ?? '').replace(/\|/g, '/');
      const shown = p.kind === 'list' ? 'rows of Material / Mesh / Weight' : range(p);
      lines.push(`| ${p.subgroup ?? ''} | ${p.label} | \`${p.id}\` | ${shown} | ${p.kind === 'list' ? 'one row' : fmt(p.default)} | ${p.variance ? 'yes' : ''} | ${p.curveAllowed ? 'yes' : ''} | ${meaning} |`);
    }
    lines.push('');
    if (group === 'Leaves') lines.push(LEAF_NOTES);
    if (group === 'Lighting') lines.push(LIGHTING_NOTES);
  }
  return lines.join('\n') + '\n' + DEFORM_NOTES + '\n' + BATCHED_NOTES;
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
