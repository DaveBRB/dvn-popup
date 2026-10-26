// Walkable Gaussian-splat pop-up store — Spark 2.4 + three.js + three-mesh-bvh
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { computeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------- settings
const CONFIG = {
  // Option A (start here): one compressed file; Spark builds the level-of-detail tree in the browser
  splatUrl: "./assets/scene.sog", paged: false,
  // Option B (faster start): pre-built streaming LoD from Spark's build-lod tool (guide §5.4)
  // splatUrl: "./assets/lod/scene-lod.rad", paged: true,
  colliderUrl: "./assets/collision.glb",
  skyUrl: "./assets/sky.jpg",
  eyeHeight: 1.65,   // metres above the feet
  radius: 0.3,       // body radius used against walls
  walkSpeed: 2.2,    // m/s
  runSpeed: 4.5,     // m/s with Shift
  stepUp: 0.4,       // tallest step you can walk up
  gravity: 9.81,
  lookSpeed: 0.0022, // radians per pixel
  doorRadius: 1.8,   // how close to DOOR_ZONE before the "enter" prompt shows
};
const DEBUG = new URLSearchParams(location.search).has("debug");
const isTouch = matchMedia("(pointer: coarse)").matches;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.25 : 1.5));
renderer.setSize(innerWidth, innerHeight);
$("app").appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 1000);
const spark = new SparkRenderer({ renderer });
scene.add(spark);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Sky: an equirectangular panorama. Blender world images line up with three.js as-is.
new THREE.TextureLoader().load(CONFIG.skyUrl, (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
});

// ---------------------------------------------------------------- the splat world
// Blender is Z-up, three.js is Y-up: rotate -90° around X.
// After this, Blender (x, y, z) appears at three.js (x, z, -y) — the same as the glTF exporter.
const world = new SplatMesh({
  url: CONFIG.splatUrl,
  // lod: builds a level-of-detail tree in a worker so phones draw fewer splats
  // paged: streams a pre-built .rad tree chunk by chunk, so walking starts almost at once
  ...(CONFIG.paged ? { paged: true } : { lod: true }),
  onProgress: (e) => {
    if (e.lengthComputable) $("progress").style.width = `${(100 * e.loaded) / e.total}%`;
  },
});
world.rotation.x = -Math.PI / 2;
scene.add(world);

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
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());

function look(dx, dy) {
  player.yaw -= dx * CONFIG.lookSpeed;
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy * CONFIG.lookSpeed, -1.35, 1.35);
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

// Touch: drag anywhere (except the joystick) to look
let lookId = null, lastX = 0, lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  lookId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
});
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerId !== lookId) return;
  look((e.clientX - lastX) * 1.6, (e.clientY - lastY) * 1.6);
  lastX = e.clientX; lastY = e.clientY;
});
const endLook = (e) => { if (e.pointerId === lookId) lookId = null; };
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
  } else {
    canvas.requestPointerLock()?.catch?.(() => {}); // refused, e.g. clicked too soon after Esc: just click again
  }
});
if (isTouch) {
  $("help-desktop").classList.add("hidden");
  $("help-touch").classList.remove("hidden");
  $("prompt").textContent = "Tap here to enter the store";
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
let ready = false, last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (ready) {
    const n = 4;
    for (let i = 0; i < n; i++) step(dt / n);
    updateDoor();
  }
  camera.position.set(player.pos.x, player.pos.y + CONFIG.eyeHeight, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0, "YXZ");
  if (DEBUG) {
    const p = player.pos; // also show Blender coordinates: (x, -z, y)
    $("hud").textContent = `three ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} | blender ${p.x.toFixed(2)} ${(-p.z).toFixed(2)} ${p.y.toFixed(2)} | mouse jumps ignored ${mouse.ignored}`;
  }
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- boot
(async () => {
  try {
    await Promise.all([world.initialized, loadColliders(CONFIG.colliderUrl)]);
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
window.popup = { player, markers, walls, floors, get doorBlocker() { return doorBlocker; }, CONFIG, world, camera, mouse };
