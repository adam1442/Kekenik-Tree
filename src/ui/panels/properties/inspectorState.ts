import type { AppContext } from '@/app/context';
import { loadJSON, saveJSON } from '@/app/settings';
import type { Command } from '@/contracts/app';
import { defaultParamState, type BoolParamDef, type ParamDef, type ParamState } from '@/contracts/params';
import type { GraphModel } from '@/graph/model/graphModel';
import type { GraphNode, NodeDefLookup } from '@/graph/model/types';
import { getNodeDef } from '@/graph/registry';

const SECTION_STATE_KEY = 'inspector.collapsedSections';
const ACTIVE_TAB_KEY = 'inspector.activeTabs';

/** Subgroups that render as `.kt-subhead` inside the preceding section card. */
const COUPLED_PARENT_SECTION: Record<string, string> = {
  Absolute: 'Generation',
  Density: 'Generation',
  Fallen: 'Season',
};

export interface InspectorParamEntry {
  def: ParamDef;
  /** Optional paired boolean enable parameter rendered as a leading checkbox on the row (e.g. `clip` + `clipEnabled`). */
  pairedEnableDef?: BoolParamDef;
}

export interface InspectorSubBlock {
  /** Subhead title (null for the section's root rows before any subhead). */
  subhead: string | null;
  entries: InspectorParamEntry[];
}

export interface InspectorSectionModel {
  /** Unique key for collapse persistence, e.g. `Generation::Generation` or `Material::Season`. */
  key: string;
  /** Tab group this section belongs to. */
  group: string;
  /** Display title of the collapsible `.kt-section` card. */
  title: string;
  blocks: InspectorSubBlock[];
  /** All ParamDefs inside this section (including paired enables), used for section reset/copy/paste. */
  allDefs: ParamDef[];
}

export class InspectorStateStore {
  private collapsed = new Set<string>();
  private activeTabs = new Map<string, string>();

  constructor() {
    const rawCollapsed = loadJSON(SECTION_STATE_KEY);
    if (Array.isArray(rawCollapsed)) {
      for (const item of rawCollapsed) {
        if (typeof item === 'string') this.collapsed.add(item);
      }
    }
    const rawTabs = loadJSON(ACTIVE_TAB_KEY);
    if (typeof rawTabs === 'object' && rawTabs !== null) {
      for (const [k, v] of Object.entries(rawTabs as Record<string, unknown>)) {
        if (typeof v === 'string') this.activeTabs.set(k, v);
      }
    }
  }

  isCollapsed(sectionKey: string): boolean {
    return this.collapsed.has(sectionKey);
  }

  setCollapsed(sectionKey: string, isCollapsed: boolean): void {
    if (isCollapsed) this.collapsed.add(sectionKey);
    else this.collapsed.delete(sectionKey);
    this.persistCollapsed();
  }

  setAllCollapsed(sectionKeys: readonly string[], isCollapsed: boolean): void {
    for (const k of sectionKeys) {
      if (isCollapsed) this.collapsed.add(k);
      else this.collapsed.delete(k);
    }
    this.persistCollapsed();
  }

  getActiveTab(nodeTypeKey: string, availableTabs: readonly string[]): string {
    const saved = this.activeTabs.get(nodeTypeKey);
    if (saved && availableTabs.includes(saved)) return saved;
    // Default to the first category tab after 'All' (e.g. 'Generation')
    return availableTabs[1] ?? availableTabs[0] ?? 'All';
  }

  setActiveTab(nodeTypeKey: string, tab: string): void {
    this.activeTabs.set(nodeTypeKey, tab);
    const obj: Record<string, string> = {};
    for (const [k, v] of this.activeTabs) obj[k] = v;
    saveJSON(ACTIVE_TAB_KEY, obj);
  }

  private persistCollapsed(): void {
    saveJSON(SECTION_STATE_KEY, [...this.collapsed]);
  }
}

/** Extract ordered tabs `['All', ...groups]` from a parameter list. */
export function getInspectorTabs(defs: readonly ParamDef[]): string[] {
  const groups: string[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    if (!seen.has(d.group)) {
      seen.add(d.group);
      groups.push(d.group);
    }
  }
  return groups.length > 0 ? ['All', ...groups] : ['All'];
}

