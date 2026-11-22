import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateContract,
  extractCssClasses,
  extractDeclaredCustomProperties,
  extractInlineStyles,
  extractUsedTokens,
  findHtmlUrlProblems,
  findUrlProblems,
  missingClasses,
  missingPrefixes,
  type CssContract,
  type UsedTokens,
} from '../scripts/lib/cssContract.mjs';

const root = path.resolve(__dirname, '..');

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

describe('extractCssClasses', () => {
  it('reads classes from plain, compound, nested-at-rule and minified selectors', () => {
    const css = '.a{color:red}.b.c>.d:hover{x:y}@media (min-width:1px){.e .f::after{content:".fake"}}';
    expect([...extractCssClasses(css)].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('ignores numbers, comments, strings and url() payloads', () => {
    const css = '/* .ghost */.k{margin:0.5em;background:url(data:image/png;base64,a.b.c);content:\'.nope\'}';
    expect([...extractCssClasses(css)]).toEqual(['k']);
  });

  it('keeps hyphenated and underscore names intact', () => {
    expect(extractCssClasses('.kt-em-btn.primary,.kt_x-1{}').has('kt-em-btn')).toBe(true);
    expect(extractCssClasses('.kt_x-1{}').has('kt_x-1')).toBe(true);
  });
});

describe('extractDeclaredCustomProperties', () => {
  it('only reports declarations, not var() references', () => {
    const css = ':root{--kt-a:1px;--kt-b: #fff}.x{width:var(--kt-c)}';
    expect([...extractDeclaredCustomProperties(css)].sort()).toEqual(['--kt-a', '--kt-b']);
  });
});

describe('extractUsedTokens', () => {
  it('finds class tokens and separates dynamic prefixes', () => {
    const src = "h('div', 'kt-em-card dim'); `kt-split-${dir}`; el.className = 'kt-fw-rs kt-fw-rs-' + edge; foo.kt-bar";
    const used = extractUsedTokens(src);
    expect([...used.classes].sort()).toEqual(['kt-em-card', 'kt-fw-rs']);
    expect([...used.prefixes].sort()).toEqual(['kt-fw-rs-', 'kt-split-']);
  });

  it('does not treat property access or longer identifiers as class names', () => {
    const used = extractUsedTokens('const x = a.kt-nope; const mykt-thing = 1;');
    expect(used.classes.size).toBe(0);
  });
});

describe('missing helpers', () => {
  it('lists undefined classes sorted', () => {
    expect(missingClasses(['b', 'a', 'c'], new Set(['c']))).toEqual(['a', 'b']);
  });

  it('accepts a dynamic prefix when any defined class starts with it', () => {
    const defined = new Set(['kt-split-row']);
    expect(missingPrefixes(['kt-split-', 'kt-gone-'], defined)).toEqual(['kt-gone-']);
  });
});

describe('url checks', () => {
  it('flags root-absolute and external CSS urls but accepts data/relative/fragment urls', () => {
    const css = '.a{background:url(/assets/x.png)}.b{background:url("https://cdn.example/x.png")}.c{background:url(data:image/svg+xml;base64,AA)}.d{background:url(./x.png)}.e{filter:url(#f)}';
    const problems = findUrlProblems(css);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('root-absolute');
    expect(problems[1]).toContain('external');
  });

  it('flags root-absolute html attributes but ignores inline scripts and relative links', () => {
    const html = '<link rel="icon" href="./favicon.svg"><link rel="manifest" href="/manifest.webmanifest"><script>const s = \' src="/x" \';</script>';
    expect(findHtmlUrlProblems(html)).toEqual(['root-absolute URL in HTML: /manifest.webmanifest']);
  });

  it('collects every inline style block', () => {
    expect(extractInlineStyles('<style>.a{}</style><p/><style media="all">.b{}</style>')).toBe('.a{}\n.b{}');
  });
});

describe('evaluateContract', () => {
  const contract: CssContract = {
    components: { dialog: ['kt-dlg', 'kt-dlg-title'] },
    hooks: ['kt-hook'],
    requiredSnippets: [':has('],
    requiredCustomProperties: ['--kt-bg'],
  };
  const css = ':root{--kt-bg:#000}.kt-dlg:has(.kt-dlg-title){display:flex}';
  const used = (classes: string[], prefixes: string[] = []): UsedTokens => ({ classes: new Set(classes), prefixes: new Set(prefixes) });

  it('passes for a complete stylesheet', () => {
    expect(evaluateContract({ css, contract, usedByFile: { 'a.ts': used(['kt-dlg', 'kt-hook']) } })).toEqual([]);
  });

  it('reports missing component classes, dropped syntax and missing tokens', () => {
    const errors = evaluateContract({ css: '.kt-dlg{display:flex}', contract, usedByFile: {} });
    expect(errors.join('\n')).toContain('.kt-dlg-title');
    expect(errors.join('\n')).toContain('":has("');
    expect(errors.join('\n')).toContain('--kt-bg');
  });

  it('reports source classes without rules unless they are declared hooks', () => {
    const errors = evaluateContract({ css, contract, usedByFile: { 'b.ts': used(['kt-unstyled', 'kt-hook']) } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('b.ts');
    expect(errors[0]).toContain('kt-unstyled');
  });

  it('reports hooks that became stale because a rule now exists', () => {
    const errors = evaluateContract({ css: `${css}.kt-hook{}`, contract, usedByFile: {} });
    expect(errors.join('\n')).toContain('kt-hook');
  });

  it('fails when the stylesheet has no classes at all', () => {
    const errors = evaluateContract({ css: '', contract: { components: {} }, usedByFile: {} });
    expect(errors[0]).toContain('no class selectors');
  });
});

describe('repository stylesheet vs. css-contract.json (source level, no build needed)', () => {
  const contract = JSON.parse(readFileSync(path.join(root, 'scripts', 'css-contract.json'), 'utf8')) as CssContract;
  const css = walk(path.join(root, 'src'), (f) => f.endsWith('.css'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  it('every src/**/*.ts class is styled or declared as a hook, and every contract class exists', () => {
    const usedByFile: Record<string, UsedTokens> = {};
    for (const file of walk(path.join(root, 'src'), (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
      usedByFile[path.relative(root, file)] = extractUsedTokens(readFileSync(file, 'utf8'));
    }
    const errors = evaluateContract({ css, contract, usedByFile }).filter((e) => !e.startsWith('built CSS lost') && !e.startsWith('design token'));
    expect(errors).toEqual([]);
  });

  it('src/index.css imports every theme stylesheet (a forgotten @import ships unstyled UI)', () => {
    const index = readFileSync(path.join(root, 'src', 'index.css'), 'utf8');
    const themeDir = path.join(root, 'src', 'ui', 'theme');
    for (const file of readdirSync(themeDir).filter((f) => f.endsWith('.css'))) {
      expect(index, `${file} is not imported by src/index.css`).toContain(`./ui/theme/${file}`);
    }
  });

  it('the Edit Mesh dialog classes have rules', () => {
    const defined = extractCssClasses(css);
    for (const cls of ['kt-editmesh', 'kt-em-btn', 'kt-em-toolbar', 'kt-em-main', 'kt-em-canvas', 'kt-em-footer', 'kt-em-lod-thumb']) {
      expect(defined.has(cls), `.${cls}`).toBe(true);
    }
  });
});
