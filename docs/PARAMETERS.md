# Parameters

Generated from the node registry by `WRITE_PARAM_DOCS=1 npx vitest run tests/paramDocs.test.ts` - do not edit by hand.

* **Var** = the row has the "%" variance toggle (blue variance field). **Curve** = a curve may drive the value along the parent / spine (green mini-curve).
* Values typed in the number field are accepted up to the hard max; the slider only covers the soft range.
* Counts above `warnAbove` (1000 for `Number`) show a yellow "!" performance badge next to the label.
* Curves on a parameter are evaluated along the *parent* (0 = base, 1 = tip) for placement params, and along the *spine* for shape params.

## Generation modes (Generation > Mode)

Every generator (Trunk, Branch, Root, Spine, Leaf, Batched Leaf, Mesh Instance, Cap, Cluster) has the same `Mode` dropdown; only the parameters of the chosen mode are shown. The layout is computed by the pure module `src/generators/modes/` and returns one record `{ t, roll, side, groupIndex }` per node (`t` 0..1 along the parent, `roll` around its axis, `side` +1 / -1, `groupIndex` of the step / internode / bend). All modes stay inside **First .. Last** (Parent is the exception: it sits at the origin). Everything is seeded: same graph + seed = same result.

* **Absolute** - exactly *Number* nodes, evenly spread; Jumble, Sweep, Roll, Favor splits, Align style.
* **Proportional** - *Frequency* x parent length nodes, one at a random place in each equal stretch of First..Last; same extras as Absolute.
* **Absolute steps / Proportional steps** - *Steps* (a number, or steps per metre of parent length) rings of *Per step* nodes from First to Last. *Spread* moves the nodes of a ring lengthwise (fraction of First..Last), *Roll* turns each ring against the previous one, *Balance* 1 spaces a ring evenly around the parent, 0 scatters it.
* **Phyllotaxy** - groups every *Internode length* metres (world space) from **Last towards First**; the first group sits at Last. *Style*: Opposite (distichous: pairs, every group the same way), Opposite (decussate: each group turned 90 degrees), Opposite (random orientation: pairs turned at random), Alternating (distichous: one node, sides alternate), Alternating (random: one node at a random roll), Whorled (*Children per node*). *Spread* offsets nodes lengthwise inside a group (1 = up to the neighbouring group), *Spiral* adds rotation per group, *Limit* caps the groups (0 = unlimited). *Internode length* 0 spreads *Limit* groups (8 if unlimited) evenly between Last and First (this is how projects saved with the old golden-angle Phyllotaxy are migrated).
* **Interval** - groups from **Last towards First**: the first group is exactly at Last, there is no guarantee of one at First. *Frequency* is the distance between groups in metres; its curve scales it along the parent (First = 0, Last = 1), a lower value packs groups tighter. *Count* nodes per group, *Spread*, *Spiral*, *Limit* as in Phyllotaxy, *Balance* turns every other group by half the angular gap so it fills the gaps of the previous group.
* **Bifurcation** - one node at each of the strongest bends of the parent (turning angle above *Threshold*, at least *Min spacing* apart, at most *Count*), rolled towards the outside of the bend. *Spread* shifts nodes along the parent (1 = 10 % of its length). A straight parent gets a few evenly spaced nodes instead. The reference parameters are not specified; these three plus Min spacing are this app's own design.
* **Flood** - exactly *Number* nodes at random places along the parent. **Parent** - exactly *Number* nodes at the origin of the parent, spread around it.
* **Density** (existing) places nodes per metre; **Classic** is listed as a disabled legacy entry.
* **Align style** (Phyllotaxy / Interval): *Group* keeps the nodes of a group in their layout, *Individual* turns every node on its own within its share of the circle. **Align** (section Alignment) is the shared skyward roll, read by generators that grow their own branches.
* **Side.** Every node carries a side: alternating per group member for Interval / Phyllotaxy, otherwise derived from the roll. Leaves use it for *Initial orientation: Classic*.
* **Back-compat.** Mode `whorled` is now `absolute-steps` (ids `whorlCount`, `whorlPerStep`, `whorlSpread`, `whorlRoll` kept); old Phyllotaxy (Number + Divergence angle) becomes Alternating (distichous) with Spiral = angle - 180; old Bifurcation Number becomes Count. Interval keeps `intervalStep` (now *Frequency*) and `perStep` (now *Count*). Node versions were bumped and `migrateGenerationParams` runs on load.

## Shared Generation properties (Generation tab of every generator)

Sections **Boundaries / Common / Extend parent / Knockout / Force containers / More / Masks**. Order of operations for the nodes of one parent: mode placement -> boundaries / Clip -> Position / Rotation / Sink -> Pruning -> Knockout -> Force containers -> Masks -> Extend parent -> compute (grow the node).

