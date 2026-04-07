'use strict'

/**
 * Simulator - FLIP/PIC fluid physics simulation
 * 
 * WHY FLIP/PIC: Combines Particle-In-Cell (PIC) stability with FLIP detail.
 * - PIC: Particles transfer velocity to grid, grid solves pressure, particles get grid velocity
 * - FLIP: Particles keep their own velocity, only get DIFFERENCE from grid (preserves detail)
 * - flipness=0.99 means 99% FLIP (detail) + 1% PIC (stability) = best of both
 * 
 * WHY STAGGERED MAC GRID:
 * - MAC = Marker-And-Cell (Harlow & Welch, 1965)
 * - Staggered = velocities stored on cell FACES, not cell centers
 * - WHY: Prevents pressure checkerboard artifacts (alternating high/low pressure)
 * - Face-centered storage naturally enforces incompressibility at boundaries
 * 
 * GRID LAYOUT:
 * - World space: [0, 0, 0] to [gridWidth, gridHeight, gridDepth] (world units)
 * - Grid space: [0, 0, 0] to [gridResolutionX, gridResolutionY, gridResolutionZ] (cell indices)
 * - Cell boundaries: integer values in grid space (simple!)
 * 
 * TEXTURE LAYOUT (WebGL limitation - no 3D textures):
 * - 3D textures emulated as 2D: z-slices laid out along X axis
 * - Velocity texture: [width*depth, height] where width = gridResolution+1 (staggered)
 * - Scalar texture: [width*depth, height] where width = gridResolution
 */
