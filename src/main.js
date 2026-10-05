import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import GUI from 'lil-gui';

const settings = {
  rotationSpeed: 0.25, // radians/sec, only used while autoRotate is on
  autoRotate: false,
  orbitControls: true,
  sunIntensity: 60,
  bloomStrength: 0.22,
  bloomRadius: 0.25,
  bloomThreshold: 1.6,
  carColor: '#f2f2f2',
  godrayIntensity: 1,
  cameraMode: false,
};

const app = document.getElementById('app');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(3.4, 1.05, 4.9);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

// Studio-style reflection source for the CAR ONLY (applied per-material below, never
// as scene.environment) — otherwise it floods the whole garage with ambient light and
// the room stops looking like a dark space lit only by the sun coming through the door.
const pmrem = new THREE.PMREMGenerator(renderer);
const carEnvMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// "Sun" shining in through the garage's door. A plain DirectionalLight has no
// falloff or cone — it lights every unoccluded surface in that direction at full
// strength, which is why a distant side wall was reading just as bright as the car
// (nothing physically blocked it). A SpotLight gives it an actual confined cone, so
// only the area the door would realistically illuminate gets lit; everything outside
// the cone stays dark regardless of line-of-sight.
const sunLight = new THREE.SpotLight(0xfff2e0, settings.sunIntensity, 40, Math.PI / 11, 0.55, 1.1);
sunLight.position.set(4, 9, 16);
sunLight.target.position.set(0.3, 0, -0.8);
scene.add(sunLight.target);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 30;
sunLight.shadow.bias = -0.0003;
sunLight.shadow.normalBias = 0.02;
sunLight.shadow.radius = 2.5;
scene.add(sunLight);

// Soft cool/warm bounce fill. A HemisphereLight only feeds indirect diffuse
// (no specular lobe), so it can't paint a hard colored streak across shiny floors
// the way a second directional light does. Kept deliberately dim — the garage should
// read as a dark space lit only by the sun trickling through the door, not a lit room.
const fillLight = new THREE.HemisphereLight(0x8fa8ff, 0x100e0a, 0.04);
scene.add(fillLight);

