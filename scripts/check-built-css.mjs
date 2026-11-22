// Post-build guard: verifies the production stylesheet still contains the rules the UI depends on.
//
// The build is a single self-contained dist/index.html (vite-plugin-singlefile), so the CSS lives in an inline
// <style> block; separate dist/assets/*.css files are scanned too in case the build setup changes.
//
// Usage: npm run build:check   (or: node scripts/check-built-css.mjs [distDir])
// Contract: scripts/css-contract.json (component class lists, intentionally unstyled "hooks", required syntax/tokens).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateContract,
  extractInlineStyles,
  extractUsedTokens,
  findHtmlUrlProblems,
} from './lib/cssContract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(root, process.argv[2] ?? 'dist');

function walk(dir, accept, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

function fail(messages) {
  console.error(`check-built-css: FAILED (${messages.length} problem${messages.length === 1 ? '' : 's'})`);
  for (const m of messages) console.error(`  - ${m}`);
  process.exit(1);
}

if (!existsSync(distDir)) fail([`${path.relative(root, distDir)} does not exist - run "npm run build" first`]);

const cssParts = [];
const htmlProblems = [];
for (const file of walk(distDir, (f) => f.endsWith('.css'))) cssParts.push(readFileSync(file, 'utf8'));
for (const file of walk(distDir, (f) => f.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  cssParts.push(extractInlineStyles(html));
  htmlProblems.push(...findHtmlUrlProblems(html).map((p) => `${path.relative(root, file)}: ${p}`));
}
const css = cssParts.join('\n');
if (css.trim() === '') fail(['no CSS found in dist (neither <style> blocks nor dist/**/*.css)']);

const contract = JSON.parse(readFileSync(path.join(root, 'scripts', 'css-contract.json'), 'utf8'));

const usedByFile = {};
for (const file of walk(path.join(root, 'src'), (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
  const used = extractUsedTokens(readFileSync(file, 'utf8'));
  if (used.classes.size > 0 || used.prefixes.size > 0) usedByFile[path.relative(root, file).split(path.sep).join('/')] = used;
}

const errors = [...evaluateContract({ css, contract, usedByFile }), ...htmlProblems];
if (errors.length > 0) fail(errors);

const componentCount = Object.keys(contract.components).length;
const classCount = Object.values(contract.components).reduce((n, list) => n + list.length, 0);
console.info(
  `check-built-css: OK - ${componentCount} components / ${classCount} required classes, ` +
    `${Object.keys(usedByFile).length} source files scanned, ${(css.length / 1024).toFixed(0)} kB CSS.`,
);
