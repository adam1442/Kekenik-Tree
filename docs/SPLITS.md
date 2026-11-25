# Splits, open ends and extensions

This page explains how a branch forks, how the fork is meshed, and how other generators continue it. The parameter list itself is in
[PARAMETERS.md](PARAMETERS.md) (Skin > Splits, Generation > Extend parent, Branch > Extensions); the code map is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## One engine

Trunk, Branch, Root and Spine share one split engine. A spine is planned in `growSpineIntoBuilder` (`src/nodes/generators/spine.ts`), the
geometry of the fork comes from `planSplit` (`src/generators/split/splitModel.ts`), and the skin from the fused crotch mesher
(`src/geometry/splitCrotch.ts`, called by `tubeMesher.ts`). There is no second fork path: old projects that used the former
"Tip behavior = Fork" settings are mapped to Skin > Splits when they load (`generators/split/legacyMigration.ts`).

## Topology

A spine that splits keeps its tube up to a point, then both halves share one skin (a "pair of pants"). The two halves end in open ends.

```
             open end 1            open end 2
            (Side 1, N/2)         (Side 2, N/2)
                 ___                   ___
                /   \                 /   \
               |  1  |               |  2  |      half rings: N / 2 vertices each
                \   /                 \   /
                 \  \                 /  /
                  \  \_____   _____/  /           crotch: rings 0..K, the two arcs
                   \       \ /       /            meet in one shared vertex C
                    \       V       /
                     \      C      /
                      \           /
                       \_________/                transition start: ring 0 = last
                       |         |                ring of the parent (N vertices)
                       |  tube   |
                       |  (N)    |                the true tube: where ordinary
                       |         |                children are placed
                       +---------+
                          base
```

* **N** is the radial vertex count of the parent. A splitting spine always has an even count of at least 6; each half ends in a ring of
  N / 2 vertices. A second split on a half halves the count again, so use a high Resolution on the first spine (32 supports three levels).
* The skin is one manifold surface. The only open boundaries are the real open ends (and the base unless Cap closes it).
* The true tube is the part of the parent below the transition. That is "the spine" for every generator that hangs on a split.

## Figure-8 cross-section (Skin > Split shape)

