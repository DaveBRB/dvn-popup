// Walkable pop-up store — Blender scene as glTF meshes + three.js + three-mesh-bvh, with simulated basin water
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { computeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { createWater } from "./water.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------- settings
const CONFIG = {
  sceneUrl: "./assets/scene.glb",          // exported by make_web_scene.py, compressed with gltf-transform
  sceneInfoUrl: "./assets/scene-info.json", // sun, water and entrance light from the .blend
  leafGravelUrl: "./assets/textures/leaf_scattered_gravel.jpg",
  colliderUrl: "./assets/collision.glb",
  skyUrl: "./assets/sky.jpg",               // the world panorama: visible sky and ambient light
  exposure: 0.85,
  sunIntensity: 4.2,
  envIntensity: 0.9,
  eyeHeight: 1.65,   // metres above the feet
  radius: 0.3,       // body radius used against walls
  walkSpeed: 2.2,    // m/s
  runSpeed: 4.5,     // m/s with Shift
  stepUp: 0.4,       // tallest step you can walk up
  gravity: 9.81,
  lookSpeed: 0.0022, // radians per pixel
  doorRadius: 1.8,   // how close to DOOR_ZONE before the "enter" prompt shows
};
const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");
const isTouch = matchMedia("(pointer: coarse)").matches;
// Firefox's pointer lock reports bogus mouse movement on some setups, so there the view turns by
// dragging instead (?look=lock or ?look=drag overrides this).
const dragLook = !isTouch && (params.get("look") ?? (/firefox/i.test(navigator.userAgent) ? "drag" : "lock")) === "drag";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.25 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;   // the .blend renders with AgX
renderer.toneMappingExposure = CONFIG.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;         // the scene is static: shadows are drawn once after loading
$("app").appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 1000);
let water = null;

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  water?.resize();
});

// ---------------------------------------------------------------- the Blender scene
const progress = { scene: 0 };
const showProgress = () => ($("progress").style.width = `${100 * progress.scene}%`);

async function loadSky(url) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping; // Blender world images line up with three.js as-is
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
  scene.environment = tex;
  scene.environmentIntensity = CONFIG.envIntensity;
}

async function loadScene(info) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(CONFIG.sceneUrl, (e) => {
    if (e.lengthComputable) { progress.scene = e.loaded / e.total; showProgress(); }
  });
  $("status").textContent = "Setting the scene…";
  const leafGravel = new THREE.TextureLoader().load(CONFIG.leafGravelUrl);
  leafGravel.colorSpace = THREE.SRGBColorSpace;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const m = o.material;
    if (m.name.startsWith("Tuileries trees")) fixFoliage(o, m);
    else if (m.name.startsWith("Tuileries | pale compacted limestone gravel")) fixGravel(m, info.ground, leafGravel);
  });
  scene.add(gltf.scene);
}

// Leaves: alpha-tested cards, and each tree slightly differently coloured (Blender varies the hue per tree)
function fixFoliage(mesh, m) {
  Object.assign(m, { transparent: false, alphaTest: 0.2, alphaToCoverage: true, side: THREE.DoubleSide, depthWrite: true });
  // thin leaves let sunlight through (Blender gives them a little subsurface): a faint glow of their own colour
  m.emissiveMap = m.map;
  m.emissive.setRGB(0.35, 0.3, 0.2);
  m.color.multiplyScalar(1.15);
  if (!mesh.isInstancedMesh) return;
  const tints = [[1, 1, 1], [1.1, 0.9, 0.75], [0.95, 1.03, 0.82], [1.12, 0.82, 0.62], [1.04, 0.97, 0.88]];
  const c = new THREE.Color();
  for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, c.setRGB(...tints[(i * 7 + 3) % tints.length]));
  mesh.instanceColor.needsUpdate = true;
}

