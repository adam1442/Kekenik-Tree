# Kekenik Tree — Architecture

Kekenik Tree is a browser-based, node-based procedural plant/tree generator built around a familiar node-graph
workflow (generation graph, properties inspector, docked panels). Everything runs client-side. **Stack: TypeScript (strict) + Vite + Three.js, vanilla DOM — no UI framework.**

## Coordinate system & units
Right-handed, **Z-up**, metres . three.js is used with `camera.up = (0,0,1)`; the grid lies in XY.
Exporters convert to Y-up where needed.

## Layers (dependency direction: top → bottom)

```
app/        bootstrap, AppContext, commands, shortcuts, menus, settings, layout persistence
ui/         docking/, components/, panels/, icons/, theme/      (DOM only)
viewport/   three.js scene, camera, grid, lighting, view modes  (no DOM panels)
geometry/   Skeleton -> MeshData builders                       (pure)
graph/      node registry (graph model: , engine: 2B)
contracts/  ALL shared interfaces + tiny helpers                (pure)
core/       rng, noise, store, event bus, disposable, math, id, logger, Component (pure/DOM-free except Component)
```

Rules: `contracts/` and `core/` import nothing from upper layers. `ui/` never imports `app/` except `app/context` (panels fetch
singletons with `getApp()`).

## Data flow (target)

```
graph (GraphJSON, ParamState per node)
   │   engine: topological evaluate(), per-node Rng = projectRng.fork(nodeId)
   ▼
NodeDef.evaluate(ctx, inputs, params) → PortValue { Structure | Mesh | Material | Force | Wind | Texture | Scalar }
   ▼
Skeleton (struct-of-arrays)  ── mesher──▶  MeshData  ──meshDataToGeometry──▶  THREE.BufferGeometry
   ▼                                                                                     ▼
Export (6A) / LOD / bake                                         ViewportContent { root, skeleton?, bounds, stats, dispose }
                                                                                         ▼
                                                                        Viewport.setContent() (owns & disposes it)
```

## Registries (extension points — never edit a central switch)
| Registry | API | File |
|---|---|---|
| Panels | `registerPanel({id,title,icon,component,defaultDock,minSize,closable,singleton,headerless,floatSize})` | `ui/docking/panelRegistry.ts` |
| Nodes | `registerNode(NodeDef)` or `export const nodeDefs: NodeDef[]` from `src/nodes/<family>/index.ts` (auto-discovered) | `graph/registry/` |
| Icons | `registerIcon(name, svgInner24)` | `ui/icons/icons.ts` |
| Commands | `app.commands.register({id,label,shortcut,run,enabled,checked})` | `app/commands.ts` |

Menus, toolbars and shortcuts refer to commands by id (`commandItem(app,id)`), so adding a command adds its shortcut everywhere.

## Docking system (`src/ui/docking/`)
* **Model** (`types.ts`): `DockLayout { root: DockNode|null, floating: FloatingPanel[], maximizedGroup }`. `DockNode` = `DockSplit{dir,children,sizes}` | `DockGroup{id,panels,active,collapsed}`. Fully JSON-serialisable.
* **Pure operations** (`layoutOps.ts`): `detachPanel`, `insertIntoGroup`, `splitGroup`, `prune` (removes empty groups, collapses/flattens splits). Unit-tested.
* **Persistence** (`layoutSerializer.ts` + `app/layoutStore.ts`): `parseLayout()` validates (drops unknown/duplicate panels, sanitises rects, re-adds required non-closable panels, rejects other versions → fall back to default). `localStorage` keys: `kekenik.layout.current`, `kekenik.layout.saved`.
* **Presets** (`layoutPresets.ts`): Default, Graph-focused, Viewport-focused.
* **DockManager**: renders the model; creates each panel's DOM *host* once and only re-parents it (WebGL context & state survive moves). Handles splitters (drag; double-click = equalise), tab drag (reorder / move / edge-split / float), floating windows, maximize (`Shift+Space`), collapse, panel menu, open/close via Window menu.
* **Drop zones**: header strip = insert into tab list; outer 25 % of a group = split on that side; the rest = merge as tab. Dragging a docked tab and releasing outside any group, or holding **Alt**, floats it. Floating windows use a stricter (smaller) centre zone so they can sit over the dock; hold **Alt** to disable docking/snapping while dragging them.
* **Headerless panels** (`headerless:true`, used by the Viewport): the panel draws its own header and calls `ctx.startDrag / showMenu / toggleFloat` (`PanelContext`).

