import { getMaterialLibrary } from '@/materials/library';
import { getApp } from '@/app/context';
import { batch } from '@/app/commands/batch';
import { SetParamCommand } from '@/app/commands/graphCommands';
import {
  defaultParamState,
  type NodeParams,
  type ParamDef,
  type ParamState,
} from '@/contracts/params';
import type { GraphNode } from '@/graph/model/types';
import { getNodeDef } from '@/graph/registry';
import { h, iconButton } from '../../components/dom';
import { showMenu } from '../../components/menu';
import {
  computeMixedParamState,
  copySectionToClipboard,
  getSectionClipboard,
  isParamModified,
  isParamVisibleForNodes,
  matchesParamSearch,
  mountParamRow,
  type ParamRowInstance,
} from '../../components/params';
import type { PanelInstance } from '../../docking/panelRegistry';
import { icon } from '../../icons/icons';
import { OverrideEditor } from '@/instances/editor';
import { reanchorOverrides, resolveOverrides, OVERRIDES_PARAM_ID, overridesParamState } from '@/instances/overrides';
import { getNodeModeView, type NodeModeView } from './nodeModeInspector';
import { mountProjectSettingsContent, mountViewportSettingsContent } from './globalPanels';
import {
  applyParamToSelectedNodes,
  buildInspectorSections,
  getInspectorTabSpecs,
  type InspectorTab,
  InspectorStateStore,
  resolveSharedParams,
  type InspectorSectionModel,
} from './inspectorState';

interface MountedEntry {
  def: ParamDef;
  pairedEnableDef?: ParamDef;
  row: ParamRowInstance;
}

interface MountedSubBlock {
  subheadEl: HTMLElement | null;
  entries: MountedEntry[];
}

interface MountedSection {
  model: InspectorSectionModel;
  sectionEl: HTMLElement;
  chevEl: SVGSVGElement;
  bodyEl: HTMLElement;
  blocks: MountedSubBlock[];
  mounted: boolean;
  mountBody(): void;
}