* **Boundaries.** *First* / *Last* = lowest / highest point on the parent where nodes occur. *Clip* (checkbox; the value insets the range as a fraction of First..Last): nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary.
* **Common.** *Active* (curve over the level of detail, left = highest detail: active where the curve is above 0.5). *Pass* (integer >= 1): generators compute in pass order; a node whose pass is lower than an ancestor's gets an error badge. *Rotation* turns all nodes of a parent around it as a group (variance jumbles it per parent). *Position* shifts all nodes along the parent (variance per parent). *Sink* moves the start of the nodes into (+) or out of (-) the parent (variance per node). *Pruning* curve runs from First (left) to Last (right); nodes are removed where it is below 0.5.
* **Extend parent** (Branch, Cap, Leaf, Batched leaf; valid under a Branch parent). *Type*: None, Any (tip), Bottom (base), Breaks only (tip of parents that end in a break; detected from the thick tip of the parent), Split 1 / Split 2 / Skinny / Fat (choose one open end of a split; the end is the parent's real open end, see docs/SPLITS.md). *Count* = extensions per open end (2 = a fused Y fork, 3+ = a bundle that follows the pipe model; Extensions group). The Type / Count rows are disabled under a parent that is not a Branch generator.
* **Knockout.** *Amount* = share of nodes removed at random after the mode ran (curve along the parent). *+ Resolution* is added to the amount for every level of detail below the highest (negative = fewer removed).
* **Force containers.** *Include* / *Exclude* list Force nodes by name. Give a Force node a volume in its *Volume* section (Shape None / Sphere / Box + Center, Radius or Size). Include keeps only nodes inside at least one named volume, Exclude removes nodes inside any. Unknown names are ignored. The volume works whether or not the force is Active. Nodes are tested where they leave the parent surface.
* **More.** *Click place* (Ready / None / Any / Number) is stored and takes effect with Freehand mode. *Mesh alignment* (Leaf, Batched leaf): when the parent is a Mesh Instance, the leaf grows along the parent Tangent / Binormal, a parent axis (X = normal, Y = tangent, Z = their cross product) or a world axis. *Size scalar* scales the node (length, radius, leaf / mesh scale ...) and is multiplied into the scalar handed to every node below it; the Tree node's *Size scalar* is the start value.
* **Masks.** Assign any number of masks from the Masks panel; a node is kept only where every mask evaluates to 0.5 or more (Inclusive / Exclusive from the mask). The elevation range of *relative* masks is the Z range of the parent structure.
* **Tree node.** Only *Size scalar* applies.
* **Back-compat.** The old scalar *Pruning* (random removal) is folded into Knockout on load; the new Pruning is the curve `pruningCurve`. `Clip` default is now 0 (no inset). Node versions were bumped.

## Tree (`output.tree`)

Root of the plant. Its Shape defines the ground disc in which first-generation nodes are placed.

### Tab: Gen

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| More | Size scalar | `scale` | 0.01..100 (slider 0.01..5) | 1 |  |  | Scales every node of the plant (each generator multiplies its own Size scalar into this value). |
| More | Ground offset | `groundOffset` | -10..10 m | 0 |  |  | Moves the whole plant up or down relative to the ground. |
| Season | Season | `season` | 0..1 | 0 |  |  | Season slider (also on the viewport toolbar). Every generator turns it into its own transition value; Material Set members are picked by weight x Season curve at that value. The model is regenerated on every change. |
| Season | Show dropped leaves | `showDroppedLeaves` | bool | false |  |  | Leaves that finished their life (transition value reached Drop time) leave the branch and lie on the ground (z = 0), swept along the Season wind arrows. |
| Season | Export dropped leaves | `exportDroppedLeaves` | bool | false |  |  | Include the dropped leaves on the ground in the export. Off = they are only a viewport aid. |

### Tab: Shape

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Shape | Type | `shapeType` | Circle | circle |  |  | Placement area. Only the circle shape is available. |
| Shape | Radius | `radius` | 0..10000 (slider 0..50) m | 10 |  |  | Radius of the placement disc (drag the white handle in the viewport). |
| Shape | Center X | `centerX` | -10000..10000 (slider -50..50) m | 0 |  |  | X position of the placement area centre. |
| Shape | Center Y | `centerY` | -10000..10000 (slider -50..50) m | 0 |  |  | Y position of the placement area centre. |
| Shape | Sink | `treeSink` | -50..50 (slider -2..2) m | 0 |  |  | Depth every child is sunk into the ground. |
| Shape | Roll | `treeRoll` | -360..360 (slider -180..180) ° | 0 |  |  | Rotates the whole placement pattern around the vertical axis. |
| Shape | Unify child orientation | `unifyChildOrientation` | bool | false |  |  | Give all children the same orientation instead of a random one. |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Dynamic LOD | Enable | `lodEnabled` | bool | false |  |  | Dynamic LOD: the model shrinks smoothly as the LOD value rises. Parts hidden in the interior are removed first; a part that will be removed shrinks until it is invisible (branches shrink to their spine, leaves to their attachment point) while the leaves that stay grow to keep the silhouette. Needs no re-generation: the viewport applies it live (toolbar LOD). |
| Dynamic LOD | Mode | `lodMode` | Manual / Screen area | manual |  |  | Manual: the LOD value below (or the toolbar slider) is used. Screen area: the value follows the camera distance and the bounding sphere of the tree. |
| Dynamic LOD | LOD value | `lodValue` | 0..1 | 0 |  |  | Manual LOD value: 0 = full detail (the unmodified mesh), 1 = lowest detail. |
| Dynamic LOD | Levels | `lodLevels` | 2..8 | 4 |  |  | Number of discrete levels written on export. Level k uses the Dynamic LOD value k / (levels - 1); the billboard impostor stays the last level. |
| Reduction curves | Branches | `lodBranches` | curve | curve |  |  | Share of the branches kept over the whole transition. X: LOD value, Y: 1 = all, 0 = none. Thin and interior branches go first; they shrink to their spine before they are removed. |
| Reduction curves | Leaves | `lodLeaves` | curve | curve |  |  | Share of the leaves kept over the whole transition. X: LOD value, Y: 1 = all, 0 = none. Interior leaves go first; they shrink away before they are removed. |
| Reduction curves | Fronds | `lodFronds` | curve | curve |  |  | Share of the fronds / fins kept over the whole transition. X: LOD value, Y: 1 = all, 0 = none. |
| Reduction curves | Decorations | `lodDecorations` | curve | curve |  |  | Share of the decorations / knots / meshes kept over the whole transition. X: LOD value, Y: 1 = all, 0 = none. |
| Reduction curves | Grow scale | `lodGrowScale` | curve | curve |  |  | How much of the leaf area lost by the removal the surviving leaves and fronds win back by growing (up to 3x). X: LOD value, Y: 0 = no growth, 1 = keep the covered area. |

### Tab: Collision

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Leaf collision | Leaf collision removal | `leafCollision` | None / Low / Medium / High | none |  |  | Removes leaves that overlap other leaves or branches. None = off. Low = leaf against leaf only (spheres, fastest). Medium = all collisions with a rough (box / capsule) intersection. High = exact triangle intersection (slowest). Runs as a background pass: the plain tree shows first and the result pops in when it is done. At a coarser LOD the tests are one step cheaper. |
| Leaf collision | Use spherical tests on leaves | `leafCollisionSpherical` | bool | false |  |  | Test every leaf as a sphere (see the leaf generator Sphere threshold) instead of its box / triangles: faster and keeps more leaves. |
| Leaf collision | Cluster plane overlapping | `clusterPlaneOverlap` | None / Low / Medium / High | none |  |  | The same tests for Batched leaf (cluster) cards, but only in the top-down XY plane: removes cards that overlap when seen from above. None = off. |

### Tab: Color

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Vertex colors | Compute | `vertexColorCompute` | bool | true |  |  | Compute and keep vertex colours. Off: nothing is exported in COLOR_0 / colour columns and the Vertex Colors view is white. On (default) is the behaviour of earlier versions. |
| Vertex colors | Packing | `vertexColorPacking` | Legacy / Kekenik | legacy |  |  | What the vertex colour channels hold in the Vertex Colors view and in exports. Legacy: RGB = baked albedo tint x ambient occlusion (earlier behaviour). Kekenik: R = per-branch random tint, G = height along the plant (0 base .. 1 top), B = ambient occlusion (the baked one when the export bakes AO, otherwise the analytic one). Leaves and other meshes without a branch have R = 0.5. |

### Tab: Lighting

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Normals | Smooth | `globalLightSmooth` | 0..1 | 0 |  |  | Blends the original normals towards smoothed ones (averaged over the neighbouring faces) after the leaf is deformed. The other normal edits follow the smoothing. |
| Parent puffiness | Amount | `globalLightParentAmount` | 0..1 | 0 |  |  | Turns the normals to face out from the anchor through each vertex. 1 = fully aligned. Needs an anchor other than None. |
| Parent puffiness | Anchor | `globalLightParentAnchor` | Global / Deep / Intermediate / Local / None / Height / Surface X / Surface Y / Surface Z | none |  |  | Global / Deep / Intermediate / Local: an ancestor in the hierarchy. Height: the ground below the highest ancestor. Surface X / Y / Z: align with the parent’s X / Y / Z axis at the attachment. |
| Anchor shift | Position | `globalLightAnchorPosition` | 0..1 | 0 |  |  | Where the anchor sits inside its shift range (straight up). Has no effect while Amount is 0. |
| Anchor shift | Amount | `globalLightAnchorAmount` | 0..100 (slider 0..10) m | 0 |  |  | Length of the range the anchor can be moved up by Position. |
| Normals | Puffiness | `globalLightPuffiness` | 0..1 | 0 |  |  | Spherizes the normals around the centre of each leaf. Applied after all other normal edits. |
| Normals | Unify | `globalLightUnify` | 0..1 | 0 |  |  | Blends every normal of a leaf towards the average normal direction. |
| Adjustments | Up | `globalLightUp` | -180..180 ° | 0 | yes |  | Rotates the normals (not the geometry) about the leaf’s local X axis. Use the variance to jumble clusters. |
| Adjustments | Right | `globalLightRight` | -180..180 ° | 0 | yes |  | Rotates the normals (not the geometry) about the leaf’s local Y axis. Use the variance to jumble clusters. |
| Adjustments | Out | `globalLightOut` | -180..180 ° | 0 | yes |  | Rotates the normals (not the geometry) about the leaf’s local Z axis. Use the variance to jumble clusters. |
| Normals | World up | `globalLightWorldUp` | 0..1 | 0 |  |  | Forces the normals upwards (even grass-like lighting). Overrides puffiness and the adjustments. |

## Trunk (`generator.trunk`)

Main stem with crown height, buttress flare, lean, gnarliness, and profile curves.

### Tab: Gen

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Generation | Mode | `mode` | Absolute / Proportional / Absolute steps / Proportional steps / Phyllotaxy / Interval / Bifurcation / Flood / Parent / Density / Classic (legacy) | absolute |  |  | How children are placed on the parent: an exact number, proportional to its length, in steps (whorls), by phyllotaxy, at intervals, at bends, flooded along it or all at its origin. |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 1 | yes | yes | Exact number of nodes created on each parent. |
| Absolute | Jumble | `jumble` | 0..1 | 0 |  | yes | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | yes | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | yes | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | yes | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | yes | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  |  | Random variation of the spacing in Density mode. |
| Proportional | Frequency | `proportionalCount` | 0..50 (slider 0..10) /m | 2.5 |  |  | Nodes per metre of parent length: longer parents get more nodes, spread at random along them. |
| Steps | Steps | `whorlCount` | 1..128 | 5 |  |  | Number of steps (rings of nodes) along the parent. |
| Steps | Steps | `stepsFrequency` | 0..20 (slider 0..5) /m | 0.5 |  |  | Steps per metre of parent length. |
| Steps | Per step | `whorlPerStep` | 1..128 (slider 1..24) | 4 |  |  | Nodes in every step. |
| Steps | Spread | `whorlSpread` | 0..1 | 0.03 |  |  | Lengthwise spacing of the nodes inside one step, as a fraction of the First..Last stretch. |
| Steps | Roll | `whorlRoll` | -180..180 ° | 15 |  |  | Rotation of every step relative to the previous one. |
| Steps | Balance | `stepsBalance` | 0..1 | 1 |  |  | How evenly the nodes of a step are spaced around the parent (1 = evenly, 0 = random). |
| Phyllotaxy | Style | `phyllotaxyStyle` | Opposite (distichous) / Opposite (decussate) / Opposite (random orientation) / Alternating (distichous) / Alternating (random) / Whorled | alternating-distichous- |  |  | How the nodes of a group are arranged and how consecutive groups are turned against each other. |
| Phyllotaxy | Internode length | `phyllotaxyInternode` | 0..50 (slider 0..2) m | 0.25 |  |  | Distance between groups, measured along the parent from Last towards First. 0 spreads Limit groups evenly instead. |
| Phyllotaxy | Children per node | `phyllotaxyChildren` | 1..32 | 3 |  |  | Nodes in each whorled group. |
| Phyllotaxy | Spread | `phyllotaxySpread` | 0..1 | 0 |  |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Phyllotaxy | Spiral | `phyllotaxySpiral` | -180..180 ° | 0 |  |  | Extra rotation added for every group. |
| Phyllotaxy | Limit | `phyllotaxyLimit` | 0..10000 (slider 0..100) | 0 |  |  | Maximum number of groups (0 = no limit). |
| Phyllotaxy | Align style | `phyllotaxyAlignStyle` | Group / Individual | group |  |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Frequency | `intervalStep` | 0.001..50 (slider 0.001..3) m | 0.6 |  | yes | Distance between groups from Last towards First. The curve scales it along the parent: lower values pack groups tighter. |
| Interval | Count | `perStep` | 1..64 (slider 1..16) | 1 |  |  | Nodes in every group. |
| Interval | Spread | `intervalSpread` | 0..1 | 0 |  |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Interval | Spiral | `intervalSpiral` | -180..180 ° | 0 |  |  | Extra rotation added for every group. |
| Interval | Limit | `intervalLimit` | 0..10000 (slider 0..100) | 0 |  |  | Maximum number of groups (0 = no limit). |
| Interval | Align style | `intervalAlignStyle` | Group / Individual | group |  |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Balance | `intervalBalance` | 0..1 | 0 |  |  | Turns every other group so its nodes fill the gaps left by the previous group. |
| Bifurcation | Count | `bifurcationCount` | 0..1000 (slider 0..32) | 4 |  |  | Maximum number of nodes; the strongest bends win. |
| Bifurcation | Threshold | `bifurcationThreshold` | 0.5..90 ° | 6 |  |  | Smallest bend of the parent that gets a node. |
| Bifurcation | Spread | `bifurcationSpread` | 0..1 | 0 |  |  | Random shift of every node along the parent (1 = 10 % of its length). |
| Bifurcation | Min spacing | `bifurcationSpacing` | 0.01..0.9 | 0.12 |  |  | Smallest distance between two bends, as a fraction of the parent. |
| Alignment | Align | `align` | bool | false |  |  | Rolls the new nodes so they face the sky. |
| Boundaries | First | `first` | 0..1 | 0 |  | yes | Lowest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 1 |  | yes | Highest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0 |  |  | With the checkbox on, nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary. The value insets the range (fraction of First..Last). |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  |  | Removes nodes that Spread or Position push outside First..Last. |
| Common | Active | `active` | bool | true |  | yes | Switches the generator on. With a curve over the level of detail (left = highest detail) it is active where the curve is above 0.5. |
| Common | Pass | `pass` | 1..99 | 1 |  |  | Generators compute in pass order. A node cannot have a lower pass than any of its ancestors. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes |  | Rotates all nodes around the parent spine as a group. Variance jumbles the rotation per parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes |  | Shifts all nodes along the parent (fraction of its length). Variance shifts every parent differently. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes |  | Start offset of the nodes into (+) or out of (-) the parent; sinks trunks under the ground. |
| Common | Pruning | `pruningCurve` | curve | curve |  |  | Runs over the parent from First (left) to Last (right). Nodes are removed where the curve is below 0.5. |
| Common | Seed | `seed` | seed | 0 |  |  | Random seed. Change it to get a different variation of the same settings. |
| Knockout | Amount | `knockout` | 0..1 | 0 |  | yes | Randomly removes this share of the nodes after the mode has placed them. The curve varies it along the parent. |
| Knockout | + Resolution | `knockoutResolution` | -1..1 | 0 |  |  | Added to the amount for every level of detail below the highest: positive removes more nodes at lower detail, negative fewer. |
| Force containers | Include | `forceInclude` | list | [] |  |  | Keeps only the nodes inside the volume of the named Force node (set a volume in the Force node). |
| Force containers | Exclude | `forceExclude` | list | [] |  |  | Removes the nodes inside the volume of the named Force node. |
| More | Click place | `clickPlace` | Ready / None / Any / Number | ready |  |  | What a click in the viewport places. It is stored with the node and takes effect with Freehand mode. |
| More | Size scalar | `sizeScalar` | 0.01..100 (slider 0.01..5) | 1 |  |  | Scales this node and every node below it. |
| Masks | Mask | `genMasks` | list | [] |  |  | Keeps a node only where every assigned mask (Masks panel) evaluates to 0.5 or more. |
| Tree placement | Distribution | `distMode` | Parametric / Uniform / Poisson disk / Ring / Grid / Spiral | uniform |  |  | How Number instances fill the Tree disc. Uniform = area-correct random (r = R*sqrt(u)); Poisson disk = blue noise with a minimum distance. |
| Tree placement | Position | `distPosition` | 0..1 | 0.5 | yes |  | Normalised distance from the disc centre (0 = centre, 1 = edge), with variance. |
| Tree placement | Rotation | `distRotation` | 0..1 | 0 | yes |  | Normalised angle around the centre (0..1 = 0..360 degrees), with variance. |
| Tree placement | Min distance | `distMinDistance` | 0..1000 (slider 0..10) m | 0.5 |  |  | Minimum distance between first-generation elements placed on the ground. |
| Tree placement | Splay | `distSplay` | 0..85 ° | 0 |  |  | Outward tilt reached at the disc edge (ferns, bushes). Ignored when Unify child orientation is on. |

### Tab: Spine

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Length | Absolute | `length` | 0..500 (slider 0..40) m | 12 | yes | yes | Fixed part of the length in metres. The curve scales the length along the parent. |
| Length | + % of parent | `lengthPercent` | 0..2 (slider 0..1) | 0 |  | yes | Adds this fraction of the parent length (1 = as long as the parent). |
| Length | + % of radius | `lengthPercentRadius` | 0..500 (slider 0..100) | 0 |  |  | Adds this many parent radii to the length. |
| Length | Match one V tile | `matchOneVTile` | bool | false |  |  | Sets the length to exactly one V tile of the material, from its aspect ratio and the branch radius, and maps V from 0 to 1. |
| Length | Stop shape control | `stopShapeControl` | bool | false |  |  | Ignores the crown shape envelope and the generation damping, so this node is not shaped by its ancestors. |
| Length | Shape scale | `shapeScale` | 0..5 (slider 0..2) | 1 |  |  | Strength of the crown shape on the length: 0 = off, 1 = as drawn, above 1 = exaggerated. |
| Length | Limit length | `lengthLimit` | bool | false |  |  | Prevents children from becoming longer than the Absolute length. |
| Length | Crown height | `crownHeight` | 0..0.95 | 0.22 |  |  | Normalized height where the lower trunk transitions into the crown. |
| Clamp | Min | `lengthMin` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no minimum. |
| Clamp | Max | `lengthMax` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no maximum. |
| Orientation | Lean | `lean` | 0..60 ° | 2 | yes |  | Tilts the whole stem away from vertical (degrees). |
| Orientation | Lean direction | `leanAzimuth` | -180..180 ° | 25 | yes |  | Compass direction of the lean. |
| Orientation | Spread | `spread` | 0..180 ° | 12 | yes | yes | Angle between the trunk and the vertical, in degrees. |
| Orientation | Start roll | `startRoll` | -180..180 ° | 0 | yes | yes | Rotates the direction the Start angle is applied in (+ clockwise, - counter-clockwise). |
| Orientation | Pitch | `pitch` | -90..90 ° | 0 | yes | yes | Tilts the starting direction up or down (degrees). |
| Orientation | Roll | `spineRoll` | -180..180 ° | 0 |  |  | Rotates the branch around its own axis by a fixed amount, after Alignment. |
| Orientation | Alignment | `alignment` | 0..1 | 0 |  |  | Blends a random up (0) with the world up (1), so the top of the branch points up. |
| Orientation | Up / down | `upDown` | -2..2 (slider -1..1) | 0.04 |  | yes | Pushes the growth direction up (+) or down (−) along the length. |
| Shape | Gravity | `gravity` | -2..3 (slider -1..1.5) | 0 |  | yes | A downward force on the spine (+ bends down, - bends up). |
| Shape | Curvature | `curvature` | -2..2 (slider -1..1) | 0.03 | yes | yes | Overall bend of the child along its length. |
| Shape | Straightness | `straightness` | 0..1 | 0.35 |  |  | Removes noise: fully at the base, fading to none at the tip. |
| Shape | Twist | `twist` | -720..720 (slider -180..180) ° | 0 | yes | yes | Total twist of the branch around its axis, in degrees. |
| Parent Curl | Up | `curlUp` | -3..3 (slider -1..1) | 0 |  |  | Curl around the parent direction (the branch winds around its parent). |
| Parent Curl | Right | `curlRight` | -3..3 (slider -1..1) | 0 |  |  | Curl around the axis perpendicular to the parent direction and the initial direction. |
| Parent Curl | Out | `curlOut` | -3..3 (slider -1..1) | 0 |  |  | Curl around the axis pointing straight out of the parent. |
| Zigzag | Intensity | `zigzag` | 0..3 (slider 0..1) | 0 |  |  | How sharply the spine changes direction at every zigzag corner (0 = off). |
| Segment length | Absolute | `zigzagLengthAbsolute` | 0..50 (slider 0..2) m | 0 |  | yes | Fixed part of the distance between two zigzag corners. The curve scales the length along the branch. |
| Segment length | + Relative | `zigzagLengthRelative` | 0..1 | 0.1 |  |  | Adds this fraction of the branch length to the distance between two zigzag corners. |
| Radius | Radius | `radius` | 0.001..20 (slider 0.001..2) m | 0.32 | yes | yes | Size: the radius of the cross-section at the base (metres), or the range of an effect. |
| Radius | Radius profile | `radiusProfile` | curve | curve |  |  | Normalized radius multiplier from base (0) to tip (1). |
| Radius | Taper | `taper` | 0..1 | 0.88 |  | yes | How much the radius shrinks from base to tip (1 = pointed). |
| Radius | Min radius | `minRadius` | 0.0005..1 (slider 0.0005..0.05) m | 0.008 |  |  | Smallest radius the child may reach. |
| Early | Amount | `earlyNoiseAmount` | 0..2 (slider 0..0.8) | 0.05 |  | yes | Strength of the noise that bends the spine while it grows (chaotic). The curve changes the strength along the spine. |
| Early | Turbulence | `earlyNoiseFrequency` | 0.05..15 (slider 0.05..5) | 1.2 |  |  | How chaotic the early noise wave is: higher values change direction more often. |
| Early | Threshold | `earlyNoiseThreshold` | 0..1 | 0 |  | yes | Point along the spine that must be passed before the early noise starts. The curve changes where it starts and ends. |
| Late | Amount | `noiseAmount` | 0..5 (slider 0..1.5) | 0.16 |  | yes | Strength of the noise applied after the spine is shaped: organic yet controlled. The curve changes the strength along the spine. |
| Late | Turbulence | `noiseFrequency` | 0..20 (slider 0..6) | 1.1 |  |  | How chaotic the late noise wave is: higher values change direction more often. |
| Late | Smooth | `noiseSmooth` | 0..1 | 0 |  |  | Straightens the applied noise: 1 gives the spine as shaped, with no noise left. |
| Late | Seed | `noiseSeed` | seed | 0 |  |  | Random seed of the late noise only; the early noise and everything else stay the same. |
| Late | Twist | `noiseTwist` | -2..2 (slider -1..1) | 0.1 |  |  | Rotates the late noise as it travels along the spine. |
| Jink | Amount | `jinkAmount` | 0..1 | 0 |  |  | Straightens the spine into linear segments: 0 leaves it unchanged, 1 makes it entirely long straight runs. |
| Jink | Absolute | `jinkAbsolute` | 1..64 (slider 1..16) | 3 |  |  | Minimum number of straight segments. |
| Jink | + Relative | `jinkRelative` | 0..20 (slider 0..4) | 0 |  |  | Adds this many straight segments per metre of branch length. |
| Jink | Uniformity | `jinkUniformity` | 0..1 | 0.5 |  |  | How similar the segment lengths are. At 1 all segments are equally long and the seed has no effect. |
| Jink | Seed | `jinkSeed` | seed | 0 |  |  | Random seed of the Jink segment lengths (no effect at Uniformity 1). |
| Path | Amount | `pathAmount` | 0..20 (slider 0..1) m | 0 |  |  | Size of the path deformation in metres. The Profile curve is the shape of one tile. |
| Path | Profile | `pathProfile` | curve | curve |  |  | Shape of one tile: sideways offset (vertical) along the tile length (horizontal). |
| Path | Twist | `pathTwist` | -720..720 (slider -180..180) °/m | 0 |  |  | Turns the direction of the deformation around the spine, in degrees per metre. |
| Path | Length | `pathLength` | 0.01..100 (slider 0.01..10) m | 1 |  |  | Length of exactly one tile. When it is shorter than the branch the tile repeats. |
| Path | Offset | `pathOffset` | 0..1 | 0 | yes |  | Shifts the tiles along the spine (fraction of one tile). Use the variance to avoid visible repetition between branches. |
| Break | Chance | `breakChance` | 0..1 | 0 |  |  | Probability that a node breaks and ends in an open end (a Cap can close it). |
| Break | Spot | `breakSpot` | 0.02..0.99 | 0.68 | yes |  | Where along the spine the break happens (1 = at the tip). |
| Break | Seed | `breakSeed` | seed | 0 |  |  | Random seed of which nodes break and where; nothing else changes. |
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken | taper |  |  | How the tip ends: taper, blunt or broken. Forks are made by Skin > Splits. |

### Tab: Forces

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Forces | Enabled | `forcesEnabled` | bool | true |  |  | Lets attached forces (gravity, wind direction, …) influence this node. |
| Influence | Influence | `forceInfluence` | 0..10 (slider 0..2) | 1 |  | yes | Global multiplier for all forces on this node. |
| Influence | Stiffness | `forceStiffness` | 0..1 | 0.5 |  | yes | Resistance against forces; stiff branches bend less. |
| Influence | Falloff | `forceFalloff` | 0..1 | 0 |  |  | How the force fades from the base to the tip. |
| Influence | Align | `forceAlign` | 0..2 (slider 0..1) | 1 |  |  | Scalar for the Align strength of every attached force: how much the forces influence the initial orientation (first segment) of this generator's branches. 1 = as set on each force, 0 = branches keep their initial orientation. |

### Tab: Shape

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Cross section | Aspect | `sectionAspect` | 0.1..4 | 1 |  | yes | Width / height ratio of the cross-section (1 = round). |
| Cross section | Roundness | `sectionRoundness` | 0..1 | 1 |  |  | Blend between a round and an angular cross-section. |
| Cross section | Profile | `sectionShape` | Round / Ridged / Lobed / Noise / Organic | round |  |  | Round, Ridged, Lobed, Noise, or Organic: an oval plus lobes whose strength, phase and orientation drift slowly along the trunk (and can spiral). |
| Cross section | Lobes | `sectionLobes` | 1..32 | 5 |  |  | Number of ribs / lobes in the cross-section. |
| Cross section | Depth | `sectionDepth` | 0..1 | 0.12 |  |  | How deep the ribs cut into the cross-section. |
| Cross section | Spiral | `sectionSpiral` | -6..6 rad/m | 0 |  |  | Twists the ribs around the stem. |
| Cross section | Noise frequency | `sectionNoiseFrequency` | 0.1..20 | 2 |  |  | Frequency of the noise in the cross-section. |
| Cross section | Oval (organic) | `sectionOval` | 0..0.6 | 0.1 |  |  | Organic profile: how far the section is stretched into an oval (fraction of the radius). The long axis turns slowly along the trunk. |
| Cross section | Drift length (organic) | `sectionDrift` | 0.05..50 (slider 0.05..10) m | 2 |  |  | Organic profile: metres of trunk for one full change of the oval, the lobe strength and their phase. Small values change quickly. |
| Cross section | Grain twist (organic) | `grainTwist` | -360..360 (slider -360..90) °/m | 0 |  |  | Organic profile: degrees per metre the lobes spiral up the trunk (spiral grain, fluting). Added to Spiral for the lobes only. |
| Flare | Radius | `flareRadius` | 0..5 (slider 0..1.5) | 0.28 |  | yes | Extra radius of the root flare at the base (metres). |
| Flare | Height | `flareHeight` | 0.01..1 | 0.14 |  |  | Height of the root flare as a fraction of the length. |
| Flare | Buttress lobes | `flareLobes` | 0..16 | 5 |  |  | Number of buttress lobes in the flare. |
| Flare | Noise | `flareNoise` | 0..1 | 0 |  |  | Random irregularity of the flare. |
| Bulge | Amount | `bulgeAmount` | 0..2 | 0 |  | yes | Strength of the periodic swelling of the radius. |
| Bulge | Frequency | `bulgeFrequency` | 0.1..20 | 1 |  |  | Number of swellings along the length. |
| Buttress | Count | `buttressCount` | 0..16 | 0 |  |  | Number of tall, thin fins that radiate from the base of the trunk (tropical and old trees). 0 = off. Use at least 8 radial sides per fin. |
| Buttress | Height | `buttressHeight` | 0.05..30 (slider 0.05..6) m | 1.5 |  |  | How far up the trunk the fins climb. The top edge is a concave ridge that runs out into the trunk. |
| Buttress | Length | `buttressLength` | 0..5 (slider 0..3) | 1 |  |  | How far a fin sticks out at the ground, as a multiple of the trunk radius. |
| Buttress | Thickness | `buttressThickness` | 0.02..1 | 0.3 |  |  | Width of the flat ridge of a fin relative to the space between two fins. Thin fins have concave sides. |

### Tab: Skin

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Type & Visibility | Type | `skinType` | Polygons / Spine only / SubD surface (rectangular attachments) (not yet available) / SubD surface (arbitrary attachments) (not yet available) | polygons |  |  | Polygons builds the tube mesh. Spine only builds no mesh: the spine stays available for children such as fronds and leaves. The SubD surface types are not available yet. |
| Type & Visibility | Spine only | `spineOnly` | bool | false |  |  | Legacy switch: use Type instead. |
| Type & Visibility | Visibility | `skinVisibility` | curve | curve |  |  | Runs along the parent (left = base, right = tip). Branches that grow where the curve is above 0.5 get geometry, the others stay invisible but keep their children. |
| Radius | Absolute | `skinRadiusAbsolute` | 0..10 (slider 0..0.5) m | 0 |  |  | Radius in metres added to the base radius of every branch. |
| Radius | Length compensation | `skinLengthCompensation` | 0..1 | 0 |  |  | Enlarges the tip radius of branches that thin out to a point too fast: 1 keeps up to half of the base radius at the tip. |
| Radius | Length kill ratio | `skinLengthKill` | 0..10000 (slider 0..500) | 0 |  |  | Removes branches whose length divided by radius is above this value (very long, thin whips). 0 = off. |
| Irregularity | Amount | `radiusNoiseAmount` | 0..0.6 (slider 0..0.3) | 0 |  | yes | Irregularity of the radius: slow swells and pinches along the branch, as a fraction of the radius (RMS). 0 = a clean taper. The curve runs along the branch (left = base, right = tip). |
| Irregularity | Scale | `radiusNoiseScale` | 0.05..50 (slider 0.05..10) m | 1.5 |  |  | Wavelength of the swells in metres (a second octave at 3x the frequency and 0.4 of the amplitude adds detail). |
| Irregularity | Seed | `radiusNoiseSeed` | seed | 0 |  |  | Random seed of the radius irregularity only; nothing else changes. |
| Irregularity | Along parent | `radiusNoiseParent` | 0..1 (slider 0..1) | 1 |  | yes | Multiplies the irregularity of a child by this curve along its parent (left = parent base, right = parent tip). |
| Radius | Light seam reduction | `seamReduction` | 0..1 | 0 |  |  | Bends the normals toward the spine direction, strongest at the base of a branch where lighting seams show at the junction. |
| Radius | Roll | `skinRoll` | -180..180 ° | 0 |  |  | Rotates the skin around the spine without changing its shape (rotates the section, the squash and the texture). |
| Radius | Smooth | `skinSmooth` | 0..1 | 0 |  |  | Pushes the vertices out on the inner side of bends so the tube does not pinch. |
| Clamp | Min | `skinRadiusMin` | 0..10 (slider 0..0.05) m | 0 |  |  | Smallest radius of any point. 0 = off. |
| Clamp | Max | `skinRadiusMax` | 0..10 (slider 0..1) m | 0 |  |  | Largest radius of any point. 0 = off. |
| Squash | Amount | `squashAmount` | 0..1 | 0 |  |  | Reduces the radius on one side: the section becomes an ellipse (1 = flat). Welds follow the squashed profile. |
| Squash | Rotate | `squashRotate` | -180..180 ° | 0 |  |  | Direction of the flattened side around the spine. |
| Splits | Chance | `splitsChance` | 0..1 | 0 | yes |  | Probability that the branch divides into two open ends at its tip. The U tile count around the branch must be even (at least 2): an odd count is raised to the next even number when the branch splits, and the node reports it as a warning. |
| Splits | Balance | `splitsBalance` | 0..1 | 0.5 | yes |  | 0.5 gives both sides the same radius; lower or higher moves radius from Side 1 to Side 2 (the cross-section area is kept). |
| Splits | Seed | `splitsSeed` | seed | 0 |  |  | Seed of the split decision: changes which branches split without changing anything else. |
| Splits | Fork type | `splitsMode` | Y / Lateral | y |  |  | Y = a symmetric fork (two lobes, Balance and the two Spread angles). Lateral = the branch keeps going with a slight kink and a clearly thinner side branch leaves at the Spread angle from a swelling (the branch-like fork of old oaks); the neck swell, ridge and valley fillet of the junction are applied automatically. |
| Splits | Dominance | `splitsDominance` | 0..1 | 0 | yes |  | Dominant leader. 0 = Balance only. Towards 1 the fat half continues the direction of the branch almost unchanged (its deviation shrinks down to 25 % of its Spread) while the skinny half leaves at its full Spread with a smaller radius. r1^e + r2^e = R^e still holds. Extend parent Fat / Skinny keep working. |
| Splits | Lateral chance | `splitsLateralChance` | 0..1 | 0 | yes |  | Fork type Y only: probability that a fork is a lateral (one-sided) one instead, drawn per fork from the Splits seed, so one tree mixes Y and lateral forks. |
| Split spread | Side 1 | `splitsSpread1` | 0..80 ° | 22 | yes |  | Angle of Side 1 away from the centre of the tree. |
| Split spread | Side 2 | `splitsSpread2` | 0..80 ° | 22 | yes |  | Angle of Side 2 toward the centre of the tree. |
| Split expand | Side 1 | `splitsExpand1` | 0.5..2 | 1 | yes |  | Scales the cross-section of Side 1 from its default (1). |
| Split expand | Side 2 | `splitsExpand2` | 0.5..2 | 1 | yes |  | Scales the cross-section of Side 2 from its default (1). |
| Split smooth | Inner | `splitsSmoothInner` | 0..1 | 0.25 | yes |  | 0 = hard crease between the two sides, 1 = no crease. |
| Split smooth | Outer | `splitsSmoothOuter` | 0..1 | 0.5 | yes |  | Smoothness of the outer bend where the split occurs (0 = hard corner). |
| Split advanced | Area exponent | `splitsAreaExponent` | 1.5..3 | 2 |  |  | Pipe-model exponent e of r1^e + r2^e = parent radius^e. 2 keeps the cross-section area of the parent; higher values make both halves thicker. |
| Split advanced | Down bias | `splitsDownBias` | 0..1 | 0 |  |  | Turns both halves toward gravity after the sides are balanced (roots default to 0.4). A half never points higher than the branch it leaves. |
| Split shape | Waist | `splitsWaist` | 0.2..1 | 1 |  |  | Width of the neck at the middle of the transition relative to the narrower lobe. 1 = the former outline, 0.6 = a pronounced figure-8 (peanut) that pinches and then separates. |
| Split shape | Neck swell | `splitsNeckSwell` | 0..0.5 | 0 |  |  | The parent swells by up to this fraction of its radius just before the fork. The swell is paid from the area reservoir of the lobes: the open ends keep r1^e + r2^e = R^e. |
| Split shape | Valley radius | `splitsValleyRadius` | 0..1 | 0 |  |  | Fillet radius of the valley between the lobes as a fraction of the smaller lobe radius. 0 = the former crease (Smooth > Inner still mixes crease and no crease); the radius fades to 0 at the open ends. |
| Split shape | Ridge | `splitsRidge` | 0..1 | 0 |  |  | Raised bark ridge along the pinch axis from the valley down to the crotch point; height as a fraction of the smaller lobe radius, width about the valley radius. |
| Split shape | Ridge length | `splitsRidgeLength` | 0.25..8 R | 2 |  |  | Length over which the ridge blends into the parent, in parent radii counted back from the crotch. |
| Split shape | Stretch | `splitsStretch` | 0.8..1.6 | 1 |  |  | Elongates the section along the divergence axis early in the transition (ovalisation before the pinch). 1 = none. |
| Split shape | Included bark | `splitsIncludedBark` | 0..1 | 0 | yes |  | Codominant stems with included bark: deepens the valley into a narrow, dark, V-shaped crevice with a bark ridge (smaller valley radius, narrower neck, a ridge, stronger ambient occlusion). 0 = off. |
| Split shape | Ease | `splitsEase` | 0..1 | 0 |  |  | Easing of the separation along the transition: 0 = smoothstep as before, 1 = the lobes stay merged longer and then pinch off suddenly. |
| Geometry | Close end | `capEnd` | bool | true |  |  | Closes the tip of the tube with a cap. |
| Geometry | Tip rings | `tipRings` | 1..8 | 2 |  |  | Rings of the rounded tip cap. |
| Geometry | Close base | `capBase` | Auto / Yes / No | auto |  |  | Auto closes branches that do not grow from a parent. |
| Geometry | Twist | `skinTwist` | -720..720 °/m | 0 |  |  | Twists the surface texture and geometry around the axis. |
| Junction | Collar | `collarAmount` | 0..2 | 0.3 |  |  | Radius flare where a branch leaves its parent. |
| Junction | Collar length | `collarLength` | 0.1..10 | 1.5 |  |  | Length of the flare in branch radii. |
| Junction | Collar swell | `collarSwell` | 0..1 | 0 |  |  | Raised shoulder where the branch meets its parent: the skin around the junction is pushed out by this fraction of the branch radius in a smooth bump (length: Collar length x radius). 0 = off. Not used where Welding is on (Spread does that job). |
| Normals | Smoothing | `smoothing` | 0..1 | 1 |  |  | Below 0.5 the tube is faceted (unwelded quads). |
| Normals | Flatten | `flatten` | 0..1 | 0 |  |  | Flattens normals towards the axis to soften the shading. |
| Vertex color | Tint | `tint` | color | [0.36, 0.26, 0.18, 1] |  |  | Vertex colour multiplied onto the material. |
| Vertex color | Variance | `tintVariance` | 0..1 | 0.1 |  |  | Random variation of the vertex colour per instance. |
| Vertex color | AO strength | `aoStrength` | 0..1 | 0.6 |  |  | Strength of the baked vertex ambient occlusion. |
| Vertex color | Mode | `vcMode` | Inherit / Multiply / Set / Add | inherit |  |  | Inherit: the colour is the bark colour blended with the parent at the junction (earlier behaviour). Multiply: tint it by Color. Set: replace it with Color. Add: brighten it by Color. Profile and Parent curve control where along the branch and along the parent the change applies. |
| Vertex color | Color | `vcColor` | color | [1, 1, 1, 1] |  |  | Linear colour used by Multiply, Set and Add. |
| Vertex color | Variance | `vcVariance` | 0..1 | 0 |  |  | Per-branch brightness variation (+-), deterministic from the seed. 0 = none. |
| Vertex color | Seamless | `vcSeamless` | bool | false |  |  | The colour at the attach point equals the parent colour exactly and blends into this generator's own colour along the collar (needs the parent to be meshed first; falls back to the bark colour otherwise). |
| Vertex color | Profile | `vcProfile` | curve | curve |  |  | Strength of the Mode along this branch (left: base, right: tip). 1 = full effect, 0 = the inherited colour. Use it for lighter young twigs, darker trunk bases or leaf tips. |
| Vertex color | Parent curve | `vcParentCurve` | curve | curve |  |  | Strength of the Mode by the position of the attach point on the parent (left: parent base, right: parent tip). Ignored without a parent. |

### Tab: UV Mapping

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Mapping | Style | `uvStyle` | Unrestricted / U locked [0,1], V unrestricted / U and V locked [0,1] | unrestricted |  |  | Unrestricted lets the coordinates tile freely. The locked styles keep U (or U and V) inside 0..1: one texture copy around the branch, and for U and V locked one along it. Offsets and twist are ignored while locked. |
| Mapping | Rotate 90° | `uvRotate` | bool | false |  |  | Swaps U and V (turns the texture a quarter turn). |
| U | Absolute | `uvUAbsolute` | 0..64 (slider 0..8) | 0 |  |  | Texture copies around the branch regardless of its thickness. The total is always a whole number, at least 1. |
| U | + Relative | `uvURelative` | 0..16 (slider 0..4) | 1 |  |  | Extra copies per metre of circumference, so thick branches get more (1 = one copy per metre of girth, the classic world-size tiling). |
| U | Offset | `uvOffsetU` | -10..10 | 0 | yes |  | Turns the texture around the branch (in copies). The variance turns every branch by a random amount, so the seam faces a different way. |
| Fractional | Enable | `uvFractional` | bool | false |  |  | Allow a fractional number of copies around the branch. The texture no longer closes on itself, so a seam can show. |
| Fractional | Auto | `uvFractionalAuto` | bool | false |  |  | Uses the same texel density as the parent branch (copies per metre of girth). A seam may appear. |
| Fractional | Value | `uvFractionalValue` | 0.01..64 (slider 0.01..8) | 1 |  |  | Free number of copies around the branch; Absolute and Relative are ignored. |
| Twist | Amount | `uvTwist` | -16..16 (slider -2..2) | 0 |  |  | Turns per V tile: the texture spirals around the branch as it runs along it. |
| Twist | Random flip | `uvTwistFlip` | bool | false |  |  | Gives every branch a random spiral direction. |
| V | Style | `uvVStyle` | Absolute / Relative (keep aspect ratio) / Relative | absolute |  |  | Absolute: copies per metre of length. Relative (keep aspect ratio): the texture keeps its proportions, a copy is as long as it is wide. Relative: the texture is stretched over the whole length of the branch. |
| V | Anchor | `uvVAnchor` | Start / End | start |  |  | Which end of the branch lies on a whole V number (End puts a texture edge exactly at the tip). |
| V | Scale | `uvScaleV` | 0.01..100 (slider 0.01..10) | 1 |  |  | Absolute: V copies per metre. Relative (keep aspect ratio): multiplies the density. Relative: the number of copies along the branch. |
| V | Skew correction | `uvSkew` | 0..1 | 0 |  |  | Compensates the narrowing or widening of a tapering branch (0 = the texture tapers with it, 1 = it keeps its proportions everywhere). |
| V | Pinch | `uvPinch` | 0..1 | 0.25 |  |  | Stops the texture from racing along the last stretch of a pointed tip (higher values keep the radius used for V further from zero). |
| V | Offset | `uvOffsetV` | -10..10 | 0 | yes |  | Moves the texture along the branch (in copies). The variance starts every branch at a random V. |
| Tiling | Optimize segments | `uvOptimize` | bool | false |  |  | Avoids rings that are very close together near a patch seam (or a whole V number): the seam moves onto a ring within the V tolerance instead of adding one. |
| Tiling | V tolerance | `uvVTolerance` | 0..0.5 | 0.1 |  |  | How close (in V) a ring must be to a whole number to be moved onto it while Optimize segments is on. |
| Tiling | Create seams | `uvCreateSeams` | bool | false |  |  | Cuts real geometry (doubled ring vertices) at every whole U tile border so each tile around the branch is its own UV island: the branch texture can then sit in an atlas without resolution loss. Positions and normals stay continuous across the cut (the mesh is still watertight when welded). |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Reduction | Side reduction | `lodSides` | 0..1 | 0.5 |  |  | How many sides are removed at lower LODs. |
| Reduction | Segment reduction | `lodSegments` | 0..1 | 0.5 |  |  | How many segments are removed at lower LODs. |
| Reduction | Cull amount | `lodCull` | 0..1 | 0 |  |  | Fraction of small children removed at lower LODs. |
| Distance | Fade start | `lodFadeStart` | 0..1 | 0.5 |  |  | Distance where this node starts fading out. |
| Distance | Fade end | `lodFadeEnd` | 0..1 | 1 |  |  | Distance where this node has completely faded. |
| Dynamic LOD | Weight | `lodWeight` | 0..1 | 0.5 |  |  | Priority to survive when Tree > Dynamic LOD removes pieces of the same type (branches, leaves, fronds, decorations): pieces of a generator with a higher Weight are removed later. 0.5 = neutral; equal weights never change the ranking. |
| Dynamic LOD | Optimization | `lodOptimization` | 0..45 ° | 0 |  |  | Degrees added to the straight-section merge angle (Segments > Optimization) for every LOD step: lower levels merge nearly straight length segments more aggressively. 0 = unchanged. |
| Dynamic LOD | Length segments | `lodLengthSegments` | 0.1..1 | 1 |  |  | Scalar applied to the number of length segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Dynamic LOD | Radial segments | `lodRadialSegments` | 0.1..1 | 1 |  |  | Scalar applied to the number of radial (or width) segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Lightmap | Lightmap weight | `lightmapWeight` | 0..4 | 1 |  |  | Relative texel density of this generator in the lightmap UVs (Tree > Lightmap, export). 1 = the same density as the other generators, 2 = twice the density, 0 = one texel per piece (a leaf gets a single texel). Leaves start at 0; the "Reset lightmap" command restores the defaults. |

### Tab: Displacement

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Main | Source | `displaceSource` | Noise / Material / Displacement / Bark | noise |  |  | Where the height values come from: built-in noise, the Height map of the assigned material, a named asset from the Displacements panel, or procedural Bark relief (see the Bark section). |
| Main | Displacement | `displacement` | None |  |  |  | Height map from the Displacements panel. A warning badge shows on the node when the map is missing or not loaded. |
| Main | Radial amount | `displaceRadial` | -5..5 (slider -0.3..0.3) m | 0 |  |  | Largest move away from (positive) or toward (negative) the spine, in metres. |
| Main | Length amount | `displaceLength` | -5..5 (slider -0.3..0.3) m | 0 |  |  | Largest move along the spine, in metres. Vertices that share a V coordinate no longer sit in one plane. |
| Main | Sharpness | `displaceSharpness` | curve | curve |  |  | Remaps the displacement values. A straight line leaves them unchanged; a curve that stays low and rises late keeps only the highest values. |
| Main | Mapping | `displaceMapping` | Use UVs / Fit to geometry | use-uvs |  |  | Use UVs follows the branch UV tiling; Fit to geometry wraps the pattern once around and once along the branch. |
| Main | U scale | `displaceUScale` | 0.05..50 (slider 0.05..10) | 1 |  |  | Pattern size around the branch (larger = more repeats). |
| Main | V scale | `displaceVScale` | 0.05..50 (slider 0.05..10) | 1 |  |  | Pattern size along the branch (larger = more repeats). |
| Main | Seed | `displaceMainSeed` | 0..99999 | 0 |  |  | Random seed of the noise source. |
| Fine | Amount | `displaceFineAmount` | -2..2 (slider -0.1..0.1) m | 0 |  |  | Second, always-noise displacement along the surface normal, added on top of the main one. |
| Fine | Sharpness | `displaceFineSharpness` | curve | curve |  |  | Remaps the fine noise values (straight line = unchanged). |
| Fine | Scale | `displaceFineScale` | 0.1..8 (slider 0.1..3) | 1 |  |  | Size of the fine noise. Above 1 the surface is pushed out on average, below 1 it is pulled in toward the center. |
| Shape | Amount | `displaceShapeAmount` | -1..1 | 0 |  |  | Depth of the creases that run along the spine, as a fraction of the local radius. |
| Shape | Twist | `displaceShapeTwist` | -720..720 (slider -90..90) °/m | 0 |  |  | Rotates the crease pattern around the spine while it climbs from the base (degrees per metre). |
| Shape | Scale | `displaceShapeScale` | 0.1..10 (slider 0.1..4) | 1 |  |  | Number of creases around the branch (larger = more, thinner creases). |
| Shape | Seed | `displaceShapeSeed` | seed | 0 |  |  | Displacement setting (height-map driven surface detail). “Seed” in Displacement › Shape. |
| Flares | Radius | `displaceFlareRadius` | 0..8 (slider 0..2) | 0 |  |  | Largest flare, as a multiple of the branch radius at its base. 0 turns the flares off. |
| Flares | Noise scale | `displaceFlareNoise` | 1..32 | 5 |  |  | Number of flare lobes around the branch. |
| Flares | Height | `displaceFlareHeight` | 0.01..50 (slider 0.01..5) m | 1 |  |  | How far up the spine the flares reach. |
| Flares | Pinch | `displaceFlarePinch` | 0..1 | 0 |  |  | Pulls the flares toward the center spine. At 1 the lobes are thin ridges and nothing spreads at the base. |
| Flares | Angle | `displaceFlareAngle` | -180..180 ° | 0 |  |  | Rotates the flares around the spine. |
| Flares | Seed | `displaceFlareSeed` | seed | 0 |  |  | Displacement setting (height-map driven surface detail). “Seed” in Displacement › Flares. |
| Bark | Style | `barkStyle` | Furrowed / Plated / Fibrous / Lenticel / Rings / Scaly | furrowed |  |  | Furrowed: long ridges and V-shaped crevices (oak, pine, elm). Plated: blocky plates between cracks (redwood, old bark). Fibrous: thin parallel fibres (cedar). Lenticel: smooth bark with short horizontal slits (cherry, birch). Rings: regular horizontal rings (palm, bamboo). Scaly: overlapping scales (cypress). |
| Bark | Depth | `barkDepth` | 0..1 (slider 0..0.3) | 0 |  |  | Relief from crevice bottom to ridge top as a fraction of the local radius, so thick trunks get deep furrows. 0 turns the bark relief off. |
| Bark | Scale | `barkScale` | 0.005..5 (slider 0.005..0.5) m | 0.08 |  |  | Feature size in metres (furrow spacing, plate width, ring spacing). Independent of UV tiling and of the number of rings. |
| Bark | Stretch | `barkStretch` | 0.1..40 (slider 0.1..12) | 4 |  |  | Feature length along the spine compared with its width (furrows, plates, fibres, scales). Lenticel: slit width across the trunk. Rings: not used. |
| Bark | Warp | `barkWarp` | 0..2 | 0.5 |  |  | Domain warp strength: how much the furrows, cracks and rings meander instead of running straight. |
| Bark | Crevice | `barkCrevice` | 0..1 | 0.5 |  |  | Crevice profile: 1 = narrow V-shaped crevices with wide tops, 0.5 = linear, 0 = wide flat-bottomed troughs. Works like the Main Sharpness curve and stacks with it. |
| Bark | Maturity | `barkMaturity` | 0..1 | 0 |  |  | How strongly the depth follows the branch radius: 0 = every branch has the same relief, 1 = young thin twigs are smooth and old thick trunks get the full depth. |
| Bark | Smooth up to radius | `barkMaturityMin` | 0..5 (slider 0..0.3) m | 0.01 |  |  | Radius at and below which the bark is smooth (Maturity > 0). A smoothstep leads to the full depth at the next radius. |
| Bark | Full depth at radius | `barkMaturityMax` | 0.001..5 (slider 0.001..0.5) m | 0.15 |  |  | Radius from which the bark has its full depth (Maturity > 0). |
| Bark | Maturity along branch | `barkMaturityCurve` | curve | curve |  |  | Depth multiplier from the base (left) to the tip (right) of each branch. A flat line at 1 leaves the depth unchanged. |
| Bark | Seed | `barkSeed` | seed | 0 |  |  | Random seed of the bark pattern. Every branch lineage also gets its own pattern. |
| Fade | Fade at junctions | `displaceFadeBase` | 0..10 | 1.5 |  |  | Fade-in length (in radii) past the weld / junction rings: prevents cracks where a branch leaves its parent. |
| Fade | Fade at tips | `displaceFadeTip` | 0..10 | 1 |  |  | Fade-out length (in radii) toward the tip / cap. |
| Fade | LOD fade | `displaceLodFade` | bool | true |  |  | Fade the displacement out between LOD 1 and 3. |
| Subdivision | Auto-subdivide | `displaceAutoSubdivide` | bool | true |  |  | Add rings and sides so the mesh has enough vertices to carry the displacement. |
| Subdivision | Detail size | `displaceDetail` | 0.002..1 (slider 0.002..0.2) m | 0.03 |  |  | Target quad size when auto-subdividing (smaller = more detail, more triangles). |
| Subdivision | Max vertices | `displaceMaxVertices` | 500..1000000 (slider 500..200000) | 40000 |  |  | Bark: most vertices auto-subdivision may create for one branch, so a small Scale cannot freeze the browser. Features coarsen when the cap is reached. |
| Subdivision | Min sides | `displaceMinSides` | 3..128 | 16 |  |  | Fewest sides around a displaced branch. |
| Asset amount (legacy) | Amount | `displaceAmount` | -5..5 (slider 0..0.2) m | 0 |  | yes | Older asset displacement in metres at full height. The curve scales it along the branch length. |
| Asset amount (legacy) | + % of radius | `displaceRadiusAmount` | -1..2 | 0 |  |  | Extra amount relative to the local radius. |
| Asset amount (legacy) | Offset | `displaceOffset` | -1..1 | 0 |  |  | Bias added to the height before scaling. |
| Asset amount (legacy) | Mid-grey is neutral | `displaceMidGrey` | bool | true |  |  | On: 50% grey does not move the surface. Off: black = none, white = full amount outward. |
| Asset amount (legacy) | Direction | `displaceDirection` | Normal / Radial | normal |  |  | Displace along the surface normal or radially from the axis. |
| Asset mapping (legacy) | Tiling | `displaceTiling` | World / Normalized | world |  |  | World: one image tile covers "Tile size" metres. |
| Asset mapping (legacy) | Tile size | `displaceTileSize` | 0.005..50 (slider 0.005..4) m | 0.5 |  |  | World size of one displacement tile. |
| Asset mapping (legacy) | Scale | `displaceScale` | 0.01..50 | 1 |  |  | Height of the displacement. |
| Asset mapping (legacy) | Scale U | `displaceScaleU` | 0.01..50 | 1 |  |  | Displacement tiling around the stem. |
| Asset mapping (legacy) | Scale V | `displaceScaleV` | 0.01..50 | 1 |  |  | Displacement tiling along the stem. |
| Asset mapping (legacy) | Rotation | `displaceRotation` | -360..360 ° | 0 |  |  | Snapped to 90° steps while seams are locked. |
| Asset mapping (legacy) | Lock seams | `displaceLockSeams` | bool | true |  |  | Round the tiling around the trunk to a whole number so the U seam is continuous. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Material | Material | `material` | None |  |  |  | Material (or Material Set) used for this node; empty = the default for the node type. |
| Material | Tint | `materialTint` | color | [1, 1, 1, 1] |  |  | Colour multiplied onto the material. |
| Material | Variation | `materialVariation` | 0..1 | 0 | yes |  | How much the material variation colours are applied. |
| Blend | Base blend | `blendBase` | 0..1 | 0 |  | yes | Blends the material towards the parent at the base. |
| Blend | Height blend | `blendHeight` | 0..1 | 0 |  |  | Blends the material along the height. |
| Season | Start offset | `seasonStartOffset` | -1..1 (slider -1..1) | 0 | yes | yes | Season start offset: 0 = the transition follows the Season slider immediately, positive values delay it, negative values start it earlier. Variance spreads it per element; the curve runs along the parent. |
| Season | Time scale | `seasonTimeScale` | 0..10 (slider 0..2) | 1 | yes | yes | Season time scale: 1 = one slider sweep is one year of this node; 2 = twice as fast, 0 = never changes. |
| Season | Descendant offset | `seasonDescendantOffset` | -1..1 (slider -1..1) | 0 | yes |  | Season descendant offset: shifts the transition of this node AND of every node below it (positive = later). Use it so that thin twigs change after the trunk. |

### Tab: Animation

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Wind hierarchy | Hierarchy | `windHierarchy` | Trunk / Branch 1 / Branch 2 / Leaf | branch-1 |  |  | Which level of the wind hierarchy this geometry follows (trunk, branch 1/2, leaf). |
| Amount | Amount | `windAmount` | 0..10 (slider 0..2) | 1 |  | yes | Strength multiplier of the wind on this node. |
| Amount | Phase variance | `windPhaseVariance` | 0..1 | 0.5 |  |  | Random phase offset of the branch-level sway (0 = a branch sways in phase with the branch it grows from, 1 = fully random) so neighbours do not sway in sync. Deeper twigs and leaves always keep the phase of their level-1 ancestor. |

### Tab: Segments

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
|  | Accuracy | `accuracy` | 4..256 | 36 |  |  | Exact number of points of the high-resolution spine the branch is built from (higher = smoother, slower). |
|  | Influence | `segmentInfluence` | 0..4 (slider 0..2) | 1 |  |  | Scales how strongly forces and spine properties act per accurate segment. 1 keeps the shape when Accuracy changes. |
|  | Scalar | `segmentScalar` | 0.1..4 (slider 0.1..2) | 1 |  |  | Multiplies the polygon count of the mesh (length and radial segments). |
| Length | Style | `lengthStyle` | Default / Legacy | default |  |  | Default builds the accurate layout with the relative basis; Legacy keeps the older layout (relative segments per metre). |
| Length | Absolute | `segments` | 1..512 | 24 |  |  | Minimum number of length segments. |
| Length | + Relative | `relativeSegments` | 0..20 (slider 0..2) | 0 |  |  | Adds more length segments, multiplied by the Relative basis. |
| Length | Relative basis | `relativeBasis` | Length only / Length/radius ratio / Parent's length segments | length-radius-ratio |  |  | What + Relative is multiplied by: the branch length, its length / radius ratio (recommended) or the length segments of the parent. |
| Length | Weld scalar | `weldScalar` | 0..4 (slider 0..2) | 1 |  |  | Scales the number of segments in the weld part, where the branch is fused to its parent. |
| Length | Optimization | `optimization` | 0..45 ° | 0 |  |  | Drops segments where the spine is nearly straight: the larger the value, the bigger the bend must be to keep a segment (0 = keep all). |
| Radial | Absolute | `sides` | 0..64 | 12 |  |  | Minimum number of radial segments (sides). |
| Radial | + Relative | `radialRelative` | 0..200 (slider 0..40) | 0 |  |  | Adds radial segments, multiplied by the Relative basis. |
| Radial | Relative basis | `radialBasis` | Radius / Parent's radial segments | radius |  |  | What + Relative is multiplied by: the branch radius in metres or the radial segments of the parent. |

### Tab: Physics _(not implemented yet - shown disabled)_

### Tab: Hand Drawn

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Hand drawn | Enabled | `handDrawn` | bool | false |  |  | Enables hand-drawn control of the spine shape. |
| Hand drawn | Strength | `handStrength` | 0..1 | 1 |  |  | Strength of the hand-drawn influence. |
| Hand drawn | Smoothing | `handSmoothing` | 0..1 | 0.5 |  |  | Smoothing of the hand-drawn spine. |

## Branch (`generator.branch`)

Procedural branches grown along parent skeletons with phyllotaxis, whorls, bifurcations, and pruning.

### Tab: Gen

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Generation | Mode | `mode` | Absolute / Proportional / Absolute steps / Proportional steps / Phyllotaxy / Interval / Bifurcation / Flood / Parent / Density / Classic (legacy) | absolute |  |  | How children are placed on the parent: an exact number, proportional to its length, in steps (whorls), by phyllotaxy, at intervals, at bends, flooded along it or all at its origin. |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 12 | yes | yes | Exact number of nodes created on each parent. |
| Absolute | Jumble | `jumble` | 0..1 | 0.2 |  | yes | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | yes | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | yes | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | yes | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | yes | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  |  | Random variation of the spacing in Density mode. |
| Proportional | Frequency | `proportionalCount` | 0..50 (slider 0..10) /m | 2.5 |  |  | Nodes per metre of parent length: longer parents get more nodes, spread at random along them. |
| Steps | Steps | `whorlCount` | 1..128 | 5 |  |  | Number of steps (rings of nodes) along the parent. |
| Steps | Steps | `stepsFrequency` | 0..20 (slider 0..5) /m | 0.5 |  |  | Steps per metre of parent length. |
| Steps | Per step | `whorlPerStep` | 1..128 (slider 1..24) | 4 |  |  | Nodes in every step. |
| Steps | Spread | `whorlSpread` | 0..1 | 0.03 |  |  | Lengthwise spacing of the nodes inside one step, as a fraction of the First..Last stretch. |
| Steps | Roll | `whorlRoll` | -180..180 ° | 15 |  |  | Rotation of every step relative to the previous one. |
| Steps | Balance | `stepsBalance` | 0..1 | 1 |  |  | How evenly the nodes of a step are spaced around the parent (1 = evenly, 0 = random). |
| Phyllotaxy | Style | `phyllotaxyStyle` | Opposite (distichous) / Opposite (decussate) / Opposite (random orientation) / Alternating (distichous) / Alternating (random) / Whorled | alternating-distichous- |  |  | How the nodes of a group are arranged and how consecutive groups are turned against each other. |
| Phyllotaxy | Internode length | `phyllotaxyInternode` | 0..50 (slider 0..2) m | 0.25 |  |  | Distance between groups, measured along the parent from Last towards First. 0 spreads Limit groups evenly instead. |
| Phyllotaxy | Children per node | `phyllotaxyChildren` | 1..32 | 3 |  |  | Nodes in each whorled group. |
| Phyllotaxy | Spread | `phyllotaxySpread` | 0..1 | 0 |  |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Phyllotaxy | Spiral | `phyllotaxySpiral` | -180..180 ° | 0 |  |  | Extra rotation added for every group. |
| Phyllotaxy | Limit | `phyllotaxyLimit` | 0..10000 (slider 0..100) | 0 |  |  | Maximum number of groups (0 = no limit). |
| Phyllotaxy | Align style | `phyllotaxyAlignStyle` | Group / Individual | group |  |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Frequency | `intervalStep` | 0.001..50 (slider 0.001..3) m | 0.6 |  | yes | Distance between groups from Last towards First. The curve scales it along the parent: lower values pack groups tighter. |
| Interval | Count | `perStep` | 1..64 (slider 1..16) | 1 |  |  | Nodes in every group. |
| Interval | Spread | `intervalSpread` | 0..1 | 0 |  |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Interval | Spiral | `intervalSpiral` | -180..180 ° | 0 |  |  | Extra rotation added for every group. |
| Interval | Limit | `intervalLimit` | 0..10000 (slider 0..100) | 0 |  |  | Maximum number of groups (0 = no limit). |
| Interval | Align style | `intervalAlignStyle` | Group / Individual | group |  |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Balance | `intervalBalance` | 0..1 | 0 |  |  | Turns every other group so its nodes fill the gaps left by the previous group. |
| Bifurcation | Count | `bifurcationCount` | 0..1000 (slider 0..32) | 4 |  |  | Maximum number of nodes; the strongest bends win. |
| Bifurcation | Threshold | `bifurcationThreshold` | 0.5..90 ° | 6 |  |  | Smallest bend of the parent that gets a node. |
| Bifurcation | Spread | `bifurcationSpread` | 0..1 | 0 |  |  | Random shift of every node along the parent (1 = 10 % of its length). |
| Bifurcation | Min spacing | `bifurcationSpacing` | 0.01..0.9 | 0.12 |  |  | Smallest distance between two bends, as a fraction of the parent. |
| Alignment | Align | `align` | bool | false |  |  | Rolls the new nodes so they face the sky. |
| Boundaries | First | `first` | 0..1 | 0.2 |  | yes | Lowest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 0.95 |  | yes | Highest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0 |  |  | With the checkbox on, nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary. The value insets the range (fraction of First..Last). |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  |  | Removes nodes that Spread or Position push outside First..Last. |
| Common | Active | `active` | bool | true |  | yes | Switches the generator on. With a curve over the level of detail (left = highest detail) it is active where the curve is above 0.5. |
| Common | Pass | `pass` | 1..99 | 1 |  |  | Generators compute in pass order. A node cannot have a lower pass than any of its ancestors. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes |  | Rotates all nodes around the parent spine as a group. Variance jumbles the rotation per parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes |  | Shifts all nodes along the parent (fraction of its length). Variance shifts every parent differently. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes |  | Start offset of the nodes into (+) or out of (-) the parent; sinks trunks under the ground. |
| Common | Pruning | `pruningCurve` | curve | curve |  |  | Runs over the parent from First (left) to Last (right). Nodes are removed where the curve is below 0.5. |
| Common | Seed | `seed` | seed | 0 |  |  | Random seed. Change it to get a different variation of the same settings. |
| Extend parent | Type | `extendParent` | None / Any / Split 1 / Split 2 / Skinny / Fat / Breaks only / Bottom | none |  |  | Continues an open end of the parent instead of starting a new branch. Valid only under a Branch, Trunk or Root parent. On a Root generator Bottom continues the base ring of the trunk (roots never start on split halves). Any = every open end (the two sides of a split count, the split branch itself does not), Split 1 / Split 2 = that side, Skinny / Fat = the thinner / thicker side, Breaks only = branches that broke, Bottom = the base of the parent. |
| Extend parent | Count | `extendCount` | 1..8 | 1 |  |  | Extensions created per open end (several extensions on one end separate by Extensions > Spread). |
| Knockout | Amount | `knockout` | 0..1 | 0 |  | yes | Randomly removes this share of the nodes after the mode has placed them. The curve varies it along the parent. |
| Knockout | + Resolution | `knockoutResolution` | -1..1 | 0 |  |  | Added to the amount for every level of detail below the highest: positive removes more nodes at lower detail, negative fewer. |
| Limits | Sub-generations | `generations` | 1..5 | 1 |  |  | Recursive branching levels evaluated inside this generator (1 = single level). |
| Limits | Max generation | `maxGeneration` | 1..16 | 8 |  |  | Maximum hierarchy generation depth allowed for branches. |
| Force containers | Include | `forceInclude` | list | [] |  |  | Keeps only the nodes inside the volume of the named Force node (set a volume in the Force node). |
| Force containers | Exclude | `forceExclude` | list | [] |  |  | Removes the nodes inside the volume of the named Force node. |
| More | Click place | `clickPlace` | Ready / None / Any / Number | ready |  |  | What a click in the viewport places. It is stored with the node and takes effect with Freehand mode. |
| More | Size scalar | `sizeScalar` | 0.01..100 (slider 0.01..5) | 1 |  |  | Scales this node and every node below it. |
| Masks | Mask | `genMasks` | list | [] |  |  | Keeps a node only where every assigned mask (Masks panel) evaluates to 0.5 or more. |
| Tree placement | Distribution | `distMode` | Parametric / Uniform / Poisson disk / Ring / Grid / Spiral | uniform |  |  | How Number instances fill the Tree disc. Uniform = area-correct random (r = R*sqrt(u)); Poisson disk = blue noise with a minimum distance. |
| Tree placement | Position | `distPosition` | 0..1 | 0.5 | yes |  | Normalised distance from the disc centre (0 = centre, 1 = edge), with variance. |
| Tree placement | Rotation | `distRotation` | 0..1 | 0 | yes |  | Normalised angle around the centre (0..1 = 0..360 degrees), with variance. |
| Tree placement | Min distance | `distMinDistance` | 0..1000 (slider 0..10) m | 0.5 |  |  | Minimum distance between first-generation elements placed on the ground. |
| Tree placement | Splay | `distSplay` | 0..85 ° | 0 |  |  | Outward tilt reached at the disc edge (ferns, bushes). Ignored when Unify child orientation is on. |

### Tab: Spine

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Length | Absolute | `length` | 0..500 (slider 0..20) m | 3.2 | yes | yes | Fixed part of the length in metres. The curve scales the length along the parent. |
| Length | + % of parent | `lengthPercent` | 0..2 (slider 0..1) | 0.08 |  | yes | Adds this fraction of the parent length (1 = as long as the parent). |
| Length | + % of radius | `lengthPercentRadius` | 0..500 (slider 0..100) | 0 |  |  | Adds this many parent radii to the length. |
| Length | Match one V tile | `matchOneVTile` | bool | false |  |  | Sets the length to exactly one V tile of the material, from its aspect ratio and the branch radius, and maps V from 0 to 1. |
| Length | Stop shape control | `stopShapeControl` | bool | false |  |  | Ignores the crown shape envelope and the generation damping, so this node is not shaped by its ancestors. |
| Length | Shape scale | `shapeScale` | 0..5 (slider 0..2) | 1 |  |  | Strength of the crown shape on the length: 0 = off, 1 = as drawn, above 1 = exaggerated. |
| Length | Limit length | `lengthLimit` | bool | false |  |  | Prevents children from becoming longer than the Absolute length. |
| Length | Crown envelope | `crownShape` | Natural / Conical / Oval / Vase / Columnar / Custom | natural |  |  | Branch length as a function of the normalised height on the parent: cone (conifer), oval (oak), vase, column or a custom curve. |
| Length | Crown curve | `crownCurve` | curve | curve |  |  | Length multiplier from parent base (0) to tip (1). |
| Clamp | Min | `lengthMin` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no minimum. |
| Clamp | Max | `lengthMax` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no maximum. |
| Orientation | Start angle | `spread` | 0..180 ° | 48 | yes | yes | Angle to the parent in degrees: 0 = parent direction, 90 = perpendicular, 180 = opposite. |
| Orientation | Start roll | `startRoll` | -180..180 ° | 0 | yes | yes | Rotates the direction the Start angle is applied in (+ clockwise, - counter-clockwise). |
| Orientation | Pitch | `pitch` | -90..90 ° | 0 | yes | yes | Tilts the starting direction up or down (degrees). |
| Orientation | Roll | `spineRoll` | -180..180 ° | 0 |  |  | Rotates the branch around its own axis by a fixed amount, after Alignment. |
| Orientation | Alignment | `alignment` | 0..1 | 0.2 |  |  | Blends a random up (0) with the world up (1), so the top of the branch points up. |
| Orientation | Up / down | `upDown` | -2..2 (slider -1..1) | 0.06 |  | yes | Pushes the growth direction up (+) or down (−) along the length. |
| Orientation | Unify | `unify` | bool | false |  |  | Nodes on opposite sides of the parent share the same orientation (mirrored roll). |
| Orientation | Weld start | `weldStart` | bool | false |  |  | For Spine only branches: starts on the skin of the parent instead of on its spine. |
| Shape | Gravity | `gravity` | -2..3 (slider -1..1.5) | 0.16 |  | yes | A downward force on the spine (+ bends down, - bends up). |
| Shape | Ancestor | `ancestor` | -1..1 | 0 |  | yes | + grows towards the direction of the parent, like a bud; - grows away from it. |
| Shape | Curvature | `curvature` | -2..2 (slider -1..1) | 0.06 | yes | yes | Overall bend of the child along its length. |
| Shape | Straightness | `straightness` | 0..1 | 0.2 |  |  | Removes noise: fully at the base, fading to none at the tip. |
| Shape | Twist | `twist` | -720..720 (slider -180..180) ° | 0 | yes | yes | Total twist of the branch around its axis, in degrees. |
| Parent Curl | Up | `curlUp` | -3..3 (slider -1..1) | 0 |  |  | Curl around the parent direction (the branch winds around its parent). |
| Parent Curl | Right | `curlRight` | -3..3 (slider -1..1) | 0 |  |  | Curl around the axis perpendicular to the parent direction and the initial direction. |
| Parent Curl | Out | `curlOut` | -3..3 (slider -1..1) | 0 |  |  | Curl around the axis pointing straight out of the parent. |
| Zigzag | Intensity | `zigzag` | 0..3 (slider 0..1) | 0 |  |  | How sharply the spine changes direction at every zigzag corner (0 = off). |
| Segment length | Absolute | `zigzagLengthAbsolute` | 0..50 (slider 0..2) m | 0 |  | yes | Fixed part of the distance between two zigzag corners. The curve scales the length along the branch. |
| Segment length | + Relative | `zigzagLengthRelative` | 0..1 | 0.1 |  |  | Adds this fraction of the branch length to the distance between two zigzag corners. |
| Radius | Radius | `radius` | 0.001..20 (slider 0.001..0.5) m | 0.06 | yes | yes | Size: the radius of the cross-section at the base (metres), or the range of an effect. |
| Radius | % of parent | `parentRadiusInfluence` | 0..1 | 0.4 |  | yes | Makes the radius a percentage of the parent radius at the attachment point. |
| Radius | Max parent ratio | `parentRadiusMax` | 0.05..1.5 | 0.82 |  |  | Upper limit of the child radius relative to the parent. |
| Radius | Radius profile | `radiusProfile` | curve | curve |  |  | Normalized radius multiplier from base (0) to tip (1). |
| Radius | Taper | `taper` | 0..1 | 0.88 |  | yes | How much the radius shrinks from base to tip (1 = pointed). |
| Radius | Min radius | `minRadius` | 0.0005..1 (slider 0.0005..0.05) m | 0.002 |  |  | Smallest radius the child may reach. |
| Early | Amount | `earlyNoiseAmount` | 0..2 (slider 0..0.8) | 0.08 |  | yes | Strength of the noise that bends the spine while it grows (chaotic). The curve changes the strength along the spine. |
| Early | Turbulence | `earlyNoiseFrequency` | 0.05..15 (slider 0.05..5) | 1.2 |  |  | How chaotic the early noise wave is: higher values change direction more often. |
| Early | Threshold | `earlyNoiseThreshold` | 0..1 | 0 |  | yes | Point along the spine that must be passed before the early noise starts. The curve changes where it starts and ends. |
| Late | Amount | `noiseAmount` | 0..5 (slider 0..1.5) | 0.2 |  | yes | Strength of the noise applied after the spine is shaped: organic yet controlled. The curve changes the strength along the spine. |
| Late | Turbulence | `noiseFrequency` | 0..20 (slider 0..6) | 1.1 |  |  | How chaotic the late noise wave is: higher values change direction more often. |
| Late | Smooth | `noiseSmooth` | 0..1 | 0 |  |  | Straightens the applied noise: 1 gives the spine as shaped, with no noise left. |
| Late | Seed | `noiseSeed` | seed | 0 |  |  | Random seed of the late noise only; the early noise and everything else stay the same. |
| Late | Twist | `noiseTwist` | -2..2 (slider -1..1) | 0 |  |  | Rotates the late noise as it travels along the spine. |
| Jink | Amount | `jinkAmount` | 0..1 | 0 |  |  | Straightens the spine into linear segments: 0 leaves it unchanged, 1 makes it entirely long straight runs. |
| Jink | Absolute | `jinkAbsolute` | 1..64 (slider 1..16) | 3 |  |  | Minimum number of straight segments. |
| Jink | + Relative | `jinkRelative` | 0..20 (slider 0..4) | 0 |  |  | Adds this many straight segments per metre of branch length. |
| Jink | Uniformity | `jinkUniformity` | 0..1 | 0.5 |  |  | How similar the segment lengths are. At 1 all segments are equally long and the seed has no effect. |
| Jink | Seed | `jinkSeed` | seed | 0 |  |  | Random seed of the Jink segment lengths (no effect at Uniformity 1). |
| Path | Amount | `pathAmount` | 0..20 (slider 0..1) m | 0 |  |  | Size of the path deformation in metres. The Profile curve is the shape of one tile. |
| Path | Profile | `pathProfile` | curve | curve |  |  | Shape of one tile: sideways offset (vertical) along the tile length (horizontal). |
| Path | Twist | `pathTwist` | -720..720 (slider -180..180) °/m | 0 |  |  | Turns the direction of the deformation around the spine, in degrees per metre. |
| Path | Length | `pathLength` | 0.01..100 (slider 0.01..10) m | 1 |  |  | Length of exactly one tile. When it is shorter than the branch the tile repeats. |
| Path | Offset | `pathOffset` | 0..1 | 0 | yes |  | Shifts the tiles along the spine (fraction of one tile). Use the variance to avoid visible repetition between branches. |
| Break | Chance | `breakChance` | 0..1 | 0 |  |  | Probability that a node breaks and ends in an open end (a Cap can close it). |
| Break | Spot | `breakSpot` | 0.02..0.99 | 0.68 | yes |  | Where along the spine the break happens (1 = at the tip). |
| Break | Seed | `breakSeed` | seed | 0 |  |  | Random seed of which nodes break and where; nothing else changes. |
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken | taper |  |  | How the tip ends: taper, blunt or broken. Forks are made by Skin > Splits. |
| Extensions | Length scale | `extensionLengthScale` | 0.1..3 | 1 |  |  | Scales the spine length of the extensions made by this node (see Generation > Extend parent). |
| Extensions | Spread | `extensionSpread` | 0..90 ° | 0 |  | yes | Separates extensions that share one open end (Count above 1). The curve sets how much of the spread applies along the length. |
| Prune | Interior | `pruneInterior` | 0..1 | 0 |  | yes | Removes branches that grow towards the inside of the model. The curve scales it along the parent. |
| Prune | Up | `pruneUp` | 0..1 | 0 |  | yes | Removes branches that grow upwards (the steeper, the more likely). |
| Prune | Down | `pruneDown` | 0..1 | 0 |  | yes | Removes branches that grow downwards (the steeper, the more likely). |
| Prune | General | `pruneGeneral` | 0..1 | 0 |  | yes | Removes branches at random with this probability. |
| Prune | Ground | `pruneGround` | 0..1 | 1 |  | yes | Removes branches that intersect the ground plane (strength = probability). |

### Tab: Forces

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Forces | Enabled | `forcesEnabled` | bool | true |  |  | Lets attached forces (gravity, wind direction, …) influence this node. |
| Influence | Influence | `forceInfluence` | 0..10 (slider 0..2) | 1 |  | yes | Global multiplier for all forces on this node. |
| Influence | Stiffness | `forceStiffness` | 0..1 | 0.5 |  | yes | Resistance against forces; stiff branches bend less. |
| Influence | Falloff | `forceFalloff` | 0..1 | 0 |  |  | How the force fades from the base to the tip. |
| Influence | Align | `forceAlign` | 0..2 (slider 0..1) | 1 |  |  | Scalar for the Align strength of every attached force: how much the forces influence the initial orientation (first segment) of this generator's branches. 1 = as set on each force, 0 = branches keep their initial orientation. |

### Tab: Shape

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Cross section | Aspect | `sectionAspect` | 0.1..4 | 1 |  | yes | Width / height ratio of the cross-section (1 = round). |
| Cross section | Roundness | `sectionRoundness` | 0..1 | 1 |  |  | Blend between a round and an angular cross-section. |
| Cross section | Profile | `sectionShape` | Round / Ridged / Lobed / Noise / Organic | round |  |  | Round, Ridged, Lobed, Noise, or Organic: an oval plus lobes whose strength, phase and orientation drift slowly along the trunk (and can spiral). |
| Cross section | Lobes | `sectionLobes` | 1..32 | 5 |  |  | Number of ribs / lobes in the cross-section. |
| Cross section | Depth | `sectionDepth` | 0..1 | 0.12 |  |  | How deep the ribs cut into the cross-section. |
| Cross section | Spiral | `sectionSpiral` | -6..6 rad/m | 0 |  |  | Twists the ribs around the stem. |
| Cross section | Noise frequency | `sectionNoiseFrequency` | 0.1..20 | 2 |  |  | Frequency of the noise in the cross-section. |
| Cross section | Oval (organic) | `sectionOval` | 0..0.6 | 0.1 |  |  | Organic profile: how far the section is stretched into an oval (fraction of the radius). The long axis turns slowly along the trunk. |
| Cross section | Drift length (organic) | `sectionDrift` | 0.05..50 (slider 0.05..10) m | 2 |  |  | Organic profile: metres of trunk for one full change of the oval, the lobe strength and their phase. Small values change quickly. |
| Cross section | Grain twist (organic) | `grainTwist` | -360..360 (slider -360..90) °/m | 0 |  |  | Organic profile: degrees per metre the lobes spiral up the trunk (spiral grain, fluting). Added to Spiral for the lobes only. |
| Flare | Radius | `flareRadius` | 0..5 (slider 0..1.5) | 0 |  | yes | Extra radius of the root flare at the base (metres). |
| Flare | Height | `flareHeight` | 0.01..1 | 0.14 |  |  | Height of the root flare as a fraction of the length. |
| Flare | Buttress lobes | `flareLobes` | 0..16 | 5 |  |  | Number of buttress lobes in the flare. |
| Flare | Noise | `flareNoise` | 0..1 | 0 |  |  | Random irregularity of the flare. |
| Bulge | Amount | `bulgeAmount` | 0..2 | 0 |  | yes | Strength of the periodic swelling of the radius. |
| Bulge | Frequency | `bulgeFrequency` | 0.1..20 | 1 |  |  | Number of swellings along the length. |
| Buttress | Count | `buttressCount` | 0..16 | 0 |  |  | Number of tall, thin fins that radiate from the base of the trunk (tropical and old trees). 0 = off. Use at least 8 radial sides per fin. |
| Buttress | Height | `buttressHeight` | 0.05..30 (slider 0.05..6) m | 1.5 |  |  | How far up the trunk the fins climb. The top edge is a concave ridge that runs out into the trunk. |
| Buttress | Length | `buttressLength` | 0..5 (slider 0..3) | 1 |  |  | How far a fin sticks out at the ground, as a multiple of the trunk radius. |
| Buttress | Thickness | `buttressThickness` | 0.02..1 | 0.3 |  |  | Width of the flat ridge of a fin relative to the space between two fins. Thin fins have concave sides. |

### Tab: Skin

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Type & Visibility | Type | `skinType` | Polygons / Spine only / SubD surface (rectangular attachments) (not yet available) / SubD surface (arbitrary attachments) (not yet available) | polygons |  |  | Polygons builds the tube mesh. Spine only builds no mesh: the spine stays available for children such as fronds and leaves. The SubD surface types are not available yet. |
| Type & Visibility | Spine only | `spineOnly` | bool | false |  |  | Legacy switch: use Type instead. |
| Type & Visibility | Visibility | `skinVisibility` | curve | curve |  |  | Runs along the parent (left = base, right = tip). Branches that grow where the curve is above 0.5 get geometry, the others stay invisible but keep their children. |
| Radius | Absolute | `skinRadiusAbsolute` | 0..10 (slider 0..0.5) m | 0 |  |  | Radius in metres added to the base radius of every branch. |
| Radius | + % of parent | `skinRadiusPercent` | 0..2 (slider 0..1) | 0 |  |  | Adds this fraction of the parent radius at the attachment to the base radius. |
| Radius | Clamp to parent | `skinRadiusClampParent` | bool | false |  |  | A branch never gets thicker than its parent at the attachment. |
| Radius | Length compensation | `skinLengthCompensation` | 0..1 | 0 |  |  | Enlarges the tip radius of branches that thin out to a point too fast: 1 keeps up to half of the base radius at the tip. |
| Radius | Length kill ratio | `skinLengthKill` | 0..10000 (slider 0..500) | 0 |  |  | Removes branches whose length divided by radius is above this value (very long, thin whips). 0 = off. |
| Irregularity | Amount | `radiusNoiseAmount` | 0..0.6 (slider 0..0.3) | 0 |  | yes | Irregularity of the radius: slow swells and pinches along the branch, as a fraction of the radius (RMS). 0 = a clean taper. The curve runs along the branch (left = base, right = tip). |
| Irregularity | Scale | `radiusNoiseScale` | 0.05..50 (slider 0.05..10) m | 1.5 |  |  | Wavelength of the swells in metres (a second octave at 3x the frequency and 0.4 of the amplitude adds detail). |
| Irregularity | Seed | `radiusNoiseSeed` | seed | 0 |  |  | Random seed of the radius irregularity only; nothing else changes. |
| Irregularity | Along parent | `radiusNoiseParent` | 0..1 (slider 0..1) | 1 |  | yes | Multiplies the irregularity of a child by this curve along its parent (left = parent base, right = parent tip). |
| Radius | Light seam reduction | `seamReduction` | 0..1 | 0 |  |  | Bends the normals toward the spine direction, strongest at the base of a branch where lighting seams show at the junction. |
| Radius | Roll | `skinRoll` | -180..180 ° | 0 |  |  | Rotates the skin around the spine without changing its shape (rotates the section, the squash and the texture). |
| Radius | Smooth | `skinSmooth` | 0..1 | 0 |  |  | Pushes the vertices out on the inner side of bends so the tube does not pinch. |
| Clamp | Min | `skinRadiusMin` | 0..10 (slider 0..0.05) m | 0 |  |  | Smallest radius of any point. 0 = off. |
| Clamp | Max | `skinRadiusMax` | 0..10 (slider 0..1) m | 0 |  |  | Largest radius of any point. 0 = off. |
| Squash | Amount | `squashAmount` | 0..1 | 0 |  |  | Reduces the radius on one side: the section becomes an ellipse (1 = flat). Welds follow the squashed profile. |
| Squash | Rotate | `squashRotate` | -180..180 ° | 0 |  |  | Direction of the flattened side around the spine. |
| Splits | Chance | `splitsChance` | 0..1 | 0 | yes |  | Probability that the branch divides into two open ends at its tip. The U tile count around the branch must be even (at least 2): an odd count is raised to the next even number when the branch splits, and the node reports it as a warning. |
| Splits | Balance | `splitsBalance` | 0..1 | 0.5 | yes |  | 0.5 gives both sides the same radius; lower or higher moves radius from Side 1 to Side 2 (the cross-section area is kept). |
| Splits | Seed | `splitsSeed` | seed | 0 |  |  | Seed of the split decision: changes which branches split without changing anything else. |
| Splits | Fork type | `splitsMode` | Y / Lateral | y |  |  | Y = a symmetric fork (two lobes, Balance and the two Spread angles). Lateral = the branch keeps going with a slight kink and a clearly thinner side branch leaves at the Spread angle from a swelling (the branch-like fork of old oaks); the neck swell, ridge and valley fillet of the junction are applied automatically. |
| Splits | Dominance | `splitsDominance` | 0..1 | 0 | yes |  | Dominant leader. 0 = Balance only. Towards 1 the fat half continues the direction of the branch almost unchanged (its deviation shrinks down to 25 % of its Spread) while the skinny half leaves at its full Spread with a smaller radius. r1^e + r2^e = R^e still holds. Extend parent Fat / Skinny keep working. |
| Splits | Lateral chance | `splitsLateralChance` | 0..1 | 0 | yes |  | Fork type Y only: probability that a fork is a lateral (one-sided) one instead, drawn per fork from the Splits seed, so one tree mixes Y and lateral forks. |
| Split spread | Side 1 | `splitsSpread1` | 0..80 ° | 22 | yes |  | Angle of Side 1 away from the centre of the tree. |
| Split spread | Side 2 | `splitsSpread2` | 0..80 ° | 22 | yes |  | Angle of Side 2 toward the centre of the tree. |
| Split expand | Side 1 | `splitsExpand1` | 0.5..2 | 1 | yes |  | Scales the cross-section of Side 1 from its default (1). |
| Split expand | Side 2 | `splitsExpand2` | 0.5..2 | 1 | yes |  | Scales the cross-section of Side 2 from its default (1). |
| Split smooth | Inner | `splitsSmoothInner` | 0..1 | 0.25 | yes |  | 0 = hard crease between the two sides, 1 = no crease. |
| Split smooth | Outer | `splitsSmoothOuter` | 0..1 | 0.5 | yes |  | Smoothness of the outer bend where the split occurs (0 = hard corner). |
| Split advanced | Area exponent | `splitsAreaExponent` | 1.5..3 | 2 |  |  | Pipe-model exponent e of r1^e + r2^e = parent radius^e. 2 keeps the cross-section area of the parent; higher values make both halves thicker. |
| Split advanced | Down bias | `splitsDownBias` | 0..1 | 0 |  |  | Turns both halves toward gravity after the sides are balanced (roots default to 0.4). A half never points higher than the branch it leaves. |
| Split shape | Waist | `splitsWaist` | 0.2..1 | 1 |  |  | Width of the neck at the middle of the transition relative to the narrower lobe. 1 = the former outline, 0.6 = a pronounced figure-8 (peanut) that pinches and then separates. |
| Split shape | Neck swell | `splitsNeckSwell` | 0..0.5 | 0 |  |  | The parent swells by up to this fraction of its radius just before the fork. The swell is paid from the area reservoir of the lobes: the open ends keep r1^e + r2^e = R^e. |
| Split shape | Valley radius | `splitsValleyRadius` | 0..1 | 0 |  |  | Fillet radius of the valley between the lobes as a fraction of the smaller lobe radius. 0 = the former crease (Smooth > Inner still mixes crease and no crease); the radius fades to 0 at the open ends. |
| Split shape | Ridge | `splitsRidge` | 0..1 | 0 |  |  | Raised bark ridge along the pinch axis from the valley down to the crotch point; height as a fraction of the smaller lobe radius, width about the valley radius. |
| Split shape | Ridge length | `splitsRidgeLength` | 0.25..8 R | 2 |  |  | Length over which the ridge blends into the parent, in parent radii counted back from the crotch. |
| Split shape | Stretch | `splitsStretch` | 0.8..1.6 | 1 |  |  | Elongates the section along the divergence axis early in the transition (ovalisation before the pinch). 1 = none. |
| Split shape | Included bark | `splitsIncludedBark` | 0..1 | 0 | yes |  | Codominant stems with included bark: deepens the valley into a narrow, dark, V-shaped crevice with a bark ridge (smaller valley radius, narrower neck, a ridge, stronger ambient occlusion). 0 = off. |
| Split shape | Ease | `splitsEase` | 0..1 | 0 |  |  | Easing of the separation along the transition: 0 = smoothstep as before, 1 = the lobes stay merged longer and then pinch off suddenly. |
| Extensions | Radius | `extensionRadius` | 0..1 | 0 |  | yes | How much of the profile curve is used. The curve is the radius along the extension relative to the radius the branch would have there (it starts at the parent radius). |
| Extensions | Normal smooth | `extensionNormalSmooth` | 0..1 | 0.5 |  |  | Smooths the normals at the base of extensions to hide seams between several extensions. |
| Extensions | Displacement scale | `extensionDisplaceScale` | 0..2 | 1 |  |  | Scales the displacement on the extensions made by this node. |
| Extensions | Blend length | `extensionBlendLength` | 0.5..8 | 2 |  |  | Length, in parent radii, over which an extension blends from its parent material to its own. Has no effect while the extension material is Inherited. |
| Extensions | Contrast | `extensionBlendContrast` | 0..1 | 0.35 |  |  | 0 = soft material transition, 1 = hard edge. |
| Extensions | Noise | `extensionBlendNoise` | 0..1 | 0.3 |  |  | Makes the blend line around the extension irregular. |
| Geometry | Close end | `capEnd` | bool | true |  |  | Closes the tip of the tube with a cap. |
| Geometry | Tip rings | `tipRings` | 1..8 | 2 |  |  | Rings of the rounded tip cap. |
| Geometry | Close base | `capBase` | Auto / Yes / No | auto |  |  | Auto closes branches that do not grow from a parent. |
| Geometry | Twist | `skinTwist` | -720..720 °/m | 0 |  |  | Twists the surface texture and geometry around the axis. |
| Junction | Collar | `collarAmount` | 0..2 | 0.3 |  |  | Radius flare where a branch leaves its parent. |
| Junction | Collar length | `collarLength` | 0.1..10 | 1.5 |  |  | Length of the flare in branch radii. |
| Junction | Collar swell | `collarSwell` | 0..1 | 0 |  |  | Raised shoulder where the branch meets its parent: the skin around the junction is pushed out by this fraction of the branch radius in a smooth bump (length: Collar length x radius). 0 = off. Not used where Welding is on (Spread does that job). |
| Welding | Enabled | `weldEnabled` | bool | false |  |  | Pushes the base of the branch out of its parent and fuses it to the parent surface, for a seamless union without a visible seam. |
| Welding | Keep | `weldKeep` | curve | curve |  |  | Runs over the height of the model (left = bottom, right = top). Welds are dropped where the curve is below 0.5: the branch then starts on the parent spine without fusing. |
| Welding | Keep failed | `weldKeepFailed` | bool | false |  |  | Keeps branches whose weld failed (they are drawn without fusing) instead of removing them. Useful to find the failures. |
| Welding | Force ray casts | `weldForceRays` | bool | false |  |  | Casts rays against the real parent tube (curved and tapered along its whole spine) instead of the procedural cone at the attachment: better on strongly bent parents, but more welds fail. |
| Welding | Offset | `weldOffset` | 0..10 (slider 0..4) | 1.5 |  |  | How far (in branch radii) the branch is pushed out of the parent surface before it is welded back: the length of the weld part. |
| Spread | Amount | `weldSpreadAmount` | 0..2 (slider 0..1) | 0.3 |  |  | How much the base of the branch widens at the weld site (fraction of its radius). |
| Spread | Upper scale | `weldSpreadUpper` | 0..2 (slider 0..1) | 0.2 |  |  | Extra widening on the side of the base facing the tip of the parent, which forms a web where the branches meet. |
| Spread | Lower scale | `weldSpreadLower` | 0..2 (slider 0..1) | 0.1 |  |  | Extra widening on the side of the base facing the base of the parent. |
| Blend | Enabled | `weldBlendEnabled` | bool | true |  |  | Fades the bark texture of the child into the texture of the parent around the weld. Needs a bark material with a Color map. |
| Blend | Texture | `weldBlendTexture` | 0..10 (slider 0..4) | 1 |  |  | Pulls the blended region further up the child (in branch radii); 0 ends the blend where the weld ends. |
| Blend | Texture scale | `weldBlendTextureScale` | 0.1..10 (slider 0.1..4) | 1 |  |  | Size of the parent map inside the blended region (above 1 = finer pattern). |
| Blend | Contrast | `weldBlendContrast` | 0..1 | 0.35 |  |  | Harshness of the blend: 0 is a soft fade, 1 a sharp edge between the two textures. |
| Blend | Noise | `weldBlendNoise` | 0..1 | 0.3 |  |  | Wave noise around the child so the blend line is not a uniform ring. |
| Blend | Lighting | `weldBlendLighting` | curve | curve |  |  | Normals in the weld region, from the parent side (left) to the child (right). At the bottom of the curve they follow the spine direction, at the top they point outward from the spine; the middle leaves them unchanged. |
| Normals | Smoothing | `smoothing` | 0..1 | 1 |  |  | Below 0.5 the tube is faceted (unwelded quads). |
| Normals | Flatten | `flatten` | 0..1 | 0 |  |  | Flattens normals towards the axis to soften the shading. |
| Vertex color | Tint | `tint` | color | [0.36, 0.26, 0.18, 1] |  |  | Vertex colour multiplied onto the material. |
| Vertex color | Variance | `tintVariance` | 0..1 | 0.1 |  |  | Random variation of the vertex colour per instance. |
| Vertex color | AO strength | `aoStrength` | 0..1 | 0.6 |  |  | Strength of the baked vertex ambient occlusion. |
| Vertex color | Mode | `vcMode` | Inherit / Multiply / Set / Add | inherit |  |  | Inherit: the colour is the bark colour blended with the parent at the junction (earlier behaviour). Multiply: tint it by Color. Set: replace it with Color. Add: brighten it by Color. Profile and Parent curve control where along the branch and along the parent the change applies. |
| Vertex color | Color | `vcColor` | color | [1, 1, 1, 1] |  |  | Linear colour used by Multiply, Set and Add. |
| Vertex color | Variance | `vcVariance` | 0..1 | 0 |  |  | Per-branch brightness variation (+-), deterministic from the seed. 0 = none. |
| Vertex color | Seamless | `vcSeamless` | bool | false |  |  | The colour at the attach point equals the parent colour exactly and blends into this generator's own colour along the collar (needs the parent to be meshed first; falls back to the bark colour otherwise). |
| Vertex color | Profile | `vcProfile` | curve | curve |  |  | Strength of the Mode along this branch (left: base, right: tip). 1 = full effect, 0 = the inherited colour. Use it for lighter young twigs, darker trunk bases or leaf tips. |
| Vertex color | Parent curve | `vcParentCurve` | curve | curve |  |  | Strength of the Mode by the position of the attach point on the parent (left: parent base, right: parent tip). Ignored without a parent. |

### Tab: UV Mapping

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Mapping | Style | `uvStyle` | Unrestricted / U locked [0,1], V unrestricted / U and V locked [0,1] | unrestricted |  |  | Unrestricted lets the coordinates tile freely. The locked styles keep U (or U and V) inside 0..1: one texture copy around the branch, and for U and V locked one along it. Offsets and twist are ignored while locked. |
| Mapping | Extension style | `extensionUvStyle` | Automatic / Manual (match) / Manual (match u only) / Manual (full control) | automatic |  |  | How an extension maps its texture next to the branch it extends. Automatic continues the parent (tiles around, V, twist, offset). Manual (match) copies the parent tile count and V; your own U and V offsets are added to those of the parent. Manual (match u only) copies only the tile count; the U offset is added to that of the parent, V is your own. Manual (full control) ignores the parent. |
| Mapping | Rotate 90° | `uvRotate` | bool | false |  |  | Swaps U and V (turns the texture a quarter turn). |
| U | Absolute | `uvUAbsolute` | 0..64 (slider 0..8) | 0 |  |  | Texture copies around the branch regardless of its thickness. The total is always a whole number, at least 1. |
| U | + Relative | `uvURelative` | 0..16 (slider 0..4) | 1 |  |  | Extra copies per metre of circumference, so thick branches get more (1 = one copy per metre of girth, the classic world-size tiling). |
| U | Offset | `uvOffsetU` | -10..10 | 0 | yes |  | Turns the texture around the branch (in copies). The variance turns every branch by a random amount, so the seam faces a different way. |
| Fractional | Enable | `uvFractional` | bool | false |  |  | Allow a fractional number of copies around the branch. The texture no longer closes on itself, so a seam can show. |
| Fractional | Auto | `uvFractionalAuto` | bool | false |  |  | Uses the same texel density as the parent branch (copies per metre of girth). A seam may appear. |
| Fractional | Value | `uvFractionalValue` | 0.01..64 (slider 0.01..8) | 1 |  |  | Free number of copies around the branch; Absolute and Relative are ignored. |
| Twist | Amount | `uvTwist` | -16..16 (slider -2..2) | 0 |  |  | Turns per V tile: the texture spirals around the branch as it runs along it. |
| Twist | Random flip | `uvTwistFlip` | bool | false |  |  | Gives every branch a random spiral direction. |
| V | Style | `uvVStyle` | Absolute / Relative (keep aspect ratio) / Relative | absolute |  |  | Absolute: copies per metre of length. Relative (keep aspect ratio): the texture keeps its proportions, a copy is as long as it is wide. Relative: the texture is stretched over the whole length of the branch. |
| V | Anchor | `uvVAnchor` | Start / End | start |  |  | Which end of the branch lies on a whole V number (End puts a texture edge exactly at the tip). |
| V | Scale | `uvScaleV` | 0.01..100 (slider 0.01..10) | 1 |  |  | Absolute: V copies per metre. Relative (keep aspect ratio): multiplies the density. Relative: the number of copies along the branch. |
| V | Skew correction | `uvSkew` | 0..1 | 0 |  |  | Compensates the narrowing or widening of a tapering branch (0 = the texture tapers with it, 1 = it keeps its proportions everywhere). |
| V | Pinch | `uvPinch` | 0..1 | 0.25 |  |  | Stops the texture from racing along the last stretch of a pointed tip (higher values keep the radius used for V further from zero). |
| V | Offset | `uvOffsetV` | -10..10 | 0 | yes |  | Moves the texture along the branch (in copies). The variance starts every branch at a random V. |
| Tiling | Style | `uvTilingStyle` | Tiling / 0-1 patches (choose one assigned material) / 0-1 patches (use all assigned materials) | tiling |  |  | Tiling repeats the texture. The patch styles cut the branch into 0..1 patches (one per V tile) that show a UV Area of the material: one material for the whole branch, or any assigned material per patch. Vertices are doubled along the seams. Set the area and placement of every row with the patch button in the Material tab. |
| Tiling | Optimize segments | `uvOptimize` | bool | false |  |  | Avoids rings that are very close together near a patch seam (or a whole V number): the seam moves onto a ring within the V tolerance instead of adding one. |
| Tiling | V tolerance | `uvVTolerance` | 0..0.5 | 0.1 |  |  | How close (in V) a ring must be to a whole number to be moved onto it while Optimize segments is on. |
| Tiling | Create seams | `uvCreateSeams` | bool | false |  |  | Cuts real geometry (doubled ring vertices) at every whole U tile border so each tile around the branch is its own UV island: the branch texture can then sit in an atlas without resolution loss. Positions and normals stay continuous across the cut (the mesh is still watertight when welded). |
| Tiling | Seed | `uvTilingSeed` | seed | 0 |  |  | UV mapping setting for textures on this geometry. “Seed” in UV › Tiling. |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Reduction | Side reduction | `lodSides` | 0..1 | 0.5 |  |  | How many sides are removed at lower LODs. |
| Reduction | Segment reduction | `lodSegments` | 0..1 | 0.5 |  |  | How many segments are removed at lower LODs. |
| Reduction | Cull amount | `lodCull` | 0..1 | 0 |  |  | Fraction of small children removed at lower LODs. |
| Distance | Fade start | `lodFadeStart` | 0..1 | 0.5 |  |  | Distance where this node starts fading out. |
| Distance | Fade end | `lodFadeEnd` | 0..1 | 1 |  |  | Distance where this node has completely faded. |
| Dynamic LOD | Weight | `lodWeight` | 0..1 | 0.5 |  |  | Priority to survive when Tree > Dynamic LOD removes pieces of the same type (branches, leaves, fronds, decorations): pieces of a generator with a higher Weight are removed later. 0.5 = neutral; equal weights never change the ranking. |
| Dynamic LOD | Optimization | `lodOptimization` | 0..45 ° | 0 |  |  | Degrees added to the straight-section merge angle (Segments > Optimization) for every LOD step: lower levels merge nearly straight length segments more aggressively. 0 = unchanged. |
| Dynamic LOD | Length segments | `lodLengthSegments` | 0.1..1 | 1 |  |  | Scalar applied to the number of length segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Dynamic LOD | Radial segments | `lodRadialSegments` | 0.1..1 | 1 |  |  | Scalar applied to the number of radial (or width) segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Lightmap | Lightmap weight | `lightmapWeight` | 0..4 | 1 |  |  | Relative texel density of this generator in the lightmap UVs (Tree > Lightmap, export). 1 = the same density as the other generators, 2 = twice the density, 0 = one texel per piece (a leaf gets a single texel). Leaves start at 0; the "Reset lightmap" command restores the defaults. |

### Tab: Displacement

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Main | Source | `displaceSource` | Noise / Material / Displacement / Bark | noise |  |  | Where the height values come from: built-in noise, the Height map of the assigned material, a named asset from the Displacements panel, or procedural Bark relief (see the Bark section). |
| Main | Displacement | `displacement` | None |  |  |  | Height map from the Displacements panel. A warning badge shows on the node when the map is missing or not loaded. |
| Main | Radial amount | `displaceRadial` | -5..5 (slider -0.3..0.3) m | 0 |  |  | Largest move away from (positive) or toward (negative) the spine, in metres. |
| Main | Length amount | `displaceLength` | -5..5 (slider -0.3..0.3) m | 0 |  |  | Largest move along the spine, in metres. Vertices that share a V coordinate no longer sit in one plane. |
| Main | Sharpness | `displaceSharpness` | curve | curve |  |  | Remaps the displacement values. A straight line leaves them unchanged; a curve that stays low and rises late keeps only the highest values. |
| Main | Mapping | `displaceMapping` | Use UVs / Fit to geometry | use-uvs |  |  | Use UVs follows the branch UV tiling; Fit to geometry wraps the pattern once around and once along the branch. |
| Main | U scale | `displaceUScale` | 0.05..50 (slider 0.05..10) | 1 |  |  | Pattern size around the branch (larger = more repeats). |
| Main | V scale | `displaceVScale` | 0.05..50 (slider 0.05..10) | 1 |  |  | Pattern size along the branch (larger = more repeats). |
| Main | Seed | `displaceMainSeed` | 0..99999 | 0 |  |  | Random seed of the noise source. |
| Fine | Amount | `displaceFineAmount` | -2..2 (slider -0.1..0.1) m | 0 |  |  | Second, always-noise displacement along the surface normal, added on top of the main one. |
| Fine | Sharpness | `displaceFineSharpness` | curve | curve |  |  | Remaps the fine noise values (straight line = unchanged). |
| Fine | Scale | `displaceFineScale` | 0.1..8 (slider 0.1..3) | 1 |  |  | Size of the fine noise. Above 1 the surface is pushed out on average, below 1 it is pulled in toward the center. |
| Shape | Amount | `displaceShapeAmount` | -1..1 | 0 |  |  | Depth of the creases that run along the spine, as a fraction of the local radius. |
| Shape | Twist | `displaceShapeTwist` | -720..720 (slider -90..90) °/m | 0 |  |  | Rotates the crease pattern around the spine while it climbs from the base (degrees per metre). |
| Shape | Scale | `displaceShapeScale` | 0.1..10 (slider 0.1..4) | 1 |  |  | Number of creases around the branch (larger = more, thinner creases). |
| Shape | Seed | `displaceShapeSeed` | seed | 0 |  |  | Displacement setting (height-map driven surface detail). “Seed” in Displacement › Shape. |
| Flares | Radius | `displaceFlareRadius` | 0..8 (slider 0..2) | 0 |  |  | Largest flare, as a multiple of the branch radius at its base. 0 turns the flares off. |
| Flares | Noise scale | `displaceFlareNoise` | 1..32 | 5 |  |  | Number of flare lobes around the branch. |
| Flares | Height | `displaceFlareHeight` | 0.01..50 (slider 0.01..5) m | 1 |  |  | How far up the spine the flares reach. |
| Flares | Pinch | `displaceFlarePinch` | 0..1 | 0 |  |  | Pulls the flares toward the center spine. At 1 the lobes are thin ridges and nothing spreads at the base. |
| Flares | Angle | `displaceFlareAngle` | -180..180 ° | 0 |  |  | Rotates the flares around the spine. |
| Flares | Seed | `displaceFlareSeed` | seed | 0 |  |  | Displacement setting (height-map driven surface detail). “Seed” in Displacement › Flares. |
| Bark | Style | `barkStyle` | Furrowed / Plated / Fibrous / Lenticel / Rings / Scaly | furrowed |  |  | Furrowed: long ridges and V-shaped crevices (oak, pine, elm). Plated: blocky plates between cracks (redwood, old bark). Fibrous: thin parallel fibres (cedar). Lenticel: smooth bark with short horizontal slits (cherry, birch). Rings: regular horizontal rings (palm, bamboo). Scaly: overlapping scales (cypress). |
| Bark | Depth | `barkDepth` | 0..1 (slider 0..0.3) | 0 |  |  | Relief from crevice bottom to ridge top as a fraction of the local radius, so thick trunks get deep furrows. 0 turns the bark relief off. |
| Bark | Scale | `barkScale` | 0.005..5 (slider 0.005..0.5) m | 0.08 |  |  | Feature size in metres (furrow spacing, plate width, ring spacing). Independent of UV tiling and of the number of rings. |
| Bark | Stretch | `barkStretch` | 0.1..40 (slider 0.1..12) | 4 |  |  | Feature length along the spine compared with its width (furrows, plates, fibres, scales). Lenticel: slit width across the trunk. Rings: not used. |
| Bark | Warp | `barkWarp` | 0..2 | 0.5 |  |  | Domain warp strength: how much the furrows, cracks and rings meander instead of running straight. |
| Bark | Crevice | `barkCrevice` | 0..1 | 0.5 |  |  | Crevice profile: 1 = narrow V-shaped crevices with wide tops, 0.5 = linear, 0 = wide flat-bottomed troughs. Works like the Main Sharpness curve and stacks with it. |
| Bark | Maturity | `barkMaturity` | 0..1 | 0 |  |  | How strongly the depth follows the branch radius: 0 = every branch has the same relief, 1 = young thin twigs are smooth and old thick trunks get the full depth. |
| Bark | Smooth up to radius | `barkMaturityMin` | 0..5 (slider 0..0.3) m | 0.01 |  |  | Radius at and below which the bark is smooth (Maturity > 0). A smoothstep leads to the full depth at the next radius. |
| Bark | Full depth at radius | `barkMaturityMax` | 0.001..5 (slider 0.001..0.5) m | 0.15 |  |  | Radius from which the bark has its full depth (Maturity > 0). |
| Bark | Maturity along branch | `barkMaturityCurve` | curve | curve |  |  | Depth multiplier from the base (left) to the tip (right) of each branch. A flat line at 1 leaves the depth unchanged. |
| Bark | Seed | `barkSeed` | seed | 0 |  |  | Random seed of the bark pattern. Every branch lineage also gets its own pattern. |
| Fade | Fade at junctions | `displaceFadeBase` | 0..10 | 1.5 |  |  | Fade-in length (in radii) past the weld / junction rings: prevents cracks where a branch leaves its parent. |
| Fade | Fade at tips | `displaceFadeTip` | 0..10 | 1 |  |  | Fade-out length (in radii) toward the tip / cap. |
| Fade | LOD fade | `displaceLodFade` | bool | true |  |  | Fade the displacement out between LOD 1 and 3. |
| Subdivision | Auto-subdivide | `displaceAutoSubdivide` | bool | true |  |  | Add rings and sides so the mesh has enough vertices to carry the displacement. |
| Subdivision | Detail size | `displaceDetail` | 0.002..1 (slider 0.002..0.2) m | 0.03 |  |  | Target quad size when auto-subdividing (smaller = more detail, more triangles). |
| Subdivision | Max vertices | `displaceMaxVertices` | 500..1000000 (slider 500..200000) | 40000 |  |  | Bark: most vertices auto-subdivision may create for one branch, so a small Scale cannot freeze the browser. Features coarsen when the cap is reached. |
| Subdivision | Min sides | `displaceMinSides` | 3..128 | 16 |  |  | Fewest sides around a displaced branch. |
| Asset amount (legacy) | Amount | `displaceAmount` | -5..5 (slider 0..0.2) m | 0 |  | yes | Older asset displacement in metres at full height. The curve scales it along the branch length. |
| Asset amount (legacy) | + % of radius | `displaceRadiusAmount` | -1..2 | 0 |  |  | Extra amount relative to the local radius. |
| Asset amount (legacy) | Offset | `displaceOffset` | -1..1 | 0 |  |  | Bias added to the height before scaling. |
| Asset amount (legacy) | Mid-grey is neutral | `displaceMidGrey` | bool | true |  |  | On: 50% grey does not move the surface. Off: black = none, white = full amount outward. |
| Asset amount (legacy) | Direction | `displaceDirection` | Normal / Radial | normal |  |  | Displace along the surface normal or radially from the axis. |
| Asset mapping (legacy) | Tiling | `displaceTiling` | World / Normalized | world |  |  | World: one image tile covers "Tile size" metres. |
| Asset mapping (legacy) | Tile size | `displaceTileSize` | 0.005..50 (slider 0.005..4) m | 0.5 |  |  | World size of one displacement tile. |
| Asset mapping (legacy) | Scale | `displaceScale` | 0.01..50 | 1 |  |  | Height of the displacement. |
| Asset mapping (legacy) | Scale U | `displaceScaleU` | 0.01..50 | 1 |  |  | Displacement tiling around the stem. |
| Asset mapping (legacy) | Scale V | `displaceScaleV` | 0.01..50 | 1 |  |  | Displacement tiling along the stem. |
| Asset mapping (legacy) | Rotation | `displaceRotation` | -360..360 ° | 0 |  |  | Snapped to 90° steps while seams are locked. |
| Asset mapping (legacy) | Lock seams | `displaceLockSeams` | bool | true |  |  | Round the tiling around the trunk to a whole number so the U seam is continuous. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Material | Material | `barkMaterials` | list | [curve] |  |  | Materials of the branches. Each branch picks a row by weight. Inherited uses the material of the parent. |
| Extensions | Extension material | `extensionMaterials` | list | [curve] |  |  | Materials of the branches. Each branch picks a row by weight. Inherited uses the material of the parent. |
| Material | Tint | `materialTint` | color | [1, 1, 1, 1] |  |  | Colour multiplied onto the material. |
| Material | Variation | `materialVariation` | 0..1 | 0 | yes |  | How much the material variation colours are applied. |
| Blend | Base blend | `blendBase` | 0..1 | 0 |  | yes | Blends the material towards the parent at the base. |
| Blend | Height blend | `blendHeight` | 0..1 | 0 |  |  | Blends the material along the height. |
| Season | Start offset | `seasonStartOffset` | -1..1 (slider -1..1) | 0 | yes | yes | Season start offset: 0 = the transition follows the Season slider immediately, positive values delay it, negative values start it earlier. Variance spreads it per element; the curve runs along the parent. |
| Season | Time scale | `seasonTimeScale` | 0..10 (slider 0..2) | 1 | yes | yes | Season time scale: 1 = one slider sweep is one year of this node; 2 = twice as fast, 0 = never changes. |
| Season | Descendant offset | `seasonDescendantOffset` | -1..1 (slider -1..1) | 0 | yes |  | Season descendant offset: shifts the transition of this node AND of every node below it (positive = later). Use it so that thin twigs change after the trunk. |
| Season | Gravity | `seasonGravity` | -1..1 (slider 0..1) | 0 |  | yes | Season gravity: the branches droop by this amount times their transition value while their material changes (0 = no droop). |

### Tab: Animation

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Wind hierarchy | Hierarchy | `windHierarchy` | Trunk / Branch 1 / Branch 2 / Leaf | branch-1 |  |  | Which level of the wind hierarchy this geometry follows (trunk, branch 1/2, leaf). |
| Amount | Amount | `windAmount` | 0..10 (slider 0..2) | 1 |  | yes | Strength multiplier of the wind on this node. |
| Amount | Phase variance | `windPhaseVariance` | 0..1 | 0.5 |  |  | Random phase offset of the branch-level sway (0 = a branch sways in phase with the branch it grows from, 1 = fully random) so neighbours do not sway in sync. Deeper twigs and leaves always keep the phase of their level-1 ancestor. |

### Tab: Segments

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
|  | Accuracy | `accuracy` | 4..256 | 24 |  |  | Exact number of points of the high-resolution spine the branch is built from (higher = smoother, slower). |
|  | Influence | `segmentInfluence` | 0..4 (slider 0..2) | 1 |  |  | Scales how strongly forces and spine properties act per accurate segment. 1 keeps the shape when Accuracy changes. |
|  | Scalar | `segmentScalar` | 0.1..4 (slider 0.1..2) | 1 |  |  | Multiplies the polygon count of the mesh (length and radial segments). |
| Length | Style | `lengthStyle` | Default / Legacy | default |  |  | Default builds the accurate layout with the relative basis; Legacy keeps the older layout (relative segments per metre). |
| Length | Absolute | `segments` | 1..512 | 10 |  |  | Minimum number of length segments. |
| Length | + Relative | `relativeSegments` | 0..20 (slider 0..2) | 0 |  |  | Adds more length segments, multiplied by the Relative basis. |
| Length | Relative basis | `relativeBasis` | Length only / Length/radius ratio / Parent's length segments | length-radius-ratio |  |  | What + Relative is multiplied by: the branch length, its length / radius ratio (recommended) or the length segments of the parent. |
| Length | Weld scalar | `weldScalar` | 0..4 (slider 0..2) | 1 |  |  | Scales the number of segments in the weld part, where the branch is fused to its parent. |
| Length | Optimization | `optimization` | 0..45 ° | 0 |  |  | Drops segments where the spine is nearly straight: the larger the value, the bigger the bend must be to keep a segment (0 = keep all). |
| Radial | Absolute | `sides` | 0..64 | 8 |  |  | Minimum number of radial segments (sides). |
| Radial | + Relative | `radialRelative` | 0..200 (slider 0..40) | 0 |  |  | Adds radial segments, multiplied by the Relative basis. |
| Radial | Relative basis | `radialBasis` | Radius / Parent's radial segments | radius |  |  | What + Relative is multiplied by: the branch radius in metres or the radial segments of the parent. |

### Tab: Physics _(not implemented yet - shown disabled)_

### Tab: Hand Drawn

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Hand drawn | Enabled | `handDrawn` | bool | false |  |  | Enables hand-drawn control of the spine shape. |
| Hand drawn | Strength | `handStrength` | 0..1 | 1 |  |  | Strength of the hand-drawn influence. |
| Hand drawn | Smoothing | `handSmoothing` | 0..1 | 0.5 |  |  | Smoothing of the hand-drawn spine. |

### Branch UV Mapping and material patches (R16) - formulas

Pure maths: `src/generators/uv/` (`uMath`, `vMath`, `areas`, `patches`); glue for the tube mesher: `src/geometry/tubeUv.ts`; parameter reader: `src/nodes/generators/uvConfig.ts`. With the defaults the result equals the tiling by world size of older projects. `metresPerTile` is the world size of one texture copy (from the bark material).

* **U tiles (around).** `tiles = max(1, round(Absolute + Relative x circumference / metresPerTile))`, circumference = 2 pi x thickest radius of the branch. Always a whole number >= 1, so the texture closes without a seam. **Offset** (copies, variance = random per branch) turns the texture around the branch.
* **Fractional.** *Enable* allows a float count. *Value* is used as is (Absolute / Relative are ignored). *Auto* = texel density of the parent (`parentTiles / parentCircumference`, tiles per metre) x circumference at the base of the branch; without a parent the world scale is used. A seam may show.
* **Twist.** U shifts by `Amount x tiles x V` along the branch (revolutions per V tile). *Random flip* gives every branch a random sign.
* **V, Absolute.** `V = arc length x Scale / metresPerTile`. **Relative:** `V = arc length / branch length x Scale`. **Relative (keep aspect ratio):** `dV/ds = Scale x tiles / (2 pi x r)` integrated along the branch, so one V copy is as long as one U copy is wide (on a cylinder). `r = max(ref + (local - ref) x Skew, ref x floor(Pinch))` with `ref` the thickest radius, `floor = 0.02 + 0.48 x Pinch`: Skew correction 0 keeps the reference radius (the texture tapers with the branch), 1 follows the local radius (it keeps its proportions); Pinch stops V from racing away at a pointed tip.
* **Anchor / Offset.** V is 0 at the base (Start). *End* shifts V so the tip lies on a whole number (`ceil`). *Offset* adds copies (variance = random start V per branch).
* **Style.** *U locked* forces one U copy around the branch and ignores offsets / twist; *U and V locked* additionally maps V to 0..1 over the whole branch (V style Relative, Scale 1). **Extension style** (Branch > Extensions): Automatic continues the parent (tiles, V at the attachment, twist, U offset), Manual (match) = own settings but parent tile count and V, Manual (match u only) = parent tile count only, Manual (full control) = own settings.
* **Patches (Tiling).** *0-1 patches* cut the branch at every whole V number: patch `p` covers V in `[p, p + 1]`, local V 0..1 and U 0..1 are remapped into the patch's UV Area rectangle (`u = u0 + (u1 - u0) x U`, same for V), so UVs never leave the area (and never leave 0..1). A seam ring exists twice (end of one patch, start of the next), the quad between them is not drawn: **vertices along a seam are doubled**. Seams never fall inside a weld. *Optimize segments* moves a seam (or, in Tiling, a ring) onto an existing ring within *V tolerance* instead of adding a close ring. *Seed* varies the random choices.
* **Materials.** Branch rows: Material (material, Material Set or `Inherited`), Weight, and (patch styles only, patch options button) *UV Area* (`Whole map`, `Any` = weighted pick among the bark / any-usage areas of the material, or a named area) and *Placement* (`Anywhere`, `First ring` = only competes for the first patch). *Choose one assigned material*: one material (rows grouped by material, summed weights) for the whole branch, each patch picks one of its rows (UV Area). *Use all assigned materials*: every patch picks any row by weight; one mesh slot per material. In Tiling one weighted row is used for the whole branch. Extension rows start as `Inherited` (the material the parent resolved to).
* **Reads / writes.** The mesher writes UV0; weld blend attributes keep using the parent-side UV (`weldParentUV`), Displacement > Use UVs reads the U / V of the same vertices. Old projects: `uvScaleU` multiplies *+ Relative*, `Normalized` mapping and *Match one V tile* map to V style Relative with a free tile count, the single Branch `material` migrates to the first row of the list (node version 5).

## Spine (`generator.spine`)

Lightweight spine-only structural guides for attaching foliage or child branches without tube geometry.

### Tab: Gen

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Generation | Mode | `mode` | Absolute / Proportional / Absolute steps / Proportional steps / Phyllotaxy / Interval / Bifurcation / Flood / Parent / Density / Classic (legacy) | absolute |  |  | How children are placed on the parent: an exact number, proportional to its length, in steps (whorls), by phyllotaxy, at intervals, at bends, flooded along it or all at its origin. |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 8 | yes | yes | Exact number of nodes created on each parent. |
| Absolute | Jumble | `jumble` | 0..1 | 0.2 |  | yes | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | yes | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | yes | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | yes | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | yes | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  |  | Random variation of the spacing in Density mode. |
| Proportional | Frequency | `proportionalCount` | 0..50 (slider 0..10) /m | 2.5 |  |  | Nodes per metre of parent length: longer parents get more nodes, spread at random along them. |
| Steps | Steps | `whorlCount` | 1..128 | 5 |  |  | Number of steps (rings of nodes) along the parent. |
| Steps | Steps | `stepsFrequency` | 0..20 (slider 0..5) /m | 0.5 |  |  | Steps per metre of parent length. |
| Steps | Per step | `whorlPerStep` | 1..128 (slider 1..24) | 4 |  |  | Nodes in every step. |
| Steps | Spread | `whorlSpread` | 0..1 | 0.03 |  |  | Lengthwise spacing of the nodes inside one step, as a fraction of the First..Last stretch. |
| Steps | Roll | `whorlRoll` | -180..180 ° | 15 |  |  | Rotation of every step relative to the previous one. |
| Steps | Balance | `stepsBalance` | 0..1 | 1 |  |  | How evenly the nodes of a step are spaced around the parent (1 = evenly, 0 = random). |
| Phyllotaxy | Style | `phyllotaxyStyle` | Opposite (distichous) / Opposite (decussate) / Opposite (random orientation) / Alternating (distichous) / Alternating (random) / Whorled | alternating-distichous- |  |  | How the nodes of a group are arranged and how consecutive groups are turned against each other. |
| Phyllotaxy | Internode length | `phyllotaxyInternode` | 0..50 (slider 0..2) m | 0.25 |  |  | Distance between groups, measured along the parent from Last towards First. 0 spreads Limit groups evenly instead. |
| Phyllotaxy | Children per node | `phyllotaxyChildren` | 1..32 | 3 |  |  | Nodes in each whorled group. |
| Phyllotaxy | Spread | `phyllotaxySpread` | 0..1 | 0 |  |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Phyllotaxy | Spiral | `phyllotaxySpiral` | -180..180 ° | 0 |  |  | Extra rotation added for every group. |
| Phyllotaxy | Limit | `phyllotaxyLimit` | 0..10000 (slider 0..100) | 0 |  |  | Maximum number of groups (0 = no limit). |
| Phyllotaxy | Align style | `phyllotaxyAlignStyle` | Group / Individual | group |  |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Frequency | `intervalStep` | 0.001..50 (slider 0.001..3) m | 0.6 |  | yes | Distance between groups from Last towards First. The curve scales it along the parent: lower values pack groups tighter. |
| Interval | Count | `perStep` | 1..64 (slider 1..16) | 1 |  |  | Nodes in every group. |
| Interval | Spread | `intervalSpread` | 0..1 | 0 |  |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Interval | Spiral | `intervalSpiral` | -180..180 ° | 0 |  |  | Extra rotation added for every group. |
| Interval | Limit | `intervalLimit` | 0..10000 (slider 0..100) | 0 |  |  | Maximum number of groups (0 = no limit). |
| Interval | Align style | `intervalAlignStyle` | Group / Individual | group |  |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Balance | `intervalBalance` | 0..1 | 0 |  |  | Turns every other group so its nodes fill the gaps left by the previous group. |
| Bifurcation | Count | `bifurcationCount` | 0..1000 (slider 0..32) | 4 |  |  | Maximum number of nodes; the strongest bends win. |
| Bifurcation | Threshold | `bifurcationThreshold` | 0.5..90 ° | 6 |  |  | Smallest bend of the parent that gets a node. |
| Bifurcation | Spread | `bifurcationSpread` | 0..1 | 0 |  |  | Random shift of every node along the parent (1 = 10 % of its length). |
| Bifurcation | Min spacing | `bifurcationSpacing` | 0.01..0.9 | 0.12 |  |  | Smallest distance between two bends, as a fraction of the parent. |
| Alignment | Align | `align` | bool | false |  |  | Rolls the new nodes so they face the sky. |
| Boundaries | First | `first` | 0..1 | 0.15 |  | yes | Lowest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 0.95 |  | yes | Highest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0 |  |  | With the checkbox on, nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary. The value insets the range (fraction of First..Last). |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  |  | Removes nodes that Spread or Position push outside First..Last. |
| Common | Active | `active` | bool | true |  | yes | Switches the generator on. With a curve over the level of detail (left = highest detail) it is active where the curve is above 0.5. |
| Common | Pass | `pass` | 1..99 | 1 |  |  | Generators compute in pass order. A node cannot have a lower pass than any of its ancestors. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes |  | Rotates all nodes around the parent spine as a group. Variance jumbles the rotation per parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes |  | Shifts all nodes along the parent (fraction of its length). Variance shifts every parent differently. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes |  | Start offset of the nodes into (+) or out of (-) the parent; sinks trunks under the ground. |
| Common | Pruning | `pruningCurve` | curve | curve |  |  | Runs over the parent from First (left) to Last (right). Nodes are removed where the curve is below 0.5. |
| Common | Seed | `seed` | seed | 0 |  |  | Random seed. Change it to get a different variation of the same settings. |
| Knockout | Amount | `knockout` | 0..1 | 0 |  | yes | Randomly removes this share of the nodes after the mode has placed them. The curve varies it along the parent. |
| Knockout | + Resolution | `knockoutResolution` | -1..1 | 0 |  |  | Added to the amount for every level of detail below the highest: positive removes more nodes at lower detail, negative fewer. |
| Limits | Sub-generations | `generations` | 1..5 | 1 |  |  | Recursive branching levels evaluated inside this generator (1 = single level). |
| Limits | Max generation | `maxGeneration` | 1..16 | 8 |  |  | Maximum hierarchy generation depth allowed for branches. |
| Force containers | Include | `forceInclude` | list | [] |  |  | Keeps only the nodes inside the volume of the named Force node (set a volume in the Force node). |
| Force containers | Exclude | `forceExclude` | list | [] |  |  | Removes the nodes inside the volume of the named Force node. |
| More | Click place | `clickPlace` | Ready / None / Any / Number | ready |  |  | What a click in the viewport places. It is stored with the node and takes effect with Freehand mode. |
| More | Size scalar | `sizeScalar` | 0.01..100 (slider 0.01..5) | 1 |  |  | Scales this node and every node below it. |
| Masks | Mask | `genMasks` | list | [] |  |  | Keeps a node only where every assigned mask (Masks panel) evaluates to 0.5 or more. |
| Tree placement | Distribution | `distMode` | Parametric / Uniform / Poisson disk / Ring / Grid / Spiral | uniform |  |  | How Number instances fill the Tree disc. Uniform = area-correct random (r = R*sqrt(u)); Poisson disk = blue noise with a minimum distance. |
| Tree placement | Position | `distPosition` | 0..1 | 0.5 | yes |  | Normalised distance from the disc centre (0 = centre, 1 = edge), with variance. |
| Tree placement | Rotation | `distRotation` | 0..1 | 0 | yes |  | Normalised angle around the centre (0..1 = 0..360 degrees), with variance. |
| Tree placement | Min distance | `distMinDistance` | 0..1000 (slider 0..10) m | 0.5 |  |  | Minimum distance between first-generation elements placed on the ground. |
| Tree placement | Splay | `distSplay` | 0..85 ° | 0 |  |  | Outward tilt reached at the disc edge (ferns, bushes). Ignored when Unify child orientation is on. |

### Tab: Spine

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Length | Absolute | `length` | 0..500 (slider 0..20) m | 1.8 | yes | yes | Fixed part of the length in metres. The curve scales the length along the parent. |
| Length | + % of parent | `lengthPercent` | 0..2 (slider 0..1) | 0.08 |  | yes | Adds this fraction of the parent length (1 = as long as the parent). |
| Length | + % of radius | `lengthPercentRadius` | 0..500 (slider 0..100) | 0 |  |  | Adds this many parent radii to the length. |
| Length | Match one V tile | `matchOneVTile` | bool | false |  |  | Sets the length to exactly one V tile of the material, from its aspect ratio and the branch radius, and maps V from 0 to 1. |
| Length | Stop shape control | `stopShapeControl` | bool | false |  |  | Ignores the crown shape envelope and the generation damping, so this node is not shaped by its ancestors. |
| Length | Shape scale | `shapeScale` | 0..5 (slider 0..2) | 1 |  |  | Strength of the crown shape on the length: 0 = off, 1 = as drawn, above 1 = exaggerated. |
| Length | Limit length | `lengthLimit` | bool | false |  |  | Prevents children from becoming longer than the Absolute length. |
| Length | Crown envelope | `crownShape` | Natural / Conical / Oval / Vase / Columnar / Custom | natural |  |  | Branch length as a function of the normalised height on the parent: cone (conifer), oval (oak), vase, column or a custom curve. |
| Length | Crown curve | `crownCurve` | curve | curve |  |  | Length multiplier from parent base (0) to tip (1). |
| Clamp | Min | `lengthMin` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no minimum. |
| Clamp | Max | `lengthMax` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no maximum. |
| Orientation | Start angle | `spread` | 0..180 ° | 42 | yes | yes | Angle to the parent in degrees: 0 = parent direction, 90 = perpendicular, 180 = opposite. |
| Orientation | Start roll | `startRoll` | -180..180 ° | 0 | yes | yes | Rotates the direction the Start angle is applied in (+ clockwise, - counter-clockwise). |
| Orientation | Pitch | `pitch` | -90..90 ° | 0 | yes | yes | Tilts the starting direction up or down (degrees). |
| Orientation | Roll | `spineRoll` | -180..180 ° | 0 |  |  | Rotates the branch around its own axis by a fixed amount, after Alignment. |
| Orientation | Alignment | `alignment` | 0..1 | 0.2 |  |  | Blends a random up (0) with the world up (1), so the top of the branch points up. |
| Orientation | Up / down | `upDown` | -2..2 (slider -1..1) | 0.05 |  | yes | Pushes the growth direction up (+) or down (−) along the length. |
| Orientation | Unify | `unify` | bool | false |  |  | Nodes on opposite sides of the parent share the same orientation (mirrored roll). |
| Orientation | Weld start | `weldStart` | bool | false |  |  | For Spine only branches: starts on the skin of the parent instead of on its spine. |
| Shape | Gravity | `gravity` | -2..3 (slider -1..1.5) | 0.12 |  | yes | A downward force on the spine (+ bends down, - bends up). |
| Shape | Ancestor | `ancestor` | -1..1 | 0 |  | yes | + grows towards the direction of the parent, like a bud; - grows away from it. |
| Shape | Curvature | `curvature` | -2..2 (slider -1..1) | 0.06 | yes | yes | Overall bend of the child along its length. |
| Shape | Straightness | `straightness` | 0..1 | 0.2 |  |  | Removes noise: fully at the base, fading to none at the tip. |
| Shape | Twist | `twist` | -720..720 (slider -180..180) ° | 0 | yes | yes | Total twist of the branch around its axis, in degrees. |
| Parent Curl | Up | `curlUp` | -3..3 (slider -1..1) | 0 |  |  | Curl around the parent direction (the branch winds around its parent). |
| Parent Curl | Right | `curlRight` | -3..3 (slider -1..1) | 0 |  |  | Curl around the axis perpendicular to the parent direction and the initial direction. |
| Parent Curl | Out | `curlOut` | -3..3 (slider -1..1) | 0 |  |  | Curl around the axis pointing straight out of the parent. |
| Zigzag | Intensity | `zigzag` | 0..3 (slider 0..1) | 0 |  |  | How sharply the spine changes direction at every zigzag corner (0 = off). |
| Segment length | Absolute | `zigzagLengthAbsolute` | 0..50 (slider 0..2) m | 0 |  | yes | Fixed part of the distance between two zigzag corners. The curve scales the length along the branch. |
| Segment length | + Relative | `zigzagLengthRelative` | 0..1 | 0.1 |  |  | Adds this fraction of the branch length to the distance between two zigzag corners. |
| Radius | Radius | `radius` | 0.001..20 (slider 0.001..0.5) m | 0.02 | yes | yes | Size: the radius of the cross-section at the base (metres), or the range of an effect. |
| Radius | % of parent | `parentRadiusInfluence` | 0..1 | 0.4 |  | yes | Makes the radius a percentage of the parent radius at the attachment point. |
| Radius | Max parent ratio | `parentRadiusMax` | 0.05..1.5 | 0.82 |  |  | Upper limit of the child radius relative to the parent. |
| Radius | Radius profile | `radiusProfile` | curve | curve |  |  | Normalized radius multiplier from base (0) to tip (1). |
| Radius | Taper | `taper` | 0..1 | 0.9 |  | yes | How much the radius shrinks from base to tip (1 = pointed). |
| Radius | Min radius | `minRadius` | 0.0005..1 (slider 0.0005..0.05) m | 0.002 |  |  | Smallest radius the child may reach. |
| Early | Amount | `earlyNoiseAmount` | 0..2 (slider 0..0.8) | 0.08 |  | yes | Strength of the noise that bends the spine while it grows (chaotic). The curve changes the strength along the spine. |
| Early | Turbulence | `earlyNoiseFrequency` | 0.05..15 (slider 0.05..5) | 1.2 |  |  | How chaotic the early noise wave is: higher values change direction more often. |
| Early | Threshold | `earlyNoiseThreshold` | 0..1 | 0 |  | yes | Point along the spine that must be passed before the early noise starts. The curve changes where it starts and ends. |
| Late | Amount | `noiseAmount` | 0..5 (slider 0..1.5) | 0.12 |  | yes | Strength of the noise applied after the spine is shaped: organic yet controlled. The curve changes the strength along the spine. |
| Late | Turbulence | `noiseFrequency` | 0..20 (slider 0..6) | 1.1 |  |  | How chaotic the late noise wave is: higher values change direction more often. |
| Late | Smooth | `noiseSmooth` | 0..1 | 0 |  |  | Straightens the applied noise: 1 gives the spine as shaped, with no noise left. |
| Late | Seed | `noiseSeed` | seed | 0 |  |  | Random seed of the late noise only; the early noise and everything else stay the same. |
| Late | Twist | `noiseTwist` | -2..2 (slider -1..1) | 0 |  |  | Rotates the late noise as it travels along the spine. |
| Jink | Amount | `jinkAmount` | 0..1 | 0 |  |  | Straightens the spine into linear segments: 0 leaves it unchanged, 1 makes it entirely long straight runs. |
| Jink | Absolute | `jinkAbsolute` | 1..64 (slider 1..16) | 3 |  |  | Minimum number of straight segments. |
| Jink | + Relative | `jinkRelative` | 0..20 (slider 0..4) | 0 |  |  | Adds this many straight segments per metre of branch length. |
| Jink | Uniformity | `jinkUniformity` | 0..1 | 0.5 |  |  | How similar the segment lengths are. At 1 all segments are equally long and the seed has no effect. |
| Jink | Seed | `jinkSeed` | seed | 0 |  |  | Random seed of the Jink segment lengths (no effect at Uniformity 1). |
| Path | Amount | `pathAmount` | 0..20 (slider 0..1) m | 0 |  |  | Size of the path deformation in metres. The Profile curve is the shape of one tile. |
| Path | Profile | `pathProfile` | curve | curve |  |  | Shape of one tile: sideways offset (vertical) along the tile length (horizontal). |
| Path | Twist | `pathTwist` | -720..720 (slider -180..180) °/m | 0 |  |  | Turns the direction of the deformation around the spine, in degrees per metre. |
| Path | Length | `pathLength` | 0.01..100 (slider 0.01..10) m | 1 |  |  | Length of exactly one tile. When it is shorter than the branch the tile repeats. |
| Path | Offset | `pathOffset` | 0..1 | 0 | yes |  | Shifts the tiles along the spine (fraction of one tile). Use the variance to avoid visible repetition between branches. |
| Break | Chance | `breakChance` | 0..1 | 0 |  |  | Probability that a node breaks and ends in an open end (a Cap can close it). |
| Break | Spot | `breakSpot` | 0.02..0.99 | 0.68 | yes |  | Where along the spine the break happens (1 = at the tip). |
| Break | Seed | `breakSeed` | seed | 0 |  |  | Random seed of which nodes break and where; nothing else changes. |
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken | taper |  |  | How the tip ends: taper, blunt or broken. Forks are made by Skin > Splits. |
| Prune | Interior | `pruneInterior` | 0..1 | 0 |  | yes | Removes branches that grow towards the inside of the model. The curve scales it along the parent. |
| Prune | Up | `pruneUp` | 0..1 | 0 |  | yes | Removes branches that grow upwards (the steeper, the more likely). |
| Prune | Down | `pruneDown` | 0..1 | 0 |  | yes | Removes branches that grow downwards (the steeper, the more likely). |
| Prune | General | `pruneGeneral` | 0..1 | 0 |  | yes | Removes branches at random with this probability. |
| Prune | Ground | `pruneGround` | 0..1 | 1 |  | yes | Removes branches that intersect the ground plane (strength = probability). |

### Tab: Forces

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Forces | Enabled | `forcesEnabled` | bool | true |  |  | Lets attached forces (gravity, wind direction, …) influence this node. |
| Influence | Influence | `forceInfluence` | 0..10 (slider 0..2) | 1 |  | yes | Global multiplier for all forces on this node. |
| Influence | Stiffness | `forceStiffness` | 0..1 | 0.5 |  | yes | Resistance against forces; stiff branches bend less. |
| Influence | Falloff | `forceFalloff` | 0..1 | 0 |  |  | How the force fades from the base to the tip. |
| Influence | Align | `forceAlign` | 0..2 (slider 0..1) | 1 |  |  | Scalar for the Align strength of every attached force: how much the forces influence the initial orientation (first segment) of this generator's branches. 1 = as set on each force, 0 = branches keep their initial orientation. |

### Tab: Shape

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Cross section | Aspect | `sectionAspect` | 0.1..4 | 1 |  | yes | Width / height ratio of the cross-section (1 = round). |
| Cross section | Roundness | `sectionRoundness` | 0..1 | 1 |  |  | Blend between a round and an angular cross-section. |
| Cross section | Profile | `sectionShape` | Round / Ridged / Lobed / Noise / Organic | round |  |  | Round, Ridged, Lobed, Noise, or Organic: an oval plus lobes whose strength, phase and orientation drift slowly along the trunk (and can spiral). |
| Cross section | Lobes | `sectionLobes` | 1..32 | 5 |  |  | Number of ribs / lobes in the cross-section. |
| Cross section | Depth | `sectionDepth` | 0..1 | 0.12 |  |  | How deep the ribs cut into the cross-section. |
| Cross section | Spiral | `sectionSpiral` | -6..6 rad/m | 0 |  |  | Twists the ribs around the stem. |
| Cross section | Noise frequency | `sectionNoiseFrequency` | 0.1..20 | 2 |  |  | Frequency of the noise in the cross-section. |
| Cross section | Oval (organic) | `sectionOval` | 0..0.6 | 0.1 |  |  | Organic profile: how far the section is stretched into an oval (fraction of the radius). The long axis turns slowly along the trunk. |
| Cross section | Drift length (organic) | `sectionDrift` | 0.05..50 (slider 0.05..10) m | 2 |  |  | Organic profile: metres of trunk for one full change of the oval, the lobe strength and their phase. Small values change quickly. |
| Cross section | Grain twist (organic) | `grainTwist` | -360..360 (slider -360..90) °/m | 0 |  |  | Organic profile: degrees per metre the lobes spiral up the trunk (spiral grain, fluting). Added to Spiral for the lobes only. |
| Flare | Radius | `flareRadius` | 0..5 (slider 0..1.5) | 0 |  | yes | Extra radius of the root flare at the base (metres). |
| Flare | Height | `flareHeight` | 0.01..1 | 0.1 |  |  | Height of the root flare as a fraction of the length. |
| Flare | Buttress lobes | `flareLobes` | 0..16 | 5 |  |  | Number of buttress lobes in the flare. |
| Flare | Noise | `flareNoise` | 0..1 | 0 |  |  | Random irregularity of the flare. |
| Bulge | Amount | `bulgeAmount` | 0..2 | 0 |  | yes | Strength of the periodic swelling of the radius. |
| Bulge | Frequency | `bulgeFrequency` | 0.1..20 | 1 |  |  | Number of swellings along the length. |
| Buttress | Count | `buttressCount` | 0..16 | 0 |  |  | Number of tall, thin fins that radiate from the base of the trunk (tropical and old trees). 0 = off. Use at least 8 radial sides per fin. |
| Buttress | Height | `buttressHeight` | 0.05..30 (slider 0.05..6) m | 1.5 |  |  | How far up the trunk the fins climb. The top edge is a concave ridge that runs out into the trunk. |
| Buttress | Length | `buttressLength` | 0..5 (slider 0..3) | 1 |  |  | How far a fin sticks out at the ground, as a multiple of the trunk radius. |
| Buttress | Thickness | `buttressThickness` | 0.02..1 | 0.3 |  |  | Width of the flat ridge of a fin relative to the space between two fins. Thin fins have concave sides. |

### Tab: Skin

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Type & Visibility | Type | `skinType` | Polygons / Spine only / SubD surface (rectangular attachments) (not yet available) / SubD surface (arbitrary attachments) (not yet available) | spine-only |  |  | Polygons builds the tube mesh. Spine only builds no mesh: the spine stays available for children such as fronds and leaves. The SubD surface types are not available yet. |
| Type & Visibility | Spine only | `spineOnly` | bool | false |  |  | Legacy switch: use Type instead. |
| Type & Visibility | Visibility | `skinVisibility` | curve | curve |  |  | Runs along the parent (left = base, right = tip). Branches that grow where the curve is above 0.5 get geometry, the others stay invisible but keep their children. |
| Radius | Absolute | `skinRadiusAbsolute` | 0..10 (slider 0..0.5) m | 0 |  |  | Radius in metres added to the base radius of every branch. |
| Radius | + % of parent | `skinRadiusPercent` | 0..2 (slider 0..1) | 0 |  |  | Adds this fraction of the parent radius at the attachment to the base radius. |
| Radius | Clamp to parent | `skinRadiusClampParent` | bool | false |  |  | A branch never gets thicker than its parent at the attachment. |
| Radius | Length compensation | `skinLengthCompensation` | 0..1 | 0 |  |  | Enlarges the tip radius of branches that thin out to a point too fast: 1 keeps up to half of the base radius at the tip. |
| Radius | Length kill ratio | `skinLengthKill` | 0..10000 (slider 0..500) | 0 |  |  | Removes branches whose length divided by radius is above this value (very long, thin whips). 0 = off. |
| Irregularity | Amount | `radiusNoiseAmount` | 0..0.6 (slider 0..0.3) | 0 |  | yes | Irregularity of the radius: slow swells and pinches along the branch, as a fraction of the radius (RMS). 0 = a clean taper. The curve runs along the branch (left = base, right = tip). |
| Irregularity | Scale | `radiusNoiseScale` | 0.05..50 (slider 0.05..10) m | 1.5 |  |  | Wavelength of the swells in metres (a second octave at 3x the frequency and 0.4 of the amplitude adds detail). |
| Irregularity | Seed | `radiusNoiseSeed` | seed | 0 |  |  | Random seed of the radius irregularity only; nothing else changes. |
| Irregularity | Along parent | `radiusNoiseParent` | 0..1 (slider 0..1) | 1 |  | yes | Multiplies the irregularity of a child by this curve along its parent (left = parent base, right = parent tip). |
| Radius | Light seam reduction | `seamReduction` | 0..1 | 0 |  |  | Bends the normals toward the spine direction, strongest at the base of a branch where lighting seams show at the junction. |
| Radius | Roll | `skinRoll` | -180..180 ° | 0 |  |  | Rotates the skin around the spine without changing its shape (rotates the section, the squash and the texture). |
| Radius | Smooth | `skinSmooth` | 0..1 | 0 |  |  | Pushes the vertices out on the inner side of bends so the tube does not pinch. |
| Clamp | Min | `skinRadiusMin` | 0..10 (slider 0..0.05) m | 0 |  |  | Smallest radius of any point. 0 = off. |
| Clamp | Max | `skinRadiusMax` | 0..10 (slider 0..1) m | 0 |  |  | Largest radius of any point. 0 = off. |
| Squash | Amount | `squashAmount` | 0..1 | 0 |  |  | Reduces the radius on one side: the section becomes an ellipse (1 = flat). Welds follow the squashed profile. |
| Squash | Rotate | `squashRotate` | -180..180 ° | 0 |  |  | Direction of the flattened side around the spine. |
| Splits | Chance | `splitsChance` | 0..1 | 0 | yes |  | Probability that the branch divides into two open ends at its tip. The U tile count around the branch must be even (at least 2): an odd count is raised to the next even number when the branch splits, and the node reports it as a warning. |
| Splits | Balance | `splitsBalance` | 0..1 | 0.5 | yes |  | 0.5 gives both sides the same radius; lower or higher moves radius from Side 1 to Side 2 (the cross-section area is kept). |
| Splits | Seed | `splitsSeed` | seed | 0 |  |  | Seed of the split decision: changes which branches split without changing anything else. |
| Splits | Fork type | `splitsMode` | Y / Lateral | y |  |  | Y = a symmetric fork (two lobes, Balance and the two Spread angles). Lateral = the branch keeps going with a slight kink and a clearly thinner side branch leaves at the Spread angle from a swelling (the branch-like fork of old oaks); the neck swell, ridge and valley fillet of the junction are applied automatically. |
| Splits | Dominance | `splitsDominance` | 0..1 | 0 | yes |  | Dominant leader. 0 = Balance only. Towards 1 the fat half continues the direction of the branch almost unchanged (its deviation shrinks down to 25 % of its Spread) while the skinny half leaves at its full Spread with a smaller radius. r1^e + r2^e = R^e still holds. Extend parent Fat / Skinny keep working. |
| Splits | Lateral chance | `splitsLateralChance` | 0..1 | 0 | yes |  | Fork type Y only: probability that a fork is a lateral (one-sided) one instead, drawn per fork from the Splits seed, so one tree mixes Y and lateral forks. |
| Split spread | Side 1 | `splitsSpread1` | 0..80 ° | 22 | yes |  | Angle of Side 1 away from the centre of the tree. |
| Split spread | Side 2 | `splitsSpread2` | 0..80 ° | 22 | yes |  | Angle of Side 2 toward the centre of the tree. |
| Split expand | Side 1 | `splitsExpand1` | 0.5..2 | 1 | yes |  | Scales the cross-section of Side 1 from its default (1). |
| Split expand | Side 2 | `splitsExpand2` | 0.5..2 | 1 | yes |  | Scales the cross-section of Side 2 from its default (1). |
| Split smooth | Inner | `splitsSmoothInner` | 0..1 | 0.25 | yes |  | 0 = hard crease between the two sides, 1 = no crease. |
| Split smooth | Outer | `splitsSmoothOuter` | 0..1 | 0.5 | yes |  | Smoothness of the outer bend where the split occurs (0 = hard corner). |
| Split advanced | Area exponent | `splitsAreaExponent` | 1.5..3 | 2 |  |  | Pipe-model exponent e of r1^e + r2^e = parent radius^e. 2 keeps the cross-section area of the parent; higher values make both halves thicker. |
| Split advanced | Down bias | `splitsDownBias` | 0..1 | 0 |  |  | Turns both halves toward gravity after the sides are balanced (roots default to 0.4). A half never points higher than the branch it leaves. |
| Split shape | Waist | `splitsWaist` | 0.2..1 | 1 |  |  | Width of the neck at the middle of the transition relative to the narrower lobe. 1 = the former outline, 0.6 = a pronounced figure-8 (peanut) that pinches and then separates. |
| Split shape | Neck swell | `splitsNeckSwell` | 0..0.5 | 0 |  |  | The parent swells by up to this fraction of its radius just before the fork. The swell is paid from the area reservoir of the lobes: the open ends keep r1^e + r2^e = R^e. |
| Split shape | Valley radius | `splitsValleyRadius` | 0..1 | 0 |  |  | Fillet radius of the valley between the lobes as a fraction of the smaller lobe radius. 0 = the former crease (Smooth > Inner still mixes crease and no crease); the radius fades to 0 at the open ends. |
| Split shape | Ridge | `splitsRidge` | 0..1 | 0 |  |  | Raised bark ridge along the pinch axis from the valley down to the crotch point; height as a fraction of the smaller lobe radius, width about the valley radius. |
| Split shape | Ridge length | `splitsRidgeLength` | 0.25..8 R | 2 |  |  | Length over which the ridge blends into the parent, in parent radii counted back from the crotch. |
| Split shape | Stretch | `splitsStretch` | 0.8..1.6 | 1 |  |  | Elongates the section along the divergence axis early in the transition (ovalisation before the pinch). 1 = none. |
| Split shape | Included bark | `splitsIncludedBark` | 0..1 | 0 | yes |  | Codominant stems with included bark: deepens the valley into a narrow, dark, V-shaped crevice with a bark ridge (smaller valley radius, narrower neck, a ridge, stronger ambient occlusion). 0 = off. |
| Split shape | Ease | `splitsEase` | 0..1 | 0 |  |  | Easing of the separation along the transition: 0 = smoothstep as before, 1 = the lobes stay merged longer and then pinch off suddenly. |
| Geometry | Close end | `capEnd` | bool | true |  |  | Closes the tip of the tube with a cap. |
| Geometry | Tip rings | `tipRings` | 1..8 | 2 |  |  | Rings of the rounded tip cap. |
| Geometry | Close base | `capBase` | Auto / Yes / No | auto |  |  | Auto closes branches that do not grow from a parent. |
| Geometry | Twist | `skinTwist` | -720..720 °/m | 0 |  |  | Twists the surface texture and geometry around the axis. |
| Junction | Collar | `collarAmount` | 0..2 | 0.3 |  |  | Radius flare where a branch leaves its parent. |
| Junction | Collar length | `collarLength` | 0.1..10 | 1.5 |  |  | Length of the flare in branch radii. |
| Junction | Collar swell | `collarSwell` | 0..1 | 0 |  |  | Raised shoulder where the branch meets its parent: the skin around the junction is pushed out by this fraction of the branch radius in a smooth bump (length: Collar length x radius). 0 = off. Not used where Welding is on (Spread does that job). |
| Normals | Smoothing | `smoothing` | 0..1 | 1 |  |  | Below 0.5 the tube is faceted (unwelded quads). |
| Normals | Flatten | `flatten` | 0..1 | 0 |  |  | Flattens normals towards the axis to soften the shading. |
| Vertex color | Tint | `tint` | color | [0.36, 0.26, 0.18, 1] |  |  | Vertex colour multiplied onto the material. |
| Vertex color | Variance | `tintVariance` | 0..1 | 0.1 |  |  | Random variation of the vertex colour per instance. |
| Vertex color | AO strength | `aoStrength` | 0..1 | 0.6 |  |  | Strength of the baked vertex ambient occlusion. |
| Vertex color | Mode | `vcMode` | Inherit / Multiply / Set / Add | inherit |  |  | Inherit: the colour is the bark colour blended with the parent at the junction (earlier behaviour). Multiply: tint it by Color. Set: replace it with Color. Add: brighten it by Color. Profile and Parent curve control where along the branch and along the parent the change applies. |
| Vertex color | Color | `vcColor` | color | [1, 1, 1, 1] |  |  | Linear colour used by Multiply, Set and Add. |
| Vertex color | Variance | `vcVariance` | 0..1 | 0 |  |  | Per-branch brightness variation (+-), deterministic from the seed. 0 = none. |
| Vertex color | Seamless | `vcSeamless` | bool | false |  |  | The colour at the attach point equals the parent colour exactly and blends into this generator's own colour along the collar (needs the parent to be meshed first; falls back to the bark colour otherwise). |
| Vertex color | Profile | `vcProfile` | curve | curve |  |  | Strength of the Mode along this branch (left: base, right: tip). 1 = full effect, 0 = the inherited colour. Use it for lighter young twigs, darker trunk bases or leaf tips. |
| Vertex color | Parent curve | `vcParentCurve` | curve | curve |  |  | Strength of the Mode by the position of the attach point on the parent (left: parent base, right: parent tip). Ignored without a parent. |

### Tab: UV Mapping

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Mapping | Style | `uvStyle` | Unrestricted / U locked [0,1], V unrestricted / U and V locked [0,1] | unrestricted |  |  | Unrestricted lets the coordinates tile freely. The locked styles keep U (or U and V) inside 0..1: one texture copy around the branch, and for U and V locked one along it. Offsets and twist are ignored while locked. |
| Mapping | Rotate 90° | `uvRotate` | bool | false |  |  | Swaps U and V (turns the texture a quarter turn). |
| U | Absolute | `uvUAbsolute` | 0..64 (slider 0..8) | 0 |  |  | Texture copies around the branch regardless of its thickness. The total is always a whole number, at least 1. |
| U | + Relative | `uvURelative` | 0..16 (slider 0..4) | 1 |  |  | Extra copies per metre of circumference, so thick branches get more (1 = one copy per metre of girth, the classic world-size tiling). |
| U | Offset | `uvOffsetU` | -10..10 | 0 | yes |  | Turns the texture around the branch (in copies). The variance turns every branch by a random amount, so the seam faces a different way. |
| Fractional | Enable | `uvFractional` | bool | false |  |  | Allow a fractional number of copies around the branch. The texture no longer closes on itself, so a seam can show. |
| Fractional | Auto | `uvFractionalAuto` | bool | false |  |  | Uses the same texel density as the parent branch (copies per metre of girth). A seam may appear. |
| Fractional | Value | `uvFractionalValue` | 0.01..64 (slider 0.01..8) | 1 |  |  | Free number of copies around the branch; Absolute and Relative are ignored. |
| Twist | Amount | `uvTwist` | -16..16 (slider -2..2) | 0 |  |  | Turns per V tile: the texture spirals around the branch as it runs along it. |
| Twist | Random flip | `uvTwistFlip` | bool | false |  |  | Gives every branch a random spiral direction. |
| V | Style | `uvVStyle` | Absolute / Relative (keep aspect ratio) / Relative | absolute |  |  | Absolute: copies per metre of length. Relative (keep aspect ratio): the texture keeps its proportions, a copy is as long as it is wide. Relative: the texture is stretched over the whole length of the branch. |
| V | Anchor | `uvVAnchor` | Start / End | start |  |  | Which end of the branch lies on a whole V number (End puts a texture edge exactly at the tip). |
| V | Scale | `uvScaleV` | 0.01..100 (slider 0.01..10) | 1 |  |  | Absolute: V copies per metre. Relative (keep aspect ratio): multiplies the density. Relative: the number of copies along the branch. |
| V | Skew correction | `uvSkew` | 0..1 | 0 |  |  | Compensates the narrowing or widening of a tapering branch (0 = the texture tapers with it, 1 = it keeps its proportions everywhere). |
| V | Pinch | `uvPinch` | 0..1 | 0.25 |  |  | Stops the texture from racing along the last stretch of a pointed tip (higher values keep the radius used for V further from zero). |
| V | Offset | `uvOffsetV` | -10..10 | 0 | yes |  | Moves the texture along the branch (in copies). The variance starts every branch at a random V. |
| Tiling | Optimize segments | `uvOptimize` | bool | false |  |  | Avoids rings that are very close together near a patch seam (or a whole V number): the seam moves onto a ring within the V tolerance instead of adding one. |
| Tiling | V tolerance | `uvVTolerance` | 0..0.5 | 0.1 |  |  | How close (in V) a ring must be to a whole number to be moved onto it while Optimize segments is on. |
| Tiling | Create seams | `uvCreateSeams` | bool | false |  |  | Cuts real geometry (doubled ring vertices) at every whole U tile border so each tile around the branch is its own UV island: the branch texture can then sit in an atlas without resolution loss. Positions and normals stay continuous across the cut (the mesh is still watertight when welded). |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Reduction | Side reduction | `lodSides` | 0..1 | 0.5 |  |  | How many sides are removed at lower LODs. |
| Reduction | Segment reduction | `lodSegments` | 0..1 | 0.5 |  |  | How many segments are removed at lower LODs. |
| Reduction | Cull amount | `lodCull` | 0..1 | 0 |  |  | Fraction of small children removed at lower LODs. |
| Distance | Fade start | `lodFadeStart` | 0..1 | 0.5 |  |  | Distance where this node starts fading out. |
| Distance | Fade end | `lodFadeEnd` | 0..1 | 1 |  |  | Distance where this node has completely faded. |
| Dynamic LOD | Weight | `lodWeight` | 0..1 | 0.5 |  |  | Priority to survive when Tree > Dynamic LOD removes pieces of the same type (branches, leaves, fronds, decorations): pieces of a generator with a higher Weight are removed later. 0.5 = neutral; equal weights never change the ranking. |
| Dynamic LOD | Optimization | `lodOptimization` | 0..45 ° | 0 |  |  | Degrees added to the straight-section merge angle (Segments > Optimization) for every LOD step: lower levels merge nearly straight length segments more aggressively. 0 = unchanged. |
| Dynamic LOD | Length segments | `lodLengthSegments` | 0.1..1 | 1 |  |  | Scalar applied to the number of length segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Dynamic LOD | Radial segments | `lodRadialSegments` | 0.1..1 | 1 |  |  | Scalar applied to the number of radial (or width) segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Lightmap | Lightmap weight | `lightmapWeight` | 0..4 | 1 |  |  | Relative texel density of this generator in the lightmap UVs (Tree > Lightmap, export). 1 = the same density as the other generators, 2 = twice the density, 0 = one texel per piece (a leaf gets a single texel). Leaves start at 0; the "Reset lightmap" command restores the defaults. |

### Tab: Displacement

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Main | Source | `displaceSource` | Noise / Material / Displacement / Bark | noise |  |  | Where the height values come from: built-in noise, the Height map of the assigned material, a named asset from the Displacements panel, or procedural Bark relief (see the Bark section). |
| Main | Displacement | `displacement` | None |  |  |  | Height map from the Displacements panel. A warning badge shows on the node when the map is missing or not loaded. |
| Main | Radial amount | `displaceRadial` | -5..5 (slider -0.3..0.3) m | 0 |  |  | Largest move away from (positive) or toward (negative) the spine, in metres. |
| Main | Length amount | `displaceLength` | -5..5 (slider -0.3..0.3) m | 0 |  |  | Largest move along the spine, in metres. Vertices that share a V coordinate no longer sit in one plane. |
| Main | Sharpness | `displaceSharpness` | curve | curve |  |  | Remaps the displacement values. A straight line leaves them unchanged; a curve that stays low and rises late keeps only the highest values. |
| Main | Mapping | `displaceMapping` | Use UVs / Fit to geometry | use-uvs |  |  | Use UVs follows the branch UV tiling; Fit to geometry wraps the pattern once around and once along the branch. |
| Main | U scale | `displaceUScale` | 0.05..50 (slider 0.05..10) | 1 |  |  | Pattern size around the branch (larger = more repeats). |
| Main | V scale | `displaceVScale` | 0.05..50 (slider 0.05..10) | 1 |  |  | Pattern size along the branch (larger = more repeats). |
| Main | Seed | `displaceMainSeed` | 0..99999 | 0 |  |  | Random seed of the noise source. |
| Fine | Amount | `displaceFineAmount` | -2..2 (slider -0.1..0.1) m | 0 |  |  | Second, always-noise displacement along the surface normal, added on top of the main one. |
| Fine | Sharpness | `displaceFineSharpness` | curve | curve |  |  | Remaps the fine noise values (straight line = unchanged). |
| Fine | Scale | `displaceFineScale` | 0.1..8 (slider 0.1..3) | 1 |  |  | Size of the fine noise. Above 1 the surface is pushed out on average, below 1 it is pulled in toward the center. |
| Shape | Amount | `displaceShapeAmount` | -1..1 | 0 |  |  | Depth of the creases that run along the spine, as a fraction of the local radius. |
| Shape | Twist | `displaceShapeTwist` | -720..720 (slider -90..90) °/m | 0 |  |  | Rotates the crease pattern around the spine while it climbs from the base (degrees per metre). |
| Shape | Scale | `displaceShapeScale` | 0.1..10 (slider 0.1..4) | 1 |  |  | Number of creases around the branch (larger = more, thinner creases). |
| Shape | Seed | `displaceShapeSeed` | seed | 0 |  |  | Displacement setting (height-map driven surface detail). “Seed” in Displacement › Shape. |
| Flares | Radius | `displaceFlareRadius` | 0..8 (slider 0..2) | 0 |  |  | Largest flare, as a multiple of the branch radius at its base. 0 turns the flares off. |
| Flares | Noise scale | `displaceFlareNoise` | 1..32 | 5 |  |  | Number of flare lobes around the branch. |
| Flares | Height | `displaceFlareHeight` | 0.01..50 (slider 0.01..5) m | 1 |  |  | How far up the spine the flares reach. |
| Flares | Pinch | `displaceFlarePinch` | 0..1 | 0 |  |  | Pulls the flares toward the center spine. At 1 the lobes are thin ridges and nothing spreads at the base. |
| Flares | Angle | `displaceFlareAngle` | -180..180 ° | 0 |  |  | Rotates the flares around the spine. |
| Flares | Seed | `displaceFlareSeed` | seed | 0 |  |  | Displacement setting (height-map driven surface detail). “Seed” in Displacement › Flares. |
| Bark | Style | `barkStyle` | Furrowed / Plated / Fibrous / Lenticel / Rings / Scaly | furrowed |  |  | Furrowed: long ridges and V-shaped crevices (oak, pine, elm). Plated: blocky plates between cracks (redwood, old bark). Fibrous: thin parallel fibres (cedar). Lenticel: smooth bark with short horizontal slits (cherry, birch). Rings: regular horizontal rings (palm, bamboo). Scaly: overlapping scales (cypress). |
| Bark | Depth | `barkDepth` | 0..1 (slider 0..0.3) | 0 |  |  | Relief from crevice bottom to ridge top as a fraction of the local radius, so thick trunks get deep furrows. 0 turns the bark relief off. |
| Bark | Scale | `barkScale` | 0.005..5 (slider 0.005..0.5) m | 0.08 |  |  | Feature size in metres (furrow spacing, plate width, ring spacing). Independent of UV tiling and of the number of rings. |
| Bark | Stretch | `barkStretch` | 0.1..40 (slider 0.1..12) | 4 |  |  | Feature length along the spine compared with its width (furrows, plates, fibres, scales). Lenticel: slit width across the trunk. Rings: not used. |
| Bark | Warp | `barkWarp` | 0..2 | 0.5 |  |  | Domain warp strength: how much the furrows, cracks and rings meander instead of running straight. |
| Bark | Crevice | `barkCrevice` | 0..1 | 0.5 |  |  | Crevice profile: 1 = narrow V-shaped crevices with wide tops, 0.5 = linear, 0 = wide flat-bottomed troughs. Works like the Main Sharpness curve and stacks with it. |
| Bark | Maturity | `barkMaturity` | 0..1 | 0 |  |  | How strongly the depth follows the branch radius: 0 = every branch has the same relief, 1 = young thin twigs are smooth and old thick trunks get the full depth. |
| Bark | Smooth up to radius | `barkMaturityMin` | 0..5 (slider 0..0.3) m | 0.01 |  |  | Radius at and below which the bark is smooth (Maturity > 0). A smoothstep leads to the full depth at the next radius. |
| Bark | Full depth at radius | `barkMaturityMax` | 0.001..5 (slider 0.001..0.5) m | 0.15 |  |  | Radius from which the bark has its full depth (Maturity > 0). |
| Bark | Maturity along branch | `barkMaturityCurve` | curve | curve |  |  | Depth multiplier from the base (left) to the tip (right) of each branch. A flat line at 1 leaves the depth unchanged. |
| Bark | Seed | `barkSeed` | seed | 0 |  |  | Random seed of the bark pattern. Every branch lineage also gets its own pattern. |
| Fade | Fade at junctions | `displaceFadeBase` | 0..10 | 1.5 |  |  | Fade-in length (in radii) past the weld / junction rings: prevents cracks where a branch leaves its parent. |
| Fade | Fade at tips | `displaceFadeTip` | 0..10 | 1 |  |  | Fade-out length (in radii) toward the tip / cap. |
| Fade | LOD fade | `displaceLodFade` | bool | true |  |  | Fade the displacement out between LOD 1 and 3. |
| Subdivision | Auto-subdivide | `displaceAutoSubdivide` | bool | true |  |  | Add rings and sides so the mesh has enough vertices to carry the displacement. |
| Subdivision | Detail size | `displaceDetail` | 0.002..1 (slider 0.002..0.2) m | 0.03 |  |  | Target quad size when auto-subdividing (smaller = more detail, more triangles). |
| Subdivision | Max vertices | `displaceMaxVertices` | 500..1000000 (slider 500..200000) | 40000 |  |  | Bark: most vertices auto-subdivision may create for one branch, so a small Scale cannot freeze the browser. Features coarsen when the cap is reached. |
| Subdivision | Min sides | `displaceMinSides` | 3..128 | 16 |  |  | Fewest sides around a displaced branch. |
| Asset amount (legacy) | Amount | `displaceAmount` | -5..5 (slider 0..0.2) m | 0 |  | yes | Older asset displacement in metres at full height. The curve scales it along the branch length. |
| Asset amount (legacy) | + % of radius | `displaceRadiusAmount` | -1..2 | 0 |  |  | Extra amount relative to the local radius. |
| Asset amount (legacy) | Offset | `displaceOffset` | -1..1 | 0 |  |  | Bias added to the height before scaling. |
| Asset amount (legacy) | Mid-grey is neutral | `displaceMidGrey` | bool | true |  |  | On: 50% grey does not move the surface. Off: black = none, white = full amount outward. |
| Asset amount (legacy) | Direction | `displaceDirection` | Normal / Radial | normal |  |  | Displace along the surface normal or radially from the axis. |
| Asset mapping (legacy) | Tiling | `displaceTiling` | World / Normalized | world |  |  | World: one image tile covers "Tile size" metres. |
| Asset mapping (legacy) | Tile size | `displaceTileSize` | 0.005..50 (slider 0.005..4) m | 0.5 |  |  | World size of one displacement tile. |
| Asset mapping (legacy) | Scale | `displaceScale` | 0.01..50 | 1 |  |  | Height of the displacement. |
| Asset mapping (legacy) | Scale U | `displaceScaleU` | 0.01..50 | 1 |  |  | Displacement tiling around the stem. |
| Asset mapping (legacy) | Scale V | `displaceScaleV` | 0.01..50 | 1 |  |  | Displacement tiling along the stem. |
| Asset mapping (legacy) | Rotation | `displaceRotation` | -360..360 ° | 0 |  |  | Snapped to 90° steps while seams are locked. |
| Asset mapping (legacy) | Lock seams | `displaceLockSeams` | bool | true |  |  | Round the tiling around the trunk to a whole number so the U seam is continuous. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Material | Material | `material` | None |  |  |  | Material (or Material Set) used for this node; empty = the default for the node type. |
| Material | Tint | `materialTint` | color | [1, 1, 1, 1] |  |  | Colour multiplied onto the material. |
| Material | Variation | `materialVariation` | 0..1 | 0 | yes |  | How much the material variation colours are applied. |
| Blend | Base blend | `blendBase` | 0..1 | 0 |  | yes | Blends the material towards the parent at the base. |
| Blend | Height blend | `blendHeight` | 0..1 | 0 |  |  | Blends the material along the height. |
| Season | Start offset | `seasonStartOffset` | -1..1 (slider -1..1) | 0 | yes | yes | Season start offset: 0 = the transition follows the Season slider immediately, positive values delay it, negative values start it earlier. Variance spreads it per element; the curve runs along the parent. |
| Season | Time scale | `seasonTimeScale` | 0..10 (slider 0..2) | 1 | yes | yes | Season time scale: 1 = one slider sweep is one year of this node; 2 = twice as fast, 0 = never changes. |
| Season | Descendant offset | `seasonDescendantOffset` | -1..1 (slider -1..1) | 0 | yes |  | Season descendant offset: shifts the transition of this node AND of every node below it (positive = later). Use it so that thin twigs change after the trunk. |

### Tab: Animation

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Wind hierarchy | Hierarchy | `windHierarchy` | Trunk / Branch 1 / Branch 2 / Leaf | branch-1 |  |  | Which level of the wind hierarchy this geometry follows (trunk, branch 1/2, leaf). |
| Amount | Amount | `windAmount` | 0..10 (slider 0..2) | 1 |  | yes | Strength multiplier of the wind on this node. |
| Amount | Phase variance | `windPhaseVariance` | 0..1 | 0.5 |  |  | Random phase offset of the branch-level sway (0 = a branch sways in phase with the branch it grows from, 1 = fully random) so neighbours do not sway in sync. Deeper twigs and leaves always keep the phase of their level-1 ancestor. |

### Tab: Segments

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
|  | Accuracy | `accuracy` | 4..256 | 24 |  |  | Exact number of points of the high-resolution spine the branch is built from (higher = smoother, slower). |
|  | Influence | `segmentInfluence` | 0..4 (slider 0..2) | 1 |  |  | Scales how strongly forces and spine properties act per accurate segment. 1 keeps the shape when Accuracy changes. |
|  | Scalar | `segmentScalar` | 0.1..4 (slider 0.1..2) | 1 |  |  | Multiplies the polygon count of the mesh (length and radial segments). |
| Length | Style | `lengthStyle` | Default / Legacy | default |  |  | Default builds the accurate layout with the relative basis; Legacy keeps the older layout (relative segments per metre). |
| Length | Absolute | `segments` | 1..512 | 8 |  |  | Minimum number of length segments. |
| Length | + Relative | `relativeSegments` | 0..20 (slider 0..2) | 0 |  |  | Adds more length segments, multiplied by the Relative basis. |
| Length | Relative basis | `relativeBasis` | Length only / Length/radius ratio / Parent's length segments | length-radius-ratio |  |  | What + Relative is multiplied by: the branch length, its length / radius ratio (recommended) or the length segments of the parent. |
| Length | Weld scalar | `weldScalar` | 0..4 (slider 0..2) | 1 |  |  | Scales the number of segments in the weld part, where the branch is fused to its parent. |
| Length | Optimization | `optimization` | 0..45 ° | 0 |  |  | Drops segments where the spine is nearly straight: the larger the value, the bigger the bend must be to keep a segment (0 = keep all). |
| Radial | Absolute | `sides` | 0..64 | 6 |  |  | Minimum number of radial segments (sides). |
| Radial | + Relative | `radialRelative` | 0..200 (slider 0..40) | 0 |  |  | Adds radial segments, multiplied by the Relative basis. |
| Radial | Relative basis | `radialBasis` | Radius / Parent's radial segments | radius |  |  | What + Relative is multiplied by: the branch radius in metres or the radial segments of the parent. |

### Tab: Physics _(not implemented yet - shown disabled)_

### Tab: Hand Drawn

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Hand drawn | Enabled | `handDrawn` | bool | false |  |  | Enables hand-drawn control of the spine shape. |
| Hand drawn | Strength | `handStrength` | 0..1 | 1 |  |  | Strength of the hand-drawn influence. |
| Hand drawn | Smoothing | `handSmoothing` | 0..1 | 0.5 |  |  | Smoothing of the hand-drawn spine. |

## Leaf (`generator.leaf`) - Leaves tab

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Leaves | Use actual size | `leafUseActualSize` | bool | false |  |  | Ignore Size and use the mesh at the real size it was authored at (cards keep Width × Height). |
| Leaves | Size | `leafSize` | 0.001..20 (slider 0.001..3) | 1 | yes | yes | Scale of the leaf (the mesh is treated as a unit mesh of Width × Height). A curve varies it along the parent. |
| Leaves | +% of parent | `leafSizeParent` | 0..500 (slider 0..100) % | 0 |  |  | Adds this percentage of the parent branch length to Size, so leaves grow with their parent. |
| Leaves | Weld | `leafWeld` | bool | false |  |  | Place leaves on the skin of the parent tube instead of on its centre line. |
| Leaves | Keep failed welds | `leafKeepFailedWelds` | bool | true |  |  | If a weld fails (the parent has no skin), still place the leaf on the centre line. Off drops the leaf. |
| Leaves | Cross | `leafCross` | bool | false |  |  | Adds a second copy of every leaf turned 90° about its growth axis (crossed planes). |
| Leaves | Fix winding | `leafFixWinding` | bool | true |  |  | After all deformation and mirroring, flips triangles whose order disagrees with the normals. |
| Leaves | Flip | `leafFlip` | bool | false |  |  | Mirrors a random half of the leaves across their local Y axis. |
| Leaves | Initial orientation | `leafInitialOrientation` | Classic / Synchronized | synchronized |  |  | Classic mirrors leaves on the left / right side of the parent (needs Interval or Phyllotaxy placement, else sides are random). Synchronized keeps one orientation. |
| Type | Type | `leafTypes` | rows of Material / Mesh / Weight | one row |  |  | Materials (and meshes) the instances are picked from. A row is chosen with probability Weight / sum of Weights. |
| Local orientation | 3D anchor style | `orientAnchorStyle` | Legacy / Match parent | match-parent |  |  | Match parent follows the parent’s orientation and twist. Legacy ignores them: use it when the parent is also a leaf. |
| Local orientation | Unification | `orientUnification` | Global / Deep / Intermediate / Local / None | none |  |  | Turns the leaf to point “out”: away from an anchor through the attachment point (Global = tree base, Deep = base near the root, Intermediate = middle of the ancestors, Local = base of the parent). |
| Local orientation | Sky influence | `orientSky` | 0..1 | 0 |  |  | Turns the leaf’s face (local Z) toward the sky. 1 = straight up. |
| Local orientation | Fold | `orientFold` | -180..180 ° | 0 |  |  | Rotates the leaf up or down around the parent’s growth direction. |
| Local orientation | Align | `orientAlign` | -180..180 ° | 0 |  |  | Rotates the leaf tip toward (+) or away from (−) the parent’s growth direction. |
| Local orientation | Face | `orientFace` | 0..1 | 0 |  |  | Spins the leaf around its stem so its up vector points along the parent’s growth (leaves face outward). 1 = fully. |
| Sensitivity → Parent | Amount | `parentAmount` | 0..1 | 0 |  |  | Turns the underside of the leaf toward the anchor. |
| Sensitivity → Parent | Anchor | `parentAnchor` | Global / Deep / Intermediate / Local / None | none |  |  | Anchor the leaf bottom turns toward. |
| Sensitivity → Parent | Sky | `parentSky` | 0..1 | 0 |  |  | Spins the leaf around its central axis so its face is as close to up as possible. |
| Final adjustments | Up | `finalUp` | -180..180 ° | 0 |  |  | Rotation around the leaf’s local X axis. Applied last, together with Right and Out. |
| Final adjustments | Right | `finalRight` | -180..180 ° | 0 |  |  | Rotation around the leaf’s local Y axis. |
| Final adjustments | Out | `finalOut` | -180..180 ° | 0 |  |  | Rotation around the leaf’s local Z axis. |

### Leaves tab - how the pieces fit together

Existing Leaf tabs (Generation, Skin, Forces, Orientation, Material, Lighting, Wind, Post) are unchanged. The *Leaves* tab adds placement and orientation:

* **Frame.** A leaf has local X = across the blade, Y = growth (base to tip), Z = face (`X × Y`). Angles are shown in degrees; the 0..1 values are blend amounts.
* **Order.** The Orientation tab builds the starting pose (angle to parent, facing, droop, roll). Then, in this order: 3D anchor style, Unification, Sky influence, Fold, Align, Face, Sensitivity → Parent (Amount, then Sky), and last the Final adjustments (Up, Right, Out as one group, rotating about the original local axes).
* **3D anchor style.** *Match parent* uses the parent's own frame (incl. twist) for the outward direction; *Legacy* uses a world-up based frame (use it for leaves on leaves).
* **Anchors** (Unification, Sensitivity → Parent). Chain = base positions of the ancestors, highest first, ending with the parent: *Global* = first entry (where the highest ancestor meets the ground), *Deep* = second entry, *Intermediate* = middle entry, *Local* = the parent's base, *None* = off. Chains travel with the structure (`StructureData.lineage`, published by Trunk / Branch / Root / Spine / Split / Knot / Leaf); without it the chain only holds the parent.
* **Unification** turns the leaf axis fully to the direction anchor → attachment point, replacing the Orientation-tab angle; Fold, Align and the rest then adjust it.
* **Size.** The card / mesh is a unit mesh of Width × Height; Size scales it, *+% of parent* adds that share of the parent branch length to Size. *Use actual size* ignores both and uses the cutout mesh at its authored size (cards keep Width × Height).
* **Weld** moves the base from the parent's spine onto its skin (radius at the attachment, in the leaf's outward direction). Parents thinner than 1.5 mm (leaves, fronds) have no skin: the weld fails and *Keep failed welds* decides whether the leaf stays on the spine or is dropped.
* **Cross** adds a copy of every card turned 90° about the leaf axis at the same position.
* **Flip / Initial orientation.** Flip mirrors a random half of the leaves across local Y. With Flip off, *Classic* mirrors leaves on the left side of the parent; *Synchronized* (default, identical to older projects) never mirrors. The side (±1) comes from this node's Interval / Phyllotaxy placement (alternating per slot), else from the parent's `side` skeleton attribute (written by Branch placed with Interval / Phyllotaxy), else it is random per leaf. Mirrored leaves get reversed winding; *Fix winding* flips triangles that disagree with their normals after all deformation.
* **Back-compat.** The former Skin › Size *Scale* is now Leaves › *Size* (`leafSize`, migrated on load); the *Type* list (`leafTypes`) moved from Material › Leaves to Leaves › Type. Every new parameter defaults to a neutral value.

