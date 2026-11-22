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
* **Extend parent** (Branch, Cap, Leaf, Batched leaf; valid under a Branch parent). *Type*: None, Any (tip), Bottom (base), Breaks only (tip of parents that end in a break; detected from the thick tip of the parent), Split 1 / Split 2 / Skinny / Fat (kept as entries, behave like Any until the split data exists). *Count* = extensions per parent.
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
| Season | Season | `season` | 0..1 | 0 |  |  | Season response: position on the 0…1 season timeline. |

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

### Tab: LOD _(not implemented yet - shown disabled)_

### Tab: Collision _(not implemented yet - shown disabled)_

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
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken / Fork | taper |  |  | How the tip ends: taper, blunt, broken or forked. |
| Splits & Termination | Split chance | `splitChance` | 0..1 | 0 |  |  | Probability that the spine forks into two. |
| Splits & Termination | Split spread | `splitSpread` | 2..85 ° | 25 |  |  | Angle between the two forks (degrees). |
| Splits & Termination | Split balance | `splitBalance` | 0.15..0.85 | 0.5 |  |  | Share of the radius that goes to the main fork. |
| Splits & Termination | Split position | `splitStart` | 0.15..0.9 | 0.58 |  |  | Position along the spine from which forks may occur. |
| Splits & Termination | Max split depth | `splitMaxDepth` | 1..3 | 1 |  |  | Maximum number of successive forks. |

### Tab: Forces

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Forces | Enabled | `forcesEnabled` | bool | true |  |  | Lets attached forces (gravity, wind direction, …) influence this node. |
| Influence | Influence | `forceInfluence` | 0..10 (slider 0..2) | 1 |  | yes | Global multiplier for all forces on this node. |
| Influence | Stiffness | `forceStiffness` | 0..1 | 0.5 |  | yes | Resistance against forces; stiff branches bend less. |
| Influence | Falloff | `forceFalloff` | 0..1 | 0 |  |  | How the force fades from the base to the tip. |

### Tab: Shape

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Cross section | Aspect | `sectionAspect` | 0.1..4 | 1 |  | yes | Width / height ratio of the cross-section (1 = round). |
| Cross section | Roundness | `sectionRoundness` | 0..1 | 1 |  |  | Blend between a round and an angular cross-section. |
| Cross section | Profile | `sectionShape` | Round / Ridged / Lobed / Noise | round |  |  | Profile of the cross-section: round, ridged, lobed or noisy. |
| Cross section | Lobes | `sectionLobes` | 1..32 | 5 |  |  | Number of ribs / lobes in the cross-section. |
| Cross section | Depth | `sectionDepth` | 0..1 | 0.12 |  |  | How deep the ribs cut into the cross-section. |
| Cross section | Spiral | `sectionSpiral` | -6..6 rad/m | 0 |  |  | Twists the ribs around the stem. |
| Cross section | Noise frequency | `sectionNoiseFrequency` | 0.1..20 | 2 |  |  | Frequency of the noise in the cross-section. |
| Flare | Radius | `flareRadius` | 0..5 (slider 0..1.5) | 0.28 |  | yes | Extra radius of the root flare at the base (metres). |
| Flare | Height | `flareHeight` | 0.01..1 | 0.14 |  |  | Height of the root flare as a fraction of the length. |
| Flare | Buttress lobes | `flareLobes` | 0..16 | 5 |  |  | Number of buttress lobes in the flare. |
| Flare | Noise | `flareNoise` | 0..1 | 0 |  |  | Random irregularity of the flare. |
| Bulge | Amount | `bulgeAmount` | 0..2 | 0 |  | yes | Strength of the periodic swelling of the radius. |
| Bulge | Frequency | `bulgeFrequency` | 0.1..20 | 1 |  |  | Number of swellings along the length. |

