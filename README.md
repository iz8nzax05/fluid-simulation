# WebGL Fluid Simulation

Real-time 3D fluid simulation running entirely in the browser using WebGL. Based on the FLIP/PIC (Fluid-Implicit-Particle) method — the same technique used in professional VFX production (Pixar, Disney).

---

## What it does

- Real-time 3D incompressible fluid simulation on the GPU
- Draw fluid containers (boxes) then watch fluid pour, splash, and swirl
- Multiple color presets: Cyan, Magma, Ocean, Fire, Rainbow, and more
- Interactive controls: gravity direction, particle density, visual effects
- Runs entirely in the browser — no install needed

## Running it

```bash
# Serve locally (required for shader file loading)
python -m http.server 8000
# then open http://localhost:8000
```

Or use the included `start-server.bat` on Windows.

---

## How it works

### Simulation — FLIP/PIC hybrid
The fluid is simulated using a FLIP/PIC (Fluid-Implicit-Particle / Particle-in-Cell) hybrid method:
- Particles carry velocity; a MAC (Marker-And-Cell) staggered grid solves pressure
- `flipness = 0.99` — 99% FLIP (preserves detail) + 1% PIC (stability)
- Pressure solved via Jacobi iteration on the GPU (divergence → jacobi → subtract)
- All physics run in fragment shaders — the entire simulation lives on the GPU

### Rendering — Deferred pipeline
```
Particles → renderingTexture (normals, speed, depth)
         → occlusionTexture (ambient occlusion)
         → depthTexture (shadow map from light POV)
         → compositingTexture (all passes + effects)
         → FXAA → screen
```

### Shader files (40+)
Key shaders in `/shaders`:
- `transfertogrid.frag` — particle velocities → grid (PIC step)
- `divergence.frag` — velocity divergence for pressure solver
- `jacobi.frag` — iterative pressure solve (Poisson equation)
- `advect.frag` — particle advection via 2nd-order Runge-Kutta
- `transfertoparticles.frag` — grid velocities back to particles (FLIP/PIC blend)
- `composite.frag` — final compositing with shadows, color ramps, post-processing
- `fxaa.frag` — Fast Approximate Anti-Aliasing
- `sphereao.frag` — sphere rendering with ambient occlusion

---

## What I added / changed

This project is built on top of [David Li's FLIP fluid demo](http://david.li) (MIT License, 2016). The original was ~4,600 lines — a working but minimal proof-of-concept with basic controls.

My additions (~1,900 lines added, files nearly doubled in size):

- **Color system** — 14 color presets (Cyan, Magma, Ocean, Fire, Rainbow with multi-stop ramp, Color Maker, etc.) with full UI controls
- **Camera system** — Rewrote `camera.js` from 138 → 300 lines with smoother controls and configurable FOV
- **Renderer expansion** — Added deferred rendering pipeline documentation, shadow map tuning, post-processing parameter controls
- **fluidparticles.js rewrite** — Expanded from 377 → 1,409 lines: full state machine (EDITING/SIMULATING), async initialization order, UI event handlers, presets system, comprehensive inline documentation explaining every architectural decision
- **5 new shaders** — billboard rendering (`billboard2d.frag/vert`, `billboard2dao.vert`, `billboard2ddepth.vert`), gbuffer view (`gbuffer_view.frag`)
- **Addons system** — `/addons` folder with extended functionality
- **11 documentation files** — Full code documentation in `/code_documentation` covering initialization order, rendering loop, critical code paths, bottleneck analysis, troubleshooting guide

---

## Attribution

Original FLIP fluid simulation by **David Li** — http://david.li
MIT License © 2016 David Li
See [LICENSE](LICENSE) for full terms.
