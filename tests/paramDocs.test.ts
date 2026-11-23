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

const MODE_NOTES = [
  '## Generation modes (Generation > Mode)',
  '',
  'Every generator (Trunk, Branch, Root, Spine, Leaf, Batched Leaf, Mesh Instance, Cap, Cluster) has the same `Mode` dropdown; only the parameters of the chosen mode are shown. The layout is computed by the pure module `src/generators/modes/` and returns one record `{ t, roll, side, groupIndex }` per node (`t` 0..1 along the parent, `roll` around its axis, `side` +1 / -1, `groupIndex` of the step / internode / bend). All modes stay inside **First .. Last** (Parent is the exception: it sits at the origin). Everything is seeded: same graph + seed = same result.',
  '',
  '* **Absolute** - exactly *Number* nodes, evenly spread; Jumble, Sweep, Roll, Favor splits, Align style.',
  '* **Proportional** - *Frequency* x parent length nodes, one at a random place in each equal stretch of First..Last; same extras as Absolute.',
  '* **Absolute steps / Proportional steps** - *Steps* (a number, or steps per metre of parent length) rings of *Per step* nodes from First to Last. *Spread* moves the nodes of a ring lengthwise (fraction of First..Last), *Roll* turns each ring against the previous one, *Balance* 1 spaces a ring evenly around the parent, 0 scatters it.',
  '* **Phyllotaxy** - groups every *Internode length* metres (world space) from **Last towards First**; the first group sits at Last. *Style*: Opposite (distichous: pairs, every group the same way), Opposite (decussate: each group turned 90 degrees), Opposite (random orientation: pairs turned at random), Alternating (distichous: one node, sides alternate), Alternating (random: one node at a random roll), Whorled (*Children per node*). *Spread* offsets nodes lengthwise inside a group (1 = up to the neighbouring group), *Spiral* adds rotation per group, *Limit* caps the groups (0 = unlimited). *Internode length* 0 spreads *Limit* groups (8 if unlimited) evenly between Last and First (this is how projects saved with the old golden-angle Phyllotaxy are migrated).',
  '* **Interval** - groups from **Last towards First**: the first group is exactly at Last, there is no guarantee of one at First. *Frequency* is the distance between groups in metres; its curve scales it along the parent (First = 0, Last = 1), a lower value packs groups tighter. *Count* nodes per group, *Spread*, *Spiral*, *Limit* as in Phyllotaxy, *Balance* turns every other group by half the angular gap so it fills the gaps of the previous group.',
  '* **Bifurcation** - one node at each of the strongest bends of the parent (turning angle above *Threshold*, at least *Min spacing* apart, at most *Count*), rolled towards the outside of the bend. *Spread* shifts nodes along the parent (1 = 10 % of its length). A straight parent gets a few evenly spaced nodes instead. The reference parameters are not specified; these three plus Min spacing are this app\'s own design.',
  '* **Flood** - exactly *Number* nodes at random places along the parent. **Parent** - exactly *Number* nodes at the origin of the parent, spread around it.',
  '* **Density** (existing) places nodes per metre; **Classic** is listed as a disabled legacy entry.',
  '* **Align style** (Phyllotaxy / Interval): *Group* keeps the nodes of a group in their layout, *Individual* turns every node on its own within its share of the circle. **Align** (section Alignment) is the shared skyward roll, read by generators that grow their own branches.',
  '* **Side.** Every node carries a side: alternating per group member for Interval / Phyllotaxy, otherwise derived from the roll. Leaves use it for *Initial orientation: Classic*.',
  '* **Back-compat.** Mode `whorled` is now `absolute-steps` (ids `whorlCount`, `whorlPerStep`, `whorlSpread`, `whorlRoll` kept); old Phyllotaxy (Number + Divergence angle) becomes Alternating (distichous) with Spiral = angle - 180; old Bifurcation Number becomes Count. Interval keeps `intervalStep` (now *Frequency*) and `perStep` (now *Count*). Node versions were bumped and `migrateGenerationParams` runs on load.',
  '',
].join('\n');

