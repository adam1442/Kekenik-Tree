/** Realism report rows and their markdown rendering (pure). */

export interface RealismRow {
  /** Trunk mesh: fraction of edges below 3 degrees. */
  trunkSoftness: number | null;
  /** All wood meshes. */
  barkSoftness: number;
  dihedralP50: number;
  dihedralP95: number;
  normalVariance: number;
  edgeLengthMean: number;
  trunkVerticesPerMetre: number | null;
  barkTriangles: number;
  /** Percent values: 100 x ratio. */
  trunkCircularityDevPct: number | null;
  trunkRoughnessPct: number | null;
  trunkSilhouettePct: number | null;
  branchCircularityDevPct: number | null;
  branchRoughnessPct: number | null;
  forkCount: number;
  waistMid: number | null;
  minAreaRatio: number | null;
  thinningForks: number;
  minValleyRadiusRel: number | null;
  allSimple: boolean | null;
  ring0NormalJumpMax: number | null;
  openEndEdgeCv: number | null;
  /** Largest wood seam gap divided by the tree height, percent. */
  windSeamGapPct: number | null;
}

export type RealismKey = keyof RealismRow;

export interface RealismColumn {
  key: RealismKey;
  title: string;
  digits: number;
}

export const REALISM_COLUMNS: readonly RealismColumn[] = [
  { key: 'trunkSoftness', title: 'trunk softness', digits: 2 },
  { key: 'barkSoftness', title: 'bark softness', digits: 2 },
  { key: 'dihedralP50', title: 'dihedral p50 (deg)', digits: 1 },
  { key: 'dihedralP95', title: 'dihedral p95 (deg)', digits: 1 },
  { key: 'normalVariance', title: 'normal var. /10 cm', digits: 3 },
  { key: 'edgeLengthMean', title: 'edge len (m)', digits: 3 },
  { key: 'trunkVerticesPerMetre', title: 'trunk verts/m', digits: 0 },
  { key: 'barkTriangles', title: 'bark tris', digits: 0 },
  { key: 'trunkCircularityDevPct', title: 'trunk circ. dev %', digits: 2 },
  { key: 'trunkRoughnessPct', title: 'trunk radius rough. %', digits: 2 },
  { key: 'trunkSilhouettePct', title: 'trunk silhouette %', digits: 2 },
  { key: 'branchCircularityDevPct', title: 'branch circ. dev %', digits: 2 },
  { key: 'branchRoughnessPct', title: 'branch radius rough. %', digits: 2 },
  { key: 'forkCount', title: 'forks', digits: 0 },
  { key: 'waistMid', title: 'waist @ mid', digits: 2 },
  { key: 'minAreaRatio', title: 'min area ratio', digits: 2 },
  { key: 'thinningForks', title: 'thinning forks', digits: 0 },
  { key: 'minValleyRadiusRel', title: 'valley R / lobe R', digits: 2 },
  { key: 'allSimple', title: 'outlines simple', digits: 0 },
  { key: 'ring0NormalJumpMax', title: 'ring0 normal jump (deg)', digits: 1 },
  { key: 'openEndEdgeCv', title: 'open-end edge CV', digits: 2 },
  { key: 'windSeamGapPct', title: 'wind seam gap % H', digits: 3 },
];

const cell = (v: number | boolean | null, digits: number): string => (v === null ? '-' : typeof v === 'boolean' ? (v ? 'yes' : 'NO') : v.toFixed(digits));

/** Combines the rows of several seeds: numbers are averaged (worst-case fields take the min / max in `merge`), booleans are AND-ed. */
export function averageRows(rows: readonly RealismRow[]): RealismRow {
  const out: Record<string, number | boolean | null> = {};
  for (const col of REALISM_COLUMNS) {
    const vals = rows.map((r) => r[col.key]);
    const nums = vals.filter((v): v is number => typeof v === 'number');
    const bools = vals.filter((v): v is boolean => typeof v === 'boolean');
    if (bools.length > 0) out[col.key] = bools.every(Boolean);
    else out[col.key] = nums.length > 0 ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
  }
  return out as unknown as RealismRow;
}

/** Markdown table: one row per sample project, one column per metric. */
export function realismTable(rows: ReadonlyMap<string, RealismRow>): string {
  const head = `| sample | ${REALISM_COLUMNS.map((c) => c.title).join(' | ')} |`;
  const sep = `|---|${REALISM_COLUMNS.map(() => '---:').join('|')}|`;
  const lines = [...rows].map(([id, r]) => `| ${id} | ${REALISM_COLUMNS.map((c) => cell(r[c.key], c.digits)).join(' | ')} |`);
  return [head, sep, ...lines].join('\n');
}

/** Median of the numeric column over all samples (null when no sample has a value). */
export function columnMedian(rows: ReadonlyMap<string, RealismRow>, key: RealismKey): number | null {
  const v = [...rows.values()].map((r) => r[key]).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
}

/** One line of the "fork" section: the fork metrics of a controlled trunk fork for one parameter set. */
export interface ForkSectionRow {
  label: string;
  forks: number;
  waistMid: number | null;
  minAreaRatio: number | null;
  minValleyRadiusRel: number | null;
  allSimple: boolean;
  ring0NormalJumpMax: number | null;
  openEndEdgeCv: number | null;
}

/** Markdown of the "fork" section: before (default parameters) and after (a natural parameter set) side by side. */
export function forkSectionMarkdown(rows: readonly ForkSectionRow[], parameters: string): string {
  const f = (v: number | null, d: number): string => (v === null ? '-' : v.toFixed(d));
  return [
    '## Fork (Skin > Splits shape, T08)',
    '',
    `Controlled trunk fork (Chance 1, seed 1, LOD 0). The natural set is: ${parameters}. Targets: waist 0.55-0.85, valley radius >= 0.12, area ratio >= 0.9, ring 0 normal jump small.`,
    '',
    '| set | forks | waist at mid | min area ratio | min valley radius (x lobe) | all simple | ring 0 normal jump max (deg) | open-end edge CV |',
    '|---|---:|---:|---:|---:|---|---:|---:|',
    ...rows.map((r) => `| ${r.label} | ${r.forks} | ${f(r.waistMid, 2)} | ${f(r.minAreaRatio, 2)} | ${f(r.minValleyRadiusRel, 2)} | ${r.allSimple ? 'yes' : 'NO'} | ${f(r.ring0NormalJumpMax, 1)} | ${f(r.openEndEdgeCv, 2)} |`),
    '',
  ].join('\n');
}
