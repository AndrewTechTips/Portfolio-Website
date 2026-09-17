import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const canvas = document.querySelector('#webgl');
let scene, camera, renderer;
let gltfModel;     // the statue
let modelPivot;    // pivot group for perfect center-rotation
let mixer;
let rafId = 0;
let renderLoopActive = true;   // paused by the hero-visibility IntersectionObserver

// OS-level "reduce motion" preference, read once at load. When set: scrolls are instant
// instead of smooth, the magnetic/tilt pointer effects are inert, and the scroll-jacked
// cinematic intro is skipped (setupFastPath lands the reader at the grid).
// Nothing here is destructive — the hero scene stays mounted and works if scrolled back to.
const prefersReducedMotion =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// `let`, not `const` — the command palette's "Toggle Motion" action (setMotionOverride, near
// the bottom of this file) reassigns this at runtime. Every existing read of it below is just
// a variable lookup inside a function body, not a value captured at declaration time, so it
// picks up that reassignment automatically with no other code here needing to change.
let reducedMotion = prefersReducedMotion;

// A visitor's explicit "Turn motion off"/"Turn motion on" choice, separate from the OS-level
// prefersReducedMotion above and persisted across visits. Kept as its own flag rather than
// folded into prefersReducedMotion because the two are allowed to disagree — see the
// html.motion-off comment in style.css and setMotionOverride() below for why the OS default
// and this explicit, page-local override are handled differently for the hero's render loop.
const MOTION_OVERRIDE_KEY = 'motion-override';
let motionOverrideActive = false;
try {
    if (localStorage.getItem(MOTION_OVERRIDE_KEY) === 'reduced') motionOverrideActive = true;
} catch {
    // Storage blocked (private browsing, disabled site data) — just fall back to the OS
    // preference; nothing else here depends on this succeeding.
}
if (motionOverrideActive) {
    reducedMotion = true;
    document.documentElement.classList.add('motion-off');
}
// THREE.Clock is deprecated in this build (r185: "THREE.Clock: This module has been
// deprecated. Please use THREE.Timer instead."). Timer ships in the vendored core bundle,
// so no extra file/import-map entry is needed. API differs slightly: call update() once per
// frame, then getDelta() / getElapsed() (not getElapsedTime()). Both still return seconds.
const timer = new THREE.Timer();
let currentScroll = 0;    // smoothed hero progress, clamped 0..1
let revealProgress = 0;   // smoothed Phase-2 blend, 0 (pure hero) .. 1 (fully settled/blurred)

let mouseX = 0, mouseY = 0, targetMouseX = 0, targetMouseY = 0;

let cursorX = window.innerWidth / 2,  cursorY = window.innerHeight / 2;

let bgMaterial;
const shaderUniforms = {
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uScroll: { value: 0 }
};

let sparkParticles;
const sparkData = [];

const sizes = { width: window.innerWidth, height: window.innerHeight };

// ---- Device quality tiers ----
const isMobile = window.matchMedia('(max-width: 767px)').matches;
const QUALITY = {
    sparkCount: isMobile ? 150 : 450,
    maxDpr: isMobile ? 1.5 : 2,
    shadowsEnabled: !isMobile,
    shadowMapSize: isMobile ? 1024 : 2048,
    maxBlurPx: isMobile ? 10 : 16,
    // Was 6 — too short relative to viewport height on phones, so the project section's top
    // edge started sliding into view (normal document flow, right after the spacer) almost
    // the instant slide 4 appeared, chopping off still fully-opaque text before it could be
    // read. 8 pushes that crossover point comfortably past slide 4's readable dwell window.
    heroVhMultiplier: isMobile ? 8 : 9,
    // Touch scrolling delivers one continuous, high-velocity, inertia-driven gesture rather
    // than the many small wheel ticks these were tuned against — at the desktop lerp speed the
    // camera/blur/text state trails far enough behind a mobile flick that it visibly keeps
    // "catching up" for a second or more after the finger lifts and the page has already
    // stopped moving, reading as content abruptly refreshing/popping into place. Faster lerp on
    // mobile keeps the visual state tied much more closely to the real, already-settled scroll
    // position.
    scrollLerpSpeed: isMobile ? 0.09 : 0.025,
    revealLerpSpeed: isMobile ? 0.12 : 0.04
};

// ---- Scroll model constants ----
let heroScrollLength = window.innerHeight * QUALITY.heroVhMultiplier;
// Slide 4 activates at 0.78 (see updateSlides). TRANSITION_START must land at or before
// roughly (1 - 1/heroVhMultiplier) — the fraction at which the project section's top edge
// starts entering the viewport from below — otherwise the incoming section visually covers
// slide 4's text while it's still fully opaque. 0.85 sits under that line for both device
// tiers (0.875 mobile / 0.889 desktop) while still giving slide 4 a real ~0.5–0.6 screen-height
// dwell to be read before anything starts fading.
const TRANSITION_START = 0.85; // fraction of hero progress where the settle/blur begins
const TRANSITION_END = 1.05;   // fraction where it's fully settled (slightly past hero's own 1.0)
const SETTLE_PHI = Math.PI / 2;  // true side-profile camera angle
const SETTLE_Y = 0.5;
const SETTLE_RADIUS = 4.0;

// ---- Assets ----
// Served locally — no external CDN dependency for the model.
const BRONZE_HORSE_MODEL_URL = "assets/bronze_horse.glb";

// ---- Project data ----
// Smart schema: `featured` pins a project to the top of the grid, `priority` orders the
// rest (lower = earlier). New projects can just be appended — no manual reordering needed,
// see sortProjects() / getVisibleProjects() below.
// ---- Project data ----
// Smart schema: `featured` pins a project to the top of the grid, `priority` orders the
// rest (lower = earlier). Loaded at runtime from projects.json — add a new project by
// appending one object to that file, no code changes needed, no manual reordering.
let PROJECTS = [];