## Leaf (`generator.leaf`) - Deformation tab

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Deformation | Height | `deformHeight` | -1..1 (slider -0.1..0.1) m | 0 | yes | yes | Pushes vertices along their normals by the Height map of the leaf’s material (mid grey = no change). Needs a Height texture in the material. |
| Deformation | Fold | `deformFold` | -90..90 ° | 0 | yes | yes | Folds both halves of the leaf lengthwise about its Y axis. Negative folds down, positive folds up. |
| Deformation | Curl | `deformCurl` | -180..180 ° | 0 | yes | yes | Curls the leaf around its X axis: the total angle between base and tip. |
| Deformation | Twist | `deformTwist` | -360..360 ° | 0 | yes | yes | Twists the leaf about its Y axis. The farther a vertex is from the X axis, the larger its rotation. |
| Vertex | Amount | `vertexAmount` | 0..1 (slider 0..0.1) m | 0 | yes | yes | Strength of the random per-vertex offset (noise in the leaf’s local space). |
| Vertex | Noise | `vertexNoise` | 0.1..50 (slider 0.1..10) | 2 |  |  | Tightness of the vertex noise: higher values make smaller, more localized bumps. |
| Vertex | Seed | `vertexSeed` | seed | 0 |  |  | “Seed” in Deformation › Vertex. |
| Scale | X | `deformScaleX` | 0.01..10 (slider 0.01..3) | 1 | yes | yes | Scales each leaf along its local X axis. The attachment point stays fixed. |
| Scale | Y | `deformScaleY` | 0.01..10 (slider 0.01..3) | 1 | yes | yes | Scales each leaf along its local Y axis. The attachment point stays fixed. |
| Scale | Z | `deformScaleZ` | 0.01..10 (slider 0.01..3) | 1 | yes | yes | Scales each leaf along its local Z axis. The attachment point stays fixed. |

