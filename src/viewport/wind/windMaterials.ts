import { MeshDepthMaterial, RGBADepthPacking, Vector4, type IUniform, type Material, type WebGLProgramParametersWithUniforms } from 'three';
import type { MeshWindOverride } from './windParams';
import { WIND_GLSL_APPLY, WIND_GLSL_DECLARATIONS, WIND_GLSL_FUNCTION } from './windShader';

/** Shared (global) uniform objects: one instance drives every patched material and the depth material. */
export interface WindUniforms {
  a: IUniform<Vector4>;
  b: IUniform<Vector4>;
  c: IUniform<Vector4>;
  d: IUniform<Vector4>;
}

export function createWindUniforms(): WindUniforms {
  return {
    a: { value: new Vector4(1, 0, 0, 0.3) },
    b: { value: new Vector4(1, 0.3, 0.3, 1) },
    c: { value: new Vector4(0.5, 1, 1, 0.3) },
    d: { value: new Vector4(0.2, 0, 10, 0.6) },
  };
}

const CACHE_KEY = 'kt-wind-v1';

function patchShader(shader: WebGLProgramParametersWithUniforms, u: WindUniforms, mesh: IUniform<Vector4>): void {
  shader.uniforms.uWindA = u.a;
  shader.uniforms.uWindB = u.b;
  shader.uniforms.uWindC = u.c;
  shader.uniforms.uWindD = u.d;
  shader.uniforms.uWindMesh = mesh;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WIND_GLSL_DECLARATIONS}\n${WIND_GLSL_FUNCTION}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_GLSL_APPLY}`);
}

/**
 * Make any three.js material wind-aware (idempotent). Call this for every material you create (the scene
 * sync already does it for materials returned by the `MaterialResolver`). Works with Standard / Physical / Basic /
 * Lambert / Phong / Depth materials; custom ShaderMaterials must include the chunks from `windShader.ts` themselves.
 */
export function applyWindToMaterial(material: Material, uniforms: WindUniforms, override?: MeshWindOverride): void {
  if (material.userData.ktWindMesh !== undefined) return;
  if ((material as Material & { isShaderMaterial?: boolean }).isShaderMaterial === true) return;
  const meshUniform: IUniform<Vector4> = { value: override ? new Vector4(override.amount, override.flutter, override.stiffness, override.flutterFrequency) : new Vector4(1, 1, -1, 1) };
  material.userData.ktWindMesh = meshUniform;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    patchShader(shader, uniforms, meshUniform);
  };
  const previousKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${previousKey.call(material)}|${CACHE_KEY}`;
  material.needsUpdate = true;
}

/** Depth material for the shadow pass that follows the same wind displacement (set as `mesh.customDepthMaterial`). */
export function createWindDepthMaterial(uniforms: WindUniforms, override?: MeshWindOverride): MeshDepthMaterial {
  return new WindDepthMaterial(uniforms, override);
}

/**
 * Depth material whose `clone()` keeps the wind patch. three.js clones the custom depth material for alpha-tested
 * meshes (cut-out leaves), which would otherwise drop `onBeforeCompile` and make the shadows ignore the wind.
 */
class WindDepthMaterial extends MeshDepthMaterial {
  constructor(
    private readonly windUniforms: WindUniforms,
    private readonly windOverride?: MeshWindOverride,
  ) {
    super({ depthPacking: RGBADepthPacking });
    applyWindToMaterial(this, windUniforms, windOverride);
  }

  override clone(): this {
    const m = new WindDepthMaterial(this.windUniforms, this.windOverride);
    m.copy(this);
    return m as this;
  }
}

/**
 * Per-mesh overrides cannot be uniforms of a shared material (three.js only re-uploads material uniforms when the
 * material changes), so a mesh with a non-neutral override gets its own clone carrying the override values.
 */
export function createWindVariant(base: Material, uniforms: WindUniforms, override: MeshWindOverride): Material {
  const v = base.clone();
  // clone() deep-copies userData through JSON: drop the serialised uniform of the source before patching.
  delete v.userData.ktWindMesh;
  applyWindToMaterial(v, uniforms, override);
  return v;
}