The rings of the shared transition used to be the outer arcs of two circles that meet in a cusp at the pinch points A and B. With any
**Split shape** value set, each inner ring is a smooth figure-8 (`generators/split/forkOutline.ts`, called by `crotchMesh.ts`). The
topology is unchanged (N vertices per ring, shared pinch vertices A / B, two open ends of N / 2); only the shape of the rings changes.
Ring 0 (the parent's real last ring) and the last ring (two exact circles) are never touched.

```
   lobe 1 circle            fillet (concave arc, radius = Valley radius x lobe)
      ___                      |
    /     \        A  ______.---'---.______  A               one ring at mid transition:
   |   1   |-------+--'   neck (waist)   '--+---|   2   |    outline = circle 1 + fillet + circle 2 + fillet,
    \     /         '------.______.------'         \     /    G1 at every joint, A / B at the neck points,
      ---          B   <- ridge on the axis A -> C ->           vertices at equal arc length per half
```

| Parameter | Effect (default = neutral = the former outline) |
| --- | --- |
| Waist (1) | neck chord at mid transition / diameter of the narrower lobe. A narrower neck is made by moving the lobe circles apart (virtual separation, only adds area; the ring is then scaled down so its area follows the pipe-model blend). |
| Neck swell (0) | radius swell up to this fraction, peak at about 55 % of the transition, paid by the area budget; zero at both ends. |
| Valley radius (0) | rolling-ball fillet radius as a fraction of the smaller lobe radius; fades to 0 at the open ends; normals across the valley are smooth. |
| Ridge (0), Ridge length (2 R) | raised bark ridge on the pinch axis, height as a fraction of the smaller lobe radius, width about the valley radius, fades into the parent over Ridge length and into the crotch point. |
| Stretch (1) | elongation of the section along the divergence axis, peak at about 45 % (flat over the first 15 %). |
| Ease (0) | 0 = smoothstep separation, 1 = the lobes stay merged longer and then pinch off suddenly. |

Any non-neutral value also switches on the **curvature-adaptive ring spacing** (`splitRingParam`: rings are 35 % denser at both ends
than a uniform spacing) and raises the least number of transition segments from 5 to 12 (`SPLIT_SHAPE_MIN_SEGMENTS`) so the neck is
resolved. The first 15 % of the transition is flat (G1 with the parent: the section normals differ from ring 0 by less than 2 degrees).
The valley also gets a darker ambient-occlusion value (`valleyAoFactor`, vertex AO, exactly 1 at both ends).

## Open ends

An open end is the free end of a broken branch or of one side of a split. Everyone reads the same type: `OpenEnd` (`splitMath.ts`), which
`collectOpenEnds` fills as `SkeletonOpenEnd` (`openEnds.ts`) from the skeleton attributes `openEnd`, `splitInfo` and `radialSides`.

| Field | Meaning |
| --- | --- |
| `position`, `direction`, `radius` | the last ring of the branch |
| `side` | 0 = break, 1 / 2 = Side 1 / Side 2 of a split |
| `kind` | `fat` or `skinny` (split ends only; equal radii: Side 1 is fat) |
| `frame` | orthonormal frame around `direction` (ring phase) |
| `uTiles`, `uStart` | the U tiles the half carries around its tube |
| `radialSides` | ring vertex count a consumer must use (N / 2 on a half) |

Consumers: Break (the end it leaves), Extend parent (`selectOpenEnds`), Cap (`evaluateCap`), Root (Bottom), the claim list
(`endClaims.ts`, which stops a Cap from closing an end that a Branch already continues) and the **Show open ends** viewport overlay
(`src/viewport/debug/openEndGlyphs.ts`).

### Show open ends overlay

Viewport toolbar / View menu > **Show open ends**. Off by default; nothing is built or drawn while it is off. Each open end is a ring
(end radius) with an arrow along its direction and one or two ticks for its index (1 / 2):

| Colour | Kind |
| --- | --- |
| orange | fat half |
| cyan | skinny half |
| red | break |
| green | bottom (the base of a spine that grows from nothing) |

## Lineage tags

Every spine carries `spineOrigin` (`generators/split/lineage.ts`), copied by `mergeSkeletons`:

* `primary` - an ordinary spine, including the one that splits;
* `splitHalf` - one of the two fused halves;
* `extension` - a spine that continues an open end (Extend parent, Cap, a virtual split).

A missing attribute means `primary`, so old data keeps working. Root uses it to anchor only on ground bases
(`isGroundBase`: `primary`, no parent branch).

## A split is one spine

For every generator under a splitting Trunk, Branch or Root, the split counts as ONE spine:

* Branch, Split, Leaf, Frond, Decal, Fin, Knot and the other placement generators run on the primary spine only, cut where the shared
  transition starts (`nodes/generators/fusedParent.ts`: `createFusedParents`, `splitHalfIds`). They are never repeated for the two halves.
* The halves are parents only for **Extend parent** and **Cap**, which continue an open end.
* The **Split** generator has **Split parents only**: it forks only parents that already split (Skin > Splits) and never the halves.

## No gap at a junction

* Children sit on the true tube, never inside the transition or on a lobe centre line, so they weld to a real tube surface.
* The mesher publishes the real end ring of each half (`publishLobeEndRings`). The first ring of an extension or a cap is snapped onto it
  vertex for vertex (`geometry/ringSnap.ts`, `snapRingToPolygon`; different ring counts land on the polygon), so the skins meet with no
  open edge. The tests check this with `meshQuality` and with edge counts (zero boundary edges, no edge shared by three triangles).

## Parameter semantics (short)

* **Chance** - probability that a spine forks at its tip. **Seed** re-rolls only the split decisions.
* **Balance** - moves cross-section area between the halves; the pipe model keeps `r1^e + r2^e = R^e` (Area exponent `e`, default 2).
* **Side 1 / Side 2** - angle of each half; the fat half bends less so the lateral forces balance.
* **Expand** - widens one half. **Smooth > Inner / Outer** - the valley and the shoulders (Inner 0 is the only place a hard crease is allowed).
* **Fork type / Dominance / Lateral chance / Included bark** - see *Natural fork behaviours (T10)*.
* **Down bias** - tilts both halves toward gravity (Root default 0.4).
* **Extend parent** - continue `any`, `split-1`, `split-2`, `skinny`, `fat`, `breaks-only` open ends or the `bottom` of the parent.
  **Count** 2 makes a fused Y (a virtual split), 3 or more a bundle on a Fermat spiral with area-rule radii.

## UV rules (even tiles)

* The U tile count around a splitting branch must be even (at least 2). An odd count is raised to the next even number and the node
  reports a warning; set UV > U to an even value to silence it.
* Each half carries half of the tiles (`uTiles`, `uStart`), so the texture keeps its scale across the fork. The two pinch vertices of the
  crotch sit on tile boundaries, and V continues from the parent by arc length of the shared axis.
* An extension in Automatic UV style continues the half's mapping.
* SpeedTree rule "U tiling must be divisible by two": the mesher raises an odd (or fractional) tile count of a splitting parent to the next
  even number (`evenTiles`: 3 -> 4, 5 -> 6, 2.2 -> 4, minimum 2) instead of splitting it into floor / ceil tiles, because two unequal halves
  would need different V scales and would shear the texture across the fork. The same rule is the warning on the node (Trunk / Branch / Root
  > Skin > Splits): *"the U tile count of N splitting branch(es) was odd and has been raised ..."*. Locked / patched mappings keep their own
  tiles and the extension then keeps its own mapping.

## Bark flows through the fork (T09)

* **Crotch displacement.** Every crotch ring 1 .. last is displaced with the SAME displacer and the parent's own coordinates: outline
  column `j` takes parent vertex `(j + phase) mod N` as U (`dv.u`), the arc length is the parent's last ring plus the crotch axis arc
  (`s`, `sLineage`), lineage / branch id / circumference / U tiles are the parent's, the radius blends from the parent's to the half's
  (crotch smoothstep). All sources are evaluated (Bark, Main, Fine, Shape, Flares). Ring 0 is the parent's real, already displaced ring;
  a splitting parent has no tip, so its last ring is no longer faded to zero. The offset moves along the outward outline normal and the
  shared axis; normals are built from the displaced faces (the open-end ring keeps them, it no longer takes the analytic cylinder normal).
* **Extension of a half.** A half publishes a pattern frame (`LobeContinuation`: lineage, arc length at the open end, circumference, U
  tiles / offset, `u0` and `span` = half of the parent's U range). An extension that continues a displaced half uses it, never fades in
  (`continued = false`) and evaluates the identical displacement at the shared ring (tested to 1e-7). The merged valley vertex of the open
  end is ONE vertex for two pattern columns (parent vertex `phase` and `phase + N / 2`); the extension of half 2 evaluates its column 0
  there with the pattern of the other half, a single-vertex difference.
* **Shared ring indices.** The extension's frames are rolled so its vertex 0 lies on the half's end-ring vertex 0 (same winding). When
  both are meshed into the same accumulator (extension in the same skeleton: `subLevel`), the extension's first ring IS the crotch's
  open-end ring: the mesher emits one ring (positions, normals, UV, wind, colour continuous, no duplicate vertices). An extension built by
  another node keeps the positional snap (`snapRingShifted`, exact for equal counts, otherwise the closest point on the polygon).
* **Ring count.** An extension that continues a half has exactly the half's ring count (N / 2 of the parent's real N) at every LOD and
  displacement subdivision, whatever its own Resolution says (`tests/splitContinuity.test.ts`, LOD 0 .. 3).
* **Colour / AO.** The vertex colour blends from the parent's last ring into the half's own generation colour with the crotch
  smoothstep; the valley AO of T08 is unchanged.

## Natural fork behaviours (T10)

All variants reuse the same pair-of-pants topology: only the radii, angles and junction shape of `planSplit` change, so every fork stays
watertight and keeps two open ends (one `fat`, one `skinny`) for Extend parent.

| Parameter (Skin > Splits) | Effect (default = neutral = the former Y) |
| --- | --- |
| Fork type (Y) | `Y` = symmetric fork (Balance + two Spread angles). `Lateral` = the fat half continues the parent with a kink of 20 % of its Spread, a thin side branch (the fat half takes 88 % of the area, the side branch radius is about 0.35 R) leaves at its full Spread. The junction gets a neck swell, a ridge and a valley fillet automatically (`resolveSplitSettings`, never lowers a value you set). |
| Dominance (0) | Dominant leader. Moves area towards the fat half (up to 85 %) and shrinks its deviation to 25 % of its Spread; the skinny half leaves at its full Spread with a smaller radius. `r1^e + r2^e = R^e` still holds. The deviation of the fat half never grows with Dominance (`dominantSplit`). |
| Lateral chance (0) | Fork type Y only: probability that a fork is lateral; one draw per fork from the Splits seed (`decideSplitMode`, stream `split:mode`), so a tree mixes both. |
| Included bark (0) | Skin > Split shape. Narrow V-shaped crevice with a ridge: small valley fillet, narrower neck, ridge and a darker, narrower valley AO (`valleyAoFactor`, down to 0.22). |

Dominance, Lateral chance and Included bark have variance (own forked streams `var:dominance`, `var:lateralChance`, `var:includedBark`).
Down bias still applies after the angles, so a half never points higher than its parent. The virtual split (Extend parent Count 2) is always a plain Y.

## Quality checks

`meshQuality` (`src/geometry/meshQuality.ts`) is the QA report used by the tests: boundary and non-manifold edges, degenerate triangles,
NaN count, smallest triangle angle, largest UV stretch, duplicate vertices (UV seams excluded), the largest dihedral angle and the
normal jump near junctions. The thresholds the tests assert: watertight except the declared open ends, no degenerate triangle, no NaN,
junction normal jump under 25 degrees (except Smooth Inner = 0).

## How to extend

* A new consumer of open ends: call `collectOpenEnds(skeleton, selector?)` and use `radialSides` for the first ring. Do not copy the type.
* A new generator placed on a parent: iterate the parent through `createFusedParents(parent)`; skip `halves`, use `prepare` for the true tube.
* A new split parameter: add the ParamDef next to the other `splits*` rows (`nodes/generators/params.ts`), read it in `splitConfig.ts`, and give
  it its own forked RNG stream in `splitVariance.ts` so changing it never changes another feature.
* A new open end kind: extend `OpenEndSelector` / `selectsOpenEnd` and the glyph colour table in `openEndGlyphs.ts`.

## Known limits

* Trifurcation (three lobes, Extend parent `Split 3`) is not implemented (T10 partial): it needs a nested split on a half with a near-zero second transition.
* A second and third split need Resolution 16 / 32 (the count halves per level; the minimum for a split spine is 6).
* The crotch pattern uses the parent's `t` (maturity curve along the branch) at ring 0 for all crotch rings, the extension its own `t`:
  a Maturity curve with a steep start can differ by its slope at the extension's first rings.
* A splitting extension of a half with an odd N / 2 gets N / 2 + 1 sides (a split needs an even count): that ring is snapped onto the
  polygon of the half, not vertex-exact. The dome under an extension stays in the mesh (hidden; three triangles on its base edges when the
  skins are welded by position).
* Odd parent U tile count + virtual split (Count 2): the stub's tiles are raised to even by the mesher, a possible small U jump at the stub start.
* The bone chain of an extension is whatever the wind pipeline derives; the first bone is not forced onto the parent's last bone.
* Sub-levels of one Branch node (*Generations* > 1) that contain splits still remap the half's parent id like regular children (a pre-existing limit); their wind then falls back to the upstream skeleton.
* Leaves, fronds, decals and fins are placed on the primary spine only (below the fork); to cover the halves, continue them with Extend parent.

## Wind

The two halves of a split and every extension are continuations of the limb they attach to, so they inherit its wind (`computeSkeletonWind` in `src/geometry/windAttributes.ts`):

* The full vector `(wind0, wind1, wind2)` and the phase are copied exactly at the attach point; the host's wind level (not the generation) keeps growing: `w[L](t) = a + (1 - a) * t^1.5`. Equal to the parent at `t = 0`, never decreasing, never above 1.
* The host is read from the skeleton's own output when it lives in the same skeleton (halves, virtual-split extensions: flag `windHost`; every branch of a Trunk) and from the upstream skeleton otherwise (an extension that continues the open end of another node). Branches are processed parents first.
* The crotch rings blend from the parent's last ring into each half's own wind with the crotch smoothstep; the last ring and the end caps equal the half's end, so an extension that continues it moves with it. Regular children are unchanged.
