# Parameters

Generated from the node registry by `WRITE_PARAM_DOCS=1 npx vitest run tests/paramDocs.test.ts` - do not edit by hand.

* **Var** = the row has the "%" variance toggle (blue variance field). **Curve** = a curve may drive the value along the parent / spine (green mini-curve).
* Values typed in the number field are accepted up to the hard max; the slider only covers the soft range.
* Counts above `warnAbove` (1000 for `Number`) show a yellow "!" performance badge next to the label.
* Curves on a parameter are evaluated along the *parent* (0 = base, 1 = tip) for placement params, and along the *spine* for shape params.

## Tree (`output.tree`)

Root of the plant. Its Shape defines the ground disc in which first-generation nodes are placed.

### Tab: Gen

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| More | Size scalar | `scale` | 0.01..100 (slider 0.01..5) | 1 |  |  | Uniform scale multiplier. |
| More | Ground offset | `groundOffset` | -10..10 m | 0 |  |  | Moves the whole plant up or down relative to the ground. |
| Season | Season | `season` | 0..1 | 0 |  |  | Season response: position on the 0…1 season timeline. |

### Tab: Shape

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Shape | Type | `shapeType` | Circle | circle |  |  | Placement area. Only the circle exists for now. |
| Shape | Radius | `radius` | 0..10000 (slider 0..50) m | 10 |  |  | Radius of the placement disc (drag the white handle in the viewport). |
| Shape | Center X | `centerX` | -10000..10000 (slider -50..50) m | 0 |  |  | X position of the placement area centre. |
| Shape | Center Y | `centerY` | -10000..10000 (slider -50..50) m | 0 |  |  | Y position of the placement area centre. |
| Shape | Sink | `treeSink` | -50..50 (slider -2..2) m | 0 |  |  | Depth every child is sunk into the ground. |
| Shape | Roll | `treeRoll` | -360..360 (slider -180..180) ° | 0 |  |  | Rotates the whole placement pattern around the vertical axis. |
| Shape | Unify child orientation | `unifyChildOrientation` | bool | false |  |  | Give all children the same orientation instead of a random one. |

### Tab: LOD _(not implemented yet - shown disabled)_

### Tab: Collision _(not implemented yet - shown disabled)_

## Trunk (`generator.trunk`)

Main stem with crown height, buttress flare, lean, gnarliness, and profile curves.

