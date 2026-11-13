import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ParamDef } from '@/contracts/params';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { STRUCTURE_TABS, TREE_TABS } from '@/ui/panels/properties/inspectorState';

beforeAll(() => registerDiscoveredNodes());

const fmt = (v: unknown): string => {
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (v && typeof v === 'object') return 'curve';
  return String(v);
};

function range(d: ParamDef): string {
  switch (d.kind) {
    case 'float':
    case 'int': {
      const hard = `${d.min ?? '-∞'}..${d.max ?? '∞'}`;
      const soft = d.softMax !== undefined || d.softMin !== undefined ? ` (slider ${d.softMin ?? d.min ?? 0}..${d.softMax ?? d.max})` : '';
      return hard + soft + (d.unit ? ` ${d.unit}` : '');
    }
    case 'enum':
      return d.options.map((o) => o.label).join(' / ');
    case 'range':
      return `${d.min}..${d.max}`;
    default:
      return d.kind;
  }
}

function table(type: string): string {
  const def = getNodeDef(type);
  if (!def) throw new Error(type);
  const tabs = type === 'output.tree' ? TREE_TABS : STRUCTURE_TABS;
  const lines: string[] = [`## ${def.label} (\`${type}\`)`, '', def.description ?? '', ''];
  for (const tab of tabs) {
    if (tab.id === 'All') continue;
    const defs = def.params.filter((p) => p.group === tab.id);
    lines.push(`### Tab: ${tab.label}${defs.length === 0 ? ' _(not implemented yet - shown disabled)_' : ''}`, '');
    if (defs.length === 0) continue;
    lines.push('| Section | Parameter | id | Range | Default | Var | Curve | Meaning |', '|---|---|---|---|---|---|---|---|');
    for (const p of defs) {
      const meaning = (p.tooltip ?? '').replace(/\|/g, '/');
      lines.push(`| ${p.subgroup ?? ''} | ${p.label} | \`${p.id}\` | ${range(p)} | ${fmt(p.default)} | ${p.variance ? 'yes' : ''} | ${p.curveAllowed ? 'yes' : ''} | ${meaning} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

describe('PARAMETERS.md', () => {
  it('lists every tab / section / parameter of Tree, Trunk, Branch and Spine', () => {
    const header = [
      '# Parameters',
      '',
      'Generated from the node registry by `WRITE_PARAM_DOCS=1 npx vitest run tests/paramDocs.test.ts` - do not edit by hand.',
      '',
      '* **Var** = the row has the "%" variance toggle (blue variance field). **Curve** = a curve may drive the value along the parent / spine (green mini-curve).',
      '* Values typed in the number field are accepted up to the hard max; the slider only covers the soft range.',
      '* Counts above `warnAbove` (1000 for `Number`) show a yellow "!" performance badge next to the label.',
      '* Curves on a parameter are evaluated along the *parent* (0 = base, 1 = tip) for placement params, and along the *spine* for shape params.',
      '',
    ].join('\n');
    const doc = [header, ...['output.tree', 'generator.trunk', 'generator.branch', 'generator.spine'].map(table)].join('\n');
    expect(doc).toContain('Tree placement');
    if (process.env.WRITE_PARAM_DOCS) writeFileSync('docs/PARAMETERS.md', doc);
  });
});