// Cheap fake volumetric light shafts ("god rays") along the sun's direction, as if
// dusty light is pouring through the garage door. Not real volumetrics — just soft
// additive cones with a gradient texture — but combined with bloom it reads well
// and costs almost nothing to render.
function createBeamTexture() {
  // Soft radial blob, fully transparent at every edge — this (not the geometry
  // outline) is what defines the beam's visible silhouette, so it never shows a
  // hard cone/plane edge no matter the viewing angle.
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Gradual, low-peak falloff across the whole radius (not just the rim) — with
  // additive blending + ACES tonemapping, a sharp/high-peak gradient compresses
  // into a flat bright disc with only the very edge fading, which reads as a
  // solid shape instead of haze. A gentle curve stays in the tonemapper's smooth
  // range so the softness actually survives to the screen.
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.45)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.3)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// A tapered quad (narrow at the top/source, wide at the bottom/spread) rather than
// a plain rectangle, so the beam actually widens as it travels from the door.
function createBeamGeometry(topWidth, bottomWidth, height) {
  const positions = new Float32Array([
    -topWidth / 2, 0, 0,
    topWidth / 2, 0, 0,
    bottomWidth / 2, -height, 0,
    -bottomWidth / 2, -height, 0,
  ]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

const beamTexture = createBeamTexture();
const sunDir = new THREE.Vector3()
  .subVectors(sunLight.target.position, sunLight.position)
  .normalize();
const beamQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sunDir);

const godrayBeams = [];
function addBeam(position, height, bottomWidth, baseOpacity, yaw) {
  const geometry = createBeamGeometry(0.15, bottomWidth, height);
  const material = new THREE.MeshBasicMaterial({
    map: beamTexture,
    color: 0xfff1d0,
    transparent: true,
    opacity: baseOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const group = new THREE.Group();
  const planeA = new THREE.Mesh(geometry, material);
  const planeB = new THREE.Mesh(geometry, material);
  planeB.rotateY(Math.PI / 2); // cross the two planes so the beam reads from more angles
  group.add(planeA, planeB);
  group.position.copy(position);
  group.quaternion.copy(beamQuat);
  group.rotateY(yaw);
  group.userData.baseOpacity = baseOpacity;
  group.userData.material = material;
  scene.add(group);
  godrayBeams.push(group);
}

addBeam(new THREE.Vector3(1.0, 3.3, 6.8), 9, 3.2, 0.14, 0.0);
addBeam(new THREE.Vector3(-0.9, 3.7, 7.3), 8, 2.6, 0.11, -0.12);
addBeam(new THREE.Vector3(2.5, 2.9, 6.3), 7.5, 2.2, 0.09, 0.18);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.55, -0.6);
controls.enableDamping = true;
// Keep the camera inside the garage: far/polar limits stop it from zooming or
// orbiting through the walls, ceiling, or floor while framing broll angles.
controls.minDistance = 2.2;
controls.maxDistance = 8.5;
controls.minPolarAngle = 0.12 * Math.PI;
controls.maxPolarAngle = 0.49 * Math.PI;
controls.enablePan = false;
controls.enabled = settings.orbitControls;
controls.update();

// ---------------------------------------------------------------------------
// Camera mode — an automated b-roll reel: a cut sequence of distinct, smoothly
// moving shots (not one continuous path drifting between angles, which is not
// how real automotive b-roll is cut). Each shot is its own self-contained move
// — a push-in, a low lateral pass, an orbiting reveal, a detail dolly — eased
// in/out, then we CUT to the next shot's start, same as an edited reel.
// Positions/look-ats are tuned for this scene: car centered near (0, *, -0.6),
// nose toward +Z (the door/sun side), tail toward -Z (the marble wall side).
// ---------------------------------------------------------------------------
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function pointOnPath(points, t) {
  if (points.length === 2) return points[0].clone().lerp(points[1], t);
  return new THREE.CatmullRomCurve3(points).getPointAt(t);
}

const BROLL_SHOTS = [
  {
    // Hero low 3/4 push-in — the classic front-corner reveal, slowly closing in.
    name: 'hero-push-in',
    duration: 6,
    path: [new THREE.Vector3(5.0, 0.95, 6.2), new THREE.Vector3(3.1, 0.75, 4.25)],
    lookAt: [new THREE.Vector3(0, 0.55, -0.2), new THREE.Vector3(0, 0.5, -0.35)],
    fov: [30, 24],
  },
  {
    // Low lateral pass down the side — the "power" shot, camera near the ground.
    name: 'low-side-pass',
    duration: 7,
    path: [new THREE.Vector3(2.6, 0.32, 2.1), new THREE.Vector3(-2.7, 0.32, 0.6)],
    lookAt: [new THREE.Vector3(0.6, 0.35, 0.2), new THREE.Vector3(-0.6, 0.4, -1.0)],
    fov: [32, 32],
  },
  {
    // Curved orbit around the back — a true arc (3 waypoints), not a straight line,
    // sweeping from the rear-3/4 to show the wing and diffuser.
    name: 'rear-orbit',
    duration: 8,
    path: [
      new THREE.Vector3(-3.0, 1.3, 1.1),
      new THREE.Vector3(-3.9, 1.45, -1.4),
      new THREE.Vector3(-2.0, 1.55, -3.3),
    ],
    lookAt: [new THREE.Vector3(0, 0.65, -0.8), new THREE.Vector3(0, 0.6, -0.9)],
    fov: [27, 25],
  },
  {
    // Tight detail dolly on the front wheel/caliper.
    name: 'wheel-detail',
    duration: 5,
    path: [new THREE.Vector3(1.75, 0.55, 1.15), new THREE.Vector3(1.15, 0.48, 0.55)],
    lookAt: [new THREE.Vector3(1.05, 0.35, 0.3), new THREE.Vector3(1.0, 0.33, 0.25)],
    fov: [18, 15],
  },
  {
    // Push toward the cockpit — shows off the (now actually transparent) glass,
    // without closing in so far it reads as "inside the car" rather than approaching it.
    name: 'cockpit-push',
    duration: 6,
    path: [new THREE.Vector3(1.3, 1.3, 2.9), new THREE.Vector3(0.8, 1.1, 1.9)],
    lookAt: [new THREE.Vector3(0.2, 0.95, 0.1), new THREE.Vector3(0.1, 0.85, -0.15)],
    fov: [25, 21],
  },
  {
    // Descending crane move that ends back near the hero angle, so the loop cuts cleanly.
    name: 'crane-down',
    duration: 7,
    path: [
      new THREE.Vector3(0.6, 3.5, 5.3),
      new THREE.Vector3(2.6, 2.1, 6.0),
      new THREE.Vector3(4.3, 1.25, 5.6),
    ],
    lookAt: [new THREE.Vector3(0, 0.6, -0.4), new THREE.Vector3(0, 0.55, -0.3)],
    fov: [32, 29],
  },
];

let cameraModeShotIndex = 0;
let cameraModeShotStart = 0;
let prevOrbitEnabled = true;
let prevAutoRotate = false;

function updateCameraMode(now) {
  const shot = BROLL_SHOTS[cameraModeShotIndex];
  const elapsed = (now - cameraModeShotStart) / 1000;
  const t = Math.min(elapsed / shot.duration, 1);
  const eased = easeInOutCubic(t);

  camera.position.copy(pointOnPath(shot.path, eased));
  const lookAt = shot.lookAt[0].clone().lerp(shot.lookAt[1], eased);
  camera.lookAt(lookAt);
  camera.fov = THREE.MathUtils.lerp(shot.fov[0], shot.fov[1], eased);
  camera.updateProjectionMatrix();

  if (t >= 1) {
    cameraModeShotIndex = (cameraModeShotIndex + 1) % BROLL_SHOTS.length;
    cameraModeShotStart = now;
  }
}

function setCameraMode(enabled) {
  settings.cameraMode = enabled;
  if (enabled) {
    prevOrbitEnabled = settings.orbitControls;
    prevAutoRotate = settings.autoRotate;
    controls.enabled = false;
    settings.autoRotate = false;
    cameraModeShotIndex = 0;
    cameraModeShotStart = performance.now();
  } else {
    controls.enabled = prevOrbitEnabled;
    settings.autoRotate = prevAutoRotate;
    camera.position.set(3.4, 1.05, 4.9);
    camera.fov = 28;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0.55, -0.6);
    controls.update();
  }
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  settings.bloomStrength,
  settings.bloomRadius,
  settings.bloomThreshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

let carRoot = null;
let garageRoot = null;
let bodyPaintMaterial = null;

// Real-world Jesko length, in meters, used to normalize whatever units the source GLB used.
const CAR_LENGTH_M = 4.69;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);
loader.setMeshoptDecoder(MeshoptDecoder);

loader.load(
  '/models/garage.glb',
  (gltf) => {
    garageRoot = gltf.scene;
    garageRoot.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = true;
      }
    });
    scene.add(garageRoot);
  },
  undefined,
  (err) => console.error('Failed to load garage.glb', err)
);

