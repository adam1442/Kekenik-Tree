# Kekenik Tree — Export specification

Everything here is produced by `src/export/`. The writers are DOM-free and unit-tested (`tests/export*.test.ts`).

## 1. Coordinate system, units, handedness
The scene is right-handed, **Z-up, metres**. The export transform (`src/export/transform.ts`) is applied to positions,
normals, tangents and wind pivots before writing:

| Setting | Matrix (row-major 3x3) |
|---|---|
| Z-up, right-handed | identity |
| Y-up, right-handed (glTF default) | `(x, y, z) -> (x, z, -y)` |
| left-handed | first row negated (mirror X); triangle winding is reversed to keep faces outward; tangent `w` is negated |

Positions are multiplied by `unitScale * extraScale` (`m 1`, `cm 100`, `mm 1000`, `in 39.3701`, `ft 3.28084`); directions are not scaled.
glTF itself is defined as Y-up / right-handed: other choices are baked into the data and recorded in
`asset.extras.kekenik` (`upAxis`, `handedness`, `metersPerUnit`). The same values are in `<name>.kekenik.json`.

## 2. Formats
| Format | Files | Notes |
|---|---|---|
| **GLB** | `<name>.glb` | Default. Embedded textures. |
| **glTF** | `<name>.gltf`, `<name>.bin`, optional `textures/*` | Textures as data URIs, or files when "Write as separate files" is on. |
| **OBJ + MTL** | `<name>_LOD<n>.obj/.mtl`, `textures/*` | `v x y z r g b` colour extension when vertex colours are on. UV origin bottom-left (as authored). Maps: `map_Kd` (albedo, alpha merged), `map_d` (cut-outs), `map_Bump` (normal). |
| **PLY** | `<name>_LOD<n>.ply` | Binary little-endian: xyz, normal, st, rgba (uchar), faces with `material_index` (order listed in the header comment). |
| **STL** | `<name>_LOD<n>.stl` | Binary, geometry only. |
| FBX | — | **Not implemented.** A binary FBX writer cannot be verified without an FBX importer in this environment. Use GLB. |

Several files (textures, atlases, metadata, impostor) are always bundled into `<name>.zip` (`fflate`; images stored, text deflated), laid out as `<name>/<file>`.

## 3. glTF details
* **UVs:** Kekenik UVs have a bottom-left origin; the writer writes `v' = 1 - v` and keeps the image in its original orientation.
* **Indices:** `UNSIGNED_SHORT` when the mesh has <= 65535 vertices, else `UNSIGNED_INT`.
* **Meshes:** "One merged mesh" (default) or "one mesh per graph node"; one primitive per material (shared vertex accessors). GPU-instanced leaves are expanded.
* **LODs:** *One file, LOD nodes*: root nodes `<name>_LOD0 … <name>_LODn` (all in the scene; `extras.kekenik = { lod, transition, triangles, vertices, drawCalls }`),
  or *one file per LOD*. `MSFT_lod` is deliberately not used (most importers drop the lower LODs).
* **Custom vertex attributes** (when "Custom attributes" is on; application-specific `_` names):

| Attribute | Type | Meaning |
|---|---|---|
| `_WIND_PIVOT` | VEC3 float | Pivot the vertex rotates around (export space, scaled). |
| `_WIND_WEIGHTS` | VEC4 float | `(level0 trunk, level1 branch, level2 twig/leaf, phase)`, all 0..1. `phase` drives the level-2 / leaf terms. |
| `_WIND_PHASE1` | SCALAR float | Phase (0..1) of the level-1 ancestor; drives the branch-level sway terms, identical on a parent point and every child that grows from it. Missing in older files: use `_WIND_WEIGHTS.w`. |
| `_AO` | SCALAR float | Ambient occlusion 0 = occluded … 1 = open (generator estimate x optional bake). |
| `_BLEND` | SCALAR float | Junction material blend (weld, extension, split half; only written when a mesh has one): 0 = parent material / no blend … 1 = the vertex's own material. |

  Standard attributes: `POSITION`, `NORMAL`, `TEXCOORD_0`, `TEXCOORD_1` (if present), `TANGENT` (if present), `COLOR_0` (RGBA float, includes baked AO).
  Per-vertex cut-out *paint* data (mask / section ids) lives on the 2D cut-out definition, not on generated meshes, so it is not exported.
