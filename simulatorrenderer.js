/**
 * SimulatorRenderer - Coordinates simulation and rendering
 * 
 * WHY THIS EXISTS: Separates physics (Simulator) from rendering (Renderer) so they can
 * be developed independently. This class bridges them by:
 * 1. Converting mouse input to world-space forces for the simulator
 * 2. Calling simulate() then draw() in the correct order each frame
 * 3. Managing the async loading of both systems
 * 
 * CRITICAL ORDER: Must call simulate() BEFORE draw() because draw() reads particle
 * positions/velocities that simulate() updates. Reversing this would show particles
 * one frame behind.
 */
var SimulatorRenderer = (function () {
    
    // ============================================================================
    // SECTION 1: CONSTRUCTOR & INITIALIZATION
    // ============================================================================

    function SimulatorRenderer (canvas, wgl, projectionMatrix, camera, gridDimensions, onLoaded) {
        this.canvas = canvas;
        this.wgl = wgl;
        this.projectionMatrix = projectionMatrix;
        this.camera = camera;

        // WHY: Float textures needed for precise velocity/position storage in simulation grid
        // Half-float (16-bit) would cause precision loss, full float (32-bit) is required
        wgl.getExtension('OES_texture_float');
        wgl.getExtension('OES_texture_float_linear');

        // WHY: Both systems load shaders asynchronously. We must wait for BOTH before
        // starting because renderer needs simulator's textures, and simulator needs to
        // be ready before we can call simulate(). The double-check pattern ensures
        // start() only runs once when the second system finishes loading.
        var rendererLoaded = false,
            simulatorLoaded = false;

        this.renderer = new Renderer(this.canvas, this.wgl, gridDimensions, (function () {
            rendererLoaded = true;  
            if (rendererLoaded && simulatorLoaded) {
                start.call(this);
            }
        }).bind(this));

        this.simulator = new Simulator(this.wgl, (function () {
            simulatorLoaded = true;
            if (rendererLoaded && simulatorLoaded) {
                start.call(this);
            }
        }).bind(this));


        function start () {
            /////////////////////////////////////////////
            // Mouse interaction state
            // WHY: Mouse position normalized to [-1, 1] makes it independent of canvas size
            // This allows mouse forces to work consistently regardless of window dimensions
            this.mouseX = 0;
            this.mouseY = 0;

            // WHY: Mouse plane tracks where mouse was last frame to calculate velocity
            // We project mouse onto a plane at camera distance to get world-space position
            // The plane is orthogonal to view direction so dragging feels natural
            this.lastMousePlaneX = 0;
            this.lastMousePlaneY = 0;

            // WHY: setTimeout ensures DOM is ready and all event handlers can attach
            // Without this, onLoaded might fire before parent code is ready to receive it
            setTimeout(onLoaded, 1);
        }
    }

    // ============================================================================
    // SECTION 2: MOUSE EVENT HANDLERS
    // ============================================================================

    SimulatorRenderer.prototype.onMouseMove = function (event) {
        var position = Utilities.getMousePosition(event, this.canvas);
        var normalizedX = position.x / this.canvas.width;
        var normalizedY = position.y / this.canvas.height;

        this.mouseX = normalizedX * 2.0 - 1.0;
        this.mouseY = (1.0 - normalizedY) * 2.0 - 1.0;

        this.camera.onMouseMove(event);
    };

    SimulatorRenderer.prototype.onMouseDown = function (event) {
        this.camera.onMouseDown(event);
    };

    SimulatorRenderer.prototype.onMouseUp = function (event) {
        this.camera.onMouseUp(event);
    };

    // ============================================================================
    // SECTION 3: UPDATE LOOP
    // ============================================================================

    /**
     * update() - Main frame update: converts mouse input to forces, runs simulation, renders
     * 
     * CRITICAL ORDER:
     * 1. Calculate mouse forces (must happen before simulate)
     * 2. Call simulate() to update particle positions/velocities
     * 3. Call draw() to render the updated particles
     * 
     * WHY THIS ORDER: simulate() writes to particle textures, draw() reads from them.
     * If we drew first, we'd render last frame's state. If we simulated twice, particles
     * would move too fast.
     */
    SimulatorRenderer.prototype.update = function (timeStep) {
        // WHY: Extract FOV from projection matrix element [5] (which is 1/tan(fov/2))
        // This is needed to convert normalized mouse coords to view-space ray
        var fov = 2.0 * Math.atan(1.0 / this.projectionMatrix[5]);

        // WHY: Convert normalized mouse [-1,1] to view-space ray direction
        // The ray goes from camera through mouse position into the scene
        // Z = -1 because view space has camera looking down -Z axis
        var viewSpaceMouseRay = [
            this.mouseX * Math.tan(fov / 2.0) * (this.canvas.width / this.canvas.height),
            this.mouseY * Math.tan(fov / 2.0),
            -1.0];

        // WHY: Project mouse onto plane at camera distance to get world-space position
        // Multiplying by distance moves from "direction" to "position on plane"
        var mousePlaneX = viewSpaceMouseRay[0] * this.camera.distance;
        var mousePlaneY = viewSpaceMouseRay[1] * this.camera.distance;
        
        // WHY: Calculate velocity from position change (delta between frames)
        // This makes dragging feel natural - fast mouse movement = strong force
        var mouseVelocityX = mousePlaneX - this.lastMousePlaneX;
        var mouseVelocityY = mousePlaneY - this.lastMousePlaneY;

        // WHY: Zero velocity when mouse is down because user is dragging camera, not particles
        // Without this, camera rotation would also push particles, which feels wrong
        if (this.camera.isMouseDown()) {
            mouseVelocityX = 0.0;
            mouseVelocityY = 0.0;
        }

        // WHY: Store for next frame's velocity calculation
        this.lastMousePlaneX = mousePlaneX;
        this.lastMousePlaneY = mousePlaneY;

        // WHY: Transform view-space ray to world space so simulator knows where mouse is
        // Simulator works in world coordinates, not view coordinates
        var inverseViewMatrix = Utilities.invertMatrix([], this.camera.getViewMatrix());
        var worldSpaceMouseRay = Utilities.transformDirectionByMatrix([], viewSpaceMouseRay, inverseViewMatrix);
        Utilities.normalizeVector(worldSpaceMouseRay, worldSpaceMouseRay);

        // WHY: Extract camera right/up vectors from view matrix columns
        // These define the plane we project mouse onto (orthogonal to view direction)
        var cameraViewMatrix = this.camera.getViewMatrix();
        var cameraRight = [cameraViewMatrix[0], cameraViewMatrix[4], cameraViewMatrix[8]];
        var cameraUp = [cameraViewMatrix[1], cameraViewMatrix[5], cameraViewMatrix[9]];

        // WHY: Convert mouse velocity from screen space to world space
        // Multiply screen-space velocity by camera right/up to get world-space force direction
        var mouseVelocity = [];
        // WHY: Disable particle pushing in free cam mode - user is flying, not interacting
        if (this.camera.freeCamMode) {
            mouseVelocity = [0, 0, 0];
        } else {
            for (var i = 0; i < 3; ++i) {
                mouseVelocity[i] = mouseVelocityX * cameraRight[i] + mouseVelocityY * cameraUp[i];
            }
        }

        // WHY: Calculate exact mouse position in world space for force application
        // Simulator needs this to apply forces at the correct location
        var cameraPosition = this.camera.getPosition();
        var mousePosition = [];
        for (var i = 0; i < 3; ++i) {
            mousePosition[i] = cameraPosition[i] + mousePlaneX * cameraRight[i] + mousePlaneY * cameraUp[i];
        }

        // CRITICAL: Must set mousePosition before simulate() so simulator can use it
        this.simulator.mousePosition = mousePosition;
        
        // STEP 1: Run physics simulation (updates particle positions/velocities)
        this.simulator.simulate(timeStep, mouseVelocity, this.camera.getPosition(), worldSpaceMouseRay);
        
        // STEP 2: Render the updated particles (reads what simulate() just wrote)
        this.renderer.draw(this.simulator, this.projectionMatrix, this.camera.getViewMatrix(), this.camera.getPosition());
    }

    // ============================================================================
    // SECTION 4: RESET & RESIZE
    // ============================================================================

    SimulatorRenderer.prototype.reset = function (particlesWidth, particlesHeight, particlePositions, gridSize, gridResolution, particleDensity, sphereRadius) {
        this.renderer.setGridDimensions(gridSize[0], gridSize[1], gridSize[2]);
        this.simulator.reset(particlesWidth, particlesHeight, particlePositions, gridSize, gridResolution, particleDensity);
        this.renderer.reset(particlesWidth, particlesHeight, sphereRadius);
    }

    SimulatorRenderer.prototype.onResize = function (event) {
        this.renderer.onResize(event);
    }

    return SimulatorRenderer;
}());