### Tab: Skin

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Geometry | Spine only | `spineOnly` | bool | false |  |  | Emit pure skeleton spines without building polygon tube geometry. |
| Geometry | Close end | `capEnd` | bool | true |  |  | Closes the tip of the tube with a cap. |
| Geometry | Tip rings | `tipRings` | 1..8 | 2 |  |  | Rings of the rounded tip cap. |
| Geometry | Close base | `capBase` | Auto / Yes / No | auto |  |  | Auto closes branches that do not grow from a parent. |
| Geometry | Twist | `skinTwist` | -720..720 °/m | 0 |  |  | Twists the surface texture and geometry around the axis. |
| Junction | Collar | `collarAmount` | 0..2 | 0.3 |  |  | Radius flare where a branch leaves its parent. |
| Junction | Collar length | `collarLength` | 0.1..10 | 1.5 |  |  | Length of the flare in branch radii. |
| Normals | Smoothing | `smoothing` | 0..1 | 1 |  |  | Below 0.5 the tube is faceted (unwelded quads). |
| Normals | Flatten | `flatten` | 0..1 | 0 |  |  | Flattens normals towards the axis to soften the shading. |
| Vertex color | Tint | `tint` | color | [0.36, 0.26, 0.18, 1] |  |  | Vertex colour multiplied onto the material. |
| Vertex color | Variance | `tintVariance` | 0..1 | 0.1 |  |  | Random variation of the vertex colour per instance. |
| Vertex color | AO strength | `aoStrength` | 0..1 | 0.6 |  |  | Strength of the baked vertex ambient occlusion. |

### Tab: UV

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Mapping | Mode | `uvMode` | Metric / Normalized | metric |  |  | How UVs are laid out: metric (real-world scale) or normalized (0…1). |
| Mapping | Rotate 90° | `uvRotate` | bool | false |  |  | Rotates the UV layout by 90°. |
| Tiling | U scale | `uvScaleU` | 0.01..100 (slider 0.01..10) | 1 |  |  | Texture tiling around the stem. |
| Tiling | V scale | `uvScaleV` | 0.01..100 (slider 0.01..10) | 1 |  |  | Texture tiling along the stem. |
| Tiling | U offset | `uvOffsetU` | -10..10 | 0 |  |  | Shifts the texture around the stem. |
| Tiling | V offset | `uvOffsetV` | -10..10 | 0 |  |  | Shifts the texture along the stem. |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Reduction | Side reduction | `lodSides` | 0..1 | 0.5 |  |  | How many sides are removed at lower LODs. |
| Reduction | Segment reduction | `lodSegments` | 0..1 | 0.5 |  |  | How many segments are removed at lower LODs. |
| Reduction | Cull amount | `lodCull` | 0..1 | 0 |  |  | Fraction of small children removed at lower LODs. |
| Distance | Fade start | `lodFadeStart` | 0..1 | 0.5 |  |  | Distance where this node starts fading out. |
| Distance | Fade end | `lodFadeEnd` | 0..1 | 1 |  |  | Distance where this node has completely faded. |