* **Materials** (`pbrMetallicRoughness`): base colour factor (sRGB -> linear), `alphaMode` = `MASK` for cut-outs (`alphaCutoff` = project Alpha Threshold),
  `BLEND` for a plain opacity constant < 1, else `OPAQUE`; `doubleSided` = two-sided or has a Back material; `normalTexture.scale`; `occlusionTexture.strength` = AO constant.
  * Colour + Opacity are merged into one RGBA albedo (the opacity channel is auto-detected, same rule as the viewport).
  * **ORM packing:** R = AO, G = roughness (`1 - gloss`, constant multiplied in), B = metalness; the same image is used for `occlusionTexture` and `metallicRoughnessTexture`.
    With packing "None", AO is exported on its own and Gloss / Metallic maps become extra images (see below).
  * Image size = `min(material Max res, export Max size)`, never upsampled. JPG is only used for opaque maps (others fall back to PNG).
    PNG is written by an in-house encoder so the colour of transparent texels (dilation / padding) survives.
* **Extensions** (listed in `extensionsUsed` only when needed): `KHR_materials_specular` (non-white Specular colour), `KHR_texture_transform` (impostor frames),
  `EXT_texture_webp` (also in `extensionsRequired`). Not implemented: `KHR_mesh_quantization`, KTX2 / Basis (convert the PNGs with `toktx` if needed).
* **`material.extras.kekenik`:**
  ```json
  { "id": "leaf", "twoSided": true, "backMaterial": {"id": "...", "spacing": 0.001} | null,
    "variations": { "colors": [[r,g,b,a] x3], "amount": 0.5 }, "season": <Curve> | null,
    "atlas": { "scale": 1, "handling": "default", "name": "" }, "maxResolution": 1024 | null, "userData": "",
    "slots": { "custom": {"scalar": 0.4, "image": 3}, "custom2": {}, "specular": {}, "subsurface": {},
               "subsurfacePercent": {}, "height": {}, "gloss": {}, "metallic": {} } }
  ```
  `image` is an index into `images[]`. Season curves use the `Curve` JSON of `src/core/curve`.
* **`asset.extras.kekenik`:** `{ version, name, units, metersPerUnit, upAxis, handedness, seed, lods: [...], wind, attributes }`.
  `wind` is the project Wind settings (`enabled, directionDeg, strength, gustiness, frequency, params`).

## 4. LOD generation (`src/export/lod/`)
Per level (`LodLevelSettings`):
1. **Generator detail 0..3** — the graph is re-evaluated with `ctx.lod` (fewer radial sides / segments; the per-node LOD curves and "Active" curves decide which generators run).
2. **Min branch size %** — bark pieces (connected components) whose bounding diagonal is below the percentage of the plant height are removed.
3. **Foliage %** — leaf / frond / decal / fin / knot / mesh / cluster pieces are thinned with a deterministic per-piece rank (nested subsets: a lower % is always a subset); GPU-instanced payloads are subset by instance.
4. **Keep area** — kept pieces are enlarged by `1/sqrt(keptFraction)` (max 3x) about their base (lowest-v vertices), preserving the silhouette coverage.
5. **Triangle budget** — the foliage keep fraction is lowered further to fit the budget.
6. **Switch at %** — screen-height fraction (`plantHeight / (2 d tan(fov/2))`) at or below which the LOD is used; strictly decreasing, LOD0 = 100 %.