// Gravel: Blender brightens the gravel texture (a tint above 1, which glTF can't store) and blends in a
// leaf-strewn gravel texture through low-frequency noise. Both are re-created here.
function fixGravel(m, g, leafGravel) {
  m.color.setRGB(...g.tint_linear).multiply(new THREE.Color(1, 0.95, 0.86)); // a touch warmer, like AgX Medium High Contrast
  leafGravel.wrapS = leafGravel.wrapT = THREE.RepeatWrapping;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.leafMap = { value: leafGravel };
    shader.uniforms.noiseScale = { value: g.noise_scale };
    shader.uniforms.leafAmount = { value: g.noise_math.b };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vObjPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvObjPos = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform sampler2D leafMap; uniform float noiseScale, leafAmount; varying vec3 vObjPos;
        float vnoise(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float n = dot(i, vec3(1.0, 57.0, 113.0));
          #define R(o) fract(sin(n + o) * 43758.5453)
          return mix(mix(mix(R(0.0), R(1.0), f.x), mix(R(57.0), R(58.0), f.x), f.y),
                     mix(mix(R(113.0), R(114.0), f.x), mix(R(170.0), R(171.0), f.x), f.y), f.z);
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        vec3 q = vObjPos * noiseScale;
        float nz = (vnoise(q) * 0.57 + vnoise(q * 2.0) * 0.29 + vnoise(q * 4.0) * 0.14);
        diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(leafMap, vMapUv).rgb, clamp(nz * leafAmount, 0.0, 1.0));`);
  };
  m.needsUpdate = true;
}

function addLights(info) {
  const s = info.sun;
  const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(...s.color), CONFIG.sunIntensity);
  const dir = new THREE.Vector3(...s.direction).normalize();        // the way sunlight travels
  sun.target.position.set(0, 0, 4);
  sun.position.copy(sun.target.position).addScaledVector(dir, -80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 20, far: 160 });
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.025;
  scene.add(sun, sun.target);

  // the warm light inside the shop that glows through the windows and the open door
  const e = info.entrance_light;
  const glow = new THREE.PointLight(new THREE.Color().setRGB(...e.color), 25, 9, 2);
  glow.position.set(...e.position);
  scene.add(glow);
  return { sun, dir };
}

// ---------------------------------------------------------------- colliders + markers from Blender
const walls = [];   // meshes the body can't pass through
const floors = [];  // meshes you stand on
const markers = {}; // SPAWN, DOOR_ZONE, ...
let doorBlocker = null;
const debugMat = new THREE.MeshBasicMaterial({ color: 0xff3355, wireframe: true });

async function loadColliders(url) { // call again later for the interior's colliders
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (o.isMesh) {
      const geom = o.geometry.clone().applyMatrix4(o.matrixWorld); // bake to world space
      geom.computeBoundsTree();
      const mesh = new THREE.Mesh(geom, debugMat);
      mesh.name = o.name;
      if (DEBUG) scene.add(mesh);
      if (o.name.startsWith("COL_FLOOR")) floors.push(mesh);
      else walls.push(mesh);
      if (o.name.startsWith("COL_DOOR_BLOCKER")) doorBlocker = mesh;
    } else if (o.name) {
      markers[o.name] = o;
    }
  });
}

// ---------------------------------------------------------------- player
const player = { pos: new THREE.Vector3(), vy: 0, onGround: false, yaw: 0, pitch: 0 };

function respawn() {
  const s = markers.SPAWN;
  if (s) s.getWorldPosition(player.pos);
  else player.pos.set(0, 0, 24);
  player.yaw = THREE.MathUtils.degToRad(s?.userData?.yaw_deg ?? 0);
  player.pitch = -0.05;
  player.vy = 0;
}

// Body vs walls: a vertical capsule pushed out of every triangle it overlaps (horizontally only).
const seg = new THREE.Line3(), box = new THREE.Box3();
const triPt = new THREE.Vector3(), capPt = new THREE.Vector3(), push = new THREE.Vector3();
function collideWalls() {
  const r = CONFIG.radius;
  seg.start.set(player.pos.x, player.pos.y + CONFIG.stepUp + r, player.pos.z); // keep the capsule above steps
  seg.end.set(player.pos.x, player.pos.y + CONFIG.eyeHeight, player.pos.z);
  for (const wall of walls) {
    if (wall.userData.enabled === false) continue; // e.g. the door blocker once the interior is open
    box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end);
    box.min.addScalar(-r);
    box.max.addScalar(r);
    wall.geometry.boundsTree.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => {
        const d = tri.closestPointToSegment(seg, triPt, capPt);
        if (d >= r) return;
        push.subVectors(capPt, triPt).setY(0);
        if (push.lengthSq() < 1e-12) return;
        push.normalize().multiplyScalar(r - d);
        seg.start.add(push);
        seg.end.add(push);
      },
    });
  }
  player.pos.x = seg.start.x;
  player.pos.z = seg.start.z;
}

// Feet vs floors: ray straight down from just above the knee.
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);
function groundBelow() {
  ray.set(new THREE.Vector3(player.pos.x, player.pos.y + CONFIG.stepUp, player.pos.z), DOWN);
  ray.far = 100;
  const hit = ray.intersectObjects(floors, false)[0];
  return hit ? hit.point.y : null;
}

// ---------------------------------------------------------------- input
const keys = new Set();
const stick = { x: 0, y: 0 };
addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "KeyE" && nearDoor) enterStore();
  if (e.code === "Escape" && dragLook) $("start").classList.remove("hidden");
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());

function look(dx, dy) {
  player.yaw -= dx * CONFIG.lookSpeed;
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy * CONFIG.lookSpeed, -1.35, 1.35);
}

// A click or tap on the water makes ripples where it lands.
const pickRay = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pokeWater(clientX, clientY) {
  if (!water) return;
  pickRay.setFromCamera(ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1), camera);
  const p = water.pick(pickRay.ray);
  if (p) water.disturb(p, 1.0, 0.14);
}

// Desktop: pointer lock. Firefox on Windows can report bogus jumps while the pointer is locked (from
// re-centring the cursor), often a big step followed by an equal step back. A hand moves smoothly, so
// a step much bigger than the recent ones is held back for one event: if the next event carries on in
// the same direction it was a fast flick and both count; otherwise the held step is ignored.
const canvas = renderer.domElement;
const mouse = { avg: 0, last: 0, held: null, ignored: 0, lockedAt: 0 };
function mouseStep(dx, dy) {
  const now = performance.now(), m = Math.hypot(dx, dy);
  mouse.avg *= Math.exp(-(now - mouse.last) / 150); // recent step size fades when the mouse rests
  mouse.last = now;
  if (mouse.held) {
    const h = mouse.held;
    mouse.held = null;
    if (now - h.t < 100 && dx * h.dx + dy * h.dy > 0 && m > 0.3 * h.m) {
      look(h.dx, h.dy);
      mouse.avg = h.m;
    } else {
      mouse.ignored++;
    }
  }
  if (m > Math.max(60, 4 * mouse.avg)) {
    mouse.held = { dx, dy, m, t: now };
    return;
  }
  mouse.avg += (m - mouse.avg) * 0.2;
  look(dx, dy);
}
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  if (performance.now() - mouse.lockedAt < 100) return; // first moves after locking can be bogus too
  mouseStep(e.movementX, e.movementY);
});
document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) Object.assign(mouse, { avg: 0, held: null, lockedAt: performance.now() });
  $("start").classList.toggle("hidden", locked || !ready);
});
canvas.addEventListener("mousedown", (e) => {
  if (e.button === 0 && document.pointerLockElement === canvas) pokeWater(innerWidth / 2, innerHeight / 2);
});

// Desktop without pointer lock (Firefox): hold the left button and drag to look; a click without a drag pokes the water
const drag = { id: null, x: 0, y: 0, moved: 0 };
canvas.addEventListener("pointerdown", (e) => {
  if (!dragLook || e.pointerType !== "mouse" || e.button !== 0) return;
  Object.assign(drag, { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 });
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
});
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  look(dx, dy);
  drag.x = e.clientX; drag.y = e.clientY;
});
const endDrag = (e) => {
  if (e.pointerId !== drag.id) return;
  if (e.type === "pointerup" && drag.moved < 5) pokeWater(e.clientX, e.clientY);
  drag.id = null;
  canvas.style.cursor = "grab";
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// Touch: drag anywhere (except the joystick) to look; a tap pokes the water
let lookId = null, lastX = 0, lastY = 0, tapMoved = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  lookId = e.pointerId; lastX = e.clientX; lastY = e.clientY; tapMoved = 0;
});
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerId !== lookId) return;
  look((e.clientX - lastX) * 1.6, (e.clientY - lastY) * 1.6);
  tapMoved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
  lastX = e.clientX; lastY = e.clientY;
});
const endLook = (e) => {
  if (e.pointerId !== lookId) return;
  if (e.type === "pointerup" && tapMoved < 8) pokeWater(e.clientX, e.clientY);
  lookId = null;
};
canvas.addEventListener("pointerup", endLook);
canvas.addEventListener("pointercancel", endLook);

// Touch: virtual joystick
const stickEl = $("stick"), knob = stickEl.querySelector("i");
stickEl.addEventListener("pointerdown", (e) => stickEl.setPointerCapture(e.pointerId));
stickEl.addEventListener("pointermove", (e) => {
  if (!stickEl.hasPointerCapture(e.pointerId)) return;
  const r = stickEl.getBoundingClientRect(), max = r.width / 2;
  let x = e.clientX - (r.left + max), y = e.clientY - (r.top + max);
  const len = Math.hypot(x, y);
  if (len > max) { x *= max / len; y *= max / len; }
  knob.style.transform = `translate(${x}px, ${y}px)`;
  stick.x = x / max; stick.y = -y / max;
});
const resetStick = () => { stick.x = stick.y = 0; knob.style.transform = ""; };
stickEl.addEventListener("pointerup", resetStick);
stickEl.addEventListener("pointercancel", resetStick);

$("prompt").addEventListener("click", () => nearDoor && enterStore());
$("enter").addEventListener("click", () => {
  if (isTouch) {
    $("start").classList.add("hidden");
    stickEl.classList.remove("hidden");
  } else if (dragLook) {
    $("start").classList.add("hidden");
    canvas.style.cursor = "grab";
  } else {
    canvas.requestPointerLock()?.catch?.(() => {}); // refused, e.g. clicked too soon after Esc: just click again
  }
});
if (isTouch) {
  $("help-desktop").classList.add("hidden");
  $("help-touch").classList.remove("hidden");
  $("prompt").textContent = "Tap here to enter the store";
} else if (dragLook) {
  $("help-desktop").textContent = "W A S D or arrows to walk · drag to look · Shift to run · click the water · Esc to pause";
}

// ---------------------------------------------------------------- the store door
let nearDoor = false;
function updateDoor() {
  const d = markers.DOOR_ZONE;
  if (!d) return;
  const p = d.getWorldPosition(new THREE.Vector3());
  nearDoor = Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < CONFIG.doorRadius;
  $("prompt").classList.toggle("hidden", !nearDoor);
}
function enterStore() {
  // Phase 2 (see guide §8): load the interior, then open the doorway:
  //   if (doorBlocker) doorBlocker.userData.enabled = false;
  $("prompt").textContent = "The boutique opens soon";
}

// ---------------------------------------------------------------- movement
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
function step(dt) {
  const k = (a, b) => (keys.has(a) || keys.has(b) ? 1 : 0);
  const f = k("KeyW", "ArrowUp") - k("KeyS", "ArrowDown") + stick.y;
  const s = k("KeyD", "ArrowRight") - k("KeyA", "ArrowLeft") + stick.x;
  const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? CONFIG.runSpeed : CONFIG.walkSpeed;

  fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  move.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
  if (move.lengthSq() > 1) move.normalize();
  player.pos.addScaledVector(move, speed * dt);

  collideWalls();

  const g = groundBelow();
  const snap = player.onGround ? CONFIG.stepUp : 0.02;
  if (g !== null && player.vy <= 0 && player.pos.y - g <= snap) {
    player.pos.y = g; player.vy = 0; player.onGround = true;
  } else {
    player.vy -= CONFIG.gravity * dt;
    player.pos.y += player.vy * dt;
    player.onGround = false;
    if (g !== null && player.pos.y < g) { player.pos.y = g; player.vy = 0; player.onGround = true; }
  }
  if (player.pos.y < -20) respawn();
}

// ---------------------------------------------------------------- main loop
let ready = false, last = performance.now(), fps = 0;
const view = { free: false }; // tests can place the camera themselves
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  fps += ((dt > 0 ? 1 / dt : 0) - fps) * 0.05;
  if (ready) {
    const n = 4;
    for (let i = 0; i < n; i++) step(dt / n);
    updateDoor();
    water?.update(dt);
  }
  if (!view.free) {
    camera.position.set(player.pos.x, player.pos.y + CONFIG.eyeHeight, player.pos.z);
    camera.rotation.set(player.pitch, player.yaw, 0, "YXZ");
  }
  if (DEBUG) {
    const p = player.pos; // also show Blender coordinates: (x, -z, y)
    $("hud").textContent = `three ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} | blender ${p.x.toFixed(2)} ${(-p.z).toFixed(2)} ${p.y.toFixed(2)} | ${fps.toFixed(0)} fps | ${dragLook ? "drag look" : `mouse jumps ignored ${mouse.ignored}`}`;
  }
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- boot
let lights = null;
(async () => {
  try {
    const info = await (await fetch(CONFIG.sceneInfoUrl)).json();
    await Promise.all([loadScene(info), loadSky(CONFIG.skyUrl), loadColliders(CONFIG.colliderUrl)]);
    lights = addLights(info);
    const w = info.water;
    water = createWater({
      renderer, center: new THREE.Vector3(...w.center), radius: w.radius, level: w.level,
      sunDirection: lights.dir.clone().negate(), sunColor: lights.sun.color,
    });
    scene.add(water.mesh);
    renderer.shadowMap.needsUpdate = true;
    await renderer.compileAsync(scene, camera); // build the shaders before the first frame, not during it
    respawn();
    ready = true;
    $("loader").classList.add("hidden");
    $("start").classList.remove("hidden");
    if (DEBUG) $("hud").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    $("status").textContent = "Could not load the scene. Check the browser console.";
  }
})();

// handy for testing in the console
window.popup = { player, markers, walls, floors, get doorBlocker() { return doorBlocker; }, CONFIG, camera, mouse, scene, renderer, view, get water() { return water; }, get lights() { return lights; }, dragLook };