### Tab: Displacement

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Displacement | Displacement | `displacement` | None |  |  |  | Height map from the Displacements panel. A warning badge shows on the node when the map is missing or not loaded. |
| Displacement | Enabled | `displaceEnabled` | bool | true |  |  | Enables displacement from a height image. |
| Displacement | Amount | `displaceAmount` | -5..5 (slider 0..0.2) m | 0 |  | yes | Displacement in metres at full height. The curve scales it along the branch length. |
| Displacement | + % of radius | `displaceRadiusAmount` | -1..2 | 0 |  |  | Extra amount relative to the local radius (thick trunks get deeper bark). |
| Displacement | Offset | `displaceOffset` | -1..1 | 0 |  |  | Bias added to the height before scaling. |
| Displacement | Mid-grey is neutral | `displaceMidGrey` | bool | true |  |  | On: 50% grey does not move the surface (both directions). Off: black = no displacement, white = full amount outward. |
| Displacement | Direction | `displaceDirection` | Normal / Radial | normal |  |  | Displace along the surface normal or radially from the axis. |
| Mapping | Tiling | `displaceTiling` | World / Normalized | world |  |  | World: one image tile covers "Tile size" metres, no stretching on long or thick branches. |
| Mapping | Tile size | `displaceTileSize` | 0.005..50 (slider 0.005..4) m | 0.5 |  |  | World size of one displacement tile. |
| Mapping | Scale | `displaceScale` | 0.01..50 | 1 |  |  | Height of the displacement. |
| Mapping | Scale U | `displaceScaleU` | 0.01..50 | 1 |  |  | Displacement tiling around the stem. |
| Mapping | Scale V | `displaceScaleV` | 0.01..50 | 1 |  |  | Displacement tiling along the stem. |
| Mapping | Rotation | `displaceRotation` | -360..360 ° | 0 |  |  | Snapped to 90° steps while seams are locked. |
| Mapping | Lock seams | `displaceLockSeams` | bool | true |  |  | Round the tiling around the trunk to a whole number so the U seam is continuous. |
| Fade | Fade at junctions | `displaceFadeBase` | 0..10 | 1.5 |  |  | Fade-in length (in radii) where a branch leaves its parent: prevents cracks at junctions. |
| Fade | Fade at tips | `displaceFadeTip` | 0..10 | 1 |  |  | Fade-out length (in radii) toward the tip / cap. |
| Fade | LOD fade | `displaceLodFade` | bool | true |  |  | Fade the amount out between LOD 1 and 3. |
| Subdivision | Auto-subdivide | `displaceAutoSubdivide` | bool | true |  |  | Add rings and sides so the mesh has enough vertices to carry the height detail. |
| Subdivision | Detail size | `displaceDetail` | 0.002..1 (slider 0.002..0.2) m | 0.03 |  |  | Target quad size when auto-subdividing (smaller = more detail, more triangles). |
| Subdivision | Min sides | `displaceMinSides` | 3..128 | 16 |  |  | Minimum number of sides while displacement is active. |
| Noise | Noise | `displaceNoise` | 0..1 | 0.5 |  |  | Adds noise to the displacement. |
| Noise | Seed | `displaceSeed` | seed | 0 |  |  | Random seed of the displacement noise. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Material | Material | `material` | None |  |  |  | Material (or Material Set) used for this node; empty = the default for the node type. |
| Material | Tint | `materialTint` | color | [1, 1, 1, 1] |  |  | Colour multiplied onto the material. |
| Material | Variation | `materialVariation` | 0..1 | 0 | yes |  | How much the material variation colours are applied. |
| Blend | Base blend | `blendBase` | 0..1 | 0 |  | yes | Blends the material towards the parent at the base. |
| Blend | Height blend | `blendHeight` | 0..1 | 0 |  |  | Blends the material along the height. |

### Tab: Animation

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Wind hierarchy | Hierarchy | `windHierarchy` | Trunk / Branch 1 / Branch 2 / Leaf | branch-1 |  |  | Which level of the wind hierarchy this geometry follows (trunk, branch 1/2, leaf). |
| Amount | Amount | `windAmount` | 0..10 (slider 0..2) | 1 |  | yes | Strength multiplier of the wind on this node. |
| Amount | Phase variance | `windPhaseVariance` | 0..1 | 0.5 |  |  | Random phase offset so neighbours do not sway in sync. |

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
| Extend parent | Type | `extendParent` | None / Any / Split 1 / Split 2 / Skinny / Fat / Breaks only / Bottom | none |  |  | Continues the parent instead of starting a new branch. Valid only under a Branch parent. Split 1 / Split 2 / Skinny / Fat currently behave like Any. |
| Extend parent | Count | `extendCount` | 1..8 | 1 |  |  | Extensions created per parent. |
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
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken / Fork | taper |  |  | How the tip ends: taper, blunt, broken or forked. |
| Splits & Termination | Split chance | `splitChance` | 0..1 | 0 |  |  | Probability that the spine forks into two. |
| Splits & Termination | Split spread | `splitSpread` | 2..85 ° | 25 |  |  | Angle between the two forks (degrees). |
| Splits & Termination | Split balance | `splitBalance` | 0.15..0.85 | 0.5 |  |  | Share of the radius that goes to the main fork. |
| Splits & Termination | Split position | `splitStart` | 0.15..0.9 | 0.58 |  |  | Position along the spine from which forks may occur. |
| Splits & Termination | Max split depth | `splitMaxDepth` | 1..3 | 1 |  |  | Maximum number of successive forks. |
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