async function loadProjects() {
    try {
        const response = await fetch('projects.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        PROJECTS = await response.json();
    } catch (error) {
        console.error('Error loading projects.json:', error);
        PROJECTS = [];
    }
}

// ============================================================
// Live GitHub stats widget
// ============================================================
// Three-layer fallback so the widget can never render broken or empty:
//   1. Paint instantly from localStorage, if a previous visit cached it.
//   2. Otherwise paint the seed below — real numbers, fetched from the API at the time this
//      widget shipped, not invented placeholders. "Stale but true" beats a blank "—" while the
//      network call is in flight, and it's also the last resort if that call fails outright.
//   3. Kick off a live fetch in the background; on success, repaint and refresh the cache. On
//      failure — rate-limited, offline, GitHub down — whatever's already on screen (cache or
//      seed) just stays there. No spinner, no error state, no retry loop.
const GITHUB_USERNAME = 'AndrewTechTips';
const GITHUB_STATS_CACHE_KEY = 'gh-stats-cache-v1';
// GitHub's unauthenticated rate limit is 60 requests/hour per IP. A 6-hour TTL keeps a repeat
// visitor comfortably under that (this page makes 2 calls per fetch) while still counting as
// "live" for a widget nobody is refreshing minute to minute.
const GITHUB_STATS_CACHE_TTL = 6 * 60 * 60 * 1000;
const GITHUB_STATS_SEED = { repos: 46, stars: 0, followers: 8 };

function readGithubStatsCache() {
    try {
        const raw = localStorage.getItem(GITHUB_STATS_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed.repos !== 'number' || typeof parsed.stars !== 'number' || typeof parsed.followers !== 'number') return null;
        return parsed;
    } catch {
        return null; // corrupted JSON, storage blocked, etc. — treat exactly like "no cache"
    }
}

function writeGithubStatsCache(stats) {
    try {
        localStorage.setItem(GITHUB_STATS_CACHE_KEY, JSON.stringify({ ...stats, ts: Date.now() }));
    } catch {
        // Storage full/blocked — the widget still works for this page view, it just won't
        // warm-start on the next one.
    }
}

function paintGithubStats(stats, { live = false } = {}) {
    const repos = document.getElementById('gh-stat-repos');
    const stars = document.getElementById('gh-stat-stars');
    const followers = document.getElementById('gh-stat-followers');
    if (repos) repos.textContent = stats.repos.toLocaleString();
    if (stars) stars.textContent = stats.stars.toLocaleString();
    if (followers) followers.textContent = stats.followers.toLocaleString();
    document.getElementById('gh-stats-live')?.classList.toggle('is-live', live);
}

async function fetchGithubStats() {
    // Two calls: the profile (repo count + followers) and the repo list (to sum stars — the
    // profile endpoint has no aggregate star count). Both are unauthenticated GETs, well
    // inside the anonymous rate limit for a single page view; a 403 here almost always means
    // that limit was already spent by other traffic from the visitor's IP, not anything this
    // page did.
    const [userRes, reposRes] = await Promise.all([
        fetch(`https://api.github.com/users/${GITHUB_USERNAME}`, { headers: { Accept: 'application/vnd.github+json' } }),
        fetch(`https://api.github.com/users/${GITHUB_USERNAME}/repos?per_page=100&type=owner`, { headers: { Accept: 'application/vnd.github+json' } })
    ]);
    if (!userRes.ok || !reposRes.ok) throw new Error(`GitHub API responded ${userRes.status}/${reposRes.status}`);

    const user = await userRes.json();
    const repos = await reposRes.json();
    if (!Array.isArray(repos)) throw new Error('Unexpected /repos payload shape');

    const stars = repos.reduce((sum, r) => sum + (r.stargazers_count || 0), 0);
    return {
        repos: typeof user.public_repos === 'number' ? user.public_repos : repos.length,
        stars,
        followers: typeof user.followers === 'number' ? user.followers : 0
    };
}

async function setupGithubStats() {
    const widget = document.getElementById('github-stats');
    if (!widget) return;

    const cached = readGithubStatsCache();
    paintGithubStats(cached || GITHUB_STATS_SEED, { live: false });

    // A cache still inside its TTL is good enough — skip the network call entirely rather
    // than re-fetching on every single page load.
    if (cached && Date.now() - cached.ts < GITHUB_STATS_CACHE_TTL) return;

    try {
        const fresh = await fetchGithubStats();
        paintGithubStats(fresh, { live: true });
        writeGithubStatsCache(fresh);
    } catch (error) {
        // See the fallback-layer comment above this section — whatever's already painted
        // stays exactly as it is.
        console.warn('GitHub stats: live fetch failed, showing cached/seed values instead.', error);
    }
}

// Display labels for the auto-generated filter bar (falls back to the raw tech name if unlisted).
const LANGUAGE_LABELS = { python: "Python", javascript: "JavaScript", html5: "HTML/CSS" };

// Featured projects always float to the top; everything else is ordered by `priority`
// (ascending, missing priority sorts last). Adding a new project is just appending an
// object to PROJECTS — this handles the layout automatically.
function sortProjects(list) {
    return [...list].sort((a, b) => {
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        const pa = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
        const pb = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
        return pa - pb;
    });
}

function getVisibleProjects(filter) {
    const sorted = sortProjects(PROJECTS);
    if (!filter || filter === "all") return sorted;
    return sorted.filter(p => p.tech.some(t => t.type === "language" && t.name === filter));
}

let activeProjectFilter = "all";

function createBackgroundShader() {
    const vertexShader = `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;

    const fragmentShader = `
        varying vec2 vUv;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform vec2 uMouse;
        uniform float uScroll;

        float hash(float n) { return fract(sin(n) * 43758.5453123); }
        float noise(in vec3 x) {
            vec3 p = floor(x);
            vec3 f = fract(x);
            f = f*f*(3.0-2.0*f);
            float n = p.x + p.y*57.0 + 113.0*p.z;
            return mix(mix(mix(hash(n+  0.0), hash(n+  1.0), f.x),
                           mix(hash(n+ 57.0), hash(n+ 58.0), f.x), f.y),
                       mix(mix(hash(n+113.0), hash(n+114.0), f.x),
                           mix(hash(n+170.0), hash(n+171.0), f.x), f.y), f.z);
        }

        void main() {
            vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;
            float aspect = uResolution.x / uResolution.y;

            float time = uTime * 0.08;
            float scroll = uScroll;

            float angle1 = 0.6;
            float angle2 = -0.7;
            float angle3 = 1.2;

            float freq1 = 2.4;
            float freq2 = 3.2;
            float freq3 = 4.0;

            vec2 warpedUv = uv;

            float scrollDeform = scroll * 5.0;

            warpedUv.x += sin(uv.y * 2.5 + time * 0.2 + scrollDeform) * 0.35;
            warpedUv.y += cos(uv.x * 2.5 - time * 0.15 - scrollDeform * 0.8) * 0.35;

            warpedUv.x += sin(uv.y * 1.2 - time * 0.1 - scrollDeform * 1.5) * 0.25;
            warpedUv.y += cos(uv.x * 1.2 + time * 0.18 + scrollDeform * 1.2) * 0.25;

            vec2 scrollDrift = vec2(scroll * 0.04, -scroll * 0.02);
            vec2 mouseShift = vec2(uMouse.x * aspect * 0.05, uMouse.y * 0.05);
            warpedUv += scrollDrift + mouseShift;

            vec2 dir1 = vec2(cos(angle1), sin(angle1));
            vec2 dir2 = vec2(cos(angle2), sin(angle2));
            vec2 dir3 = vec2(cos(angle3), sin(angle3));

            float w1 = sin(dot(warpedUv, dir1) * freq1 + time * 1.0);
            float w2 = cos(dot(warpedUv, dir2) * freq2 - time * 1.4 + w1 * 0.4);
            float w3 = sin(dot(warpedUv, dir3) * freq3 + time * 1.8 + w2 * 0.5);

            float waveField = w1 * 0.50 + w2 * 0.35 + w3 * 0.15;

            float wideSheen = pow(max(0.0, 1.0 - abs(waveField - 0.1)), 2.5);
            float crispSpecular = pow(max(0.0, 1.0 - abs(waveField - 0.15)), 8.0);
            float crest = wideSheen * 0.5 + crispSpecular * 0.9;

            vec3 c0_shadow = vec3(0.0010, 0.0006, 0.0004);
            vec3 c0_wave1  = vec3(0.085, 0.040, 0.015);
            vec3 c0_wave2  = vec3(0.050, 0.022, 0.008);
            vec3 c0_crest  = vec3(0.45, 0.30, 0.18);

            vec3 c1_shadow = vec3(0.0004, 0.0006, 0.0012);
            vec3 c1_wave1  = vec3(0.015, 0.035, 0.065);
            vec3 c1_wave2  = vec3(0.008, 0.020, 0.045);
            vec3 c1_crest  = vec3(0.18, 0.35, 0.55);

            float t = smoothstep(0.0, 1.0, scroll);
            vec3 colShadow = mix(c0_shadow, c1_shadow, t);
            vec3 colWave1  = mix(c0_wave1, c1_wave1, t);
            vec3 colWave2  = mix(c0_wave2, c1_wave2, t);
            vec3 colCrest  = mix(c0_crest, c1_crest, t);

            vec3 color = colShadow;
            color = mix(color, colWave2, smoothstep(-0.6, 0.2, waveField));
            color = mix(color, colWave1, smoothstep(0.0, 0.8, waveField));

            color += colCrest * crest * 1.4;

            float vignette = 1.0 - dot(uv, uv) * 0.12;
            color *= vignette;

            gl_FragColor = vec4(color, 1.0);
        }
    `;

    bgMaterial = new THREE.ShaderMaterial({
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
        uniforms: shaderUniforms,
        depthWrite: false,
        depthTest: false
    });

    const bgGeometry = new THREE.PlaneGeometry(30, 30);
    const bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
    bgMesh.position.set(0.0, 0.0, -8.0);
    bgMesh.renderOrder = -10;
    camera.add(bgMesh);
}

function createSparkTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.25, 'rgba(255, 255, 255, 0.85)');
    gradient.addColorStop(0.6, 'rgba(255, 255, 255, 0.3)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 16, 16);
    return new THREE.CanvasTexture(canvas);
}

function createSparks() {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(QUALITY.sparkCount * 3);
    const colors = new Float32Array(QUALITY.sparkCount * 3);

    for (let i = 0; i < QUALITY.sparkCount; i++) {
        const x = (Math.random() - 0.5) * 6.5;
        const y = (Math.random() - 0.5) * 5.0 - 0.5;
        const z = (Math.random() - 0.5) * 6.5;
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        if (Math.random() < 0.6) {
            // saturated fiery orange
            colors[i * 3] = 1.0;
            colors[i * 3 + 1] = 0.4 + Math.random() * 0.15;
            colors[i * 3 + 2] = 0.05 + Math.random() * 0.1;
        } else {
            // cosmic icy light-blue (matches rim light)
            colors[i * 3] = 0.55 + Math.random() * 0.15;
            colors[i * 3 + 1] = 0.82 + Math.random() * 0.12;
            colors[i * 3 + 2] = 1.0;
        }

        sparkData.push({
            speedX: (Math.random() - 0.5) * 0.4,
            speedY: 0.15 + Math.random() * 0.3,
            speedZ: (Math.random() - 0.5) * 0.4,
            swaySpeed: 0.5 + Math.random() * 1.5,
            swayRadius: 0.05 + Math.random() * 0.15,
            phase: Math.random() * Math.PI * 2
        });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 0.025,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        map: createSparkTexture()
    });

    sparkParticles = new THREE.Points(geometry, material);
    scene.add(sparkParticles);
}

function loadModel() {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
        BRONZE_HORSE_MODEL_URL,
        (gltf) => {
            hideModelLoader();
            gltfModel = gltf.scene;

            modelPivot = new THREE.Group();
            scene.add(modelPivot);
            modelPivot.add(gltfModel);

            gltfModel.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = QUALITY.shadowsEnabled;
                    child.receiveShadow = QUALITY.shadowsEnabled;
                    if (child.material) {
                        child.material.roughness = 0.42;   // semi-matte, noble highlights
                        child.material.metalness = 0.92;   // high satin-bronze metallic sheen
                        child.material.envMapIntensity = 0.6;   // soft IBL from createEnvironment()
                        child.material.flatShading = false;
                        if (child.material.map) {
                            child.material.map.anisotropy = isMobile ? 4 : 16;
                        }
                    }
                }
            });

            if (gltf.animations && gltf.animations.length > 0) {
                mixer = new THREE.AnimationMixer(gltfModel);
                gltf.animations.forEach((clip) => { mixer.clipAction(clip).play(); });
            }

            // 1. scale so max dimension = 3.5
            const boxInitial = new THREE.Box3().setFromObject(gltfModel);
            const sizeInitial = boxInitial.getSize(new THREE.Vector3());
            const maxDim = Math.max(sizeInitial.x, sizeInitial.y, sizeInitial.z);
            const targetScale = 3.5 / (maxDim > 0.0001 ? maxDim : 1);
            gltfModel.scale.setScalar(targetScale);

            // 2. update world matrix so the box accounts for scale
            gltfModel.updateMatrixWorld(true);

            // 3. exact geometric center of the scaled model
            const boxScaled = new THREE.Box3().setFromObject(gltfModel);
            const centerScaled = boxScaled.getCenter(new THREE.Vector3());

            // 4. recenter model so its center sits at the pivot origin
            gltfModel.position.sub(centerScaled);

            // 5. lower the pivot for a grounded stance
            modelPivot.position.y = -0.4;
        },
        (event) => {
            if (event.total > 0) updateModelLoaderProgress(event.loaded / event.total);
        },
        (error) => {
            console.error('Error loading bronze horse model:', error);
            showModelLoaderError();
        }
    );
}

// The loader stays transparent (no full-screen cover) so the ambient sparks/shader backdrop
// is visible the whole time the ~600KB model streams in — see .model-loader in style.css.
// Rounded to the nearest 10% (rather than every raw progress tick) so the aria-live region
// announces a handful of times over the download instead of spamming screen readers.
let lastAnnouncedDecile = -1;
function updateModelLoaderProgress(fraction) {
    const decile = Math.floor(Math.min(1, fraction) * 10);
    if (decile === lastAnnouncedDecile) return;
    lastAnnouncedDecile = decile;
    const label = document.getElementById('model-loader-label');
    if (label) label.textContent = `Loading scene… ${decile * 10}%`;
}

function hideModelLoader() {
    const loader = document.getElementById('model-loader');
    if (loader) loader.classList.add('hidden');
}

// Shown only if the model genuinely fails to fetch/parse — the rest of the page (nav, hero
// text, project grid) still works fine without the statue, so this never blocks anything,
// it just stops the spinner from spinning forever with no explanation.
function showModelLoaderError() {
    const loader = document.getElementById('model-loader');
    const label = document.getElementById('model-loader-label');
    if (label) label.textContent = 'Could not load the 3D scene';
    if (loader) {
        loader.classList.add('error');
        setTimeout(() => loader.classList.add('hidden'), 4000);
    }
}

// ---- Image-based lighting ----
// A small procedural "studio" environment: a canvas-painted equirectangular gradient (near-
// black floor -> warm horizon sweep -> cool ceiling, plus one soft off-axis glint) baked once
// through PMREMGenerator at startup. scene.environment feeds reflections to every
// MeshStandardMaterial in the scene — here that's only the bronze horse (the sparks are
// Points, the backdrop is a raw ShaderMaterial). The result is a static prefiltered cube map
// sampled in the material shader like any other texture: zero per-frame cost, nothing like the
// EffectComposer that was removed. Without it a metalness-0.92 surface reflects pure black
// everywhere a direct light doesn't strike it and reads as dark plastic; with it the shaded
// areas pick up soft reflective detail and the metal looks forged. Per-material
// envMapIntensity (see loadModel) scales the contribution.
function createEnvironment() {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext('2d');

    // Vertical base gradient — floor up to ceiling. The bright warm band near the middle is
    // the "horizon" the metal catches as a broad specular sweep.
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, '#26242c');   // ceiling — cool neutral
    g.addColorStop(0.42, '#4a4650');   // upper wall
    g.addColorStop(0.55, '#9a8672');   // horizon — warm reflective sweep
    g.addColorStop(0.70, '#2a2320');   // lower wall
    g.addColorStop(1.00, '#0b0a09');   // floor — near black
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 256);

    // One soft warm glint, off-centre, so the orbiting camera sees a highlight travel across
    // the bronze rather than a static, uniform sheen.
    const blob = ctx.createRadialGradient(360, 80, 0, 360, 80, 150);
    blob.addColorStop(0, 'rgba(232, 212, 188, 0.55)');
    blob.addColorStop(1, 'rgba(232, 212, 188, 0)');
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, 512, 256);

    const equirect = new THREE.CanvasTexture(c);
    equirect.colorSpace = THREE.SRGBColorSpace;
    equirect.mapping = THREE.EquirectangularReflectionMapping;

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(equirect).texture;

    equirect.dispose();
    pmrem.dispose();
}

function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#000000');
    scene.fog = new THREE.FogExp2('#000000', 0.01);

    camera = new THREE.PerspectiveCamera(50, sizes.width / sizes.height, 0.1, 100);
    camera.position.set(0, 0.2, 3.0);
    scene.add(camera);

    createBackgroundShader();   // adds the wave plane as a child of the camera

    renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: false,
        powerPreference: "high-performance"
    });
    renderer.setSize(sizes.width, sizes.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxDpr));

    renderer.shadowMap.enabled = QUALITY.shadowsEnabled;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Native rendering path — no EffectComposer. The premium metallic look comes purely from
    // the lighting rig + these two settings: ACES filmic tone mapping rolls the specular
    // highlights off cinematically instead of clipping, and the sRGB output color space
    // gamma-corrects the final image. Nothing blurs or blooms the frame; every pixel the
    // renderer produces goes straight to the canvas, so the bronze stays crisp and sharp.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2.2;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    createEnvironment();   // scene.environment — soft IBL reflections for the metal

    const ambientLight = new THREE.AmbientLight('#ffffff', 0.1);
    scene.add(ambientLight);

    // Key light: super-bright white from upper-right, casts shadows
    const keyLight = new THREE.SpotLight('#ffffff', 18.0);
    keyLight.position.set(4, 6, 3);
    keyLight.angle = Math.PI / 4;
    keyLight.penumbra = 0.9;
    keyLight.castShadow = QUALITY.shadowsEnabled;
    keyLight.shadow.mapSize.width = QUALITY.shadowMapSize;
    keyLight.shadow.mapSize.height = QUALITY.shadowMapSize;
    keyLight.shadow.camera.near = 1.0;
    keyLight.shadow.camera.far = 15;
    keyLight.shadow.bias = -0.001;
    scene.add(keyLight);

    // Rim light: cool blue from behind-left, defines the silhouette
    const rimLight = new THREE.DirectionalLight('#e3f2ff', 10.0);
    rimLight.position.set(-5, 3, -4);
    scene.add(rimLight);

    // Fill light: very faint warm cream from below-front
    const fillLight = new THREE.DirectionalLight('#fff3e6', 0.8);
    fillLight.position.set(-2, -4, 2);
    scene.add(fillLight);

    createSparks();
    loadModel();
}

function onWindowResize({ recalcHeroLength = true } = {}) {
    sizes.width = window.innerWidth;
    sizes.height = window.innerHeight;
    if (camera) {
        camera.aspect = sizes.width / sizes.height;
        camera.updateProjectionMatrix();
    }
    if (renderer) {
        renderer.setSize(sizes.width, sizes.height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxDpr));
    }
    if (shaderUniforms) shaderUniforms.uResolution.value.set(sizes.width, sizes.height);

    // Only recompute the hero's scroll distance (8-9 viewport-heights tall) on a real layout
    // change — orientation flip, actual window resize — never on a mobile browser's
    // address-bar show/hide, which fires plain 'resize' events with the same width but a
    // different innerHeight while the user is mid-scroll. Recalculating this spacer's height
    // under the user's feet mid-gesture rewrote the document's scrollable length while they
    // were actively scrolling through it, producing a visible jump/flash partway through.
    if (recalcHeroLength) {
        heroScrollLength = window.innerHeight * QUALITY.heroVhMultiplier;
        document.documentElement.style.setProperty('--hero-scroll-vh', `${heroScrollLength}px`);
    }

    // Real measured header height (not a guessed constant) so the mobile menu panel always
    // sits flush below it, whatever font-loading/content differences shift its actual size.
    const headerEl = document.querySelector('.main-header');
    if (headerEl) {
        document.documentElement.style.setProperty('--mobile-header-height', `${headerEl.getBoundingClientRect().height}px`);
    }
}

let resizeTimeout;
let lastResizeWidth = window.innerWidth;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        const widthChanged = window.innerWidth !== lastResizeWidth;
        lastResizeWidth = window.innerWidth;
        onWindowResize({ recalcHeroLength: widthChanged });
    }, 120);
});
window.addEventListener('orientationchange', () => {
    lastResizeWidth = window.innerWidth;
    onWindowResize({ recalcHeroLength: true });
});

// ---- Pointer handling — fine-pointer only ----
// `(pointer: fine)` is supposed to be false on phones, but plenty of real devices get this
// wrong in practice — Android phones with stylus support, in-app browsers (Instagram/Facebook
// webviews), foldables — which was showing the desktop cursor ring on tap for those users, with
// no mouse around to explain what it was. A media query alone isn't trustworthy enough here, so
// the first real touch event is treated as the tie-breaker: any actual touch immediately strips
// the class, permanently, regardless of what the query claimed up front.
if (window.matchMedia('(pointer: fine)').matches) {
    document.documentElement.classList.add('has-fine-pointer');
}
window.addEventListener('touchstart', () => {
    document.documentElement.classList.remove('has-fine-pointer');
}, { once: true, passive: true });

window.addEventListener('mousemove', (event) => {
    cursorX = event.clientX;
    cursorY = event.clientY;
    const cursorInner = document.querySelector('.cursor-inner');
    if (cursorInner) { cursorInner.style.left = `${cursorX}px`; cursorInner.style.top = `${cursorY}px`; }
    targetMouseX = (event.clientX / window.innerWidth) * 2 - 1;
    targetMouseY = (event.clientY / window.innerHeight) * 2 - 1;
});

// Walks the actual DOM nodes (not a raw HTML string) so decoded entities like "&amp;"
// come through as a single real "&" character instead of being split into literal
// "&", "a", "m", "p", ";" spans.
function splitTitlesIntoChars() {
    const titles = document.querySelectorAll('.slide-title');
    titles.forEach(title => {
        const sourceNodes = Array.from(title.childNodes);
        title.innerHTML = '';
        let delayCounter = 0;

        sourceNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent;
                for (let i = 0; i < text.length; i++) {
                    if (text[i] === ' ') {
                        title.appendChild(document.createTextNode(' '));
                    } else {
                        const span = document.createElement('span');
                        span.className = 'char';
                        span.style.transitionDelay = `${delayCounter * 0.035}s`;
                        span.textContent = text[i];
                        title.appendChild(span);
                        delayCounter++;
                    }
                }
            } else {
                title.appendChild(node.cloneNode(true));
            }
        });
    });
}

function animate() {
    if (!renderLoopActive) return;         // paused: hero scrolled out of view
    rafId = requestAnimationFrame(animate);
    timer.update();                       // sample the frame clock once
    const deltaTime = timer.getDelta();
    if (mixer) mixer.update(deltaTime);

    // 1. raw progress over the fixed hero distance (NOT total document scroll)
    const scrollTop = window.scrollY !== undefined ? window.scrollY
        : (window.pageYOffset !== undefined ? window.pageYOffset : document.documentElement.scrollTop);
    const rawProgress = heroScrollLength > 0 ? scrollTop / heroScrollLength : 0;

    const targetHeroProgress = Math.min(1, Math.max(0, rawProgress));
    currentScroll += (targetHeroProgress - currentScroll) * QUALITY.scrollLerpSpeed;

    const revealTarget = Math.min(1, Math.max(0, (rawProgress - TRANSITION_START) / (TRANSITION_END - TRANSITION_START)));
    revealProgress += (revealTarget - revealProgress) * QUALITY.revealLerpSpeed;

    // smooth model tilt lerp
    mouseX += (targetMouseX - mouseX) * 0.05;
    mouseY += (targetMouseY - mouseY) * 0.05;

    // gentle interactive model tilt from mouse, damped out as Phase 2 settles in
    if (modelPivot) {
        const tiltDamp = 1 - revealProgress;
        modelPivot.rotation.y = mouseX * 0.25 * tiltDamp;
        modelPivot.rotation.x = mouseY * 0.15 * tiltDamp;
    }

    // 2. sparks physics — always running on real elapsed time, never frozen
    if (sparkParticles) {
        const positions = sparkParticles.geometry.attributes.position.array;
        const time = timer.getElapsed();
        const scrollVelocity = Math.abs(targetHeroProgress - currentScroll);
        const speedMultiplier = 1.0 + scrollVelocity * 9.0;
        const turbulence = scrollVelocity * 0.8;

        for (let i = 0; i < QUALITY.sparkCount; i++) {
            const idx = i * 3;
            const data = sparkData[i];
            positions[idx]     += data.speedX * deltaTime * speedMultiplier;
            positions[idx + 1] += data.speedY * deltaTime * speedMultiplier;
            positions[idx + 2] += data.speedZ * deltaTime * speedMultiplier;

            const currentSway = data.swayRadius * (1.0 + turbulence * 4.0);
            positions[idx]     += Math.sin(time * data.swaySpeed + data.phase) * currentSway * deltaTime;
            positions[idx + 2] += Math.cos(time * data.swaySpeed + data.phase) * currentSway * deltaTime;

            if (positions[idx + 1] > 3.0 || Math.abs(positions[idx]) > 3.5 || Math.abs(positions[idx + 2]) > 3.5) {
                positions[idx + 1] = -2.5;
                positions[idx]     = (Math.random() - 0.5) * 3.0;
                positions[idx + 2] = (Math.random() - 0.5) * 3.0;
            }
        }
        sparkParticles.geometry.attributes.position.needsUpdate = true;
    }

    // 3. camera: full 360° orbit during hero, blended into a fixed side-profile "settle" pose
    const heroPhi = currentScroll * Math.PI * 2.0;
    const phi = THREE.MathUtils.lerp(heroPhi, SETTLE_PHI, revealProgress);

    const heroY = 0.35 + Math.sin(currentScroll * Math.PI) * 0.8;
    const y = THREE.MathUtils.lerp(heroY, SETTLE_Y, revealProgress);

    const heroRadius = 4.2 - Math.sin(currentScroll * Math.PI) * 0.6;
    const radius = THREE.MathUtils.lerp(heroRadius, SETTLE_RADIUS, revealProgress);

    const x = radius * Math.sin(phi);
    const z = radius * Math.cos(phi);

    let transitionProgress = Math.min(1.0, currentScroll / 0.28);
    let easeFactor = (Math.cos(transitionProgress * Math.PI) + 1.0) * 0.5;
    const lookAtXOffset = -0.9 * easeFactor * (1 - revealProgress);
    const targetLookAt = new THREE.Vector3(lookAtXOffset, -0.15, 0);
    const targetPos = new THREE.Vector3(x, y, z);
    camera.position.lerp(targetPos, 0.025);
    camera.lookAt(targetLookAt);

    // background shader uniforms — keeps breathing via uTime even once frozen
    if (shaderUniforms) {
        shaderUniforms.uTime.value = timer.getElapsed();
        shaderUniforms.uMouse.value.set(mouseX, -mouseY);
        shaderUniforms.uScroll.value = currentScroll;
    }

    // 4. Phase-2 visual reveal: real CSS blur on the canvas + dark tint + hero-UI fade-out
    const blurPx = QUALITY.maxBlurPx * revealProgress;
    canvas.style.filter = revealProgress > 0.01 ? `blur(${blurPx.toFixed(1)}px)` : 'none';

    const tint = document.querySelector('.reveal-tint');
    if (tint) tint.style.opacity = (revealProgress * 0.55).toFixed(3);

    const gridLines = document.querySelector('.grid-lines');
    const gridHLine = document.querySelector('.grid-horizontal-line');
    const uiFade = 1 - revealProgress;
    if (gridLines) gridLines.style.opacity = uiFade;
    if (gridHLine) gridHLine.style.opacity = uiFade;

    updateSlides(currentScroll, revealProgress, targetHeroProgress);
    updateGridDots(currentScroll);

    renderer.render(scene, camera);
}

function updateGridDots(scroll) {
    const dots = document.querySelectorAll('.grid-dot');
    dots.forEach((dot, i) => {
        const startY = (i * 17) % 80 + 10;
        let speed = 90 + (i * 55) % 180;
        if (i % 2 === 0) speed = -speed;
        let y = startY + scroll * speed;
        y = ((y % 100) + 100) % 100;
        dot.style.top = `${y}%`;
    });
}

function updateSlides(scroll, reveal, rawScroll) {
    const slide1 = document.getElementById('slide-1');
    const slide2 = document.getElementById('slide-2');
    const slide3 = document.getElementById('slide-3');
    const slide4 = document.getElementById('slide-4');
    const slideImg = document.getElementById('slide-2-img');

    for (let i = 1; i <= 4; i++) {
        const fill = document.getElementById(`dash-fill-${i}`);
        if (fill) {
            const start = (i - 1) * 0.25;
            const end = i * 0.25;
            let progress = (scroll - start) / (end - start);
            progress = Math.max(0, Math.min(1, progress));
            fill.style.height = `${progress * 100}%`;
        }
    }

    // Activation is driven purely by scroll position (currentScroll), not revealProgress.
    // The two used to be mixed (isActive also required reveal < 0.05), but reveal ramps up
    // faster than currentScroll settles into a slide's window — slide 4's range overlaps
    // TRANSITION_START, so reveal would cross the old 0.05 cutoff and force the slide invisible
    // while currentScroll was still mid-window: it flashed on, then vanished before the project
    // grid had actually faded in underneath. The container-level opacity fade below already
    // handles the Phase-2 fade-out smoothly, so this class toggle only needs to track scroll
    // position.
    function isActive(val, start, end) { return val >= start && val <= end; }

    if (slide1) slide1.classList.toggle('active', isActive(scroll, -0.10, 0.12));
    if (slide2) {
        const active2 = isActive(scroll, 0.28, 0.40);
        slide2.classList.toggle('active', active2);
        if (slideImg) slideImg.classList.toggle('active', active2);
    }
    if (slide3) slide3.classList.toggle('active', isActive(scroll, 0.56, 0.68));
    // Keyed to rawScroll (the un-lerped, instantaneous scroll fraction), not the smoothed
    // `scroll` (currentScroll) used above — currentScroll's 0.025 lerp factor means it steadily
    // lags real scroll position by as much as ~0.07 of the fraction range during continuous
    // scrolling. revealProgress (which drives TRANSITION_START below) is derived from rawScroll
    // too, so gating slide 4 on the laggy signal instead would let the two drift apart: slide 4
    // wouldn't visually activate until well after its nominal 0.78 mark, landing it right on top
    // of where the fade-out already begins — the exact "no time to read it" bug this is fixing,
    // just relocated. Slides 1–3 stay on currentScroll since their timing is tied to the camera
    // orbit, not reported as broken, and untouched here to keep this change narrowly scoped.
    if (slide4) slide4.classList.toggle('active', isActive(rawScroll, 0.78, 1.05));

    // Text fades out over just the first 40% of the reveal range instead of linearly across
    // all of it — it needs to be gone well before the incoming project section (which starts
    // physically covering the screen at a fraction independent of `reveal`, see
    // heroVhMultiplier's comment) reaches up to where the text sits, or it reads as the text
    // getting abruptly chopped off mid-sentence rather than cleanly fading away first.
    const container = document.querySelector('.cinematic-container');
    if (container) container.style.opacity = Math.max(0, 1 - reveal / 0.4).toFixed(3);
    if (slideImg) slideImg.style.opacity = slideImg.classList.contains('active') ? '1' : '0';
}

// Each link carries its own destination fraction (data-target-fraction), rather than being
// matched by position in a flat querySelectorAll list — the desktop nav and the mobile menu
// panel both render a full set of `.nav-link`s (10 elements total), and index-matching them
// against a single targetFractions array would silently break as soon as the two lists
// diverge in order or count.
// Shared by the header/mobile nav links and the command palette's "Navigate" commands — pulled
// out of what used to be setupNavigation's click handler so both drive the exact same,
// carefully-tuned scroll math instead of two copies quietly drifting apart.
function jumpToFraction(fraction) {
    const targetY = heroScrollLength * fraction;

    // revealProgress normally lerps toward its target over a second or two, tracking the
    // ACTUAL scroll position frame by frame as the user scrolls by hand. A programmatic jump
    // instead teleports the scroll position, so left alone, reveal would still be lerping from
    // wherever it USED to be — landing on "Connect" (inside slide 4's own window, but also
    // inside the blur/tint transition zone) used to show a partially blurred, half-legible
    // slide instead of a clean one; landing on "Work" showed slide 4's fading text hovering
    // over the now-visible project cards. Both are the same root cause: reveal desynced from
    // where the destination actually is. Snapping it straight to the value the destination
    // fraction implies fixes every jump at once, in both directions, rather than special-casing
    // one target. "Work" (fraction >= 1) is hardcoded to fully revealed rather than run through
    // the formula — it lands inside the project section's own normal-flow content, past
    // TRANSITION_END, and tying its correctness to it exactly matching TRANSITION_END would
    // silently break the very next time these constants get tuned.
    revealProgress = fraction >= 1
        ? 1
        : Math.min(1, Math.max(0, (fraction - TRANSITION_START) / (TRANSITION_END - TRANSITION_START)));

    // "Work" additionally jumps past the hero-scroll-spacer into the project section's own
    // content, so the camera/orbit state should already be fully settled there too — not still
    // gliding in from wherever it was when triggered.
    if (fraction >= 1) {
        currentScroll = 1;
    }

    const startY = window.scrollY;
    window.scrollTo({ top: targetY, behavior: reducedMotion ? 'auto' : 'smooth' });
    // Some webviews (and headless/automation contexts) treat behavior:'smooth' as a no-op
    // instead of falling back to an instant jump. If the position hasn't budged at all a
    // beat later, force it — a working smooth scroll will already have moved by then, so this
    // never truncates a real animation.
    if (!reducedMotion) {
        setTimeout(() => {
            if (window.scrollY === startY && startY !== targetY) {
                window.scrollTo({ top: targetY, behavior: 'auto' });
            }
        }, 400);
    }
}

function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link[data-target-fraction]');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            jumpToFraction(parseFloat(link.dataset.targetFraction));
            closeMobileMenu();
        });
    });
}

// The mobile menu and the contact modal can both be open at once (the Contact button and the
// hamburger sit side by side, so nothing stops a tap on Contact while the menu is open) — each
// tracks its own lock instead of unconditionally clearing body.style.overflow on close, so
// closing one doesn't re-enable scrolling while the other is still open.
const scrollLocks = new Set();
function setScrollLock(name, locked) {
    if (locked) scrollLocks.add(name); else scrollLocks.delete(name);
    document.body.style.overflow = scrollLocks.size > 0 ? 'hidden' : '';
}

// Keeps Tab/Shift+Tab cycling within an open overlay (mobile menu panel, contact modal)
// instead of moving focus into content that's visually hidden behind it — the standard
// WAI-ARIA dialog pattern expectation for anything with a backdrop.
function trapFocus(container, event) {
    if (event.key !== 'Tab') return;
    const focusables = container.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

// Hamburger menu — only meaningfully visible ≤767px (see CSS), but wired up unconditionally
// since it's harmless when hidden and avoids re-checking viewport width in JS.
// The hamburger button doubles as the close control (it morphs into an X) — that's the one
// and only close button. Tapping the dimmed backdrop or pressing Escape close it too.
function setupMobileMenu() {
    const toggle = document.getElementById('menu-toggle');
    const panel = document.getElementById('mobile-menu-panel');
    const backdrop = document.getElementById('mobile-menu-backdrop');
    if (!toggle || !panel || !backdrop) return;

    toggle.addEventListener('click', () => {
        if (panel.classList.contains('open')) {
            closeMobileMenu();
        } else {
            openMobileMenu();
        }
    });

    backdrop.addEventListener('click', closeMobileMenu);

    window.addEventListener('keydown', (e) => {
        if (!panel.classList.contains('open')) return;
        if (e.key === 'Escape') closeMobileMenu();
        else trapFocus(panel, e);
    });
}

function openMobileMenu() {
    const toggle = document.getElementById('menu-toggle');
    const panel = document.getElementById('mobile-menu-panel');
    const backdrop = document.getElementById('mobile-menu-backdrop');
    if (!toggle || !panel || !backdrop) return;
    panel.classList.add('open');
    backdrop.classList.add('open');
    toggle.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
    setScrollLock('mobile-menu', true);
    // Moves keyboard focus into the panel the instant it opens — otherwise a keyboard user
    // who just activated the toggle has no way to know the menu appeared, since focus would
    // otherwise stay on the (now visually relocated) toggle button.
    const firstLink = panel.querySelector('.mobile-menu-link');
    if (firstLink) firstLink.focus();
}

function closeMobileMenu() {
    const toggle = document.getElementById('menu-toggle');
    const panel = document.getElementById('mobile-menu-panel');
    const backdrop = document.getElementById('mobile-menu-backdrop');
    if (!toggle || !panel || !backdrop) return;
    const hadFocusInside = panel.contains(document.activeElement);
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    toggle.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    setScrollLock('mobile-menu', false);
    // Returns focus to the toggle so keyboard users land back where they started instead of
    // on a now-hidden (and unfocusable) element inside the closed panel.
    if (hadFocusInside) toggle.focus();
}

// projects.json is a local, developer-edited file today, but it's still external data
// being injected via innerHTML — escaping here is what keeps a future data source (CMS,
// user-submitted form, etc.) from turning this into a stored-XSS vector.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Tech-pill icons are self-hosted (assets/icons/) instead of fetched from cdn.simpleicons.org,
// so a CDN hiccup can no longer blank out every icon on the page. The onerror handler on the
// <img> itself (see buildProjectCard) is the safety net for any tech name added to
// projects.json later that doesn't have a matching local SVG yet.
const GENERIC_TECH_ICON = 'assets/icons/_generic.svg';
function getTechIconSrc(name) {
    return `assets/icons/${name.toLowerCase()}.svg`;
}

// Escaping neutralizes HTML/attribute syntax but not a `javascript:` URI, so href values
// additionally get scheme-checked — only plain http(s) links are ever rendered as href.
function escapeUrl(url) {
    try {
        const parsed = new URL(url, window.location.href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return escapeHtml(parsed.href);
    } catch {
        return null;
    }
}

// Screen-reader-only status line for the project grid — filtering and pagination both change
// what's on screen with no page navigation and no focus move, so without this a screen-reader
// user gets no signal anything happened at all. Also used by the command palette's
// jumpToProject() to announce where a search jump landed. Clearing the text before setting it
// (rather than setting it directly) is what makes most screen readers re-announce even when
// the new message is identical to the last one — an aria-live region only fires on an actual
// text-content mutation, not on assigning the same string twice in a row.
let projectStatusTimer;
function announceProjectStatus(message) {
    const el = document.getElementById('project-status-announcer');
    if (!el) return;
    el.textContent = '';
    clearTimeout(projectStatusTimer);
    projectStatusTimer = setTimeout(() => { el.textContent = message; }, 60);
}

// Three tiers, one label each — read by both the card and the case-study modal so a project
// can never be badged one thing in the grid and another inside its own case study.
function projectBadgeLabel(project) {
    if (project.flagship) return 'Flagship';
    if (project.spotlight) return 'Spotlight';
    return project.featured ? 'Featured' : '';
}

function buildProjectCard(project) {
    const card = document.createElement('article');
    card.className = 'project-card';
    // Stable hook for the command palette's "jump to this project" action (see
    // jumpToProject) — set as a real element property, not part of the innerHTML template
    // below, so it needs no HTML-escaping.
    card.dataset.projectId = project.id;
    if (project.featured) card.classList.add('project-card-featured');
    // Two projects are the headline work and get a rim treatment in style.css instead of a
    // plain bordered card: `flagship: true` (the deployed, Play-Store-bound one) burns amber,
    // `spotlight: true` (the full-stack one beside it) burns rim-light blue. Both are keyed
    // off the data, not grid position, so they stay correct under any filter/sort.
    // .project-card-major carries the mechanism the two share (rim, glow, mobile layout);
    // .tier-* carries only that tier's colours, as custom properties — which is also what the
    // case-study modal wears, so a project is the same colour wherever it appears.
    if (project.flagship) card.classList.add('tier-flagship');
    if (project.spotlight) card.classList.add('tier-spotlight');
    if (project.flagship || project.spotlight) card.classList.add('project-card-major');

    const techHTML = project.tech.map(t => {
        const safeName = escapeHtml(t.name);
        const safeType = escapeHtml(t.type);
        const iconSrc = getTechIconSrc(t.name);
        return `
        <span class="tech-pill tech-${safeType}">
            <img src="${escapeHtml(iconSrc)}" alt="${safeName}" class="tech-icon" loading="lazy"
                 onerror="this.onerror=null;this.src='${GENERIC_TECH_ICON}';" />
            <span>${safeName}</span>
        </span>
    `;
    }).join('');

    const safeLiveUrl = project.liveUrl ? escapeUrl(project.liveUrl) : null;
    const safeSourceUrl = project.sourceUrl ? escapeUrl(project.sourceUrl) : null;
    const liveBtn = safeLiveUrl
        ? `<a href="${safeLiveUrl}" target="_blank" rel="noopener" class="project-btn">Live <span class="btn-circle"></span></a>`
        : '';
    const sourceBtn = safeSourceUrl
        ? `<a href="${safeSourceUrl}" target="_blank" rel="noopener" class="project-btn project-btn-outline">Source <span class="btn-circle"></span></a>`
        : '';
    // Only projects carrying a `caseStudy` object in projects.json get this button; it's the
    // marquee action, so it renders first and takes the forge-amber fill (see style.css).
    // Clicks are handled by an event-delegated listener in setupCaseStudyModal().
    const caseStudyBtn = project.caseStudy
        ? `<button type="button" class="project-btn project-btn-casestudy" data-casestudy-id="${escapeHtml(project.id)}">Case Study <span class="btn-circle"></span></button>`
        : '';
    const badgeLabel = projectBadgeLabel(project);
    const featuredBadge = project.featured ? `<span class="featured-badge">${badgeLabel}</span>` : '';

    // The two headline cards open with their case study's one-line hook before the paragraph.
    // It is the same sentence the case-study modal leads with — not a second thing to write and
    // keep in sync — and it exists to break what is otherwise a single unbroken block of prose:
    // on a phone that block is the whole card, and a card that is only a wall of text reads as
    // one long stretched column however well it is written.
    const lead = (project.flagship || project.spotlight) && project.caseStudy && project.caseStudy.tagline
        ? `<p class="project-lead">${escapeHtml(project.caseStudy.tagline)}</p>`
        : '';

    // Glare layer for the pointer-tracked tilt (see setupCardTilt). Sits behind the card's
    // text via z-index (the card is an `isolation: isolate` stacking context), stays fully
    // transparent until hovered, and is inert for reduced-motion / touch users.
    card.innerHTML = `
        <span class="project-card__glare" aria-hidden="true"></span>
        ${featuredBadge}
        <h3 class="project-title">${escapeHtml(project.title)}</h3>
        ${lead}
        <p class="project-desc">${escapeHtml(project.description)}</p>
        <div class="project-tech">${techHTML}</div>
        <div class="project-actions">${caseStudyBtn}${liveBtn}${sourceBtn}</div>
    `;
    return card;
}

// Cards fade/slide in independently as they scroll into view — decoupled from the hero's
// scroll-jack math on purpose: it's cheaper, and it means the grid works perfectly even if
// someone lands on #work directly via a bookmark or the nav link.
function observeProjectCards(scope) {
    const cards = (scope || document).querySelectorAll('.project-card:not(.in-view)');
    const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('in-view');
                io.unobserve(entry.target);
            }
        });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
    cards.forEach(card => io.observe(card));
}

const OTHER_PAGE_SIZE = 6;
let showingAllOthers = false;

function updateShowMoreControl(otherCount) {
    const wrapper = document.getElementById('show-more-wrapper');
    const label = document.getElementById('show-more-label');
    if (!wrapper || !label) return;
    wrapper.style.display = otherCount > OTHER_PAGE_SIZE ? 'flex' : 'none';
    label.textContent = showingAllOthers ? 'Show Less' : 'Show More';
}

function toggleSectionVisibility(sectionEl, hasContent) {
    if (sectionEl) sectionEl.style.display = hasContent ? '' : 'none';
}

// The grid is split into "Featured Work" (always fully shown) and "Other Projects"
// (paginated — only the first OTHER_PAGE_SIZE render until "Show More" is clicked) so a
// recruiter sees the strongest work first instead of scrolling past 30 cards.
// On the initial paint, cards reveal via IntersectionObserver as the user scrolls to them.
// On a filter change (animateGrid: true) both grids fade as one unit instead — the cards
// are already in the viewport, so a per-card scroll observer would be pointless.
function renderProjectCards(filter = activeProjectFilter, { animateGrid = false } = {}) {
    const featuredGrid = document.getElementById('featured-project-grid');
    const otherGrid = document.getElementById('other-project-grid');
    const featuredSection = document.getElementById('featured-section');
    const otherSection = document.getElementById('other-section');
    const emptyState = document.getElementById('project-empty-state');
    if (!featuredGrid || !otherGrid) return;

    const paint = () => {
        const filtered = getVisibleProjects(filter);
        const featuredList = filtered.filter(p => p.featured);
        const otherList = filtered.filter(p => !p.featured);
        const visibleOther = showingAllOthers ? otherList : otherList.slice(0, OTHER_PAGE_SIZE);

        featuredGrid.innerHTML = '';
        otherGrid.innerHTML = '';
        featuredList.forEach(project => featuredGrid.appendChild(buildProjectCard(project)));
        visibleOther.forEach(project => otherGrid.appendChild(buildProjectCard(project)));

        toggleSectionVisibility(featuredSection, featuredList.length > 0);
        toggleSectionVisibility(otherSection, otherList.length > 0);
        if (emptyState) emptyState.style.display = filtered.length === 0 ? 'flex' : 'none';
        updateShowMoreControl(otherList.length);

        if (animateGrid) {
            [...featuredGrid.children, ...otherGrid.children].forEach(c => c.classList.add('in-view'));
            requestAnimationFrame(() => {
                featuredGrid.classList.remove('is-filtering');
                otherGrid.classList.remove('is-filtering');
            });
        } else {
            observeProjectCards(featuredGrid);
            observeProjectCards(otherGrid);
        }
        bindMagneticButtons();   // Live / Source / Case Study buttons on the new cards
    };

    if (animateGrid) {
        featuredGrid.classList.add('is-filtering');
        otherGrid.classList.add('is-filtering');
        setTimeout(paint, 300);
    } else {
        paint();
    }
}

// Expands/collapses the "Other Projects" grid in place — only the delta cards are
// added or removed, so the already-visible first page never flashes or re-animates.
function setupShowMoreButton() {
    const btn = document.getElementById('show-more-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
        const otherGrid = document.getElementById('other-project-grid');
        if (!otherGrid) return;

        const filtered = getVisibleProjects(activeProjectFilter);
        const otherList = filtered.filter(p => !p.featured);
        showingAllOthers = !showingAllOthers;

        if (showingAllOthers) {
            const toAdd = otherList.slice(otherGrid.children.length);
            const newCards = toAdd.map(project => {
                const card = buildProjectCard(project);
                otherGrid.appendChild(card);
                return card;
            });
            requestAnimationFrame(() => requestAnimationFrame(() => {
                newCards.forEach(card => card.classList.add('in-view'));
            }));
            bindMagneticButtons();
        } else {
            const toRemove = [...otherGrid.children].slice(OTHER_PAGE_SIZE);
            toRemove.forEach(card => card.classList.remove('in-view'));
            setTimeout(() => toRemove.forEach(card => card.remove()), 300);
        }

        updateShowMoreControl(otherList.length);
        announceProjectStatus(showingAllOthers
            ? `Showing all ${otherList.length} other projects.`
            : `Showing ${Math.min(OTHER_PAGE_SIZE, otherList.length)} of ${otherList.length} other projects.`);
    });
}

// Filter buttons are generated from whatever "language" tech tags actually exist in
// PROJECTS — adding a project with a new language automatically adds its filter button.
function setupProjectFilters() {
    const bar = document.getElementById('project-filter-bar');
    if (!bar) return;

    const seen = new Map();
    PROJECTS.forEach(p => {
        p.tech.forEach(t => {
            if (t.type === 'language' && !seen.has(t.name)) {
                seen.set(t.name, LANGUAGE_LABELS[t.name] || t.name);
            }
        });
    });

    const options = [['all', 'All'], ...seen.entries()];
    bar.innerHTML = '';
    options.forEach(([value, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'filter-btn' + (value === 'all' ? ' active' : '');
        btn.dataset.filter = value;
        btn.textContent = label;
        // .active already carries the visual state; aria-pressed carries the same state to
        // assistive tech — these are toggle buttons (a filter stays "on" until another is
        // chosen), which is exactly what aria-pressed exists for.
        btn.setAttribute('aria-pressed', value === 'all' ? 'true' : 'false');
        btn.addEventListener('click', () => {
            if (value === activeProjectFilter) return;
            activeProjectFilter = value;
            showingAllOthers = false; // start collapsed again for the new filter's results
            bar.querySelectorAll('.filter-btn').forEach(b => {
                const isActive = b === btn;
                b.classList.toggle('active', isActive);
                b.setAttribute('aria-pressed', String(isActive));
            });
            renderProjectCards(activeProjectFilter, { animateGrid: true });

            const count = getVisibleProjects(activeProjectFilter).length;
            const noun = count === 1 ? 'project' : 'projects';
            const scope = value === 'all' ? '' : `${label} `;
            announceProjectStatus(count > 0
                ? `Showing ${count} ${scope}${noun}.`
                : `No ${scope}${noun} found. Try a different filter.`);
        });
        bar.appendChild(btn);
    });
}

// Contact modal — opens on .contact-btn click instead of navigating away, and submits
// via the same FormSubmit endpoint/credentials the old portfolio used.
function setupContactModal() {
    const overlay = document.getElementById('contact-modal-overlay');
    const openBtn = document.getElementById('contact-btn');
    const closeBtn = document.getElementById('contact-modal-close');
    const form = document.getElementById('contact-form');
    const statusBox = document.getElementById('form-status');
    const submitBtn = form ? form.querySelector('.contact-submit-btn') : null;
    const btnText = submitBtn ? submitBtn.querySelector('span') : null;

    if (!overlay || !openBtn || !form) return;

    const emailInput = document.getElementById('sender-email');

    const openModal = () => {
        overlay.classList.add('open');
        setScrollLock('contact-modal', true);
        // Same reasoning as the mobile menu: move focus in on open so keyboard/screen-reader
        // users land directly on the form instead of an overlay they can't otherwise perceive.
        if (emailInput) emailInput.focus();
    };
    const closeModal = () => {
        overlay.classList.remove('open');
        setScrollLock('contact-modal', false);
        // Returns focus to whatever opened the modal (always openBtn today), rather than
        // leaving it on a control that's now hidden behind the closed overlay.
        openBtn.focus();
    };

    openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeMobileMenu();
        openModal();
    });
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
    window.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('open')) return;
        if (e.key === 'Escape') closeModal();
        else trapFocus(overlay.querySelector('.contact-modal'), e);
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();

        const originalText = btnText ? btnText.innerText : '';
        if (btnText) btnText.innerText = 'Sending...';
        if (submitBtn) { submitBtn.style.opacity = '0.7'; submitBtn.style.pointerEvents = 'none'; }
        statusBox.classList.remove('show');

        const formData = new FormData(form);

        fetch(form.action, {
            method: 'POST',
            body: formData,
            headers: { 'Accept': 'application/json' }
        })
            .then(response => response.json())
            .then(() => {
                statusBox.textContent = 'Message sent. I will get back to you soon.';
                statusBox.className = 'form-status-message success';
                requestAnimationFrame(() => statusBox.classList.add('show'));

                form.reset();
                if (btnText) btnText.innerText = originalText;
                if (submitBtn) { submitBtn.style.opacity = '1'; submitBtn.style.pointerEvents = 'auto'; }

                setTimeout(() => {
                    statusBox.classList.remove('show');
                    setTimeout(() => { statusBox.className = 'form-status-message'; }, 400);
                }, 5000);
            })
            .catch(() => {
                statusBox.textContent = 'Something went wrong. Please try again or email me directly.';
                statusBox.className = 'form-status-message error';
                requestAnimationFrame(() => statusBox.classList.add('show'));

                if (btnText) btnText.innerText = originalText;
                if (submitBtn) { submitBtn.style.opacity = '1'; submitBtn.style.pointerEvents = 'auto'; }
            });
    });
}

// ---- Case study modal ----
// A few projects carry a `caseStudy` object in projects.json (tagline / problem /
// architecture / decisions). Their cards get a "Case Study" button; clicking it opens
// this modal, populated from that data. Same overlay mechanics as the contact modal —
// shared .modal-overlay / .contact-modal styles, the scrollLocks Set, trapFocus(),
// Escape to close, and focus returned to the button that opened it.
let caseStudyLastTrigger = null;

// ---- Headline architecture diagram ----
// A pure-SVG, self-drawing flow diagram for the two headline projects (see the
// `flagship || spotlight` check in renderCaseStudy below), built directly from each project's
// own `architecture` array in projects.json — no separate diagram data file to keep in sync
// with the case study text.
// Every node is DIAGRAM_NODE_H tall and every connector exactly DIAGRAM_GAP long, which is
// what lets style.css express per-step stagger and the pulse dot's travel distance without any
// inline style="" attribute (see the CSP comment on .cs-diagram there for why that matters on
// this page specifically). See setupArchitectureDiagram() below for the scroll-triggered draw.
//
// Nodes are the step name only — SVG <text> has no wrapping, so a longer body line would just
// run past the card edge. The full detail for each step is in the <ol class="cs-arch"> right
// below; the diagram's job is to show the sequence, not restate the prose. The viewBox is kept
// narrow (DIAGRAM_NODE_X*2 + DIAGRAM_NODE_W) so it scales down less on a phone.
const DIAGRAM_NODE_X = 30;
const DIAGRAM_NODE_W = 300;
const DIAGRAM_NODE_H = 52;
const DIAGRAM_GAP = 46;   // must match the translateY distance in the cs-diagram-pulse keyframe in style.css
const DIAGRAM_PAD = 16;
const DIAGRAM_TITLE_MAX = 32;   // hard cap so an unusually long future step name still can't overflow the card

function truncateAtWord(str, max) {
    if (str.length <= max) return str;
    const cut = str.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`;
}

function buildArchitectureDiagram(steps) {
    if (!Array.isArray(steps) || steps.length < 2) return ''; // nothing to connect
    const n = steps.length;
    const vbW = DIAGRAM_NODE_X * 2 + DIAGRAM_NODE_W;
    const vbH = DIAGRAM_PAD * 2 + n * DIAGRAM_NODE_H + (n - 1) * DIAGRAM_GAP;
    const midX = DIAGRAM_NODE_X + DIAGRAM_NODE_W / 2;

    const links = steps.slice(1).map((_, i) => {
        const y1 = DIAGRAM_PAD + i * (DIAGRAM_NODE_H + DIAGRAM_GAP) + DIAGRAM_NODE_H;
        const y2 = y1 + DIAGRAM_GAP;
        return `
        <g class="cs-diagram__link">
            <path d="M ${midX} ${y1} L ${midX} ${y2}" class="cs-diagram__path"
                  stroke="url(#cs-diagram-gradient)" filter="url(#cs-diagram-glow)"
                  stroke-dasharray="${DIAGRAM_GAP}" stroke-dashoffset="${DIAGRAM_GAP}"></path>
            <circle cx="${midX}" cy="${y1}" r="3.5" class="cs-diagram__pulse" filter="url(#cs-diagram-glow)"></circle>
        </g>`;
    }).join('');

    const nodes = steps.map((s, i) => {
        const y = DIAGRAM_PAD + i * (DIAGRAM_NODE_H + DIAGRAM_GAP);
        const cy = y + DIAGRAM_NODE_H / 2;
        const title = escapeHtml(truncateAtWord(s.step || '', DIAGRAM_TITLE_MAX));
        return `
        <g class="cs-diagram__node">
            <rect x="${DIAGRAM_NODE_X}" y="${y}" width="${DIAGRAM_NODE_W}" height="${DIAGRAM_NODE_H}" rx="14" class="cs-diagram__card"></rect>
            <circle cx="${DIAGRAM_NODE_X + 24}" cy="${cy}" r="13" fill="url(#cs-diagram-badge)"></circle>
            <text x="${DIAGRAM_NODE_X + 24}" y="${cy}" class="cs-diagram__num" text-anchor="middle" dominant-baseline="central">${i + 1}</text>
            <text x="${DIAGRAM_NODE_X + 46}" y="${cy}" class="cs-diagram__title" dominant-baseline="central">${title}</text>
        </g>`;
    }).join('');

    // aria-hidden: the <ol class="cs-arch"> rendered right after this carries the same step
    // names plus their full detail text, so the diagram is a visual restatement rather than an
    // additional source of information a screen reader needs to visit separately.
    return `
    <div class="cs-diagram" id="cs-diagram" aria-hidden="true">
        <svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMidYMin meet" role="presentation" focusable="false">
            <defs>
                <linearGradient id="cs-diagram-gradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#ffb347"></stop>
                    <stop offset="100%" stop-color="#78beff"></stop>
                </linearGradient>
                <linearGradient id="cs-diagram-badge" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#ffe4b8"></stop>
                    <stop offset="100%" stop-color="#ffb347"></stop>
                </linearGradient>
                <filter id="cs-diagram-glow" x="-60%" y="-60%" width="220%" height="220%">
                    <feGaussianBlur stdDeviation="2.1" result="b"></feGaussianBlur>
                    <feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge>
                </filter>
            </defs>
            <g class="cs-diagram__links">${links}</g>
            <g class="cs-diagram__nodes">${nodes}</g>
        </svg>
    </div>`;
}

// Draws the diagram the moment it scrolls into view inside the case-study modal's own scroll
// container (root: scrollRoot) — not the viewport, since the modal is the thing that scrolls.
// Reduced motion (OS preference or the command palette's explicit override, both folded into
// the live `reducedMotion` flag) skips straight to the fully-drawn end state instead.
function setupArchitectureDiagram(scrollRoot) {
    const diagram = scrollRoot.querySelector('.cs-diagram');
    if (!diagram) return;

    if (reducedMotion) { diagram.classList.add('is-drawn'); return; }

    const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                diagram.classList.add('is-drawing');
                io.unobserve(entry.target);
            }
        });
    }, { root: scrollRoot, threshold: 0.3 });
    io.observe(diagram);
}