/** One tab of the inspector strip. `id` is the ParamDef `group` (or 'All'); `label` is what the tab shows. */
export interface InspectorTab {
  id: string;
  label: string;
  /** Tab exists but has no parameters yet: shown greyed out, never hidden. */
  disabled?: boolean;
  hint?: string;
}

const tab = (id: string, label = id): InspectorTab => ({ id, label });

/** Tab strip of the structure generators (Trunk / Branch / Spine / Root). */
export const STRUCTURE_TABS: readonly InspectorTab[] = [
  tab('All'),
  tab('Generation', 'Gen'),
  tab('Spine'),
  tab('Forces'),
  tab('Shape'),
  tab('Skin'),
  tab('UV'),
  tab('LOD'),
  tab('Displacement'),
  tab('Material'),
  tab('Animation'),
  tab('Segments'),
  tab('Physics'),
  tab('Hand drawn', 'Hand Drawn'),
];

/** Tab strip of the Tree node. */
export const TREE_TABS: readonly InspectorTab[] = [tab('All'), tab('Generation', 'Gen'), tab('Shape'), tab('LOD'), tab('Collision')];

const STRUCTURE_TYPES = new Set(['generator.trunk', 'generator.branch', 'generator.spine', 'generator.root']);

/**
 * Tabs for a node type. Structure generators and the Tree use fixed tab strips (tabs without parameters are
 * disabled, not hidden); every other node derives its tabs from the parameter groups.
 */
export function getInspectorTabSpecs(nodeType: string | null, defs: readonly ParamDef[]): InspectorTab[] {
  const fixed = nodeType === 'output.tree' ? TREE_TABS : nodeType && STRUCTURE_TYPES.has(nodeType) ? STRUCTURE_TABS : null;
  if (!fixed) return getInspectorTabs(defs).map((g) => tab(g));
  const groups = new Set(defs.map((d) => d.group));
  const known = new Set(fixed.map((t) => t.id));
  const extra = [...groups].filter((g) => !known.has(g)).map((g) => tab(g));
  return [
    ...fixed.map((t) => (t.id === 'All' || groups.has(t.id) ? t : { ...t, disabled: true, hint: `${t.label}: no parameters yet` })),
    ...extra,
  ];
}

/**
 * Group `ParamDef[]` into collapsible `.kt-section` cards and `.kt-subhead` blocks
 * for the given `activeTab` (`'All'` or a specific `group` name).
 */
export function buildInspectorSections(defs: readonly ParamDef[], activeTab: string): InspectorSectionModel[] {
  const filtered = activeTab === 'All' ? defs : defs.filter((d) => d.group === activeTab);

  // Pair `<id>` with `<id>Enabled` when adjacent in the same subgroup (e.g. `clip` + `clipEnabled` in Boundaries)
  const pairedSkipIds = new Set<string>();
  const pairedMap = new Map<string, BoolParamDef>();
  for (let i = 0; i < filtered.length - 1; i++) {
    const cur = filtered[i];
    const next = filtered[i + 1];
    if (
      cur &&
      next &&
      (cur.kind === 'float' || cur.kind === 'int') &&
      next.kind === 'bool' &&
      next.id === `${cur.id}Enabled` &&
      cur.group === next.group &&
      cur.subgroup === next.subgroup
    ) {
      pairedSkipIds.add(next.id);
      pairedMap.set(cur.id, next);
    }
  }

  const sections: InspectorSectionModel[] = [];
  const sectionByKey = new Map<string, InspectorSectionModel>();

  for (const def of filtered) {
    if (pairedSkipIds.has(def.id)) continue;

    const rawSub = def.subgroup ?? def.group;
    const coupledParent = COUPLED_PARENT_SECTION[rawSub];
    const sectionTitle = coupledParent ?? rawSub;
    const subheadTitle = coupledParent ? rawSub : null;
    const sectionKey = `${def.group}::${sectionTitle}`;

    let sec = sectionByKey.get(sectionKey);
    if (!sec) {
      sec = {
        key: sectionKey,
        group: def.group,
        title: activeTab === 'All' && sectionTitle !== def.group ? `${def.group} · ${sectionTitle}` : sectionTitle,
        blocks: [],
        allDefs: [],
      };
      sectionByKey.set(sectionKey, sec);
      sections.push(sec);
    }

    const pairedEnableDef = pairedMap.get(def.id);
    sec.allDefs.push(def);
    if (pairedEnableDef) sec.allDefs.push(pairedEnableDef);

    let block = sec.blocks[sec.blocks.length - 1];
    if (!block || block.subhead !== subheadTitle) {
      block = { subhead: subheadTitle, entries: [] };
      sec.blocks.push(block);
    }
    block.entries.push({ def, pairedEnableDef });
  }

  return sections;
}