### 4.1 Dynamic LOD (Tree > LOD, `src/lod/dynamic/`)
When Tree > LOD > **Enable** is on, the classic per-level thinning above is replaced by the Dynamic LOD transform:
- **Levels**: the level count is Tree > Levels (default 4); level `k` of `n` is the Dynamic LOD value `k / (n - 1)` (level 0 = the unmodified mesh). The generator detail (`engineLod`) and Switch-at values of the export LOD list still apply (new levels continue the series).
- **Importance analysis** (`analysis.ts`, pure): every leaf card / branch tube / decoration (mesh component or GPU instance) is a node. Exposure = mean transmittance over 26 probe rays through a density grid of all nodes (interior = low). Survival rank per family = exposure (branches: 40 % exposure + 60 % size percentile) + `(Weight - 0.5) x 1.5` of the producing generator + a seeded tie-break.
- **Continuous evaluation** (`apply.ts`): the kept share of a family comes from its curve (Branches / Leaves / Fronds / Decorations; x = LOD value, y = kept share). A node shrinks from 1 to 0 while the kept share sweeps over its rank (band 0.25), so the scale is continuous in the value; nodes at 0 lose their triangles. Branch vertices shrink towards their ring centre (spine), other pieces towards their attachment point (the per-vertex *LOD anchor*). Leaves / fronds that stay grow by sqrt(total area / alive area) x Grow scale (max 3x).
- **Export**: compact meshes (removed vertices dropped). `<name>.kekenik.json` gets `dynamicLod.levels[]` (value, triangles, interiorRemovedShare) and `lods[]` entries carry `dynamicLodValue`, `removedTriangles`, `interiorRemovedShare` (share of the removed triangles that belonged to interior nodes, exposure < 0.3). The export dialog lists the same numbers after the export. The billboard impostor (Impostor tab) is written after the geometry levels, i.e. it stays the last level.
- **Viewport**: toolbar LOD popover (Enable, Screen area, LOD value, live triangles) and a corner indicator; `LodPreview.setDynamic` overrides the Tree settings without re-evaluating the graph. Screen-area mode maps the bounding-sphere coverage of the viewport height (0.9 -> value 0, 0.04 -> value 1, logarithmic).

LOD settings are stored in `localStorage` (`kekenik.export.lods`), not in the project file (a known limitation).
Viewport preview: `LODs` panel (Window menu) — Off / Auto (camera distance or simulated distance) / fixed LOD; `LodPreview.resolve()` is consulted by the viewport.

## 5. Baking
* **AO → vertices:** voxel density grid (64³) + cosine-weighted hemisphere marching in a worker (main-thread fallback, time-sliced, cancellable). Written to `_AO`
  and, per mode, multiplied into / replacing `COLOR_0`. It is an estimate, not a ray-traced bake.
* **Texture AO baking** is not implemented (the imported AO map is exported through ORM).

## 6. Impostors / billboards (`src/export/impostor/`)
WebGL, orthographic, 2x supersampled, 3 passes per view. Files: `<name>_impostor_albedo.png`, `_normal.png`, `_depth.png`, `<name>_impostor.json`, plus `<name>_impostor.glb/.obj/…` with the quad mesh(es).
* Camera: at `2 * radius` from the bounding-sphere centre, azimuth `0..360` counter-clockwise seen from above in the source (Z-up) frame (0 = camera on +X); the optional last frame is top-down (up = +Y).
* Atlas: `cols = min(frames, 4)`, row-major from the top-left; `uvTopLeft` of each frame is a `KHR_texture_transform` (`offset`, `scale`).
* Albedo: sRGB RGBA, colour dilated under transparent texels by `padding`. Normal: `rgb = n * 0.5 + 0.5` in **export** object space, alpha = coverage. Depth: `R = 1 - linearDepth` over `[centre - radius, centre + radius]`.
* `Impostor` = one quad with frame 0; `Cross billboard` = two crossed double-sided quads using the frames at 0 / 90 degrees (views should be a multiple of 4). OBJ has no texture transform: the frame rectangle is baked into the UVs.