function renderCaseStudy(project) {
    const cs = project.caseStudy || {};
    const badgeLabel = projectBadgeLabel(project);
    const badge = badgeLabel ? `<span class="featured-badge">${escapeHtml(badgeLabel)}</span>` : '';

    const problemParas = (Array.isArray(cs.problem) ? cs.problem : [cs.problem])
        .filter(Boolean)
        .map(p => `<p class="cs-para">${escapeHtml(p)}</p>`)
        .join('');

    const archItems = (cs.architecture || [])
        .map(a => `
            <li class="cs-arch-item">
                <span class="cs-arch-title">${escapeHtml(a.step)}</span>
                <span class="cs-arch-detail">${escapeHtml(a.detail)}</span>
            </li>`)
        .join('');

    const decisions = (cs.decisions || [])
        .map(d => `
            <div class="cs-decision">
                <p class="cs-decision-choice">${escapeHtml(d.choice)}</p>
                <p class="cs-decision-rationale">${escapeHtml(d.rationale)}</p>
                ${d.tradeoff ? `<p class="cs-decision-tradeoff"><span>Trade-off</span> ${escapeHtml(d.tradeoff)}</p>` : ''}
            </div>`)
        .join('');

    const safeLiveUrl = project.liveUrl ? escapeUrl(project.liveUrl) : null;
    const safeSourceUrl = project.sourceUrl ? escapeUrl(project.sourceUrl) : null;
    const liveBtn = safeLiveUrl
        ? `<a href="${safeLiveUrl}" target="_blank" rel="noopener" class="project-btn">Live <span class="btn-circle"></span></a>`
        : '';
    const sourceBtn = safeSourceUrl
        ? `<a href="${safeSourceUrl}" target="_blank" rel="noopener" class="project-btn project-btn-outline">Source <span class="btn-circle"></span></a>`
        : '';

    return `
        ${badge}
        <h3 class="modal-title" id="case-study-modal-title">${escapeHtml(project.title)}</h3>
        ${cs.tagline ? `<p class="cs-tagline">${escapeHtml(cs.tagline)}</p>` : ''}
        ${problemParas ? `<div class="cs-block"><h4 class="cs-eyebrow">The problem</h4>${problemParas}</div>` : ''}
        ${archItems ? `<div class="cs-block"><h4 class="cs-eyebrow">Architecture</h4>${project.flagship || project.spotlight ? buildArchitectureDiagram(cs.architecture) : ''}<ol class="cs-arch">${archItems}</ol></div>` : ''}
        ${decisions ? `<div class="cs-block"><h4 class="cs-eyebrow">Key decisions</h4>${decisions}</div>` : ''}
        ${cs.status ? `<p class="cs-status">${escapeHtml(cs.status)}</p>` : ''}
        <div class="project-actions cs-actions">${liveBtn}${sourceBtn}</div>
    `;
}

