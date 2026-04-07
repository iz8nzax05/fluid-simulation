'use strict'

/**
 * FluidParticles - Main application controller
 * 
 * RESPONSIBILITIES:
 * 1. Manages application state (EDITING vs SIMULATING)
 * 2. Coordinates all components (BoxEditor, SimulatorRenderer, UI)
 * 3. Handles initialization order (async shader loading)
 * 4. Manages UI updates and event handlers
 * 5. Runs animation loop
 * 
 * CRITICAL INITIALIZATION ORDER:
 * 1. Create WebGL context (WrappedGL)
 * 2. Create BoxEditor (loads shaders async)
 * 3. Create SimulatorRenderer (loads shaders async)
 * 4. Wait for BOTH to finish loading
 * 5. Call start() to set up UI and event handlers
 * 6. Start animation loop
 * 
 * WHY ASYNC: Shader files must be loaded from disk. Can't proceed until shaders ready.
 */
var FluidParticles = (function () {
    // WHY Math.PI/3 (60°): Standard FOV for 3D games. Wider = see more but distortion.
    // Narrower = less distortion but tunnel vision. 60° is good balance.
    var FOV = Math.PI / 3;

    /**
     * APPLICATION STATES:
     * 
     * EDITING: User is placing/editing boxes (fluid containers)
     * - BoxEditor is active (can draw boxes, resize, translate)
     * - SimulatorRenderer is NOT running (no physics, no rendering)
     * - UI shows editing controls (room size, presets)
     * 
     * SIMULATING: Fluid simulation is running
     * - SimulatorRenderer is active (physics + rendering)
     * - BoxEditor is inactive (can't edit boxes)
     * - UI shows simulation controls (gravity, effects, etc.)
     * 
     * WHY TWO STATES: Can't edit boxes while simulation running (would break physics).
     * Must stop simulation to edit, then restart.
     */
    var State = {
        EDITING: 0,
        SIMULATING: 1
    };

    // WHY 10: Default particle density (particles per simulation grid cell).
    // Higher = more particles = smoother fluid but slower.
    // Lower = fewer particles = faster but choppier.
    var PARTICLES_PER_CELL = 10;

    // ============================================================================
    // SECTION 1: CONSTANTS & CONFIGURATION
    // ============================================================================

    // Box presets for initial fluid container setups
    var PRESETS = [
        //dam break
        [
            new BoxEditor.AABB([0, 0, 0], [15, 20, 20]) 
        ],

        //block drop
        [
            new BoxEditor.AABB([0, 0, 0], [40, 7, 20]),
            new BoxEditor.AABB([12, 12, 5], [28, 20, 15]) 
        ],

        //double splash
        [
            new BoxEditor.AABB([0, 0, 0], [10, 20, 15]),
            new BoxEditor.AABB([30, 0, 5], [40, 20, 20]) 
        ],

    ];

    // ============================================================================
    // SECTION 2: CONSTRUCTOR & INITIALIZATION
    // ============================================================================
    // NOTE: Constructor sets up WebGL, camera, and creates BoxEditor/SimulatorRenderer.
    // The start() function (nested in constructor) is called when both systems finish loading.

    function FluidParticles () {
        // CRITICAL INITIALIZATION ORDER (DO NOT CHANGE):
        // 1. Canvas must exist (created by HTML)
        // 2. WebGL context must be created before anything else
        // 3. Camera/projection need grid dimensions
        // 4. BoxEditor and SimulatorRenderer need WebGL context

        var canvas = this.canvas = document.getElementById('canvas');
        var wgl = this.wgl = new WrappedGL(canvas);

        // WHY expose globally: Debugging - can inspect WebGL state in console
        window.wgl = wgl;

        // WHY these defaults: 40x20x20 = good starting size for demo.
        // Not too small (hard to see), not too large (slow).
        // User can change via room size sliders.
        this.gridWidth = 40;
        this.gridHeight = 20;
        this.gridDepth = 20;

        // WHY 0.1 to 600.0: Near/far clipping planes. 0.1 = very close, 600 = very far.
        // Grid is typically 40 units, so 600 covers it with room to spare.
        this.projectionMatrix = Utilities.makePerspectiveMatrix(new Float32Array(16), FOV, this.canvas.width / this.canvas.height, 0.1, 600.0);
        
        // WHY center at gridWidth/2, height/3, depth/2: Camera looks at center of grid,
        // slightly above (height/3) for better viewing angle.
        this.camera = new Camera(this.canvas, [this.gridWidth / 2, this.gridHeight / 3, this.gridDepth / 2]);
        this.backgroundBrightness = 1.0;

        // WHY DOUBLE-CHECK PATTERN: Both systems load asynchronously. We don't know which
        // will finish first. The double-check ensures start() only runs once when BOTH are ready.
        // If we only checked in one callback, start() might never run if that callback fires second.
        var boxEditorLoaded = false,
            simulatorRendererLoaded = false;

        // WHY BoxEditor loads first: It's simpler (fewer shaders), might load faster.
        // Order doesn't matter - both must finish before start() runs.
        this.boxEditor = new BoxEditor.BoxEditor(this.canvas, this.wgl, this.projectionMatrix, this.camera, [this.gridWidth, this.gridHeight, this.gridDepth], (function () {
            boxEditorLoaded = true;
            // CRITICAL: Check BOTH flags. start() only runs when BOTH systems ready.
            if (boxEditorLoaded && simulatorRendererLoaded) {
                start.call(this);
            }
        }).bind(this),
        (function () {
            // WHY: Redraw UI when boxes change (e.g., user adds/removes box)
            this.redrawUI(); 
        }).bind(this),
        (function () { return this.backgroundBrightness; }).bind(this));

        // WHY SimulatorRenderer loads separately: It has many shaders (13+ programs).
        // Loading is async, so we create it and wait for callback.
        this.simulatorRenderer = new SimulatorRenderer(this.canvas, this.wgl, this.projectionMatrix, this.camera, [this.gridWidth, this.gridHeight, this.gridDepth], (function () {
            simulatorRendererLoaded = true;
            // CRITICAL: Check BOTH flags. start() only runs when BOTH systems ready.
            if (boxEditorLoaded && simulatorRendererLoaded) {
                start.call(this);
            }
        }).bind(this));

        /**
         * start() - Called when BOTH BoxEditor AND SimulatorRenderer finish loading
         * 
         * WHY THIS FUNCTION: Can't set up UI/events until shaders are loaded.
         * If we tried earlier, DOM elements might not exist or shaders might not be ready.
         * 
         * WHAT IT DOES:
         * 1. Sets initial state (EDITING mode)
         * 2. Sets up all UI event handlers (buttons, sliders, toggles)
         * 3. Sets up keyboard/mouse handlers
         * 4. Loads initial preset (dam break)
         * 5. Starts animation loop
         * 
         * CRITICAL: This only runs ONCE when both systems are ready.
         */
        function start(programs) {
            // WHY start in EDITING: User should place boxes before starting simulation.
            // Starting in SIMULATING would show empty scene (no particles yet).
            this.state = State.EDITING;

            // ============================================================================
            // SECTION 7: BUTTON EVENT HANDLERS
            // ============================================================================
            // NOTE: Button handlers are set up in start() function when UI is ready.

            this.startButton = document.getElementById('start-button');
            this.resetButton = document.getElementById('reset-button');

            // WHY check boxes.length: Can't start simulation without fluid containers.
            // Boxes define where particles spawn. No boxes = no particles = nothing to simulate.
            this.startButton.addEventListener('click', (function () {
                if (this.state === State.EDITING) {
                    if (this.boxEditor.boxes.length > 0) {
                        this.startSimulation();
                    }
                    this.redrawUI();
                } else if (this.state === State.SIMULATING) {
                    this.stopSimulation();
                    this.redrawUI();
                }
            }).bind(this));

            if (this.resetButton) {
                this.resetButton.addEventListener('click', (function () {
                    if (this.state === State.SIMULATING) {
                        this.resetSimulation();
                    }
                }).bind(this));
            }

            this.currentPresetIndex = 0;
            this.colorPresetIndex = 0;
            this.editedSinceLastPreset = false; //whether the user has edited the last set preset
            
            // ============================================================================
            // SECTION 7: BUTTON EVENT HANDLERS (continued)
            // ============================================================================
            // Preset button handler
            this.presetButton = document.getElementById('preset-button');
            this.presetButton.addEventListener('click', (function () {
                this.editedSinceLastPreset = false;

                this.boxEditor.boxes.length = 0;

                var preset = PRESETS[this.currentPresetIndex];
                for (var i = 0; i < preset.length; ++i) {
                    this.boxEditor.boxes.push(preset[i].clone());
                }
                this.boxEditor.clampBoxesToGrid();

                this.currentPresetIndex = (this.currentPresetIndex + 1) % PRESETS.length; 

                this.redrawUI();

            }).bind(this));

            // ============================================================================
            // SECTION 5: COLOR PRESETS & COLOR MAKER
            // ============================================================================
            // NOTE: Color preset setup happens in start() function when DOM is ready.

            // color preset bar (simulating only)
            var bar = document.getElementById('color-preset-bar');
            this.colorMakerPresetIndex = -1;
            this.colorMakerTrayOpen = true;
            function rgbToHex(r, g, b) {
                return '#' + [r, g, b].map(function (x) { var h = Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
            }
            function hexToRgb(hex) {
                var n = parseInt(hex.slice(1), 16);
                return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
            }
            // Wait for Renderer.COLOR_PRESETS to be available (set at end of renderer.js module)
            // If not available yet, retry after a short delay
            var self = this;
            function initColorPresets() {
                if (!bar) return;
                if (typeof Renderer === 'undefined' || !Renderer.COLOR_PRESETS) {
                    setTimeout(initColorPresets, 10);
                    return;
                }
                var presets = Renderer.COLOR_PRESETS;
                for (var i = 0; i < presets.length; i++) {
                    if (presets[i].name === 'Color Maker') self.colorMakerPresetIndex = i;
                    var btn = document.createElement('button');
                    btn.className = 'color-preset-btn' + (i === self.colorPresetIndex ? ' active' : '');
                    btn.textContent = presets[i].name;
                    btn.dataset.preset = String(i);
                    (function (idx) {
                        btn.addEventListener('click', function () {
                            self.colorPresetIndex = idx;
                            self.simulatorRenderer.renderer.setColorPreset(idx);
                            var btns = document.querySelectorAll('.color-preset-btn');
                            for (var j = 0; j < btns.length; j++) {
                                btns[j].classList.toggle('active', parseInt(btns[j].dataset.preset, 10) === idx);
                            }
                            var tray = document.getElementById('color-maker-tray');
                            if (tray) {
                                if (idx === self.colorMakerPresetIndex) {
                                    var trayVisible = tray.style.display === 'flex';
                                    if (trayVisible) {
                                        self.colorMakerTrayOpen = false;
                                        tray.style.display = 'none';
                                    } else {
                                        self.colorMakerTrayOpen = true;
                                        tray.style.display = 'flex';
                                        var p = Renderer.COLOR_PRESETS[self.colorMakerPresetIndex];
                                        var lowIn = document.getElementById('color-maker-low');
                                        var highIn = document.getElementById('color-maker-high');
                                        var glowIn = document.getElementById('color-maker-glow');
                                        if (lowIn && p && p.colorLow) lowIn.value = rgbToHex(p.colorLow[0], p.colorLow[1], p.colorLow[2]);
                                        if (highIn && p && p.colorHigh) highIn.value = rgbToHex(p.colorHigh[0], p.colorHigh[1], p.colorHigh[2]);
                                        if (glowIn && p) glowIn.value = String(p.glow !== undefined ? p.glow : 0);
                                    }
                                } else {
                                    tray.style.display = 'none';
                                }
                            }
                        });
                    })(i);
                    if (presets[i].name === 'Color Maker') {
                        var wrapper = document.createElement('div');
                        wrapper.className = 'color-maker-wrapper';
                        wrapper.appendChild(btn);
                        var trayEl = document.getElementById('color-maker-tray');
                        if (trayEl) wrapper.appendChild(trayEl);
                        bar.appendChild(wrapper);
                    } else {
                        bar.appendChild(btn);
                    }
                }
                var lowIn = document.getElementById('color-maker-low');
                var highIn = document.getElementById('color-maker-high');
                var glowIn = document.getElementById('color-maker-glow');
                if (lowIn && highIn) {
                    function syncColorMakerFromInputs() {
                        var low = hexToRgb(lowIn.value);
                        var high = hexToRgb(highIn.value);
                        self.simulatorRenderer.renderer.setColorMakerColors(low, high);
                    }
                    lowIn.addEventListener('input', syncColorMakerFromInputs);
                    highIn.addEventListener('input', syncColorMakerFromInputs);
                }
                if (glowIn) {
                    glowIn.addEventListener('input', (function () {
                        self.simulatorRenderer.renderer.setColorMakerGlow(parseFloat(glowIn.value));
                    }).bind(self));
                }
            }
            initColorPresets();

            // ============================================================================
            // SECTION 4: UI SLIDERS SETUP
            // ============================================================================
            // NOTE: All sliders are set up in start() function. They are grouped here
            // for organization, but initialization code remains in start() for proper timing.

            ////////////////////////////////////////////////////////
            // parameters/sliders

            //using gridCellDensity ensures a linear relationship to particle count
            this.gridCellDensity = 0.5; //simulation grid cell density per world space unit volume
            
            // Custom particle settings
            this.useCustomParticleSettings = false;
            this.customParticleSpacing = 0.5; // Distance between particles in world units
            this.customParticleSize = 1.0; // Particle size multiplier
            this.customParticleRadiusMin = 0.1; // Minimum particle radius
            this.customParticleRadiusMax = 0.3; // Maximum particle radius

            this.timeStep = 1.0 / 60.0;

            this.densitySlider = new Slider(document.getElementById('density-slider'), this.gridCellDensity, 0.2, 6.0, (function (value) {
                this.gridCellDensity = value; 

                this.redrawUI();
            }).bind(this));

            this.roomWidthSlider = new Slider(document.getElementById('room-width-slider'), this.gridWidth, 1, 80, (function (value) {
                this.gridWidth = value;
                this.boxEditor.setGridSize(this.gridWidth, this.gridHeight, this.gridDepth);
                this.camera.setOrbitPoint(this.gridWidth / 2, this.gridHeight / 3, this.gridDepth / 2);
            }).bind(this));
            this.roomHeightSlider = new Slider(document.getElementById('room-height-slider'), this.gridHeight, 1, 80, (function (value) {
                this.gridHeight = value;
                this.boxEditor.setGridSize(this.gridWidth, this.gridHeight, this.gridDepth);
                this.camera.setOrbitPoint(this.gridWidth / 2, this.gridHeight / 3, this.gridDepth / 2);
            }).bind(this));
            this.roomDepthSlider = new Slider(document.getElementById('room-depth-slider'), this.gridDepth, 1, 80, (function (value) {
                this.gridDepth = value;
                this.boxEditor.setGridSize(this.gridWidth, this.gridHeight, this.gridDepth);
                this.camera.setOrbitPoint(this.gridWidth / 2, this.gridHeight / 3, this.gridDepth / 2);
            }).bind(this));

            this.flipnessSlider = new Slider(document.getElementById('fluidity-slider'), this.simulatorRenderer.simulator.flipness, 0, 1.0, (function (value) {
                this.simulatorRenderer.simulator.flipness = value;
                this.redrawUI();
            }).bind(this));

            this.speedSlider = new Slider(document.getElementById('speed-slider'), this.timeStep, 0.0, 1.0 / 60.0, (function (value) {
                this.timeStep = value;
                this.redrawUI();
            }).bind(this));

            this.gravity = 1.0;
            var gravityEl = document.getElementById('gravity-slider');
            this.gravitySlider = gravityEl ? new Slider(gravityEl, this.gravity, -2.0, 2.0, (function (value) {
                this.gravity = value;
                this.simulatorRenderer.simulator.gravity = value;
                this.redrawUI();
            }).bind(this)) : null;
            // WHY this lives HERE (right after gravitySlider is created):
            // We must attach the 0G button handler only after `this.gravitySlider` exists.
            // If we set up the handler earlier (e.g. near other buttons at the top of start()),
            // `this.gravitySlider` would still be null/undefined, the guard
            // `if (gravityZeroBtn && this.gravitySlider ...)` would fail, and NO click handler
            // would be registered—making the 0G button appear "broken" while dragging the
            // gravity slider still works (because its callback is attached during Slider construction).
            //
            // 0G button: set gravity to 0 on room (simulator) and slider
            var gravityZeroBtn = document.getElementById('gravity-zero-btn');
            if (gravityZeroBtn && this.gravitySlider && this.simulatorRenderer) {
                gravityZeroBtn.addEventListener('click', (function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.gravity = 0;
                    this.gravitySlider.value = 0;
                    if (this.simulatorRenderer.simulator) {
                        this.simulatorRenderer.simulator.gravity = 0;
                    }
                    this.gravitySlider.redraw();
                    this.redrawUI();
                }).bind(this));
            }

            // ============================================================================
            // SECTION 6: EFFECT TOGGLES & CHECKBOXES
            // ============================================================================
            // NOTE: Effect toggles are set up in start() function when DOM is ready.

            var r = this.simulatorRenderer.renderer;
            function setupEffect(el, getVal, setVal) {
                if (!el) return;
                el.classList.toggle('checked', getVal());
                function toggle() {
                    setVal(!getVal());
                    el.classList.toggle('checked', getVal());
                }
                el.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    toggle();
                });
                el.addEventListener('keydown', function (e) {
                    if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        toggle();
                    }
                });
                var label = el.parentElement;
                if (label && label.classList && label.classList.contains('effect-option')) {
                    label.addEventListener('click', function (e) {
                        if (e.target === el) return;
                        e.preventDefault();
                        e.stopPropagation();
                        toggle();
                    });
                }
            }
            setupEffect(document.getElementById('sparkle-cb'), function () { return r.sparkle; }, function (v) { r.sparkle = v; });
            var sparkleStrEl = document.getElementById('sparkle-strength-slider');
            this.sparkleStrengthSlider = sparkleStrEl ? new Slider(sparkleStrEl, r.sparkleStrength, 0, 1, (function (v) { r.sparkleStrength = v; }).bind(this)) : null;
            setupEffect(document.getElementById('vignette-cb'), function () { return r.vignette; }, function (v) { r.vignette = v; });
            var vignetteStrEl = document.getElementById('vignette-strength-slider');
            this.vignetteStrengthSlider = vignetteStrEl ? new Slider(vignetteStrEl, r.vignetteStrength, 0, 1, (function (v) { r.vignetteStrength = v; }).bind(this)) : null;
            setupEffect(document.getElementById('bloom-cb'), function () { return r.bloom; }, function (v) { r.bloom = v; });
            var bloomStrEl = document.getElementById('bloom-strength-slider');
            this.bloomStrengthSlider = bloomStrEl ? new Slider(bloomStrEl, r.bloomStrength, 0, 1, (function (v) { r.bloomStrength = v; }).bind(this)) : null;

            this.backgroundSlider = new Slider(document.getElementById('background-slider'), this.backgroundBrightness, 0, 1, (function (value) {
                this.backgroundBrightness = value;
                this.simulatorRenderer.renderer.backgroundBrightness = value;
            }).bind(this));
            
            // Free camera toggle
            var freeCamCb = document.getElementById('free-cam-cb');
            if (freeCamCb) {
                freeCamCb.classList.toggle('checked', this.camera.freeCamMode);
                function toggleFreeCam() {
                    this.camera.freeCamMode = !this.camera.freeCamMode;
                    freeCamCb.classList.toggle('checked', this.camera.freeCamMode);
                }
                freeCamCb.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleFreeCam.call(this);
                }.bind(this));
                freeCamCb.addEventListener('keydown', function (e) {
                    if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        toggleFreeCam.call(this);
                    }
                }.bind(this));
                var freeCamLabel = freeCamCb.parentElement;
                if (freeCamLabel && freeCamLabel.classList && freeCamLabel.classList.contains('effect-option')) {
                    freeCamLabel.addEventListener('click', function (e) {
                        if (e.target === freeCamCb) return;
                        e.preventDefault();
                        e.stopPropagation();
                        toggleFreeCam.call(this);
                    }.bind(this));
                }
            }

            this.redrawUI();


            this.presetButton.click();

            // ============================================================================
            // DEBUG MENU SETUP (part of Section 7: Button Event Handlers)
            // ============================================================================
            ///////////////////////////////////////////////////////
            // debug menu setup
            this.debugMenuVisible = false;
            this.uiVisible = true; // Start with UI visible
            
            // FPS tracking
            this.frameCount = 0;
            this.lastFpsUpdate = 0;
            this.fps = 0;
            this.frameTime = 0;
            this.frameTimeHistory = [];
            
            // Get debug menu elements after DOM is ready
            var self = this;
            // Try immediately first
            this.debugMenu = document.getElementById('debug-menu');
            var debugUiToggleBtn = document.getElementById('debug-ui-toggle-btn');
            var debugCompositeToggleBtn = document.getElementById('debug-composite-toggle-btn');
            var debugOcclusionToggleBtn = document.getElementById('debug-occlusion-toggle-btn');
            var debugShadowToggleBtn = document.getElementById('debug-shadow-toggle-btn');
            var debug2dFacesToggleBtn = document.getElementById('debug-2d-faces-toggle-btn');
            var debugSphereIterationsSlider = document.getElementById('debug-sphere-iterations-slider');
            var debugSphereIterationsValue = document.getElementById('debug-sphere-iterations-value');
            var debugWaterBlendSlider = document.getElementById('debug-water-blend-slider');
            var debugWaterBlendValue = document.getElementById('debug-water-blend-value');
            
            // Ensure debug menu starts hidden
            if (this.debugMenu) {
                this.debugMenu.style.display = 'none';
            }
            
            // Setup function for debug controls
            var setupDebugControls = function() {
                if (debugUiToggleBtn) {
                    debugUiToggleBtn.addEventListener('click', function () {
                        self.toggleUIVisibility();
                    });
                }
                if (debugCompositeToggleBtn) {
                    debugCompositeToggleBtn.addEventListener('click', function () {
                        self.toggleCompositeShader();
                    });
                }
                if (debugOcclusionToggleBtn) {
                    debugOcclusionToggleBtn.addEventListener('click', function () {
                        self.toggleOcclusion();
                    });
                }
                if (debugShadowToggleBtn) {
                    debugShadowToggleBtn.addEventListener('click', function () {
                        self.toggleShadowMap();
                    });
                }
                if (debug2dFacesToggleBtn) {
                    debug2dFacesToggleBtn.addEventListener('click', function () {
                        self.toggle2DFaces();
                    });
                }
                if (debugSphereIterationsSlider && debugSphereIterationsValue) {
                    // Initialize slider value from renderer
                    if (self.simulatorRenderer && self.simulatorRenderer.renderer) {
                        var currentIterations = self.simulatorRenderer.renderer.sphereIterations;
                        // Default to old backup value (3 = 1280 faces) if not set
                        if (currentIterations === undefined || currentIterations === null) {
                            currentIterations = 3;
                            self.simulatorRenderer.renderer.sphereIterations = 3;
                        }
                        var sliderValue = self.iterationsToSliderValue(currentIterations);
                        debugSphereIterationsSlider.value = sliderValue;
                        debugSphereIterationsValue.textContent = self.getSphereComplexityLabel(sliderValue);
                    }
                    debugSphereIterationsSlider.addEventListener('input', function () {
                        var sliderValue = parseInt(this.value);
                        debugSphereIterationsValue.textContent = self.getSphereComplexityLabel(sliderValue);
                        self.setSphereIterations(sliderValue);
                    });
                }
                if (debugWaterBlendSlider && debugWaterBlendValue) {
                    debugWaterBlendSlider.addEventListener('input', function () {
                        var value = parseFloat(this.value);
                        debugWaterBlendValue.textContent = value.toFixed(1);
                        self.setWaterBlendFactor(value);
                    });
                }
            };
            
            // If not found, try again after a short delay (template might not be inserted yet)
            if (!this.debugMenu || !debugUiToggleBtn || !debugCompositeToggleBtn || !debugOcclusionToggleBtn || !debugShadowToggleBtn || !debugSphereIterationsSlider || !debugWaterBlendSlider) {
                setTimeout(function() {
                    self.debugMenu = document.getElementById('debug-menu');
                    debugUiToggleBtn = document.getElementById('debug-ui-toggle-btn');
                    debugCompositeToggleBtn = document.getElementById('debug-composite-toggle-btn');
                    debugOcclusionToggleBtn = document.getElementById('debug-occlusion-toggle-btn');
                    debugShadowToggleBtn = document.getElementById('debug-shadow-toggle-btn');
                    debug2dFacesToggleBtn = document.getElementById('debug-2d-faces-toggle-btn');
                    debugSphereIterationsSlider = document.getElementById('debug-sphere-iterations-slider');
                    debugSphereIterationsValue = document.getElementById('debug-sphere-iterations-value');
                    debugWaterBlendSlider = document.getElementById('debug-water-blend-slider');
                    debugWaterBlendValue = document.getElementById('debug-water-blend-value');
                    // Ensure it's hidden
                    if (self.debugMenu) {
                        self.debugMenu.style.display = 'none';
                    }
                    setupDebugControls();
                }, 500);
            } else {
                // Found immediately, set up the controls
                setupDebugControls();
            }

            ///////////////////////////////////////////////////////
            // Settings menu setup
            var settingsMenuButton = document.getElementById('settings-menu-button');
            var settingsMenuTray = document.getElementById('settings-menu-tray');
            var settingsMouseStrengthSlider = document.getElementById('settings-mouse-strength-slider');
            var settingsMouseStrengthValue = document.getElementById('settings-mouse-strength-value');

            if (settingsMenuButton && settingsMenuTray) {
                settingsMenuButton.addEventListener('click', function() {
                    var isOpen = settingsMenuTray.classList.toggle('open');
                    settingsMenuButton.classList.toggle('active', isOpen);
                });
            }

            if (settingsMouseStrengthSlider && settingsMouseStrengthValue && this.simulatorRenderer && this.simulatorRenderer.simulator) {
                // Set initial value
                settingsMouseStrengthSlider.value = this.simulatorRenderer.simulator.mouseStrength || 3.0;
                settingsMouseStrengthValue.textContent = (this.simulatorRenderer.simulator.mouseStrength || 3.0).toFixed(1);

                settingsMouseStrengthSlider.addEventListener('input', function() {
                    var value = parseFloat(this.value);
                    settingsMouseStrengthValue.textContent = value.toFixed(1);
                    if (self.simulatorRenderer && self.simulatorRenderer.simulator) {
                        self.simulatorRenderer.simulator.mouseStrength = value;
                    }
                });
            }

            var settingsMouseModeSelect = document.getElementById('settings-mouse-mode-select');
            if (settingsMouseModeSelect && this.simulatorRenderer && this.simulatorRenderer.simulator) {
                // Set initial value
                settingsMouseModeSelect.value = (this.simulatorRenderer.simulator.mouseMode || 0).toString();

                settingsMouseModeSelect.addEventListener('change', function() {
                    var value = parseInt(this.value);
                    if (self.simulatorRenderer && self.simulatorRenderer.simulator) {
                        self.simulatorRenderer.simulator.mouseMode = value;
                    }
                });
            }

            // Custom particle settings
            var customParticlesToggle = document.getElementById('settings-custom-particles-toggle');
            var customParticlesPanel = document.getElementById('settings-custom-particles-panel');
            var particleSpacingSlider = document.getElementById('settings-particle-spacing-slider');
            var particleSpacingValue = document.getElementById('settings-particle-spacing-value');
            var particleSizeSlider = document.getElementById('settings-particle-size-slider');
            var particleSizeValue = document.getElementById('settings-particle-size-value');
            var particleRadiusMinSlider = document.getElementById('settings-particle-radius-min-slider');
            var particleRadiusMinValue = document.getElementById('settings-particle-radius-min-value');
            var particleRadiusMaxSlider = document.getElementById('settings-particle-radius-max-slider');
            var particleRadiusMaxValue = document.getElementById('settings-particle-radius-max-value');
            var densitySliderDiv = document.getElementById('density-slider');

            if (customParticlesToggle && customParticlesPanel) {
                customParticlesToggle.checked = this.useCustomParticleSettings || false;
                customParticlesPanel.style.display = this.useCustomParticleSettings ? 'block' : 'none';
                
                customParticlesToggle.addEventListener('change', function() {
                    var enabled = this.checked;
                    self.useCustomParticleSettings = enabled;
                    customParticlesPanel.style.display = enabled ? 'block' : 'none';
                    
                    // Disable/enable density slider
                    if (densitySliderDiv) {
                        densitySliderDiv.style.opacity = enabled ? '0.5' : '1.0';
                        densitySliderDiv.style.pointerEvents = enabled ? 'none' : 'auto';
                    }
                    
                    // Regenerate particles if simulation is running
                    if (self.state === State.SIMULATING) {
                        self._resetSimulatorFromBoxes();
                    }
                });
            }

            if (particleSpacingSlider && particleSpacingValue) {
                particleSpacingSlider.value = this.customParticleSpacing || 0.5;
                particleSpacingValue.textContent = (this.customParticleSpacing || 0.5).toFixed(2);
                particleSpacingSlider.addEventListener('input', function() {
                    var value = parseFloat(this.value);
                    particleSpacingValue.textContent = value.toFixed(2);
                    self.customParticleSpacing = value;
                    if (self.state === State.SIMULATING && self.useCustomParticleSettings) {
                        self._resetSimulatorFromBoxes();
                    }
                });
            }

            if (particleSizeSlider && particleSizeValue) {
                particleSizeSlider.value = this.customParticleSize || 1.0;
                particleSizeValue.textContent = (this.customParticleSize || 1.0).toFixed(1);
                particleSizeSlider.addEventListener('input', function() {
                    var value = parseFloat(this.value);
                    particleSizeValue.textContent = value.toFixed(1);
                    self.customParticleSize = value;
                    if (self.state === State.SIMULATING && self.useCustomParticleSettings) {
                        self._resetSimulatorFromBoxes();
                    }
                });
            }

            if (particleRadiusMinSlider && particleRadiusMinValue) {
                particleRadiusMinSlider.value = this.customParticleRadiusMin || 0.1;
                particleRadiusMinValue.textContent = (this.customParticleRadiusMin || 0.1).toFixed(2);
                particleRadiusMinSlider.addEventListener('input', function() {
                    var value = parseFloat(this.value);
                    particleRadiusMinValue.textContent = value.toFixed(2);
                    self.customParticleRadiusMin = value;
                    // Ensure min <= max
                    if (value > self.customParticleRadiusMax) {
                        self.customParticleRadiusMax = value;
                        if (particleRadiusMaxSlider) particleRadiusMaxSlider.value = value;
                        if (particleRadiusMaxValue) particleRadiusMaxValue.textContent = value.toFixed(2);
                    }
                    if (self.state === State.SIMULATING && self.useCustomParticleSettings) {
                        self._resetSimulatorFromBoxes();
                    }
                });
            }

            if (particleRadiusMaxSlider && particleRadiusMaxValue) {
                particleRadiusMaxSlider.value = this.customParticleRadiusMax || 0.3;
                particleRadiusMaxValue.textContent = (this.customParticleRadiusMax || 0.3).toFixed(2);
                particleRadiusMaxSlider.addEventListener('input', function() {
                    var value = parseFloat(this.value);
                    particleRadiusMaxValue.textContent = value.toFixed(2);
                    self.customParticleRadiusMax = value;
                    // Ensure max >= min
                    if (value < self.customParticleRadiusMin) {
                        self.customParticleRadiusMin = value;
                        if (particleRadiusMinSlider) particleRadiusMinSlider.value = value;
                        if (particleRadiusMinValue) particleRadiusMinValue.textContent = value.toFixed(2);
                    }
                    if (self.state === State.SIMULATING && self.useCustomParticleSettings) {
                        self._resetSimulatorFromBoxes();
                    }
                });
            }

            // Reset button for custom particle settings
            var resetParticlesBtn = document.getElementById('settings-reset-particles-btn');
            if (resetParticlesBtn) {
                resetParticlesBtn.addEventListener('click', function() {
                    // Reset to default values
                    self.customParticleSpacing = 0.5;
                    self.customParticleSize = 1.0;
                    self.customParticleRadiusMin = 0.1;
                    self.customParticleRadiusMax = 0.3;
                    
                    // Update sliders and values
                    if (particleSpacingSlider) {
                        particleSpacingSlider.value = 0.5;
                        if (particleSpacingValue) particleSpacingValue.textContent = '0.50';
                    }
                    if (particleSizeSlider) {
                        particleSizeSlider.value = 1.0;
                        if (particleSizeValue) particleSizeValue.textContent = '1.0';
                    }
                    if (particleRadiusMinSlider) {
                        particleRadiusMinSlider.value = 0.1;
                        if (particleRadiusMinValue) particleRadiusMinValue.textContent = '0.10';
                    }
                    if (particleRadiusMaxSlider) {
                        particleRadiusMaxSlider.value = 0.3;
                        if (particleRadiusMaxValue) particleRadiusMaxValue.textContent = '0.30';
                    }
                    
                    // Regenerate particles if simulation is running
                    if (self.state === State.SIMULATING && self.useCustomParticleSettings) {
                        self._resetSimulatorFromBoxes();
                    }
                });
            }


            // ============================================================================
            // SECTION 8: KEYBOARD & MOUSE EVENT HANDLERS
            // ============================================================================
            // NOTE: Event handlers are attached in start() function. Prototype methods
            // (onMouseMove, onKeyDown, etc.) are defined in Section 8 below.

            ///////////////////////////////////////////////////////
            // interaction state stuff

            canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
            canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
            document.addEventListener('mouseup', this.onMouseUp.bind(this));

            document.addEventListener('keydown', this.onKeyDown.bind(this));
            document.addEventListener('keyup', this.onKeyUp.bind(this));

            window.addEventListener('resize', this.onResize.bind(this));
            this.onResize();

            var self = this;
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    self.redrawUI();
                });
            });
            // Deferred redraw so sliders get correct layout when load/layout is delayed.
            setTimeout(function () { self.redrawUI(); }, 50);

            ////////////////////////////////////////////////////
            // start the update loop

            var lastTime = 0;
            var update = (function (currentTime) {
                var deltaTime = currentTime - lastTime || 0;
                lastTime = currentTime;

                // FPS tracking
                this.frameCount++;
                this.frameTime = deltaTime;
                this.frameTimeHistory.push(deltaTime);
                if (this.frameTimeHistory.length > 60) {
                    this.frameTimeHistory.shift();
                }
                
                if (currentTime - this.lastFpsUpdate >= 1000) {
                    this.fps = this.frameCount;
                    this.frameCount = 0;
                    this.lastFpsUpdate = currentTime;
                }
                
                // Update debug info every frame if visible
                if (this.debugMenuVisible) {
                    this.updateDebugInfo();
                }

                this.camera.update();
                this.update(deltaTime);

                requestAnimationFrame(update);
            }).bind(this);
            update();


        }
    }

    // ============================================================================
    // SECTION 3: STATE MANAGEMENT
    // ============================================================================
    // NOTE: State variables (this.state, this.frozen) are initialized in start() function.
    // State transition methods are defined below.

    // ============================================================================
    // SECTION 8 (continued): KEYBOARD & MOUSE EVENT HANDLERS (prototype methods)
    // ============================================================================

    FluidParticles.prototype.onResize = function (event) {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        Utilities.makePerspectiveMatrix(this.projectionMatrix, FOV, this.canvas.width / this.canvas.height, 0.1, 600.0);

        this.simulatorRenderer.onResize(event);
    }

    FluidParticles.prototype.onMouseMove = function (event) {
        event.preventDefault();

        if (this.state === State.EDITING) {
            this.boxEditor.onMouseMove(event);

            if (this.boxEditor.interactionState !== null) {
                this.editedSinceLastPreset = true;
            }
        } else if (this.state === State.SIMULATING) {
            this.simulatorRenderer.onMouseMove(event);
        }
    };

    FluidParticles.prototype.onMouseDown = function (event) {
        event.preventDefault();

        if (this.state === State.EDITING) {
            this.boxEditor.onMouseDown(event);
        } else if (this.state === State.SIMULATING) {
            this.simulatorRenderer.onMouseDown(event);
        }
    };

    FluidParticles.prototype.onMouseUp = function (event) {
        event.preventDefault();

        if (this.state === State.EDITING) {
            this.boxEditor.onMouseUp(event);
        } else if (this.state === State.SIMULATING) {
            this.simulatorRenderer.onMouseUp(event);
        }
    };

    FluidParticles.prototype.onKeyDown = function (event) {
        // F key to toggle debug menu (keyCode 70)
        var isF = event.keyCode === 70 || 
                  (event.key && event.key.toUpperCase() === 'F') || 
                  (event.code && event.code === 'KeyF');
        
        // U key to toggle UI visibility (keyCode 85)
        var isU = event.keyCode === 85 || 
                  (event.key && event.key.toUpperCase() === 'U') || 
                  (event.code && event.code === 'KeyU');
        
        // R key to reset simulation (keyCode 82)
        var isR = event.keyCode === 82 || 
                  (event.key && event.key.toUpperCase() === 'R') || 
                  (event.code && event.code === 'KeyR');
        
        if (isF) {
            event.preventDefault();
            event.stopPropagation();
            
            // Make sure we have the debug menu element
            if (!this.debugMenu) {
                this.debugMenu = document.getElementById('debug-menu');
            }
            
            if (this.debugMenu) {
                this.debugMenuVisible = !this.debugMenuVisible;
                if (this.debugMenuVisible) {
                    this.debugMenu.style.display = 'block';
                    this.debugMenu.style.visibility = 'visible';
                    this.debugMenu.style.opacity = '1';
                    this.debugMenu.style.position = 'fixed';
                    this.debugMenu.style.top = '50%';
                    this.debugMenu.style.right = '30px';
                    this.debugMenu.style.transform = 'translateY(-50%)';
                    this.debugMenu.style.zIndex = '99999';
                    this.updateDebugInfo();
                } else {
                    this.debugMenu.style.display = 'none';
                }
            }
            return;
        }
        
        if (isU) {
            event.preventDefault();
            event.stopPropagation();
            this.toggleUIVisibility();
            return;
        }
        
        if (isR && this.state === State.SIMULATING) {
            event.preventDefault();
            event.stopPropagation();
            this.resetSimulation();
            return;
        }
        
        if (this.state === State.SIMULATING && event.keyCode === 32) {
            event.preventDefault();
            this.frozen = !this.frozen;
            this.redrawUI();
            return;
        }
        if (this.state === State.EDITING) {
            this.boxEditor.onKeyDown(event);
        }
        // Forward keyboard events to camera for WASD movement
        this.camera.onKeyDown(event);
    };

    FluidParticles.prototype.onKeyUp = function (event) {
        if (this.state === State.EDITING) {
            this.boxEditor.onKeyUp(event);
        }
        // Forward keyboard events to camera for WASD movement
        this.camera.onKeyUp(event);
    };

    // ============================================================================
    // SECTION 9: UI UPDATE METHODS
    // ============================================================================

    FluidParticles.prototype.updateDebugInfo = function () {
        if (!this.debugMenuVisible) return;
        // Make sure we have the debug menu element
        if (!this.debugMenu) {
            this.debugMenu = document.getElementById('debug-menu');
        }
        if (!this.debugMenu) return;
        
        var fpsEl = document.getElementById('debug-fps');
        var frameTimeEl = document.getElementById('debug-frame-time');
        var stateEl = document.getElementById('debug-state');
        var particlesEl = document.getElementById('debug-particles');
        var boxesEl = document.getElementById('debug-boxes');
        var cameraModeEl = document.getElementById('debug-camera-mode');
        var cameraDistanceEl = document.getElementById('debug-camera-distance');
        var cameraPositionEl = document.getElementById('debug-camera-position');
        var canvasSizeEl = document.getElementById('debug-canvas-size');
        
        if (fpsEl) fpsEl.textContent = this.fps;
        if (frameTimeEl) frameTimeEl.textContent = this.frameTime.toFixed(2);
        if (stateEl) stateEl.textContent = this.state === State.EDITING ? 'Editing' : 'Simulating';
        
        var particleCount = 0;
        if (this.state === State.SIMULATING && this.simulatorRenderer && this.simulatorRenderer.simulator) {
            particleCount = this.simulatorRenderer.simulator.particlesWidth * this.simulatorRenderer.simulator.particlesHeight;
        } else {
            particleCount = Math.round(this.getParticleCount());
        }
        if (particlesEl) particlesEl.textContent = particleCount;
        
        if (boxesEl) boxesEl.textContent = this.boxEditor ? this.boxEditor.boxes.length : 0;
        if (cameraModeEl) cameraModeEl.textContent = this.camera.freeCamMode ? 'Free Camera' : 'Orbit';
        if (cameraDistanceEl) cameraDistanceEl.textContent = this.camera.distance.toFixed(2);
        
        var camPos = this.camera.getPosition();
        if (cameraPositionEl) cameraPositionEl.textContent = camPos[0].toFixed(1) + ', ' + camPos[1].toFixed(1) + ', ' + camPos[2].toFixed(1);
        
        if (canvasSizeEl) canvasSizeEl.textContent = this.canvas.width + 'x' + this.canvas.height;
    };

    FluidParticles.prototype.toggleUIVisibility = function () {
        this.uiVisible = !this.uiVisible;
        this.updateUIVisibility();
    };

    FluidParticles.prototype.toggleCompositeShader = function () {
        if (this.simulatorRenderer && this.simulatorRenderer.renderer) {
            this.simulatorRenderer.renderer.compositeEnabled = !this.simulatorRenderer.renderer.compositeEnabled;
        }
    };

    FluidParticles.prototype.toggleOcclusion = function () {
        if (this.simulatorRenderer && this.simulatorRenderer.renderer) {
            this.simulatorRenderer.renderer.occlusionEnabled = !this.simulatorRenderer.renderer.occlusionEnabled;
        }
    };

    FluidParticles.prototype.toggleShadowMap = function () {
        if (this.simulatorRenderer && this.simulatorRenderer.renderer) {
            this.simulatorRenderer.renderer.shadowMapEnabled = !this.simulatorRenderer.renderer.shadowMapEnabled;
        }
    };

    FluidParticles.prototype.toggle2DFaces = function () {
        if (this.simulatorRenderer && this.simulatorRenderer.renderer) {
            this.simulatorRenderer.renderer.use2DFaces = !this.simulatorRenderer.renderer.use2DFaces;
        }
    };

    // ============================================================================
    // SPHERE COMPLEXITY MAPPING FUNCTIONS
    // ============================================================================
    // WHY: Slider uses 0-7 for user-friendly values, but renderer uses internal iteration values.
    // These functions map between slider values and internal iterations.

    /**
     * getSphereComplexityLabel() - Returns human-readable label for slider value
     * @param {number} sliderValue - Slider value (0-7)
     * @returns {string} Label like "8 faces (octahedron)"
     */
    FluidParticles.prototype.getSphereComplexityLabel = function (sliderValue) {
        var labels = [
            "1 face (triangle)",
            "4 faces (tetrahedron)",
            "8 faces (octahedron)",
            "12 faces (cube)",
            "20 faces (icosahedron)",
            "80 faces (ico+1)",
            "320 faces (ico+2)",
            "1280 faces (ico+3)"
        ];
        return labels[Math.max(0, Math.min(7, Math.round(sliderValue)))] || "Unknown";
    };

    /**
     * sliderValueToIterations() - Maps slider value (0-7) to internal iteration value
     * @param {number} sliderValue - Slider value (0-7)
     * @returns {number} Internal iteration value for renderer
     */
    FluidParticles.prototype.sliderValueToIterations = function (sliderValue) {
        // Map slider 0-7 to internal values:
        // 0: -3 (triangle, 1 face)
        // 1: -2 (tetrahedron, 4 faces)
        // 2: -1 (octahedron, 8 faces)
        // 3: -2 (cube, 12 faces) - NOTE: cube uses -2 in old system, but we'll use a new value
        // 4: 0 (icosahedron, 20 faces)
        // 5: 1 (ico+1 subdivision, 80 faces)
        // 6: 2 (ico+2 subdivisions, 320 faces)
        // 7: 3 (ico+3 subdivisions, 1280 faces)
        
        var slider = Math.max(0, Math.min(7, Math.round(sliderValue)));
        if (slider === 0) return -3; // triangle
        if (slider === 1) return -2; // tetrahedron (will need new case in renderer)
        if (slider === 2) return -1; // octahedron
        if (slider === 3) return -4; // cube (will need new case in renderer)
        return slider - 4; // 4->0, 5->1, 6->2, 7->3
    };

    /**
     * iterationsToSliderValue() - Maps internal iteration value to slider value (0-7)
     * @param {number} iterations - Internal iteration value
     * @returns {number} Slider value (0-7)
     */
    FluidParticles.prototype.iterationsToSliderValue = function (iterations) {
        // Reverse mapping
        if (iterations === -3) return 0; // triangle
        if (iterations === -2) return 1; // tetrahedron
        if (iterations === -1) return 2; // octahedron
        if (iterations === -4) return 3; // cube
        if (iterations >= 0 && iterations <= 3) return iterations + 4; // 0->4, 1->5, 2->6, 3->7
        // Fallback: clamp to valid range
        return Math.max(0, Math.min(7, iterations + 4));
    };

    FluidParticles.prototype.setSphereIterations = function (sliderValue) {
        if (this.simulatorRenderer && this.simulatorRenderer.renderer) {
            var iterations = this.sliderValueToIterations(sliderValue);
            this.simulatorRenderer.renderer.sphereIterations = iterations;
            this.simulatorRenderer.renderer.regenerateSphereGeometry();
        }
    };

    FluidParticles.prototype.setWaterBlendFactor = function (factor) {
        if (this.simulatorRenderer && this.simulatorRenderer.renderer) {
            this.simulatorRenderer.renderer.waterBlendFactor = Math.max(0, Math.min(5.0, parseFloat(factor)));
        }
    };

    FluidParticles.prototype.updateUIVisibility = function () {
        var ui = document.getElementById('ui');
        var instructions = document.querySelectorAll('.instructions');
        var colorPresetBar = document.getElementById('color-preset-bar');
        var colorMakerTray = document.getElementById('color-maker-tray');
        
        if (ui) ui.style.display = this.uiVisible ? 'block' : 'none';
        for (var i = 0; i < instructions.length; i++) {
            instructions[i].style.display = this.uiVisible ? 'block' : 'none';
        }
        if (colorPresetBar) colorPresetBar.style.display = this.uiVisible ? 'flex' : 'none';
        if (colorMakerTray) colorMakerTray.style.display = this.uiVisible ? 'block' : 'none';
    };

    //the UI elements are all created in the constructor, this just updates the DOM elements
    //should be called every time state changes
    FluidParticles.prototype.redrawUI = function () {

        var simulatingElements = document.querySelectorAll('.simulating-ui');
        var editingElements = document.querySelectorAll('.editing-ui');


        if (this.state === State.SIMULATING) {
            for (var i = 0; i < simulatingElements.length; ++i) {
                simulatingElements[i].style.display = 'block';
            }

            for (var i = 0; i < editingElements.length; ++i) {
                editingElements[i].style.display = 'none';
            }

            document.getElementById('ui').style.top = '50px';
            document.getElementById('fluidity-value').innerHTML = this.simulatorRenderer.simulator.flipness.toFixed(2);
            var sv = document.getElementById('speed-value');
            if (sv) sv.innerHTML = Math.round((this.timeStep / (1 / 60)) * 100) + '%';
            var gv = document.getElementById('gravity-value');
            if (gv) gv.innerHTML = this.gravity === 0 ? '0 G' : this.gravity.toFixed(1) + '×';
            var sp = document.getElementById('sim-paused');
            if (sp) {
                sp.textContent = this.frozen ? 'Paused — Space to start' : '';
                sp.style.display = this.frozen ? 'block' : 'none';
            }
            var presetBtns = document.querySelectorAll('.color-preset-btn');
            for (var i = 0; i < presetBtns.length; i++) {
                presetBtns[i].classList.toggle('active', parseInt(presetBtns[i].dataset.preset, 10) === this.colorPresetIndex);
            }
            var tray = document.getElementById('color-maker-tray');
            if (tray) tray.style.display = (this.colorPresetIndex === this.colorMakerPresetIndex && this.colorMakerTrayOpen) ? 'flex' : 'none';

            this.startButton.textContent = 'Edit';
            this.startButton.className = 'start-button-active';
        } else if (this.state === State.EDITING) {
            for (var i = 0; i < simulatingElements.length; ++i) {
                simulatingElements[i].style.display = 'none';
            }

            for (var i = 0; i < editingElements.length; ++i) {
                editingElements[i].style.display = 'block';
            }

            document.getElementById('ui').style.top = '30px';

            document.getElementById('particle-count').innerHTML = Math.round(this.getParticleCount()).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' particles';
            document.getElementById('room-size').innerHTML = Math.round(this.gridWidth) + ' × ' + Math.round(this.gridHeight) + ' × ' + Math.round(this.gridDepth);

            if (this.boxEditor.boxes.length >= 2 ||
                this.boxEditor.boxes.length === 1 && (this.boxEditor.interactionState === null || this.boxEditor.interactionState.mode !== BoxEditor.InteractionMode.EXTRUDING && this.boxEditor.interactionState.mode !== BoxEditor.InteractionMode.DRAWING)) { 
                this.startButton.className = 'start-button-active';
            } else {
                this.startButton.className = 'start-button-inactive';
            }

            this.startButton.textContent = 'Start';

            if (this.editedSinceLastPreset) {
                this.presetButton.innerHTML = 'Use Preset';
            } else {
                this.presetButton.innerHTML = 'Next Preset';
            }
        }

        // Force reflow before slider.redraw() so track/fill have correct size after display toggles.
        void document.body.offsetHeight;
        this.flipnessSlider.redraw();
        this.densitySlider.redraw();
        this.roomWidthSlider.redraw();
        this.roomHeightSlider.redraw();
        this.roomDepthSlider.redraw();
        this.speedSlider.redraw();
        if (this.gravitySlider) this.gravitySlider.redraw();
        if (this.sparkleStrengthSlider) this.sparkleStrengthSlider.redraw();
        if (this.vignetteStrengthSlider) this.vignetteStrengthSlider.redraw();
        if (this.bloomStrengthSlider) this.bloomStrengthSlider.redraw();
        this.backgroundSlider.redraw();
    }


    //compute the number of particles for the current boxes and grid density
    // ============================================================================
    // SECTION 11: UTILITY METHODS
    // ============================================================================

    FluidParticles.prototype.getParticleCount = function () {
        var boxEditor = this.boxEditor;

        var gridCells = this.gridWidth * this.gridHeight * this.gridDepth * this.gridCellDensity;

        //assuming x:y:z ratio of 2:1:1
        var gridResolutionY = Math.ceil(Math.pow(gridCells / 2, 1.0 / 3.0));
        var gridResolutionZ = gridResolutionY * 1;
        var gridResolutionX = gridResolutionY * 2;

        var totalGridCells = gridResolutionX * gridResolutionY * gridResolutionZ;


        var totalVolume = 0;
        var cumulativeVolume = []; //at index i, contains the total volume up to and including box i (so index 0 has volume of first box, last index has total volume)

        for (var i = 0; i < boxEditor.boxes.length; ++i) {
            var box = boxEditor.boxes[i];
            var volume = box.computeVolume();

            totalVolume += volume;
            cumulativeVolume[i] = totalVolume;
        }

        var fractionFilled = totalVolume / (this.gridWidth * this.gridHeight * this.gridDepth);

        var desiredParticleCount = fractionFilled * totalGridCells * PARTICLES_PER_CELL; //theoretical number of particles

        return desiredParticleCount;
    }

    // Generate particles in a box with custom spacing (grid-based)
    FluidParticles.prototype._generateParticlesWithSpacing = function (box, spacing) {
        var particles = [];
        var width = box.max[0] - box.min[0];
        var height = box.max[1] - box.min[1];
        var depth = box.max[2] - box.min[2];
        
        var stepsX = Math.max(1, Math.floor(width / spacing));
        var stepsY = Math.max(1, Math.floor(height / spacing));
        var stepsZ = Math.max(1, Math.floor(depth / spacing));
        
        var offsetX = (width - (stepsX - 1) * spacing) / 2;
        var offsetY = (height - (stepsY - 1) * spacing) / 2;
        var offsetZ = (depth - (stepsZ - 1) * spacing) / 2;
        
        for (var x = 0; x < stepsX; x++) {
            for (var y = 0; y < stepsY; y++) {
                for (var z = 0; z < stepsZ; z++) {
                    var pos = [
                        box.min[0] + offsetX + x * spacing,
                        box.min[1] + offsetY + y * spacing,
                        box.min[2] + offsetZ + z * spacing
                    ];
                    // Only add if position is inside box (safety check)
                    if (pos[0] >= box.min[0] && pos[0] <= box.max[0] &&
                        pos[1] >= box.min[1] && pos[1] <= box.max[1] &&
                        pos[2] >= box.min[2] && pos[2] <= box.max[2]) {
                        particles.push(pos);
                    }
                }
            }
        }
        return particles;
    };

    // (re)initialize simulator and renderer from current box editor state (particles, grid, etc.)
    FluidParticles.prototype._resetSimulatorFromBoxes = function () {
        var particlePositions = [];
        var boxEditor = this.boxEditor;
        var particlesWidth, particlesHeight;

        if (this.useCustomParticleSettings) {
            // Custom mode: Generate particles with custom spacing
            for (var i = 0; i < boxEditor.boxes.length; ++i) {
                var box = boxEditor.boxes[i];
                var boxParticles = this._generateParticlesWithSpacing(box, this.customParticleSpacing);
                particlePositions = particlePositions.concat(boxParticles);
            }
            particlesWidth = 512;
            particlesHeight = Math.ceil(particlePositions.length / particlesWidth);
            // Pad to fill the texture
            while (particlePositions.length < particlesWidth * particlesHeight) {
                particlePositions.push([0, 0, 0]);
            }
        } else {
            // Normal mode: Use density-based random generation
            var desiredParticleCount = this.getParticleCount();
            particlesWidth = 512;
            particlesHeight = Math.ceil(desiredParticleCount / particlesWidth);

            var particleCount = particlesWidth * particlesHeight;
            var totalVolume = 0;
            for (var i = 0; i < boxEditor.boxes.length; ++i) {
                totalVolume += boxEditor.boxes[i].computeVolume();
            }

            var particlesCreatedSoFar = 0;
            for (var i = 0; i < boxEditor.boxes.length; ++i) {
                var box = boxEditor.boxes[i];
                var particlesInBox = 0;
                if (i < boxEditor.boxes.length - 1) {
                    particlesInBox = Math.floor(particleCount * box.computeVolume() / totalVolume);
                } else {
                    particlesInBox = particleCount - particlesCreatedSoFar;
                }
                for (var j = 0; j < particlesInBox; ++j) {
                    particlePositions.push(box.randomPoint());
                }
                particlesCreatedSoFar += particlesInBox;
            }
        }

        var gridCells = this.gridWidth * this.gridHeight * this.gridDepth * this.gridCellDensity;
        var gridResolutionY = Math.ceil(Math.pow(gridCells / 2, 1.0 / 3.0));
        var gridResolutionZ = gridResolutionY * 1;
        var gridResolutionX = gridResolutionY * 2;

        var gridSize = [this.gridWidth, this.gridHeight, this.gridDepth];
        var gridResolution = [gridResolutionX, gridResolutionY, gridResolutionZ];
        
        // Calculate sphere radius based on custom settings or default
        var sphereRadius;
        if (this.useCustomParticleSettings) {
            // Use average of min/max radius, scaled by particle size
            var avgRadius = (this.customParticleRadiusMin + this.customParticleRadiusMax) / 2.0;
            sphereRadius = avgRadius * this.customParticleSize;
        } else {
            sphereRadius = 7.0 / gridResolutionX;
        }

        this.simulatorRenderer.reset(particlesWidth, particlesHeight, particlePositions, gridSize, gridResolution, PARTICLES_PER_CELL, sphereRadius);
        this.simulatorRenderer.renderer.backgroundBrightness = this.backgroundBrightness;
    };

    // ============================================================================
    // SECTION 3 (continued): STATE MANAGEMENT METHODS
    // ============================================================================

    //begin simulation using boxes from box editor
    //EDITING -> SIMULATING
    FluidParticles.prototype.startSimulation = function () {
        this.state = State.SIMULATING;
        this.frozen = true;
        this.simulatorRenderer.simulator.gravity = this.gravity;
        this._resetSimulatorFromBoxes();
        this.camera.setBounds(-Math.PI / 2, Math.PI / 2);
    }

    // reset particles (same boxes); only in SIMULATING. If frozen, stays frozen; if running, freezes (paused).
    FluidParticles.prototype.resetSimulation = function () {
        this._resetSimulatorFromBoxes();
        this.frozen = true;
        this.redrawUI();
    }

    //go back to box editing
    //SIMULATING -> EDITING
    FluidParticles.prototype.stopSimulation = function () {
        this.state = State.EDITING;

        this.camera.setBounds(-Math.PI / 2, Math.PI / 2);
    }

    // ============================================================================
    // SECTION 10 (continued): ANIMATION LOOP (prototype method)
    // ============================================================================
    // NOTE: FPS tracking and requestAnimationFrame loop are in start() function.
    // The update() method itself is called from that loop.

    FluidParticles.prototype.update = function () {
        if (this.state === State.EDITING) {
            this.boxEditor.draw();
        } else if (this.state === State.SIMULATING) {
            // WHY Math.max(timeStep, 1/600): Ensures physics always runs even when speed slider is at 0%.
            // Without this, timeStep = 0 would cause simulate() to return early (line 279 in simulator.js),
            // and gravity/forces wouldn't apply. Minimum 1/600 (very slow) keeps physics active.
            // This allows gravity to work even at "paused" speed, which is useful for tweaking.
            var dt = this.frozen ? 0 : Math.max(this.timeStep, 1 / 600);
            this.simulatorRenderer.update(dt);
        }
    }

    return FluidParticles;
}());