## Leaf (`generator.leaf`) - Resolution tab

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Resolution | Size increase % | `resSizeIncrease` | curve | curve |  |  | Enlarges leaves at lower detail to make up for fewer leaves. X: LOD (0 = highest detail … 3 = lowest), Y: percent. |
| Resolution | Mesh LOD | `resMeshLod` | curve | curve |  |  | Which mesh version to use at each LOD. X: LOD (0 … 3), Y: 0 = High, 1 = Medium, 2 = Low. |
| Resolution | Mesh LOD offset | `resMeshLodOffset` | -2..2 | 0 |  |  | Shifts the chosen mesh LOD toward lower (+) or higher (−) detail. Needs at least two mesh LOD slots filled: with one, it is ignored. |
| Dynamic LOD | Weight | `lodWeight` | 0..1 | 0.5 |  |  | Priority to survive when Tree > Dynamic LOD removes pieces of the same type (branches, leaves, fronds, decorations): pieces of a generator with a higher Weight are removed later. 0.5 = neutral; equal weights never change the ranking. |
| Dynamic LOD | Length segments | `lodLengthSegments` | 0.1..1 | 1 |  |  | Scalar applied to the number of length segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Dynamic LOD | Radial segments | `lodRadialSegments` | 0.1..1 | 1 |  |  | Scalar applied to the number of radial (or width) segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Lightmap | Lightmap weight | `lightmapWeight` | 0..4 | 0 |  |  | Relative texel density of this generator in the lightmap UVs (Tree > Lightmap, export). 1 = the same density as the other generators, 2 = twice the density, 0 = one texel per piece (a leaf gets a single texel). Leaves start at 0; the "Reset lightmap" command restores the defaults. |

