// GLSL for the sky. Stars/lines are stored as J2000 unit vectors; `uEqToWorld` (per-frame mat3)
// rotates them to the local horizon frame on the GPU and `refractAlt` lifts them by atmospheric refraction.

export const COMMON = /* glsl */ `
uniform mat3 uEqToWorld;
uniform float uNight;     // 0 normal, 1 red night mode
const float D2R = 0.017453292519943295;

vec3 refractWorld(vec3 v) {
  float alt = asin(clamp(v.y, -1.0, 1.0)) / D2R;
  if (alt < -1.5) return v;
  float r = (1.02 / tan((alt + 10.3 / (alt + 5.11)) * D2R)) / 60.0;
  float na = (alt + r) * D2R;
  float h = length(v.xz);
  if (h < 1e-6) return v;
  return vec3(v.x * cos(na) / h, sin(na), v.z * cos(na) / h);
}
`;

export const NIGHT_FRAG = /* glsl */ `
vec3 nightify(vec3 c) {
  float l = dot(c, vec3(0.30, 0.55, 0.15));
  return mix(c, vec3(l * 0.95, l * 0.06, l * 0.02), uNight);
}
`;

export const STAR_VERT = /* glsl */ `
${COMMON}
attribute float aMag;
attribute vec3 aColor;
uniform float uMagLimit;
uniform float uSizeBase;
uniform float uPixelRatio;
uniform float uBrightness;
varying vec3 vColor;
varying float vAlpha;
varying float vCore;
void main() {
  vec3 w = refractWorld(normalize(uEqToWorld * position));
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
  float rel = uMagLimit - aMag;               // >0 visible
  float alpha = clamp((rel + 0.6) / 1.2, 0.0, 1.0) * uBrightness;
  // bright stars get bigger discs + halos; faint ones stay pixel-sized
  float size = uSizeBase * pow(10.0, 0.4 * max(rel, -1.0) * 0.5);
  size = clamp(size, 1.6, 56.0);
  vCore = clamp(3.6 / size, 0.1, 1.0);
  gl_PointSize = size * uPixelRatio;
  vColor = aColor;
  vAlpha = alpha;
  if (alpha <= 0.002 || w.y < -0.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // cull
}
`;

export const STAR_FRAG = /* glsl */ `
uniform float uNight;
varying vec3 vColor;
varying float vAlpha;
varying float vCore;
${NIGHT_FRAG}
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  float core = exp(-d * d / (vCore * vCore) * 2.2);
  float halo = exp(-d * 2.6) * 0.85 * (1.0 - vCore);
  float spike = (exp(-abs(p.x) * 26.0) + exp(-abs(p.y) * 26.0)) * exp(-d * 3.0) * 0.12 * (1.0 - vCore);
  float i = core + halo + spike;
  vec3 c = mix(vColor, vec3(1.0), core * 0.55) * i;
  gl_FragColor = vec4(nightify(c) * vAlpha, 1.0);
}
`;

export const LINE_VERT = /* glsl */ `
${COMMON}
uniform float uRefract;
varying float vAlt;
void main() {
  vec3 w = normalize(uEqToWorld * position);
  if (uRefract > 0.5) w = refractWorld(w);
  vAlt = w.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 1.0);
}
`;

export const LINE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uNight;
varying float vAlt;
${NIGHT_FRAG}
void main() {
  gl_FragColor = vec4(nightify(uColor), uOpacity);
}
`;

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SKY_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform float uSunAlt;
uniform float uNight;
uniform float uMoonGlow;
uniform vec3 uMoonDir;
varying vec3 vDir;
${NIGHT_FRAG}
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  // day factor: 1 above +3 deg, 0 below -18 deg (astronomical night)
  float day = smoothstep(-18.0, 4.0, uSunAlt);
  float twi = smoothstep(-18.0, -4.0, uSunAlt) * (1.0 - smoothstep(-4.0, 8.0, uSunAlt));
  vec3 nightZen = vec3(0.008, 0.012, 0.028), nightHor = vec3(0.03, 0.04, 0.07);
  vec3 dayZen = vec3(0.16, 0.36, 0.72), dayHor = vec3(0.62, 0.76, 0.92);
  vec3 zen = mix(nightZen, dayZen, day * day);
  vec3 hor = mix(nightHor, dayHor, day * day);
  vec3 c = mix(hor, zen, pow(h, 0.45));
  // twilight glow toward the sun
  float toSun = max(dot(d, uSunDir), 0.0);
  c += vec3(0.85, 0.42, 0.18) * twi * pow(1.0 - h, 3.0) * (0.25 + 0.75 * pow(toSun, 3.0)) * 0.55;
  c += vec3(1.0, 0.95, 0.85) * day * pow(toSun, 64.0) * 0.6;
  // moonlight brightens the sky a bit
  c += vec3(0.05, 0.07, 0.11) * uMoonGlow * (0.3 + 0.7 * pow(max(dot(d, uMoonDir), 0.0), 8.0));
  gl_FragColor = vec4(nightify(c), 1.0);
}
`;

export const GROUND_FRAG = /* glsl */ `
uniform float uSunAlt;
uniform float uNight;
varying vec3 vDir;
${NIGHT_FRAG}
void main() {
  vec3 d = normalize(vDir);
  float day = smoothstep(-12.0, 6.0, uSunAlt);
  float depth = clamp(-d.y * 3.0, 0.0, 1.0);
  vec3 near = mix(vec3(0.035, 0.04, 0.035), vec3(0.20, 0.24, 0.17), day);
  vec3 far = mix(vec3(0.012, 0.014, 0.012), vec3(0.10, 0.12, 0.09), day);
  vec3 c = mix(near, far, depth);
  gl_FragColor = vec4(nightify(c), 1.0);
}
`;

export const ZONE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uNight;
varying vec3 vDir;
${NIGHT_FRAG}
void main() {
  // subtle diagonal hatching so the zone reads as "no-go" without hiding stars
  float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 14.0));
  gl_FragColor = vec4(nightify(uColor), uOpacity * (0.6 + 0.4 * hatch));
}
`;
