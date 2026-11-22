import type { ListItem, ListParamDef } from '@/contracts/params';
import { getMaterialLibrary } from '@/materials/library';
import { MESH_ANY, materialChoices, meshChoices, slotProbabilities } from '@/materials/meshSelection';
import type { ParamWidgetInstance, ParamWidgetMountOptions } from '../paramWidgetRegistry';
import { createListWidget } from './listWidget';

const percent = (p: number): string => `${Math.round(p * 100)}%`;

/**
 * `MaterialSlotList`: the repeatable Material / Mesh / Weight rows used by generators that place meshes. The Material
 * dropdown offers every material and Material Set (or None), the Mesh dropdown offers Any / Primary / Not primary plus
 * the chosen material's named meshes, and each row shows its pick probability (weight / sum of weights).
 */
export function createMaterialSlotList(host: HTMLElement, opts: ParamWidgetMountOptions<ListParamDef>): ParamWidgetInstance {
  return createListWidget(host, opts, {
    fieldOptions(fieldId, item) {
      const lib = getMaterialLibrary();
      if (fieldId === 'material') return materialChoices(lib);
      if (fieldId === 'mesh') return meshChoices(String(item.material ?? ''), lib, String(item.mesh ?? MESH_ANY));
      return undefined;
    },
    rowChanged(item: ListItem, fieldId) {
      if (fieldId !== 'material') return false;
      // A mesh of the previous material is meaningless for the new one: fall back to "Any".
      const options = meshChoices(String(item.material ?? ''), getMaterialLibrary());
      if (!options.some((o) => o.value === item.mesh)) item.mesh = MESH_ANY;
      return true;
    },
    rowHint(item, items) {
      const i = items.indexOf(item);
      const probs = slotProbabilities(items.map((x) => ({ weight: Number(x.weight ?? 1) })));
      return i >= 0 ? percent(probs[i] ?? 0) : '';
    },
  });
}
