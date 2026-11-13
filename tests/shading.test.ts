import { describe, expect, it } from 'vitest';
import { ShaderChunk } from 'three';
import { lightsFragmentBegin } from '@/materials/ktShader';
import { defaultMaterials } from '@/materials/library';
import { getShadingSettings, setShadingSettings } from '@/materials/shadingSettings';
import { LIGHTING_PRESETS } from '@/viewport/lighting';

describe('foliage shading hook', () => {
  const patched = lightsFragmentBegin();
  const dirBlock = patched.indexOf('NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');

  it('injects the transmission hook exactly once, inside the directional light loop', () => {
    expect(patched.split('#ifdef KT_FOLIAGE').length - 1).toBe(2); // prelude + hook
    const hook = patched.indexOf('float ktNL');
    expect(hook).toBeGreaterThan(dirBlock);
    expect(patched.indexOf('float ktNL', hook + 1)).toBe(-1);
  });

  it('keeps three.js lighting code intact and runs the hook after the shadowed RE_Direct call', () => {
    expect(patched.length).toBeGreaterThan(ShaderChunk.lights_fragment_begin.length);
    const re = patched.indexOf('RE_Direct(', dirBlock);
    expect(patched.indexOf('float ktNL')).toBeGreaterThan(re);
    expect(patched.replace(/#ifdef KT_FOLIAGE[\s\S]*?#endif\n/g, '')).toContain('getDirectionalLightInfo');
  });
});

describe('lighting presets and defaults', () => {
  it('all presets define every setting and valid ranges', () => {
    const keys = Object.keys(LIGHTING_PRESETS.Day ?? {}).sort();
    for (const [name, p] of Object.entries(LIGHTING_PRESETS)) {
      expect(Object.keys(p).sort(), name).toEqual(keys);
      expect(p.sunElevation).toBeGreaterThan(0.05);
      expect(p.shadowSoftness).toBeGreaterThanOrEqual(0);
      expect(p.exposure).toBeGreaterThan(0);
    }
    expect(Object.keys(LIGHTING_PRESETS)).toEqual(expect.arrayContaining(['Day', 'Overcast', 'Sunset', 'Studio', 'Golden Hour', 'Foggy Morning', 'Moonlight']));
  });

  it('shading settings are patched immutably and bark has no colour variation by default', () => {
    const before = getShadingSettings();
    setShadingSettings({ foliageWrap: 0.5 });
    expect(getShadingSettings().foliageWrap).toBe(0.5);
    expect(before.foliageWrap).not.toBe(0.5);
    setShadingSettings({ foliageWrap: before.foliageWrap });
    const bark = defaultMaterials().find((m) => m.id === 'bark');
    expect(bark?.variationAmount).toBe(0);
    expect(defaultMaterials().find((m) => m.id === 'leaf')?.slots.subsurfacePercent?.scalar).toBeGreaterThan(0);
  });
});
