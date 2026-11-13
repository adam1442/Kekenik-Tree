import { PANEL } from '../docking/layoutPresets';
import { registerPanel } from '../docking/panelRegistry';
import { createGraphPanel } from './graph/graphPanel';
import { createDisplacementsPanel } from './displacementsPanel';
import { createLibraryPanel } from './libraryPanel';
import { createLightingPanel } from './lightingPanel';
import { createLodPanel } from './lodPanel';
import { createMasksPanel } from './masksPanel';
import { createMaterialSetsPanel } from './materialSetsPanel';
import { createMaterialsPanel } from './materialsPanel';
import { createMeshesPanel } from './meshesPanel';
import {
  createProjectSettingsPanel,
  createPropertiesPanel,
  createViewportSettingsPanel,
} from './propertiesPanel';
import { createViewportPanel } from './viewportPanel';
import { createViewportQualityPanel } from './viewportQualityPanel';
import { createWindPanel } from './windPanel';

/** Registers every built-in panel. New panels are added here (or in their own module) via registerPanel(). */
export function registerBuiltinPanels(): void {
  registerPanel({
    id: PANEL.viewport,
    title: 'Viewport',
    icon: 'cube',
    component: createViewportPanel,
    defaultDock: 'center',
    minSize: { w: 320, h: 240 },
    closable: false,
    singleton: true,
    headerless: true,
    floatSize: { w: 720, h: 520 },
  });
  registerPanel({
    id: PANEL.graph,
    title: 'Generation',
    icon: 'nodes',
    component: createGraphPanel,
    defaultDock: 'left',
    minSize: { w: 220, h: 140 },
    floatSize: { w: 420, h: 420 },
  });
  registerPanel({
    id: PANEL.properties,
    title: 'Properties',
    icon: 'gear',
    component: createPropertiesPanel,
    defaultDock: 'left',
    minSize: { w: 260, h: 160 },
    floatSize: { w: 400, h: 560 },
  });
  registerPanel({
    id: PANEL.materials,
    title: 'Materials',
    icon: 'materials',
    component: createMaterialsPanel,
    defaultDock: 'right',
    minSize: { w: 260, h: 160 },
    floatSize: { w: 380, h: 640 },
  });
  registerPanel({
    id: PANEL.materialLibrary,
    title: 'Material Sets',
    icon: 'layers',
    component: createMaterialSetsPanel,
    defaultDock: 'right',
    minSize: { w: 220, h: 140 },
  });
  registerPanel({
    id: PANEL.meshes,
    title: 'Meshes',
    icon: 'meshList',
    component: createMeshesPanel,
    defaultDock: 'right',
    minSize: { w: 220, h: 140 },
    floatSize: { w: 380, h: 640 },
  });
  registerPanel({
    id: PANEL.masks,
    title: 'Masks',
    icon: 'toolPaint',
    component: createMasksPanel,
    defaultDock: 'right',
    minSize: { w: 220, h: 140 },
  });
  registerPanel({
    id: PANEL.displacements,
    title: 'Displacements',
    icon: 'curve',
    component: createDisplacementsPanel,
    defaultDock: 'right',
    minSize: { w: 220, h: 140 },
    floatSize: { w: 380, h: 560 },
  });
  registerPanel({
    id: PANEL.lighting,
    title: 'Lighting',
    icon: 'sun',
    component: createLightingPanel,
    defaultDock: 'right',
    minSize: { w: 240, h: 160 },
    floatSize: { w: 360, h: 640 },
  });
  registerPanel({
    id: PANEL.viewportQuality,
    title: 'Viewport Quality',
    icon: 'cube',
    component: createViewportQualityPanel,
    defaultDock: 'right',
    minSize: { w: 240, h: 160 },
    floatSize: { w: 360, h: 640 },
  });
  registerPanel({
    id: PANEL.timeline,
    title: 'Wind & Timeline',
    icon: 'wind',
    component: createWindPanel,
    defaultDock: 'bottom',
    minSize: { w: 240, h: 120 },
    floatSize: { w: 380, h: 560 },
  });
  registerPanel({
    id: 'project-settings',
    title: 'Project Settings',
    icon: 'globe',
    component: createProjectSettingsPanel,
    defaultDock: 'left',
    minSize: { w: 260, h: 160 },
    floatSize: { w: 380, h: 520 },
  });
  registerPanel({
    id: 'viewport-settings',
    title: 'Viewport Settings',
    icon: 'eye',
    component: createViewportSettingsPanel,
    defaultDock: 'right',
    minSize: { w: 260, h: 160 },
    floatSize: { w: 380, h: 520 },
  });
  registerPanel({
    id: PANEL.library,
    title: 'Library',
    icon: 'layers',
    component: createLibraryPanel,
    defaultDock: 'right',
    minSize: { w: 240, h: 200 },
    floatSize: { w: 420, h: 560 },
  });
  registerPanel({
    id: 'lods',
    title: 'LODs',
    icon: 'layers',
    component: createLodPanel,
    defaultDock: 'right',
    minSize: { w: 360, h: 200 },
    floatSize: { w: 640, h: 360 },
  });
}