## 7. `<name>.kekenik.json`
`{ format: "kekenik-export", version, name, exportedAt, seed, settings, transform, lods[], materials[], wind { project, sceneWindNode, perNode[] }, windAudit, windAuditLods[], lightmap, vTiling { enabled, entries[] }, packing { packer, forceTextures, materials[] }, impostor, warnings }`.

## 8. Verification
After writing a glTF / GLB the exporter re-reads it: nodes, meshes, triangles, vertices, materials and images are recomputed from the accessors and compared with what the writer received;
GLB files are also imported with three.js `GLTFLoader` and the triangle count is compared. Differences become warnings in the dialog.

## 9. Real-time parity (T18)

### 9.1 Wind data for a game shader and the seam audit
With "Custom attributes" on, every primitive carries (see section 3): `_WIND_PIVOT` (VEC3), `_WIND_WEIGHTS` (VEC4 = trunk w0, branch w1, leaf w2, phase of the level-2 / leaf terms), `_WIND_PHASE1` (SCALAR, the level-1 ancestor phase: identical on a parent point and every child that grows from it).
A reference GLSL snippet (the same model as the viewport; `describeWindRuntime()` in `src/viewport/wind/windExport.ts` returns the exact source) for a vertex shader:

```glsl
attribute vec3 _WIND_PIVOT;     // glTF custom attributes keep their names in three.js / most importers
attribute vec4 _WIND_WEIGHTS;   // x trunk, y branch, z leaf, w phase (level 2)
attribute float _WIND_PHASE1;   // phase of the level-1 ancestor (branch sway)
uniform vec4 uWindA;            // xy = direction (export space), z = strength, w = time
vec3 ktWind(vec3 p) {
  float sway0 = sin(uWindA.w * 0.6) * _WIND_WEIGHTS.x;                  // trunk: whole plant leans
  float sway1 = sin(uWindA.w * 1.4 + 6.2831853 * _WIND_PHASE1) * _WIND_WEIGHTS.y; // branches: share the ancestor phase
  float flut  = sin(uWindA.w * 4.0 + 6.2831853 * _WIND_WEIGHTS.w) * _WIND_WEIGHTS.z;   // leaves around their pivot
  vec3 d = vec3(uWindA.xy, 0.0) * uWindA.z;
  vec3 off = d * (sway0 * p.z * 0.02 + sway1 * 0.03) + cross(vec3(0.0, 0.0, 1.0), p - _WIND_PIVOT) * flut * 0.05;
  return p + off;
}
```
Because a parent point and the child that grows from it share `w0 / w1 / phase1`, the displacement is identical there and the mesh does not tear.
**Seam audit:** the exporter runs the T03 audit (`src/viewport/wind/windAudit.ts`) on the export pieces of every exported LOD (CPU reference wind, strength at least 1, 4 sample times). The result (`windAudit` = the first LOD, `windAuditLods[] = { lod, audit }` for all of them, in `<name>.kekenik.json` and in the dialog report) holds `maxDisplacement`, the largest gap of coincident vertices and of touching vertices of different generators, the threshold (`1e-3 x plant height`; contact pairs get 4x) and `ok`. Above the threshold a warning is added. Plants above 600 000 vertices skip the audit (reported).