const COMMON_NOTES = [
  '## Shared Generation properties (Generation tab of every generator)',
  '',
  'Sections **Boundaries / Common / Extend parent / Knockout / Force containers / More / Masks**. Order of operations for the nodes of one parent: mode placement -> boundaries / Clip -> Position / Rotation / Sink -> Pruning -> Knockout -> Force containers -> Masks -> Extend parent -> compute (grow the node).',
  '',
  '* **Boundaries.** *First* / *Last* = lowest / highest point on the parent where nodes occur. *Clip* (checkbox; the value insets the range as a fraction of First..Last): nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary.',
  '* **Common.** *Active* (curve over the level of detail, left = highest detail: active where the curve is above 0.5). *Pass* (integer >= 1): generators compute in pass order; a node whose pass is lower than an ancestor\'s gets an error badge. *Rotation* turns all nodes of a parent around it as a group (variance jumbles it per parent). *Position* shifts all nodes along the parent (variance per parent). *Sink* moves the start of the nodes into (+) or out of (-) the parent (variance per node). *Pruning* curve runs from First (left) to Last (right); nodes are removed where it is below 0.5.',
  '* **Extend parent** (Branch, Cap, Leaf, Batched leaf; valid under a Branch parent). *Type*: None, Any (tip), Bottom (base), Breaks only (tip of parents that end in a break; detected from the thick tip of the parent), Split 1 / Split 2 / Skinny / Fat (kept as entries, behave like Any until the split data exists). *Count* = extensions per parent.',
  '* **Knockout.** *Amount* = share of nodes removed at random after the mode ran (curve along the parent). *+ Resolution* is added to the amount for every level of detail below the highest (negative = fewer removed).',
  '* **Force containers.** *Include* / *Exclude* list Force nodes by name. Give a Force node a volume in its *Volume* section (Shape None / Sphere / Box + Center, Radius or Size). Include keeps only nodes inside at least one named volume, Exclude removes nodes inside any. Unknown names are ignored. The volume works whether or not the force is Active. Nodes are tested where they leave the parent surface.',
  '* **More.** *Click place* (Ready / None / Any / Number) is stored and takes effect with Freehand mode. *Mesh alignment* (Leaf, Batched leaf): when the parent is a Mesh Instance, the leaf grows along the parent Tangent / Binormal, a parent axis (X = normal, Y = tangent, Z = their cross product) or a world axis. *Size scalar* scales the node (length, radius, leaf / mesh scale ...) and is multiplied into the scalar handed to every node below it; the Tree node\'s *Size scalar* is the start value.',
  '* **Masks.** Assign any number of masks from the Masks panel; a node is kept only where every mask evaluates to 0.5 or more (Inclusive / Exclusive from the mask). The elevation range of *relative* masks is the Z range of the parent structure.',
  '* **Tree node.** Only *Size scalar* applies.',
  '* **Back-compat.** The old scalar *Pruning* (random removal) is folded into Knockout on load; the new Pruning is the curve `pruningCurve`. `Clip` default is now 0 (no inset). Node versions were bumped.',
  '',
].join('\n');

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

const FROND_VARIANCE_NOTES = [
  '### Frond (`generator.frond`) - variance, lighting and wind',
  '',
  '* **Left-Right Variance** (Shape). *Amount* (0..1): the left and right half of every frond get their own random multiplier (`1 - amount .. 1 + amount`) for Curl, Fold and Gravity, so the halves react independently. *Seed* picks the pattern. Amount 0 keeps both halves identical.',
  '* **Section Variance** (Shape). Sections are painted in the cutout editor with the *Section [n]* paint tool (ids 1..8, 1 = default / unpainted) and read per vertex of the mapped mesh. Sections 2..8 get their own shift for Gravity, Fold, Curl and Roll: `Offset + Amount × random(-1..1)`, drawn once per frond and section. *Favor Outliers* maps the random value to its square root (sign kept), so extreme values are more likely than the median. Section 1 / unpainted vertices and plain ribbons keep the whole-mesh values. Each painted section is its own rib set, so section borders can show a step.',
  '* **Lighting.** Style Global reads the Tree lighting (Alignment / Spread are not part of it); Local uses the frond group: Smooth, Alignment (normals toward the growth direction of the parent spine), Spread (normals away from the spine), Parent puffiness (Anchor = the Leaf list plus *Origin*, Amount) and Adjustments (Up / Right / Out about the frond axes: X across, Y along, Z face; ± variance per frond). It reuses `applyLeafLighting`; order: Smooth → Parent puffiness → Alignment → Spread → Adjustments. Geometry never moves.',
  '* **Wind.** The per-vertex weights keep the existing layout `(level 0, level 1, level 2, phase)`; the frond starts from the parent weights at its base and adds its own bend on level 2. *Weight* = value × profile × `t^Bend power` (the profile\'s left end is the pivot and the weight is exactly 0 at the base, so the frond stays attached). *Cross* scales the motion from none at the spine to full at the edges. *Boost* adds an absolute weight (profile: left = base, right = tip), faded in over the first 10 % of the length. *Ribs › Apply branch wind* raises the level above the parent branch (generation − 1, at least the trunk level) for the vertices off the spine by *Ribs › Weight* × distance from the spine, also faded in over the first 10 %. Defaults reproduce the previous wind.',
  '',
].join('\n');

const BATCHED_NOTES = [
  '### Batched Leaf (`generator.batchedLeaf`)',
  '',
  'Same tabs and parameters as Leaf (placement, orientation, type, deformation, resolution, lighting) except **Mesh LOD offset**, the vertex-noise **Seed**, **Unify** and **World up**, which do not exist. It does not follow the viewport / export LOD (it always builds at the highest detail; the Resolution curves are read at LOD 0). All leaves are merged into **one slot per material** (`mergeByMaterial`), and `MeshData.parts` is an index table (source key, skeleton branch, vertex and index ranges per leaf, sorted by index) so a triangle can be resolved back to the leaf that produced it.',
  '',
].join('\n');

