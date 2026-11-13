# Cutout attachment: Straighten axis, base pivot and anchor frames

Source of truth: `src/materials/cutouts/frame.ts` (axis, anchors, UV -> local), `src/geometry/cardPose.ts` (deformation),
`src/geometry/rigid.ts` (`composeFrame`), `src/geometry/attachments.ts` (`AttachmentSet` builder / queries),
`src/nodes/generators/cutoutPlacement.ts` (child placement shared by Leaf, Mesh, Decoration).

## Data (stored in `CutoutMesh`, shared by High / Med / Low and imported LODs)
| Spec name | Stored as | Notes |
|---|---|---|
| `axis.points` | `straightenAxis: [u,v][]` | polyline, first point = base (attachment pivot), last = tip |
| `axis.mode` | `straightenLinear` (true = `linear`) | linear = straight line first -> last point; curve = full polyline |
| anchor position | `anchors[i].uv` | |
| anchor `direction` | `normalize(handleUv - uv)` (in card metres) | the white handle in Edit Mesh |
| anchor `roll`, `scale`, `name`, `tags` | optional fields | roll in degrees, scale default 1 |
| anchor `axisT` | derived (arc length projection / axis length) | anchors are kept ordered by `axisT` |
| `pivot` | synchronised with the axis base on Done / load | |
| `attachVersion` | 1 | absent = old project -> migrated silently |

Defaults / fallback (never crashes): missing or degenerate axis = bottom-centre of the outline bounding box straight up to
the top-centre; no anchors. `ensureCutoutAttachmentData` runs when the library meta is read and when a project is
normalised on load; it is idempotent.

## Local frame of an instance (metres)
* UV -> metres: `(u * w, v * h)`. Placed cards: `w = node Width * mesh Scale`, `h = node Height * mesh Scale` (node
  size curves / variance / anchor scale are already inside Width / Height / Scale of the node). Standalone (Mesh
  instances, Meshes panel): `boundsMeters * mesh Scale`.
* Origin `O` = axis base. `+Y` = tangent of the first axis segment (base tangent). `+Z` = card normal (texture front),
  `+X = Y x Z`. `axis.tipDirection` (overall base -> tip) is exposed on `CutoutFrame` for options.
* **Straighten**: a vertex becomes `(d, s)`: `s` = arc length of its projection onto the axis (extended linearly beyond the
  ends), `d` = signed distance to the right of the axis direction. Local position = `(d, s, 0)`: the authored curve is a
  straight line along +Y; the texture stays undistorted because UVs are untouched.
* Generator deformation (`bend`, `twist`, `fold`, `curl`; droop is part of bend) is applied from the base on the
  straightened coordinates (`cardPointAt`). The base stays fixed. Anchor frames are computed with the SAME function
  after deformation, so grandchildren follow the deformed card.
* Transform (Meshes panel): `Flip` mirrors local axes (an anchor direction is mirrored with it, winding is reversed
  automatically for an odd number of mirrors, `Fix winding` toggles it again), `Flip normals` negates normals.
  `Orient` only applies to imported 3D meshes (authored cards are generated in generator space).
  The idle label `X Y Z` means "no flip".

## Placement pipeline (Leaf, Mesh, Decoration)
1. Attachment: along-parent sample (spine point + tangent + normal) or a parent anchor frame.
2. Child base `O` = attachment point; `+Y` = growth direction (parent tangent rotated by Angle / Pitch / Yaw, or the
   anchor direction blended by `Align to anchor direction`, plus `Direction spread` cone); `+Z` = facing (Parent / Up /
   Outward / Sun, or the anchor `up` with `Roll mode`); node `Roll` rotates around the axis only.
3. Scale = node Scale x variance x curves x post scale x anchor scale (`Use anchor scale`) x mesh Scale (in the metric).
4. Deformation (see above), then frames, then wind weights: flutter weight grows with `axisT`; a child on an anchor
   inherits `w2 + (1 - w2) * axisT * 0.8`.
5. Output: mesh + `StructureData.attachments` (`AttachmentSet`) + skeleton with one 2-point branch per instance
   (`instanceBranch` maps branch -> instance).

Decoration: the cutout's base pivot stands on the surface point (`radius + offset`) instead of the card centre.
Mesh instance: cutout assets use local `+Y` = growth, `+Z` = normal (other meshes keep `+Z` = direction).
Frond / Spine: not changed (ribbons already follow the spine).

## Placement controls (Generation tab > Placement)
`Attach to parent anchors` (Auto / Always / Never), `Anchor mode` (One per anchor / Cycle / Random / Specific index /
Specific tag), `Number per anchor`, `Anchor index`, `Anchor tag`, `Align to anchor direction` (0..1), `Direction spread`,
`Roll mode` (Anchor / Random / Node), `Use anchor scale`. Cycle / Random use the node `Number` per parent instance.
Auto with a parent that has no anchors falls back to the normal distribution.

## Queries
`ctx.getParentAttachments(instanceKey)` -> `AttachmentFrame[]` (position, direction, up, scale, anchorId, anchorIndex,
axisT, tags). Instance keys: `instanceKey(nodeId, parentKey, slot, sub)` (FNV-1a hash). `composeFrame(parentInstance,
anchor, childBase = identity)` = `parent * anchor * inverse(childBase)`. Graph rule: Leaf / Mesh / Decoration expose a
`children` port; Frond / Spine / Cluster / Cap accept a parent but do not use anchors.

## Edit Mesh
* Base marker (yellow diamond "attach"), tip arrow on the axis, anchors with direction arrows and index labels,
  selected anchor ring. Drag the anchor to move, drag the white handle to set the direction.
* "Anchor" row below the canvas: Angle (deg from axis up), Roll, Scale of the selected anchor (undoable).
* Footer: base coordinates, axis angle, anchor count and warnings (axis < 2 points, base outside the outline,
  anchors off the mesh). `Attachment preview` toggle: the cutout planted on a sample stem with triads and child stubs.
* `Linear` is non-destructive (previously it sheared the outline); `Reset` restores the default axis.
* Done commits mesh, axis, anchors, pivot in one `lib.edit` (one undo step) after `ensureCutoutAttachmentData`.

## Viewport
`Show > Attachment frames`: triads (X red, Y green = growth, Z blue) at each instance base and at each anchor, constant
screen length (vertex shader), longer for selected nodes. Dev scene: `src/dev/cutoutAttachmentScene.ts`
(1 cluster -> 4 leaves -> 8 sub-leaves; frames coincide exactly with the child bases).