loader.load(
  '/models/jesko.glb',
  (gltf) => {
    carRoot = gltf.scene;

    // Center the model and sit it on the ground plane.
    const box = new THREE.Box3().setFromObject(carRoot);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    carRoot.position.x -= center.x;
    carRoot.position.z -= center.z;
    carRoot.position.y -= box.min.y;

    // Normalize scale to the Jesko's real-world length regardless of the source GLB's units.
    const longestSide = Math.max(size.x, size.y, size.z);
    const scale = CAR_LENGTH_M / longestSide;
    carRoot.scale.setScalar(scale);
    carRoot.position.multiplyScalar(scale);
    carRoot.position.y = 0;

    carRoot.traverse((obj) => {
      if (obj.isMesh) {
        obj.receiveShadow = false;

        // The source model's glass is a flat alpha-blended white (no real
        // refraction), which reads as hazy/foggy. Swap it for a true
        // transmissive material so it actually looks like glass.
        if (obj.material && /^GlassMtl$/i.test(obj.material.name)) {
          const old = obj.material;
          obj.material = new THREE.MeshPhysicalMaterial({
            color: 0xeef4f8,
            metalness: 0,
            roughness: 0.05,
            transmission: 1,
            thickness: 0.05,
            ior: 1.52,
            clearcoat: 1,
            clearcoatRoughness: 0.03,
            envMapIntensity: 1.1,
            side: THREE.DoubleSide,
          });
          old.dispose();
          obj.castShadow = false;
        } else {
          obj.castShadow = true;
        }

        // Give the car (and only the car) something to reflect — the garage
        // itself stays unlit except by direct light, see fillLight/ambient above.
        if (obj.material && 'envMap' in obj.material) {
          obj.material.envMap = carEnvMap;
          obj.material.envMapIntensity = obj.material.envMapIntensity || 0.9;
          obj.material.needsUpdate = true;
        }

        // Main body paint — exposed via the GUI (and later the WE "carcolor" property).
        if (obj.material && obj.material.name === 'body1') {
          bodyPaintMaterial = obj.material;
          bodyPaintMaterial.color.set(settings.carColor);
        }
      }
    });

    scene.add(carRoot);
  },
  undefined,
  (err) => console.error('Failed to load jesko.glb', err)
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

const gui = new GUI();
gui.add(settings, 'cameraMode').name('Camera mode (b-roll)').onChange((v) => {
  setCameraMode(v);
});
gui.add(settings, 'autoRotate').name('Auto-rotate');
gui.add(settings, 'rotationSpeed', 0, 1.5, 0.01).name('Rotation speed');
gui.add(settings, 'orbitControls').name('Orbit controls').onChange((v) => {
  controls.enabled = settings.cameraMode ? false : v;
});
gui.add(settings, 'sunIntensity', 0, 200, 1).name('Sun intensity').onChange((v) => {
  sunLight.intensity = v;
});
gui.addColor(settings, 'carColor').name('Paint color').onChange((v) => {
  if (bodyPaintMaterial) bodyPaintMaterial.color.set(v);
});
gui.add(settings, 'godrayIntensity', 0, 2, 0.05).name('God rays').onChange((v) => {
  godrayBeams.forEach((beam) => {
    beam.userData.material.opacity = beam.userData.baseOpacity * v;
  });
});
const bloomFolder = gui.addFolder('Bloom');
bloomFolder.add(settings, 'bloomStrength', 0, 1.5, 0.01).onChange((v) => {
  bloomPass.strength = v;
});
bloomFolder.add(settings, 'bloomRadius', 0, 1, 0.01).onChange((v) => {
  bloomPass.radius = v;
});
bloomFolder.add(settings, 'bloomThreshold', 0, 4, 0.02).onChange((v) => {
  bloomPass.threshold = v;
});

let running = true;
let lastTime = performance.now();

function animate(now) {
  if (!running) return;
  requestAnimationFrame(animate);

  const dt = (now - lastTime) / 1000;
  lastTime = now;

  if (carRoot && settings.autoRotate) {
    carRoot.rotation.y += settings.rotationSpeed * dt;
  }

  if (settings.cameraMode) {
    updateCameraMode(now);
  } else {
    controls.update();
  }
  composer.render();
}
requestAnimationFrame(animate);

// Wallpaper Engine hook (no-op outside the WE runtime). Stub for now — properties
// get wired up once the scene itself is dialed in.
window.wallpaperPropertyListener = {
  applyUserProperties() {},
  applyGeneralProperties() {},
  setPaused(isPaused) {
    running = !isPaused;
    if (running) {
      lastTime = performance.now();
      requestAnimationFrame(animate);
    }
  },
};