### Tab: Shape

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Cross section | Aspect | `sectionAspect` | 0.1..4 | 1 |  | yes | Width / height ratio of the cross-section (1 = round). |
| Cross section | Roundness | `sectionRoundness` | 0..1 | 1 |  |  | Blend between a round and an angular cross-section. |
| Cross section | Profile | `sectionShape` | Round / Ridged / Lobed / Noise | round |  |  | Profile of the cross-section: round, ridged, lobed or noisy. |
| Cross section | Lobes | `sectionLobes` | 1..32 | 5 |  |  | Number of ribs / lobes in the cross-section. |
| Cross section | Depth | `sectionDepth` | 0..1 | 0.12 |  |  | How deep the ribs cut into the cross-section. |
| Cross section | Spiral | `sectionSpiral` | -6..6 rad/m | 0 |  |  | Twists the ribs around the stem. |
| Cross section | Noise frequency | `sectionNoiseFrequency` | 0.1..20 | 2 |  |  | Frequency of the noise in the cross-section. |
| Flare | Radius | `flareRadius` | 0..5 (slider 0..1.5) | 0 |  | yes | Extra radius of the root flare at the base (metres). |
| Flare | Height | `flareHeight` | 0.01..1 | 0.14 |  |  | Height of the root flare as a fraction of the length. |
| Flare | Buttress lobes | `flareLobes` | 0..16 | 5 |  |  | Number of buttress lobes in the flare. |
| Flare | Noise | `flareNoise` | 0..1 | 0 |  |  | Random irregularity of the flare. |
| Bulge | Amount | `bulgeAmount` | 0..2 | 0 |  | yes | Strength of the periodic swelling of the radius. |
| Bulge | Frequency | `bulgeFrequency` | 0.1..20 | 1 |  |  | Number of swellings along the length. |

### Tab: Skin

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Geometry | Spine only | `spineOnly` | bool | false |  |  | Emit pure skeleton spines without building polygon tube geometry. |
| Geometry | Close end | `capEnd` | bool | true |  |  | Closes the tip of the tube with a cap. |
| Geometry | Tip rings | `tipRings` | 1..8 | 2 |  |  | Rings of the rounded tip cap. |
| Geometry | Close base | `capBase` | Auto / Yes / No | auto |  |  | Auto closes branches that do not grow from a parent. |
| Geometry | Twist | `skinTwist` | -720..720 °/m | 0 |  |  | Twists the surface texture and geometry around the axis. |
| Junction | Collar | `collarAmount` | 0..2 | 0.3 |  |  | Radius flare where a branch leaves its parent. |
| Junction | Collar length | `collarLength` | 0.1..10 | 1.5 |  |  | Length of the flare in branch radii. |
| Welding | Enabled | `weldEnabled` | bool | false |  |  | Pushes the base of the branch out of its parent and fuses it to the parent surface, for a seamless union without a visible seam. |
| Welding | Keep | `weldKeep` | curve | curve |  |  | Runs over the height of the model (left = bottom, right = top). Welds are dropped where the curve is below 0.5: the branch then starts on the parent spine without fusing. |
| Welding | Keep failed | `weldKeepFailed` | bool | false |  |  | Keeps branches whose weld failed (they are drawn without fusing) instead of removing them. Useful to find the failures. |
| Welding | Force ray casts | `weldForceRays` | bool | false |  |  | Casts rays against the real parent tube (curved and tapered along its whole spine) instead of the procedural cone at the attachment: better on strongly bent parents, but more welds fail. |
| Welding | Offset | `weldOffset` | 0..10 (slider 0..4) | 1.5 |  |  | How far (in branch radii) the branch is pushed out of the parent surface before it is welded back: the length of the weld part. |
| Spread | Amount | `weldSpreadAmount` | 0..2 (slider 0..1) | 0.3 |  |  | How much the base of the branch widens at the weld site (fraction of its radius). |
| Spread | Upper scale | `weldSpreadUpper` | 0..2 (slider 0..1) | 0.2 |  |  | Extra widening on the side of the base facing the tip of the parent, which forms a web where the branches meet. |
| Spread | Lower scale | `weldSpreadLower` | 0..2 (slider 0..1) | 0.1 |  |  | Extra widening on the side of the base facing the base of the parent. |
| Normals | Smoothing | `smoothing` | 0..1 | 1 |  |  | Below 0.5 the tube is faceted (unwelded quads). |
| Normals | Flatten | `flatten` | 0..1 | 0 |  |  | Flattens normals towards the axis to soften the shading. |
| Vertex color | Tint | `tint` | color | [0.36, 0.26, 0.18, 1] |  |  | Vertex colour multiplied onto the material. |
| Vertex color | Variance | `tintVariance` | 0..1 | 0.1 |  |  | Random variation of the vertex colour per instance. |
| Vertex color | AO strength | `aoStrength` | 0..1 | 0.6 |  |  | Strength of the baked vertex ambient occlusion. |