/**
 * Compute the shared `ParamDef[]` across 1 or more selected `GraphNode`s.
 * If 1 node is selected, returns all its `NodeDef.params`.
 * If multiple nodes are selected, returns parameters whose `id` and `kind` exist in every selected node.
 */
export function resolveSharedParams(
  nodes: readonly GraphNode[],
  lookup: NodeDefLookup = getNodeDef,
): ParamDef[] {
  if (nodes.length === 0) return [];
  const firstDef = nodes[0] ? lookup(nodes[0].type) : undefined;
  if (!firstDef) return [];
  if (nodes.length === 1) return [...firstDef.params];

  const otherParamMaps = nodes.slice(1).map((n) => {
    const d = lookup(n.type);
    const map = new Map<string, ParamDef>();
    for (const p of d?.params ?? []) map.set(p.id, p);
    return map;
  });

  return firstDef.params.filter((p) =>
    otherParamMaps.every((m) => {
      const match = m.get(p.id);
      return match !== undefined && match.kind === p.kind;
    }),
  );
}

/**
 * Undoable command that sets a parameter on one or more nodes simultaneously,
 * supporting continuous gesture merging via `mergeKey`.
 */
export class SetMultiParamCommand implements Command {
  readonly label: string;
  private readonly before = new Map<string, ParamState | undefined>();
  private nextState: ParamState;

  constructor(
    private readonly model: GraphModel,
    nodeIds: readonly string[],
    private readonly paramId: string,
    next: ParamState,
    readonly mergeKey?: string,
    paramLabel?: string,
  ) {
    this.label = `Change ${paramLabel ?? paramId}`;
    this.nextState = structuredClone(next);
    for (const id of nodeIds) {
      const node = model.getNode(id);
      if (node && !node.locked) {
        const cur = node.params[paramId];
        this.before.set(id, cur ? structuredClone(cur) : undefined);
      }
    }
  }

  do(): void {
    for (const id of this.before.keys()) {
      this.model.setParam(id, this.paramId, structuredClone(this.nextState));
    }
  }

  undo(): void {
    for (const [id, prev] of this.before.entries()) {
      if (prev !== undefined) {
        this.model.setParam(id, this.paramId, structuredClone(prev));
      }
    }
  }

  merge(next: Command): boolean {
    if (
      this.mergeKey !== undefined &&
      next instanceof SetMultiParamCommand &&
      next.mergeKey === this.mergeKey &&
      next.model === this.model &&
      next.paramId === this.paramId
    ) {
      this.nextState = structuredClone(next.nextState);
      return true;
    }
    return false;
  }
}

/** Dispatch a parameter update to 1 or more selected nodes with proper undo merging. */
export function applyParamToSelectedNodes(
  app: AppContext,
  nodeIds: readonly string[],
  def: ParamDef,
  patch: Partial<ParamState>,
  merge: boolean,
): void {
  const model = app.graph.model;
  const unlockedIds = nodeIds.filter((id) => {
    const n = model.getNode(id);
    return n !== undefined && !n.locked;
  });
  if (unlockedIds.length === 0) return;

  if (unlockedIds.length === 1) {
    const id = unlockedIds[0] as string;
    app.graph.setParam(id, def.id, patch, merge);
    return;
  }

  const firstNode = model.getNode(unlockedIds[0] as string);
  const baseState = firstNode?.params[def.id] ?? defaultParamState(def);
  const nextState: ParamState = {
    ...structuredClone(baseState),
    ...structuredClone(patch),
  };
  const mergeKey = merge ? `multiparam:${unlockedIds.join(',')}:${def.id}` : undefined;
  app.graph.exec(new SetMultiParamCommand(model, unlockedIds, def.id, nextState, mergeKey, def.label));
}