### Tab: Gen

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Generation | Mode | `mode` | Absolute / Density | absolute |  |  | How the number and spacing of children are decided (absolute count, density, phyllotaxy, whorls, …). |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 1 | yes | yes | How many children are created on each parent (or how many stems for a Trunk). Large values are slow. |
| Absolute | Jumble | `jumble` | 0..1 | 0 |  | yes | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | yes | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | yes | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | yes | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Absolute | Align | `align` | bool | false |  |  | Aligns all children to the same angular position instead of rotating them. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | yes | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  |  | Random variation of the spacing in Density mode. |
| Boundaries | First | `first` | 0..1 | 0 |  | yes | Where along the parent the first child may appear (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 1 |  | yes | Where along the parent the last child may appear (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0.025 |  | yes | Fraction of the parent at both ends that stays free of children. |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  |  | Enables the clip margins at both ends of the parent. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes |  | Extra rotation (degrees) applied to every child around the parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes |  | Slides every child along the parent by a fixed fraction. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes |  | How deep the base is sunk into the ground (+ variance for placed instances). |
| Common | Active | `active` | bool | true |  | yes | Turns the whole node on or off without deleting it. |
| Common | Seed | `seed` | seed | 0 |  |  | Random seed. Change it to get a different variation of the same settings. |
| Tree placement | Distribution | `distMode` | Parametric / Uniform / Poisson disk / Ring / Grid / Spiral | uniform |  |  | How Number instances fill the Tree disc. Uniform = area-correct random (r = R*sqrt(u)); Poisson disk = blue noise with a minimum distance. |
| Tree placement | Position | `distPosition` | 0..1 | 0.5 | yes |  | Normalised distance from the disc centre (0 = centre, 1 = edge), with variance. |
| Tree placement | Rotation | `distRotation` | 0..1 | 0 | yes |  | Normalised angle around the centre (0..1 = 0..360 degrees), with variance. |
| Tree placement | Min distance | `distMinDistance` | 0..1000 (slider 0..10) m | 0.5 |  |  | Minimum distance between first-generation elements placed on the ground. |
| Tree placement | Splay | `distSplay` | 0..85 ° | 0 |  |  | Outward tilt reached at the disc edge (ferns, bushes). Ignored when Unify child orientation is on. |

### Tab: Spine

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Length | Absolute | `length` | 0.02..500 (slider 0.02..40) m | 12 | yes | yes | Length of each child in metres. |
| Length | Relative to parent | `lengthRelative` | bool | false |  |  | Makes the length depend on the length of the parent. |
| Length | + % of parent | `lengthPercent` | 0..2 (slider 0..1) | 0 |  | yes | Adds a percentage of the parent length to the absolute length. |
| Length | + % of radius | `lengthPercentRadius` | 0..500 (slider 0..100) | 0 |  |  | Adds this many parent radii to the length. |
| Length | Match one v tile | `matchOneVTile` | Generated / Yes / No | generated |  |  | Yes: the bark texture is stretched so it tiles exactly once along the spine. |
| Length | Shape scale | `shapeScale` | 0..5 (slider 0..2) | 1 |  |  | Multiplies curvature and noise amounts of the spine. |
| Length | Limit length | `lengthLimit` | bool | false |  |  | Prevents children from becoming longer than the parent. |
| Length | Crown height | `crownHeight` | 0..0.95 | 0.22 |  |  | Normalized height where the lower trunk transitions into the crown. |
| Clamp | Min | `lengthMin` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no minimum. |
| Clamp | Max | `lengthMax` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no maximum. |
| Orientation | Lean | `lean` | 0..60 ° | 2 | yes |  | Tilts the whole stem away from vertical (degrees). |
| Orientation | Lean direction | `leanAzimuth` | -180..180 ° | 25 | yes |  | Compass direction of the lean. |
| Orientation | Spread | `spread` | 0..180 ° | 12 | yes | yes | Angle between the child and its parent (degrees, 0 = parallel). |
| Orientation | Start roll | `startRoll` | -180..180 ° | 0 | yes | yes | Rotation of the child around its own axis at the start. |
| Orientation | Pitch | `pitch` | -90..90 ° | 0 | yes | yes | Tilts the starting direction up or down (degrees). |
| Orientation | Roll | `spineRoll` | -180..180 ° | 0 |  |  | Rotation of the spine around its own axis. |
| Orientation | Alignment | `alignment` | 0..1 | 0 |  |  | Rotates children towards the sun / up direction. |
| Orientation | Up / down | `upDown` | -2..2 (slider -1..1) | 0.04 |  | yes | Pushes the growth direction up (+) or down (−) along the length. |
| Shape | Gravity | `gravity` | -2..3 (slider -1..1.5) | 0 |  | yes | Bends the child downward (+) or upward (−) under gravity. |
| Shape | Curvature | `curvature` | -2..2 (slider -1..1) | 0.03 | yes | yes | Overall bend of the child along its length. |
| Shape | Straightness | `straightness` | 0..1 | 0.35 |  |  | How strongly the child resists bending; 1 = ruler straight. |
| Shape | Twist | `twist` | -720..720 (slider -180..180) ° | 0 | yes | yes | Adds a rotation around the axis along the path. |
| Parent Curl | Up | `curlUp` | -3..3 (slider -1..1) | 0 |  |  | Curl toward the parent direction (up the parent). |
| Parent Curl | Right | `curlRight` | -3..3 (slider -1..1) | 0 |  |  | Curl sideways relative to the parent. |
| Parent Curl | Out | `curlOut` | -3..3 (slider -1..1) | 0 |  |  | Curl away from the parent axis (negative = toward it). |
| Zigzag | Intensity | `zigzag` | 0..3 (slider 0..1) | 0 |  |  | Alternating bend at every segment (zig-zag stem). |
| Segment length | Absolute | `segments` | 2..512 | 24 |  |  | Number of segments along the spine. |
| Segment length | + Relative | `relativeSegments` | 0..20 (slider 0..4) /m | 0 |  |  | Extra segments scaled by the length of the child. |
| Segment length | Accuracy | `accuracy` | 8..128 | 36 |  |  | Number of sample points used to follow the spine (higher = smoother, slower). |
| Segment length | Optimization | `optimization` | 0..30 ° | 0 |  |  | Curvature-aware adaptive simplification threshold (0 = keep all segments). |
| Radius | Radius | `radius` | 0.001..20 (slider 0.001..2) m | 0.32 | yes | yes | Size: the radius of the cross-section at the base (metres), or the range of an effect. |
| Radius | Radius profile | `radiusProfile` | curve | curve |  |  | Normalized radius multiplier from base (0) to tip (1). |
| Radius | Taper | `taper` | 0..1 | 0.88 |  | yes | How much the radius shrinks from base to tip (1 = pointed). |
| Radius | Min radius | `minRadius` | 0.0005..1 (slider 0.0005..0.05) m | 0.008 |  |  | Smallest radius the child may reach. |
| Noise | Early amount | `earlyNoiseAmount` | 0..2 (slider 0..0.8) | 0.05 |  | yes | Noise strength near the base of the child. |
| Noise | Early turbulence | `earlyNoiseFrequency` | 0.05..15 (slider 0.05..5) | 1.2 |  |  | Noise frequency near the base of the child. |
| Noise | Amount | `noiseAmount` | 0..5 (slider 0..1.5) | 0.16 |  | yes | Strength of the random wobble along the spine. |
| Noise | Frequency | `noiseFrequency` | 0..20 (slider 0..6) | 1.1 |  |  | How fast the wobble changes along the spine. |
| Noise | Twist | `noiseTwist` | -2..2 (slider -1..1) | 0.1 |  |  | Rotates the noise as it travels along the spine. |
| Noise | Smooth | `noiseSmooth` | 0..1 | 0 |  |  | Smooths the noise to avoid sharp kinks. |
| Noise | Noise seed | `noiseSeed` | seed | 0 |  |  | Random seed of the noise pattern. |
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken / Fork | taper |  |  | How the tip ends: taper, blunt, broken or forked. |
| Splits & Termination | Split chance | `splitChance` | 0..1 | 0 |  |  | Probability that the spine forks into two. |
| Splits & Termination | Split spread | `splitSpread` | 2..85 ° | 25 |  |  | Angle between the two forks (degrees). |
| Splits & Termination | Split balance | `splitBalance` | 0.15..0.85 | 0.5 |  |  | Share of the radius that goes to the main fork. |
| Splits & Termination | Split position | `splitStart` | 0.15..0.9 | 0.58 |  |  | Position along the spine from which forks may occur. |
| Splits & Termination | Max split depth | `splitMaxDepth` | 1..3 | 1 |  |  | Maximum number of successive forks. |
| Splits & Termination | Break chance | `breakChance` | 0..1 | 0 |  |  | Probability that the spine snaps and ends early. |
| Splits & Termination | Break spot | `breakSpot` | 0.1..0.98 | 0.68 | yes |  | Position along the spine where a break may happen. |

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
| Geometry | Sides | `sides` | 3..64 | 12 |  |  | Number of sides of the tube cross-section. Fewer sides = fewer triangles. |
| Geometry | Length segments | `lengthSegments` | 0..512 | 0 |  |  | 0 = use the Spine segments |
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

### Tab: Segments _(not implemented yet - shown disabled)_

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
| Generation | Mode | `mode` | Absolute / Density / Proportional / Interval / Phyllotaxy / Whorled / Bifurcation / Flood | absolute |  |  | How the number and spacing of children are decided (absolute count, density, phyllotaxy, whorls, …). |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 12 | yes | yes | How many children are created on each parent (or how many stems for a Trunk). Large values are slow. |
| Absolute | Jumble | `jumble` | 0..1 | 0.2 |  | yes | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | yes | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | yes | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | yes | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Absolute | Align | `align` | bool | false |  |  | Aligns all children to the same angular position instead of rotating them. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | yes | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  |  | Random variation of the spacing in Density mode. |
| Proportional | Steps per meter | `proportionalCount` | 0..50 (slider 0..10) | 2.5 |  |  | Children per metre in Proportional mode. |
| Interval | Interval | `intervalStep` | 0.02..20 (slider 0.02..3) m | 0.6 |  |  | Distance between children in Interval mode. |
| Interval | Per step | `perStep` | 1..16 | 1 |  |  | Children created at each interval step. |
| Phyllotaxy | Divergence angle | `phyllotaxyAngle` | 0..360 ° | 137.508 |  |  | Rotation between consecutive children (137.5° gives the golden angle). |
| Whorled | Whorls | `whorlCount` | 1..128 | 5 |  |  | Number of whorls (rings of children). |
| Whorled | Per whorl | `whorlPerStep` | 1..128 (slider 1..24) | 4 |  |  | Children per whorl. |
| Whorled | Whorl spread | `whorlSpread` | 0..0.5 | 0.03 |  |  | Random jitter of the children inside a whorl. |
| Whorled | Step roll | `whorlRoll` | -180..180 ° | 15 |  |  | Rotation between consecutive whorls. |
| Bifurcation | Bend threshold | `bifurcationThreshold` | 0.5..90 ° | 6 |  |  | Bend angle above which a bifurcation is placed. |
| Bifurcation | Min spacing | `bifurcationSpacing` | 0.01..0.9 | 0.12 |  |  | Minimum distance between bifurcations. |
| Boundaries | First | `first` | 0..1 | 0.2 |  | yes | Where along the parent the first child may appear (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 0.95 |  | yes | Where along the parent the last child may appear (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0.025 |  | yes | Fraction of the parent at both ends that stays free of children. |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  |  | Enables the clip margins at both ends of the parent. |
| Extend parent | Type | `extendParent` | None / Any / Split 1 / Split 2 | none |  |  | Continues the parent through one of the splits instead of spawning a new child. |
| Extend parent | Count | `extendCount` | 1..8 | 1 |  |  | How many times the parent is extended. |
| Knockout & Limits | Knockout | `knockout` | 0..1 | 0 |  | yes | Randomly removes this fraction of children. |
| Knockout & Limits | Pruning | `pruning` | 0..1 | 0 |  | yes | Removes children that collide with others or leave the crown shape. |
| Knockout & Limits | Sub-generations | `generations` | 1..5 | 1 |  |  | Recursive branching levels evaluated inside this generator (1 = single level). |
| Knockout & Limits | Max generation | `maxGeneration` | 1..16 | 8 |  |  | Maximum hierarchy generation depth allowed for branches. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes |  | Extra rotation (degrees) applied to every child around the parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes |  | Slides every child along the parent by a fixed fraction. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes |  | How deep the base is sunk into the ground (+ variance for placed instances). |
| Common | Active | `active` | bool | true |  | yes | Turns the whole node on or off without deleting it. |
| Common | Seed | `seed` | seed | 0 |  |  | Random seed. Change it to get a different variation of the same settings. |
| Tree placement | Distribution | `distMode` | Parametric / Uniform / Poisson disk / Ring / Grid / Spiral | uniform |  |  | How Number instances fill the Tree disc. Uniform = area-correct random (r = R*sqrt(u)); Poisson disk = blue noise with a minimum distance. |
| Tree placement | Position | `distPosition` | 0..1 | 0.5 | yes |  | Normalised distance from the disc centre (0 = centre, 1 = edge), with variance. |
| Tree placement | Rotation | `distRotation` | 0..1 | 0 | yes |  | Normalised angle around the centre (0..1 = 0..360 degrees), with variance. |
| Tree placement | Min distance | `distMinDistance` | 0..1000 (slider 0..10) m | 0.5 |  |  | Minimum distance between first-generation elements placed on the ground. |
| Tree placement | Splay | `distSplay` | 0..85 ° | 0 |  |  | Outward tilt reached at the disc edge (ferns, bushes). Ignored when Unify child orientation is on. |

### Tab: Spine

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Length | Absolute | `length` | 0.02..500 (slider 0.02..20) m | 3.2 | yes | yes | Length of each child in metres. |
| Length | Relative to parent | `lengthRelative` | bool | false |  |  | Makes the length depend on the length of the parent. |
| Length | + % of parent | `lengthPercent` | 0..2 (slider 0..1) | 0.08 |  | yes | Adds a percentage of the parent length to the absolute length. |
| Length | + % of radius | `lengthPercentRadius` | 0..500 (slider 0..100) | 0 |  |  | Adds this many parent radii to the length. |
| Length | Match one v tile | `matchOneVTile` | Generated / Yes / No | generated |  |  | Yes: the bark texture is stretched so it tiles exactly once along the spine. |
| Length | Shape scale | `shapeScale` | 0..5 (slider 0..2) | 1 |  |  | Multiplies curvature and noise amounts of the spine. |
| Length | Limit length | `lengthLimit` | bool | false |  |  | Prevents children from becoming longer than the parent. |
| Length | Crown envelope | `crownShape` | Natural / Conical / Oval / Vase / Columnar / Custom | natural |  |  | Branch length as a function of the normalised height on the parent: cone (conifer), oval (oak), vase, column or a custom curve. |
| Length | Crown curve | `crownCurve` | curve | curve |  |  | Length multiplier from parent base (0) to tip (1). |
| Clamp | Min | `lengthMin` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no minimum. |
| Clamp | Max | `lengthMax` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no maximum. |
| Orientation | Start angle | `spread` | 0..180 ° | 48 | yes | yes | Angle between the child and its parent (degrees, 0 = parallel). |
| Orientation | Start roll | `startRoll` | -180..180 ° | 0 | yes | yes | Rotation of the child around its own axis at the start. |
| Orientation | Pitch | `pitch` | -90..90 ° | 0 | yes | yes | Tilts the starting direction up or down (degrees). |
| Orientation | Roll | `spineRoll` | -180..180 ° | 0 |  |  | Rotation of the spine around its own axis. |
| Orientation | Alignment | `alignment` | 0..1 | 0.2 |  |  | Rotates children towards the sun / up direction. |
| Orientation | Up / down | `upDown` | -2..2 (slider -1..1) | 0.06 |  | yes | Pushes the growth direction up (+) or down (−) along the length. |
| Orientation | Weld start | `weldStart` | bool | false |  |  | Welds the child base into the parent surface to hide the seam. |
| Shape | Gravity | `gravity` | -2..3 (slider -1..1.5) | 0.16 |  | yes | Bends the child downward (+) or upward (−) under gravity. |
| Shape | Ancestor | `ancestor` | -1..1 | 0 |  | yes | Inherit part of the direction of the grandparent. |
| Shape | Curvature | `curvature` | -2..2 (slider -1..1) | 0.06 | yes | yes | Overall bend of the child along its length. |
| Shape | Straightness | `straightness` | 0..1 | 0.2 |  |  | How strongly the child resists bending; 1 = ruler straight. |
| Shape | Twist | `twist` | -720..720 (slider -180..180) ° | 0 | yes | yes | Adds a rotation around the axis along the path. |
| Parent Curl | Up | `curlUp` | -3..3 (slider -1..1) | 0 |  |  | Curl toward the parent direction (up the parent). |
| Parent Curl | Right | `curlRight` | -3..3 (slider -1..1) | 0 |  |  | Curl sideways relative to the parent. |
| Parent Curl | Out | `curlOut` | -3..3 (slider -1..1) | 0 |  |  | Curl away from the parent axis (negative = toward it). |
| Zigzag | Intensity | `zigzag` | 0..3 (slider 0..1) | 0 |  |  | Alternating bend at every segment (zig-zag stem). |
| Segment length | Absolute | `segments` | 2..512 | 10 |  |  | Number of segments along the spine. |
| Segment length | + Relative | `relativeSegments` | 0..20 (slider 0..4) /m | 0 |  |  | Extra segments scaled by the length of the child. |
| Segment length | Accuracy | `accuracy` | 8..128 | 24 |  |  | Number of sample points used to follow the spine (higher = smoother, slower). |
| Segment length | Optimization | `optimization` | 0..30 ° | 0 |  |  | Curvature-aware adaptive simplification threshold (0 = keep all segments). |
| Radius | Radius | `radius` | 0.001..20 (slider 0.001..0.5) m | 0.06 | yes | yes | Size: the radius of the cross-section at the base (metres), or the range of an effect. |
| Radius | % of parent | `parentRadiusInfluence` | 0..1 | 0.4 |  | yes | Makes the radius a percentage of the parent radius at the attachment point. |
| Radius | Max parent ratio | `parentRadiusMax` | 0.05..1.5 | 0.82 |  |  | Upper limit of the child radius relative to the parent. |
| Radius | Radius profile | `radiusProfile` | curve | curve |  |  | Normalized radius multiplier from base (0) to tip (1). |
| Radius | Taper | `taper` | 0..1 | 0.88 |  | yes | How much the radius shrinks from base to tip (1 = pointed). |
| Radius | Min radius | `minRadius` | 0.0005..1 (slider 0.0005..0.05) m | 0.002 |  |  | Smallest radius the child may reach. |
| Noise | Early amount | `earlyNoiseAmount` | 0..2 (slider 0..0.8) | 0.08 |  | yes | Noise strength near the base of the child. |
| Noise | Early turbulence | `earlyNoiseFrequency` | 0.05..15 (slider 0.05..5) | 1.2 |  |  | Noise frequency near the base of the child. |
| Noise | Amount | `noiseAmount` | 0..5 (slider 0..1.5) | 0.2 |  | yes | Strength of the random wobble along the spine. |
| Noise | Frequency | `noiseFrequency` | 0..20 (slider 0..6) | 1.1 |  |  | How fast the wobble changes along the spine. |
| Noise | Twist | `noiseTwist` | -2..2 (slider -1..1) | 0 |  |  | Rotates the noise as it travels along the spine. |
| Noise | Smooth | `noiseSmooth` | 0..1 | 0 |  |  | Smooths the noise to avoid sharp kinks. |
| Noise | Noise seed | `noiseSeed` | seed | 0 |  |  | Random seed of the noise pattern. |
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken / Fork | taper |  |  | How the tip ends: taper, blunt, broken or forked. |
| Splits & Termination | Split chance | `splitChance` | 0..1 | 0 |  |  | Probability that the spine forks into two. |
| Splits & Termination | Split spread | `splitSpread` | 2..85 ° | 25 |  |  | Angle between the two forks (degrees). |
| Splits & Termination | Split balance | `splitBalance` | 0.15..0.85 | 0.5 |  |  | Share of the radius that goes to the main fork. |
| Splits & Termination | Split position | `splitStart` | 0.15..0.9 | 0.58 |  |  | Position along the spine from which forks may occur. |
| Splits & Termination | Max split depth | `splitMaxDepth` | 1..3 | 1 |  |  | Maximum number of successive forks. |
| Splits & Termination | Break chance | `breakChance` | 0..1 | 0 |  |  | Probability that the spine snaps and ends early. |
| Splits & Termination | Break spot | `breakSpot` | 0.1..0.98 | 0.68 | yes |  | Position along the spine where a break may happen. |
| Prune | General | `pruneGeneral` | 0..1 | 0 |  |  | Removes children by general rules (crown shape). |
| Prune | Interior | `pruneInterior` | 0..1 | 0 |  |  | Removes children pointing into the inside of the crown. |
| Prune | Up | `pruneUp` | 0..1 | 0 |  |  | Removes children pointing upwards. |
| Prune | Down | `pruneDown` | 0..1 | 0 |  |  | Removes children pointing downwards. |
| Prune | Ground plane | `pruneGround` | bool | true |  |  | Removes children that would go below the ground plane. |

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
| Geometry | Sides | `sides` | 3..64 | 8 |  |  | Number of sides of the tube cross-section. Fewer sides = fewer triangles. |
| Geometry | Length segments | `lengthSegments` | 0..512 | 0 |  |  | 0 = use the Spine segments |
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

### Tab: Segments _(not implemented yet - shown disabled)_

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
| Generation | Mode | `mode` | Absolute / Density / Proportional / Interval / Phyllotaxy / Whorled / Bifurcation / Flood | absolute |  |  | How the number and spacing of children are decided (absolute count, density, phyllotaxy, whorls, …). |
| Absolute | Number | `number` | 0..100000 (slider 0..100) | 8 | yes | yes | How many children are created on each parent (or how many stems for a Trunk). Large values are slow. |
| Absolute | Jumble | `jumble` | 0..1 | 0.2 |  | yes | Randomises the order of spacing so children do not form a regular pattern. |
| Absolute | Sweep | `sweep` | 0.01..1 (slider 0.01..1) | 1 |  | yes | Fraction of the full circle the children are spread around the parent. |
| Absolute | Roll | `roll` | -1..1 | 0 |  | yes | Rotates children around the parent axis (−1…1 = a full turn each way). |
| Absolute | Favor splits | `favorSplits` | -1..1 | 0 |  | yes | Prefers (+) or avoids (−) placing children on split points. |
| Absolute | Align style | `alignStyle` | Group / Individual / Spiral / Alternate / Opposite | group |  |  | How the rotation of consecutive children is arranged: group, individual, spiral, alternate or opposite. |
| Absolute | Align | `align` | bool | false |  |  | Aligns all children to the same angular position instead of rotating them. |
| Density | Density | `density` | 0..100 (slider 0..10) /m | 1.5 |  | yes | Children per metre of parent length (Density mode). |
| Density | Jitter | `densityJitter` | 0..1 | 0.2 |  |  | Random variation of the spacing in Density mode. |
| Proportional | Steps per meter | `proportionalCount` | 0..50 (slider 0..10) | 2.5 |  |  | Children per metre in Proportional mode. |
| Interval | Interval | `intervalStep` | 0.02..20 (slider 0.02..3) m | 0.6 |  |  | Distance between children in Interval mode. |
| Interval | Per step | `perStep` | 1..16 | 1 |  |  | Children created at each interval step. |
| Phyllotaxy | Divergence angle | `phyllotaxyAngle` | 0..360 ° | 137.508 |  |  | Rotation between consecutive children (137.5° gives the golden angle). |
| Whorled | Whorls | `whorlCount` | 1..128 | 5 |  |  | Number of whorls (rings of children). |
| Whorled | Per whorl | `whorlPerStep` | 1..128 (slider 1..24) | 4 |  |  | Children per whorl. |
| Whorled | Whorl spread | `whorlSpread` | 0..0.5 | 0.03 |  |  | Random jitter of the children inside a whorl. |
| Whorled | Step roll | `whorlRoll` | -180..180 ° | 15 |  |  | Rotation between consecutive whorls. |
| Bifurcation | Bend threshold | `bifurcationThreshold` | 0.5..90 ° | 6 |  |  | Bend angle above which a bifurcation is placed. |
| Bifurcation | Min spacing | `bifurcationSpacing` | 0.01..0.9 | 0.12 |  |  | Minimum distance between bifurcations. |
| Boundaries | First | `first` | 0..1 | 0.15 |  | yes | Where along the parent the first child may appear (0 = base, 1 = tip). |
| Boundaries | Last | `last` | 0..1 | 0.95 |  | yes | Where along the parent the last child may appear (0 = base, 1 = tip). |
| Boundaries | Distribution curve | `distributionCurve` | curve | curve |  |  | Maps normalized spacing [0..1] across [First..Last]. |
| Boundaries | Clip | `clip` | 0..0.49 | 0.025 |  | yes | Fraction of the parent at both ends that stays free of children. |
| Boundaries | Clip enabled | `clipEnabled` | bool | false |  |  | Enables the clip margins at both ends of the parent. |
| Extend parent | Type | `extendParent` | None / Any / Split 1 / Split 2 | none |  |  | Continues the parent through one of the splits instead of spawning a new child. |
| Extend parent | Count | `extendCount` | 1..8 | 1 |  |  | How many times the parent is extended. |
| Knockout & Limits | Knockout | `knockout` | 0..1 | 0 |  | yes | Randomly removes this fraction of children. |
| Knockout & Limits | Pruning | `pruning` | 0..1 | 0 |  | yes | Removes children that collide with others or leave the crown shape. |
| Knockout & Limits | Sub-generations | `generations` | 1..5 | 1 |  |  | Recursive branching levels evaluated inside this generator (1 = single level). |
| Knockout & Limits | Max generation | `maxGeneration` | 1..16 | 8 |  |  | Maximum hierarchy generation depth allowed for branches. |
| Common | Rotation | `rotationOffset` | -180..180 ° | 0 | yes |  | Extra rotation (degrees) applied to every child around the parent. |
| Common | Position | `positionOffset` | -0.5..0.5 | 0 | yes |  | Slides every child along the parent by a fixed fraction. |
| Common | Sink | `sink` | -5..5 (slider -1..1) m | 0 | yes |  | How deep the base is sunk into the ground (+ variance for placed instances). |
| Common | Active | `active` | bool | true |  | yes | Turns the whole node on or off without deleting it. |
| Common | Seed | `seed` | seed | 0 |  |  | Random seed. Change it to get a different variation of the same settings. |
| Tree placement | Distribution | `distMode` | Parametric / Uniform / Poisson disk / Ring / Grid / Spiral | uniform |  |  | How Number instances fill the Tree disc. Uniform = area-correct random (r = R*sqrt(u)); Poisson disk = blue noise with a minimum distance. |
| Tree placement | Position | `distPosition` | 0..1 | 0.5 | yes |  | Normalised distance from the disc centre (0 = centre, 1 = edge), with variance. |
| Tree placement | Rotation | `distRotation` | 0..1 | 0 | yes |  | Normalised angle around the centre (0..1 = 0..360 degrees), with variance. |
| Tree placement | Min distance | `distMinDistance` | 0..1000 (slider 0..10) m | 0.5 |  |  | Minimum distance between first-generation elements placed on the ground. |
| Tree placement | Splay | `distSplay` | 0..85 ° | 0 |  |  | Outward tilt reached at the disc edge (ferns, bushes). Ignored when Unify child orientation is on. |

### Tab: Spine

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Length | Absolute | `length` | 0.02..500 (slider 0.02..20) m | 1.8 | yes | yes | Length of each child in metres. |
| Length | Relative to parent | `lengthRelative` | bool | false |  |  | Makes the length depend on the length of the parent. |
| Length | + % of parent | `lengthPercent` | 0..2 (slider 0..1) | 0.08 |  | yes | Adds a percentage of the parent length to the absolute length. |
| Length | + % of radius | `lengthPercentRadius` | 0..500 (slider 0..100) | 0 |  |  | Adds this many parent radii to the length. |
| Length | Match one v tile | `matchOneVTile` | Generated / Yes / No | generated |  |  | Yes: the bark texture is stretched so it tiles exactly once along the spine. |
| Length | Shape scale | `shapeScale` | 0..5 (slider 0..2) | 1 |  |  | Multiplies curvature and noise amounts of the spine. |
| Length | Limit length | `lengthLimit` | bool | false |  |  | Prevents children from becoming longer than the parent. |
| Length | Crown envelope | `crownShape` | Natural / Conical / Oval / Vase / Columnar / Custom | natural |  |  | Branch length as a function of the normalised height on the parent: cone (conifer), oval (oak), vase, column or a custom curve. |
| Length | Crown curve | `crownCurve` | curve | curve |  |  | Length multiplier from parent base (0) to tip (1). |
| Clamp | Min | `lengthMin` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no minimum. |
| Clamp | Max | `lengthMax` | 0..500 (slider 0..20) m | 0 |  |  | 0 = no maximum. |
| Orientation | Start angle | `spread` | 0..180 ° | 42 | yes | yes | Angle between the child and its parent (degrees, 0 = parallel). |
| Orientation | Start roll | `startRoll` | -180..180 ° | 0 | yes | yes | Rotation of the child around its own axis at the start. |
| Orientation | Pitch | `pitch` | -90..90 ° | 0 | yes | yes | Tilts the starting direction up or down (degrees). |
| Orientation | Roll | `spineRoll` | -180..180 ° | 0 |  |  | Rotation of the spine around its own axis. |
| Orientation | Alignment | `alignment` | 0..1 | 0.2 |  |  | Rotates children towards the sun / up direction. |
| Orientation | Up / down | `upDown` | -2..2 (slider -1..1) | 0.05 |  | yes | Pushes the growth direction up (+) or down (−) along the length. |
| Orientation | Weld start | `weldStart` | bool | false |  |  | Welds the child base into the parent surface to hide the seam. |
| Shape | Gravity | `gravity` | -2..3 (slider -1..1.5) | 0.12 |  | yes | Bends the child downward (+) or upward (−) under gravity. |
| Shape | Ancestor | `ancestor` | -1..1 | 0 |  | yes | Inherit part of the direction of the grandparent. |
| Shape | Curvature | `curvature` | -2..2 (slider -1..1) | 0.06 | yes | yes | Overall bend of the child along its length. |
| Shape | Straightness | `straightness` | 0..1 | 0.2 |  |  | How strongly the child resists bending; 1 = ruler straight. |
| Shape | Twist | `twist` | -720..720 (slider -180..180) ° | 0 | yes | yes | Adds a rotation around the axis along the path. |
| Parent Curl | Up | `curlUp` | -3..3 (slider -1..1) | 0 |  |  | Curl toward the parent direction (up the parent). |
| Parent Curl | Right | `curlRight` | -3..3 (slider -1..1) | 0 |  |  | Curl sideways relative to the parent. |
| Parent Curl | Out | `curlOut` | -3..3 (slider -1..1) | 0 |  |  | Curl away from the parent axis (negative = toward it). |
| Zigzag | Intensity | `zigzag` | 0..3 (slider 0..1) | 0 |  |  | Alternating bend at every segment (zig-zag stem). |
| Segment length | Absolute | `segments` | 2..512 | 8 |  |  | Number of segments along the spine. |
| Segment length | + Relative | `relativeSegments` | 0..20 (slider 0..4) /m | 0 |  |  | Extra segments scaled by the length of the child. |
| Segment length | Accuracy | `accuracy` | 8..128 | 24 |  |  | Number of sample points used to follow the spine (higher = smoother, slower). |
| Segment length | Optimization | `optimization` | 0..30 ° | 0 |  |  | Curvature-aware adaptive simplification threshold (0 = keep all segments). |
| Radius | Radius | `radius` | 0.001..20 (slider 0.001..0.5) m | 0.02 | yes | yes | Size: the radius of the cross-section at the base (metres), or the range of an effect. |
| Radius | % of parent | `parentRadiusInfluence` | 0..1 | 0.4 |  | yes | Makes the radius a percentage of the parent radius at the attachment point. |
| Radius | Max parent ratio | `parentRadiusMax` | 0.05..1.5 | 0.82 |  |  | Upper limit of the child radius relative to the parent. |
| Radius | Radius profile | `radiusProfile` | curve | curve |  |  | Normalized radius multiplier from base (0) to tip (1). |
| Radius | Taper | `taper` | 0..1 | 0.9 |  | yes | How much the radius shrinks from base to tip (1 = pointed). |
| Radius | Min radius | `minRadius` | 0.0005..1 (slider 0.0005..0.05) m | 0.002 |  |  | Smallest radius the child may reach. |
| Noise | Early amount | `earlyNoiseAmount` | 0..2 (slider 0..0.8) | 0.08 |  | yes | Noise strength near the base of the child. |
| Noise | Early turbulence | `earlyNoiseFrequency` | 0.05..15 (slider 0.05..5) | 1.2 |  |  | Noise frequency near the base of the child. |
| Noise | Amount | `noiseAmount` | 0..5 (slider 0..1.5) | 0.12 |  | yes | Strength of the random wobble along the spine. |
| Noise | Frequency | `noiseFrequency` | 0..20 (slider 0..6) | 1.1 |  |  | How fast the wobble changes along the spine. |
| Noise | Twist | `noiseTwist` | -2..2 (slider -1..1) | 0 |  |  | Rotates the noise as it travels along the spine. |
| Noise | Smooth | `noiseSmooth` | 0..1 | 0 |  |  | Smooths the noise to avoid sharp kinks. |
| Noise | Noise seed | `noiseSeed` | seed | 0 |  |  | Random seed of the noise pattern. |
| Splits & Termination | Tip behavior | `termination` | Taper / Blunt / Broken / Fork | taper |  |  | How the tip ends: taper, blunt, broken or forked. |
| Splits & Termination | Split chance | `splitChance` | 0..1 | 0 |  |  | Probability that the spine forks into two. |
| Splits & Termination | Split spread | `splitSpread` | 2..85 ° | 25 |  |  | Angle between the two forks (degrees). |
| Splits & Termination | Split balance | `splitBalance` | 0.15..0.85 | 0.5 |  |  | Share of the radius that goes to the main fork. |
| Splits & Termination | Split position | `splitStart` | 0.15..0.9 | 0.58 |  |  | Position along the spine from which forks may occur. |
| Splits & Termination | Max split depth | `splitMaxDepth` | 1..3 | 1 |  |  | Maximum number of successive forks. |
| Splits & Termination | Break chance | `breakChance` | 0..1 | 0 |  |  | Probability that the spine snaps and ends early. |
| Splits & Termination | Break spot | `breakSpot` | 0.1..0.98 | 0.68 | yes |  | Position along the spine where a break may happen. |
| Prune | General | `pruneGeneral` | 0..1 | 0 |  |  | Removes children by general rules (crown shape). |
| Prune | Interior | `pruneInterior` | 0..1 | 0 |  |  | Removes children pointing into the inside of the crown. |
| Prune | Up | `pruneUp` | 0..1 | 0 |  |  | Removes children pointing upwards. |
| Prune | Down | `pruneDown` | 0..1 | 0 |  |  | Removes children pointing downwards. |
| Prune | Ground plane | `pruneGround` | bool | true |  |  | Removes children that would go below the ground plane. |

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
| Geometry | Sides | `sides` | 3..64 | 6 |  |  | Number of sides of the tube cross-section. Fewer sides = fewer triangles. |
| Geometry | Length segments | `lengthSegments` | 0..512 | 0 |  |  | 0 = use the Spine segments |
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

### Tab: Segments _(not implemented yet - shown disabled)_

### Tab: Physics _(not implemented yet - shown disabled)_

### Tab: Hand Drawn

| Section | Parameter | id | Range | Default | Var | Curve | Meaning |
|---|---|---|---|---|---|---|---|
| Hand drawn | Enabled | `handDrawn` | bool | false |  |  | Enables hand-drawn control of the spine shape. |
| Hand drawn | Strength | `handStrength` | 0..1 | 1 |  |  | Strength of the hand-drawn influence. |
| Hand drawn | Smoothing | `handSmoothing` | 0..1 | 0.5 |  |  | Smoothing of the hand-drawn spine. |