### 9.2 Texture packer (`src/export/packing/`)
A packer is data: `{ id, label, textures: [{ suffix, label, r, g, b, a: { source?, channel?, invert?, value }, srgb, mip: { alphaIsOpacity, rgbIsNormal } }] }`. Sources: `color, opacity, normal, height, ao, gloss, roughness, metallic` (roughness and gloss are derived from each other, `1 - x`). A channel without a map uses the material slot constant (`value` otherwise).
Presets: **Kekenik default** (`basecolor` = colour RGB + opacity A, `normal` = normal RGB + height A, `orm` = AO / roughness / metalness), **Unity URP** (`BaseMap`, `BumpMap`, `MetallicGloss` = metallic R + smoothness A, `Occlusion` = AO in G), **Unreal** (`BaseColor`, `Normal` with the green channel flipped for DirectX, `ORM`). `legacy` (default) = no extra textures (earlier behaviour).
`forceTextures`: false = a texture whose channels are all constants is not written, the constants are listed under `packing.materials[].constants`; true = a 4 x 4 texture is written. Mip flags (`mips` are built for engines that need them; glTF carries only level 0): `rgbIsNormal` uses `src/textures/normalMips.ts` (average decoded vectors, renormalise), `alphaIsOpacity` uses `buildCoverageMipChain` (alpha-test coverage kept, cut-off remapped to 0.5). Files: `textures/<material>_<suffix>.png` (level 0 only) or, with *Packed format = DDS* (`textures.packedFormat`, default `png`), `textures/<material>_<suffix>.dds`: an uncompressed RGBA8 DDS (`src/export/images/ddsWriter.ts`, byte order R G B A) that holds the whole mip chain built with the def's flags, so AlphaIsOpacity / RgbIsNormal reach the engine; `mipLevels` in the metadata is the stored level count.

### 9.3 V-tiling, UV seams, atlas handling
* **V-tiling** (export option, `src/export/atlas/vTiling.ts`): every primitive whose V range exceeds 1 is moved to start at V = 0 and stretched to the nearest whole number of repeats `n` (V' runs 0 .. n, so top and bottom touch the cell edges; a shader samples `fract(V')` inside the atlas cell). Untiled primitives, primitives that share vertices with another material, and materials with Atlas handling = Force out are not touched. The report lists `repeats`, `stretch`, the U tile count (`uMax - uMin`, a fractional count adds a warning) and the V resolution lost by squashing (warning above 10 %). Applied per primitive: use "One mesh per graph node" to get a separate V range per branch generator.
* **UV seams** (Branch > UV Mapping > *Create seams*, `uvCreateSeams`): at every ring vertex whose U is a whole number (a tile border) the mesher adds a second vertex with the same position, normal, tangent, wind and UV; the quads left of the border use the copy. Every U tile is a separate island, the welded surface is unchanged (tested: same welded vertex count, no new open edges).
* **Atlas handling** per material: Default / Cutout / Mesh / **Force out** (`atlas.handling = 'forceOut'`): never cut apart or repacked (no V-tiling, no lightmap re-unwrap). `atlas.unwrapScale` is the lightmap unwrap scale.

### 9.4 Lightmap UVs (`src/export/lightmap/lightmapPack.ts`)
Tree > Lightmap: `lightmapEnabled` (default off: UV1 stays the per-branch UV1), `lightmapResolution` (texels, default 1024), `lightmapLayout` (Atlas / UDIM). Per generator `lightmapWeight` (relative texel density, default 1, 0 for leaf and frond generators) and per material `unwrapScale`. The packer makes one island per exported piece: a weight-0 (or GPU-instanced) piece is split into connected components (one leaf card each), every component gets one texel (weight 0) or an equal cell; other pieces keep their own UV1 layout (aspect preserved) scaled to `sqrt(area) x weight x unwrapScale`. All islands are shelf-packed; the neutral texel density is the largest one for which everything fits the resolution (bisection), so the layout always fits [0, 1]. The achieved density (`texelsPerMetre`, `fill`, per island rectangles, UDIM tile numbers `1001 + u + 10 v`) is in the report and `lightmap` of the metadata. UDIM: every piece owns a tile. View mode **Lightmap density** (green = within 0.5x .. 2x of the ideal density of a perfectly packed atlas, blue = too low, red = too high); command **Reset Lightmap** restores all weights / unwrap scales of the graph nodes to their defaults in one undo step and the Unwrap scale of the project material library to 1 (a second undo step of the library). Branches of one generator already own separate cells of the generator's UV1 grid (`vx.u1 / v1` in `tubeMesher`), so the islands of different branches do not overlap inside the generator island.