### FloatingWindow (`ui/components/floatingWindow.ts`)
The single floating-window primitive: title bar drag, 8-way resize, z-order per container, minimize/maximize/close, clamp-to-container, edge snapping (Alt disables), optional modal backdrop. Used by floating dock panels (container = dock's float layer) **and** all dialogs (container = `app.dialogLayer`): Curve popup, Edit Mesh, About, Shortcuts, Save-layout prompt.  / 6A must use it for the Curve editor and Export dialog.

## Application context (`app/context.ts`)
`getApp()` → `{ store: Store<AppState>, events, commands, undo: UndoStack, dialogLayer, dock, viewport, notify() }`. `dock` is assigned after `DockManager` is constructed (panels are built during its constructor — do not touch `app.dock` while initialising a panel).

## Conventions
* Determinism: all randomness through `core/rng.ts` (`Rng.fork(key)` for stable sub-streams). `Math.random` only for UI ids/seeds-by-user-action.
* Theme: every colour/size is a CSS variable in `ui/theme/tokens.css`. No hex values in other CSS. (Scene/3D colours in code are allowed.)
* Performance: viewport renders on demand (dirty flag, idles when nothing moves), DPR clamped to 2, `ResizeObserver` for sizing, everything disposed.
* Undo/redo: wrap model changes in `Command {label, do, undo, merge?}` and run via `app.undo.execute()`.
* No `any`; unknown data is validated with guards (see `layoutSerializer`, `settings`).

## Graph editor

**Model** (`src/graph/model/`): `GraphModel` (pure, event-emitting, JSON round-trip) owns nodes, edges and annotations
(groups / sticky comments). Mutation primitives are unchecked and driven by Commands; rules are queried first with
`canConnect()` (direction, edge family, `portsCompatible`, locked, duplicate, **cycle**, capacity). A port without
`multiple` is *replaced* (`ConnectCheck.replaced`) - this is how the single-parent rule / re-parenting works.
Helpers: `layout.ts` (tidy tree, align, distribute, free slot), `clipboard.ts` (copy sub-graph / paste plan), `search.ts` (fuzzy).

**Edge convention.** `from` = parent output port (`children`), `to` = child input port (`parent`). Data flows parent -> child.
Hierarchy edges are drawn child-bottom -> parent-top (children grow UP, root at the bottom).
Nodes without hierarchy ports (Force / Material / Mesh / Wind) are *attachment nodes*: connected with
`EdgeKind:'attachment'` edges, never drawn on the canvas, listed in the footer counters.

**Commands** (`src/app/commands/`): `commandRegistry.ts`, `undoStack.ts` (per-document histories via `setContext`, merge of
keyed commands until `seal()`, dirty flag, history list + `jumpTo`, `onChange` hook for a History panel), `batch.ts`,
`graphCommands.ts` (add / remove / connect / patch nodes / set param / annotations). `import '@/app/commands'` still works.

**Session** (`src/app/graphSession.ts`, reachable as `getApp().graph`): one `GraphModel` per document, selection (mirrored into
`store.selection/selectionLabel`), clipboard and every *undoable operation* (addNode, deleteSelection, connect, reparentAndPlace,
setFlag, rename, autoLayout, align, duplicate, paste, groups ...). The Properties inspector uses `graph.setParam(...)`;
the engine listens to `events 'graph:changed'` and can call `graph.setEdgeLabels()` / `graph.setRootInfo()`.

**Canvas** (`src/ui/panels/graph/`): **SVG** with one transformed `<g>`. Justification: nodes are small vector discs, so
SVG gives crisp output at any zoom, trivial hit-testing (`closest('[data-node]')`), native text/tooltips and a single
attribute write per pan/zoom frame; changes are applied incrementally (dirty sets flushed once per frame). Measured in
Chromium headless: ~490 nodes, dragging a 6-node selection stays at the rAF rate (~16 ms/frame). A canvas renderer would
only be needed beyond several thousand nodes (labels hide automatically below zoom 0.5).
`graphRenderer.ts` (views + overlay), `graphCanvas.ts` (gestures, keyboard, inline edit), `graphMenus.ts`, `addNodePopup.ts`,
`graphFooter.ts`, `graphPanel.ts`, pure `viewTransform.ts` / `edgeGeometry.ts`.

## Contract notes
* `GraphNodeJSON`: optional `bypass`, `solo`, `collapsed`, `locked`, `note`. `GraphJSON`: optional `annotations`
  (`GraphAnnotationJSON`). Backward compatible (absent = default). Reason: editor state must persist.
* `AppState.dirty` (derived from the undo save point). `AppEvents['graph:changed']`. `AppContext.graph: GraphSession`.
* `AppCommand.extraShortcuts` (Ctrl+Y for redo) and `AppCommand.scope` (panel-scoped shortcuts, e.g. `F` / `A` /
  `Tab` only fire inside the graph panel; the global dispatcher skips scoped commands).
* `src/app/commands.ts` became the folder `src/app/commands/` (index re-exports the old API).
* `ui/icons/icons.ts`: added `iconMarkup(name)`; node glyph icons in `ui/icons/nodeIcons.ts`.

## Evaluation engine — `src/graph/engine/`, `src/app/engineHost.ts`

**Pipeline.** `GraphModel` -> `snapshotGraph()` (immutable copy, params deep-cloned + hashed) -> `GraphEvaluator.evaluate()` ->
`EvaluationSummary { diagnostics, edgeLabels, scene: SceneModel }` -> `EngineHost.publish()` -> graph badges / edge labels / root text /
status bar / `SceneSync` (viewport). `EngineHost` (`getApp().engine`) listens to `graph:changed`, document switch, seed and LOD changes and
debounces (16 ms) into runs.

**Order & semantics.** Kahn topological order over ALL edges (hierarchy parent -> child, attachment -> generator); ties by snapshot order.
Inputs: hierarchy child receives `inputs.parent = [parent.outputs.children]`; attachment ports receive the attachment node's `out`.
`disabled` (zz): node and its hierarchy descendants are `skipped`; `bypass`: not evaluated, `children = parent input` (no geometry);
`solo`: only soloed nodes + their ancestors are evaluated, only soloed nodes contribute geometry; upstream failure => `blocked`;
attachment failure only drops that input. Cycles (corrupt files) => the nodes on the cycle get an `error` state.

**Reserved output keys** (`contracts/engine.ts`, `OUTPUT_KEY`): a node may return, next to its declared out-ports, `geometry` (`Mesh` value =
its own renderable MeshData) and `instances` (`Scalar` = instance count shown on the edge). Generators return `children: Structure` holding
ONLY their own instances in world space (`parentBranch/parentPoint` index the PARENT's skeleton).

**Cache.** Key = `nodeId : hash(KEY_VERSION, type, def.version, paramsHash, derivedNodeSeed, lod, input keys [, name for force/material/mesh/wind/utility])`.
Because input keys are inside the key, an edit invalidates exactly the node and its downstream nodes; ancestors / siblings hit the cache
(dirty propagation without bookkeeping). Errors are cached too. LRU bounded by estimated typed-array bytes (default 384 MB); entries of deleted
nodes are dropped after each run. Preview (LOD 3) and full (LOD 0) results coexist, as do undo/redo states.

**Seeds.** `deriveNodeSeed(projectSeed, nodeId, perNodeSeed)` = `Rng(project).fork(nodeId).fork(perNodeSeed)`; the per-node seed is the optional
`seed` param. Independent of node order and node count. `sampleVariance(rng, value, variance, span?)` always consumes one number.

**Threading decision.** Main thread, time-sliced: 8 ms of synchronous work then a MessageChannel macrotask yield; cancellation token is
checked between nodes and exposed to node code (`ctx.cancel`). Why not a Worker: node definitions live in the main bundle (a worker would need
the whole catalogue + registry), the app ships as one inlined HTML file, and cached nodes make most edits cheap. The evaluator is DOM-free and
works on a snapshot + typed arrays, so a Worker backend can be swapped in behind `EngineHost` without touching nodes.
**Progressive:** when the last full pass took > 60 ms (or on the first run) a LOD-3 preview is published first, then the refined result.

**Viewport sync** (`viewport/sceneSync.ts`): one `Mesh` per graph node, keyed by node id + revision token (producer's cache key); unchanged nodes
are untouched, changed nodes write into existing GPU buffers when the layout is identical (else new geometry, old disposed), removed nodes are
disposed. `Viewport.refreshContent()` re-applies view mode / fit after in-place changes. `userData.nodeId` tags geometry; selection = yellow
wire overlay sharing the geometry. Materials come from `MaterialResolver` (default: `'bark' | 'leaf' | 'cluster'` by slot id;  replaces).

## Persistence — `src/app/project/`
* `format.ts` (`createProjectFile`, `parseProject`: migration chain + sanitising + per-node param migration), `codec.ts` (JSON <-> bytes,
  gzip via fflate when > 200 KB or forced, sniffed by magic number), `fileAccess.ts` (`FileIO`: File System Access API or upload/download),
  `kvStore.ts` (IndexedDB / memory), `autosave.ts`, `recent.ts`, `templates.ts` (`.kttemplate`), `defaultGraph.ts` (new project),
  `projectManager.ts` (documents <-> files; `getApp().project`), `projectCommands.ts` (`file.*` commands).
* File = `ProjectFile` JSON (`version` 2, `format: "kekenik-tree"`, `nodeVersions`). One `store.documents` entry per project; the tab name is the
  file name; `DocMeta` keeps handle + the non-graph parts of the project verbatim.
* Autosave: dirty documents are written to IndexedDB 1.5 s after the last edit and on tab hide; records are deleted on save / close; the next
  start offers recovery. `beforeunload` guards unsaved work.

## Contract notes
* `NodeCategory` + `'modifier'`. `NodeDef` + optional `version`, `migrate`, `statsGroup`. `NodeContext` + `nodeId`, `name`.
* `ParamDef` + `ListParamDef` (`kind: 'list'`, `fields`), `ParamValue` + `ListItem[]`.
* `ProjectFile` + optional `format`, `savedAt`, `nodeVersions`; `PROJECT_VERSION` 1 -> 2 with `PROJECT_MIGRATIONS` (real chain in `contracts/project.ts`).
* New `contracts/engine.ts` (`NodeDiagnostic`, `SceneModel`, `EvaluationSummary`, `OUTPUT_KEY`).
* `AppState` + `evaluating`, `evaluationProgress`, `evaluationPreview`. `AppContext` + `engine`, `project`. `UndoStack.markDirty()`.
* `GraphSession`: `diagnostics`/`setDiagnostics`, `dropDocument`, `modelOf`, `exportSelection`, `importSubgraph`, optional `initialGraph` dep; the
  `graph/registry.ts` became the folder `graph/registry/` (same import path).
* `Viewport.refreshContent()`. `createAppStore()` starts with ONE document ("Untitled").

## Curve & Ramp System — `src/core/curve/`, `src/ui/components/{curve,ramp}/`

* **Core evaluation & operations (`src/core/curve/`)**:
  * `types.ts`: `Curve`, `CurvePoint`, `TangentMode` (`'auto' | 'smooth' | 'linear' | 'flat' | 'free' | 'stepped' | 'constant' | 'aligned' | 'mirrored'`), `WrapMode` (`'clamp' | 'loop' | 'repeat' | 'pingpong'`), `Ramp`, `RampStop`, `RampInterpolation`.
  * `evaluate.ts`: `evaluateCurve` (monotonic-x safe cubic Hermite with Fritsch-Carlson auto slopes), `curveDerivative`, `curveIntegral` (composite Simpson quadrature), `curveHash` (32-bit FNV-1a), `curveToLUT(curve, 256 | 512)` (LRU-cached `Float32Array` keyed by hash), `sampleCurveLUT`.
  * `presets.ts`: 14 presets (`linear`, `ease-in`, `ease-out`, `ease-in-out`, `bell`, `inverse`, `constant-1`, `constant-0.5`, `constant-0`, `step`, `noise`, `late-rise`, `early-drop`, `spike`), `getCurvePreset`, `applyCurvePreset`, `detectCurvePreset`.
  * `ops.ts`: `addCurvePoint`, `removeCurvePoints`, `moveCurvePoint`, `moveCurvePointsByDelta`, `setPointTangent`, `setPointsTangentMode`, `flipCurveHorizontal`, `flipCurveVertical`, `mirrorCurve`, `reverseCurve`, `scaleOffsetCurvePoints`, `smoothCurvePoints`, `simplifyCurve` (Ramer-Douglas-Peucker), `fitCurveFromStroke`, `switchCurveLevel`, `serializeCurve`, `deserializeCurve`, `copyCurveClipboard`, `pasteCurveClipboard`.
  * `ramp.ts`: `evaluateRamp`, `rampHash`, `rampToLUT`, `rampToFloatLUT`, stop editing operations, `RAMP_PRESETS`, JSON/clipboard helpers.
* **UI components**:
  * `src/ui/components/curve/miniCurve.ts`: `mountMiniCurve` and `renderCurveThumbnail` (inline HiDPI curve button with parent green / profile cyan / dim variants, level badge `2..5`, right-click preset/flip/copy/paste/reset menu).
  * `src/ui/components/curve/curveEditor.ts`: `mountCurveEditor` (full HiDPI canvas editor, toolbar, adaptive grid, pan/zoom, point/tangent handle dragging, freehand `Draw` stroke fitting, scrub inputs, marquee multi-select, variance band, ghost curve, right-click menu).
  * `src/ui/components/ramp/rampEditor.ts`: `mountRampEditor` and `renderRampThumbnail` (HiDPI gradient bar with top alpha stops & bottom color stops, interpolation modes, `ColorPicker` integration).
  * `src/ui/components/colorPicker.ts`: shared `mountColorPicker` and `openColorPickerPopup` (HSV 2D area, hue/alpha sliders, RGB/HEX inputs, EyeDropper support, swatches).
  * `src/ui/components/paramWidgetRegistry.ts`: `registerParamWidget` / `mountParamWidget` registry with built-in registrations for `'curve'`, `'ramp'`, and `'color'`.
  * `src/ui/panels/dialogs/curveDialog.ts`: `openCurveDialog(path, opts)` hosted in `FloatingWindow` and wired to `app.graph.setParam` and `app.undo`.
  * `src/ui/panels/devCurveHarness.ts`: visual comparison harness at `#/dev/curve` and dockable panel `'dev.curve'`.

## Contract notes
* `src/contracts/curve.ts` now re-exports from `src/core/curve/`.
* `TangentMode` extended backward-compatibly with `'smooth' | 'constant' | 'aligned' | 'mirrored'`. `WrapMode` extended with `'repeat'`.
* `CurvePoint`: optional `weight?: number`. `Curve`: optional `fixedEndpoints?: boolean`, `valueMode?: 'relative' | 'absolute'`, `level?: number`, `levelCurves?: Record<number, CurvePoint[]>`.


## Mesh building — `src/geometry/`
* `tubeMesher.ts` `buildTubeMesh(skeleton, TubeOptions)`: skeleton -> `MeshData`. Options are built from a generator's Skin / UV / Shape / LOD tabs by `nodes/generators/common.ts#tubeOptionsFromParams`. Junctions (`parentPoint >= 0`) get a buried first ring + exponential radius collar + colour/AO blend toward the parent; free starts (`parentPoint < 0`) get a flat base cap; tips get a dome (`tipRings`).
* `leafMesher.ts` `buildLeafMesh(LeafCard[])`: one bent/folded/curled blade per card, cards grouped per material slot. `bladeBasis` builds a blade frame from direction + desired face.
* `primitives.ts` (quad, cross, cone, sphere, flower), `instancing.ts` (`placeMeshes`, `expandInstances`, `composeMatrix`), `meshImport.ts` (OBJ, glTF/GLB -> Z-up `MeshData`, `fitToUnit`), `meshAssets.ts` (asset id -> parsed mesh, lookup registered in `bootstrap.ts`), `meshAccumulator.ts` (interleaved growable vertex store), `windAttributes.ts`, `crossSection.ts`, `math3.ts`.
* **Winding / frames:** triangles are CCW seen from outside (verified by signed volume in tests). Skeleton Z-up; rings go from `N` toward `B = T x N`.
* **Vertex data written by every builder:** position, normal, tangent(xyzw), uv0, uv1 (unique cell per branch / leaf, lightmap-ready), `colors` (rgb already multiplied by AO, alpha = 1 so `alphaTest` materials are safe), `ao` (raw), `wind.pivot` (branch base / leaf base) and `wind.weights = (h0, h1, h2, phase)`.
* **Wind channels** (`windAttributes.ts`): each generator attaches `wind0`, `wind1`, `wind2`, `windPhase` per skeleton point; children inherit the parent's value at their attachment point. Level = `min(generation, 2)`, own weight `t^1.5`. Leaves add `0.8 * a` toward the tip in `w2`.
* **GPU instancing:** `MeshData.instanced = { count, matrices }` holds ONE geometry copy; `SceneSync` draws an `InstancedMesh`, exporters call `expandInstances`.
* **LOD:** `ctx.lod` is continuous in all builders: sides `(1 - 0.4 r)^lod`, rings `(1 - 0.4 r)^lod`, tip rings 1 from LOD 2, foliage detail `0.7^lod`, plus the distribution engine's count scaling.

## Contract notes
* `MeshData` + optional `ao`, `instanced` (`InstancedMeshPayload`); `meshTriangleCount` multiplies by the instance count; `mergeMeshData` keeps `ao` and `wind` when every input has them.
* `ViewMode` + `'uv' | 'ao'` (menus, toolbar, commands `view.mode.uv/ao`, shortcuts Alt+6 / Alt+7, Skeleton moves to Alt+8).
* New node `generator.meshes` ("Mesh Instance"). New params (all optional / defaulted): Shape `sectionShape/sectionLobes/sectionDepth/sectionSpiral/sectionNoiseFrequency`; Skin `tipRings/capBase/skinTwist/collarAmount/collarLength/aoStrength`; leaf Skin `cardType/outline/cardCount/leafSegments/leafWidthSegments/leafBend/leafFold/leafCurl/leafTwist/atlas*`, Generation `leavesPerNode/clusterAngle`; Orientation `angleToParent`; frond and cluster catalogues extended.
* `emitStructureOutput(skeleton, params, lod, materialId, instances?, parent?, seed?)` gained `parent` + `seed`.
* `Skeleton.attributes` may now contain `wind0..2`, `windPhase`.
* Removed: `geometry/cardMesher.ts`, `geometry/meshBuilder.ts`, `nodes/generators/foliageBaseline.ts`.


## Contract notes
- `contracts/material.ts`: new `MaterialSetDef`, `MaterialSetMember`, `MaskDef`, `DisplacementDef` (+ `MaskType`, `MaskBehavior`, `DisplacementChannel`). `MaterialDef` unchanged.
- `contracts/project.ts`: `ProjectFile` gains optional `materialSets`, `masks`, `displacements`; `AssetEntry` gains optional `hash`. `ProjectMeta` (`app/project/format.ts`) gains the same optional lists; `ProjectManager.onMetaLoaded(fn)` notifies after a project is loaded.
- `.ktree` binary container (`app/project/binaryContainer.ts`): projects with embedded assets are written as `KTB1 | flags | jsonLen | json(+blob table) | raw blobs`; `decodeJson` sniffs it. Plain JSON / gzip files are still read and written for projects without assets.
- `AppEvents`: `'material:editMesh' { materialId }`.
- `MaterialResolver` (viewport/defaultMaterials.ts): optional `resolveBack`, `backKey`, `onChange`. `SceneSync` renders a BackSide twin mesh for Back materials and exposes `refreshMaterials()`.
- Generators: `materialTabParams()` gained `material` (enum, dynamic options = library materials + sets), `displacementParams()` gained `displacement` and `displaceOffset`. `emitStructureOutput` resolves `material` through `resolveMaterialRef` and applies `displaceMeshData`. `pickLeafType` resolves Material Sets through the node RNG.
- `wind/windMaterials.ts`: depth materials are a `WindDepthMaterial` subclass whose `clone()` keeps the wind patch (three.js clones custom depth materials of alpha-tested meshes).
- New layers: `materials/` (pure: shadingMath, materialSource, masks, displacement; stateful: library, resolver, preview, install), `textures/` (bytes, textureManager), `viewport/lighting.ts`.

### Materials / lighting data flow
```
ProjectMeta (active document) <-> MaterialLibrary (undoable edits, events) --> KtMaterialResolver -> KtPhysicalMaterial (in place)
                                         |                                    '-> SceneSync (Back twin, refreshMaterials)
                                         '--> MaterialSource (global read-only view for node evaluation: sets, displacements, season)
TextureManager: assets[] (base64 in memory, raw in file) -> decode (ImageBitmap) -> pooled Texture per (asset, colour space, res)
Lighting settings (localStorage) -> Viewport.setLighting -> sun / hemisphere / tone mapping / PMREM / fog / background
```


### Contract notes
* `ResolverOptions.vertexColors?: boolean` (materials/materialResolver.ts): scene resolvers set it, the preview resolver does not.
* `ShadingSettings` gained `translucencyStrength`, `foliageWrap`, `foliageSheen`, `vertexAo`; `LightingSettings` gained `shadowSoftness`, `sunGlow`, `fogFollowsHorizon` and `ToneMappingName` gained `'AgX'` (old stored settings are merged with defaults, backward compatible).
* `KtUniforms` gained `uKtTrans`, `uKtWrap`, `uKtAoMix`; program cache key bumped to `kt2`.

## Cutout / Mesh Editor, Meshes Panel & UV Areas — `src/materials/cutouts/`

* **Data model (`contracts/material.ts`, `materials/cutouts/`)**:
  * `CutoutMesh`: stores UV boundary `outline` (`[u, v][]`), `interiorPoints` (Steiner vertices), base `indices`, per-LOD `lods: Record<'high'|'med'|'low', CutoutLodVariant>`, `straightenAxis`, `straightenLinear`, `anchors` (`CutoutAnchor[]`), `paint` (`CutoutPaintLayers`: `vertexMask`, `vertexColor`, `vertexSection`), `pivot`, `doubleSided`, `settings` (`CutoutTessellationSettings`), `boundsMeters`, `scale`, `transform` (`MeshTransformSettings`), and `windDirection` (`MeshWindDirectionSettings`).
  * `UVAreaDef`: named rectangular or polygonal UV region on a material atlas (`rect`, `pivot`, `usage`, `weight`).
  * Both `cutoutMeshes` and `uvAreas` are persisted on `ProjectFile` (`contracts/project.ts`), `ProjectMeta` (`app/project/format.ts`), and managed with snapshot undo/redo by `MaterialLibrary` (`materials/library.ts`).
* **Algorithms (`src/materials/cutouts/`)**:
  * `contour.ts`: `generateCutoutOutline` / `generateCutoutOutlineAsync` (alpha/luma extraction, max-pool downsampling for up to 4096² textures, separable Chamfer dilation for `opacityMargin`, radial/concave silhouette tracing, closed-loop RDP simplification driven by `refineEdges`, `angle` rotation, and Convex Hull mode).
  * `triangulate.ts`: `triangulateCutout` (ear-clipping of arbitrary concave polygons + interior Steiner point insertion + Lawson Delaunay edge flipping preserving constrained boundary edges) and `generateTessellationPoints`.
  * `lod.ts`: `rebuildCutoutLods` / `buildLodVariant` (Visvalingam-Whyatt importance decimation preserving the stem pivot and guaranteeing `V(High) >= V(Med) >= V(Low) >= 3`).
  * `ops.ts`: `mirrorCutoutOutline`, `linearizeStraighten`, `resetStraighten`, `addAnchor`, `removeAnchor`, `resetAnchors`, `applyBrushStroke`, `clearOrFillPaintLayer`, `checkUvWarnings`, `snapUvPoint`.
  * `buildCutoutGeometry.ts`: `buildCutoutGeometry(cutout, lod, opts)` outputs `CutoutMeshData` (extending `MeshData` with `cutoutSection`, `cutoutMask`, `bendWeights`, `cutoutPivot`), deforming UV vertices or imported 3D LOD meshes into leaf card space (`origin`, `axis`, `side`, `bend`, `fold`, `curl`, `twist`) and computing wind pivots and flutter weights from `straightenAxis`, `anchors`, and `windDirection.growth`.
* **Integration with  generators**:
  * `LeafCard` (`geometry/leafMesher.ts`) gained optional `cutout?: CutoutMesh | null` and `lod?: number`; `emitCard` emits `buildCutoutGeometry` when `c.cutout` is present.
  * `foliage.ts` (`evaluateLeaf`, `evaluateFrond`) resolves `cutout` via `resolveCutoutForLeaf(type.material, type.mesh, rng)` and `uvArea` via `resolveUvAreaRect`.
  * `nodes/meshes/index.ts` (`mesh.cutout`, `mesh.asset`) and `instanceNodes.ts` evaluate cutout meshes via `buildCutoutGeometry`.

### Contract notes
* `contracts/material.ts`: added `CutoutMesh`, `CutoutLodVariant`, `CutoutAnchor`, `ImportedLodMesh`, `CutoutPaintLayers`, `CutoutTessellationSettings`, `MeshTransformSettings`, `MeshWindDirectionSettings`, `UVAreaDef`, `LodLevel`, `TessellationMode`, `MeshOrientMode`, `MeshFlipMode`, `WindGrowthAxis`, `WindRippleMode`.
* `contracts/project.ts` & `app/project/format.ts`: `ProjectFile` and `ProjectMeta` gained optional `cutoutMeshes?: CutoutMesh[]` and `uvAreas?: UVAreaDef[]`.
* `materials/library.ts`: `LibraryKind` gained `'meshes' | 'uvAreas'`; `MaterialLibrary` gained `cutoutMeshes()`, `cutoutMesh(id)`, `cutoutsForMaterial(matId)`, `uvAreas()`, `uvAreasForMaterial(matId)`.
* `materials/materialSource.ts`: `MaterialSource` gained optional `cutoutMeshes?()` and `uvAreas?()`, plus `resolveCutoutForLeaf` and `resolveUvAreaRect`.
* `geometry/leafMesher.ts`: `LeafCard` gained optional `cutout?: CutoutMesh | null` and `lod?: number`.
* `ui/panels/dialogs/editMeshDialog.ts`: `openEditMeshDialog(target: EditMeshTarget)` accepts either a string name or `{ materialId?, cutoutId?, materialName? }`.

## Viewport Quality — `src/viewport/quality/`, `src/viewport/gridMesh.ts`, `src/viewport/thickLines.ts`, `src/textures/alphaCoverage*.ts`

**Render path.** `Viewport.tick` -> `planAa()` (pure) -> `QualityPipeline.render()`:
`scene (multisampled HDR RGBA16F target + DepthTexture, samples 0/2/4/8) -> composite -> [FXAA | SMAA | TAA accumulation] -> canvas`.
The canvas is opaque and never multisampled itself. The gradient background is `scene.background` (1x256 canvas texture, same stops as the old CSS gradient),
so alpha-to-coverage never leaks alpha into the framebuffer. The composite pass applies tone mapping **exactly once** (three.js skips it for render targets)
and the sRGB OETF. Pixels with depth == 1 (background + ground decals: grid, shadow catcher, contact disc, human) are only colour-space encoded, not tone mapped.
TAA = sub-pixel Halton jitter (`camera.setViewOffset`) accumulated as a running average (weights 1/(n+1)) while the view is still; any camera/size/scene change
(`Viewport.requestRender`, fingerprint of camera matrices) resets it. No motion vectors => no ghosting. Content that animates (wind) falls back to MSAA only.
Progressive refinement: every `requestRender()`/camera move marks the viewport interactive; for 150 ms (`RefinementState`) the cheap plan is used
(MSAA <= 2x, no SMAA/TAA, FXAA if MSAA is off), then one refined frame is rendered. Pixel ratio = `min(devicePixelRatio, maxPixelRatio)`.
Near/far follow the zoom (`clipPlanes`).

**Settings.** `quality/qualitySettings.ts` (`getQuality/setQuality/applyQualityPreset/onQualityChange`, persisted in localStorage `kekenik.viewport.quality`,
validated by `sanitizeQuality`; presets Low/Medium/High/Ultra). `getQualityStatus()` exposes the active AA label. UI: dockable panel `viewport-quality`
(`ui/panels/viewportQualityPanel.ts`, registered in `registerPanels.ts`, Window menu).

**Alpha-tested foliage.**
* `textures/alphaCoverage.ts` (pure): box mips + per-level alpha scale (histogram bisection) so the fraction above the cutoff equals level 0; colours alpha-weighted;
  the result is remapped so the cutoff lands on **0.5** (three.js shadow passes use a fixed 0.5 for alpha-to-coverage materials, so shadows match the main pass).
  Computed in an inline worker (`alphaCoverage.worker.ts`, `coverageService.ts`, main-thread fallback), cached per asset hash + size + channel + cutoff (LRU 96 MB),
  rebuilt (newest request wins) when the threshold changes. `TextureManager.acquire(assetId, slot, maxRes, coverage?)` returns the plain texture until the
  coverage `DataTexture` is ready, then notifies listeners; `isCoverageTexture(tex)` tells the resolver to use `alphaTest = 0.5`. Images > 2048 px keep GPU mips.
* `viewport/quality/sharedUniforms.ts` replaces three's `alphatest_fragment` globally (main, depth and distance shaders): `ALPHA_TO_COVERAGE` -> sharpened alpha
  `(a - cutoff) / max(fwidth(a), eps) + 0.5`; `KT_ALPHA_HASHED` -> same sharpened alpha vs interleaved-gradient noise (fallback without MSAA); else plain test.
  Also owns the shared uniforms (`uKtMipBias`, leaf distance scaling) used by `materials/ktShader.ts` (map/alphaMap sampled with `uKtMipBias`; `KT_LEAF_SCALE` grows
  cut-out leaf cards about `windPivot` with camera distance). `materialResolver` picks the effective alpha mode (`effectiveAlphaMode`), keeps cutouts in the opaque pass
  (`transparent=false`, depth write on).

**Ground grid.** `gridMesh.ts` (`Grid`): one quad re-centred under the camera, everything analytic in the fragment shader: distance to line in *screen pixels*
(world distance / `length(vec2(dFdx(c), dFdy(c)))`) => constant 1 / 1.5 / 2 px lines with 1 px AA at any distance and angle (axes included). Levels cell*10^-2..10^3
cross-fade by their on-screen spacing (5..20 px), brighter when the next finer level is visible; fade by 3D distance and at grazing angles. Pure twins of all
formulas live in `quality/gridMath.ts` (tested). Ground decals never write depth, are ordered with `renderOrder` and use `polygonOffset` (no z-fighting).

**Thick lines.** `thickLines.ts`: `createThickMaterial` (LineMaterial, CSS-pixel width, resolution kept in sync by the viewport), `wireGeometryFor` (cached edge list,
rebuilt when `position.version` changes), `createWireOverlay`, `ThickSegment`. Used by wireframe / shaded-wire view modes (non-instanced meshes), selection outline,
skeleton debug lines/radii/frames and the force / wind gizmos.

### Contract notes
* `TextureManager.acquire` gained an optional 4th parameter `coverage?: CoverageSpec`; new `setCoverageEnabled`, `isCoverageTexture`; `setAnisotropy` now re-uploads pooled textures.
* `createGrid()` was replaced by the `Grid` class; `Viewport` no longer takes an antialiased/alpha canvas (opaque canvas, background drawn in-scene).
* `SkeletonDebugMaterials` fields and `SkeletonDebugPiece` line members are now `LineMaterial` / `LineSegments2`.
* `PANEL.viewportQuality` ('viewport-quality'). `KtPhysicalMaterial` program cache key `kt3`.


## Contract notes
* `contracts/params.ts`: `IntParamDef` gained optional `softMin`, `softMax`, `warnAbove` (backward compatible).
* `contracts/ports.ts`: `StructureData.placement?: TreePlacement` (set by the Tree node, read by first-generation generators). Included in `hashPortValue`.
* `viewport/gizmos/gizmoLayer.ts`: `Handle.onDrag(world, event?)` and `GizmoLayer.onActiveChange` (both optional).
* Inspector tabs: `getInspectorTabSpecs(nodeType, defs)` (`ui/panels/properties/inspectorState.ts`) returns `InspectorTab[]` (id = ParamDef group, label shown on the tab, `disabled` when the tab has no params). `getInspectorTabs` is unchanged for other nodes.
* Param `rotationOffset` / `positionOffset` keep their meaning along a parent; the Tree disc uses the separate `distRotation` / `distPosition` (Generation > Tree placement).

* `NodeDef.dependencyKey?(params): string`: extra cache-key text for nodes that read project data outside their params
  (displacement maps, masks). `AppEvents['tree:refresh']`: re-evaluate without clearing the cache. `TubeOptions.displace /
  displaceDirection / maxSegmentLength`, `TubeOptions.radialSegments(generation, maxRadius)` (second argument added).
  `generator.frond` is now version 3 (rib-based frond, see the Frond note below; version 2 was the ribbon along each parent spine, `migrateFrondParams`); new node `generator.decoration`.
  Reason: live, targeted displacement updates; crack-free displaced tubes; correct Frond semantics.


## Node mode, overlays
* `src/instances/` (pure): keys, overrides (stored in the reserved param `__overrides`), `InstanceScope` (key derivation + `InstanceTable`), handle mapping registry, `OverrideEditor` (Command-based writes). Details: `docs/NODE_MODE.md`.
* `src/viewport/picking/instancePicker.ts` (pure picking), `src/viewport/overlays/` (selection pass), `src/viewport/gizmos/nodeModeGizmo.ts` + `nodeModeMath.ts`, `src/viewport/nodeModeController.ts` (pointer / keyboard).
* The overlay group is a child of the scene root, never of the plant content: view modes cannot affect it.

## Contract notes
* `AppState` + `editMode`, `instanceSelection`, `instanceHover`, `spinesOnTop` (view pref, persisted). `EditMode` type in `contracts/app.ts`.
* `StructureData.instances?: InstanceTable`, `SceneSkeleton.instances?: InstanceTable` (optional, backward compatible).
* `SpineSpawnSpec.lengthScale/radiusScale`, `TubeOptions.skipBranch`, `emitStructureOutput(..., table?)`, `extractParentTable()`.
* Reserved node param id `__overrides` (string); it is preserved by the existing graph loader (unknown params with a `value` are kept).
* Command `view.toggle.spinesOnTop`. `SceneSync.getMesh(nodeId)`; `SceneSync` no longer draws selection wire overlays.

### Contract notes
* `contracts/app.ts`: `ViewMode` gained `points`, `vertexColor`, `normalColors`, `alpha`; the meaning of `normals` changed from
  colour shading to vertex-normal lines (old colour shading = `normalColors`). New exports `VIEW_MODES`, `VIEW_MODE_LABELS`
  (single source of truth; persisted old values stay valid).
* `SkeletonDebugVisibility` gained `showLines`. `WindParams` gained `baseHold` (stored in `WindSettings.params`, backward
  compatible); `uWindD.w` = base hold in metres.
* `ViewportContent.skeleton` pieces are tagged by `userData.nodeId`; surface meshes are recognised with `isSurfaceMesh()`
  (never use `instanceof Mesh` on plant content: `LineSegments2` extends `Mesh`).
* The global three.js `alphamap_fragment` chunk is replaced (`sharedUniforms.ts`): an Opacity map replaces the colour alpha.
* `CutoutAnchor`: optional `name`, `roll`, `scale`, `tags`. `CutoutMesh.attachVersion` (axis / anchor data version; absent = migrate).
  The spec's `axis {points, mode}` is stored as the existing `straightenAxis` / `straightenLinear` (documented in
  `docs/CUTOUT_ATTACHMENT.md`); anchor `direction` = `handleUv - uv`, `axisT` is derived. Reason: backward compatibility.
* `StructureData.attachments?: AttachmentSet` (`contracts/attachment.ts`), `SceneSkeleton.attachments`,
  `NodeContext.getParentAttachments?(instanceKey)`, `AppState.showAttachmentFrames`. Leaf / Mesh / Decoration get the
  `Generation > Placement` params; Decoration now has a `children` port. Wind attribute layout (5A) unchanged: `axisT`
  drives the existing flutter weight (`w2`); `CutoutMeshData.cutoutAxisT` is an extra, non-exported array.


## Export, LODs, Baking & Impostors — `src/export/`
Layers: `export/` is DOM-free except `materials/materialContext.ts`, `impostor/impostorRender.ts` (WebGL), `install.ts`; the UI lives in
`ui/panels/dialogs/exportDialog.ts`, `ui/panels/lodEditor.ts`, `ui/panels/lodPanel.ts`, `ui/panels/dialogs/exportKit.ts`.

```
SceneModel (engine, any LOD) -> lod/lodScene.applyLodToScene -> geometry.buildGeometries (merge, expand instances, 1 primitive / material)
  -> bake/aoBake (worker) -> materials/materialExport (textures, ORM, albedo+opacity) -> impostor/* (WebGL) -> transform.ts (axes/units/handedness)
  -> writers/{gltf,simpleFormats}.ts -> verify.ts (round trip) -> zip.ts -> download
```
* `exportService.runExport(env, settings, token, onProgress)` is the single entry point; `ExportEnv` injects the engine (`EngineHost.evaluateAt`), material context, renderer, so it runs headless in tests.
* LOD: `lod/lodBuilder.buildLods` (evaluate per generator detail + post-process), `lod/lodPreview.ts` (`getLodPreview()`, consulted by `viewportPanel` through `resolve(summary)`).
* Settings: `export/settings.ts` (sanitising, `localStorage` keys `kekenik.export.settings`, `kekenik.export.lods`).
* Spec of every file / attribute / extras field: `docs/EXPORT_SPEC.md`.

## Contract notes
* `EngineHost.evaluateAt(lod, token, onProgress?)`: evaluate the current graph at any LOD without publishing (shares the node cache).
* `file.export` command is real ; panel `lods` registered; `viewportPanel` draws `getLodPreview().resolve(summary)` instead of `summary.scene` (identical when the preview is off).
* No change to `contracts/` or the project file format.

## Multiple cutout meshes per material & Material lists — `materials/meshSelection.ts`
* **Ownership.** `MaterialDef.meshes: CutoutMeshRef[]` (`{ id }`) is the ordered list of the cutout meshes a material owns; **index 0 = Primary**. The mesh data itself still lives in `ProjectFile.cutoutMeshes` (each keeps its own High/Med/Low, axis/anchors, paint, scale, name; `CutoutMesh.materialId` is the owner). `reconcileMaterialMeshes` keeps both in sync: it runs in `MaterialLibrary.meta()` and in `parseProject`, so files saved before this existed migrate on load (`meshes` = the cutouts whose `materialId` matches, in library order; materials without cutouts get `[]`). `MaterialLibrary.moveMesh` reorders (one undo step); `add` / `duplicate` / `remove` on `'meshes'` keep refs consistent (a duplicate sits after its source; a duplicated material gets its own mesh copies).
* **Selection (pure).** `selectMesh(material, mode, rng)`: `any` (uniform), `primary` (index 0), `notPrimary` (uniform over index >= 1, primary when it is the only mesh) or a mesh id. A draw is consumed only when there is a real choice, so projects with a single mesh keep their previous random stream.
* **Node side.** `ListParamDef.widget = 'materialSlots'` (builder `materialSlotList()` in `nodes/generators/params.ts`) renders the `MaterialSlotList` widget (`ui/components/params/materialSlotList.ts`, built on the generic list widget through `ListWidgetHooks`): rows of Material (None / material / Material Set), Mesh (Any / Primary / Not primary / the material's meshes) and Weight, with the pick probability shown per row. Leaf, Frond, Decoration, Cluster (`leafTypes`) and Mesh Instance (`meshTypes`) read it through `readMaterialSlots` + the single shared `pickMaterialMesh(list, ctx)` -> `{ material, materialId, meshAsset, lodMeshes, row }`: weighted row (one draw), `resolveMaterial(slot, season, rng)` (Material Sets: member by weight/season rule; the season is a hook that currently comes from the global Lighting season), then `selectMesh`. A None row or a material without meshes yields `meshAsset = null` = unit-square card (Leaf, Decoration, Frond keeps its ribbon, Mesh Instance keeps its primitive). Legacy `material` / `meshMaterial` params become a one-row list (`migrateLegacyMaterialParam`; Mesh Instance is node version 2).
* **Frond.** (Reworked in R06, node version 3.) A frond is built from *ribs*: `geometry/frondRibs.ts` (`buildRibs`) puts a left and a right rib (`accuracy + 1` points, point 0 = the spine point) at every station of the parent spine, in the rotation-minimising frame of the spine, and deforms them with Gravity / Fold / Curl / Roll (Shape > Height) and Align. `geometry/frondMesher.ts` (`buildFrondMesh`) maps a cutout mesh (normalised by `unitMeshFromGeometry`: u across, v along, relief z) or the plain ribbon grid onto the ribs; the centre line stays on the spine. Length always comes from the parent spine (Boundary Start / End only trim it); the Forces tab (Gravity, Up / Down, Ancestor with strength curves) bends the spine copy with `bendPath` (length preserving, base fixed). `buildFrondSpecs` returns `{ specs, paths }`; the mesh LOD uses `chooseMeshLod` (Material > Mesh: Index, Resolution). Old graphs go through `migrateFrondParams` (v1 -> v2 -> v3).
* **Frond variance / lighting / wind (R07).** `geometry/frondVariance.ts` (pure): `leftRightScales` (own Fold / Curl / Gravity multipliers per half, passed to `buildRibs` as `RibSettings.sides`), `sectionDeltas` + `spreadDraw` (Section Variance, Favor Outliers). `UnitMesh.section` / `.sections` carry the per-vertex section id of the cutout (`cutoutSection`); `buildFrondSpecs` builds one extra `Ribs` per painted section (ids 2..8, `FrondSpec.sectionRibs`) and `mappedLocal` maps every vertex through the ribs of its section. Lighting: `FrondSpec.light` + `FrondMeshOptions.lighting / lightingExtras`; `buildFrondMesh` collects one `LightingGroup` per emitted copy (with per-vertex `spine.along / away`) and calls `applyLeafLighting(..., { frond })` after `acc.build` (settings from `resolveFrondLighting`, Style Global = Tree lighting). Wind: `geometry/frondWind.ts#frondWindAt` writes the existing `w0..w3` per vertex (Weight x t^power, Cross, Boost, Ribs), so the attribute layout is unchanged.
* **Mesh Instance.** The base mesh is chosen per instance; an attached Mesh input / explicit asset still wins. Different bases are baked as one group each and merged (GPU instancing only applies when one base is used).
* **Generation modes (R08).** `src/generators/modes/` is the pure placement layer: `generatePlacements(frame, request)` returns `PlacementRecord { t, roll, side, groupIndex }[]` for ONE parent (`count` modes: `countModes.ts`, `stepsMode.ts`, `groupModes.ts` = Phyllotaxy + Interval, `bifurcationMode.ts`; dispatch + `normalizeMode` in `index.ts`). It only sees a `ModeFrame` (seeded stream, First / Last, parent length in metres, LOD keep, warp / attract / bend-finder callbacks), so it is testable without a skeleton. `nodes/generators/distribution.ts#generateChildPlacements` is the single adapter used by Trunk / Branch / Root / Spine / Leaf / Cluster / Mesh Instance: params -> `ModeRequest` (`readModeRequest`), then the shared Clip / Pruning / Knockout / Extend-parent steps. `ChildPlacement` gained `groupIndex`; `side` is now written by every mode. Params live in `generationParams` (params.ts); `EnumParamDef.options[].disabled` marks legacy entries (Classic). `generationMigration.ts` (`migrateGenerationParams`, chained with `withGenerationMigration`) upgrades older files. Frond and Decoration keep their own Generation tab (rib / surface placement) and do not use the modes.

## Shared Generation properties (R09) — `src/generators/common/`, `nodes/generators/generationEnv.ts`

Pure, seeded building blocks (`filters.ts` Clip / Pruning / Knockout, `volumes.ts` Force containers, `maskGate.ts`, `pass.ts`, `sizeScalar.ts`, `extend.ts`, `meshAlignment.ts`, `migrate.ts`) used by the generators through `generateChildPlacements(prep, params, rng, lod, max, env)` and `withGenerationCommon(def)`.

**Order of operations** for the nodes of one parent branch (`distribution.ts`):

```
mode placement -> boundaries / clip -> position / rotation / sink -> pruning -> knockout
  -> force containers -> masks -> extension logic -> compute
```

* Mode placement + boundaries: `generators/modes`. With Clip on, `ModeFrame.clip` stops the modes from clamping to First..Last, and the adapter removes nodes outside the (inset) range.
* Position and Rotation are applied inside the mode frame (`positionOffset`, `rollBase`, variance per parent); Sink is applied when the child grows (`sampledSink`, variance per node).
* Pruning: curve `pruningCurve` over First..Last, node removed where < 0.5. Knockout: `knockoutChance(amount x curve, resolution x lod)`, one `modeRng.fork('ko:<slot>')` draw per node (stable ids).
* Force containers and Masks are tested at the surface point where the node leaves the parent (`GenerationEnv`, built once per node by `createGenerationEnv(ctx, params, parentSkeleton)`). Volumes come from `NodeContext.forceVolumes` (all enabled Force nodes with a *Volume* section, filled by the evaluator and part of the cache key of nodes that use containers); masks come from the project Masks library (`generationDependencyKey` makes mask edits invalidate only the generators that use them).
* Extension nodes (`isExtension`, `u` 0 or 1) are added last and are not filtered. Extend parent is valid only under a Branch parent (`NodeContext.parentType`, set by the evaluator) and only Branch / Cap / Leaf / Batched leaf expose it.
* Root-level nodes (children of the Tree disc) get Knockout, Force containers and Masks via `keepsRootLevelNode`.

**Pass.** `topologicalOrder` breaks ties by Pass, then snapshot order. `validatePasses` (evaluator) appends an error message (error badge, not a failed state) to every node whose Pass is lower than an ancestor's.

**Size scalar.** `withGenerationCommon` multiplies the node's own `sizeScalar` into `StructureData.sizeScalar` of its parent (the Tree node starts it from its `scale`), scales the size parameters listed in `SIZE_PARAMS` for that node type and publishes the result (plus `StructureData.kind`, the node type) on its `children` output.

**Migration.** `withGenerationCommon` bumps every generator's node version and chains `migrateCommonGeneration` (old scalar `pruning` is folded into `knockout`).

## Spine and Segments (R10) — `src/generators/spine/`, `nodes/generators/spine.ts`

* Pure helpers: `lengthMath` (additive length, clamp, one V tile, shape envelope), `segmentMath` (accurate point / step count, Influence gain, length and radial segment counts per Relative basis, weld sample spacing), `orientationMath` (Start angle, Alignment with a random up, Unify), `shapeMath` (straightness, Parent Curl step, zigzag spacing), `pruneMath` (directional and ground prune), `migrate` (`migrateSpineParams`).
* Order of the spine operations in `growSpineIntoBuilder`: orientation (`branch.ts`: start angle -> start roll -> random up -> Alignment -> Roll) -> shape forces per accurate segment (curvature, Parent Curl rotations, zigzag by arc length, root dive, gravity / ancestor / forces; all scaled by `influenceGain`) -> noise (early noise during integration, late noise as displacement) -> Straightness (`noiseKeep`: removes noise, full at the base) -> ground prune -> resampling to the length segment count (+ weld part) -> Clamp is part of the length.
* Accuracy = exact number of points of the dense spine (Legacy style: scaled by the split position). The final length segment count is `Absolute + Relative x basis`; Legacy keeps `Relative x length`.
* Radial segments: the spine writes the final count per branch into the `radialSides` skeleton attribute (read by `tubeOptionsFromParams` and by children for the `Parent's radial segments` basis). `TubeOptions.radialSegments(generation, maxRadius, branchIndex?)`.
* Start angle keeps the `spread` id and its degree unit (0 = parent direction, 90 = perpendicular, 180 = opposite). Prune strengths are 0..1; `pruneGround` accepts old booleans.

## Spine noise, Jink, Path and Break (R11) — `src/generators/spine/{noiseMath,jinkMath,pathMath,breakMath,polyline}.ts`

* Order inside `growSpineIntoBuilder`: break / split decision (`breakSeed` has its own stream) -> Pass 1 integration with **Early noise** (`earlyNoiseGate`: Threshold + profile curves; own simplex field, so the Late Seed does not touch it) -> Pass 2 **Late noise** displacement (`smoothNoiseOffsets` low-pass, scaled by `1 - Smooth`) -> **Jink** (`applyJink`: points move towards the chord of their run; knots from `jinkKnots`, Uniformity 1 ignores the seed) -> **Path** (`applyPath`: perpendicular displacement `pathOffsetAt(arc length)` measured from the base value, so the start stays attached; period = `Length`, `Offset` is a fraction of a tile and may carry variance) -> ground prune -> resampling.
* Break: a node breaks with `breaks(chance, draw)` and ends at `clampBreakSpot(spot) x length`; the branch is written with `openEnd: true`, stored as the `openEnd` skeleton attribute (0 / 1 per point, copied by `mergeSkeletons`). `PreparedParentBranch.openEnd` carries it to `branchLooksBroken` (Extend parent > Breaks only; Cap generators can use the same flag). Skeletons without the attribute fall back to the old thick-tip heuristic.
* Inspector: subgroups `Early` and `Late` are coupled to the `Noise` section (`COUPLED_PARENT_SECTION`) and render as sub-heads.


## Welding (R12) — `src/generators/weld/`, `nodes/generators/weldApply.ts`, `geometry/tubeMesher.ts`

Skin > **Welding** (Branch and Root; ids `weldEnabled`, `weldKeep`, `weldKeepFailed`, `weldForceRays`, `weldOffset`, `weldSpreadAmount/Upper/Lower`; the ring count comes from Segments > Length > `weldScalar`) fuses the base of a child into the skin of its parent. It is **off by default**, so old projects load and look exactly as before.

* **Pure module** `generators/weld`: `surface.ts` (parent skin as a signed-distance surface: `coneSurface` = procedural cone around the parent axis at the attachment with taper, `tubeSurface` = ray cast against the parent's frusta around the attachment, `sagScale` compensates the polygon sag of the parent), `solve.ts` (`solveWeld`), `keep.ts` (Keep helpers), `attach.ts` (`parentSurfaceFor`, `WeldMeshOptions`).
* **Solver.** For every column of the child's cross-section the column line (the child's own curved tube, evaluated on its centre line + ring frames) is traced from inside the parent until it leaves the skin (marching + Illinois refinement). Ring 0 is that closed loop, so it lies exactly on the parent surface at every angle (no gap); the next rings blend linearly (per column) to the plain child circle `Offset` x child radius beyond the last crossing, while the widening fades out with a smoothstep. A base the generator pushed out of the parent (Root sprouts, Sink) is extended backwards along its first tangent until it is buried again. Spread widens the base by `Amount + Upper scale x w_up + Lower scale x w_low`, where `w_up` / `w_low` are the components of the ring direction towards the tip / base of the parent; the widening is capped at 95 % of the parent radius so ratios up to ~0.8 always stay inside.
* **Gaps / faces.** The parent mesh is not cut: ring 0 sits on the parent skin (radius reduced by `sagScale(parentSides)` so the rim never floats above the flats) and the part of the child inside the parent is simply not meshed (the buried ring and the collar are replaced by the weld). Normals fade from the parent's skin normal (ring 0) to the child's own normal over the weld rings; V is computed per vertex from its arc length.
* **Failure** (`WeldFailure`): degenerate parent / child, the base is wider than the parent (`inside`), a column never leaves the parent along the child (`noExit`, ray miss), the weld part is longer than the child (`short`), the weld ends on an end cap of the parent (`cap`, only with Force ray casts), inverted base ring. **Keep failed** off removes the child (`StructureSkeletonBuilder.truncate`, so its own children never exist); on keeps it unfused (`weld` = 2).
* **Pipeline.** Generation (`branch.ts`, `root.ts`): after a child is grown, `weldChild` applies the Keep curve (x = attachment height as a 0..1 fraction of the z range of the parent structure), runs the analysis (`analyzeOnly`) on the child's spine and writes the per-point skeleton attributes `weld` (0 none / 1 welded / 2 failed but kept) and `weldSelf` (the parent is a branch of the same skeleton: sub-levels of one Branch node). `mergeSkeletons` copies them. Mesher: `buildTubeMesh` re-solves the weld on the real ring samples (radial count, section shape and LOD included) for branches with `weld` = 1 and splices the weld rings into the ring grid; if that solve fails the junction falls back to the old buried ring + collar. `StructureSkeletonBuilder` gained `branchView`, `setBranchExtra`, `truncate`.
* **Performance.** 5,000 welds cost ~0.4 s on top of the generation (analysis + meshing); the pure solver does 5,000 welds in ~0.2 s.
* Not covered here (see R13 below for blending, seam lighting, squash and radius options): splits (done in R14, see below), displacement of the weld rings (R15: the weld vertices are not displaced), parent section shapes other than round (the cone / tube skin is round).

## Weld blend, Squash and Skin radius (R13) — `src/generators/skin/`, `generators/weld/{blend,squashSurface}.ts`, `geometry/tubeMesher.ts`, `materials/ktShader.ts`

* **Pure modules.** `skin/radius.ts` (`skinBaseRadius` = spine radius + Absolute + `+ % of parent` x parent radius, `Clamp to parent`, Clamp Min / Max; `compensateTipRadii`; `exceedsKillRatio`), `skin/squash.ts` (`squashRatio`, `squashRadius`: elliptical section, short axis at Rotate, Amount 1 = 10 % of the radius), `skin/seam.ts` (`seamWeight`, `bendPushFactor` for Smooth and `leanNormal`, the **only** normal-lean helper: Light seam reduction leans toward the spine, the weld Lighting curve leans toward the spine or away from it), `skin/visibility.ts` (`isSpineOnly`, `branchVisibility`, threshold 0.5), `weld/blend.ts` (`weldBlendValue`, `lightingNormal`, `lightingValue`), `weld/squashSurface.ts` (`squashSurface`: decorates the parent skin so weld rings land on the flattened profile).
* **Radius options** are applied in `nodes/generators/spine.ts` while the spine is grown (children attach to the final radius): base radius -> tip compensation -> Clamp. Length kill ratio removes a whole branch (length / base radius). The Trunk has no parent-relative options; Branch / Root get `+ % of parent` and `Clamp to parent`. Roll, Smooth, Light seam reduction and Squash exist on every skin (also Cap / helpers).
* **Squash and Roll.** The mesher multiplies the ring radius by `squashRadius(angle)`; Roll rotates the frames. `emitStructureOutput` writes `SQUASH_ATTR` / `SQUASH_ANGLE_ATTR` (Rotate + Roll) on the skeleton so a welded child sees the squashed parent (`parentSurfaceFor` wraps the cone / tube skin with `squashSurface`). `readSquash` in `nodes/generators/common.ts` is the single reader of the two Squash parameters.
* **Weld blend (texture).** For welded branches the mesher writes `MeshData.weld = { blend, parentUv, style }` (vertex attributes `weldBlend` 0 parent side .. 1 child, monotonic; `weldParentUV` = the UV the parent's bark has at the vertex x Texture scale; `weldStyle` = contrast, noise, active flag). Texture extends the blended region up the child (in child radii). `mergeMeshData` fills neutral values for meshes without the channels, `meshDataToGeometry` / `sceneSync` upload them. Export ignores them (a baked atlas has no parent sample).
* **Shader** (`KtPhysicalMaterial`, `WELD_FRAGMENT`): `map_fragment` samples `ktSampleBark` -> the child's UV and (only where the active flag is set) the parent's UV through `textureGrad`, mixed with a `smoothstep` whose width comes from Contrast and whose edge is bent by Noise (sine waves with whole periods per U tile, so the line closes without a seam). Meshes without the channels read `defaultAttributeValues` (inactive). The attributes exist only in the main (colour) material, so depth / shadow passes and the wind chunk are untouched.
* **Lighting curve.** Over the blend value (left = parent side, right = child): 0 = normals follow the spine, 0.5 unchanged, 1 = outward from the spine (`lightingNormal`).
* **Type.** `skinType` (`polygons` / `spine-only`; the two SubD entries are disabled "(not yet available)"). Old projects with `spineOnly: true` are migrated to `skinType: spine-only` (`generationMigration.ts`); `isSpineOnly` still honours the legacy flag for scripts. **Visibility** is a curve over the position of the attachment on the parent (sub-levels of one node use the node's own skeleton): above 0.5 the branch gets geometry, otherwise `skipBranch` drops the mesh but the branch (and its children) stay in the skeleton.
* Tests: `tests/skinR13.test.ts`.

## Splits, Extensions and Caps (R14) — `src/generators/split/`, `nodes/generators/{spine,branch,distribution,splitConfig,instanceNodes}.ts`, `geometry/tubeMesher.ts`

* **Pure module** `generators/split/`: `splitMath.ts` (`splitRadii` pipe model `r1^2 + r2^2 = R^2` with Balance and Expand, `computeSplit` = the two sides of a split with Spread, Smooth > Inner / Outer, `selectsOpenEnd`, `applyExtensionSpread`, `extensionRadiusFactor`, skeleton attribute names) and `openEnds.ts` (`collectOpenEnds(skeleton, selector?)` -> position / direction / radius of every open end).
* **Split geometry.** `growSpineIntoBuilder` decides with `rng.fork('splits' + Seed)` (Skin > Splits > Chance; Seed changes only the decision and the plane roll). The branch tip keeps its radius `R` and two short *side* branches (5 rings) are added as its children: both start parallel to the parent, offset toward their own side so the outer wall is tangent to the parent wall (Inner shrinks the offset, 1 = no crease), then the direction eases to the side angle over Outer x the side length. Side 1 leans away from the centre of the tree (horizontal direction from the Z axis to the tip, jittered by the seeded roll), Side 2 toward it. Both sides are flagged `openEnd` and carry `splitInfo` bits (`SplitFlag`: Parent, Side1, Side2, Fat); the branch that splits is flagged Parent and is not an open end itself. Legacy *Spine > Splits & Termination* forks (auto daughters) are unchanged and independent.
* **Extend parent.** `extensionPositions(type, count, broken, splitFlags)` (`generators/common/extend.ts`): Any = every open end (the parent of a split has none, its sides do), Split 1 / Split 2 = that side, Skinny / Fat = thinner / thicker side (equal radii: Side 1 is fat), Breaks only = branches that ended in a break (not split sides), Bottom = the base of any parent. Valid under a Branch **or Trunk** parent. `PreparedParentBranch.splitFlags` carries the parent's `splitInfo`.
* **Seamless extensions.** An extension (and every split side) is flagged `extensionInfo`: the mesher adds no buried ring, no collar and no base cap for it (it starts exactly on the parent end ring with the parent radius), and the spine starts with the parent's end position, direction (no pitch / spread / sink) and radius. Branch > Extensions: Spine > Length scale, Spread (separates several extensions on one open end: an ease-in lateral push, profile curve along the length; the base direction stays the parent's), Skin > Radius (value + curve = factor `lerp(1, c(f)/c(0), value)`, 1 at the base), Normal smooth (`extensionNormalSmooth`: normals at the base lean to the pure cylinder normal), Displacement scale (`extensionDisplaceScale`: multiplies the displacement of the extension; R15 reads the same attribute), UV > Extension style (list only, see below). `mergeSkeletons` copies all four attributes between sub-levels.
* **Cap.** `evaluateCap` uses `collectOpenEnds`: one cap per open end (breaks and split sides); Extend parent restricts the choice (Bottom caps the base of every branch); *Count* is hidden for Cap. Branches without open ends get no cap (the tip dome of the mesher still closes them).
* Tests: `tests/splitsR14.test.ts`.
