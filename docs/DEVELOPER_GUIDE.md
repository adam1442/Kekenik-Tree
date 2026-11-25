# Kekenik Tree – Developer Guide

Setup, scripts, branching and commit style are in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first (layers, data flow, registries). Rules: TypeScript strict, no `any`, tokens in `ui/theme/tokens.css`, seeded RNG only, dispose Three.js resources.

## Add a node
Create `src/nodes/<family>/index.ts` exporting `nodeDefs: NodeDef[]` (auto-discovered by `registerDiscoveredNodes`). Define `type`, `category`, `ports` (`src/nodes/shared/ports.ts`), `params` (use the `section()` builders in `src/nodes/shared/builders.ts`) and a pure `evaluate(ctx, inputs, params)` that uses `ctx.rng` / `ctx.seed`. Parameter tooltips come from `src/graph/registry/paramHelp.ts` (add an entry per new `id`; `tests/library.test.ts` fails if any ParamDef has no tooltip). Regenerate `docs/PARAMETERS.md` with `WRITE_PARAM_DOCS=1 npx vitest run tests/paramDocs.test.ts`.

## Add a parameter widget
`src/ui/components/paramWidgetRegistry.ts` maps a `ParamDef.kind` to a widget factory (`registerParamWidget`). Widgets live in `src/ui/components/params/`.

## Add a panel
`registerPanel({ id, title, icon, component, defaultDock, minSize })` in `src/ui/panels/registerPanels.ts`; add its id to layout presets in `ui/docking/layoutPresets.ts` if it should appear by default. Dialogs use `FloatingWindow` (`showInfoDialog`).

## Add a force / exporter
Forces: `src/forces/registry.ts` + a `ForceDef` node in `src/nodes/forces`. Exporters: a writer in `src/export/writers/`, then a format option in `src/export/types.ts` and `exportService.ts`.

## Add a sample project
Save the project as `.ktree` (File ▸ Save), copy it into `public/Sample Projects/` and add one row (`id`, `file`, `name`, `category`, `description`, `tags`) to `SAMPLES` in `src/presets/samples.ts`. Vite copies the folder to `dist/Sample Projects/`; the file is fetched when the sample is opened or its thumbnail is rendered. `tests/presets.test.ts` loads every sample, round-trips it and evaluates it at LOD 0 and 3 (add the id to `SAMPLE_IDS` automatically through `SAMPLES`). Bump `BUILTIN_REVISION` in `presets/catalog.ts` when a sample file changes so cached thumbnails refresh.

## The empty default project
`defaultGraph()` (`src/app/project/defaultGraph.ts`) returns the Tree node and nothing else; it is used at startup, by File ▸ New and when the last document is closed. Tests that need a small complete tree use `tests/fixtures/starterGraph.ts`.

## Add a command / shortcut
`app.commands.register({ id, label, shortcut, run })` in `app/appCommands.ts`; reference it from `app/menus.ts` with `c('id')`. The cheat sheet (`?`) is generated from the registry.

## Add a preference
Extend `Preferences` + `sanitizePreferences` (`app/preferences.ts`), apply it in `app/installPreferences.ts`, add a row in `ui/onboarding/preferencesDialog.ts`.

## i18n
`t('English text')` (`src/i18n`). Other languages add key → text in `src/i18n/<lang>.ts` and register it in `TABLES`.

## Styles & the built-CSS guard
Every UI class is a `kt-*` name styled in `src/ui/theme/*.css` (all imported by `src/index.css`; a new theme file MUST be added there). The production build is a single `dist/index.html` with the CSS inlined, so a class without a rule ships silently unstyled. `npm run build:check` (build + `scripts/check-built-css.mjs`, also run in CI/deploy/release after the build) scans the built CSS against `scripts/css-contract.json`: every class listed under `components` must have a rule, every `kt-*` token used in `src/**/*.ts` must be styled or listed under `hooks` (pure DOM hooks / storage keys), and modern syntax (`:has()`, `conic-gradient()`), required design tokens and sub-path-safe `url()`s are verified. When you add a component, give its classes CSS and add them to `components`; `tests/cssContract.test.ts` runs the same check on the sources during `npm test`.

## Testing & profiling
`npm test` (vitest, jsdom for DOM tests). `Alt+P` toggles the evaluation profiler overlay. Long-run leak check: load every preset repeatedly (`Library`), watch `renderer.info` in the viewport stats.

## Realism QA harness
`src/qa/` holds pure metrics (no DOM, no three.js): `surfaceMetrics` (dihedral angles, softness index, normal variance per 10 cm patch, edge lengths, vertices per metre), `profileMetrics` (circularity, radius roughness, silhouette deviation of the trunk and the two largest branches), `forkMetrics` (7 cross-section stations per split: waist ratio, pipe-model area, valley curvature, simple outlines, ring 0 normal jump, open-end regularity) and `windSeamMetrics` (re-export of `auditWindSeams`). Run the whole-species report with `QA_REPORT=1 npx vitest run tests/qa --maxWorkers=2` (no npm script; it writes `qa/realism-report.md`, `qa/baseline.json` and the git-ignored `qa/out/` OBJ / SVG dumps; without the variable the report test is skipped). The metric definitions, the targets and the baseline are in `docs/REALISM_TARGETS.md`. Regenerate and commit `qa/baseline.json` whenever a task intentionally changes the geometry.
