// Pure helpers for scripts/check-built-css.mjs (kept side-effect free so tests can import them).

const IDENT = '-?[_a-zA-Z][_a-zA-Z0-9-]*';

/** Removes block comments, string literals and url(...) payloads so they cannot produce fake selectors. */
export function stripCssNoise(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

/** Returns the set of class names that appear in selectors of the given CSS text. */
export function extractCssClasses(css) {
  const out = new Set();
  const re = new RegExp(`\\.(${IDENT})`, 'g');
  for (const m of stripCssNoise(css).matchAll(re)) out.add(m[1]);
  return out;
}

/** Returns the set of CSS custom properties that are *declared* (not merely referenced). */
export function extractDeclaredCustomProperties(css) {
  const out = new Set();
  for (const m of stripCssNoise(css).matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) out.add(m[1]);
  return out;
}

/**
 * Finds the `kt-*` tokens a source file refers to. Tokens ending in `-` are dynamic prefixes
 * (e.g. `kt-split-${dir}`) and are returned separately.
 */
export function extractUsedTokens(source, prefix = 'kt-') {
  const classes = new Set();
  const prefixes = new Set();
  const re = new RegExp(`(?<![A-Za-z0-9_.-])(${prefix}[a-zA-Z0-9_-]*)`, 'g');
  for (const m of source.matchAll(re)) {
    const token = m[1];
    if (token === prefix) continue;
    if (token.endsWith('-')) prefixes.add(token);
    else classes.add(token);
  }
  return { classes, prefixes };
}

/** Class names inside `data` that are not present in `defined`. */
export function missingClasses(wanted, defined) {
  return [...wanted].filter((c) => !defined.has(c)).sort();
}

/** A dynamic prefix is satisfied when at least one defined class starts with it. */
export function missingPrefixes(prefixes, defined) {
  const all = [...defined];
  return [...prefixes].filter((p) => !all.some((c) => c.startsWith(p))).sort();
}

/** Reports URLs that would break under a sub-path or that reach the network. */
export function findUrlProblems(css) {
  const problems = [];
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/g)) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (url === '' || url.startsWith('data:') || url.startsWith('#')) continue;
    if (/^(?:https?:)?\/\//.test(url)) problems.push(`external URL in CSS: ${url.slice(0, 80)}`);
    else if (url.startsWith('/')) problems.push(`root-absolute URL in CSS (breaks under a sub-path): ${url.slice(0, 80)}`);
  }
  return problems;
}

/** Root-absolute src/href attributes in the built HTML (they would ignore the `/Kekenik-Tree/` base). */
export function findHtmlUrlProblems(html) {
  const problems = [];
  const head = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  for (const m of head.matchAll(/\s(?:src|href)="(\/[^"]*|https?:\/\/[^"]*)"/g)) {
    const url = m[1] ?? '';
    if (url.startsWith('//') || /^https?:/.test(url)) continue;
    problems.push(`root-absolute URL in HTML: ${url.slice(0, 80)}`);
  }
  return problems;
}

/** Concatenates the contents of every `<style>` block of an HTML document. */
export function extractInlineStyles(html) {
  const parts = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) parts.push(m[1] ?? '');
  return parts.join('\n');
}

/**
 * Runs the whole contract against the built CSS. `usedByFile` maps a source path to the result of
 * `extractUsedTokens`. Returns a list of human readable errors (empty list = pass).
 */
export function evaluateContract({ css, contract, usedByFile }) {
  const errors = [];
  const defined = extractCssClasses(css);
  const declared = extractDeclaredCustomProperties(css);

  if (defined.size === 0) errors.push('built CSS contains no class selectors at all (stylesheet missing from the build?)');

  for (const [component, classes] of Object.entries(contract.components)) {
    const missing = missingClasses(classes, defined);
    if (missing.length > 0) errors.push(`component "${component}" is missing styles for: ${missing.map((c) => `.${c}`).join(', ')}`);
  }

  for (const snippet of contract.requiredSnippets ?? []) {
    if (!css.includes(snippet)) errors.push(`built CSS lost required syntax "${snippet}" (minifier/target problem?)`);
  }
  for (const prop of contract.requiredCustomProperties ?? []) {
    if (!declared.has(prop)) errors.push(`design token ${prop} is not declared in the built CSS`);
  }

  const hooks = new Set(contract.hooks ?? []);
  for (const [file, used] of Object.entries(usedByFile)) {
    const undeclared = missingClasses(used.classes, defined).filter((c) => !hooks.has(c));
    if (undeclared.length > 0) {
      errors.push(`${file} uses class(es) with no CSS rule and not listed in "hooks": ${undeclared.join(', ')}`);
    }
    const badPrefixes = missingPrefixes(used.prefixes, defined).filter((p) => !hooks.has(p));
    if (badPrefixes.length > 0) errors.push(`${file} builds class names from prefix(es) with no CSS rule: ${badPrefixes.join(', ')}`);
  }

  const stale = [...hooks].filter((c) => defined.has(c)).sort();
  if (stale.length > 0) errors.push(`"hooks" lists classes that now have CSS rules (remove them): ${stale.join(', ')}`);

  errors.push(...findUrlProblems(css));
  return errors;
}