## Leaf (`generator.leaf`) - Lighting tab

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Style | Style | `lightingStyle` | Global / Local | global |  |  | Global reads the shared leaf lighting of the Tree node; Local uses the settings below for this generator only. |
| Normals | Smooth | `lightSmooth` | 0..1 | 0 |  |  | Blends the original normals towards smoothed ones (averaged over the neighbouring faces) after the leaf is deformed. The other normal edits follow the smoothing. |
| Parent puffiness | Amount | `lightParentAmount` | 0..1 | 0 |  |  | Turns the normals to face out from the anchor through each vertex. 1 = fully aligned. Needs an anchor other than None. |
| Parent puffiness | Anchor | `lightParentAnchor` | Global / Deep / Intermediate / Local / None / Height / Surface X / Surface Y / Surface Z | none |  |  | Global / Deep / Intermediate / Local: an ancestor in the hierarchy. Height: the ground below the highest ancestor. Surface X / Y / Z: align with the parent’s X / Y / Z axis at the attachment. |
| Anchor shift | Position | `lightAnchorPosition` | 0..1 | 0 |  |  | Where the anchor sits inside its shift range (straight up). Has no effect while Amount is 0. |
| Anchor shift | Amount | `lightAnchorAmount` | 0..100 (slider 0..10) m | 0 |  |  | Length of the range the anchor can be moved up by Position. |
| Normals | Puffiness | `lightPuffiness` | 0..1 | 0 |  |  | Spherizes the normals around the centre of each leaf. Applied after all other normal edits. |
| Normals | Unify | `lightUnify` | 0..1 | 0 |  |  | Blends every normal of a leaf towards the average normal direction. |
| Adjustments | Up | `lightUp` | -180..180 ° | 0 | yes |  | Rotates the normals (not the geometry) about the leaf’s local X axis. Use the variance to jumble clusters. |
| Adjustments | Right | `lightRight` | -180..180 ° | 0 | yes |  | Rotates the normals (not the geometry) about the leaf’s local Y axis. Use the variance to jumble clusters. |
| Adjustments | Out | `lightOut` | -180..180 ° | 0 | yes |  | Rotates the normals (not the geometry) about the leaf’s local Z axis. Use the variance to jumble clusters. |
| Normals | World up | `lightWorldUp` | 0..1 | 0 |  |  | Forces the normals upwards (even grass-like lighting). Overrides puffiness and the adjustments. |
| Ambient occlusion | Strength | `aoStrength` | 0..1 | 0.5 |  | yes | Strength of the baked vertex ambient occlusion. |
| Ambient occlusion | Depth | `aoDepth` | 0..1 | 0.5 |  |  | Depth of the ambient-occlusion darkening towards the centre of the crown. |

