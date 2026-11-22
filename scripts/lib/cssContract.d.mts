export interface UsedTokens {
  classes: Set<string>;
  prefixes: Set<string>;
}

export interface CssContract {
  /** Component name -> class names that must have a rule in the built CSS. */
  components: Record<string, string[]>;
  /** Class names / prefixes used by code that intentionally have no rule (DOM hooks, storage keys). */
  hooks?: string[];
  /** Substrings that must survive minification (modern syntax the UI depends on). */
  requiredSnippets?: string[];
  /** Design tokens that must be declared. */
  requiredCustomProperties?: string[];
}

export function stripCssNoise(css: string): string;
export function extractCssClasses(css: string): Set<string>;
export function extractDeclaredCustomProperties(css: string): Set<string>;
export function extractUsedTokens(source: string, prefix?: string): UsedTokens;
export function missingClasses(wanted: Iterable<string>, defined: Set<string>): string[];
export function missingPrefixes(prefixes: Iterable<string>, defined: Set<string>): string[];
export function findUrlProblems(css: string): string[];
export function findHtmlUrlProblems(html: string): string[];
export function extractInlineStyles(html: string): string;
export function evaluateContract(input: {
  css: string;
  contract: CssContract;
  usedByFile: Record<string, UsedTokens>;
}): string[];
