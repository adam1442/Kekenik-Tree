# Contributing to Kekenik Tree

Thank you for your interest! Bug reports, ideas, documentation fixes and code are all welcome.

## Setup

Requirements: Node.js 20.19+ (see `.nvmrc`) and npm.

```bash
git clone https://github.com/adam1442/Kekenik-Tree.git
cd Kekenik-Tree
npm ci
npm run dev
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Vite development server |
| `npm run build` | Production build into `dist/` (single `index.html`) |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` (TypeScript strict) |
| `npm run lint` | ESLint |
| `npm test` | Vitest (unit tests and jsdom DOM tests) |
| `npm run licenses` | Regenerate `THIRD_PARTY_NOTICES.md` |

All of `typecheck`, `lint`, `test` and `build` must pass before a pull request is merged; CI runs them for you.

## Branching and pull requests

- Fork the repository and create a topic branch from `main`: `feature/<short-name>`, `fix/<short-name>` or `docs/<short-name>`.
- Keep pull requests focused. Describe the change and why it is needed, and fill in the PR template.
- `main` is deployed automatically to GitHub Pages, so it must always be green.

## Commit style

Use short, imperative [Conventional Commits](https://www.conventionalcommits.org/)-style subjects:

```
feat(nodes): add Frond curl parameter
fix(export): keep texture names unique in OBJ output
docs: describe LOD export settings
test(curve): cover tangent mirroring
```

## Code rules

- TypeScript `strict`; no `any` (use `unknown` and type guards); no commented-out code or leftover `console.log`.
- No UI framework: the app is vanilla TypeScript with its own small component, store and event utilities.
- **Determinism**: every random decision uses the shared seeded RNG so the same graph and seed always give the same plant.
- **Performance**: keep the UI at 60 fps — debounce, use dirty flags and caches, and dispose three.js geometries, materials and textures.
- Colors, spacing and font sizes come from `src/ui/theme/tokens.css`; icons are inline SVG you draw yourself.
- Everything must work offline: no CDNs, analytics or runtime network calls.
- Add new functionality through the registries (never by editing a central switch): nodes, panels, parameter widgets, commands.
- Pure logic needs unit tests in `tests/`.

## How to add …

### a node
Create `src/nodes/<family>/index.ts` exporting `nodeDefs: NodeDef[]`; it is auto-discovered by `registerDiscoveredNodes`. Define `type`, `category`, `ports` (`src/nodes/shared/ports.ts`), `params` (builders in `src/nodes/shared/builders.ts`) and a pure `evaluate(ctx, inputs, params)` that only uses `ctx.rng` / `ctx.seed` for randomness. Add a tooltip for each new parameter id in `src/graph/registry/paramHelp.ts` (a test fails otherwise), then regenerate the parameter reference:

```bash
WRITE_PARAM_DOCS=1 npx vitest run tests/paramDocs.test.ts
```

### a parameter widget
Register a factory for a `ParamDef.kind` with `registerParamWidget` in `src/ui/components/paramWidgetRegistry.ts`. Widget implementations live in `src/ui/components/params/`.

### a panel
Register it with `registerPanel({ id, title, icon, component, defaultDock, ... })` in `src/ui/panels/registerPanels.ts` so it can be docked, tabbed and floated. Dialogs use the shared `FloatingWindow`.

### an exporter
Writers live in `src/export/writers/` and are DOM-free: they receive the evaluated scene and return bytes. Wire the new format into the settings and dialog in `src/export/settings.ts` and `src/ui/panels/dialogs/exportDialog.ts`, document it in `docs/EXPORT_SPEC.md`, and cover it with a round-trip test like `tests/export.test.ts`.

### a command or menu item
`app.commands.register({ id, label, shortcut, run })` in `src/app/appCommands.ts`; reference it from `src/app/menus.ts`. The shortcut cheat sheet is generated from the registry.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) for the bigger picture.

## Reporting bugs and requesting features

Use the issue templates. For security problems follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