### Lighting tab - how the pieces fit together

* **Style.** *Global* (default) reads the shared leaf lighting on the **Tree** node (Lighting tab, same parameters as Local, handed down the hierarchy as `StructureData.lighting`); *Local* uses this generator's own values. Defaults are neutral, so older projects look the same. The former *Spherize* / *Bend* controls did nothing and were removed (the ambient-occlusion section is unchanged).
* **Pass.** A normal-only pass runs after deformation, mirroring and the winding fix, per leaf (`applyLeafLighting`, reused by the Frond later). Geometry never moves; tangents are re-orthogonalised to the new normals. Order: Smooth → Parent puffiness → Unify → Adjustments → Puffiness → World up.
* **Smooth** blends the original normals toward area-weighted face-averaged normals computed from the deformed mesh.
* **Parent puffiness.** *Amount* blends each normal toward the direction anchor → vertex (1 = fully aligned). *Anchor*: Global / Deep / Intermediate / Local are ancestor base points (as in the Leaves tab); *Height* = the Global ancestor dropped to the ground (z = 0); *Surface X / Y / Z* use the parent's normal / binormal / tangent at the attachment as one fixed direction; *None* = off.
* **Anchor shift.** *Amount* is the length (m) of the straight-up range the anchor can move through and *Position* (0..1) picks the spot inside it, so Position does nothing while Amount is 0. It applies to every point anchor (not to Surface / None).
* **Unify** blends all normals of a leaf toward their average. **Adjustments** (Up / Right / Out, with ± variance per leaf) rotate the normals about the leaf's local X / Y / Z. **Puffiness** spherizes the normals around the centre of each leaf after all other edits. **World up** blends toward straight up (+Z) and overrides puffiness and the adjustments.