### Tab: UV

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Mapping | Mode | `uvMode` | Metric / Normalized | metric |  |  | How UVs are laid out: metric (real-world scale) or normalized (0…1). |
| Mapping | Rotate 90° | `uvRotate` | bool | false |  |  | Rotates the UV layout by 90°. |
| Tiling | U scale | `uvScaleU` | 0.01..100 (slider 0.01..10) | 1 |  |  | Texture tiling around the stem. |
| Tiling | V scale | `uvScaleV` | 0.01..100 (slider 0.01..10) | 1 |  |  | Texture tiling along the stem. |
| Tiling | U offset | `uvOffsetU` | -10..10 | 0 |  |  | Shifts the texture around the stem. |
| Tiling | V offset | `uvOffsetV` | -10..10 | 0 |  |  | Shifts the texture along the stem. |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Reduction | Side reduction | `lodSides` | 0..1 | 0.5 |  |  | How many sides are removed at lower LODs. |
| Reduction | Segment reduction | `lodSegments` | 0..1 | 0.5 |  |  | How many segments are removed at lower LODs. |
| Reduction | Cull amount | `lodCull` | 0..1 | 0 |  |  | Fraction of small children removed at lower LODs. |
| Distance | Fade start | `lodFadeStart` | 0..1 | 0.5 |  |  | Distance where this node starts fading out. |
| Distance | Fade end | `lodFadeEnd` | 0..1 | 1 |  |  | Distance where this node has completely faded. |

### Tab: Displacement

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Displacement | Displacement | `displacement` | None |  |  |  | Height map from the Displacements panel. A warning badge shows on the node when the map is missing or not loaded. |
| Displacement | Enabled | `displaceEnabled` | bool | true |  |  | Enables displacement from a height image. |
| Displacement | Amount | `displaceAmount` | -5..5 (slider 0..0.2) m | 0 |  | yes | Displacement in metres at full height. The curve scales it along the branch length. |
| Displacement | + % of radius | `displaceRadiusAmount` | -1..2 | 0 |  |  | Extra amount relative to the local radius (thick trunks get deeper bark). |
| Displacement | Offset | `displaceOffset` | -1..1 | 0 |  |  | Bias added to the height before scaling. |
| Displacement | Mid-grey is neutral | `displaceMidGrey` | bool | true |  |  | On: 50% grey does not move the surface (both directions). Off: black = no displacement, white = full amount outward. |
| Displacement | Direction | `displaceDirection` | Normal / Radial | normal |  |  | Displace along the surface normal or radially from the axis. |
| Mapping | Tiling | `displaceTiling` | World / Normalized | world |  |  | World: one image tile covers "Tile size" metres, no stretching on long or thick branches. |
| Mapping | Tile size | `displaceTileSize` | 0.005..50 (slider 0.005..4) m | 0.5 |  |  | World size of one displacement tile. |
| Mapping | Scale | `displaceScale` | 0.01..50 | 1 |  |  | Height of the displacement. |
| Mapping | Scale U | `displaceScaleU` | 0.01..50 | 1 |  |  | Displacement tiling around the stem. |
| Mapping | Scale V | `displaceScaleV` | 0.01..50 | 1 |  |  | Displacement tiling along the stem. |
| Mapping | Rotation | `displaceRotation` | -360..360 ° | 0 |  |  | Snapped to 90° steps while seams are locked. |
| Mapping | Lock seams | `displaceLockSeams` | bool | true |  |  | Round the tiling around the trunk to a whole number so the U seam is continuous. |
| Fade | Fade at junctions | `displaceFadeBase` | 0..10 | 1.5 |  |  | Fade-in length (in radii) where a branch leaves its parent: prevents cracks at junctions. |
| Fade | Fade at tips | `displaceFadeTip` | 0..10 | 1 |  |  | Fade-out length (in radii) toward the tip / cap. |
| Fade | LOD fade | `displaceLodFade` | bool | true |  |  | Fade the amount out between LOD 1 and 3. |
| Subdivision | Auto-subdivide | `displaceAutoSubdivide` | bool | true |  |  | Add rings and sides so the mesh has enough vertices to carry the height detail. |
| Subdivision | Detail size | `displaceDetail` | 0.002..1 (slider 0.002..0.2) m | 0.03 |  |  | Target quad size when auto-subdividing (smaller = more detail, more triangles). |
| Subdivision | Min sides | `displaceMinSides` | 3..128 | 16 |  |  | Minimum number of sides while displacement is active. |
| Noise | Noise | `displaceNoise` | 0..1 | 0.5 |  |  | Adds noise to the displacement. |
| Noise | Seed | `displaceSeed` | seed | 0 |  |  | Random seed of the displacement noise. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Material | Material | `material` | None |  |  |  | Material (or Material Set) used for this node; empty = the default for the node type. |
| Material | Tint | `materialTint` | color | [1, 1, 1, 1] |  |  | Colour multiplied onto the material. |
| Material | Variation | `materialVariation` | 0..1 | 0 | yes |  | How much the material variation colours are applied. |
| Blend | Base blend | `blendBase` | 0..1 | 0 |  | yes | Blends the material towards the parent at the base. |
| Blend | Height blend | `blendHeight` | 0..1 | 0 |  |  | Blends the material along the height. |

