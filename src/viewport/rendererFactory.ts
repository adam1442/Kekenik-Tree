import { WebGLRenderer, type WebGLRendererParameters } from 'three';

let available = false;

/**
 * Probe for a usable WebGL2 context (the only API three.js r163+ supports). Beyond `getContext` returning something it
 * checks that the context answers a real driver query, so DOM emulations and stubs (jsdom, canvas mocks) are rejected
 * before three.js starts logging errors. A positive result is cached; a negative one is re-probed (cheap).
 */
export function isWebGLAvailable(): boolean {
  if (available) return true;
  if (typeof document === 'undefined') return false;
  let ok = false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl && typeof gl.getShaderPrecisionFormat === 'function') {
      ok = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT) != null;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    ok = false;
  }
  if (ok) available = true;
  return ok;
}

/** A WebGLRenderer, or null when WebGL is unavailable or the renderer could not be created. Never throws. */
export function createWebGLRenderer(params: WebGLRendererParameters = {}): WebGLRenderer | null {
  if (!isWebGLAvailable()) return null;
  try {
    return new WebGLRenderer(params);
  } catch {
    return null;
  }
}

/** Renderer settings of the main 3D viewport. The scene is drawn into an HDR target, so the canvas stays opaque. */
export function createViewportRenderer(): WebGLRenderer | null {
  return createWebGLRenderer({ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
}
