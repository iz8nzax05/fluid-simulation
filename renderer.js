'use strict'

/**
 * Renderer - Deferred rendering pipeline for particle-based fluid
 * 
 * WHY DEFERRED RENDERING: Instead of rendering directly to screen, we render to textures
 * first, then composite. This allows:
 * 1. Multiple passes (occlusion, shadows) that read previous passes
 * 2. Post-processing effects (sparkle, vignette, bloom) applied to final image
 * 3. Better performance (can skip expensive passes if disabled)
 * 
 * RENDERING PIPELINE ORDER (CRITICAL - DO NOT CHANGE):
 * 1. Draw particles → renderingTexture (stores normal.x, normal.y, speed, depth)
 * 2. Draw occlusion → occlusionTexture (ambient occlusion for depth)
 * 3. Draw shadow map → depthTexture (from light's perspective)
 * 4. Composite → compositingTexture (combines all passes + effects)
 * 5. FXAA → screen (anti-aliasing, final output)
 * 
 * WHY THIS ORDER:
 * - Occlusion needs renderingTexture (to know what's occluded)
 * - Shadow map can be independent (from light view, not camera view)
 * - Composite needs all textures (rendering, occlusion, shadow)
 * - FXAA must be last (anti-aliases final image)
 */
var Renderer = (function () {

    // ============================================================================
    // SECTION 1: CONSTANTS & CONFIGURATION
    // ============================================================================

    // WHY 256x256: Shadow map resolution. Lower = faster but blurrier shadows.
    // 256 is good balance for real-time. Higher (512/1024) = sharper but slower.
    var SHADOW_MAP_WIDTH = 256;

    var COLOR_PRESETS = [
        { name: 'Cyan',    colorLow: [0.0, 0.45, 0.95], colorHigh: [0.25, 0.35, 1.0] },
        { name: 'Magma',   colorLow: [0.2, 0.0, 0.4],   colorHigh: [1.0, 0.35, 0.2] },
        { name: 'Ocean',   colorLow: [0.0, 0.2, 0.5],   colorHigh: [0.2, 0.6, 1.0] },
        { name: 'Forest',  colorLow: [0.1, 0.35, 0.2],  colorHigh: [0.4, 0.9, 0.5] },
        { name: 'Sunset',  colorLow: [0.4, 0.15, 0.3],  colorHigh: [1.0, 0.5, 0.2] },
        { name: 'Plasma',  colorLow: [0.2, 0.0, 0.6],   colorHigh: [1.0, 0.5, 0.0] },
        { name: 'Viridis', colorLow: [0.25, 0.0, 0.4],  colorHigh: [0.4, 0.9, 0.2] },
        { name: 'Fire',    colorLow: [0.2, 0.0, 0.0],   colorHigh: [1.0, 1.0, 0.2] },
        { name: 'Mono',    colorLow: [0.06, 0.06, 0.06], colorHigh: [1.0, 1.0, 1.0] },
        { name: 'Red',     colorLow: [0.75, 0.0, 0.0],  colorHigh: [1.0, 0.0, 0.0], glow: 1 },
        { name: 'Green',   colorLow: [0.0, 0.75, 0.0],  colorHigh: [0.0, 1.0, 0.0], glow: 1 },
        { name: 'Blue',    colorLow: [0.0, 0.0, 0.75],  colorHigh: [0.0, 0.0, 1.0], glow: 1 },
        { name: 'Color Maker', colorLow: [0.2, 0.4, 0.8], colorHigh: [0.8, 0.6, 1.0], glow: 0 },
        { name: 'Rainbow', colors: [[1,0,0],[1,0.5,0],[1,1,0],[0,1,0],[0,1,1],[0,0.5,1],[0.5,0,1]], glow: 0, rampScale: 0.045 }
    ];
    var SHADOW_MAP_HEIGHT = 256;


    /*
     * DEFERRED RENDERING TEXTURE FORMAT:
     * 
     * renderingTexture stores: (normal.x, normal.y, speed, depth)
     * 
     * WHY THIS FORMAT:
     * - Normal.x, Normal.y: Only need 2 components (Z reconstructed: sqrt(1 - x² - y²))
     *   Saves texture bandwidth (2 floats instead of 3)
     * - Speed: Particle velocity magnitude (for color gradients, sparkle effect)
     * - Depth: Z in view space (for depth-based effects, occlusion calculations)
     * 
     * WHY NOT STORE NORMAL.Z: Can be reconstructed from x,y since normal is unit length.
     * This saves 33% texture memory and bandwidth.
     */

    // ============================================================================
    // SECTION 2: SPHERE GEOMETRY GENERATION
    // ============================================================================

    /**
     * generateSphereGeometry() - Creates sphere mesh for particle rendering
     * 
     * WHY SPHERES: Particles rendered as instanced spheres. Each particle = one sphere.
     * Instanced rendering = draw one sphere mesh N times (one per particle) = very fast.
     * 
     * SLIDER MAPPING (0-7):
     * - iterations = -4: Cube (12 faces, slider 3)
     * - iterations = -3: Triangle (1 face, slider 0)
     * - iterations = -2: Tetrahedron (4 faces, slider 1)
     * - iterations = -1: Octahedron (8 faces, slider 2)
     * - iterations = 0: Icosahedron (20 faces, slider 4)
     * - iterations = 1-3: Icosahedron subdivided (80/320/1280 faces, sliders 5-7)
     * 
     * Higher slider = more faces = smoother spheres but more GPU cost. Slider 3 (cube) = good balance.
     */
    function generateSphereGeometry (iterations) {

        var vertices = [],
            normals = [];

        var compareVectors = function (a, b) {
            var EPSILON = 0.001;
            return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON;
        };

        var addVertex = function (v) {
            Utilities.normalizeVector(v, v);
            vertices.push(v);
            normals.push(v);
        };

        var getMiddlePoint = function (vertexA, vertexB) {
            var middle = [
                (vertexA[0] + vertexB[0]) / 2.0,
                (vertexA[1] + vertexB[1]) / 2.0,
                (vertexA[2] + vertexB[2]) / 2.0];

            Utilities.normalizeVector(middle, middle);

            for (var i = 0; i < vertices.length; ++i) {
                if (compareVectors(vertices[i], middle)) {
                    return i;
                }
            }

            addVertex(middle);
            return (vertices.length - 1);
        };

        var faces = [];

        // NEW SLIDER MAPPING (0-7):
        // 0: -3 = 1 face (triangle)
        // 1: -2 = 4 faces (tetrahedron)
        // 2: -1 = 8 faces (octahedron)
        // 3: -4 = 12 faces (cube)
        // 4: 0 = 20 faces (icosahedron)
        // 5: 1 = 80 faces (ico+1 subdivision)
        // 6: 2 = 320 faces (ico+2 subdivisions)
        // 7: 3 = 1280 faces (ico+3 subdivisions)
        
        // Round to nearest integer for base shape selection
        var roundedIterations = Math.round(iterations);
        
        if (roundedIterations === -4) {
            // Cube: 8 vertices, 6 square faces = 12 triangular faces (36 indices)
            // Slider value 3
            // Vertices of a cube (normalized to unit sphere)
            var s = 1.0 / Math.sqrt(3.0); // Scale factor to normalize cube vertices to unit sphere
            addVertex([s, s, s]);      // 0: +X +Y +Z
            addVertex([-s, s, s]);     // 1: -X +Y +Z
            addVertex([-s, -s, s]);    // 2: -X -Y +Z
            addVertex([s, -s, s]);     // 3: +X -Y +Z
            addVertex([s, s, -s]);     // 4: +X +Y -Z
            addVertex([-s, s, -s]);    // 5: -X +Y -Z
            addVertex([-s, -s, -s]);   // 6: -X -Y -Z
            addVertex([s, -s, -s]);    // 7: +X -Y -Z

            // 12 triangular faces (2 triangles per cube face)
            // Front face (Z+)
            faces.push([0, 1, 2]);
            faces.push([0, 2, 3]);
            // Back face (Z-)
            faces.push([4, 7, 6]);
            faces.push([4, 6, 5]);
            // Right face (X+)
            faces.push([0, 3, 7]);
            faces.push([0, 7, 4]);
            // Left face (X-)
            faces.push([1, 5, 6]);
            faces.push([1, 6, 2]);
            // Top face (Y+)
            faces.push([0, 4, 5]);
            faces.push([0, 5, 1]);
            // Bottom face (Y-)
            faces.push([3, 2, 6]);
            faces.push([3, 6, 7]);
        } else if (roundedIterations === -3) {
            // Triangle: 3 vertices, 1 triangular face (3 indices)
            // Slider value 0 - simplest possible shape
            addVertex([0, 0, 1]);   // 0: Top point
            addVertex([1, 0, -1]);  // 1: Bottom right
            addVertex([-1, 0, -1]); // 2: Bottom left
            
            // Single triangle face
            faces.push([0, 1, 2]);
        } else if (roundedIterations === -2) {
            // Tetrahedron: 4 vertices, 4 triangular faces (12 indices)
            // Slider value 1
            // Regular tetrahedron vertices (normalized to unit sphere)
            var sqrt2 = Math.sqrt(2.0);
            var sqrt6 = Math.sqrt(6.0);
            addVertex([0, 0, 1]);                    // 0: Top
            addVertex([2*sqrt2/3, 0, -1/3]);        // 1: Front-right
            addVertex([-sqrt2/3, sqrt6/3, -1/3]);   // 2: Back-left
            addVertex([-sqrt2/3, -sqrt6/3, -1/3]);  // 3: Back-right
            
            // 4 faces of tetrahedron
            faces.push([0, 1, 2]);  // Top-front-back
            faces.push([0, 2, 3]);  // Top-back-bottom
            faces.push([0, 3, 1]);  // Top-bottom-front
            faces.push([1, 3, 2]);  // Bottom (all three bottom vertices)
        } else if (roundedIterations === -1) {
            // Octahedron: 6 vertices, 8 triangular faces (24 indices)
            // Slider value 2
            addVertex([1, 0, 0]);   // 0: +X
            addVertex([-1, 0, 0]);  // 1: -X
            addVertex([0, 1, 0]);   // 2: +Y
            addVertex([0, -1, 0]);  // 3: -Y
            addVertex([0, 0, 1]);   // 4: +Z
            addVertex([0, 0, -1]);  // 5: -Z

            // 8 faces of octahedron
            faces.push([2, 0, 4]);  // Top front right
            faces.push([2, 4, 1]);  // Top front left
            faces.push([2, 1, 5]);  // Top back left
            faces.push([2, 5, 0]);  // Top back right
            faces.push([3, 4, 0]);  // Bottom front right
            faces.push([3, 1, 4]);  // Bottom front left
            faces.push([3, 5, 1]);  // Bottom back left
            faces.push([3, 0, 5]);  // Bottom back right
        } else {
            // Icosahedron: 12 vertices, 20 triangular faces (60 indices)
            // Slider values 4-7 (iterations 0-3)
            var t = (1.0 + Math.sqrt(5.0)) / 2.0;

            addVertex([-1, t, 0]);
            addVertex([1, t, 0]);
            addVertex([-1, -t, 0]);
            addVertex([1, -t, 0]);

            addVertex([0, -1, t]);
            addVertex([0, 1, t]);
            addVertex([0, -1, -t]);
            addVertex([0, 1, -t]);

            addVertex([t, 0, -1]);
            addVertex([t, 0, 1]);
            addVertex([-t, 0, -1]);
            addVertex([-t, 0, 1]);

            faces.push([0, 11, 5]);
            faces.push([0, 5, 1]);
            faces.push([0, 1, 7]);
            faces.push([0, 7, 10]);
            faces.push([0, 10, 11]);

            faces.push([1, 5, 9]);
            faces.push([5, 11, 4]);
            faces.push([11, 10, 2]);
            faces.push([10, 7, 6]);
            faces.push([7, 1, 8]);

            faces.push([3, 9, 4]);
            faces.push([3, 4, 2]);
            faces.push([3, 2, 6]);
            faces.push([3, 6, 8]);
            faces.push([3, 8, 9]);

            faces.push([4, 9, 5]);
            faces.push([2, 4, 11]);
            faces.push([6, 2, 10]);
            faces.push([8, 6, 7]);
            faces.push([9, 8, 1]);
        }


        // Only subdivide if iterations >= 0 (iterations < 0 use base shapes: triangle, tetrahedron, octahedron, cube)
        // Use floor for subdivision count since we can't do fractional iterations
        var subdivisionCount = Math.max(0, Math.floor(iterations));
        for (var i = 0; i < subdivisionCount; ++i) {
            var faces2 = [];

            for (var i = 0; i < faces.length; ++i) {
                var face = faces[i];
                //replace triangle with 4 triangles
                var a = getMiddlePoint(vertices[face[0]], vertices[face[1]]);
                var b = getMiddlePoint(vertices[face[1]], vertices[face[2]]);
                var c = getMiddlePoint(vertices[face[2]], vertices[face[0]]);

                faces2.push([face[0], a, c]);
                faces2.push([face[1], b, a]);
                faces2.push([face[2], c, b]);
                faces2.push([a, b, c]);
            }

            faces = faces2;
        }


        var packedVertices = [],
            packedNormals = [],
            indices = [];

        for (var i = 0; i < vertices.length; ++i) {
            packedVertices.push(vertices[i][0]);
            packedVertices.push(vertices[i][1]);
            packedVertices.push(vertices[i][2]);

            packedNormals.push(normals[i][0]);
            packedNormals.push(normals[i][1]);
            packedNormals.push(normals[i][2]);
        }

        for (var i = 0; i < faces.length; ++i) {
            var face = faces[i];
            indices.push(face[0]);
            indices.push(face[1]);
            indices.push(face[2]);
        }

        return {
            vertices: packedVertices,
            normals: packedNormals,
            indices: indices
        }
    }

    // ============================================================================
    // SECTION 3: CONSTRUCTOR & INITIALIZATION
    // ============================================================================

    //you need to call reset() before drawing
    function Renderer (canvas, wgl, gridDimensions, onLoaded) {

        this.canvas = canvas;
        this.wgl = wgl;

        this.particlesWidth = 0;
        this.particlesHeight = 0;

        this.sphereRadius = 0.0;
        this.colorPresetIndex = 0;
        this.backgroundBrightness = 1.0;
        this.sparkle = false;
        this.sparkleStrength = 0.35;
        this.vignette = false;
        this.vignetteStrength = 0.5;
        this.bloom = false;
        this.bloomStrength = 0.3;
        this.compositeEnabled = true; // Toggle for composite shader (debug feature)
        this.sphereIterations = 3; // Sphere geometry complexity (same as old backup: 1280 faces, icosahedron + 3 subdivisions)
        this.occlusionEnabled = true; // Toggle for ambient occlusion pass (debug feature)
        this.shadowMapEnabled = true; // Toggle for shadow map pass (debug feature)
        this.waterBlendFactor = 1.5; // Multiplier for sphere radius to create continuous water surface (1.0 = separate orbs, 1.5+ = blended water)
        this.use2DFaces = false; // 2D Faces: billboarded flat discs (1 quad/particle). Much faster than spheres; allows more particles.
        this.lightPosition = [0, 0, 0]; // Set in setGridDimensions; used for 2D shadow billboarding.
        
        // Initialize sphere geometry with default iterations
        var sphereGeometry = this.sphereGeometry = generateSphereGeometry(this.sphereIterations);

        this.wgl.getExtension('ANGLE_instanced_arrays');
        this.depthExt = this.wgl.getExtension('WEBGL_depth_texture');


        this.quadVertexBuffer = wgl.createBuffer();
        wgl.bufferData(this.quadVertexBuffer, wgl.ARRAY_BUFFER, new Float32Array([-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0]), wgl.STATIC_DRAW);

        // 2D Faces: billboard quad (XY plane, corners -1..1). One quad per particle, always faces camera.
        this.billboardQuadVertexBuffer = wgl.createBuffer();
        wgl.bufferData(this.billboardQuadVertexBuffer, wgl.ARRAY_BUFFER, new Float32Array([-1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0]), wgl.STATIC_DRAW);
        this.billboardQuadIndexBuffer = wgl.createBuffer();
        wgl.bufferData(this.billboardQuadIndexBuffer, wgl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), wgl.STATIC_DRAW);
        this.billboardQuadIndexCount = 6;

        ///////////////////////////////////////////////////////
        // create stuff for rendering 

        // Sphere geometry already generated in constructor
        // this.sphereGeometry is already set

        this.sphereVertexBuffer = wgl.createBuffer();
        wgl.bufferData(this.sphereVertexBuffer, wgl.ARRAY_BUFFER, new Float32Array(this.sphereGeometry.vertices), wgl.STATIC_DRAW);

        this.sphereNormalBuffer = wgl.createBuffer();
        wgl.bufferData(this.sphereNormalBuffer, wgl.ARRAY_BUFFER, new Float32Array(this.sphereGeometry.normals), wgl.STATIC_DRAW);

        this.sphereIndexBuffer = wgl.createBuffer();
        wgl.bufferData(this.sphereIndexBuffer, wgl.ELEMENT_ARRAY_BUFFER, new Uint16Array(this.sphereGeometry.indices), wgl.STATIC_DRAW);

        this.depthFramebuffer = wgl.createFramebuffer();
        this.depthColorTexture = wgl.buildTexture(wgl.RGBA, wgl.UNSIGNED_BYTE, SHADOW_MAP_WIDTH, SHADOW_MAP_HEIGHT, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
        this.depthTexture = wgl.buildTexture(wgl.DEPTH_COMPONENT, wgl.UNSIGNED_SHORT, SHADOW_MAP_WIDTH, SHADOW_MAP_HEIGHT, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);

        
        //we light directly from above
        this.lightViewMatrix = new Float32Array(16); 
        var midpoint = [gridDimensions[0] / 2, gridDimensions[1] / 2, gridDimensions[2] / 2];
        this.lightPosition[0] = midpoint[0];
        this.lightPosition[1] = midpoint[1];
        this.lightPosition[2] = midpoint[2];
        Utilities.makeLookAtMatrix(this.lightViewMatrix, midpoint, [midpoint[0], midpoint[1] - 1.0, midpoint[2]], [0.0, 0.0, 1.0]);
        this.lightProjectionMatrix = Utilities.makeOrthographicMatrix(new Float32Array(16), -gridDimensions[0] / 2, gridDimensions[0] / 2, -gridDimensions[2] / 2, gridDimensions[2] / 2, -gridDimensions[1] / 2, gridDimensions[1] / 2);
        this.lightProjectionViewMatrix = new Float32Array(16);
        Utilities.premultiplyMatrix(this.lightProjectionViewMatrix, this.lightViewMatrix, this.lightProjectionMatrix);


        this.particleVertexBuffer = wgl.createBuffer();

        this.renderingFramebuffer = wgl.createFramebuffer();
        this.renderingRenderbuffer = wgl.createRenderbuffer();
        this.renderingTexture = wgl.createTexture();
        this.occlusionTexture = wgl.createTexture();
        this.compositingTexture = wgl.createTexture();
        this.colorRampTexture = wgl.createTexture();
        this.colorRampInitialized = false;
        this.colorRampSize = 2;

        this.onResize();

        // ============================================================================
        // SECTION 4: BUFFER & TEXTURE CREATION
        // ============================================================================
        // NOTE: All buffers, textures, and framebuffers are created in constructor.
        // They are rebuilt/resized in onResize() and reset() methods as needed.

        // ============================================================================
        // SECTION 5: SHADER PROGRAM LOADING
        // ============================================================================

        wgl.createProgramsFromFiles({
            sphereProgram: {
                vertexShader: 'shaders/sphere.vert',
                fragmentShader: 'shaders/sphere.frag'
            },
            sphereDepthProgram: {
                vertexShader: 'shaders/spheredepth.vert',
                fragmentShader: 'shaders/spheredepth.frag'
            },
            sphereAOProgram: {
                vertexShader: 'shaders/sphereao.vert',
                fragmentShader: 'shaders/sphereao.frag'
            },
            billboard2dProgram: {
                vertexShader: 'shaders/billboard2d.vert',
                fragmentShader: 'shaders/billboard2d.frag'
            },
            billboard2dAOProgram: {
                vertexShader: 'shaders/billboard2dao.vert',
                fragmentShader: 'shaders/sphereao.frag'
            },
            billboard2dDepthProgram: {
                vertexShader: 'shaders/billboard2ddepth.vert',
                fragmentShader: 'shaders/spheredepth.frag'
            },
            compositeProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: 'shaders/composite.frag',
                attributeLocations: { 'a_position': 0}
            },
            fxaaProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: 'shaders/fxaa.frag',
                attributeLocations: { 'a_position': 0}
            },
            gbufferViewProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: 'shaders/gbuffer_view.frag',
                attributeLocations: { 'a_position': 0 }
            },
        }, (function (programs) {
            for (var programName in programs) {
                this[programName] = programs[programName];
            }

            // Initialize color ramp before first draw to ensure composite shader works on startup
            var defaultPreset = COLOR_PRESETS[this.colorPresetIndex] || { colorLow: [0, 0.5, 1], colorHigh: [0.2, 0.4, 1] };
            this.updateColorRamp(defaultPreset);

            onLoaded();
        }).bind(this));
    }

    // ============================================================================
    // SECTION 6: RESET & PARTICLE SETUP
    // ============================================================================

    Renderer.prototype.reset = function (particlesWidth, particlesHeight, sphereRadius) {
        this.particlesWidth = particlesWidth;
        this.particlesHeight = particlesHeight;

        this.sphereRadius = sphereRadius;

        ///////////////////////////////////////////////////////////
        // create particle data
        
        var particleCount = this.particlesWidth * this.particlesHeight;

        //fill particle vertex buffer containing the relevant texture coordinates
        var particleTextureCoordinates = new Float32Array(this.particlesWidth * this.particlesHeight * 2);
        for (var y = 0; y < this.particlesHeight; ++y) {
            for (var x = 0; x < this.particlesWidth; ++x) {
                particleTextureCoordinates[(y * this.particlesWidth + x) * 2] = (x + 0.5) / this.particlesWidth;
                particleTextureCoordinates[(y * this.particlesWidth + x) * 2 + 1] = (y + 0.5) / this.particlesHeight;
            }
        }

        wgl.bufferData(this.particleVertexBuffer, wgl.ARRAY_BUFFER, particleTextureCoordinates, wgl.STATIC_DRAW);
    }

    // ============================================================================
    // SECTION 7: RENDERING PIPELINE (draw method)
    // ============================================================================

    /**
     * draw() - Main rendering function (called once per frame)
     * 
     * CRITICAL PIPELINE ORDER (DO NOT CHANGE):
     * 1. Draw particles → renderingTexture (deferred G-buffer)
     * 2. Draw occlusion → occlusionTexture (ambient occlusion)
     * 3. Draw shadow map → depthTexture (from light's view)
     * 4. Composite → compositingTexture (combine all + effects)
     * 5. FXAA → screen (anti-aliasing)
     * 
     * WHY THIS ORDER:
     * - Step 2 (occlusion) reads step 1 (renderingTexture)
     * - Step 4 (composite) reads steps 1, 2, 3
     * - Step 5 (FXAA) reads step 4 (final image)
     * 
     * Reversing order = broken rendering (occlusion has nothing to read, etc.)
     */
    Renderer.prototype.draw = function (simulator, projectionMatrix, viewMatrix, cameraPosition) {
        var wgl = this.wgl;
        var particleCount = this.particlesWidth * this.particlesHeight;
        var radius = this.sphereRadius * this.waterBlendFactor;

        /////////////////////////////////////////////
        // STEP 1: Draw particles to deferred G-buffer
        //
        // WHY FIRST: All other passes read from this texture.
        // This stores: normal.x, normal.y, speed, depth for each pixel.
        // Future passes use this to compute lighting, occlusion, shadows.

        var projectionViewMatrix = Utilities.premultiplyMatrix(new Float32Array(16), viewMatrix, projectionMatrix);

        wgl.framebufferTexture2D(this.renderingFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.renderingTexture, 0);
        wgl.framebufferRenderbuffer(this.renderingFramebuffer, wgl.FRAMEBUFFER, wgl.DEPTH_ATTACHMENT, wgl.RENDERBUFFER, this.renderingRenderbuffer);

        wgl.clear(
            wgl.createClearState().bindFramebuffer(this.renderingFramebuffer).clearColor(-99999.0, -99999.0, -99999.0, -99999.0),
            wgl.COLOR_BUFFER_BIT | wgl.DEPTH_BUFFER_BIT);

        if (this.use2DFaces && cameraPosition) {
            var billboardDrawState = wgl.createDrawState()
                .bindFramebuffer(this.renderingFramebuffer)
                .viewport(0, 0, this.canvas.width, this.canvas.height)
                .enable(wgl.DEPTH_TEST)
                .enable(wgl.CULL_FACE)
                .useProgram(this.billboard2dProgram)
                .vertexAttribPointer(this.billboardQuadVertexBuffer, this.billboard2dProgram.getAttribLocation('a_vertexCorner'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                .vertexAttribPointer(this.particleVertexBuffer, this.billboard2dProgram.getAttribLocation('a_textureCoordinates'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                .vertexAttribDivisorANGLE(this.billboard2dProgram.getAttribLocation('a_textureCoordinates'), 1)
                .bindIndexBuffer(this.billboardQuadIndexBuffer)
                .uniformMatrix4fv('u_projectionMatrix', false, projectionMatrix)
                .uniformMatrix4fv('u_viewMatrix', false, viewMatrix)
                .uniform3f('u_cameraPosition', cameraPosition[0], cameraPosition[1], cameraPosition[2])
                .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, simulator.particlePositionTexture)
                .uniformTexture('u_velocitiesTexture', 1, wgl.TEXTURE_2D, simulator.particleVelocityTexture)
                .uniform1f('u_sphereRadius', radius);
            wgl.drawElementsInstancedANGLE(billboardDrawState, wgl.TRIANGLES, this.billboardQuadIndexCount, wgl.UNSIGNED_SHORT, 0, particleCount);
        } else {
            var sphereDrawState = wgl.createDrawState()
                .bindFramebuffer(this.renderingFramebuffer)
                .viewport(0, 0, this.canvas.width, this.canvas.height)
                .enable(wgl.DEPTH_TEST)
                .enable(wgl.CULL_FACE)
                .useProgram(this.sphereProgram)
                .vertexAttribPointer(this.sphereVertexBuffer, this.sphereProgram.getAttribLocation('a_vertexPosition'), 3, wgl.FLOAT, wgl.FALSE, 0, 0)
                .vertexAttribPointer(this.sphereNormalBuffer, this.sphereProgram.getAttribLocation('a_vertexNormal'), 3, wgl.FLOAT, wgl.FALSE, 0, 0)
                .vertexAttribPointer(this.particleVertexBuffer, this.sphereProgram.getAttribLocation('a_textureCoordinates'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                .vertexAttribDivisorANGLE(this.sphereProgram.getAttribLocation('a_textureCoordinates'), 1)
                .bindIndexBuffer(this.sphereIndexBuffer)
                .uniformMatrix4fv('u_projectionMatrix', false, projectionMatrix)
                .uniformMatrix4fv('u_viewMatrix', false, viewMatrix)
                .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, simulator.particlePositionTexture)
                .uniformTexture('u_velocitiesTexture', 1, wgl.TEXTURE_2D, simulator.particleVelocityTexture)
                .uniform1f('u_sphereRadius', radius);
            wgl.drawElementsInstancedANGLE(sphereDrawState, wgl.TRIANGLES, this.sphereGeometry.indices.length, wgl.UNSIGNED_SHORT, 0, particleCount);
        }



        ///////////////////////////////////////////////////
        // STEP 2: Draw ambient occlusion
        //
        // WHY AFTER RENDERING: Occlusion pass reads renderingTexture to know particle positions.
        // It computes how much each particle is occluded by nearby particles (darkens crevices).
        // This adds depth perception - particles in tight spaces look darker.
        //
        // WHY AMBIENT OCCLUSION: Simulates soft shadows from nearby geometry.
        // Makes fluid look more 3D and realistic without expensive per-light shadows.

        var fov = 2.0 * Math.atan(1.0 / projectionMatrix[5]);

        wgl.framebufferTexture2D(this.renderingFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.occlusionTexture, 0);

        if (this.occlusionEnabled) {
            wgl.clear(
                wgl.createClearState().bindFramebuffer(this.renderingFramebuffer).clearColor(0.0, 0.0, 0.0, 0.0),
                wgl.COLOR_BUFFER_BIT);

            var occlusionDrawState = wgl.createDrawState()
                .bindFramebuffer(this.renderingFramebuffer)
                .viewport(0, 0, this.canvas.width, this.canvas.height)
                .enable(wgl.DEPTH_TEST)
                .depthMask(false)
                .enable(wgl.CULL_FACE)
                .enable(wgl.BLEND)
                .blendEquation(wgl.FUNC_ADD)
                .blendFuncSeparate(wgl.ONE, wgl.ONE, wgl.ONE, wgl.ONE)
                .uniformTexture('u_renderingTexture', 2, wgl.TEXTURE_2D, this.renderingTexture)
                .uniform2f('u_resolution', this.canvas.width, this.canvas.height)
                .uniform1f('u_fov', fov)
                .uniform1f('u_sphereRadius', radius);

            if (this.use2DFaces && cameraPosition) {
                occlusionDrawState = occlusionDrawState
                    .useProgram(this.billboard2dAOProgram)
                    .vertexAttribPointer(this.billboardQuadVertexBuffer, this.billboard2dAOProgram.getAttribLocation('a_vertexCorner'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                    .vertexAttribPointer(this.particleVertexBuffer, this.billboard2dAOProgram.getAttribLocation('a_textureCoordinates'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                    .vertexAttribDivisorANGLE(this.billboard2dAOProgram.getAttribLocation('a_textureCoordinates'), 1)
                    .bindIndexBuffer(this.billboardQuadIndexBuffer)
                    .uniformMatrix4fv('u_projectionMatrix', false, projectionMatrix)
                    .uniformMatrix4fv('u_viewMatrix', false, viewMatrix)
                    .uniform3f('u_cameraPosition', cameraPosition[0], cameraPosition[1], cameraPosition[2])
                    .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, simulator.particlePositionTexture)
                    .uniformTexture('u_velocitiesTexture', 1, wgl.TEXTURE_2D, simulator.particleVelocityTexture);
                wgl.drawElementsInstancedANGLE(occlusionDrawState, wgl.TRIANGLES, this.billboardQuadIndexCount, wgl.UNSIGNED_SHORT, 0, particleCount);
            } else {
                occlusionDrawState = occlusionDrawState
                    .useProgram(this.sphereAOProgram)
                    .vertexAttribPointer(this.sphereVertexBuffer, this.sphereAOProgram.getAttribLocation('a_vertexPosition'), 3, wgl.FLOAT, wgl.FALSE, 0, 0)
                    .vertexAttribPointer(this.particleVertexBuffer, this.sphereAOProgram.getAttribLocation('a_textureCoordinates'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                    .vertexAttribDivisorANGLE(this.sphereAOProgram.getAttribLocation('a_textureCoordinates'), 1)
                    .bindIndexBuffer(this.sphereIndexBuffer)
                    .uniformMatrix4fv('u_projectionMatrix', false, projectionMatrix)
                    .uniformMatrix4fv('u_viewMatrix', false, viewMatrix)
                    .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, simulator.particlePositionTexture)
                    .uniformTexture('u_velocitiesTexture', 1, wgl.TEXTURE_2D, simulator.particleVelocityTexture);
                wgl.drawElementsInstancedANGLE(occlusionDrawState, wgl.TRIANGLES, this.sphereGeometry.indices.length, wgl.UNSIGNED_SHORT, 0, particleCount);
            }
        } else {
            // Clear occlusion texture to black (no occlusion) when disabled
            wgl.clear(
                wgl.createClearState().bindFramebuffer(this.renderingFramebuffer).clearColor(0.0, 0.0, 0.0, 0.0),
                wgl.COLOR_BUFFER_BIT);
        }


        ////////////////////////////////////////////////
        // STEP 3: Draw shadow map (from light's perspective)
        //
        // WHY INDEPENDENT OF CAMERA: Shadow map renders from light's view, not camera's view.
        // This can happen anytime before composite (doesn't depend on occlusion/rendering order).
        // We do it here for organization, but could be done earlier.
        //
        // WHY SHADOW MAP: Renders depth from light's perspective. Composite pass uses this
        // to determine which particles are in shadow (behind other particles from light's view).
        // Creates realistic lighting - particles block light from reaching other particles.

        wgl.framebufferTexture2D(this.depthFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.depthColorTexture, 0);
        wgl.framebufferTexture2D(this.depthFramebuffer, wgl.FRAMEBUFFER, wgl.DEPTH_ATTACHMENT, wgl.TEXTURE_2D, this.depthTexture, 0);

        if (this.shadowMapEnabled) {
            wgl.clear(
                wgl.createClearState().bindFramebuffer(this.depthFramebuffer).clearColor(0, 0, 0, 0),
                wgl.DEPTH_BUFFER_BIT);

            var depthDrawState = wgl.createDrawState()
                .bindFramebuffer(this.depthFramebuffer)
                .viewport(0, 0, SHADOW_MAP_WIDTH, SHADOW_MAP_HEIGHT)
                .enable(wgl.DEPTH_TEST)
                .depthMask(true)
                .enable(wgl.SCISSOR_TEST)
                .scissor(1, 1, SHADOW_MAP_WIDTH - 2, SHADOW_MAP_HEIGHT - 2)
                .colorMask(false, false, false, false)
                .enable(wgl.CULL_FACE)
                .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, simulator.particlePositionTexture)
                .uniformTexture('u_velocitiesTexture', 1, wgl.TEXTURE_2D, simulator.particleVelocityTexture)
                .uniform1f('u_sphereRadius', radius);

            if (this.use2DFaces) {
                depthDrawState = depthDrawState
                    .useProgram(this.billboard2dDepthProgram)
                    .vertexAttribPointer(this.billboardQuadVertexBuffer, this.billboard2dDepthProgram.getAttribLocation('a_vertexCorner'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                    .vertexAttribPointer(this.particleVertexBuffer, this.billboard2dDepthProgram.getAttribLocation('a_textureCoordinates'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                    .vertexAttribDivisorANGLE(this.billboard2dDepthProgram.getAttribLocation('a_textureCoordinates'), 1)
                    .bindIndexBuffer(this.billboardQuadIndexBuffer)
                    .uniformMatrix4fv('u_projectionViewMatrix', false, this.lightProjectionViewMatrix)
                    .uniform3f('u_lightPosition', this.lightPosition[0], this.lightPosition[1], this.lightPosition[2]);
                wgl.drawElementsInstancedANGLE(depthDrawState, wgl.TRIANGLES, this.billboardQuadIndexCount, wgl.UNSIGNED_SHORT, 0, particleCount);
            } else {
                depthDrawState = depthDrawState
                    .useProgram(this.sphereDepthProgram)
                    .vertexAttribPointer(this.sphereVertexBuffer, this.sphereDepthProgram.getAttribLocation('a_vertexPosition'), 3, wgl.FLOAT, wgl.FALSE, 0, 0)
                    .vertexAttribPointer(this.particleVertexBuffer, this.sphereDepthProgram.getAttribLocation('a_textureCoordinates'), 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                    .vertexAttribDivisorANGLE(this.sphereDepthProgram.getAttribLocation('a_textureCoordinates'), 1)
                    .bindIndexBuffer(this.sphereIndexBuffer)
                    .uniformMatrix4fv('u_projectionViewMatrix', false, this.lightProjectionViewMatrix);
                wgl.drawElementsInstancedANGLE(depthDrawState, wgl.TRIANGLES, this.sphereGeometry.indices.length, wgl.UNSIGNED_SHORT, 0, particleCount);
            }
        }
        // Note: When shadow map is disabled, composite shader skips shadow calculations via u_shadowMapEnabled uniform


        ///////////////////////////////////////////
        // STEP 4: Composite all passes + apply effects
        //
        // WHY AFTER ALL PASSES: Composite reads renderingTexture, occlusionTexture, and depthTexture.
        // It combines them with lighting, color gradients, and post-processing effects:
        // - Color presets (velocity-based gradients, custom colors)
        // - Sparkle (highlights fastest particles)
        // - Vignette (darkens edges)
        // - Bloom (glow effect)
        // - Shadows (from shadow map)
        // - Ambient occlusion (from occlusion pass)
        //
        // This is where all visual effects are applied to create final image.

        if (this.compositeEnabled) {
            var inverseViewMatrix = Utilities.invertMatrix(new Float32Array(16), viewMatrix);

            wgl.framebufferTexture2D(this.renderingFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.compositingTexture, 0);

            wgl.clear(
                wgl.createClearState().bindFramebuffer(this.renderingFramebuffer).clearColor(0, 0, 0, 0),
                wgl.COLOR_BUFFER_BIT | wgl.DEPTH_BUFFER_BIT);

            var compositeDrawState = wgl.createDrawState()
                .bindFramebuffer(this.renderingFramebuffer)
                .viewport(0, 0, this.canvas.width, this.canvas.height)
                .useProgram(this.compositeProgram)
                .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                .uniformTexture('u_renderingTexture', 0, wgl.TEXTURE_2D, this.renderingTexture)
                .uniformTexture('u_occlusionTexture', 1, wgl.TEXTURE_2D, this.occlusionTexture)
                .uniform2f('u_resolution', this.canvas.width, this.canvas.height)
                .uniform1f('u_fov', fov)
                .uniformMatrix4fv('u_inverseViewMatrix', false, inverseViewMatrix)
                .uniformTexture('u_shadowDepthTexture', 2, wgl.TEXTURE_2D, this.depthTexture)
                .uniform2f('u_shadowResolution', SHADOW_MAP_WIDTH, SHADOW_MAP_HEIGHT)
                .uniformMatrix4fv('u_lightProjectionViewMatrix', false, this.lightProjectionViewMatrix)
                .uniform1f('u_shadowMapEnabled', this.shadowMapEnabled ? 1.0 : 0.0)
                .uniform1f('u_occlusionEnabled', this.occlusionEnabled ? 1.0 : 0.0);

            var idx = Math.max(0, Math.min(this.colorPresetIndex, COLOR_PRESETS.length - 1));
            var p = COLOR_PRESETS[idx] || { colorLow: [0, 0.5, 1], colorHigh: [0.2, 0.4, 1] };
            if (!this.colorRampInitialized) {
                this.updateColorRamp(p);
            }
            compositeDrawState = compositeDrawState
                .uniformTexture('u_colorRamp', 3, wgl.TEXTURE_2D, this.colorRampTexture)
                .uniform1f('u_colorRampSize', Math.max(2, this.colorRampSize))
                .uniform1f('u_rampScale', p.rampScale !== undefined ? p.rampScale : 0.012)
                .uniform1f('u_glow', p.glow || 0)
                .uniform1f('u_backgroundBrightness', this.backgroundBrightness)
                .uniform1f('u_sparkle', this.sparkle ? 1.0 : 0.0)
                .uniform1f('u_sparkleStrength', this.sparkleStrength)
                .uniform1f('u_sparkleThreshold', 15.0)
                .uniform1f('u_vignette', this.vignette ? 1.0 : 0.0)
                .uniform1f('u_vignetteStrength', this.vignetteStrength)
                .uniform1f('u_bloom', this.bloom ? 1.0 : 0.0)
                .uniform1f('u_bloomStrength', this.bloomStrength);

            wgl.drawArrays(compositeDrawState, wgl.TRIANGLE_STRIP, 0, 4);
        } else {
            /* Composite OFF: G-buffer view (normal + depth only, no speed).
             * Raw G-buffer uses B = speed, so moving particles looked bright blue.
             * This pass gives view-dependent hues without speed. */
            wgl.framebufferTexture2D(this.renderingFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.compositingTexture, 0);
            wgl.clear(
                wgl.createClearState().bindFramebuffer(this.renderingFramebuffer).clearColor(0, 0, 0, 0),
                wgl.COLOR_BUFFER_BIT | wgl.DEPTH_BUFFER_BIT);

            var gbufferViewDrawState = wgl.createDrawState()
                .bindFramebuffer(this.renderingFramebuffer)
                .viewport(0, 0, this.canvas.width, this.canvas.height)
                .useProgram(this.gbufferViewProgram)
                .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)
                .uniformTexture('u_renderingTexture', 0, wgl.TEXTURE_2D, this.renderingTexture);
            wgl.drawArrays(gbufferViewDrawState, wgl.TRIANGLE_STRIP, 0, 4);
        }

        //////////////////////////////////////
        // STEP 5: FXAA (Fast Approximate Anti-Aliasing) - FINAL PASS
        //
        // WHY LAST: FXAA smooths jagged edges in the final image.
        // Composite ON: FXAA runs on compositingTexture (full effects).
        // Composite OFF: FXAA runs on compositingTexture (G-buffer view: normal+depth only, no speed).
        wgl.clear(
            wgl.createClearState().bindFramebuffer(null).clearColor(0, 0, 0, 0),
            wgl.COLOR_BUFFER_BIT | wgl.DEPTH_BUFFER_BIT);

        var fxaaDrawState = wgl.createDrawState()
            .bindFramebuffer(null)
            .viewport(0, 0, this.canvas.width, this.canvas.height)
            .useProgram(this.fxaaProgram)
            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)
            .uniformTexture('u_input', 0, wgl.TEXTURE_2D, this.compositingTexture)
            .uniform2f('u_resolution', this.canvas.width, this.canvas.height);

        wgl.drawArrays(fxaaDrawState, wgl.TRIANGLE_STRIP, 0, 4);
    }

    // ============================================================================
    // SECTION 8: COLOR MANAGEMENT
    // ============================================================================

    Renderer.prototype.updateColorRamp = function (preset) {
        var colors = preset && (preset.colors && preset.colors.length >= 2)
            ? preset.colors
            : (preset && preset.colorLow && preset.colorHigh
                ? [preset.colorLow, preset.colorHigh]
                : [[0, 0.5, 1], [0.2, 0.4, 1]]);
        var n = Math.min(Math.max(colors.length, 2), 16);
        var data = new Uint8Array(n * 4);
        for (var i = 0; i < n; i++) {
            var c = colors[i];
            data[i * 4] = Math.round((c[0] || 0) * 255);
            data[i * 4 + 1] = Math.round((c[1] || 0) * 255);
            data[i * 4 + 2] = Math.round((c[2] || 0) * 255);
            data[i * 4 + 3] = 255;
        }
        this.wgl.rebuildTexture(this.colorRampTexture, this.wgl.RGBA, this.wgl.UNSIGNED_BYTE, n, 1, data, this.wgl.CLAMP_TO_EDGE, this.wgl.CLAMP_TO_EDGE, this.wgl.LINEAR, this.wgl.LINEAR);
        this.colorRampSize = n;
        this.colorRampInitialized = true;
    };

    Renderer.prototype.setColorPreset = function (index) {
        this.colorPresetIndex = Math.max(0, Math.min(index, COLOR_PRESETS.length - 1));
        this.updateColorRamp(COLOR_PRESETS[this.colorPresetIndex] || { colorLow: [0, 0.5, 1], colorHigh: [0.2, 0.4, 1] });
    };

    Renderer.prototype.setColorMakerColors = function (colorLow, colorHigh) {
        for (var i = 0; i < COLOR_PRESETS.length; i++) {
            if (COLOR_PRESETS[i].name === 'Color Maker') {
                COLOR_PRESETS[i].colorLow = [colorLow[0], colorLow[1], colorLow[2]];
                COLOR_PRESETS[i].colorHigh = [colorHigh[0], colorHigh[1], colorHigh[2]];
                this.updateColorRamp(COLOR_PRESETS[i]);
                break;
            }
        }
    };

    Renderer.prototype.setColorMakerGlow = function (glow) {
        for (var i = 0; i < COLOR_PRESETS.length; i++) {
            if (COLOR_PRESETS[i].name === 'Color Maker') {
                COLOR_PRESETS[i].glow = glow;
                break;
            }
        }
    };

    // ============================================================================
    // SECTION 9: UTILITY METHODS
    // ============================================================================

    Renderer.prototype.setGridDimensions = function (w, h, d) {
        var midpoint = [w / 2, h / 2, d / 2];
        this.lightPosition[0] = midpoint[0];
        this.lightPosition[1] = midpoint[1];
        this.lightPosition[2] = midpoint[2];
        Utilities.makeLookAtMatrix(this.lightViewMatrix, midpoint, [midpoint[0], midpoint[1] - 1.0, midpoint[2]], [0.0, 0.0, 1.0]);
        this.lightProjectionMatrix = Utilities.makeOrthographicMatrix(new Float32Array(16), -w / 2, w / 2, -d / 2, d / 2, -h / 2, h / 2);
        Utilities.premultiplyMatrix(this.lightProjectionViewMatrix, this.lightViewMatrix, this.lightProjectionMatrix);
    };

    Renderer.prototype.onResize = function (event) {
        var wgl = this.wgl;
        wgl.renderbufferStorage(this.renderingRenderbuffer, wgl.RENDERBUFFER, wgl.DEPTH_COMPONENT16, this.canvas.width, this.canvas.height);
        wgl.rebuildTexture(this.renderingTexture, wgl.RGBA, wgl.FLOAT, this.canvas.width, this.canvas.height, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR); //contains (normal.x, normal.y, speed, depth)

        wgl.rebuildTexture(this.occlusionTexture, wgl.RGBA, wgl.UNSIGNED_BYTE, this.canvas.width, this.canvas.height, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);

        wgl.rebuildTexture(this.compositingTexture, wgl.RGBA, wgl.UNSIGNED_BYTE, this.canvas.width, this.canvas.height, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
    }

    Renderer.prototype.regenerateSphereGeometry = function () {
        var wgl = this.wgl;
        var sphereGeometry = this.sphereGeometry = generateSphereGeometry(this.sphereIterations);
        
        wgl.bufferData(this.sphereVertexBuffer, wgl.ARRAY_BUFFER, new Float32Array(sphereGeometry.vertices), wgl.STATIC_DRAW);
        wgl.bufferData(this.sphereNormalBuffer, wgl.ARRAY_BUFFER, new Float32Array(sphereGeometry.normals), wgl.STATIC_DRAW);
        wgl.bufferData(this.sphereIndexBuffer, wgl.ELEMENT_ARRAY_BUFFER, new Uint16Array(sphereGeometry.indices), wgl.STATIC_DRAW);
    };

    // ============================================================================
    // SECTION 10: EXPORTS
    // ============================================================================

    Renderer.COLOR_PRESETS = COLOR_PRESETS;
    return Renderer;
}());
