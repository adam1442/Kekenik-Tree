import type { ParamValue } from '@/contracts/params';
import type { ProjectFile } from '@/contracts/project';
import type { Rgb, TextureKind } from './procTextures';

/** One node of a preset graph (flat list, parents before children). */
export interface NodeSpec {
  id: string;
  type: string;
  name?: string;
  parent: string | null;
  params?: Record<string, ParamValue | { value: ParamValue; variance?: number }>;
}

export type PresetCategory = 'Broadleaf' | 'Conifer' | 'Palm & Tropical' | 'Shrubs & Plants' | 'Succulent' | 'Special';

export const PRESET_CATEGORIES: readonly PresetCategory[] = ['Broadleaf', 'Conifer', 'Palm & Tropical', 'Shrubs & Plants', 'Succulent', 'Special'];

/** Material slot content of a species: a neutral generated map the user can replace. */
export interface MaterialSpec {
  /** `bark` or `leaf` (ids the generators use by default). */
  id: 'bark' | 'leaf' | 'cluster';
  name: string;
  /** Base colour baked into the placeholder map. */
  color: Rgb;
  texture: TextureKind;
  twoSided?: boolean;
  gloss?: number;
  /** 0..1 amount of hue variation between instances. */
  variation?: number;
}

export interface WindSpec {
  strength?: number;
  stiffness?: number;
  baseHold?: number;
  trunkResponse?: number;
  branchResponse?: number;
  leafResponse?: number;
  gustiness?: number;
  frequency?: number;
}

export interface SpeciesDef {
  id: string;
  name: string;
  category: PresetCategory;
  description: string;
  tags: string[];
  seed: number;
  nodes: NodeSpec[];
  materials: MaterialSpec[];
  wind: WindSpec;
}

/** A browsable library entry (built-in species or a user preset). */
export interface PresetEntry {
  id: string;
  name: string;
  category: PresetCategory | 'User';
  description: string;
  tags: string[];
  builtin: boolean;
  /** Builds the project (built-ins) or returns the stored one (user presets). */
  load(): Promise<ProjectFile>;
  /** Stable key for the thumbnail cache; changes whenever the content changes. */
  revision: string;
}