### Deformation and Resolution tabs - how the pieces fit together

* **Frame.** Deformation works on the vertices of the chosen mesh (or card) in the leaf's local frame: X across the blade, Y along the growth axis, Z the face. Every step maps the pivot (attachment point) to itself, so welds, anchors and children stay attached. Order: Height, Scale, Fold, Twist, Curl, Vertex noise.
* **Height** pushes vertices along their normals by (map − 0.5) × amount metres, sampled at the vertex UV from the **Height** texture of the leaf's material (Materials panel). Without a Height texture it does nothing and the node shows a warning. It fades in over the first 10 % of the leaf so the pivot stays put.
* **Fold** rotates both halves about Y (+ up toward the face, − down). **Curl** bends the blade around X into a circular arc whose total angle is the value. **Twist** rotates about Y by an angle that grows linearly with the distance from the X axis (value = angle at the tip).
* **Vertex** adds a 3D simplex-noise offset to every vertex in local space. *Amount* is in metres, *Noise* is the tightness (cycles per leaf length, higher = more localized), *Seed* picks the pattern. Each leaf samples its own place in the noise field (deterministic).
* **Scale** X / Y / Z scale each leaf along its local axes.
* **Variance / curves.** Each value gets its optional ± variance and is multiplied by its curve along the parent. Variance of a value that is 0 uses a fixed span (Height 0.05 m, Fold 45°, Curl 90°, Twist 180°, Vertex 0.05 m, Scale 0.5) so it still has an effect.
* **Sparse meshes.** At the high LODs (0 and 1) meshes with fewer than ~24 vertices are subdivided (midpoints, up to three passes) before deforming, so folds and curls are visible on a plain quad. Normals are recomputed from the deformed surface (the Lighting tab edits them afterwards).
* **Anchors.** Attachment frames of cutout meshes go through the same deformation (without Height): position by the deformation, direction / up by its local derivative.
* **Resolution.** The *LOD* axis of both curves is the active LOD (viewport LOD selector, export LODs, 0 = highest … 3 = lowest) divided by 3. *Size increase %* multiplies the leaf size by 1 + y/100 (default curve 0 % → 36 %, the growth older projects had). *Mesh LOD* picks the mesh slot (0 High, 1 Medium, 2 Low, rounded; default curve = High at LOD 0, Medium at 1, Low from 2). *Mesh LOD offset* shifts it and is clamped to High..Low; it needs two or more filled mesh LOD slots (otherwise it is ignored with a warning). An empty slot falls back to the nearest filled one. Plain cards (no mesh) only follow the existing segment reduction.

### Batched Leaf (`generator.batchedLeaf`)

Same tabs and parameters as Leaf (placement, orientation, type, deformation, resolution, lighting) except **Mesh LOD offset**, the vertex-noise **Seed**, **Unify** and **World up**, which do not exist. It does not follow the viewport / export LOD (it always builds at the highest detail; the Resolution curves are read at LOD 0). All leaves are merged into **one slot per material** (`mergeByMaterial`), and `MeshData.parts` is an index table (source key, skeleton branch, vertex and index ranges per leaf, sorted by index) so a triangle can be resolved back to the leaf that produced it.

### Frond (`generator.frond`) - variance, lighting and wind

* **Left-Right Variance** (Shape). *Amount* (0..1): the left and right half of every frond get their own random multiplier (`1 - amount .. 1 + amount`) for Curl, Fold and Gravity, so the halves react independently. *Seed* picks the pattern. Amount 0 keeps both halves identical.
* **Section Variance** (Shape). Sections are painted in the cutout editor with the *Section [n]* paint tool (ids 1..8, 1 = default / unpainted) and read per vertex of the mapped mesh. Sections 2..8 get their own shift for Gravity, Fold, Curl and Roll: `Offset + Amount × random(-1..1)`, drawn once per frond and section. *Favor Outliers* maps the random value to its square root (sign kept), so extreme values are more likely than the median. Section 1 / unpainted vertices and plain ribbons keep the whole-mesh values. Each painted section is its own rib set, so section borders can show a step.
* **Lighting.** Style Global reads the Tree lighting (Alignment / Spread are not part of it); Local uses the frond group: Smooth, Alignment (normals toward the growth direction of the parent spine), Spread (normals away from the spine), Parent puffiness (Anchor = the Leaf list plus *Origin*, Amount) and Adjustments (Up / Right / Out about the frond axes: X across, Y along, Z face; ± variance per frond). It reuses `applyLeafLighting`; order: Smooth → Parent puffiness → Alignment → Spread → Adjustments. Geometry never moves.
* **Wind.** The per-vertex weights keep the existing layout `(level 0, level 1, level 2, phase)`; the frond starts from the parent weights at its base and adds its own bend on level 2. *Weight* = value × profile × `t^Bend power` (the profile's left end is the pivot and the weight is exactly 0 at the base, so the frond stays attached). *Cross* scales the motion from none at the spine to full at the edges. *Boost* adds an absolute weight (profile: left = base, right = tip), faded in over the first 10 % of the length. *Ribs › Apply branch wind* raises the level above the parent branch (generation − 1, at least the trunk level) for the vertices off the spine by *Ribs › Weight* × distance from the spine, also faded in over the first 10 %. Defaults reproduce the previous wind.

## Splits, Extend parent, Extensions and Root splitting (notes)

* **Skin > Splits** (Trunk, Branch, Root). *Chance* decides per spine whether its tip forks into two fused halves (one skin, one crotch vertex). *Balance* moves cross-section area between the halves (pipe model: r1^2 + r2^2 stays the parent area at Expand 1); *Side 1 / Side 2* are the half angles, *Expand* widens one half, *Smooth > Inner / Outer* shape the valley and the shoulders (Inner 0 keeps a sharp crease, the only place a normal jump above 25 degrees is expected). *Seed* re-rolls only the splits. The halves are the two open ends that Extend parent and Cap continue.
* **One spine.** A split counts as ONE spine for every generator below it: Branch, Split, Leaf, Frond, Decal, Fin, Knot and the other placement generators place their nodes on the parent up to the start of the shared transition and never on the two halves (the halves only take Extend parent / Cap), so a generator is never repeated per half. Children therefore sit on the true tube and weld to it.
* **Split generator > Split parents only.** Forks only the parents that already split (Skin > Splits). Off = every parent (halves excluded).
* **Ring counts.** A half ends in a ring of N / 2 vertices; its extension or cap uses exactly that ring and starts on the half's real end ring (no gap). Every further split of a split halves the count again, so give the first spine a high Resolution (32 supports three levels).
* **Root splitting.** Roots split with the same engine (Down bias tilts both halves towards gravity). Roots anchor on the ground base only, never on a split half or an extension.
* **View > Show open ends.** Draws every open end as a ring with a direction arrow and one or two ticks (index): orange = fat half, blue = skinny half, red = break, green = bottom. Off by default.

## Knot (`generator.knot`)

Surface details welded onto branches and trunks: knots, lumps and gashes with an Outer band (parent material), an Inner bridge and a Core.

### Tab: Generation

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Generation | Mode | `mode` | Absolute / Proportional / Absolute steps / Proportional steps / Phyllotaxy / Interval / Bifurcation / Flood / Parent / Density / Classic (legacy) | absolute |  | How children are placed on the parent: an exact number, proportional to its length, in steps (whorls), by phyllotaxy, at intervals, at bends, flooded along it or all at its origin. |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 5 | yes | Exact number of nodes created on each parent. |
| Absolute | Jumble | `jumble` | 0..1 | 0.35 |  | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  | Random variation of the spacing in Density mode. |
| Proportional | Frequency | `proportionalCount` | 0..50 (slider 0..10) /m | 2.5 |  | Nodes per metre of parent length: longer parents get more nodes, spread at random along them. |
| Steps | Steps | `whorlCount` | 1..128 | 5 |  | Number of steps (rings of nodes) along the parent. |
| Steps | Steps | `stepsFrequency` | 0..20 (slider 0..5) /m | 0.5 |  | Steps per metre of parent length. |
| Steps | Per step | `whorlPerStep` | 1..128 (slider 1..24) | 4 |  | Nodes in every step. |
| Steps | Spread | `whorlSpread` | 0..1 | 0.03 |  | Lengthwise spacing of the nodes inside one step, as a fraction of the First..Last stretch. |
| Steps | Roll | `whorlRoll` | -180..180 ° | 15 |  | Rotation of every step relative to the previous one. |
| Steps | Balance | `stepsBalance` | 0..1 | 1 |  | How evenly the nodes of a step are spaced around the parent (1 = evenly, 0 = random). |
| Phyllotaxy | Style | `phyllotaxyStyle` | Opposite (distichous) / Opposite (decussate) / Opposite (random orientation) / Alternating (distichous) / Alternating (random) / Whorled | alternating-distichous- |  | How the nodes of a group are arranged and how consecutive groups are turned against each other. |
| Phyllotaxy | Internode length | `phyllotaxyInternode` | 0..50 (slider 0..2) m | 0.25 |  | Distance between groups, measured along the parent from Last towards First. 0 spreads Limit groups evenly instead. |
| Phyllotaxy | Children per node | `phyllotaxyChildren` | 1..32 | 3 |  | Nodes in each whorled group. |
| Phyllotaxy | Spread | `phyllotaxySpread` | 0..1 | 0 |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Phyllotaxy | Spiral | `phyllotaxySpiral` | -180..180 ° | 0 |  | Extra rotation added for every group. |
| Phyllotaxy | Limit | `phyllotaxyLimit` | 0..10000 (slider 0..100) | 0 |  | Maximum number of groups (0 = no limit). |
| Phyllotaxy | Align style | `phyllotaxyAlignStyle` | Group / Individual | group |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Frequency | `intervalStep` | 0.001..50 (slider 0.001..3) m | 0.6 |  | Distance between groups from Last towards First. The curve scales it along the parent: lower values pack groups tighter. |
| Interval | Count | `perStep` | 1..64 (slider 1..16) | 1 |  | Nodes in every group. |
| Interval | Spread | `intervalSpread` | 0..1 | 0 |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Interval | Spiral | `intervalSpiral` | -180..180 ° | 0 |  | Extra rotation added for every group. |
| Interval | Limit | `intervalLimit` | 0..10000 (slider 0..100) | 0 |  | Maximum number of groups (0 = no limit). |
| Interval | Align style | `intervalAlignStyle` | Group / Individual | group |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Balance | `intervalBalance` | 0..1 | 0 |  | Turns every other group so its nodes fill the gaps left by the previous group. |
| Bifurcation | Count | `bifurcationCount` | 0..1000 (slider 0..32) | 4 |  | Maximum number of nodes; the strongest bends win. |
| Bifurcation | Threshold | `bifurcationThreshold` | 0.5..90 ° | 6 |  | Smallest bend of the parent that gets a node. |
| Bifurcation | Spread | `bifurcationSpread` | 0..1 | 0 |  | Random shift of every node along the parent (1 = 10 % of its length). |
| Bifurcation | Min spacing | `bifurcationSpacing` | 0.01..0.9 | 0.12 |  | Smallest distance between two bends, as a fraction of the parent. |
| Alignment | Align | `align` | bool | false |  | Rolls the new nodes so they face the sky. |
| Boundaries | First | `first` | 0..1 | 0.1 |  | Lowest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 0.9 |  | Highest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0 |  | With the checkbox on, nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary. The value insets the range (fraction of First..Last). |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  | Removes nodes that Spread or Position push outside First..Last. |
| Common | Active | `active` | bool | true |  | Switches the generator on. With a curve over the level of detail (left = highest detail) it is active where the curve is above 0.5. |
| Common | Pass | `pass` | 1..99 | 1 |  | Generators compute in pass order. A node cannot have a lower pass than any of its ancestors. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes | Rotates all nodes around the parent spine as a group. Variance jumbles the rotation per parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes | Shifts all nodes along the parent (fraction of its length). Variance shifts every parent differently. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes | Start offset of the nodes into (+) or out of (-) the parent; sinks trunks under the ground. |
| Common | Pruning | `pruningCurve` | curve | curve |  | Runs over the parent from First (left) to Last (right). Nodes are removed where the curve is below 0.5. |
| Common | Seed | `seed` | seed | 0 |  | Random seed. Change it to get a different variation of the same settings. |
| Knockout | Amount | `knockout` | 0..1 | 0 |  | Randomly removes this share of the nodes after the mode has placed them. The curve varies it along the parent. |
| Knockout | + Resolution | `knockoutResolution` | -1..1 | 0 |  | Added to the amount for every level of detail below the highest: positive removes more nodes at lower detail, negative fewer. |
| Force containers | Include | `forceInclude` | rows of Material / Weight / UV Area | one row |  | Keeps only the nodes inside the volume of the named Force node (set a volume in the Force node). |
| Force containers | Exclude | `forceExclude` | rows of Material / Weight / UV Area | one row |  | Removes the nodes inside the volume of the named Force node. |
| More | Click place | `clickPlace` | Ready / None / Any / Number | ready |  | What a click in the viewport places. It is stored with the node and takes effect with Freehand mode. |
| More | Size scalar | `sizeScalar` | 0.01..100 (slider 0.01..5) | 1 |  | Scales this node and every node below it. |
| Masks | Mask | `genMasks` | rows of Material / Weight / UV Area | one row |  | Keeps a node only where every assigned mask (Masks panel) evaluates to 0.5 or more. |

### Tab: Outer

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Outer | Size | `outerSize` | 0.002..20 (slider 0.002..1) m | 0.12 | yes | Radius of the whole knot on the parent surface, measured along the branch. |
| Outer | Offset | `outerOffset` | -2..2 (slider -0.3..0.3) m | 0.02 | yes | How far the knot is extruded from the parent surface. Negative values cut into it (gashes). |
| Outer | Rotation | `outerRotation` | -180..180 ° | 0 | yes | Rolls the whole knot around its centre; Inner and Core follow. |
| Outer | Scale | `outerScale` | 0.1..8 (slider 0.1..3) | 1 | yes | Width of the knot across the branch relative to its length. Combine with Rotation for non-circular knots. |
| Outer | Lip | `outerLip` | -1..1 (slider -0.1..0.1) m | 0.01 | yes | Raises (or lowers) the edge between Outer and Inner above the Offset. |
| Noise | Seed | `outerNoiseSeed` | seed | 0 |  | “Seed” in Outer › Noise. |
| Noise shape | Amount | `outerShapeAmount` | 0..1 | 0.15 |  | Deforms the outline of the knot (fraction of its radius). |
| Noise shape | Scale | `outerShapeScale` | 0.1..20 (slider 0.1..8) | 2 |  | Frequency of the outline noise: higher gives more, smaller bumps around the knot. |
| Noise offset | Amount | `outerOffsetAmount` | 0..1 (slider 0..0.05) m | 0.004 |  | Height noise on the surface of the Outer band. |
| Noise offset | Scale | `outerOffsetScale` | 0.1..40 (slider 0.1..12) | 4 |  | Frequency of the height noise. |

### Tab: Inner

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Inner | Size % | `innerSizePct` | 5..98 % | 60 | yes | Size of Inner and Core together as a percentage of the knot size. |
| Inner | Scale | `innerScale` | 0.1..4 (slider 0.1..2) | 1 | yes | Width of Inner and Core relative to Outer. |
| Inner | Curvature | `innerCurvature` | -2..4 (slider -1..2) | 0.5 | yes | Roundness of the Inner section: higher values puff it out, negative values pinch it in. |
| Inner | Overlap | `innerOverlap` | 0..0.9 | 0 |  | How far the Inner section reaches under the Core. Hides gaps when the two use different materials. |
| UV | Style | `innerUvStyle` | Match trunk / Ring | match-trunk |  | Match trunk continues the parent texture over the Inner. Ring maps it like a torus: U around the knot, V from outside to inside. |
| UV | Scale | `innerUvScale` | 0.01..32 (slider 0.01..8) | 1 |  | Texture scale of the Inner section. |
| UV | U offset | `innerUvOffsetU` | -10..10 (slider -1..1) | 0 |  | Shifts the Inner texture around the knot. |
| UV | V offset | `innerUvOffsetV` | -10..10 (slider -1..1) | 0 |  | Shifts the Inner texture along the knot. |
| Noise shape | Amount | `innerShapeAmount` | 0..1 | 0.1 |  | Deforms the boundary between Inner and Core (fraction of its radius). |
| Noise shape | Scale | `innerShapeScale` | 0.1..20 (slider 0.1..8) | 2 |  | Frequency of the Inner outline noise. |

### Tab: Core

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Core | Size % | `coreSizePct` | 5..98 % | 50 | yes | Size of the Core as a percentage of the Inner size. |
| Core | Offset | `coreOffset` | -2..2 (slider -0.2..0.2) m | -0.01 | yes | Moves the Core towards (negative) or away from (positive) the parent, relative to the knot Offset. |
| UV | Style | `coreUvStyle` | Match trunk / Ring | match-trunk |  | Match trunk continues the parent texture over the Core. Ring maps the texture flat over the Core disc, like the end of a cut branch. |
| UV | Scale | `coreUvScale` | 0.01..32 (slider 0.01..8) | 1 |  | Texture scale of the Core. |
| UV | U offset | `coreUvOffsetU` | -10..10 (slider -1..1) | 0 |  | Shifts the Core texture around the knot. No effect with the Ring style. |
| UV | V offset | `coreUvOffsetV` | -10..10 (slider -1..1) | 0 |  | Shifts the Core texture along the knot. No effect with the Ring style. |
| Noise shape | Amount | `coreShapeAmount` | 0..1 | 0.1 |  | Deforms the outline of the Core (fraction of its radius). |
| Noise shape | Scale | `coreShapeScale` | 0.1..20 (slider 0.1..8) | 2 |  | Frequency of the Core outline noise. |
| Noise offset | Amount | `coreOffsetAmount` | 0..1 (slider 0..0.05) m | 0.003 |  | Height noise on the Core surface. |
| Noise offset | Scale | `coreOffsetScale` | 0.1..40 (slider 0.1..12) | 4 |  | Frequency of the Core height noise. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Inner | Material | `innerMaterials` | rows of Material / Weight / UV Area | one row |  | Materials of the Inner section; each knot picks a row by weight. Inherited uses the parent material. The gear button on a row opens the UV Area. |
| Core | Material | `coreMaterials` | rows of Material / Weight / UV Area | one row |  | Materials of the Core, usually a cut-branch material; each knot picks a row by weight. None or Inherited uses the parent material. |
| Season | Start offset | `seasonStartOffset` | -1..1 (slider -1..1) | 0 | yes | Season start offset: 0 = the transition follows the Season slider immediately, positive values delay it, negative values start it earlier. Variance spreads it per element; the curve runs along the parent. |
| Season | Time scale | `seasonTimeScale` | 0..10 (slider 0..2) | 1 | yes | Season time scale: 1 = one slider sweep is one year of this node; 2 = twice as fast, 0 = never changes. |

### Tab: Segments

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Rings | Outer | `ringsOuter` | 1..24 | 3 |  | Rings of the Outer band, from the parent surface to the Inner edge. |
| Rings | Inner | `ringsInner` | 1..24 | 3 |  | Rings of the Inner section. |
| Rings | Core | `ringsCore` | 1..24 | 2 |  | Rings of the Core disc. |
| Slices | Slices | `slices` | 4..128 (slider 4..48) | 16 |  | Segments around the knot; shared by Outer, Inner and Core. |
| Resolution | Resolution | `knotResolution` | 0.1..4 (slider 0.1..2) | 1 |  | Multiplies the rings and slices at once. |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Dynamic LOD | Weight | `lodWeight` | 0..1 | 1 |  | Importance of the knots. Below 1, a share of them is removed as the level of detail drops (all of them at the lowest level for 0). |
| Dynamic LOD | Ring segments | `lodRingSegments` | 0..1 | 0.5 |  | How strongly the rings are reduced per level of detail. |
| Dynamic LOD | Slice segments | `lodSliceSegments` | 0..1 | 0.5 |  | How strongly the slices are reduced per level of detail. |

### Knot geometry and UV (R17)

Pure maths: `src/generators/knot/` (`knotMesh`, `segments`); parameter reader and the old-project migration: `src/nodes/generators/knotConfig.ts`; node: `src/nodes/generators/knot.ts`.

* **Sections.** The knot is built in the tangent plane of the parent surface (x around the branch, y along it, centre = origin). *Size* is the outer radius; Inner starts at *Size %* of it and the Core at *Size %* of the Inner radius. Every ring is a smooth blend between the boundaries of its section; the boundaries are deformed by the *Noise > Shape* amounts (a seeded simplex noise, per-knot offset).
* **Heights** (metres along the parent surface normal). Outer rises from 0 at the weld to the rim `Offset + Lip` with a smoothstep (zero slope, so the weld has no crack and its normal equals the parent normal). Inner runs from the rim to the Core height `Offset + Core Offset` and adds `Curvature x sin(pi g)` of bulge (g = progress across the band). The Core is a cap with a dome of `Curvature`. *Noise > Offset* adds height noise (Outer fades in from the weld). *Overlap* extends the Inner under the Core.
* **Welding.** A plane point is projected onto the parent cone (axis point, ring frame, radius x polygon-sag scale, taper) of the spot the knot sits on, so the Outer boundary lies exactly on the parent skin. A knot wider than the branch wraps at most 0.95 pi to either side.
* **Outer UV** is exactly the parent mapping read from the skeleton (`uvTiles`, `uvUOffset`, `uvTwist`, `uvV`): `U = angle / 2pi x tiles + offset + twist x tiles x V`, `V = V(parent) + slope x distance along`. Inner / Core *Match trunk* use the same formula scaled about the knot centre (*Scale*, *U / V offset*). *Ring* maps Inner like a torus (U around, V across the band) and the Core as a flat disc (offsets ignored). A UV Area of the material row confines the coordinates to its rectangle (Match trunk tiles inside it).
* **Materials.** Outer always uses the material of the parent node. Inner and Core pick a row of their Material list by weight (Inherited / None = the parent material). Slots are merged per material over all knots.
* **Segments and LOD.** Rings are bands per section (Outer, Inner, Core) and *Slices* are shared; both are multiplied by *Resolution* and by the Dynamic LOD keep factor `(1 - reduction x 0.4)^lod` (separate *Ring segments* / *Slice segments*). *Weight* below 1 removes a seeded share `(1 - weight) x lod / 3` of the knots at lower detail. Knots count as decorations (visibility toggle, statistics group).
* **Old projects.** `knotRadius` (fraction of the parent radius) becomes *Size* = fraction x 0.1 m, `knotLength` x 0.25 becomes *Offset*, `knotCoreScale` x 100 becomes Inner *Size %*, `knotCurvature` x 2 becomes *Curvature*, the old material becomes the Inner and Core material.

## Decal (`generator.decal`)

Flat patches projected onto the skin of a trunk, branch or root with their own material and height map: knots, lumps, cavities, scars.

### Tab: Generation

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Generation | Mode | `mode` | Absolute / Proportional / Absolute steps / Proportional steps / Phyllotaxy / Interval / Bifurcation / Flood / Parent / Density / Classic (legacy) | absolute |  | How children are placed on the parent: an exact number, proportional to its length, in steps (whorls), by phyllotaxy, at intervals, at bends, flooded along it or all at its origin. |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 3 | yes | Exact number of nodes created on each parent. |
| Absolute | Jumble | `jumble` | 0..1 | 0.35 |  | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  | Random variation of the spacing in Density mode. |
| Proportional | Frequency | `proportionalCount` | 0..50 (slider 0..10) /m | 2.5 |  | Nodes per metre of parent length: longer parents get more nodes, spread at random along them. |
| Steps | Steps | `whorlCount` | 1..128 | 5 |  | Number of steps (rings of nodes) along the parent. |
| Steps | Steps | `stepsFrequency` | 0..20 (slider 0..5) /m | 0.5 |  | Steps per metre of parent length. |
| Steps | Per step | `whorlPerStep` | 1..128 (slider 1..24) | 4 |  | Nodes in every step. |
| Steps | Spread | `whorlSpread` | 0..1 | 0.03 |  | Lengthwise spacing of the nodes inside one step, as a fraction of the First..Last stretch. |
| Steps | Roll | `whorlRoll` | -180..180 ° | 15 |  | Rotation of every step relative to the previous one. |
| Steps | Balance | `stepsBalance` | 0..1 | 1 |  | How evenly the nodes of a step are spaced around the parent (1 = evenly, 0 = random). |
| Phyllotaxy | Style | `phyllotaxyStyle` | Opposite (distichous) / Opposite (decussate) / Opposite (random orientation) / Alternating (distichous) / Alternating (random) / Whorled | alternating-distichous- |  | How the nodes of a group are arranged and how consecutive groups are turned against each other. |
| Phyllotaxy | Internode length | `phyllotaxyInternode` | 0..50 (slider 0..2) m | 0.25 |  | Distance between groups, measured along the parent from Last towards First. 0 spreads Limit groups evenly instead. |
| Phyllotaxy | Children per node | `phyllotaxyChildren` | 1..32 | 3 |  | Nodes in each whorled group. |
| Phyllotaxy | Spread | `phyllotaxySpread` | 0..1 | 0 |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Phyllotaxy | Spiral | `phyllotaxySpiral` | -180..180 ° | 0 |  | Extra rotation added for every group. |
| Phyllotaxy | Limit | `phyllotaxyLimit` | 0..10000 (slider 0..100) | 0 |  | Maximum number of groups (0 = no limit). |
| Phyllotaxy | Align style | `phyllotaxyAlignStyle` | Group / Individual | group |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Frequency | `intervalStep` | 0.001..50 (slider 0.001..3) m | 0.6 |  | Distance between groups from Last towards First. The curve scales it along the parent: lower values pack groups tighter. |
| Interval | Count | `perStep` | 1..64 (slider 1..16) | 1 |  | Nodes in every group. |
| Interval | Spread | `intervalSpread` | 0..1 | 0 |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Interval | Spiral | `intervalSpiral` | -180..180 ° | 0 |  | Extra rotation added for every group. |
| Interval | Limit | `intervalLimit` | 0..10000 (slider 0..100) | 0 |  | Maximum number of groups (0 = no limit). |
| Interval | Align style | `intervalAlignStyle` | Group / Individual | group |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Balance | `intervalBalance` | 0..1 | 0 |  | Turns every other group so its nodes fill the gaps left by the previous group. |
| Bifurcation | Count | `bifurcationCount` | 0..1000 (slider 0..32) | 4 |  | Maximum number of nodes; the strongest bends win. |
| Bifurcation | Threshold | `bifurcationThreshold` | 0.5..90 ° | 6 |  | Smallest bend of the parent that gets a node. |
| Bifurcation | Spread | `bifurcationSpread` | 0..1 | 0 |  | Random shift of every node along the parent (1 = 10 % of its length). |
| Bifurcation | Min spacing | `bifurcationSpacing` | 0.01..0.9 | 0.12 |  | Smallest distance between two bends, as a fraction of the parent. |
| Alignment | Align | `align` | bool | false |  | Rolls the new nodes so they face the sky. |
| Boundaries | First | `first` | 0..1 | 0.1 |  | Lowest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 0.9 |  | Highest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0 |  | With the checkbox on, nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary. The value insets the range (fraction of First..Last). |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  | Removes nodes that Spread or Position push outside First..Last. |
| Common | Active | `active` | bool | true |  | Switches the generator on. With a curve over the level of detail (left = highest detail) it is active where the curve is above 0.5. |
| Common | Pass | `pass` | 1..99 | 1 |  | Generators compute in pass order. A node cannot have a lower pass than any of its ancestors. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes | Rotates all nodes around the parent spine as a group. Variance jumbles the rotation per parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes | Shifts all nodes along the parent (fraction of its length). Variance shifts every parent differently. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes | Start offset of the nodes into (+) or out of (-) the parent; sinks trunks under the ground. |
| Common | Pruning | `pruningCurve` | curve | curve |  | Runs over the parent from First (left) to Last (right). Nodes are removed where the curve is below 0.5. |
| Common | Seed | `seed` | seed | 0 |  | Random seed. Change it to get a different variation of the same settings. |
| Knockout | Amount | `knockout` | 0..1 | 0 |  | Randomly removes this share of the nodes after the mode has placed them. The curve varies it along the parent. |
| Knockout | + Resolution | `knockoutResolution` | -1..1 | 0 |  | Added to the amount for every level of detail below the highest: positive removes more nodes at lower detail, negative fewer. |
| Force containers | Include | `forceInclude` | rows of Material / Weight / UV Area | one row |  | Keeps only the nodes inside the volume of the named Force node (set a volume in the Force node). |
| Force containers | Exclude | `forceExclude` | rows of Material / Weight / UV Area | one row |  | Removes the nodes inside the volume of the named Force node. |
| More | Click place | `clickPlace` | Ready / None / Any / Number | ready |  | What a click in the viewport places. It is stored with the node and takes effect with Freehand mode. |
| More | Size scalar | `sizeScalar` | 0.01..100 (slider 0.01..5) | 1 |  | Scales this node and every node below it. |
| Masks | Mask | `genMasks` | rows of Material / Weight / UV Area | one row |  | Keeps a node only where every assigned mask (Masks panel) evaluates to 0.5 or more. |

### Tab: Mesh

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Scale | Size | `decalSize` | 0.002..20 (slider 0.002..2) m | 0.25 | yes | Length of the patch along the parent, metres. The curve runs along the parent branch. |
| Scale | + % of parent | `decalSizeParent` | 0..1000 (slider 0..300) % | 0 |  | Added to Size: this percentage of the parent radius at the placement (bigger decals on thicker wood). |
| Scale | Aspect | `decalAspect` | 0.1..10 (slider 0.1..3) | 1 | yes | Width across the parent relative to the length along it. |
| Resolution | Resolution | `decalResolution` | 2..64 (slider 2..32) | 12 |  | Cells per side of the patch grid (12 gives 288 triangles). Lower for distant LODs. |
| Resolution | Mesh LOD offset | `decalLodOffset` | -3..3 | 0 |  | Shifts the detail level of this mesh: +1 builds it like the next lower LOD, -1 keeps more detail. |

### Tab: Decal

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Decal | Rotation | `decalRotation` | -180..180 ° | 0 | yes | Rolls the patch around its centre on the surface. |
| Decal | Random rotation | `decalRandomRotation` | 0..1 | 1 |  | Fraction of a full turn added at random per decal. |
| Decal | Offset | `decalOffset` | -0.5..0.5 (slider -0.02..0.05) m | 0.002 |  | Lift of the whole patch above the parent surface (avoids z-fighting with the bark). |
| Decal | Edge fade | `decalFade` | 0..0.5 | 0.25 |  | Fraction of the patch over which the relief fades to zero at its border, so the decal blends into the bark. |

### Tab: Height

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Height | Height | `decalHeight` | -2..2 (slider -0.2..0.2) m | 0.03 | yes | Extrusion of the material height map (Height map, or the alpha of the normal map) away from the surface. Negative values dig cavities. Needs a material with a height map; 0 keeps the patch flat. |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| LOD | Cull amount | `lodCull` | 0..1 | 0.5 |  | Fraction of decals removed at the lowest LOD. |
| Dynamic LOD | Weight | `lodWeight` | 0..1 | 0.5 |  | Priority to survive when Tree > Dynamic LOD removes pieces of the same type (branches, leaves, fronds, decorations): pieces of a generator with a higher Weight are removed later. 0.5 = neutral; equal weights never change the ranking. |
| Dynamic LOD | Length segments | `lodLengthSegments` | 0.1..1 | 1 |  | Scalar applied to the number of length segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Dynamic LOD | Radial segments | `lodRadialSegments` | 0.1..1 | 1 |  | Scalar applied to the number of radial (or width) segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Lightmap | Lightmap weight | `lightmapWeight` | 0..4 | 1 |  | Relative texel density of this generator in the lightmap UVs (Tree > Lightmap, export). 1 = the same density as the other generators, 2 = twice the density, 0 = one texel per piece (a leaf gets a single texel). Leaves start at 0; the "Reset lightmap" command restores the defaults. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Leaves | Type | `leafTypes` | rows of Material / Weight / UV Area | one row |  | Materials (and meshes) the instances are picked from. A row is chosen with probability Weight / sum of Weights. |
| Vertex Color | Color | `vertexColor` | color | [1, 1, 1, 1] |  | Vertex colour tint of the geometry. |
| Vertex Color | Variance | `vertexColorVariance` | 0..1 | 0.1 |  | Random variation of the vertex colour per leaf. |
| Vertex Color | Gradient | `vertexColorGradient` | -1..1 | 0 |  | Darkens (−) or brightens (+) towards the tip. |
| Vertex Color | Mode | `vcMode` | Inherit / Multiply / Set / Add | inherit |  | Inherit: keep the colour (Color x Variance, earlier behaviour). Multiply: tint it by Mode color. Set: replace it with Mode color. Add: brighten it by Mode color. Profile and Parent curve control where the change applies. |
| Vertex Color | Mode color | `vcColor` | color | [1, 1, 1, 1] |  | Linear colour used by Multiply, Set and Add. |
| Vertex Color | Seamless | `vcSeamless` | bool | false |  | The colour at the attach point equals the parent colour exactly and blends into the item's own colour over its first quarter (needs the parent to be meshed first; falls back to the own colour otherwise). |
| Vertex Color | Profile | `vcProfile` | curve | curve |  | Strength of the Mode along the item (left: base, right: tip). 1 = full effect, 0 = the inherited colour. Use it for lighter young twigs, darker trunk bases or leaf tips. |
| Vertex Color | Parent curve | `vcParentCurve` | curve | curve |  | Strength of the Mode by the position of the attach point on the parent (left: parent base, right: parent tip); a frond runs along its parent, so it follows the curve along it. Ignored without a parent. |
| Season | Start offset | `seasonStartOffset` | -1..1 (slider -1..1) | 0 | yes | Season start offset: 0 = the transition follows the Season slider immediately, positive values delay it, negative values start it earlier. Variance spreads it per element; the curve runs along the parent. |
| Season | Time scale | `seasonTimeScale` | 0..10 (slider 0..2) | 1 | yes | Season time scale: 1 = one slider sweep is one year of this node; 2 = twice as fast, 0 = never changes. |

### Decal geometry (T15)

Pure maths: `src/generators/decal/decalMesh.ts` (shape: `src/generators/surfaceDetail/planarShape.ts`); node: `src/nodes/generators/decal.ts` (placement = the knot's `collectPlacements` + `knotFrame`, skin = the knot's `parentSkin`).

* **Skin projection.** The patch is a `Resolution x Resolution` grid in the tangent plane of the parent (x around, y along, rolled by *Rotation* + *Random rotation*); every vertex is mapped onto the parent cone (axis point, ring frame, radius x polygon-sag scale, taper) and lifted by `Offset + displacement` along the skin normal.
* **Size.** Length along the parent = *Size* (variance, curve along the parent) + *+ % of parent* x parent radius; width = length x *Aspect*.
* **Height.** `displacement = Height x map(u, v) x fade`, bounded by `|Height|`. The map is the material Height texture or, as for bark sets (T07), the alpha channel of its normal map; a material without a decoded height map leaves the patch flat. *Edge fade* ramps the relief to 0 at the border, so the border floats exactly *Offset* above the bark; the colour map's alpha (cut-out) blends the rim.
* **UV / material.** UVs cover the material once (0..1). *Type* picks a row by weight (Material Sets by season); a None row uses the parent material. A row with a **cutout mesh** replaces the grid by the cutout outline (refined to *Resolution*, then projected exactly like the grid: skin projection, height and edge fade - the distance to the outline - all apply); the cutout's anchors are exported for child generators.
* **Wind.** Every vertex copies the parent's wind at its own position along the axis (interpolated like the parent's rings; level phases unchanged): the decal moves with the skin under it.
* **Placement.** All Generation modes, Knockout, Masks, First / Last, Extend parent; split parents are cut at the crotch (`createFusedParents`), so decals are never placed in the transition.
* **LOD.** *Cull amount* removes a seeded share at lower detail; *Resolution* x Dynamic LOD radial scalar per step; *Mesh LOD offset* shifts the level used for the resolution. Decals count as decorations. Not implemented: Post > Collision / Shade pruning.

