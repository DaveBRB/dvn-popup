// Fountain basin water: a wave-equation height field simulated on the GPU, drawn with a live mirror
// reflection of the scene. Ripples spread, bounce off the round rim and fade; anything can call disturb().
import * as THREE from "three";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";
import { Reflector } from "three/addons/objects/Reflector.js";

const SIM_SIZE = 512;    // cells across the basin's diameter (about 2.6 cm each)
const SIM_RATE = 30;     // simulation steps per second (sets how fast ripples travel: ~0.55 m/s)
const MAX_DROPS = 8;     // disturbances applied per step

// One step of the classic two-buffer wave scheme: x = height now, y = height one step ago.
const simShader = /* glsl */ `
  uniform vec4 drops[${MAX_DROPS}];   // xy: centre (sim uv), z: radius (sim uv), w: strength
  uniform int dropCount;
  uniform float damping;
  void main() {
    vec2 cell = 1.0 / resolution.xy;
    vec2 uv = gl_FragCoord.xy * cell;
    vec4 c = texture2D(heightmap, uv);
    float sum = texture2D(heightmap, uv + vec2(cell.x, 0.0)).x + texture2D(heightmap, uv - vec2(cell.x, 0.0)).x
              + texture2D(heightmap, uv + vec2(0.0, cell.y)).x + texture2D(heightmap, uv - vec2(0.0, cell.y)).x;
    float h = (sum * 0.5 - c.y) * damping;
    for (int i = 0; i < ${MAX_DROPS}; i++) {
      if (i >= dropCount) break;
      float r = length(uv - drops[i].xy) / drops[i].z;
      if (r < 1.0) h += drops[i].w * (0.5 + 0.5 * cos(r * 3.14159265));
    }
    if (length(uv - 0.5) > 0.5) h = 0.0;   // the basin wall: waves reflect off the rim
    gl_FragColor = vec4(h, c.x, 0.0, 1.0);
  }`;

