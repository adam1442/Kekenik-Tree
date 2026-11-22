# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Generation modes for every generator (Trunk, Branch, Root, Spine, Leaf, Batched Leaf, Mesh Instance, Cap, Cluster): Absolute, Proportional, Absolute steps / Proportional steps (Steps, Per step, Spread, Roll, Balance), Phyllotaxy (Internode length in metres from Last towards First; Style Opposite distichous / decussate / random, Alternating distichous / random, Whorled; Children per node, Spread, Spiral, Limit, Align style), Interval (Frequency with a profile curve, Count, Spread, Spiral, Limit, Align style, Balance), Bifurcation (Count, Threshold, Spread), Flood and Parent. Only the parameters of the chosen mode are shown; *Classic* is listed as a disabled legacy entry. The layouts live in the pure module `src/generators/modes/` and every node publishes its `side` (+1 / -1) and `groupIndex`.

### Changed
- Old projects are migrated on load: `whorled` is now Absolute steps, the golden-angle Phyllotaxy becomes Alternating (distichous) with a Spiral, Bifurcation keeps its count. Built-in presets use the new parameters. Absolute mode now also publishes a `side` attribute (derived from the roll).

### Fixed
- Edit Mesh dialog, shared dialog buttons/footers (info, prompt, choice, Export, LOD editor) and a few inspector widgets were missing their stylesheet rules in the published build; the rules now live in `ui/theme/editmesh.css` and `panels.css`.

### Added
- Frond *Left-Right Variance* (Amount, Seed: each half reacts independently to Curl, Fold and Gravity) and *Section Variance* (Favor Outliers; Amount / Offset for Gravity, Fold, Curl and Roll per mesh section painted in the cutout editor).
- Frond *Lighting* tab: Style Global / Local, Smooth, Alignment, Spread, Parent puffiness (Anchor incl. the new *Origin*, Amount) and Up / Right / Out adjustments, built on `applyLeafLighting`.
- Frond wind: Weight (curve), Cross, Boost (curve) and Ribs (Apply branch wind, Weight), written into the existing per-vertex wind weights; the base stays static.

### Changed
- Frond generator rebuilt on ribs: a left and a right rib runs across the parent spine at every length segment, and the cutout mesh of the assigned material (or a plain ribbon) is mapped onto them. The length always comes from the parent spine. New Shape tab (Unification, Height: Amount / Offset / Gravity / Fold / Curl / Roll, Boundary: Start / End, Scale: Width / Height), Segments tab (Accuracy, Width: Absolute / + Relative), Forces tab (Gravity, Up / Down, Ancestor with strength curves, Align) and Material: Flip, Two sided, Mesh Index / Resolution. Older Frond graphs and the built-in presets are migrated automatically (the old Droop becomes the Gravity force; Arch, Twist, Crease, Sink and length scaling were dropped).

### Added
- Leaf generator *Lighting* tab: Style (Global / Local) and a normal-editing pass run after deformation (Smooth, Parent puffiness with Global / Deep / Intermediate / Local / None / Height / Surface X-Y-Z anchors, Anchor shift, Puffiness, Unify, Up / Right / Out adjustments with variance, World up). Global style reads a shared group on the Tree node (new *Lighting* tab). The pass is `applyLeafLighting` (reusable by the Frond). The old Spherize / Bend controls did nothing and were removed.
- *Batched Leaf* node: the Leaf evaluator without Mesh LOD offset, vertex-noise Seed, Unify and World up, always at the highest detail, merged into one slot per material (`mergeByMaterial`) with an index table (`MeshData.parts`) that resolves every triangle back to its source leaf.
- Leaf generator *Leaves* tab: Use actual size, Size (curve + variance) and +% of parent, Weld / Keep failed welds, Cross, Fix winding, Flip with Classic / Synchronized initial orientation, the Type list, Local orientation (3D anchor style, Unification, Sky influence, Fold, Align, Face), Sensitivity → Parent (Amount, Anchor, Sky) and Final adjustments (Up, Right, Out). Interval / Phyllotaxy placement now publishes a per-branch `side` attribute and generators publish ancestor chains for the Global / Deep / Intermediate / Local anchors. The old Skin › Size *Scale* is migrated to *Size*; the Type list moved from Material › Leaves to Leaves › Type.
- Leaf generator *Deformation* tab (Height from the material Height map, Fold, Curl, Twist, Vertex Amount / Noise / Seed, Scale X / Y / Z; curves and variance) and *Resolution* tab (Size increase % curve, Mesh LOD curve, Mesh LOD offset). The pivot stays fixed, attachment anchors follow the deformed leaf, sparse meshes are subdivided at high detail, and the viewport LOD selector switches mesh versions and sizes live. Defaults reproduce the previous result.
- A material can own several cutout meshes (`MaterialDef.meshes`, first = Primary). The Materials panel *Cutouts/Meshes* tab lists them with thumbnails, a Primary badge, move up/down, duplicate, delete, per-mesh Edit mesh… and a preview of the selected mesh. Older projects migrate automatically.
- `MaterialSlotList` widget (Material / Mesh / Weight rows with pick probabilities, Material Sets, Any / Primary / Not primary) for Leaf, Frond, Decoration, Cluster and Mesh Instance; Frond uses the chosen cutout mesh instead of the ribbon, Mesh Instance mixes meshes per instance.
- `npm run build:check` / `scripts/check-built-css.mjs`: post-build guard that verifies the built CSS against `scripts/css-contract.json`; runs in the CI, deploy and release workflows.

## [1.0.0] - 2026-11-13

Initial public release.

### Added
- Node-based procedural plant generation with live, cached and cancellable evaluation, undo/redo, node templates, autosave and crash recovery.
- Generators: Trunk, Branch, Root, Spine, Frond, Leaf, Cap, Decoration and Mesh, with Split, Knot and Cluster helpers; per-parameter variance and curves along the parent.
- Forces (gravity, directional, phototropism, attractor, vortex, turbulence, curl and more) and hierarchical GPU wind with a timeline.
- Materials with texture maps, material sets, masks, alpha-coverage mips and viewport quality options (MSAA, SMAA, TAA, FXAA).
- Cutout / mesh editor with outlines, straighten axes, attachment anchors and LOD meshes.
- Curve and color-ramp editor with presets, tangent modes and a freehand draw tool.
- Height-map displacement of generated branches.
- LOD editor with viewport preview.
- Export to GLB, glTF, OBJ, PLY and STL with LODs, baked ambient occlusion and billboard impostors.
- Dockable, tabbable and floating panels with saved layouts; instance-level Node mode.
- Species library of 16 presets, user presets and `.ktree` project import/export.
- Welcome screen, interactive tour, keyboard shortcut sheet and preferences (UI scale, navigation scheme, autosave, performance mode).
- GitHub Actions for CI, GitHub Pages deployment and tagged releases.

[Unreleased]: https://github.com/adam1442/Kekenik-Tree/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/adam1442/Kekenik-Tree/releases/tag/v1.0.0
