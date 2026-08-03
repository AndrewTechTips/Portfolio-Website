import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const canvas = document.querySelector('#webgl');
let scene, camera, renderer;
let gltfModel;     // the statue
let modelPivot;    // pivot group for perfect center-rotation
let mixer;
const clock = new THREE.Clock();
let currentScroll = 0;    // smoothed hero progress, clamped 0..1
let revealProgress = 0;   // smoothed Phase-2 blend, 0 (pure hero) .. 1 (fully settled/blurred)

let mouseX = 0, mouseY = 0, targetMouseX = 0, targetMouseY = 0;

let cursorX = window.innerWidth / 2,  cursorY = window.innerHeight / 2;
let outerCursorX = window.innerWidth / 2, outerCursorY = window.innerHeight / 2;

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
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2.2;

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
    requestAnimationFrame(animate);
    const deltaTime = clock.getDelta();
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

    // outer cursor ring lerps toward inner
    outerCursorX += (cursorX - outerCursorX) * 0.2;
    outerCursorY += (cursorY - outerCursorY) * 0.2;
    const cursorOuter = document.querySelector('.cursor-outer');
    if (cursorOuter) { cursorOuter.style.left = `${outerCursorX}px`; cursorOuter.style.top = `${outerCursorY}px`; }

    // gentle interactive model tilt from mouse, damped out as Phase 2 settles in
    if (modelPivot) {
        const tiltDamp = 1 - revealProgress;
        modelPivot.rotation.y = mouseX * 0.25 * tiltDamp;
        modelPivot.rotation.x = mouseY * 0.15 * tiltDamp;
    }

    // 2. sparks physics — always running on real elapsed time, never frozen
    if (sparkParticles) {
        const positions = sparkParticles.geometry.attributes.position.array;
        const time = clock.getElapsedTime();
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
        shaderUniforms.uTime.value = clock.getElapsedTime();
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
function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link[data-target-fraction]');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const fraction = parseFloat(link.dataset.targetFraction);
            const targetY = heroScrollLength * fraction;

            // revealProgress normally lerps toward its target over a second or two, tracking
            // the ACTUAL scroll position frame by frame as the user scrolls by hand. A nav
            // click instead teleports the scroll position, so left alone, reveal would still
            // be lerping from wherever it USED to be — landing on "Connect" (inside slide 4's
            // own window, but also inside the blur/tint transition zone) used to show a
            // partially blurred, half-legible slide instead of a clean one; landing on "Work"
            // showed slide 4's fading text hovering over the now-visible project cards. Both
            // are the same root cause: reveal desynced from where the destination actually is.
            // Snapping it straight to the value the destination fraction implies fixes every
            // nav link at once, in both directions, rather than special-casing one target.
            // "Work" (fraction >= 1) is hardcoded to fully revealed rather than run through the
            // formula — it lands inside the project section's own normal-flow content, past
            // TRANSITION_END, and tying its correctness to it exactly matching TRANSITION_END
            // would silently break the very next time these constants get tuned.
            revealProgress = fraction >= 1
                ? 1
                : Math.min(1, Math.max(0, (fraction - TRANSITION_START) / (TRANSITION_END - TRANSITION_START)));

            // "Work" additionally jumps past the hero-scroll-spacer into the project section's
            // own content, so the camera/orbit state should already be fully settled there too
            // — not still gliding in from wherever it was when clicked.
            if (fraction >= 1) {
                currentScroll = 1;
            }

            window.scrollTo({ top: targetY, behavior: 'smooth' });
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

function buildProjectCard(project) {
    const card = document.createElement('article');
    card.className = 'project-card';
    if (project.featured) card.classList.add('project-card-featured');

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
    const featuredBadge = project.featured ? `<span class="featured-badge">Featured</span>` : '';

    card.innerHTML = `
        ${featuredBadge}
        <h3 class="project-title">${escapeHtml(project.title)}</h3>
        <p class="project-desc">${escapeHtml(project.description)}</p>
        <div class="project-tech">${techHTML}</div>
        <div class="project-actions">${liveBtn}${sourceBtn}</div>
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
        } else {
            const toRemove = [...otherGrid.children].slice(OTHER_PAGE_SIZE);
            toRemove.forEach(card => card.classList.remove('in-view'));
            setTimeout(() => toRemove.forEach(card => card.remove()), 300);
        }

        updateShowMoreControl(otherList.length);
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
        btn.addEventListener('click', () => {
            if (value === activeProjectFilter) return;
            activeProjectFilter = value;
            showingAllOthers = false; // start collapsed again for the new filter's results
            bar.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
            renderProjectCards(activeProjectFilter, { animateGrid: true });
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

window.addEventListener('DOMContentLoaded', async () => {
    onWindowResize(); // sets --hero-scroll-vh before anything reads it
    splitTitlesIntoChars();
    initScene();       // renderer + tone mapping, lighting, createSparks(), loadModel()
    animate();
    setupNavigation();
    setupMobileMenu();
    setupContactModal();

    await loadProjects(); // fetch projects.json — see PROJECTS above
    setupProjectFilters();
    setupShowMoreButton();
    renderProjectCards('all');
});
