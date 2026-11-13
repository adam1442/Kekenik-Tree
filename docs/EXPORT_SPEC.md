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
| `_WIND_WEIGHTS` | VEC4 float | `(level0 trunk, level1 branch, level2 twig/leaf, phase)`, all 0..1. |
| `_AO` | SCALAR float | Ambient occlusion 0 = occluded … 1 = open (generator estimate x optional bake). |

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
3. **Foliage %** — leaf / frond / decoration / mesh / cluster pieces are thinned with a deterministic per-piece rank (nested subsets: a lower % is always a subset); GPU-instanced payloads are subset by instance.
4. **Keep area** — kept pieces are enlarged by `1/sqrt(keptFraction)` (max 3x) about their base (lowest-v vertices), preserving the silhouette coverage.
5. **Triangle budget** — the foliage keep fraction is lowered further to fit the budget.
6. **Switch at %** — screen-height fraction (`plantHeight / (2 d tan(fov/2))`) at or below which the LOD is used; strictly decreasing, LOD0 = 100 %.

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
`{ format: "kekenik-export", version, name, exportedAt, seed, settings, transform, lods[], materials[], wind { project, sceneWindNode, perNode[] }, impostor, warnings }`.

## 8. Verification
After writing a glTF / GLB the exporter re-reads it: nodes, meshes, triangles, vertices, materials and images are recomputed from the accessors and compared with what the writer received;
GLB files are also imported with three.js `GLTFLoader` and the triangle count is compared. Differences become warnings in the dialog.
