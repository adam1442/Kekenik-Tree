import { beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '@/app/context';
import { findTreeWindNode, setWindParam } from '@/app/windControl';
import { defaultWindSettings, type WindSettings } from '@/contracts/material';
import { GraphModel } from '@/graph/model/graphModel';
import { registerDiscoveredNodes } from '@/graph/registry';
import { loadSample } from './helpers/sampleProjects';
import { windNodeParamId } from '@/viewport/wind/windParams';

beforeAll(() => registerDiscoveredNodes());

function fakeApp(model: GraphModel, project: WindSettings): { app: AppContext; marked: () => number } {
  let marked = 0;
  const app = {
    graph: {
      model,
      setParam: (nodeId: string, paramId: string, patch: { value?: unknown }): void => {
        const prev = model.getNode(nodeId)?.params[paramId] ?? { value: null };
        model.setParam(nodeId, paramId, { ...prev, ...patch } as typeof prev);
      },
    },
    project: { metaOf: () => ({ settings: { wind: project } }) },
    store: { get: () => ({ activeDocumentId: 'doc' }) },
    undo: { markDirty: (): void => void (marked += 1) },
  } as unknown as AppContext;
  return { app, marked: () => marked };
}

describe('wind controls edit the effective wind source', () => {
  it('a sample with a Wind node on the Tree: its Enabled switch can be toggled', () => {
    const model = GraphModel.fromJSON(loadSample('birch').graph);
    const wind = findTreeWindNode(model);
    expect(wind?.type).toBe('wind.settings');
    const before = wind?.params.enabled?.value === true;
    const project = defaultWindSettings();
    const { app, marked } = fakeApp(model, project);
    setWindParam(app, 'enabled', !before);
    expect(model.getNode(wind!.id)?.params.enabled?.value).toBe(!before);
    // The project settings are left alone while a node overrides them.
    expect(project.enabled).toBe(false);
    expect(marked()).toBe(0);
  });

  it('maps parameter keys to the Wind node ids', () => {
    const model = GraphModel.fromJSON(loadSample('birch').graph);
    const wind = findTreeWindNode(model)!;
    const { app } = fakeApp(model, defaultWindSettings());
    setWindParam(app, 'directionDeg', 123);
    setWindParam(app, 'gustStrength', 0.7);
    setWindParam(app, 'turbulence', 0.5);
    expect(model.getNode(wind.id)?.params[windNodeParamId('directionDeg')]?.value).toBe(123);
    expect(model.getNode(wind.id)?.params.gustiness?.value).toBe(0.7);
    expect(model.getNode(wind.id)?.params.turbulence?.value).toBe(0.5);
  });

  it('without a Wind node on the Tree the project settings are written', () => {
    const model = new GraphModel();
    expect(findTreeWindNode(model)).toBeUndefined();
    const project = defaultWindSettings();
    const { app, marked } = fakeApp(model, project);
    setWindParam(app, 'enabled', true);
    setWindParam(app, 'strength', 2);
    expect(project.enabled).toBe(true);
    expect(project.strength).toBe(2);
    expect(marked()).toBe(2);
  });
});
