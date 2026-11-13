# Publishing to GitHub

## 1. First push

Place `ScreenShot.jpg` in the repository root (next to `README.md`), then run:

```bash
git init
git config user.name "adam1442"
git config user.email "hossein.r.1442@gmail.com"
git add .
git commit -m "Initial release: Kekenik Tree 1.0.0"
git branch -M main
git remote add origin https://github.com/adam1442/Kekenik-Tree.git
git push -u origin main
```

(Create the empty repository `adam1442/Kekenik-Tree` on GitHub first, without a README or license.)

## 2. One-time GitHub setting

GitHub does not allow a workflow's default token to enable Pages by itself:

**Repository → Settings → Pages → Build and deployment → Source: "GitHub Actions"**

After that every push to `main` runs *Deploy to GitHub Pages* and publishes `https://adam1442.github.io/Kekenik-Tree/`. (If the first run failed before the setting was changed, re-run it from the *Actions* tab or start it with *Run workflow*.)

Also add a repository description and topics: `threejs`, `typescript`, `vite`, `procedural-generation`, `tree-generator`, `node-based`, `vegetation`, `gamedev`.

## 3. Versioned release

```bash
git tag v1.0.0
git push origin v1.0.0
```

The *Release* workflow builds the project, zips `dist/` as `kekenik-tree-v1.0.0-web.zip` and creates a GitHub Release with generated notes and the zip attached.

Before tagging a new version update `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`) and `CHANGELOG.md`.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | pull requests, pushes to branches other than `main` | `npm ci`, typecheck, lint, tests, build |
| `deploy.yml` | push to `main`, manual | same checks, then publishes `dist/` to GitHub Pages |
| `release.yml` | tags `v*.*.*` | checks, build, zip, GitHub Release |