const UV_NOTES = [
  '### Branch UV Mapping and material patches (R16) - formulas',
  '',
  'Pure maths: `src/generators/uv/` (`uMath`, `vMath`, `areas`, `patches`); glue for the tube mesher: `src/geometry/tubeUv.ts`; parameter reader: `src/nodes/generators/uvConfig.ts`. With the defaults the result equals the tiling by world size of older projects. `metresPerTile` is the world size of one texture copy (from the bark material).',
  '',
  '* **U tiles (around).** `tiles = max(1, round(Absolute + Relative x circumference / metresPerTile))`, circumference = 2 pi x thickest radius of the branch. Always a whole number >= 1, so the texture closes without a seam. **Offset** (copies, variance = random per branch) turns the texture around the branch.',
  '* **Fractional.** *Enable* allows a float count. *Value* is used as is (Absolute / Relative are ignored). *Auto* = texel density of the parent (`parentTiles / parentCircumference`, tiles per metre) x circumference at the base of the branch; without a parent the world scale is used. A seam may show.',
  '* **Twist.** U shifts by `Amount x tiles x V` along the branch (revolutions per V tile). *Random flip* gives every branch a random sign.',
  '* **V, Absolute.** `V = arc length x Scale / metresPerTile`. **Relative:** `V = arc length / branch length x Scale`. **Relative (keep aspect ratio):** `dV/ds = Scale x tiles / (2 pi x r)` integrated along the branch, so one V copy is as long as one U copy is wide (on a cylinder). `r = max(ref + (local - ref) x Skew, ref x floor(Pinch))` with `ref` the thickest radius, `floor = 0.02 + 0.48 x Pinch`: Skew correction 0 keeps the reference radius (the texture tapers with the branch), 1 follows the local radius (it keeps its proportions); Pinch stops V from racing away at a pointed tip.',
  '* **Anchor / Offset.** V is 0 at the base (Start). *End* shifts V so the tip lies on a whole number (`ceil`). *Offset* adds copies (variance = random start V per branch).',
  '* **Style.** *U locked* forces one U copy around the branch and ignores offsets / twist; *U and V locked* additionally maps V to 0..1 over the whole branch (V style Relative, Scale 1). **Extension style** (Branch > Extensions): Automatic continues the parent (tiles, V at the attachment, twist, U offset), Manual (match) = own settings but parent tile count and V, Manual (match u only) = parent tile count only, Manual (full control) = own settings.',
  '* **Patches (Tiling).** *0-1 patches* cut the branch at every whole V number: patch `p` covers V in `[p, p + 1]`, local V 0..1 and U 0..1 are remapped into the patch\'s UV Area rectangle (`u = u0 + (u1 - u0) x U`, same for V), so UVs never leave the area (and never leave 0..1). A seam ring exists twice (end of one patch, start of the next), the quad between them is not drawn: **vertices along a seam are doubled**. Seams never fall inside a weld. *Optimize segments* moves a seam (or, in Tiling, a ring) onto an existing ring within *V tolerance* instead of adding a close ring. *Seed* varies the random choices.',
  '* **Materials.** Branch rows: Material (material, Material Set or `Inherited`), Weight, and (patch styles only, patch options button) *UV Area* (`Whole map`, `Any` = weighted pick among the bark / any-usage areas of the material, or a named area) and *Placement* (`Anywhere`, `First ring` = only competes for the first patch). *Choose one assigned material*: one material (rows grouped by material, summed weights) for the whole branch, each patch picks one of its rows (UV Area). *Use all assigned materials*: every patch picks any row by weight; one mesh slot per material. In Tiling one weighted row is used for the whole branch. Extension rows start as `Inherited` (the material the parent resolved to).',
  '* **Reads / writes.** The mesher writes UV0; weld blend attributes keep using the parent-side UV (`weldParentUV`), Displacement > Use UVs reads the U / V of the same vertices. Old projects: `uvScaleU` multiplies *+ Relative*, `Normalized` mapping and *Match one V tile* map to V style Relative with a free tile count, the single Branch `material` migrates to the first row of the list (node version 5).',
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
  return lines.join('\n') + '\n' + DEFORM_NOTES + '\n' + BATCHED_NOTES + '\n' + FROND_VARIANCE_NOTES;
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
    const doc = [header, MODE_NOTES, COMMON_NOTES, ...['output.tree', 'generator.trunk', 'generator.branch', 'generator.spine'].map((type) => (type === 'generator.branch' ? `${table(type)}\n${UV_NOTES}` : table(type))), leafTab()].join('\n');
    expect(doc).toContain('Tree placement');
    expect(doc).toContain('Internode length');
    expect(doc).toContain('Force containers');
    expect(doc).toContain('Sensitivity → Parent');
    expect(doc).toContain('Left-Right Variance');
    if (process.env.WRITE_PARAM_DOCS) writeFileSync('docs/PARAMETERS.md', doc);
  });
});
