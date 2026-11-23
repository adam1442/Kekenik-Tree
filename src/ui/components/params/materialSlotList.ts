import { getString, type ListItem, type ListParamDef, type NodeParams } from '@/contracts/params';
import { iconButton } from '../dom';
import { icon } from '../../icons/icons';
import { getMaterialLibrary } from '@/materials/library';
import { MESH_ANY, materialChoices, meshChoices, slotProbabilities } from '@/materials/meshSelection';
import { uvAreaChoices } from '@/materials/uvAreaChoices';
import { MATERIAL_INHERITED } from '@/generators/uv';
import type { ParamWidgetInstance, ParamWidgetMountOptions } from '../paramWidgetRegistry';
import { createListWidget } from './listWidget';

const percent = (p: number): string => `${Math.round(p * 100)}%`;
/** Pick probability of a row (weight / sum of weights), shown next to the Weight field. */
const pickProbabilityHint = (item: ListItem, items: ListItem[]): string => {
  const i = items.indexOf(item);
  const probs = slotProbabilities(items.map((x) => ({ weight: Number(x.weight ?? 1) })));
  return i >= 0 ? percent(probs[i] ?? 0) : '';
};
const isPlain = (ref: string): boolean => getMaterialLibrary().materials().some((m) => m.id === ref);

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
    rowHint: pickProbabilityHint,
  });
}

/**
 * `barkMaterials`: the Material / Weight rows of a Branch (or its extensions). The Material dropdown also offers
 * `Inherited` (the parent's material). While Tiling is a 0-1 patches style a patch options button on every row reveals
 * its UV Area (Whole map / Any / a named UV Area of the material) and Placement (Anywhere / First ring).
 */
export function createBarkMaterialList(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<ListParamDef>,
  variant: { alwaysPatch?: boolean; placement?: boolean } = {},
): ParamWidgetInstance {
  const open = new Set<number>();
  const showPlacement = variant.placement !== false;
  const patchMode = (): boolean => {
    if (variant.alwaysPatch) return true;
    const params: NodeParams | undefined = opts.nodeParams?.();
    return params !== undefined && getString(params, 'uvTilingStyle', 'tiling') !== 'tiling';
  };
  return createListWidget(host, opts, {
    fieldOptions(fieldId, item) {
      const lib = getMaterialLibrary();
      if (fieldId === 'material') return [...materialChoices(lib), { value: MATERIAL_INHERITED, label: 'Inherited' }];
      if (fieldId === 'uvArea') return uvAreaChoices(String(item.material ?? ''), lib.uvAreas(), isPlain(String(item.material ?? '')), String(item.uvArea ?? 'whole'));
      return undefined;
    },
    rowChanged(item: ListItem, fieldId) {
      if (fieldId !== 'material') return false;
      // An area of the previous material is meaningless for the new one: fall back to the whole map.
      const known = uvAreaChoices(String(item.material ?? ''), getMaterialLibrary().uvAreas(), isPlain(String(item.material ?? ''))).some((o) => o.value === item.uvArea);
      if (!known) item.uvArea = 'whole';
      return true;
    },
    rowHint: pickProbabilityHint,
    fieldHidden: (fieldId, _item, index) =>
      (fieldId === 'uvArea' || fieldId === 'placement') && (!(patchMode() && open.has(index)) || (fieldId === 'placement' && !showPlacement)),
    rowControl(_item, index, rerender) {
      if (!patchMode()) return null;
      const btn = iconButton(
        icon('gear', 14),
        showPlacement ? 'Patch options: UV Area and Placement' : 'Patch options: UV Area',
        () => {
          if (open.has(index)) open.delete(index);
          else open.add(index);
          rerender();
        },
        'kt-type-patch',
      );
      btn.classList.toggle('active', open.has(index));
      return btn;
    },
  });
}
