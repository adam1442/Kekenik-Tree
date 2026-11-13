import type { NodeSpec } from './graphSpec';

/** Reference plants built ONLY from nodes and parameters (no code hacks). */
export const REFERENCE_GRAPHS: Record<string, NodeSpec[]> = {
  oak_broadleaf: [
    { id: 'tree', type: 'output.tree', name: 'Tree', parent: null, params: { radius: 6 } },
    {
      id: 'trunk', type: 'generator.trunk', name: 'Trunk', parent: 'tree',
      params: { length: 7.5, radius: 0.4, taper: 0.8, flareRadius: 0.4, flareHeight: 0.12, flareLobes: 6, crownHeight: 0.3, lean: 3, noiseAmount: { value: 0.35 }, earlyNoiseAmount: 0.1, splitChance: 0.5, splitStart: 0.7, splitSpread: 32, straightness: 0.25 },
    },
    {
      id: 'big', type: 'generator.branch', name: 'Big Branches', parent: 'trunk',
      params: { mode: 'phyllotaxy', number: 13, first: 0.34, last: 0.97, length: { value: 5.2, variance: 0.2 }, crownShape: 'oval', radius: 0.13, spread: { value: 58, variance: 0.18 }, gravity: 0.1, upDown: 0.12, curvature: 0.14, noiseAmount: 0.4, splitChance: 0.4, pruneDown: 0.5 },
    },
    {
      id: 'small', type: 'generator.branch', name: 'Small Branches', parent: 'big',
      params: { mode: 'phyllotaxy', number: 11, first: 0.12, last: 0.98, length: 2.3, crownShape: 'natural', radius: 0.045, spread: { value: 50, variance: 0.25 }, gravity: 0.12, noiseAmount: 0.3, zigzag: 0.15 },
    },
    { id: 'leaf', type: 'generator.leaf', name: 'Leaves', parent: 'small', params: { number: 10, first: 0.1, last: 1 } },
  ],
  spruce_conifer: [
    { id: 'tree', type: 'output.tree', name: 'Tree', parent: null, params: { radius: 5 } },
    {
      id: 'trunk', type: 'generator.trunk', name: 'Trunk', parent: 'tree',
      params: { length: 17, radius: 0.3, taper: 0.97, flareRadius: 0.2, crownHeight: 0.06, lean: 0.4, noiseAmount: 0.05, earlyNoiseAmount: 0.02, straightness: 0.9 },
    },
    {
      id: 'whorls', type: 'generator.branch', name: 'Whorled Branches', parent: 'trunk',
      params: { mode: 'whorled', whorlCount: 20, whorlPerStep: 5, whorlSpread: 0.02, first: 0.1, last: 0.99, length: { value: 4.4, variance: 0.1 }, crownShape: 'conical', radius: 0.05, spread: 82, gravity: 0.22, upDown: 0.15, curvature: 0.08, noiseAmount: 0.06, straightness: 0.5, pruneInterior: 0 },
    },
    {
      id: 'sub', type: 'generator.branch', name: 'Branchlets', parent: 'whorls',
      params: { mode: 'phyllotaxy', number: 9, first: 0.15, last: 0.95, length: 1.1, crownShape: 'conical', radius: 0.012, spread: 62, gravity: 0.16, noiseAmount: 0.1 },
    },
    { id: 'needles', type: 'generator.leaf', name: 'Needles', parent: 'sub', params: { number: 9, first: 0.1, last: 1 } },
  ],
  birch: [
    { id: 'tree', type: 'output.tree', name: 'Tree', parent: null, params: { radius: 4 } },
    {
      id: 'trunk', type: 'generator.trunk', name: 'Trunk', parent: 'tree',
      params: { length: 11, radius: 0.16, taper: 0.9, flareRadius: 0.1, crownHeight: 0.4, lean: 4, noiseAmount: 0.22, earlyNoiseAmount: 0.08, straightness: 0.55, zigzag: 0.05 },
    },
    {
      id: 'limbs', type: 'generator.branch', name: 'Limbs', parent: 'trunk',
      params: { mode: 'phyllotaxy', number: 15, first: 0.42, last: 0.98, length: { value: 3.8, variance: 0.2 }, crownShape: 'vase', radius: 0.035, spread: { value: 36, variance: 0.2 }, gravity: 0.28, upDown: 0.05, curvature: 0.18, noiseAmount: 0.3, curlUp: 0.15, pruneDown: 0.7 },
    },
    {
      id: 'twigs', type: 'generator.branch', name: 'Twigs', parent: 'limbs',
      params: { mode: 'phyllotaxy', number: 14, first: 0.15, last: 1, length: 1.5, crownShape: 'natural', radius: 0.01, spread: 44, gravity: 0.4, noiseAmount: 0.25, zigzag: 0.2 },
    },
    { id: 'leaf', type: 'generator.leaf', name: 'Leaves', parent: 'twigs', params: { number: 12, first: 0.1, last: 1 } },
  ],
};
