# Kekenik Tree – User Guide

## Quick start (5 minutes)
1. **Open a species.** On start the Welcome window lists presets – click one. Or use *Window ▸ Layout ▸ Library (presets)* and double-click a card (or drag it into the viewport).
2. **Look around.** Viewport: LMB orbit, MMB / Shift+LMB pan, wheel zoom, `F` frame, `Home` reset camera, `Alt+1…8` view modes (shaded, wireframe, normals, AO, skeleton …).
3. **Tweak.** Click a node in the *Generation* graph; the *Properties* panel shows its parameters. Hover a label for a description. Examples: Trunk ▸ *Length*, Branch ▸ *Number*, *Spread*, *Gravity*, Leaf ▸ *Width / Height*. `Shift+R` randomises the seed.
4. **Wind.** *Window ▸ Wind & Timeline*: set direction / strength and press play. Per-node *Wind* tabs set how much a trunk, branch or leaf reacts.
5. **Export.** *File ▸ Export…* (`Ctrl+E`) → format GLB, LOD levels, texture size, AO bake, impostor → *Export*. The result list verifies the file.

## Graph basics
Children grow upward from the parent. `Tab` / double-click adds a node; drag from a port to connect; `Del` deletes; `Ctrl+C/V/D` copy/paste/duplicate branches; `F2` renames; `A` fits; `Space+drag` pans.
Node types: **Trunk**, **Branch**, **Root**, **Spine**, **Split**, **Knot** (structure) · **Leaf**, **Frond**, **Cap**, **Cluster**, **Decoration**, **Mesh** (surface) · **Forces** · **Material** · **Wind**.

## Parameters
Every row has: label (hover for help) · slider/number · optional `%` toggle (random variance) · optional curve button (vary along the parent). Orange bars mark modified values. A yellow `!` marks counts that will be slow.

## Materials
Presets ship neutral generated maps. To use your own, open the **Materials** panel, select *Bark* or *Leaf* and drop an image on the *Color* (and *Opacity*, *Normal* …) slot. Maps are embedded in the `.ktree`.

## Library
* Search box and category chips filter the grid; *Save Current…* stores the open project as a user preset (local browser storage); *Import* / *Export* read/write `.ktree` files; the × button deletes a user preset.

## Projects
`Ctrl+N/O/S`, `Ctrl+Shift+S`. Unsaved work is autosaved and offered for recovery after a crash. Templates (*File ▸ Export Node Template…*) share sub-graphs.

## Preferences (Edit ▸ Preferences…)
UI scale · navigation scheme (Kekenik, Maya-like Alt-drag, Blender-like MMB) · autosave delay · performance mode (Low viewport preset) · language.

## Help
`?` or `F1` – shortcut cheat sheet · *Help ▸ Interactive Tour* · *Help ▸ Welcome Screen*.

## Troubleshooting
* Blank viewport: the browser needs WebGL2. Enable hardware acceleration.
* Slow: enable *Performance mode*, lower *Number* counts (yellow `!`), use LOD preview.
* A crash page shows a log – use **Copy log** and **Reload** (autosave restores your work).