var Simulator = (function () {

    /*
     * STAGGERED MAC GRID EXPLANATION:
     * 
     * WHY velocities on faces, not centers:
     * - X-velocity at [i, j+0.5, k+0.5] = on face between cells [i,j,k] and [i+1,j,k]
     * - Y-velocity at [i+0.5, j, k+0.5] = on face between cells [i,j,k] and [i,j+1,k]
     * - Z-velocity at [i+0.5, j+0.5, k] = on face between cells [i,j,k] and [i,j,k+1]
     * 
     * WHY this matters:
     * - Pressure gradient naturally computed as difference across face
     * - Divergence calculation uses face velocities (no interpolation needed)
     * - Boundary conditions simpler (velocity = 0 at wall faces)
     * 
     * Grid size: velocity grid is (resolution+1) in each dimension because we need
     * one face velocity per cell edge. Example: 40 cells need 41 face velocities.
     */

    // ============================================================================
    // SECTION 1: CONSTANTS & GRID CONFIGURATION
    // ============================================================================

    // ============================================================================
    // SECTION 2: CONSTRUCTOR & INITIALIZATION
    // ============================================================================

    function Simulator (wgl, onLoaded) {
        this.wgl = wgl;

        this.particlesWidth = 0;
        this.particlesHeight = 0;
        
        this.gridWidth = 0;
        this.gridHeight = 0;
        this.gridDepth = 0;

        this.gridResolutionX = 0;
        this.gridResolutionY = 0;
        this.gridResolutionZ = 0;

        this.particleDensity = 0;

        this.velocityTextureWidth = 0;
        this.velocityTextureHeight = 0;

        this.scalarTextureWidth = 0;
        this.scalarTextureHeight = 0;

        
        this.halfFloatExt = this.wgl.getExtension('OES_texture_half_float');
        this.wgl.getExtension('OES_texture_half_float_linear');

        this.simulationNumberType = this.halfFloatExt.HALF_FLOAT_OES;


        ///////////////////////////////////////////////////////
        // simulation parameters

        // WHY 0.99 not 1.0: Pure FLIP (1.0) can be unstable with large timesteps.
        // Small PIC component (0.01) adds damping that prevents explosion.
        // 0.99 = 99% FLIP detail + 1% PIC stability = industry standard
        this.flipness = 0.99; //0 is full PIC, 1 is full FLIP

        // WHY: Gravity in addforce.frag applies -40.0 * gravity * timeStep to Y velocity
        // Negative values flip gravity (up), 0 = zero G, positive = normal down
        this.gravity = 1.0; // 1=normal down, 0=zero G, negative=flip

        // WHY: Multiplier for mouse force strength. Higher = stronger particle pushing
        this.mouseStrength = 3.0; // Mouse interaction strength multiplier
        this.mouseMode = 0; // 0=repel, 1=vortex, 2=attract
        this.mousePosition = [0, 0, 0]; // Mouse position in world space

        // WHY: Used for random motion in shaders (frameNumber % someValue for variation)
        this.frameNumber = 0; //used for motion randomness

        
        /////////////////////////////////////////////////
        // simulation objects (most are filled in by reset)

        this.quadVertexBuffer = wgl.createBuffer();
        wgl.bufferData(this.quadVertexBuffer, wgl.ARRAY_BUFFER, new Float32Array([-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0]), wgl.STATIC_DRAW);

        this.simulationFramebuffer = wgl.createFramebuffer();
        this.particleVertexBuffer = wgl.createBuffer();


        this.particlePositionTexture = wgl.createTexture();
        this.particlePositionTextureTemp = wgl.createTexture();


        this.particleVelocityTexture = wgl.createTexture();
        this.particleVelocityTextureTemp = wgl.createTexture();

        this.particleRandomTexture = wgl.createTexture(); //contains a random normalized direction for each particle



        ////////////////////////////////////////////////////
        // create simulation textures

        this.velocityTexture = wgl.createTexture();
        this.tempVelocityTexture = wgl.createTexture();
        this.originalVelocityTexture = wgl.createTexture();
        this.weightTexture = wgl.createTexture();

        this.markerTexture = wgl.createTexture(); //marks fluid/air, 1 if fluid, 0 if air
        this.divergenceTexture = wgl.createTexture();
        this.pressureTexture = wgl.createTexture();
        this.tempSimulationTexture = wgl.createTexture();



        /////////////////////////////
        // load programs


        // ============================================================================
        // SECTION 4: SHADER PROGRAM LOADING
        // ============================================================================
        // NOTE: Texture creation happens in reset() method (Section 5) when particle count is known.
        // Textures are rebuilt each time reset() is called with new dimensions.

        wgl.createProgramsFromFiles({
            transferToGridProgram: {
                vertexShader: 'shaders/transfertogrid.vert',
                fragmentShader: ['shaders/common.frag', 'shaders/transfertogrid.frag'],
                attributeLocations: { 'a_textureCoordinates': 0}
            },
            normalizeGridProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: 'shaders/normalizegrid.frag',
                attributeLocations: { 'a_position': 0}
            },
            markProgram: {
                vertexShader: 'shaders/mark.vert',
                fragmentShader: 'shaders/mark.frag',
                attributeLocations: { 'a_textureCoordinates': 0}
            },
            addForceProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: ['shaders/common.frag', 'shaders/addforce.frag'],
                attributeLocations: { 'a_position': 0}
            },
            enforceBoundariesProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: ['shaders/common.frag', 'shaders/enforceboundaries.frag'],
                attributeLocations: { 'a_textureCoordinates': 0 }
            },
            extendVelocityProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: 'shaders/extendvelocity.frag',
                attributeLocations: { 'a_textureCoordinates': 0 }
            },
            transferToParticlesProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: ['shaders/common.frag', 'shaders/transfertoparticles.frag'],
                attributeLocations: { 'a_position': 0}
            },
            divergenceProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: ['shaders/common.frag', 'shaders/divergence.frag'],
                attributeLocations: { 'a_position': 0}
            },
            jacobiProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: ['shaders/common.frag', 'shaders/jacobi.frag'],
                attributeLocations: { 'a_position': 0}
            },
            subtractProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: ['shaders/common.frag', 'shaders/subtract.frag'],
                attributeLocations: { 'a_position': 0}
            },
            advectProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: ['shaders/common.frag', 'shaders/advect.frag'],
                attributeLocations: { 'a_position': 0}
            },
            copyProgram: {
                vertexShader: 'shaders/fullscreen.vert',
                fragmentShader: 'shaders/copy.frag',
                attributeLocations: { 'a_position': 0}
            }
        }, (function (programs) {
            for (var programName in programs) {
                this[programName] = programs[programName];
            }

            onLoaded();
        }).bind(this));
    }


    // ============================================================================
    // SECTION 5: RESET & PARTICLE INITIALIZATION
    // ============================================================================

    //expects an array of [x, y, z] particle positions
    //gridSize and gridResolution are both [x, y, z]

    //particleDensity is particles per simulation grid cell
    Simulator.prototype.reset = function (particlesWidth, particlesHeight, particlePositions, gridSize, gridResolution, particleDensity) {

        this.particlesWidth = particlesWidth;
        this.particlesHeight = particlesHeight;

        this.gridWidth = gridSize[0];
        this.gridHeight = gridSize[1];
        this.gridDepth = gridSize[2];

        this.gridResolutionX = gridResolution[0];
        this.gridResolutionY = gridResolution[1];
        this.gridResolutionZ = gridResolution[2];

        this.particleDensity = particleDensity;

        this.velocityTextureWidth = (this.gridResolutionX + 1) * (this.gridResolutionZ + 1);
        this.velocityTextureHeight = (this.gridResolutionY + 1);

        this.scalarTextureWidth = this.gridResolutionX * this.gridResolutionZ;
        this.scalarTextureHeight = this.gridResolutionY;



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

        //generate initial particle positions amd create particle position texture for them
        var particlePositionsData = new Float32Array(this.particlesWidth * this.particlesHeight * 4);
        var particleRandoms = new Float32Array(this.particlesWidth * this.particlesHeight * 4);
        for (var i = 0; i < this.particlesWidth * this.particlesHeight; ++i) {
            particlePositionsData[i * 4] = particlePositions[i][0];
            particlePositionsData[i * 4 + 1] = particlePositions[i][1];
            particlePositionsData[i * 4 + 2] = particlePositions[i][2];
            particlePositionsData[i * 4 + 3] = 0.0;

            var theta = Math.random() * 2.0 * Math.PI;
            var u = Math.random() * 2.0 - 1.0;
            particleRandoms[i * 4] = Math.sqrt(1.0 - u * u) * Math.cos(theta);
            particleRandoms[i * 4 + 1] = Math.sqrt(1.0 - u * u) * Math.sin(theta);
            particleRandoms[i * 4 + 2] = u;
            particleRandoms[i * 4 + 3] = 0.0;
        }

        wgl.rebuildTexture(this.particlePositionTexture, wgl.RGBA, wgl.FLOAT, this.particlesWidth, this.particlesHeight, particlePositionsData, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);
        wgl.rebuildTexture(this.particlePositionTextureTemp, wgl.RGBA, wgl.FLOAT, this.particlesWidth, this.particlesHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);


        wgl.rebuildTexture(this.particleVelocityTexture, wgl.RGBA, this.simulationNumberType, this.particlesWidth, this.particlesHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);
        wgl.rebuildTexture(this.particleVelocityTextureTemp, wgl.RGBA, this.simulationNumberType, this.particlesWidth, this.particlesHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST);

        wgl.rebuildTexture(this.particleRandomTexture, wgl.RGBA, wgl.FLOAT, this.particlesWidth, this.particlesHeight, particleRandoms, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.NEAREST, wgl.NEAREST); //contains a random normalized direction for each particle



        ////////////////////////////////////////////////////
        // create simulation textures

        wgl.rebuildTexture(this.velocityTexture, wgl.RGBA, this.simulationNumberType, this.velocityTextureWidth, this.velocityTextureHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
        wgl.rebuildTexture(this.tempVelocityTexture, wgl.RGBA, this.simulationNumberType, this.velocityTextureWidth, this.velocityTextureHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
        wgl.rebuildTexture(this.originalVelocityTexture, wgl.RGBA, this.simulationNumberType, this.velocityTextureWidth, this.velocityTextureHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
        wgl.rebuildTexture(this.weightTexture, wgl.RGBA, this.simulationNumberType, this.velocityTextureWidth, this.velocityTextureHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);

        wgl.rebuildTexture(this.markerTexture, wgl.RGBA, wgl.UNSIGNED_BYTE, this.scalarTextureWidth, this.scalarTextureHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR); //marks fluid/air, 1 if fluid, 0 if air
        wgl.rebuildTexture(this.divergenceTexture, wgl.RGBA, this.simulationNumberType, this.scalarTextureWidth, this.scalarTextureHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
        wgl.rebuildTexture(this.pressureTexture, wgl.RGBA, this.simulationNumberType, this.scalarTextureWidth, this.scalarTextureHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);
        wgl.rebuildTexture(this.tempSimulationTexture, wgl.RGBA, this.simulationNumberType, this.scalarTextureWidth, this.scalarTextureHeight, null, wgl.CLAMP_TO_EDGE, wgl.CLAMP_TO_EDGE, wgl.LINEAR, wgl.LINEAR);


    }

    // ============================================================================
    // SECTION 6: SIMULATION PIPELINE (simulate method)
    // ============================================================================

    /**
     * simulate() - Run one physics timestep
     * 
     * CRITICAL PIPELINE ORDER (DO NOT CHANGE):
     * 1. Transfer particles → grid (splat particle velocities to staggered MAC grid)
     * 2. Normalize grid (divide accumulated velocity by weights)
     * 3. Mark fluid cells (which cells contain particles)
     * 4. Add forces (gravity, mouse, future: jets, wind)
     * 5. Enforce boundaries (zero velocity at walls, future: obstacles)
     * 6. Compute divergence (for pressure solve)
     * 7. Solve pressure (Jacobi iterations to make velocity divergence-free)
     * 8. Subtract pressure gradient (apply pressure correction to velocity)
     * 9. Transfer grid → particles (FLIP blend: particles get velocity difference)
     * 10. Advect particles (move particles through velocity field using RK2)
     * 
     * WHY THIS ORDER:
     * - Forces must be added BEFORE pressure solve (pressure corrects the forced velocity)
     * - Boundaries must be enforced BEFORE divergence (divergence needs correct boundary conditions)
     * - Pressure solve must happen BEFORE transferring to particles (particles need corrected velocity)
     * - Advection must be LAST (particles move based on final corrected velocity)
     * 
     * Changing order = broken physics (particles explode, flow wrong direction, etc.)
     */
    Simulator.prototype.simulate = function (timeStep, mouseVelocity, mouseRayOrigin, mouseRayDirection) {
        // WHY: Early return if paused (timeStep = 0). Prevents unnecessary GPU work.
        // NOTE: In simulatorrenderer.js, we ensure timeStep >= 1/600 when running
        // so physics (gravity) always applies even when speed slider is at 0%
        if (timeStep === 0.0) return;

        this.frameNumber += 1;

        var wgl = this.wgl;


        //////////////////////////////////////////////////////
        // STEP 1: Transfer particle velocities to grid (PIC/FLIP splatting)
        //
        // WHY TWO-PASS SPLATTING:
        // - Pass 1: Accumulate weights (how many particles contribute to each grid cell)
        // - Pass 2: Accumulate weighted velocities (sum of velocity * weight)
        // - Normalize: velocity = weightedSum / weightSum (average velocity per cell)
        //
        // WHY NOT ONE PASS: Can't divide during accumulation (GPU limitation).
        // Must accumulate sums first, then divide in separate pass.
        //
        // WHY SPLAT DEPTH = 5: Each particle affects 5 Z-layers of grid cells.
        // This creates smooth velocity field even with sparse particles.
        // Too few = choppy, too many = expensive and blurry

        var transferToGridDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.velocityTextureWidth, this.velocityTextureHeight)

            .vertexAttribPointer(this.particleVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)

            .useProgram(this.transferToGridProgram)
            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ)
            .uniform3f('u_gridSize', this.gridWidth, this.gridHeight, this.gridDepth)
            .uniformTexture('u_positionTexture', 0, wgl.TEXTURE_2D, this.particlePositionTexture)
            .uniformTexture('u_velocityTexture', 1, wgl.TEXTURE_2D, this.particleVelocityTexture)

            .enable(wgl.BLEND)
            .blendEquation(wgl.FUNC_ADD)
            .blendFuncSeparate(wgl.ONE, wgl.ONE, wgl.ONE, wgl.ONE);


        //accumulate weight
        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.weightTexture, 0);

        wgl.clear(
            wgl.createClearState().bindFramebuffer(this.simulationFramebuffer).clearColor(0, 0, 0, 0),
            wgl.COLOR_BUFFER_BIT);

        transferToGridDrawState.uniform1i('u_accumulate', 0)

        // WHY 5 layers: Particles are 3D but grid is discrete. Splatting across 5 Z-layers
        // ensures smooth velocity field. Each particle contributes to cells at:
        // z-2, z-1, z, z+1, z+2 (centered on particle's Z position)
        var SPLAT_DEPTH = 5;

        for (var z = -(SPLAT_DEPTH - 1) / 2; z <= (SPLAT_DEPTH - 1) / 2; ++z) {
            transferToGridDrawState.uniform1f('u_zOffset', z);
            wgl.drawArrays(transferToGridDrawState, wgl.POINTS, 0, this.particlesWidth * this.particlesHeight);
        }

        //accumulate (weight * velocity)
        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.tempVelocityTexture, 0);
        wgl.clear(
            wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),
            wgl.COLOR_BUFFER_BIT);

        transferToGridDrawState.uniform1i('u_accumulate', 1)

        for (var z = -(SPLAT_DEPTH - 1) / 2; z <= (SPLAT_DEPTH - 1) / 2; ++z) {
            transferToGridDrawState.uniform1f('u_zOffset', z);
            wgl.drawArrays(transferToGridDrawState, wgl.POINTS, 0, this.particlesWidth * this.particlesHeight);
        }


        //in the second step, we divide sum(weight * velocity) by sum(weight) (the two accumulated quantities from before)

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.velocityTexture, 0);

        var normalizeDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.velocityTextureWidth, this.velocityTextureHeight)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)

            .useProgram(this.normalizeGridProgram)
            .uniformTexture('u_weightTexture', 0, wgl.TEXTURE_2D, this.weightTexture)
            .uniformTexture('u_accumulatedVelocityTexture', 1, wgl.TEXTURE_2D, this.tempVelocityTexture)

        wgl.drawArrays(normalizeDrawState, wgl.TRIANGLE_STRIP, 0, 4);


        //////////////////////////////////////////////////////
        // STEP 3: Mark cells with fluid
        //
        // WHY: Pressure solve only needs to run in cells that contain fluid.
        // Air cells (no particles) should have zero pressure. This texture marks
        // which cells are fluid (1) vs air (0) so pressure solver knows where to work.
        // Future: Can extend to mark solid cells (obstacles) with different value.

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.markerTexture, 0);
        wgl.clear(
            wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),
            wgl.COLOR_BUFFER_BIT);

        var markDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.scalarTextureWidth, this.scalarTextureHeight)

            .vertexAttribPointer(this.particleVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)

            .useProgram(this.markProgram)
            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ)
            .uniform3f('u_gridSize', this.gridWidth, this.gridHeight, this.gridDepth)
            .uniformTexture('u_positionTexture', 0, wgl.TEXTURE_2D, this.particlePositionTexture);

        wgl.drawArrays(markDrawState, wgl.POINTS, 0, this.particlesWidth * this.particlesHeight);

        ////////////////////////////////////////////////////
        // STEP 4: Save original velocity grid (CRITICAL FOR FLIP)
        //
        // WHY: FLIP method needs the velocity BEFORE pressure correction.
        // Later, we'll give particles the DIFFERENCE between new and old velocity.
        // This preserves particle detail while still getting pressure stability.
        // Formula: particleVelocity += (newGridVelocity - oldGridVelocity) * flipness
        // Without saving original, we can't compute the difference.

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.originalVelocityTexture, 0);

        var copyDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.velocityTextureWidth, this.velocityTextureHeight)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)

            .useProgram(this.copyProgram)
            .uniformTexture('u_texture', 0, wgl.TEXTURE_2D, this.velocityTexture)

        wgl.drawArrays(copyDrawState, wgl.TRIANGLE_STRIP, 0, 4);


        /////////////////////////////////////////////////////
        // STEP 5: Add forces to velocity grid
        //
        // WHY BEFORE PRESSURE SOLVE: Forces (gravity, mouse, future: jets/wind) modify
        // velocity. Pressure solve then corrects this forced velocity to be incompressible.
        // If we solved pressure first, forces would break incompressibility.
        //
        // Forces applied:
        // - Gravity: -40.0 * gravity * timeStep in Y direction (addforce.frag)
        // - Mouse: Velocity-based force at mouse position (repel/vortex/attract modes)
        // Future: Jets (velocity sources), wind zones (directional force in AABB)

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.tempVelocityTexture, 0);

        var addForceDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.velocityTextureWidth, this.velocityTextureHeight)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)

            .useProgram(this.addForceProgram)
            .uniformTexture('u_velocityTexture', 0, wgl.TEXTURE_2D, this.velocityTexture)

            .uniform1f('u_timeStep', timeStep)
            .uniform1f('u_gravity', typeof this.gravity === 'number' ? this.gravity : 1.0)
            .uniform1f('u_mouseStrength', typeof this.mouseStrength === 'number' ? this.mouseStrength : 3.0)
            .uniform1f('u_mouseMode', typeof this.mouseMode === 'number' ? this.mouseMode : 0.0)

            .uniform3f('u_mouseVelocity', mouseVelocity[0], mouseVelocity[1], mouseVelocity[2])

            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ)
            .uniform3f('u_gridSize', this.gridWidth, this.gridHeight, this.gridDepth)

            .uniform3f('u_mouseRayOrigin', mouseRayOrigin[0], mouseRayOrigin[1], mouseRayOrigin[2])
            .uniform3f('u_mouseRayDirection', mouseRayDirection[0], mouseRayDirection[1], mouseRayDirection[2])
            .uniform3f('u_mousePosition', this.mousePosition[0], this.mousePosition[1], this.mousePosition[2])


        wgl.drawArrays(addForceDrawState, wgl.TRIANGLE_STRIP, 0, 4);

        swap(this, 'velocityTexture', 'tempVelocityTexture');

        
        /////////////////////////////////////////////////////
        // STEP 6: Enforce boundary velocity conditions
        //
        // WHY BEFORE DIVERGENCE: Boundaries must be set BEFORE computing divergence.
        // Divergence calculation uses face velocities - if boundary faces have wrong
        // velocity, divergence will be wrong, pressure solve will be wrong.
        //
        // Current: Zero velocity at walls (no-slip boundary condition)
        // Future: Obstacles (spheres/boxes) will also set velocity = 0 at their faces

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.tempVelocityTexture, 0);

        var enforceBoundariesDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.velocityTextureWidth, this.velocityTextureHeight)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)

            .useProgram(this.enforceBoundariesProgram)
            .uniformTexture('u_velocityTexture', 0, wgl.TEXTURE_2D, this.velocityTexture)
            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ);

        wgl.drawArrays(enforceBoundariesDrawState, wgl.TRIANGLE_STRIP, 0, 4);

        swap(this, 'velocityTexture', 'tempVelocityTexture');


        /////////////////////////////////////////////////////
        // STEP 7-9: Pressure projection (make velocity divergence-free)
        //
        // WHY: Incompressible fluid means div(velocity) = 0 everywhere.
        // After adding forces, velocity field has divergence (fluid compresses/expands).
        // Pressure projection corrects this by subtracting pressure gradient.
        //
        // Process:
        // 7. Compute divergence (how much fluid is compressing/expanding per cell)
        // 8. Solve pressure (Poisson equation: ∇²p = div(velocity))
        // 9. Subtract pressure gradient (velocity -= ∇p, makes div(velocity) = 0)

         // STEP 7: Compute divergence for pressure projection

        var divergenceDrawState = wgl.createDrawState()
            
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.scalarTextureWidth, this.scalarTextureHeight)

            .useProgram(this.divergenceProgram)
            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ)
            .uniformTexture('u_velocityTexture', 0, wgl.TEXTURE_2D, this.velocityTexture)
            .uniformTexture('u_markerTexture', 1, wgl.TEXTURE_2D, this.markerTexture)
            .uniformTexture('u_weightTexture', 2, wgl.TEXTURE_2D, this.weightTexture)

            .uniform1f('u_maxDensity', this.particleDensity)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, false, 0, 0)

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.divergenceTexture, 0);
        wgl.clear(
            wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),
            wgl.COLOR_BUFFER_BIT);
        
        wgl.drawArrays(divergenceDrawState, wgl.TRIANGLE_STRIP, 0, 4);
        
        
        // STEP 8: Compute pressure via Jacobi iteration
        //
        // WHY JACOBI: Poisson equation (∇²p = div) is solved iteratively.
        // Jacobi method: each cell's pressure = average of neighbors + divergence term.
        // Iterate until pressure field converges (satisfies Poisson equation).
        //
        // WHY 50 ITERATIONS: Trade-off between accuracy and speed.
        // More iterations = more accurate (closer to true incompressible), but slower.
        // 50 is standard for real-time fluid - good enough visually, fast enough for 60fps.
        // Too few (<20) = visible compression artifacts. Too many (>100) = unnecessary cost.

        var jacobiDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.scalarTextureWidth, this.scalarTextureHeight)

            .useProgram(this.jacobiProgram)
            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ)
            .uniformTexture('u_divergenceTexture', 1, wgl.TEXTURE_2D, this.divergenceTexture)
            .uniformTexture('u_markerTexture', 2, wgl.TEXTURE_2D, this.markerTexture)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, false, 0, 0)


        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.pressureTexture, 0);
        wgl.clear(
            wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),
            wgl.COLOR_BUFFER_BIT);
        var PRESSURE_JACOBI_ITERATIONS = 50;
        for (var i = 0; i < PRESSURE_JACOBI_ITERATIONS; ++i) {
            wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.tempSimulationTexture, 0);
            jacobiDrawState.uniformTexture('u_pressureTexture', 0, wgl.TEXTURE_2D, this.pressureTexture);
            
            wgl.drawArrays(jacobiDrawState, wgl.TRIANGLE_STRIP, 0, 4);
            
            swap(this, 'pressureTexture', 'tempSimulationTexture');
        }
        
        
        // STEP 9: Subtract pressure gradient from velocity
        //
        // WHY: This is the pressure correction step. Pressure gradient points in direction
        // that will cancel divergence. Subtracting it from velocity makes velocity
        // divergence-free (incompressible). Formula: velocity -= ∇p
        //
        // After this step: div(velocity) ≈ 0 (fluid no longer compresses/expands)

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.tempVelocityTexture, 0);

        var subtractDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.velocityTextureWidth, this.velocityTextureHeight)

            .useProgram(this.subtractProgram)
            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ)
            .uniformTexture('u_pressureTexture', 0, wgl.TEXTURE_2D, this.pressureTexture)
            .uniformTexture('u_velocityTexture', 1, wgl.TEXTURE_2D, this.velocityTexture)
            .uniformTexture('u_markerTexture', 2, wgl.TEXTURE_2D, this.markerTexture)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, false, 0, 0)
        
        wgl.drawArrays(subtractDrawState, wgl.TRIANGLE_STRIP, 0, 4);
        
        swap(this, 'velocityTexture', 'tempVelocityTexture');

        /////////////////////////////////////////////////////////////
        // STEP 10: Transfer velocities back to particles (FLIP blend)
        //
        // WHY FLIP BLEND: Particles keep their own velocity detail, but get stability from grid.
        // Formula: particleVelocity += (newGridVelocity - oldGridVelocity) * flipness
        //
        // - flipness = 0.99 means 99% of velocity change comes from grid (FLIP detail)
        // - 1% comes from direct grid velocity (PIC stability)
        // - This preserves particle turbulence while getting pressure correction benefits
        //
        // WHY NOT JUST SET particleVelocity = gridVelocity: That's pure PIC - loses all
        // particle detail (turbulence, small-scale motion). FLIP preserves it.

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.particleVelocityTextureTemp, 0);

        var transferToParticlesDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.particlesWidth, this.particlesHeight)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)

            .useProgram(this.transferToParticlesProgram)
            .uniformTexture('u_particlePositionTexture', 0, wgl.TEXTURE_2D, this.particlePositionTexture)
            .uniformTexture('u_particleVelocityTexture', 1, wgl.TEXTURE_2D, this.particleVelocityTexture)
            .uniformTexture('u_gridVelocityTexture', 2, wgl.TEXTURE_2D, this.velocityTexture)
            .uniformTexture('u_originalGridVelocityTexture', 3, wgl.TEXTURE_2D, this.originalVelocityTexture)
            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ)
            .uniform3f('u_gridSize', this.gridWidth, this.gridHeight, this.gridDepth)

            .uniform1f('u_flipness', this.flipness)

        wgl.drawArrays(transferToParticlesDrawState, wgl.TRIANGLE_STRIP, 0, 4);

        swap(this, 'particleVelocityTextureTemp', 'particleVelocityTexture');

        ///////////////////////////////////////////////
        // STEP 11: Advect particle positions with velocity grid using RK2
        //
        // WHY LAST: Particles must move AFTER getting their updated velocity.
        // Order: update velocity → then move particles. Reversing = particles move with old velocity.
        //
        // WHY RK2 (Runge-Kutta 2nd order): More accurate than Euler (simple position += velocity * dt).
        // RK2: Move halfway, sample velocity there, then move full step with that velocity.
        // This reduces error when velocity field changes rapidly (curved flow paths).
        // Euler would cause particles to "overshoot" in curved flows.
        //
        // Future: Can add obstacle push-out here (if particle inside obstacle, push it out)

        wgl.framebufferTexture2D(this.simulationFramebuffer, wgl.FRAMEBUFFER, wgl.COLOR_ATTACHMENT0, wgl.TEXTURE_2D, this.particlePositionTextureTemp, 0);
        wgl.clear(
            wgl.createClearState().bindFramebuffer(this.simulationFramebuffer),
            wgl.COLOR_BUFFER_BIT);

        var advectDrawState = wgl.createDrawState()
            .bindFramebuffer(this.simulationFramebuffer)
            .viewport(0, 0, this.particlesWidth, this.particlesHeight)

            .vertexAttribPointer(this.quadVertexBuffer, 0, 2, wgl.FLOAT, wgl.FALSE, 0, 0)

            .useProgram(this.advectProgram)
            .uniformTexture('u_positionsTexture', 0, wgl.TEXTURE_2D, this.particlePositionTexture)
            .uniformTexture('u_randomsTexture', 1, wgl.TEXTURE_2D, this.particleRandomTexture)
            .uniformTexture('u_velocityGrid', 2, wgl.TEXTURE_2D, this.velocityTexture)
            .uniform3f('u_gridResolution', this.gridResolutionX, this.gridResolutionY, this.gridResolutionZ)
            .uniform3f('u_gridSize', this.gridWidth, this.gridHeight, this.gridDepth)
            .uniform1f('u_timeStep', timeStep)
            .uniform1f('u_frameNumber', this.frameNumber)
            .uniform2f('u_particlesResolution', this.particlesWidth, this.particlesHeight);

        wgl.drawArrays(advectDrawState, wgl.TRIANGLE_STRIP, 0, 4);

        swap(this, 'particlePositionTextureTemp', 'particlePositionTexture');
    }

    // ============================================================================
    // SECTION 7: UTILITY FUNCTIONS
    // ============================================================================

    function swap (object, a, b) {
        var temp = object[a];
        object[a] = object[b];
        object[b] = temp;
    }

    return Simulator;
}());