### Tab: Animation

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Wind hierarchy | Hierarchy | `windHierarchy` | Trunk / Branch 1 / Branch 2 / Leaf | branch-1 |  |  | Which level of the wind hierarchy this geometry follows (trunk, branch 1/2, leaf). |
| Amount | Amount | `windAmount` | 0..10 (slider 0..2) | 1 |  | yes | Strength multiplier of the wind on this node. |
| Amount | Phase variance | `windPhaseVariance` | 0..1 | 0.5 |  |  | Random phase offset so neighbours do not sway in sync. |

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
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken / Fork | taper |  |  | How the tip ends: taper, blunt, broken or forked. |
| Splits & Termination | Split chance | `splitChance` | 0..1 | 0 |  |  | Probability that the spine forks into two. |
| Splits & Termination | Split spread | `splitSpread` | 2..85 ° | 25 |  |  | Angle between the two forks (degrees). |
| Splits & Termination | Split balance | `splitBalance` | 0.15..0.85 | 0.5 |  |  | Share of the radius that goes to the main fork. |
| Splits & Termination | Split position | `splitStart` | 0.15..0.9 | 0.58 |  |  | Position along the spine from which forks may occur. |
| Splits & Termination | Max split depth | `splitMaxDepth` | 1..3 | 1 |  |  | Maximum number of successive forks. |
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

### Tab: Shape

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Cross section | Aspect | `sectionAspect` | 0.1..4 | 1 |  | yes | Width / height ratio of the cross-section (1 = round). |
| Cross section | Roundness | `sectionRoundness` | 0..1 | 1 |  |  | Blend between a round and an angular cross-section. |
| Cross section | Profile | `sectionShape` | Round / Ridged / Lobed / Noise | round |  |  | Profile of the cross-section: round, ridged, lobed or noisy. |
| Cross section | Lobes | `sectionLobes` | 1..32 | 5 |  |  | Number of ribs / lobes in the cross-section. |
| Cross section | Depth | `sectionDepth` | 0..1 | 0.12 |  |  | How deep the ribs cut into the cross-section. |
| Cross section | Spiral | `sectionSpiral` | -6..6 rad/m | 0 |  |  | Twists the ribs around the stem. |
| Cross section | Noise frequency | `sectionNoiseFrequency` | 0.1..20 | 2 |  |  | Frequency of the noise in the cross-section. |
| Flare | Radius | `flareRadius` | 0..5 (slider 0..1.5) | 0 |  | yes | Extra radius of the root flare at the base (metres). |
| Flare | Height | `flareHeight` | 0.01..1 | 0.1 |  |  | Height of the root flare as a fraction of the length. |
| Flare | Buttress lobes | `flareLobes` | 0..16 | 5 |  |  | Number of buttress lobes in the flare. |
| Flare | Noise | `flareNoise` | 0..1 | 0 |  |  | Random irregularity of the flare. |
| Bulge | Amount | `bulgeAmount` | 0..2 | 0 |  | yes | Strength of the periodic swelling of the radius. |
| Bulge | Frequency | `bulgeFrequency` | 0.1..20 | 1 |  |  | Number of swellings along the length. |

