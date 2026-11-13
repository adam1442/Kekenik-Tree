# Node mode

Toolbar **Mode → Node** (or the second icon in the Properties header) edits **one generated instance** (a trunk, a
branch with the split daughters it produced, a spine) while everything else stays procedural. **Generator** edits the
global parameters; **Freehand** is a stub (button stays, tooltip + status message "Freehand mode is not available yet").

## Instance identity
`InstanceKey = FNV-1a(generatorNodeId, parentInstanceKey, indexInParent, subLevel)` (`src/instances/keys.ts`).
It contains no parameter value, so changing Length, Gravity, ... keeps every key. The key changes only when the
generator, the parent instance or the placement slot changes. Every generator that grows spines through
`InstanceScope` (`src/instances/scope.ts`: Trunk, Branch, Spine, first-generation Trunk/Spine/Branch on the Tree disc)
emits an `InstanceTable` next to its skeleton (`StructureData.instances`, `SceneSkeleton.instances`):

| array | meaning |
|---|---|
| `key`, `parentKey`, `index` | identity, parent key, placement slot |
| `parentInstance`, `parentBranch` | row in the parent's table / branch id in the parent skeleton |
| `branchStart/Count`, `pointStart/Count` | skeleton ranges owned by the instance |
| `baseU` | procedural position along the parent (before overrides) |
| `flags` | bit 0 hidden |
| `bounds` | min/max xyz (after forces), used by picking |
| `branchToInstance` | skeleton branch -> row |
| `pruned` | keys of pruned instances (no row) |

Mesh triangle ranges are **not** tracked (the tube mesher merges all branches): picking refines against skeleton
capsules instead of triangles.

## Overrides
```
InstanceOverride { key, anchor?{parentKey,index}, params: Record<paramId,{mode:'set'|'offset'|'scale', value}>,
                   transform?{positionAlongParent, rotation, roll, lengthScale, radiusScale}, hidden?, pruned? }
```
Stored on the generator node as the reserved param `__overrides` (JSON string `{v:1, items:[...]}`; bare arrays of
v0 are migrated, malformed items dropped). Because it is a normal param, save/load, undo/redo, dirty tracking, the param
hash and the engine cache key need no special cases.

Applied **inside the generator, before growth** (so children follow the modified parent):
* `params` overrides: the instance's params are patched and the spine config recompiled (cached per override signature).
* `transform`: position offset (clamped 0..1), rotation (azimuth around the parent axis), roll, `lengthScale`,
  `radiusScale` (passed to `growSpineIntoBuilder` via `SpineSpawnSpec`).
* `pruned`: the instance is not grown (children vanish); `hidden`: grown but skipped by the tube mesher and by the overlays.

Orphans (instances that no longer exist, e.g. `Number` was reduced) are **listed, never applied elsewhere**:
Properties → Node bar shows "n orphaned overrides" with **Re-anchor** (moves each to the nearest free slot of the same
parent, max 2 slots away; `reanchorOverrides`) and **Discard**.

All writes go through `OverrideEditor` (`src/instances/editor.ts`) = `graph.setParam(.., merge)`; a drag merges into one
undo step, `commit()` seals it.

## Gizmo handle -> parameter mapping
Registered per node type with `registerNodeModeMapping(nodeType, mapping)` (`src/instances/mappings.ts`); `null` hides a
handle; a function can depend on `{rootLevel}`.

| Handle (look) | Trunk (on Tree disc) | Trunk (on parent) | Branch / Spine |
|---|---|---|---|
| **Position** (orange disc at the base, slides along the parent spine) | hidden | `transform.positionAlongParent` | `transform.positionAlongParent` |
| **Rotation** (orange arc around the parent axis) | `transform.rotation` | `transform.rotation` | `transform.rotation` |
| **Angle** (large arc between parent axis and branch) | param `lean` (offset) | param `spread` (offset) | param `spread` (Start angle, offset) |
| **Roll** (small arc around the branch axis) | `transform.roll` | `transform.roll` | `transform.roll` |
| **Length** (yellow tip disc) | `transform.lengthScale` | same | same |
| **Bend** (knob at 55 % of the branch, drag up/down) | param `curvature` (offset) | same | param `gravity` (offset, -2 per branch length) |
| Radius | Properties panel (`radius` param or `transform.radiusScale`) | | |

Modifiers: **Shift** snaps (5° angles, 0.05 length ratio, 0.02 position); a numeric readout follows the cursor.
Gizmo size is constant in pixels; arcs are drawn depth-tested plus a faint always-visible ghost.
Local/World space: only the local frame exists; the Gizmo toolbar space switch is not implemented yet.

## Picking and navigation
Click = pick (broad phase over per-instance AABBs, refine against skeleton capsules with a 6 px tolerance;
120 000 instances pick in a few ms), hover highlights the spine in light pink, **Shift** adds, **Ctrl** toggles,
**Alt+drag** = marquee, **Esc** clears, **↑** selects the parent instance, **↓** the children, **H** hide, **Del** prune.
Selecting an instance selects its generator node in the Generation panel; hidden instances and disabled / bypassed
nodes are not pickable; the View mode has no influence on picking.
