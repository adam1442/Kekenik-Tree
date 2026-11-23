import type { UVAreaDef } from '@/contracts/material';

export interface UvAreaChoice {
  value: string;
  label: string;
}

/**
 * UV Area dropdown of a material row: Whole map, Any, then the named areas of the material. A Material Set, Inherited or
 * None (`plainMaterial` false) offers every area because the member is only known when the plant is generated. `current`
 * stays selectable even when it no longer exists, so a stored value is never silently rewritten.
 */
export function uvAreaChoices(materialRef: string, areas: readonly UVAreaDef[], plainMaterial: boolean, current = 'whole'): UvAreaChoice[] {
  const list = plainMaterial ? areas.filter((a) => a.materialId === materialRef) : areas;
  const out: UvAreaChoice[] = [
    { value: 'whole', label: 'Whole map' },
    { value: 'any', label: 'Any' },
    ...list.map((a) => ({ value: a.id, label: a.name })),
  ];
  if (!out.some((o) => o.value === current)) {
    const stale = areas.find((a) => a.id === current || a.name === current);
    if (stale) out.push({ value: stale.id, label: stale.name });
  }
  return out;
}