function setupCaseStudyModal() {
    const overlay = document.getElementById('case-study-modal-overlay');
    if (!overlay) return;
    const modalEl = overlay.querySelector('.case-study-modal');
    const body = document.getElementById('case-study-body');
    const closeBtn = document.getElementById('case-study-modal-close');
    if (!modalEl || !body || !closeBtn) return;

    const closeCaseStudy = () => {
        overlay.classList.remove('open');
        setScrollLock('case-study', false);
        if (caseStudyLastTrigger && document.contains(caseStudyLastTrigger)) {
            caseStudyLastTrigger.focus();
        }
        caseStudyLastTrigger = null;
    };

    const openCaseStudy = (project, trigger) => {
        caseStudyLastTrigger = trigger || null;
        // Same tier class the card carries — the palette rides in on inherited custom properties
        // (see .tier-flagship / .tier-spotlight in style.css), so nothing here names a colour.
        // Toggled rather than added, since one modal element is reused for every project.
        body.classList.toggle('tier-flagship', !!project.flagship);
        body.classList.toggle('tier-spotlight', !!project.spotlight);
        body.innerHTML = renderCaseStudy(project);
        bindMagneticButtons();   // Live / Source buttons inside the freshly built body
        setupArchitectureDiagram(body);   // no-op unless this project has one (see renderCaseStudy)
        body.scrollTop = 0;
        overlay.classList.add('open');
        setScrollLock('case-study', true);
        // Deferred a frame: the overlay only just flipped from visibility:hidden to visible,
        // and an element inside a still-hidden ancestor can't take focus in every engine.
        requestAnimationFrame(() => closeBtn.focus());
    };

    // Delegated: the grids re-render on every filter change, so a listener bound to each
    // button would need re-attaching each time. PROJECTS is read at click time, by which
    // point loadProjects() has resolved.
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('[data-casestudy-id]');
        if (!trigger) return;
        e.preventDefault();
        const project = PROJECTS.find(p => p.id === trigger.dataset.casestudyId);
        if (project && project.caseStudy) openCaseStudy(project, trigger);
    });

    closeBtn.addEventListener('click', closeCaseStudy);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCaseStudy(); });
    window.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('open')) return;
        if (e.key === 'Escape') closeCaseStudy();
        else trapFocus(modalEl, e);
    });
}

