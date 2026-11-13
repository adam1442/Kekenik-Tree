export const WIND_GLSL_DECLARATIONS = /* glsl */ `
uniform vec4 uWindA; // dirX, dirY, strength (0 when disabled), gust strength
uniform vec4 uWindB; // gust frequency, turbulence, ripple, quality (1 = high)
uniform vec4 uWindC; // trunk response, branch response, leaf response, stiffness
uniform vec4 uWindD; // damping, clock (seconds * speed), tree height, base hold (m)
uniform vec4 uWindMesh; // amount, flutter, stiffness override (-1 = none), flutter frequency
attribute vec3 windPivot;
attribute vec4 windWeights;
`;

export const WIND_GLSL_FUNCTION = /* glsl */ `
vec3 ktWindRotate(vec3 v, vec3 axis, float a) {
  float s = sin(a);
  float c = cos(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

// p: mesh-local vertex, wp: world-ish position (phase source), toLocal: world -> local rotation/scale.
vec3 ktWindLocal(vec3 p, vec3 pivot, vec4 w, vec3 wp, mat3 toLocal) {
  float strength = uWindA.z * uWindMesh.x;
  if (strength <= 0.0 || (w.x + w.y + w.z) <= 0.0) return p;
  // Ground anchor: exactly 0 at / below the ground (z <= 0 in plant space, so every trunk of a placement disc and
  // all roots stay fixed), smoothstep up to the base hold height. Mirrors windReference.ts#anchorWeight.
  float hold = uWindD.w;
  float anchor = hold > 1e-4 ? smoothstep(0.0, hold, wp.z) : step(1e-4, wp.z);
  if (anchor <= 0.0) return p;
  float t = uWindD.y;
  float H = max(uWindD.z, 0.5);
  float stiff = uWindMesh.z >= 0.0 ? uWindMesh.z : uWindC.w;
  float freqK = 1.0 + stiff * 1.5;
  float ampK = 1.0 / (1.0 + stiff * 3.0);
  float osc = 1.0 - uWindD.x;
  float phase = w.w * 6.2831853;
  bool hq = uWindB.w > 0.5;
  vec3 dirW = vec3(uWindA.x, uWindA.y, 0.0);
  vec3 sideW = vec3(-uWindA.y, uWindA.x, 0.0);

  // Gusts travel along the wind direction.
  float ga = dot(wp.xy, uWindA.xy) * 0.12 - t * 0.9 * uWindB.x;
  float gust = 0.5 + 0.5 * (sin(ga) * 0.6 + sin(ga * 2.31 + 1.7) * 0.4);
  float A = max(0.0, strength * (1.0 + uWindA.w * (gust * 2.0 - 1.0)));

  // level 0: trunk
  float o0 = sin(t * 0.7 * freqK + 0.6 * sin(t * 0.31));
  float d0 = H * 0.04 * uWindC.x * w.x * ampK * A * (1.0 + 0.6 * osc * o0);
  // level 1: branches
  float o1 = sin(t * 1.7 * freqK + phase) + 0.5 * sin(t * 2.9 * freqK + phase * 2.3);
  float p1 = A * (0.4 + 0.6 * osc * o1);
  float d1 = H * 0.015 * uWindC.y * w.y * ampK * p1;
  float c1 = H * 0.006 * uWindC.y * w.y * ampK * A * sin(t * 1.3 * freqK + phase * 1.7) * osc;
  vec3 dispW = dirW * (d0 + d1) + sideW * c1;
  if (hq) {
    float tb = sin(t * 5.3 + phase * 3.1) * 0.5 + sin(t * 3.7 + dot(wp, vec3(1.7, 1.3, 0.9))) * 0.5;
    dispW += (dirW * 0.6 + sideW * tb) * (H * 0.004 * uWindB.y * w.y * uWindC.y * A * tb);
  }

  dispW *= anchor;
  vec3 rel = p - pivot;
  vec3 res = p + toLocal * dispW;
  // level 2: leaf flutter (rotation about the pivot) + ripple
  if (w.z > 0.0) {
    float f2 = 5.0 * uWindMesh.w * freqK;
    float o2 = sin(t * f2 + phase * 9.0 + dot(wp, vec3(1.3, 0.7, 1.1)));
    float turb = 0.0;
    if (hq) turb = uWindB.y * (sin(t * 11.3 + phase * 31.0) * 0.5 + sin(t * 7.1 + dot(wp, vec3(2.1, 1.7, 0.3))) * 0.5);
    float ang = anchor * w.z * uWindC.z * uWindMesh.y * ampK * (A * 0.35 + osc * o2 * 0.22 * (A * 0.5 + 0.3) + turb * 0.3 * A);
    vec3 axis = normalize(toLocal * sideW + vec3(1e-6));
    res = pivot + ktWindRotate(rel, axis, ang) + toLocal * dispW;
    if (hq && uWindB.z > 0.0) {
      float len = length(rel);
      float rip = sin(len * 18.0 - t * 7.0 * freqK + phase * 5.0) * uWindB.z * w.z * uWindC.z * len * 0.08 * (0.3 + A) * anchor;
      res += toLocal * vec3(0.0, 0.0, rip);
    }
  }
  return res;
}
`;

/** Inserted right after `#include <begin_vertex>`. */
export const WIND_GLSL_APPLY = /* glsl */ `
#ifdef USE_INSTANCING
  mat3 ktIM = mat3(instanceMatrix);
  float ktSc = max(length(ktIM[0]), 1e-4);
  vec3 ktWp = (instanceMatrix * vec4(transformed, 1.0)).xyz;
  mat3 ktToLocal = transpose(ktIM) / (ktSc * ktSc);
#else
  vec3 ktWp = transformed;
  mat3 ktToLocal = mat3(1.0);
#endif
transformed = ktWindLocal(transformed, windPivot, windWeights, ktWp, ktToLocal);
`;