### Tab: Skin

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Geometry | Spine only | `spineOnly` | bool | true |  |  | Emit pure skeleton spines without building polygon tube geometry. |
| Geometry | Close end | `capEnd` | bool | true |  |  | Closes the tip of the tube with a cap. |
| Geometry | Tip rings | `tipRings` | 1..8 | 2 |  |  | Rings of the rounded tip cap. |
| Geometry | Close base | `capBase` | Auto / Yes / No | auto |  |  | Auto closes branches that do not grow from a parent. |
| Geometry | Twist | `skinTwist` | -720..720 °/m | 0 |  |  | Twists the surface texture and geometry around the axis. |
| Junction | Collar | `collarAmount` | 0..2 | 0.3 |  |  | Radius flare where a branch leaves its parent. |
| Junction | Collar length | `collarLength` | 0.1..10 | 1.5 |  |  | Length of the flare in branch radii. |
| Normals | Smoothing | `smoothing` | 0..1 | 1 |  |  | Below 0.5 the tube is faceted (unwelded quads). |
| Normals | Flatten | `flatten` | 0..1 | 0 |  |  | Flattens normals towards the axis to soften the shading. |
| Vertex color | Tint | `tint` | color | [0.36, 0.26, 0.18, 1] |  |  | Vertex colour multiplied onto the material. |
| Vertex color | Variance | `tintVariance` | 0..1 | 0.1 |  |  | Random variation of the vertex colour per instance. |
| Vertex color | AO strength | `aoStrength` | 0..1 | 0.6 |  |  | Strength of the baked vertex ambient occlusion. |

### Tab: UV

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Mapping | Mode | `uvMode` | Metric / Normalized | metric |  |  | How UVs are laid out: metric (real-world scale) or normalized (0…1). |
| Mapping | Rotate 90° | `uvRotate` | bool | false |  |  | Rotates the UV layout by 90°. |
| Tiling | U scale | `uvScaleU` | 0.01..100 (slider 0.01..10) | 1 |  |  | Texture tiling around the stem. |
| Tiling | V scale | `uvScaleV` | 0.01..100 (slider 0.01..10) | 1 |  |  | Texture tiling along the stem. |
| Tiling | U offset | `uvOffsetU` | -10..10 | 0 |  |  | Shifts the texture around the stem. |
| Tiling | V offset | `uvOffsetV` | -10..10 | 0 |  |  | Shifts the texture along the stem. |

### Tab: LOD

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Reduction | Side reduction | `lodSides` | 0..1 | 0.5 |  |  | How many sides are removed at lower LODs. |
| Reduction | Segment reduction | `lodSegments` | 0..1 | 0.5 |  |  | How many segments are removed at lower LODs. |
| Reduction | Cull amount | `lodCull` | 0..1 | 0 |  |  | Fraction of small children removed at lower LODs. |
| Distance | Fade start | `lodFadeStart` | 0..1 | 0.5 |  |  | Distance where this node starts fading out. |
| Distance | Fade end | `lodFadeEnd` | 0..1 | 1 |  |  | Distance where this node has completely faded. |