// ============================================================
// Fast path — "Skip 3D"  +  hero-visibility gate
// ============================================================
// The button only smooth-scrolls to the work grid — nothing is torn down, so scrolling back
// up to the hero always works. Performance instead comes from a single IntersectionObserver
// on the hero's scroll-spacer: while the hero region is off-screen the rAF loop is paused
// (renderer + WebGL context stay alive) and the button fades away; both come back the moment
// the hero re-enters the viewport.

function revealAllProjectCards() {
    document.querySelectorAll('.project-card:not(.in-view)')
        .forEach(card => card.classList.add('in-view'));
}

function pauseLoop() {
    if (!renderLoopActive) return;
    renderLoopActive = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function resumeLoop() {
    if (renderLoopActive) return;
    // An explicit "Turn motion off" (motionOverrideActive) has to win over the hero-visibility
    // observer: without this guard, scrolling back up to the hero would silently restart the
    // WebGL loop the visitor just asked us to stop. The OS-level preference is deliberately not
    // checked here — that path is allowed to resume on scroll-up (see setMotionOverride).
    if (motionOverrideActive) return;
    renderLoopActive = true;
    // Consume the paused gap so the first resumed frame's delta isn't a multi-second spike
    // (which would fling the spark sim and jump the model's animation clip).
    timer.update();
    rafId = requestAnimationFrame(animate);
}

// The command palette's "Toggle Motion" command. Distinct from the passive OS-level
// prefersReducedMotion check: that default deliberately leaves the hero's WebGL loop free to
// resume if a visitor scrolls back up to it later (see setupHeroVisibilityGate's own comment),
// while this is an explicit, immediate request — flipping it pauses/resumes the loop right
// now, and everything CSS-driven follows via the html.motion-off class (see the big mirrored
// rule block near the end of style.css).
function setMotionOverride(reduceMotion) {
    motionOverrideActive = reduceMotion;
    reducedMotion = prefersReducedMotion || motionOverrideActive;
    document.documentElement.classList.toggle('motion-off', motionOverrideActive);
    try {
        localStorage.setItem(MOTION_OVERRIDE_KEY, motionOverrideActive ? 'reduced' : 'full');
    } catch {
        // Storage blocked — the toggle still works for the rest of this page view.
    }

    if (motionOverrideActive) {
        pauseLoop();
        // Pausing the loop freezes the fixed hero canvas in place, which turns the tall
        // hero-scroll-spacer into ~8 screens of dead, unchanging space between the visitor and
        // the work grid — it reads as "the page froze". If they're still up in that region,
        // land them at the work grid instead (instant, no focus steal), mirroring what the
        // OS-level reduced-motion path already does in setupFastPath(). Nothing is torn down:
        // scrolling back up still works, and turning motion on resumes the loop as before.
        const spacer = document.querySelector('.hero-scroll-spacer');
        const rect = spacer && spacer.getBoundingClientRect();
        const inHeroZone = rect && rect.bottom > 0 && rect.top < window.innerHeight;
        if (inHeroZone) document.getElementById('work')?.scrollIntoView({ block: 'start' });
        // The scroll-in observer that adds .in-view to cards won't fire meaningfully on a
        // now-static page, so reveal them all up front (same as the load-time reducedMotion path).
        revealAllProjectCards();
    } else if (!prefersReducedMotion) {
        // Only restart the WebGL loop if the hero is actually the thing on screen right now —
        // resuming unconditionally would leave it rendering forever under a visitor scrolled
        // deep into the project grid, since setupHeroVisibilityGate's observer only fires on
        // the next intersection *change*, not while already (and still) out of view. The
        // !prefersReducedMotion guard means turning this override off never fights the OS-level
        // accessibility preference for the loop specifically, even though it does relax the
        // CSS-driven motion — flipping a page-local control shouldn't override what the
        // visitor told their whole system they want.
        const spacer = document.querySelector('.hero-scroll-spacer');
        const rect = spacer && spacer.getBoundingClientRect();
        if (rect && rect.bottom > 0 && rect.top < window.innerHeight) resumeLoop();
    }
}

function skipToWork() {
    const work = document.getElementById('work');
    if (!work) return;
    work.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    // Move focus into the grid for keyboard users, without a second scroll jump.
    work.focus({ preventScroll: true });
}

function setupFastPath() {
    const btn = document.getElementById('fast-path-btn');
    if (!btn) return;

    btn.addEventListener('click', skipToWork);
    // Fades in a beat after load so it never competes with first paint. Plain timer, not rAF
    // — a throttled/backgrounded tab would otherwise never reveal it.
    setTimeout(() => btn.classList.add('is-ready'), reducedMotion ? 0 : 700);

    if (reducedMotion) {
        // OS asked for reduced motion: skip the scroll-jacked cinematic intro by landing at
        // the work grid (instant, and no focus steal on load). Everything stays mounted — the
        // observer below pauses the loop while we're down here, and scrolling back up to the
        // hero restores it.
        document.getElementById('work')?.scrollIntoView({ block: 'start' });
    }
}

// Pauses/resumes the render loop and shows/hides the fast-path button based on whether the
// hero's scroll region is anywhere in the viewport. The spacer spans exactly the hero's
// scroll footprint, so "spacer not intersecting" == "fully scrolled into the work grid".
function setupHeroVisibilityGate() {
    const spacer = document.querySelector('.hero-scroll-spacer');
    const btn = document.getElementById('fast-path-btn');
    if (!spacer) return;

    const io = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) {
            resumeLoop();
            if (btn) btn.classList.remove('is-hidden');
        } else {
            pauseLoop();
            if (btn) btn.classList.add('is-hidden');
        }
    }, { rootMargin: '150px 0px 0px 0px' });   // resume/reveal slightly before the hero is back

    io.observe(spacer);
}

