import type { ProjectFile } from '@/contracts/project';
import type { MaterialSource } from '@/materials/materialSource';

/** The material source the app installs for a document: its own materials and Material Sets (needed by seasonal presets). */
export function projectMaterialSource(project: Pick<ProjectFile, 'materials' | 'materialSets' | 'displacements' | 'masks'>, season = 0.5): MaterialSource {
  return {
    materials: () => project.materials,
    sets: () => project.materialSets ?? [],
    displacements: () => project.displacements ?? [],
    masks: () => project.masks ?? [],
    season: () => season,
  };
}

/** True for the bark materials of a preset ('bark' and the seasonal 'bark-<season>' variants). */
export const isBarkMaterial = (id: string): boolean => id === 'bark' || id.startsWith('bark-');