### Tab: Displacement

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Displacement | Displacement | `displacement` | None |  |  |  | Height map from the Displacements panel. A warning badge shows on the node when the map is missing or not loaded. |
| Displacement | Enabled | `displaceEnabled` | bool | true |  |  | Enables displacement from a height image. |
| Displacement | Amount | `displaceAmount` | -5..5 (slider 0..0.2) m | 0 |  | yes | Displacement in metres at full height. The curve scales it along the branch length. |
| Displacement | + % of radius | `displaceRadiusAmount` | -1..2 | 0 |  |  | Extra amount relative to the local radius (thick trunks get deeper bark). |
| Displacement | Offset | `displaceOffset` | -1..1 | 0 |  |  | Bias added to the height before scaling. |
| Displacement | Mid-grey is neutral | `displaceMidGrey` | bool | true |  |  | On: 50% grey does not move the surface (both directions). Off: black = no displacement, white = full amount outward. |
| Displacement | Direction | `displaceDirection` | Normal / Radial | normal |  |  | Displace along the surface normal or radially from the axis. |
| Mapping | Tiling | `displaceTiling` | World / Normalized | world |  |  | World: one image tile covers "Tile size" metres, no stretching on long or thick branches. |
| Mapping | Tile size | `displaceTileSize` | 0.005..50 (slider 0.005..4) m | 0.5 |  |  | World size of one displacement tile. |
| Mapping | Scale | `displaceScale` | 0.01..50 | 1 |  |  | Height of the displacement. |
| Mapping | Scale U | `displaceScaleU` | 0.01..50 | 1 |  |  | Displacement tiling around the stem. |
| Mapping | Scale V | `displaceScaleV` | 0.01..50 | 1 |  |  | Displacement tiling along the stem. |
| Mapping | Rotation | `displaceRotation` | -360..360 ° | 0 |  |  | Snapped to 90° steps while seams are locked. |
| Mapping | Lock seams | `displaceLockSeams` | bool | true |  |  | Round the tiling around the trunk to a whole number so the U seam is continuous. |
| Fade | Fade at junctions | `displaceFadeBase` | 0..10 | 1.5 |  |  | Fade-in length (in radii) where a branch leaves its parent: prevents cracks at junctions. |
| Fade | Fade at tips | `displaceFadeTip` | 0..10 | 1 |  |  | Fade-out length (in radii) toward the tip / cap. |
| Fade | LOD fade | `displaceLodFade` | bool | true |  |  | Fade the amount out between LOD 1 and 3. |
| Subdivision | Auto-subdivide | `displaceAutoSubdivide` | bool | true |  |  | Add rings and sides so the mesh has enough vertices to carry the height detail. |
| Subdivision | Detail size | `displaceDetail` | 0.002..1 (slider 0.002..0.2) m | 0.03 |  |  | Target quad size when auto-subdividing (smaller = more detail, more triangles). |
| Subdivision | Min sides | `displaceMinSides` | 3..128 | 16 |  |  | Minimum number of sides while displacement is active. |
| Noise | Noise | `displaceNoise` | 0..1 | 0.5 |  |  | Adds noise to the displacement. |
| Noise | Seed | `displaceSeed` | seed | 0 |  |  | Random seed of the displacement noise. |

### Tab: Material

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Material | Material | `material` | None |  |  |  | Material (or Material Set) used for this node; empty = the default for the node type. |
| Material | Tint | `materialTint` | color | [1, 1, 1, 1] |  |  | Colour multiplied onto the material. |
| Material | Variation | `materialVariation` | 0..1 | 0 | yes |  | How much the material variation colours are applied. |
| Blend | Base blend | `blendBase` | 0..1 | 0 |  | yes | Blends the material towards the parent at the base. |
| Blend | Height blend | `blendHeight` | 0..1 | 0 |  |  | Blends the material along the height. |

### Tab: Animation

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Wind hierarchy | Hierarchy | `windHierarchy` | Trunk / Branch 1 / Branch 2 / Leaf | branch-1 |  |  | Which level of the wind hierarchy this geometry follows (trunk, branch 1/2, leaf). |
| Amount | Amount | `windAmount` | 0..10 (slider 0..2) | 1 |  | yes | Strength multiplier of the wind on this node. |
| Amount | Phase variance | `windPhaseVariance` | 0..1 | 0.5 |  |  | Random phase offset so neighbours do not sway in sync. |

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