// ============================================================
// Subtle pointer interactions — magnetic buttons + card tilt
// ============================================================
// Both are fine-pointer + motion-allowed only. They drive CSS custom properties rather than
// writing `transform` directly, so the stylesheet keeps ownership of the hover scale and the
// scroll-in entrance and nothing has to be re-derived here.

const finePointer = window.matchMedia('(pointer: fine)').matches;
const interactionsAllowed = finePointer && !prefersReducedMotion;

const MAGNET_SELECTOR = '.contact-btn, .project-btn, .filter-btn, .fast-path-btn, .modal-close';
const MAGNET_MAX_PULL = 6;   // px — deliberately small; a nudge toward the cursor, not a throw

function bindMagnet(el) {
    if (!interactionsAllowed || el.dataset.magnetBound) return;
    el.dataset.magnetBound = '1';

    el.addEventListener('pointermove', (e) => {
        if (reducedMotion) return;
        const r = el.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        el.style.setProperty('--magnet-x', `${(dx * MAGNET_MAX_PULL).toFixed(2)}px`);
        el.style.setProperty('--magnet-y', `${(dy * MAGNET_MAX_PULL).toFixed(2)}px`);
    });
    const release = () => {
        el.style.setProperty('--magnet-x', '0px');
        el.style.setProperty('--magnet-y', '0px');
    };
    el.addEventListener('pointerleave', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('blur', release);
}

// Idempotent — safe to call after every grid / modal re-render to pick up new buttons.
function bindMagneticButtons() {
    if (!interactionsAllowed) return;
    document.querySelectorAll(MAGNET_SELECTOR).forEach(bindMagnet);
}

function setupCardTilt() {
    if (!interactionsAllowed) return;
    const MAX_TILT = 4;   // degrees

    const grids = ['featured-project-grid', 'other-project-grid']
        .map(id => document.getElementById(id))
        .filter(Boolean);

    let frame = 0;
    let pending = null;   // { card, px, py }

    const apply = () => {
        frame = 0;
        if (!pending) return;
        const { card, px, py } = pending;
        card.style.setProperty('--tilt-x', `${(-(py - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
        card.style.setProperty('--tilt-y', `${((px - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
        card.style.setProperty('--glare-x', `${(px * 100).toFixed(1)}%`);
        card.style.setProperty('--glare-y', `${(py * 100).toFixed(1)}%`);
        pending = null;
    };

    const reset = (card) => {
        card.style.setProperty('--tilt-x', '0deg');
        card.style.setProperty('--tilt-y', '0deg');
        card.classList.remove('is-tilting');
    };

    grids.forEach(grid => {
        grid.addEventListener('pointermove', (e) => {
            if (reducedMotion) return;
            const card = e.target.closest('.project-card');
            if (!card || !grid.contains(card)) return;
            const r = card.getBoundingClientRect();
            card.classList.add('is-tilting');
            pending = {
                card,
                px: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
                py: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
            };
            if (!frame) frame = requestAnimationFrame(apply);
        });
        grid.addEventListener('pointerout', (e) => {
            const card = e.target.closest('.project-card');
            if (card && !card.contains(e.relatedTarget)) reset(card);
        });
    });
}

// ============================================================
// Command palette — Cmd/Ctrl+K
// ============================================================
// A lightweight, dependency-free command palette: the same overlay/focus-trap/scroll-lock/
// Escape-to-close mechanics as the contact and case-study modals (see trapFocus, scrollLocks),
// laid out as a top-anchored spotlight instead of a centered dialog. Results mix static
// commands — jump to a section, email me, toggle motion, open GitHub/LinkedIn — with every
// project in PROJECTS, filtered live as the visitor types. Selection moves via
// aria-activedescendant on the input rather than real DOM focus — the standard "editable
// combobox with a listbox popup" ARIA pattern — so a screen reader announces the highlighted
// result without ever leaving the text field.

// Finds a project's card, resetting the active filter and expanding "Other Projects" first if
// that's the only reason it isn't currently rendered. Mirrors the exact filter/pagination
// state buildProjectCard's grid already tracks, rather than searching the DOM for a card that
// may simply not exist yet.
function jumpToProject(project) {
    const findCard = () => document.querySelector(`.project-card[data-project-id="${CSS.escape(project.id)}"]`);

    const reveal = () => {
        const card = findCard();
        if (!card) return; // shouldn't happen once the filter/pagination state below is resolved
        // Instant, not smooth: this is a command-palette "jump to result", where landing
        // immediately with the highlight pulse to orient the eye is the convention. An animated
        // scroll past the entire hero spacer would be disorienting here anyway, and
        // behavior:'smooth' is an outright no-op in some webviews.
        card.scrollIntoView({ behavior: 'auto', block: 'center' });
        card.classList.add('cmdk-jump-highlight');
        setTimeout(() => card.classList.remove('cmdk-jump-highlight'), 1600);
        announceProjectStatus(`Jumped to ${project.title}.`);
    };

    let needsRerender = false;

    if (activeProjectFilter !== 'all' && !project.tech.some(t => t.type === 'language' && t.name === activeProjectFilter)) {
        activeProjectFilter = 'all';
        document.querySelectorAll('.filter-btn').forEach(b => {
            const isAll = b.dataset.filter === 'all';
            b.classList.toggle('active', isAll);
            b.setAttribute('aria-pressed', String(isAll));
        });
        needsRerender = true;
    }
    if (!project.featured && !showingAllOthers) {
        showingAllOthers = true;
        needsRerender = true;
    }

    if (needsRerender) {
        renderProjectCards(activeProjectFilter, { animateGrid: true });
        updateShowMoreControl(getVisibleProjects(activeProjectFilter).filter(p => !p.featured).length);
        setTimeout(reveal, 340); // outlast renderProjectCards' own 300ms filter-fade timeout
    } else {
        reveal();
    }
}

const CMDK_MAX_RESULTS = 8;
let cmdkVisibleItems = [];   // the flat, currently-rendered command objects, in DOM order
let cmdkSelectedIndex = 0;
let cmdkStatusTimer;

// Rebuilt fresh on every open/keystroke rather than cached once, so labels that depend on
// live state (the motion toggle's own current on/off wording) are never stale.
function buildStaticCommands() {
    return [
        { id: 'nav-about', group: 'Navigate', title: 'About', sub: 'The intro', keywords: 'about intro home hero', run: () => jumpToFraction(0) },
        { id: 'nav-backend', group: 'Navigate', title: 'Backend & APIs', sub: 'FastAPI, Django', keywords: 'backend api fastapi django server', run: () => jumpToFraction(0.34) },
        { id: 'nav-frontend', group: 'Navigate', title: 'Frontend', sub: 'JavaScript, no framework', keywords: 'frontend js javascript ui', run: () => jumpToFraction(0.62) },
        { id: 'nav-connect', group: 'Navigate', title: 'Connect', sub: 'Open to work', keywords: 'connect open to work hire', run: () => jumpToFraction(0.80) },
        { id: 'nav-work', group: 'Navigate', title: 'Selected Work', sub: 'The project grid', keywords: 'work projects portfolio grid selected', run: () => jumpToFraction(1.05) },
        { id: 'action-email', group: 'Actions', title: 'Email me', sub: 'Open the contact form', keywords: 'email contact mail reach hire message', run: () => document.getElementById('contact-btn')?.click() },
        {
            id: 'action-motion', group: 'Actions',
            title: motionOverrideActive ? 'Turn motion on' : 'Turn motion off',
            sub: prefersReducedMotion
                ? 'Your system already requests reduced motion'
                : (motionOverrideActive ? 'Re-enable the 3D scene and animation' : 'Pause the 3D scene and reduce animation'),
            keywords: 'motion animation reduce accessibility a11y pause 3d scene still',
            run: () => setMotionOverride(!motionOverrideActive)
        },
        { id: 'action-github', group: 'Elsewhere', title: 'GitHub', sub: 'github.com/AndrewTechTips', keywords: 'github source code repo repository', run: () => window.open('https://github.com/AndrewTechTips', '_blank', 'noopener') },
        { id: 'action-linkedin', group: 'Elsewhere', title: 'LinkedIn', sub: 'Andrei Condrea', keywords: 'linkedin resume cv profile', run: () => window.open('https://linkedin.com/in/andrei-condrea-b32148346', '_blank', 'noopener') }
    ];
}

function buildProjectCommands() {
    return sortProjects(PROJECTS).map(p => ({
        id: `project-${p.id}`,
        group: 'Projects',
        title: p.title,
        sub: p.tech.map(t => t.name).join(' · '),
        keywords: `${p.title} ${p.description} ${p.tech.map(t => t.name).join(' ')}`.toLowerCase(),
        run: () => jumpToProject(p)
    }));
}

function filterCommands(query) {
    const staticCommands = buildStaticCommands();
    const projectCommands = buildProjectCommands();
    const q = query.trim().toLowerCase();

    if (!q) {
        // Empty palette: every static command, plus a handful of projects (flagship/featured
        // first, via sortProjects) so it reads as useful rather than just a settings menu.
        return [...staticCommands, ...projectCommands.slice(0, 5)];
    }
    return [...staticCommands, ...projectCommands]
        .filter(c => c.keywords.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
        .slice(0, CMDK_MAX_RESULTS);
}

function announceCmdkStatus(count) {
    const status = document.getElementById('cmdk-status');
    if (!status) return;
    clearTimeout(cmdkStatusTimer);
    // Debounced separately from the (instant) visual render — announcing on every keystroke
    // while someone is mid-word would just be noise for a screen-reader user.
    cmdkStatusTimer = setTimeout(() => {
        status.textContent = count === 0 ? 'No results.' : `${count} result${count === 1 ? '' : 's'}.`;
    }, 400);
}

function renderCmdkResults(items) {
    const list = document.getElementById('cmdk-list');
    const empty = document.getElementById('cmdk-empty');
    const input = document.getElementById('cmdk-input');
    if (!list) return;

    cmdkVisibleItems = items;
    cmdkSelectedIndex = 0;
    announceCmdkStatus(items.length);

    if (items.length === 0) {
        list.innerHTML = '';
        if (empty) empty.hidden = false;
        input?.removeAttribute('aria-activedescendant');
        return;
    }
    if (empty) empty.hidden = true;

    let lastGroup = null;
    list.innerHTML = items.map((item, i) => {
        const groupHeader = item.group !== lastGroup
            ? `<li class="cmdk-group-label" role="presentation">${escapeHtml(item.group)}</li>`
            : '';
        lastGroup = item.group;
        return `${groupHeader}
        <li class="cmdk-item" role="option" id="cmdk-item-${i}" aria-selected="${i === 0 ? 'true' : 'false'}" data-cmdk-index="${i}">
            <span class="cmdk-item-main">
                <span class="cmdk-item-title">${escapeHtml(item.title)}</span>
                <span class="cmdk-item-sub">${escapeHtml(item.sub || '')}</span>
            </span>
        </li>`;
    }).join('');

    input?.setAttribute('aria-activedescendant', 'cmdk-item-0');
}

function setCmdkSelection(index) {
    if (!cmdkVisibleItems.length) return;
    cmdkSelectedIndex = Math.max(0, Math.min(cmdkVisibleItems.length - 1, index));
    const list = document.getElementById('cmdk-list');
    const input = document.getElementById('cmdk-input');
    if (!list) return;
    list.querySelectorAll('.cmdk-item').forEach(el => {
        const isSelected = Number(el.dataset.cmdkIndex) === cmdkSelectedIndex;
        el.setAttribute('aria-selected', String(isSelected));
        if (isSelected) {
            input?.setAttribute('aria-activedescendant', el.id);
            el.scrollIntoView({ block: 'nearest' });
        }
    });
}

function runCmdkItem(index) {
    const item = cmdkVisibleItems[index];
    if (!item) return;
    closeCmdk();
    // A task's grace so the palette's own close transition isn't fighting the action's own
    // scroll/focus change (opening the contact modal, jumping to a project card) in the same
    // paint. setTimeout, not requestAnimationFrame — an rAF callback can be parked
    // indefinitely in a backgrounded/throttled tab, which would drop the command entirely.
    setTimeout(() => item.run(), 0);
}

let cmdkLastTrigger = null;

function openCmdk(sourceEl) {
    const overlay = document.getElementById('cmdk-overlay');
    const input = document.getElementById('cmdk-input');
    if (!overlay || !input) return;
    cmdkLastTrigger = sourceEl || document.activeElement;
    closeMobileMenu();
    overlay.classList.add('open');
    setScrollLock('cmdk', true);
    input.value = '';
    renderCmdkResults(filterCommands(''));
    // Focus the search field. The overlay just flipped visibility:hidden -> visible via the
    // .open class; reading offsetHeight forces the style/layout flush that makes it count as
    // visible (and therefore focusable) right now, so focus lands synchronously while opening
    // via a button click — before that click's own focus settles on the button. The
    // setTimeout is a fallback for any engine that still won't take it in this task.
    void overlay.offsetHeight;
    input.focus();
    setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 0);
}

function closeCmdk() {
    const overlay = document.getElementById('cmdk-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    setScrollLock('cmdk', false);
    if (cmdkLastTrigger && document.contains(cmdkLastTrigger) && typeof cmdkLastTrigger.focus === 'function') {
        cmdkLastTrigger.focus();
    }
    cmdkLastTrigger = null;
}

function setupCommandPalette() {
    const overlay = document.getElementById('cmdk-overlay');
    const panel = overlay?.querySelector('.cmdk-panel');
    const input = document.getElementById('cmdk-input');
    const list = document.getElementById('cmdk-list');
    const trigger = document.getElementById('cmdk-trigger');
    const mobileTrigger = document.getElementById('mobile-menu-cmdk');
    if (!overlay || !panel || !input || !list) return;

    // The header trigger's kbd hint reads "Ctrl" everywhere except macOS/iOS/iPadOS, where the
    // actual key is ⌘. navigator.platform is deprecated but still the simplest reliable signal
    // for this; userAgentData isn't available in every engine yet, and this is cosmetic only —
    // the shortcut listener below matches metaKey OR ctrlKey regardless of what the label says.
    const isApplePlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
    const keyLabel = document.getElementById('cmdk-trigger-key');
    if (keyLabel && isApplePlatform) keyLabel.textContent = '⌘';

    trigger?.addEventListener('click', () => openCmdk(trigger));
    mobileTrigger?.addEventListener('click', () => openCmdk(mobileTrigger));

    document.getElementById('cmdk-dismiss')?.addEventListener('click', closeCmdk);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCmdk(); });

    input.addEventListener('input', () => renderCmdkResults(filterCommands(input.value)));

    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setCmdkSelection(cmdkSelectedIndex + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdkSelection(cmdkSelectedIndex - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); runCmdkItem(cmdkSelectedIndex); }
    });

    list.addEventListener('click', (e) => {
        const row = e.target.closest('.cmdk-item');
        if (row) runCmdkItem(Number(row.dataset.cmdkIndex));
    });
    // pointerover (fires once on entry), not pointermove/mousemove, so hovering a row doesn't
    // re-run the selection update on every pixel of pointer travel.
    list.addEventListener('pointerover', (e) => {
        const row = e.target.closest('.cmdk-item');
        if (!row) return;
        const idx = Number(row.dataset.cmdkIndex);
        if (idx !== cmdkSelectedIndex) setCmdkSelection(idx);
    });

    window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            if (overlay.classList.contains('open')) closeCmdk(); else openCmdk();
            return;
        }
        if (!overlay.classList.contains('open')) return;
        if (e.key === 'Escape') closeCmdk();
        else trapFocus(panel, e);
    });
}