const waterShader = {
  name: "BasinWater",
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    heightmap: { value: null },
    texel: { value: 1 / SIM_SIZE },
    slope: { value: 0.3 },            // height-field units -> surface slope
    radius: { value: 1 },
    time: { value: 0 },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },   // towards the sun
    sunColor: { value: new THREE.Color(1, 1, 1) },
    deepColor: { value: new THREE.Color(0.006, 0.016, 0.008) },
    waterTint: { value: new THREE.Color(0.78, 0.86, 0.74) },  // olive-green cast on what the water reflects
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    uniform float radius;
    varying vec4 vUv;
    varying vec2 vSimUv;
    varying vec3 vWorldPos;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vSimUv = position.xy / (2.0 * radius) + 0.5;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, heightmap;
    uniform float texel, slope, time;
    uniform vec3 sunDir, sunColor, deepColor, waterTint;
    varying vec4 vUv;
    varying vec2 vSimUv;
    varying vec3 vWorldPos;
    #include <logdepthbuf_pars_fragment>
    float H(vec2 uv) { return texture2D(heightmap, uv).x; }
    void main() {
      #include <logdepthbuf_fragment>
      // simulated ripples (sim v runs along world -z) plus a faint breeze on the surface
      float dx = (H(vSimUv + vec2(texel, 0.0)) - H(vSimUv - vec2(texel, 0.0))) * slope;
      float dz = -(H(vSimUv + vec2(0.0, texel)) - H(vSimUv - vec2(0.0, texel))) * slope;
      vec2 p = vWorldPos.xz;
      dx += 0.0012 * sin(p.x * 3.1 + p.y * 1.7 + time * 1.3) + 0.0008 * sin(p.x * 5.3 - p.y * 4.1 - time * 1.9);
      dz += 0.0012 * sin(p.y * 2.9 - p.x * 1.3 + time * 1.1) + 0.0008 * sin(p.y * 6.1 + p.x * 3.7 + time * 2.3);
      vec3 n = normalize(vec3(-dx, 1.0, -dz));
      vec3 V = normalize(cameraPosition - vWorldPos);
      float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      vec4 uv = vUv;
      uv.xy += n.xz * 0.25 * uv.w;          // ripples bend the reflection
      vec3 refl = texture2DProj(tDiffuse, uv).rgb * waterTint;
      vec3 h = normalize(sunDir + V);
      vec3 glint = sunColor * pow(max(dot(n, h), 0.0), 900.0) * 40.0;
      vec3 col = mix(deepColor, refl, fresnel) + glint;
      gl_FragColor = vec4(col, mix(0.9, 1.0, fresnel));   // shallow: the basin bed shows a little
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

export function createWater({ renderer, center, radius, level, sunDirection, sunColor, pixelScale = 0.5 }) {
  // ---- simulation
  const gpu = new GPUComputationRenderer(SIM_SIZE, SIM_SIZE, renderer);
  gpu.setDataType(THREE.HalfFloatType);
  const heightVar = gpu.addVariable("heightmap", simShader, gpu.createTexture());
  gpu.setVariableDependencies(heightVar, [heightVar]);
  const simU = heightVar.material.uniforms;
  simU.drops = { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) };
  simU.dropCount = { value: 0 };
  simU.damping = { value: 0.993 };
  const err = gpu.init();
  if (err) throw new Error(err);

  // ---- surface: a disc at the water level that mirrors the scene
  const size = () => new THREE.Vector2(innerWidth, innerHeight).multiplyScalar(renderer.getPixelRatio() * pixelScale).floor();
  const s = size();
  const mesh = new Reflector(new THREE.CircleGeometry(radius, 96), {
    shader: waterShader, textureWidth: s.x, textureHeight: s.y, clipBias: 0.003, multisample: 0,
  });
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(center.x, level, center.z);
  mesh.material.transparent = true;
  mesh.name = "Basin water";
  const u = mesh.material.uniforms;
  u.radius.value = radius;
  u.sunDir.value.copy(sunDirection).normalize();
  u.sunColor.value.copy(sunColor);

  const pending = [];
  let acc = 0, time = 0;

  // world point -> ripple; strength ~1 is a pebble, 0.1 a falling leaf
  function disturb(point, strength = 1, dropRadius = 0.12) {
    const lx = point.x - center.x, ly = -(point.z - center.z);
    if (Math.hypot(lx, ly) > radius - dropRadius) return false;
    pending.push(new THREE.Vector4(lx / (2 * radius) + 0.5, ly / (2 * radius) + 0.5, dropRadius / (2 * radius), -strength));
    return true;
  }

  // a ray from the camera (e.g. a click) -> the point where it meets the water, or null
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -level), hit = new THREE.Vector3();
  function pick(ray) {
    if (!ray.intersectPlane(plane, hit)) return null;
    return Math.hypot(hit.x - center.x, hit.z - center.z) < radius ? hit.clone() : null;
  }

  // the breeze and the odd falling leaf keep the surface alive
  let nextLeaf = 1;
  function ambient(dt) {
    nextLeaf -= dt;
    if (nextLeaf > 0) return;
    nextLeaf = 0.6 + Math.random() * 2.5;
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * (radius - 0.3);
    disturb(new THREE.Vector3(center.x + Math.cos(a) * r, level, center.z + Math.sin(a) * r), 0.08 + Math.random() * 0.12, 0.05);
  }

  function update(dt) {
    time += dt;
    ambient(dt);
    acc = Math.min(acc + dt, 4 / SIM_RATE);
    while (acc >= 1 / SIM_RATE) {
      acc -= 1 / SIM_RATE;
      const n = Math.min(pending.length, MAX_DROPS);
      for (let i = 0; i < n; i++) simU.drops.value[i].copy(pending.shift());
      simU.dropCount.value = n;
      gpu.compute();
    }
    u.heightmap.value = gpu.getCurrentRenderTarget(heightVar).texture;
    u.time.value = time;
  }

  function resize() {
    const s2 = size();
    mesh.getRenderTarget().setSize(s2.x, s2.y);
  }

  return {
    mesh, update, disturb, pick, resize,
    get pending() { return pending.length; },
    get heightTarget() { return gpu.getCurrentRenderTarget(heightVar); }, // for debugging
  };
}
