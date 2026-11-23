// Global vitest setup: jsdom has no canvas or WebGL. Make every canvas context request answer "not supported"
// (null, like a browser without WebGL) so no test ever constructs a real WebGLRenderer or hits jsdom's
// "not implemented" noise. Individual tests may still install their own 2D context stub in beforeAll.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