// ============================================================
// Console greeting
// ============================================================
// Lives in this module rather than a separate inline <script> — the page's CSP has no
// 'unsafe-inline' for script-src, so an inline block would just be silently dropped; this file
// is already the one script the CSP allow-lists by origin ('self').
function printConsoleGreeting() {
    const headline = 'font-size: 14px; font-weight: 600; color: #ffb347;';
    const body = 'font-size: 12px; color: #d1d5db; line-height: 1.6;';
    const mono = 'font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; color: #78beff;';

    console.log('%cHi — you found the source.', headline);
    console.log(
        '%cNo framework, no build step: vanilla ES modules, one hand-written GLSL shader, and a ' +
        'strict Content-Security-Policy with no unsafe-inline anywhere. If that\'s your kind of ' +
        'engineering, I\'d like to talk.',
        body
    );
    console.log('%cGitHub  https://github.com/AndrewTechTips\nEmail   condrea.andrey777@gmail.com', mono);
    console.log('%cPS — press ⌘K / Ctrl+K for a command palette.', body);
}

window.addEventListener('DOMContentLoaded', async () => {
    printConsoleGreeting();
    onWindowResize(); // sets --hero-scroll-vh before anything reads it
    splitTitlesIntoChars();
    initScene();       // renderer + tone mapping, lighting, createSparks(), loadModel()
    animate();
    // A stored "motion off" override (see the top of this file) should hold from the very
    // first frame, not just once the hero scrolls out of view — animate() above always starts
    // the loop, so if the override was already active on load, immediately undo that.
    if (motionOverrideActive) pauseLoop();
    setupNavigation();
    setupMobileMenu();
    setupContactModal();
    setupCaseStudyModal();
    setupCommandPalette();   // wires the Cmd/Ctrl+K shortcut immediately; project results
                              // populate themselves once loadProjects() resolves below
    setupFastPath();
    setupHeroVisibilityGate();   // pauses the loop + hides the button once past the hero
    bindMagneticButtons();
    setupCardTilt();
    setupGithubStats();   // paints instantly from cache/seed, then refreshes live in the background

    await loadProjects(); // fetch projects.json — see PROJECTS above
    setupProjectFilters();
    setupShowMoreButton();
    renderProjectCards('all');
    bindMagneticButtons();                       // pick up the freshly rendered project buttons
    if (reducedMotion) revealAllProjectCards();  // no scroll observer payoff on a static page
});