export function createPropertiesPanel(host: HTMLElement): PanelInstance {
  const app = getApp();
  const stateStore = new InspectorStateStore();
  host.classList.add('kt-props');
  const overrideEditor = new OverrideEditor(app);
  const nm = (): NodeModeView | null => getNodeModeView(app, overrideEditor);
  let onlyOverridden = false;

  // --- Header elements ---
  const nodeBadge = h('span', 'kt-prop-node-badge');
  const titleEl = h('div', 'kt-prop-title', 'Tree');
  const typeTag = h('span', 'kt-prop-type-tag');

  const renameBtn = iconButton(icon('pencil', 15), 'Rename node (F2)', () => startInlineRename());

  const enableBtn = h('button', 'kt-icon-btn kt-prop-flag-btn', icon('check', 13));
  enableBtn.type = 'button';
  enableBtn.title = 'Toggle Node Enabled (E)';
  enableBtn.addEventListener('click', () => {
    if (app.graph.getSelection().length > 0) {
      app.graph.setFlag('enabled');
    }
  });

  const bypassBtn = h('button', 'kt-icon-btn kt-prop-flag-btn', icon('arrowRight', 13));
  bypassBtn.type = 'button';
  bypassBtn.title = 'Toggle Node Bypass (B)';
  bypassBtn.addEventListener('click', () => {
    if (app.graph.getSelection().length > 0) {
      app.graph.setFlag('bypass');
    }
  });

  const modesWrap = h('div', 'kt-prop-modes');
  const modeIds = ['generator', 'node', 'freehand'] as const;
  const activeIndex = (): number => modeIds.indexOf(app.store.get().editMode);

  const renderModeButtons = (isLeafLike: boolean): void => {
    modesWrap.replaceChildren();
    const icons = isLeafLike ? ['nodes', 'sun', 'toolNodes'] : ['leafCircle', 'nodes', 'brush'];
    const titles = isLeafLike
      ? ['Generator properties', 'Lighting / Season preview', 'Node edit mode']
      : ['Generator mode', 'Node mode', 'Hand-drawn mode'];
    icons.forEach((ic, idx) => {
      const b = h('button', `kt-prop-mode${!isLeafLike && idx === activeIndex() ? ' active' : ''}`, icon(ic, 17));
      b.type = 'button';
      b.title = titles[idx] ?? '';
      b.addEventListener('click', () => {
        if (isLeafLike) return;
        if (idx === 2) {
          app.notify('Freehand mode is not available yet.');
          return;
        }
        app.store.set({ editMode: modeIds[idx] ?? 'generator' });
      });
      modesWrap.append(b);
    });
  };
  renderModeButtons(false);

  const head = h(
    'div',
    'kt-prop-head',
    nodeBadge,
    titleEl,
    renameBtn,
    typeTag,
    h('div', 'kt-spacer'),
    enableBtn,
    bypassBtn,
    modesWrap,
  );

  // --- Node mode bar: instance badge, override actions ---
  const nodeBar = h('div', 'kt-prop-nodebar');
  nodeBar.hidden = true;

  // --- Diagnostics banner (shown when selected node has error/warning) ---
  const diagBanner = h('div', 'kt-prop-diag');
  diagBanner.hidden = true;

  // --- Tabs strip ---
  const tabsEl = h('div', 'kt-prop-tabs');

  // --- Search & Expand/Collapse bar ---
  const searchInput = h('input', 'kt-prop-search-input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search properties';
  searchInput.setAttribute('aria-label', 'Search properties');

  const clearSearchBtn = h('button', 'kt-icon-btn kt-prop-search-clear', icon('close', 12));
  clearSearchBtn.type = 'button';
  clearSearchBtn.title = 'Clear search';
  clearSearchBtn.hidden = true;

  const expandAllBtn = h('button', 'kt-icon-btn kt-prop-collapse-btn', icon('chevronDown', 13));
  expandAllBtn.type = 'button';
  expandAllBtn.title = 'Expand / Collapse all sections';

  const searchBar = h(
    'div',
    'kt-prop-search',
    icon('search', 15),
    searchInput,
    clearSearchBtn,
    expandAllBtn,
  );

  // --- Scrollable body ---
  const scrollEl = h('div', 'kt-prop-scroll');

  host.append(head, nodeBar, diagBanner, tabsEl, searchBar, scrollEl);

  // --- Responsive ResizeObserver for compact label layout ---
  const ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 360;
    host.classList.toggle('compact', w > 0 && w < 310);
  });
  ro.observe(host);

  // --- Inspector runtime state ---
  let currentSelectionKey = '';
  let currentActiveTab = 'Generation';
  let currentSearchQuery = '';
  let mountedSections: MountedSection[] = [];
  let globalContentDisposable: { dispose(): void } | null = null;
  let isEditingParam = false;

  const disposeMountedSections = (): void => {
    for (const sec of mountedSections) {
      for (const blk of sec.blocks) {
        for (const entry of blk.entries) entry.row.dispose();
      }
    }
    mountedSections = [];
    if (globalContentDisposable) {
      globalContentDisposable.dispose();
      globalContentDisposable = null;
    }
  };

  // --- Inline rename ---
  function startInlineRename(): void {
    const sel = app.graph.getSelection();
    if (sel.length !== 1) return;
    const node = app.graph.model.getNode(sel[0] as string);
    if (!node || node.locked) return;

    const inp = h('input', 'kt-field kt-prop-rename-input');
    inp.type = 'text';
    inp.value = node.name;
    titleEl.replaceWith(inp);
    inp.focus();
    inp.select();

    let finished = false;
    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      const nextName = inp.value.trim();
      inp.replaceWith(titleEl);
      if (commit && nextName && nextName !== node.name) {
        app.graph.rename(node.id, nextName);
      }
      updateHeaderOnly();
    };

    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
  }

  titleEl.addEventListener('dblclick', () => startInlineRename());

  // --- Dynamic options for Material / Mesh enum fields ---
  const resolveDynamicOptions = (fieldId: string): { value: string; label: string }[] => {
    const model = app.graph.model;
    if (fieldId === 'material' || fieldId === 'backMaterial') {
      // Materials and Material Sets of the project library (ids are what the generators store).
      const lib = getMaterialLibrary();
      return [
        { value: '', label: 'None' },
        ...lib.materials().map((m) => ({ value: m.id, label: m.name })),
        ...lib.sets().map((s) => ({ value: s.id, label: `Set: ${s.name}` })),
      ];
    }
    if (fieldId === 'decoMask') {
      return [{ value: '', label: 'None' }, ...getMaterialLibrary().masks().map((mk) => ({ value: mk.id, label: mk.name }))];
    }
    if (fieldId === 'displacement') {
      return [{ value: '', label: 'None' }, ...getMaterialLibrary().displacements().map((d) => ({ value: d.id, label: d.name }))];
    }
    if (fieldId === 'mesh') {
      const lib = getMaterialLibrary();
      const meshNodes = model.nodes().filter((n) => n.type.startsWith('mesh.'));
      const opts: { value: string; label: string }[] = [
        { value: 'any', label: 'Any' },
        ...lib.cutoutMeshes().map((c) => ({ value: c.id, label: c.name })),
      ];
      for (const m of meshNodes) {
        opts.push({ value: m.name, label: m.name });
      }
      return opts;
    }
    return [];
  };

  // --- Selected nodes helper ---
  const getSelectedNodes = (): GraphNode[] => {
    const ids = app.graph.getSelection();
    const model = app.graph.model;
    const view = nm();
    return ids
      .map((id) => model.getNode(id))
      .filter((n): n is GraphNode => n !== undefined)
      .map((n) => (view && view.nodeId === n.id ? view.effective(n) : n));
  };

  /** Writes a param edit: to the selected instances in Node mode, to the node(s) otherwise. */
  const applyParams = (ids: readonly string[], def: ParamDef, patch: Partial<ParamState>, merge: boolean): void => {
    const view = nm();
    if (view) view.apply(def, patch, merge);
    else applyParamToSelectedNodes(app, ids, def, patch, merge);
  };

  const renderNodeBar = (): void => {
    const s = app.store.get();
    const nodes = app.graph.getSelection();
    nodeBar.hidden = s.editMode !== 'node' || nodes.length !== 1;
    if (nodeBar.hidden) return;
    const view = nm();
    const nodeId = nodes[0] as string;
    nodeBar.replaceChildren();
    if (!view) {
      nodeBar.append(h('span', '', 'Node mode: click a branch in the viewport to edit only that instance. Edits below change the whole generator.'));
    } else {
      const badge = h('span', 'kt-prop-inst-badge', view.refs.length === 1 ? `Instance #${(view.refs[0]?.key ?? 0).toString(16).slice(-5)}` : `${view.refs.length} instances`);
      const clear = h('button', '', 'Clear all overrides');
      clear.type = 'button';
      clear.title = 'Remove every override of the selected instances';
      clear.addEventListener('click', () => view.clearAll());
      const only = h('button', onlyOverridden ? 'active' : '', 'Show only overridden');
      only.type = 'button';
      only.addEventListener('click', () => {
        onlyOverridden = !onlyOverridden;
        renderNodeBar();
        renderInspectorBody();
      });
      const hide = h('button', '', 'Hide');
      hide.type = 'button';
      hide.addEventListener('click', () => overrideEditor.setFlag(view.refs, 'hidden', !view.refs.every((r) => overrideEditor.get(r)?.hidden === true)));
      const prune = h('button', '', 'Delete');
      prune.type = 'button';
      prune.title = 'Prune the instances (their children disappear too)';
      prune.addEventListener('click', () => {
        overrideEditor.setFlag(view.refs, 'pruned', true);
        app.store.set({ instanceSelection: [] });
      });
      nodeBar.append(badge, clear, only, hide, prune);
      const primary = view.refs[view.refs.length - 1];
      if (primary && view.refs.length > 1) {
        const copy = h('button', '', 'Copy overrides to selected');
        copy.type = 'button';
        copy.addEventListener('click', () => overrideEditor.copyOverrides(primary, view.refs));
        nodeBar.append(copy);
      }
    }
    // Pruned instances (no longer selectable) and orphans (instances that vanished) are listed, never silently applied.
    const table = overrideEditor.table(nodeId);
    const list = overrideEditor.list(nodeId);
    const pruned = Array.from(table?.pruned ?? []);
    if (pruned.length > 0) {
      const b = h('button', '', `Restore ${pruned.length} deleted`);
      b.type = 'button';
      b.addEventListener('click', () => overrideEditor.setFlag(pruned.map((key) => ({ nodeId, key })), 'pruned', false));
      nodeBar.append(b);
    }
    const orphans = table ? resolveOverrides(table, list).orphans : [];
    if (orphans.length > 0) {
      const o = h('span', 'kt-orphans', `${orphans.length} orphaned override${orphans.length > 1 ? 's' : ''}`);
      o.title = 'These overrides belong to instances that no longer exist (the count of the parent changed).';
      const fix = h('button', '', 'Re-anchor');
      fix.type = 'button';
      fix.title = 'Move orphaned overrides to the nearest free instance of the same parent';
      fix.addEventListener('click', () => {
        if (!table) return;
        const res = reanchorOverrides(table, list);
        app.graph.setParam(nodeId, OVERRIDES_PARAM_ID, overridesParamState(res.overrides), false);
        app.graph.endGesture();
        if (res.remaining.length > 0) app.notify(`${res.remaining.length} override(s) could not be re-anchored.`);
      });
      const drop = h('button', '', 'Discard');
      drop.type = 'button';
      drop.addEventListener('click', () => overrideEditor.clear(nodeId, orphans.map((x) => x.key)));
      nodeBar.append(o, fix, drop);
    }
  };

  // --- Header & Diagnostics sync ---
  const updateHeaderOnly = (): void => {
    const nodes = getSelectedNodes();
    if (nodes.length === 0) {
      nodeBar.hidden = true;
      nodeBadge.style.background = 'var(--kt-node-tree)';
      nodeBadge.replaceChildren(icon('nodeTree', 14));
      titleEl.textContent = 'Tree & Project';
      titleEl.title = 'Global Tree, Project & Viewport settings (select any node in Generation to inspect its parameters)';
      typeTag.textContent = '';
      renameBtn.hidden = true;
      enableBtn.hidden = true;
      bypassBtn.hidden = true;
      diagBanner.hidden = true;
      return;
    }

    renderNodeBar();
    if (nodes.length === 1) {
      const node = nodes[0] as GraphNode;
      const def = getNodeDef(node.type);
      nodeBadge.style.background = def?.color ?? 'var(--kt-accent)';
      nodeBadge.replaceChildren(icon(def?.icon ?? 'nodes', 14));
      const inNodeMode = app.store.get().editMode === 'node';
      titleEl.textContent = inNodeMode ? `${node.name} node` : node.name;
      titleEl.title = `${node.name} (${def?.label ?? node.type})`;
      typeTag.textContent = def && def.label !== node.name ? def.label : '';
      renameBtn.hidden = Boolean(node.locked);
      enableBtn.hidden = false;
      bypassBtn.hidden = false;
      enableBtn.classList.toggle('active', node.enabled);
      enableBtn.classList.toggle('off', !node.enabled);
      bypassBtn.classList.toggle('active', Boolean(node.bypass));

      const isLeafLike = node.type === 'generator.leaf' || node.type === 'generator.frond' || node.type === 'generator.cluster';
      renderModeButtons(isLeafLike);

      const diag = app.graph.diagnostics.get(node.id);
      if (diag && (diag.state === 'error' || diag.messages.length > 0)) {
        diagBanner.hidden = false;
        const hasErr = diag.state === 'error' || diag.messages.some((m) => m.level === 'error');
        diagBanner.className = `kt-prop-diag ${hasErr ? 'error' : 'warn'}`;
        diagBanner.textContent = diag.messages.map((m) => m.text).join(' · ') || 'Evaluation error';
      } else {
        diagBanner.hidden = true;
      }
      return;
    }

    // Multi-selection header
    const firstDef = getNodeDef((nodes[0] as GraphNode).type);
    nodeBadge.style.background = firstDef?.color ?? 'var(--kt-accent)';
    nodeBadge.replaceChildren(icon('nodes', 14));
    titleEl.textContent = `${nodes.length} nodes`;
    const uniqueLabels = [...new Set(nodes.map((n) => getNodeDef(n.type)?.label ?? n.type))];
    typeTag.textContent = uniqueLabels.join(', ');
    titleEl.title = nodes.map((n) => n.name).join(', ');
    renameBtn.hidden = true;
    enableBtn.hidden = false;
    bypassBtn.hidden = false;
    enableBtn.classList.toggle('active', nodes.every((n) => n.enabled));
    bypassBtn.classList.toggle('active', nodes.every((n) => n.bypass));
    diagBanner.hidden = true;
  };

  /** Node mode: flag rows overridden on the selected instance and give them a per-parameter reset button. */
  const decorateRow = (entry: Pick<MountedEntry, 'def' | 'row'>): void => {
    const on = nm()?.overridden(entry.def.id) === true;
    const el = entry.row.element;
    el.classList.toggle('kt-overridden', on);
    let btn = el.querySelector<HTMLButtonElement>('.kt-ovr-reset');
    if (on && !btn) {
      btn = h('button', 'kt-ovr-reset', '↺');
      btn.type = 'button';
      btn.title = 'Reset override (back to the procedural value)';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        nm()?.reset(entry.def.id);
      });
      (el.querySelector('.kt-row') ?? el).append(btn);
    }
    if (btn) btn.hidden = !on;
  };
  const passesOverrideFilter = (id: string): boolean => {
    const view = nm();
    return !onlyOverridden || !view || view.overridden(id);
  };

  // --- Update visibility & values of already-mounted rows in-place ---
  const syncMountedRowsInPlace = (): void => {
    const nodes = getSelectedNodes();
    if (nodes.length === 0) return;
    const paramMaps: NodeParams[] = nodes.map((n) => n.params);

    for (const sec of mountedSections) {
      if (!sec.mounted) continue;
      let anyVisibleInSection = false;

      for (const blk of sec.blocks) {
        let anyVisibleInBlock = false;
        for (const entry of blk.entries) {
          const matchesSearch = matchesParamSearch(entry.def, currentSearchQuery);
          const satisfiesCond = isParamVisibleForNodes(entry.def, paramMaps);
          const visible = matchesSearch && satisfiesCond && passesOverrideFilter(entry.def.id);
          entry.row.setVisible(visible);
          decorateRow(entry);
          if (visible) {
            anyVisibleInBlock = true;
            anyVisibleInSection = true;
          }

          if (!isEditingParam) {
            const states = nodes.map((n) => n.params[entry.def.id] ?? defaultParamState(entry.def));
            const mixedInfo = computeMixedParamState(entry.def, states);
            let pairedRep: ParamState | undefined;
            let pairedMixed = false;
            if (entry.pairedEnableDef) {
              const pDef = entry.pairedEnableDef;
              const pStates = nodes.map((n) => n.params[pDef.id] ?? defaultParamState(pDef));
              const pMixedInfo = computeMixedParamState(pDef, pStates);
              pairedRep = pMixedInfo.representative;
              pairedMixed = pMixedInfo.valueMixed;
            }
            entry.row.update(
              mixedInfo.representative,
              mixedInfo.valueMixed || mixedInfo.varianceMixed || mixedInfo.curveMixed,
              pairedRep,
              pairedMixed,
            );
          }
        }
        if (blk.subheadEl) {
          blk.subheadEl.hidden = !anyVisibleInBlock;
        }
      }

      sec.sectionEl.hidden = currentSearchQuery.trim() !== '' && !anyVisibleInSection;
    }
  };

  // --- Full rebuild of sections for the current selection & active tab ---
  const renderInspectorBody = (): void => {
    disposeMountedSections();
    scrollEl.replaceChildren();

    const nodes = getSelectedNodes();

    // Case 1: No node selected -> show Global Tree/Project & Viewport tabs
    if (nodes.length === 0) {
      const globalTabs: InspectorTab[] = [{ id: 'All', label: 'All' }, { id: 'Project', label: 'Project' }, { id: 'Viewport', label: 'Viewport' }];
      if (!globalTabs.some((t) => t.id === currentActiveTab)) currentActiveTab = 'All';
      renderTabButtons(globalTabs, 'global');

      const wrap = h('div', 'kt-global-inspector-wrap');
      const d1 = currentActiveTab === 'All' || currentActiveTab === 'Project' ? mountProjectSettingsContent(wrap, app) : null;
      const d2 = currentActiveTab === 'All' || currentActiveTab === 'Viewport' ? mountViewportSettingsContent(wrap, app) : null;
      globalContentDisposable = {
        dispose(): void {
          d1?.dispose();
          d2?.dispose();
        },
      };
      scrollEl.append(wrap);
      return;
    }

    // Case 2: `output.tree` root node selected -> show its params + Project & Viewport tabs
    const isSingleTreeRoot = nodes.length === 1 && (nodes[0] as GraphNode).type === 'output.tree';
    const sharedDefs = resolveSharedParams(nodes);
    const sameType = nodes.every((n) => n.type === (nodes[0] as GraphNode).type);
    const tabSpecs = getInspectorTabSpecs(sameType ? (nodes[0] as GraphNode).type : null, sharedDefs);
    const tabs: InspectorTab[] = isSingleTreeRoot
      ? [...tabSpecs, { id: 'Project', label: 'Project' }, { id: 'Viewport', label: 'Viewport' }]
      : tabSpecs;
    const nodeTypeKey = nodes.length === 1 ? (nodes[0] as GraphNode).type : `multi:${nodes.map((n) => n.type).join(',')}`;

    if (!tabs.some((t) => t.id === currentActiveTab && !t.disabled)) {
      currentActiveTab = stateStore.getActiveTab(nodeTypeKey, tabs.filter((t) => !t.disabled).map((t) => t.id));
    }
    renderTabButtons(tabs, nodeTypeKey);

    if (isSingleTreeRoot && (currentActiveTab === 'Project' || currentActiveTab === 'Viewport')) {
      const wrap = h('div', 'kt-global-inspector-wrap');
      globalContentDisposable =
        currentActiveTab === 'Project'
          ? mountProjectSettingsContent(wrap, app)
          : mountViewportSettingsContent(wrap, app);
      scrollEl.append(wrap);
      return;
    }

    if (sharedDefs.length === 0) {
      scrollEl.append(h('div', 'kt-prop-empty', 'Selected nodes have no shared editable parameters.'));
      return;
    }

    // When search query has text, search across ALL tabs so the user finds any parameter immediately
    const effectiveTab = currentSearchQuery.trim() !== '' ? 'All' : currentActiveTab;
    const sectionModels = buildInspectorSections(sharedDefs, effectiveTab);
    const paramMaps: NodeParams[] = nodes.map((n) => n.params);
    const allLocked = nodes.every((n) => Boolean(n.locked));

    for (const secModel of sectionModels) {
      const isSearching = currentSearchQuery.trim() !== '';
      const MatchingEntriesCount = secModel.allDefs.filter((d) => matchesParamSearch(d, currentSearchQuery)).length;
      if (isSearching && MatchingEntriesCount === 0) continue;

      const initiallyCollapsed = !isSearching && stateStore.isCollapsed(secModel.key);
      const chev = icon('chevronDown', 14);
      if (initiallyCollapsed) chev.style.transform = 'rotate(-90deg)';

      const dotsBtn = iconButton(icon('dotsV', 14), 'Section menu', (e) => {
        const firstNode = nodes[0];
        const anyModified = secModel.allDefs.some((d) =>
          nodes.some((n) => isParamModified(d, n.params[d.id] ?? defaultParamState(d))),
        );
        showMenu(
          [
            {
              label: 'Reset section',
              disabled: allLocked || !anyModified,
              run: () => resetSectionToDefaults(nodes, secModel.allDefs),
            },
            {
              label: 'Copy',
              disabled: !firstNode,
              run: () => {
                if (firstNode) copySectionToClipboard(secModel.allDefs, firstNode.params);
              },
            },
            {
              label: 'Paste',
              disabled: allLocked || !getSectionClipboard(),
              run: () => pasteSectionValues(nodes, secModel.allDefs),
            },
            { separator: true },
            {
              label: 'Expand all sections',
              run: () => toggleAllSections(false),
            },
            {
              label: 'Collapse all sections',
              run: () => toggleAllSections(true),
            },
          ],
          e.currentTarget as HTMLElement,
        );
      });

      const sectionHead = h(
        'div',
        'kt-section-head',
        chev,
        h('span', 'kt-section-title', secModel.title),
        h('div', 'kt-spacer'),
        dotsBtn,
      );
      const sectionBody = h('div', 'kt-section-body');
      const sectionEl = h('div', `kt-section${initiallyCollapsed ? ' collapsed' : ''}`, sectionHead, sectionBody);

      const mountedSec: MountedSection = {
        model: secModel,
        sectionEl,
        chevEl: chev,
        bodyEl: sectionBody,
        blocks: [],
        mounted: false,
        mountBody(): void {
          if (this.mounted) return;
          this.mounted = true;

          for (const blk of secModel.blocks) {
            const subheadEl = blk.subhead ? h('div', 'kt-subhead', h('span', '', blk.subhead)) : null;
            if (subheadEl) sectionBody.append(subheadEl);

            const mountedEntries: MountedEntry[] = [];
            for (const entry of blk.entries) {
              const { def, pairedEnableDef } = entry;
              const states = nodes.map((n) => n.params[def.id] ?? defaultParamState(def));
              const mixedInfo = computeMixedParamState(def, states);

              let pairedOpt: Parameters<typeof mountParamRow>[1]['pairedEnable'];
              if (pairedEnableDef) {
                const pStates = nodes.map((n) => n.params[pairedEnableDef.id] ?? defaultParamState(pairedEnableDef));
                const pMixed = computeMixedParamState(pairedEnableDef, pStates);
                pairedOpt = {
                  def: pairedEnableDef,
                  state: pMixed.representative,
                  mixed: pMixed.valueMixed,
                  onChange: (nextP, mergeP) => {
                    isEditingParam = true;
                    applyParams(nodes.map((n) => n.id),
                      pairedEnableDef,
                      nextP,
                      mergeP,
                    );
                    isEditingParam = false;
                    syncMountedRowsInPlace();
                  },
                  onCommit: () => app.graph.endGesture(),
                };
              }

              const rowInst = mountParamRow(sectionBody, {
                def,
                state: mixedInfo.representative,
                nodeId: nodes.length === 1 ? (nodes[0] as GraphNode).id : undefined,
                nodeName: nodes.length === 1 ? (nodes[0] as GraphNode).name : `${nodes.length} nodes`,
                mixed: mixedInfo.valueMixed || mixedInfo.varianceMixed || mixedInfo.curveMixed,
                disabled: allLocked,
                pairedEnable: pairedOpt,
                resolveDynamicOptions,
                onChange: (nextState, merge) => {
                  isEditingParam = true;
                  applyParams(nodes.map((n) => n.id),
                    def,
                    nextState,
                    merge,
                  );
                  isEditingParam = false;
                  syncMountedRowsInPlace();
                },
                onCommit: () => {
                  app.graph.endGesture();
                },
              });

              const visible =
                matchesParamSearch(def, currentSearchQuery) && isParamVisibleForNodes(def, paramMaps) && passesOverrideFilter(def.id);
              rowInst.setVisible(visible);
              decorateRow({ def, row: rowInst });

              mountedEntries.push({ def, pairedEnableDef, row: rowInst });
            }

            if (subheadEl) {
              const anyVis = mountedEntries.some(
                (e) => matchesParamSearch(e.def, currentSearchQuery) && isParamVisibleForNodes(e.def, paramMaps),
              );
              subheadEl.hidden = !anyVis;
            }

            this.blocks.push({ subheadEl, entries: mountedEntries });
          }
        },
      };

      // Lazy mount: only mount rows immediately if not collapsed
      if (!initiallyCollapsed) {
        mountedSec.mountBody();
      }

      sectionHead.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.kt-icon-btn')) return;
        const nowCollapsed = sectionEl.classList.toggle('collapsed');
        chev.style.transform = nowCollapsed ? 'rotate(-90deg)' : '';
        stateStore.setCollapsed(secModel.key, nowCollapsed);
        if (!nowCollapsed && !mountedSec.mounted) {
          mountedSec.mountBody();
        }
      });

      mountedSections.push(mountedSec);
      scrollEl.append(sectionEl);
    }

    // If Tree root node is selected and 'All' tab is active, also append Project Settings below Tree section
    if (isSingleTreeRoot && effectiveTab === 'All') {
      const globalWrap = h('div', 'kt-global-inspector-wrap');
      globalContentDisposable = mountProjectSettingsContent(globalWrap, app);
      scrollEl.append(globalWrap);
    }

    if (scrollEl.children.length === 0) {
      scrollEl.append(h('div', 'kt-prop-empty', 'No matching properties.'));
    }
  };

  function renderTabButtons(tabs: readonly InspectorTab[], nodeTypeKey: string): void {
    tabsEl.replaceChildren();
    for (const spec of tabs) {
      const tab = spec.id;
      const btn = h('button', `kt-prop-tab${tab === currentActiveTab ? ' active' : ''}${spec.disabled ? ' disabled' : ''}`, spec.label);
      btn.type = 'button';
      if (spec.disabled) {
        btn.disabled = true;
        btn.title = spec.hint ?? 'No parameters yet';
        tabsEl.append(btn);
        continue;
      }
      btn.addEventListener('click', () => {
        currentActiveTab = tab;
        stateStore.setActiveTab(nodeTypeKey, tab);
        tabsEl.querySelectorAll('.kt-prop-tab').forEach((el) => el.classList.toggle('active', el === btn));
        renderInspectorBody();
      });
      tabsEl.append(btn);
    }
  }

  function resetSectionToDefaults(nodes: readonly GraphNode[], defs: readonly ParamDef[]): void {
    const view = nm();
    if (view) {
      for (const def of defs) if (view.overridden(def.id)) view.reset(def.id);
      return;
    }
    const model = app.graph.model;
    const cmds: SetParamCommand[] = [];
    for (const node of nodes) {
      if (node.locked) continue;
      for (const def of defs) {
        const defState = defaultParamState(def);
        if (isParamModified(def, node.params[def.id])) {
          cmds.push(new SetParamCommand(model, node.id, def.id, defState));
        }
      }
    }
    if (cmds.length > 0) {
      app.graph.exec(batch('Reset Section', cmds));
    }
  }

  function pasteSectionValues(nodes: readonly GraphNode[], defs: readonly ParamDef[]): void {
    const clip = getSectionClipboard();
    if (!clip) return;
    if (nm()) {
      app.notify('Paste is not available while editing instance overrides.');
      return;
    }
    const model = app.graph.model;
    const cmds: SetParamCommand[] = [];
    for (const node of nodes) {
      if (node.locked) continue;
      for (const def of defs) {
        const entry = clip[def.id];
        if (entry) {
          cmds.push(new SetParamCommand(model, node.id, def.id, structuredClone(entry)));
        }
      }
    }
    if (cmds.length > 0) {
      app.graph.exec(batch('Paste Section', cmds));
    }
  }

  function toggleAllSections(collapse: boolean): void {
    const keys = mountedSections.map((s) => s.model.key);
    stateStore.setAllCollapsed(keys, collapse);
    for (const sec of mountedSections) {
      sec.sectionEl.classList.toggle('collapsed', collapse);
      sec.chevEl.style.transform = collapse ? 'rotate(-90deg)' : '';
      if (!collapse && !sec.mounted) {
        sec.mountBody();
      }
    }
  }

  expandAllBtn.addEventListener('click', () => {
    const anyCollapsed = mountedSections.some((s) => s.sectionEl.classList.contains('collapsed'));
    toggleAllSections(!anyCollapsed);
  });

  // --- Search input handlers ---
  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape' && searchInput.value !== '') {
      e.preventDefault();
      searchInput.value = '';
      currentSearchQuery = '';
      clearSearchBtn.hidden = true;
      renderInspectorBody();
    }
  });

  searchInput.addEventListener('input', () => {
    const prevWasSearch = currentSearchQuery.trim() !== '';
    currentSearchQuery = searchInput.value;
    const nowIsSearch = currentSearchQuery.trim() !== '';
    clearSearchBtn.hidden = !nowIsSearch;
    if (prevWasSearch !== nowIsSearch || nowIsSearch) {
      renderInspectorBody();
    } else {
      syncMountedRowsInPlace();
    }
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    currentSearchQuery = '';
    clearSearchBtn.hidden = true;
    renderInspectorBody();
  });

  // --- Refresh on selection / graph / document changes ---
  const refreshSelection = (forceRebuild = false): void => {
    const nodes = getSelectedNodes();
    const st = app.store.get();
    const nextKey = `${st.activeDocumentId}::${nodes.map((n) => `${n.id}:${n.type}:${Boolean(n.locked)}`).join(',')}::${st.editMode}:${nm() ? st.instanceSelection.map((r) => r.key).join('.') : ''}`;
    updateHeaderOnly();
    if (forceRebuild || nextKey !== currentSelectionKey) {
      currentSelectionKey = nextKey;
      renderInspectorBody();
    } else {
      syncMountedRowsInPlace();
    }
  };

  refreshSelection(true);

  const unsubs = [
    app.store.select(
      (s) => s.selection,
      () => refreshSelection(false),
    ),
    app.store.select(
      (s) => s.activeDocumentId,
      () => refreshSelection(true),
    ),
    app.store.select(
      (s) => s.editMode,
      () => refreshSelection(false),
    ),
    app.store.select(
      (s) => s.instanceSelection,
      () => refreshSelection(false),
    ),
    app.events.on('graph:changed', () => {
      updateHeaderOnly();
      syncMountedRowsInPlace();
    }),
    app.engine.events.on('result', () => renderNodeBar()),
    app.graph.events.on('decorationsChanged', () => {
      updateHeaderOnly();
    }),
    app.graph.events.on('modelSwapped', () => {
      refreshSelection(true);
    }),
  ];

  return {
    dispose(): void {
      ro.disconnect();
      unsubs.forEach((u) => u());
      disposeMountedSections();
    },
  };
}