## Fin (`generator.fin`)

Thin flaps that stand off a trunk or branch: fungus shelves, moss and lichen flaps, bark curls, with fold, curl, noise and soft lighting.

### Tab: Generation

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Generation | Mode | `mode` | Absolute / Proportional / Absolute steps / Proportional steps / Phyllotaxy / Interval / Bifurcation / Flood / Parent / Density / Classic (legacy) | absolute |  | How children are placed on the parent: an exact number, proportional to its length, in steps (whorls), by phyllotaxy, at intervals, at bends, flooded along it or all at its origin. |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 4 | yes | Exact number of nodes created on each parent. |
| Absolute | Jumble | `jumble` | 0..1 | 0.35 |  | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  | Random variation of the spacing in Density mode. |
| Proportional | Frequency | `proportionalCount` | 0..50 (slider 0..10) /m | 2.5 |  | Nodes per metre of parent length: longer parents get more nodes, spread at random along them. |
| Steps | Steps | `whorlCount` | 1..128 | 5 |  | Number of steps (rings of nodes) along the parent. |
| Steps | Steps | `stepsFrequency` | 0..20 (slider 0..5) /m | 0.5 |  | Steps per metre of parent length. |
| Steps | Per step | `whorlPerStep` | 1..128 (slider 1..24) | 4 |  | Nodes in every step. |
| Steps | Spread | `whorlSpread` | 0..1 | 0.03 |  | Lengthwise spacing of the nodes inside one step, as a fraction of the First..Last stretch. |
| Steps | Roll | `whorlRoll` | -180..180 ° | 15 |  | Rotation of every step relative to the previous one. |
| Steps | Balance | `stepsBalance` | 0..1 | 1 |  | How evenly the nodes of a step are spaced around the parent (1 = evenly, 0 = random). |
| Phyllotaxy | Style | `phyllotaxyStyle` | Opposite (distichous) / Opposite (decussate) / Opposite (random orientation) / Alternating (distichous) / Alternating (random) / Whorled | alternating-distichous- |  | How the nodes of a group are arranged and how consecutive groups are turned against each other. |
| Phyllotaxy | Internode length | `phyllotaxyInternode` | 0..50 (slider 0..2) m | 0.25 |  | Distance between groups, measured along the parent from Last towards First. 0 spreads Limit groups evenly instead. |
| Phyllotaxy | Children per node | `phyllotaxyChildren` | 1..32 | 3 |  | Nodes in each whorled group. |
| Phyllotaxy | Spread | `phyllotaxySpread` | 0..1 | 0 |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Phyllotaxy | Spiral | `phyllotaxySpiral` | -180..180 ° | 0 |  | Extra rotation added for every group. |
| Phyllotaxy | Limit | `phyllotaxyLimit` | 0..10000 (slider 0..100) | 0 |  | Maximum number of groups (0 = no limit). |
| Phyllotaxy | Align style | `phyllotaxyAlignStyle` | Group / Individual | group |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Frequency | `intervalStep` | 0.001..50 (slider 0.001..3) m | 0.6 |  | Distance between groups from Last towards First. The curve scales it along the parent: lower values pack groups tighter. |
| Interval | Count | `perStep` | 1..64 (slider 1..16) | 1 |  | Nodes in every group. |
| Interval | Spread | `intervalSpread` | 0..1 | 0 |  | Random lengthwise offset of every node inside its group (1 = up to the neighbouring group). |
| Interval | Spiral | `intervalSpiral` | -180..180 ° | 0 |  | Extra rotation added for every group. |
| Interval | Limit | `intervalLimit` | 0..10000 (slider 0..100) | 0 |  | Maximum number of groups (0 = no limit). |
| Interval | Align style | `intervalAlignStyle` | Group / Individual | group |  | Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle. |
| Interval | Balance | `intervalBalance` | 0..1 | 0 |  | Turns every other group so its nodes fill the gaps left by the previous group. |
| Bifurcation | Count | `bifurcationCount` | 0..1000 (slider 0..32) | 4 |  | Maximum number of nodes; the strongest bends win. |
| Bifurcation | Threshold | `bifurcationThreshold` | 0.5..90 ° | 6 |  | Smallest bend of the parent that gets a node. |
| Bifurcation | Spread | `bifurcationSpread` | 0..1 | 0 |  | Random shift of every node along the parent (1 = 10 % of its length). |
| Bifurcation | Min spacing | `bifurcationSpacing` | 0.01..0.9 | 0.12 |  | Smallest distance between two bends, as a fraction of the parent. |
| Alignment | Align | `align` | bool | false |  | Rolls the new nodes so they face the sky. |
| Boundaries | First | `first` | 0..1 | 0.1 |  | Lowest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 0.9 |  | Highest point on the parent where nodes occur (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0 |  | With the checkbox on, nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary. The value insets the range (fraction of First..Last). |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  | Removes nodes that Spread or Position push outside First..Last. |
| Common | Active | `active` | bool | true |  | Switches the generator on. With a curve over the level of detail (left = highest detail) it is active where the curve is above 0.5. |
| Common | Pass | `pass` | 1..99 | 1 |  | Generators compute in pass order. A node cannot have a lower pass than any of its ancestors. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes | Rotates all nodes around the parent spine as a group. Variance jumbles the rotation per parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes | Shifts all nodes along the parent (fraction of its length). Variance shifts every parent differently. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes | Start offset of the nodes into (+) or out of (-) the parent; sinks trunks under the ground. |
| Common | Pruning | `pruningCurve` | curve | curve |  | Runs over the parent from First (left) to Last (right). Nodes are removed where the curve is below 0.5. |
| Common | Seed | `seed` | seed | 0 |  | Random seed. Change it to get a different variation of the same settings. |
| Knockout | Amount | `knockout` | 0..1 | 0 |  | Randomly removes this share of the nodes after the mode has placed them. The curve varies it along the parent. |
| Knockout | + Resolution | `knockoutResolution` | -1..1 | 0 |  | Added to the amount for every level of detail below the highest: positive removes more nodes at lower detail, negative fewer. |
| Force containers | Include | `forceInclude` | rows of Material / Weight / UV Area | one row |  | Keeps only the nodes inside the volume of the named Force node (set a volume in the Force node). |
| Force containers | Exclude | `forceExclude` | rows of Material / Weight / UV Area | one row |  | Removes the nodes inside the volume of the named Force node. |
| More | Click place | `clickPlace` | Ready / None / Any / Number | ready |  | What a click in the viewport places. It is stored with the node and takes effect with Freehand mode. |
| More | Size scalar | `sizeScalar` | 0.01..100 (slider 0.01..5) | 1 |  | Scales this node and every node below it. |
| Masks | Mask | `genMasks` | rows of Material / Weight / UV Area | one row |  | Keeps a node only where every assigned mask (Masks panel) evaluates to 0.5 or more. |

### Tab: Fins

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Fins | Size | `finSize` | 0.002..20 (slider 0.002..2) m | 0.25 | yes | How far the fin reaches away from its base, metres. The curve runs along the parent branch. |
| Fins | + % of parent | `finSizeParent` | 0..1000 (slider 0..300) % | 0 |  | Added to Size: this percentage of the parent radius at the placement. |
| Fins | Width | `finWidth` | 0.002..20 (slider 0.002..2) m | 0.2 | yes | Width of the base ring of the fin along the surface, metres. |
| Fins | Flip | `finFlip` | None / Random / Always | random |  | Mirrors the fin (texture, fold and curl direction): never, at random, or always. |
| Segments | Width segments | `finSegmentsWidth` | 1..32 (slider 1..12) | 4 |  | Cells across the fin. The base ring has one more vertex, every one on the parent skin. |
| Segments | Length segments | `finSegmentsLength` | 2..64 (slider 2..20) | 6 |  | Cells from the base to the tip; more cells give smoother curl and noise. |

### Tab: Orientation

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Orientation | Style | `finStyle` | Perpendicular / Along spine / Up | perpendicular |  | Direction in which the fin leaves the surface plane: Perpendicular = around the parent, Along spine = along the parent, Up = towards the sky (shelf fungus). |
| Orientation | Start angle | `finStartAngle` | 0..180 ° | 60 | yes | Angle between the surface and the fin at its base: 0 lies flat on the bark, 90 stands straight out. |
| Orientation | Roll | `finRoll` | -180..180 ° | 0 | yes | Turns the fin around the surface normal at its attachment. |

### Tab: Deformation

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Deformation | Fold | `finFold` | -180..180 ° | 0 | yes | Folds the two halves of the fin along its centre line; the fold grows from the base to the tip. |
| Deformation | Curl | `finCurl` | -360..360 ° | 0 | yes | Bends the fin along its length towards its face (positive) or away from it. |
| Vertex | Amount | `finVertexAmount` | 0..2 (slider 0..0.2) m | 0 |  | Random displacement of the vertices (grows from the base to the tip, so the base stays on the skin). |
| Vertex | Noise scale | `finVertexScale` | 0.1..40 (slider 0.1..12) | 3 |  | Frequency of the vertex noise: higher gives finer wrinkles. |
| Vertex | Seed | `finVertexSeed` | seed | 0 |  | “Seed” in Deformation › Vertex. |
| Scale | Scale X | `finScaleX` | 0.01..10 (slider 0.01..3) | 1 |  | Scale of the fin across its width. |
| Scale | Scale Y | `finScaleY` | 0.01..10 (slider 0.01..3) | 1 |  | Scale of the fin along its length. |
| Scale | Scale Z | `finScaleZ` | 0..10 (slider 0..3) | 1 |  | Scale of the fin's thickness direction (the amount of fold, curl and noise out of its plane). |

### Tab: Lighting

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Lighting | Puffiness | `finPuffiness` | 0..1 | 0.3 |  | Bends the normals towards the surface normal of the parent: soft, rounded shading instead of a flat card. |
| Lighting | Match surface | `finMatchSurface` | 0..1 | 0.5 |  | Blends the normals at the base of the fin into the parent surface normal (fading out towards the tip), so the fin merges with the bark shading. |

### Tab: Wind

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Ripple | Ripple scale | `finRipple` | 0..5 (slider 0..2) | 1 |  | Strength of the fin's own leaf-level wind motion. The base ring keeps the exact wind of the parent, the weight grows towards the tip, so the fin never tears off. |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| LOD | Cull amount | `lodCull` | 0..1 | 0.5 |  | Fraction of fins removed at the lowest LOD. |
| LOD | Segment reduction | `lodSegments` | 0..0.9 | 0.5 |  | Fraction of the width and length segments removed per LOD step. |
| Dynamic LOD | Weight | `lodWeight` | 0..1 | 0.5 |  | Priority to survive when Tree > Dynamic LOD removes pieces of the same type (branches, leaves, fronds, decorations): pieces of a generator with a higher Weight are removed later. 0.5 = neutral; equal weights never change the ranking. |
| Dynamic LOD | Length segments | `lodLengthSegments` | 0.1..1 | 1 |  | Scalar applied to the number of length segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Dynamic LOD | Radial segments | `lodRadialSegments` | 0.1..1 | 1 |  | Scalar applied to the number of radial (or width) segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction. |
| Lightmap | Lightmap weight | `lightmapWeight` | 0..4 | 1 |  | Relative texel density of this generator in the lightmap UVs (Tree > Lightmap, export). 1 = the same density as the other generators, 2 = twice the density, 0 = one texel per piece (a leaf gets a single texel). Leaves start at 0; the "Reset lightmap" command restores the defaults. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Meaning |
|---|---|---|---|---|---|---|
| Leaves | Type | `leafTypes` | rows of Material / Weight / UV Area | one row |  | Materials (and meshes) the instances are picked from. A row is chosen with probability Weight / sum of Weights. |
| Vertex Color | Color | `vertexColor` | color | [1, 1, 1, 1] |  | Vertex colour tint of the geometry. |
| Vertex Color | Variance | `vertexColorVariance` | 0..1 | 0.1 |  | Random variation of the vertex colour per leaf. |
| Vertex Color | Gradient | `vertexColorGradient` | -1..1 | 0 |  | Darkens (−) or brightens (+) towards the tip. |
| Vertex Color | Mode | `vcMode` | Inherit / Multiply / Set / Add | inherit |  | Inherit: keep the colour (Color x Variance, earlier behaviour). Multiply: tint it by Mode color. Set: replace it with Mode color. Add: brighten it by Mode color. Profile and Parent curve control where the change applies. |
| Vertex Color | Mode color | `vcColor` | color | [1, 1, 1, 1] |  | Linear colour used by Multiply, Set and Add. |
| Vertex Color | Seamless | `vcSeamless` | bool | false |  | The colour at the attach point equals the parent colour exactly and blends into the item's own colour over its first quarter (needs the parent to be meshed first; falls back to the own colour otherwise). |
| Vertex Color | Profile | `vcProfile` | curve | curve |  | Strength of the Mode along the item (left: base, right: tip). 1 = full effect, 0 = the inherited colour. Use it for lighter young twigs, darker trunk bases or leaf tips. |
| Vertex Color | Parent curve | `vcParentCurve` | curve | curve |  | Strength of the Mode by the position of the attach point on the parent (left: parent base, right: parent tip); a frond runs along its parent, so it follows the curve along it. Ignored without a parent. |
| Season | Start offset | `seasonStartOffset` | -1..1 (slider -1..1) | 0 | yes | Season start offset: 0 = the transition follows the Season slider immediately, positive values delay it, negative values start it earlier. Variance spreads it per element; the curve runs along the parent. |
| Season | Time scale | `seasonTimeScale` | 0..10 (slider 0..2) | 1 | yes | Season time scale: 1 = one slider sweep is one year of this node; 2 = twice as fast, 0 = never changes. |

### Fin geometry (T15)

Pure maths: `src/generators/fin/finMesh.ts`; node: `src/nodes/generators/fin.ts`.

* **Base ring.** The `Width segments + 1` base vertices are skin points of the parent (distance 0, zero gap) along a line in the tangent plane. Fold, curl and noise grow from the base, so the ring never leaves the skin.
* **Orientation.** *Style*: Perpendicular (the flap runs around the parent), Along spine (along it), Up (towards +Z). The fin leaves along `cos(Start angle) x e + sin(Start angle) x n` (e = style direction, n = surface normal): 0 degrees lies on the bark, 90 stands out; *Roll* turns it about n.
* **Deformation.** *Fold* turns the two halves towards each other about the centre line (growing to the tip); *Curl* bends the length axis towards the face; *Vertex Amount / Noise scale / Seed* is seeded simplex displacement x distance from the base; *Scale X / Y / Z* scale width, length and the out-of-plane amount. *Flip* mirrors U and reverses fold / curl.
* **Lighting.** *Puffiness* blends all normals towards the parent surface normal; *Match surface* blends the base normals into it, fading out towards the tip.
* **Wind.** Base ring = the parent's wind exactly (per vertex along the axis); `w2 = host + (1 - host) x min(1, 0.8 x Ripple) x t^1.5`, so the weight never decreases and never exceeds 1. Level phases are copied.
* **Type: Material / Mesh / Weight.** A row with a cutout mesh gives the flap the cutout outline (normalised to Width x Size, refined to the segment counts, then mapped with the same fold / curl / noise / wind code as the grid; its base line is where the cutout touches the bark). The cutout's anchors are exported for child generators.
* **Not implemented:** Growth, Post > Collision / Shade pruning.
