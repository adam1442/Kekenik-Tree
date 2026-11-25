import type { ProjectFile } from '@/contracts/project';

export type PresetCategory = 'Broadleaf' | 'Palm & Tropical' | 'Shrubs & Plants' | 'Special';

export const PRESET_CATEGORIES: readonly PresetCategory[] = ['Broadleaf', 'Palm & Tropical', 'Shrubs & Plants', 'Special'];

/** A browsable library entry (built-in sample project or a user preset). */
export interface PresetEntry {
  id: string;
  name: string;
  category: PresetCategory | 'User';
  description: string;
  tags: string[];
  builtin: boolean;
  /** Highlighted entry (built-ins only). */
  hero?: boolean;
  /** Decodes the sample file (built-ins) or returns the stored project (user presets). */
  load(): Promise<ProjectFile>;
  /** Stable key for the thumbnail cache; changes whenever the content changes. */
  revision: string;
}
