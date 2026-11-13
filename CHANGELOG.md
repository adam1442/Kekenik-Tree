# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
