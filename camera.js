'use strict'

var Camera = (function () {
    var SENSITIVITY = 0.005;
    var MOVE_SPEED = 0.5;

    var MIN_DISTANCE = 10.0;
    var MAX_DISTANCE = 240.0;

    function Camera (element, orbitPoint) {
        this.element = element;
        this.distance = 40.0;
        this.orbitPoint = orbitPoint;

        this.azimuth = 0.0,
        this.elevation = 0.25

        this.minElevation = -Math.PI / 2;
        this.maxElevation = Math.PI / 2;

        this.currentMouseX = 0,
        this.currentMouseY = 0;

        this.lastMouseX = 0,
        this.lastMouseY = 0;

        this.mouseDown = false;
        this.freeCamMode = false;
        this.mouseLookActive = false;
        
        this.keys = {
            w: false,
            a: false,
            s: false,
            d: false,
            q: false,
            e: false
        };

        this.viewMatrix = new Float32Array(16);


        this.recomputeViewMatrix();


        element.addEventListener('wheel', (function (event) {
            var scrollDelta = event.deltaY;
            this.distance += ((scrollDelta > 0) ? 1 : -1) * 2.0;

            if (this.distance < MIN_DISTANCE) this.distance = MIN_DISTANCE;
            if (this.distance > MAX_DISTANCE) this.distance = MAX_DISTANCE;

            this.recomputeViewMatrix();
        }).bind(this));
        
        // Handle pointer lock for FPS-style controls
        var self = this;
        document.addEventListener('pointerlockchange', function() {
            if (document.pointerLockElement === element && self.freeCamMode) {
                self.mouseLookActive = true;
            } else {
                self.mouseLookActive = false;
            }
        });
        
        document.addEventListener('mousemove', (function (event) {
            if (this.freeCamMode && this.mouseLookActive && document.pointerLockElement === this.element) {
                // Use movementX/Y for pointer lock, more accurate for FPS
                var deltaX = event.movementX || 0;
                var deltaY = event.movementY || 0;
                
                if (deltaX !== 0 || deltaY !== 0) {
                    this.azimuth += deltaX * SENSITIVITY;
                    this.elevation += deltaY * SENSITIVITY;
                    
                    if (this.elevation > this.maxElevation) this.elevation = this.maxElevation;
                    if (this.elevation < this.minElevation) this.elevation = this.minElevation;
                    
                    this.recomputeViewMatrix();
                }
            }
        }).bind(this), false);
    };

    Camera.prototype.recomputeViewMatrix = function () {
        var xRotationMatrix = new Float32Array(16),
            yRotationMatrix = new Float32Array(16),
            distanceTranslationMatrix = Utilities.makeIdentityMatrix(new Float32Array(16)),
            orbitTranslationMatrix = Utilities.makeIdentityMatrix(new Float32Array(16));

        Utilities.makeIdentityMatrix(this.viewMatrix);

        Utilities.makeXRotationMatrix(xRotationMatrix, this.elevation);
        Utilities.makeYRotationMatrix(yRotationMatrix, this.azimuth);
        distanceTranslationMatrix[14] = -this.distance;
        orbitTranslationMatrix[12] = -this.orbitPoint[0];
        orbitTranslationMatrix[13] = -this.orbitPoint[1];
        orbitTranslationMatrix[14] = -this.orbitPoint[2];

        Utilities.premultiplyMatrix(this.viewMatrix, this.viewMatrix, orbitTranslationMatrix);
        Utilities.premultiplyMatrix(this.viewMatrix, this.viewMatrix, yRotationMatrix);
        Utilities.premultiplyMatrix(this.viewMatrix, this.viewMatrix, xRotationMatrix);
        Utilities.premultiplyMatrix(this.viewMatrix, this.viewMatrix, distanceTranslationMatrix);
    };

    Camera.prototype.getPosition = function () {
        var position = [
            this.distance * Math.sin(Math.PI / 2 - this.elevation) * Math.sin(-this.azimuth) + this.orbitPoint[0],
            this.distance * Math.cos(Math.PI / 2 - this.elevation) + this.orbitPoint[1],
            this.distance * Math.sin(Math.PI / 2 - this.elevation) * Math.cos(-this.azimuth) + this.orbitPoint[2]
        ];

        return position;
    };

    Camera.prototype.isMouseDown = function () {
        return this.mouseDown;
    };


    Camera.prototype.getViewMatrix = function () {
        return this.viewMatrix;
    };

    Camera.prototype.setOrbitPoint = function (x, y, z) {
        this.orbitPoint[0] = x;
        this.orbitPoint[1] = y;
        this.orbitPoint[2] = z;
        this.recomputeViewMatrix();
    };

    Camera.prototype.setBounds = function (minElevation, maxElevation) {
        this.minElevation = minElevation;
        this.maxElevation = maxElevation;

        if (this.elevation > this.maxElevation) this.elevation = this.maxElevation;
        if (this.elevation < this.minElevation) this.elevation = this.minElevation;

        this.recomputeViewMatrix();
    };

    Camera.prototype.onMouseDown = function (event) {
        event.preventDefault();

        var x = Utilities.getMousePosition(event, this.element).x;
        var y = Utilities.getMousePosition(event, this.element).y;

        if (event.button !== 0) return;
        
        if (this.freeCamMode) {
            // In free cam mode, enable mouse look
            this.mouseLookActive = true;
            this.lastMouseX = x;
            this.lastMouseY = y;
            // Lock pointer for FPS-style controls
            if (this.element.requestPointerLock) {
                this.element.requestPointerLock();
            }
        } else {
            // Orbit mode
            this.mouseDown = true;
            this.lastMouseX = x;
            this.lastMouseY = y;
        }
    };

    Camera.prototype.onMouseUp = function (event) {
        event.preventDefault();

        if (event.button !== 0) return;

        if (this.freeCamMode) {
            // In free cam mode, disable mouse look when mouse is released
            this.mouseLookActive = false;
        } else {
            this.mouseDown = false;
        }
    };

    Camera.prototype.onMouseMove = function (event) {
        event.preventDefault();

        var x = Utilities.getMousePosition(event, this.element).x;
        var y = Utilities.getMousePosition(event, this.element).y;

        if (this.freeCamMode && this.mouseLookActive) {
            // FPS-style mouse look in free camera mode
            var deltaX = x - this.lastMouseX;
            var deltaY = y - this.lastMouseY;
            
            this.azimuth += deltaX * SENSITIVITY;
            this.elevation += deltaY * SENSITIVITY;
            
            if (this.elevation > this.maxElevation) this.elevation = this.maxElevation;
            if (this.elevation < this.minElevation) this.elevation = this.minElevation;
            
            this.recomputeViewMatrix();
            this.lastMouseX = x;
            this.lastMouseY = y;
        } else if (this.mouseDown && !this.freeCamMode) {
            // Orbit mode
            this.currentMouseX = x;
            this.currentMouseY = y;

            var deltaAzimuth = (this.currentMouseX - this.lastMouseX) * SENSITIVITY;
            var deltaElevation = (this.currentMouseY - this.lastMouseY) * SENSITIVITY;

            this.azimuth += deltaAzimuth;
            this.elevation += deltaElevation;

            if (this.elevation > this.maxElevation) this.elevation = this.maxElevation;
            if (this.elevation < this.minElevation) this.elevation = this.minElevation;

            this.recomputeViewMatrix();

            this.lastMouseX = this.currentMouseX;
            this.lastMouseY = this.currentMouseY;
        }
    };
    
    Camera.prototype.onKeyDown = function (event) {
        var key = event.key.toLowerCase();
        if (key === 'w' || key === 'a' || key === 's' || key === 'd' || key === 'q' || key === 'e') {
            this.keys[key] = true;
        }
    };
    
    Camera.prototype.onKeyUp = function (event) {
        var key = event.key.toLowerCase();
        if (key === 'w' || key === 'a' || key === 's' || key === 'd' || key === 'q' || key === 'e') {
            this.keys[key] = false;
        }
    };
    
    Camera.prototype.update = function () {
        if (!this.freeCamMode) {
            return;
        }
        if (!this.keys.w && !this.keys.a && !this.keys.s && !this.keys.d && !this.keys.q && !this.keys.e) {
            return;
        }
        
        var pos = this.getPosition();
        var viewDir = [this.orbitPoint[0] - pos[0], this.orbitPoint[1] - pos[1], this.orbitPoint[2] - pos[2]];
        Utilities.normalizeVector(viewDir, viewDir);
        
        // Calculate movement vectors
        var right = Utilities.crossVectors([], viewDir, [0, 1, 0]);
        if (Utilities.magnitudeOfVector(right) < 1e-6) {
            Utilities.crossVectors(right, viewDir, [1, 0, 0]);
        }
        Utilities.normalizeVector(right, right);
        
        var up = [0, 1, 0];
        var forward = viewDir;
        
        var move = [0, 0, 0];
        if (this.keys.w) {
            move[0] += forward[0];
            move[1] += forward[1];
            move[2] += forward[2];
        }
        if (this.keys.s) {
            move[0] -= forward[0];
            move[1] -= forward[1];
            move[2] -= forward[2];
        }
        if (this.keys.a) {
            move[0] -= right[0];
            move[1] -= right[1];
            move[2] -= right[2];
        }
        if (this.keys.d) {
            move[0] += right[0];
            move[1] += right[1];
            move[2] += right[2];
        }
        if (this.keys.q) {
            move[0] -= up[0];
            move[1] -= up[1];
            move[2] -= up[2];
        }
        if (this.keys.e) {
            move[0] += up[0];
            move[1] += up[1];
            move[2] += up[2];
        }
        
        if (Utilities.magnitudeOfVector(move) > 0) {
            Utilities.normalizeVector(move, move);
            var speed = MOVE_SPEED;
            this.orbitPoint[0] += move[0] * speed;
            this.orbitPoint[1] += move[1] * speed;
            this.orbitPoint[2] += move[2] * speed;
            this.recomputeViewMatrix();
        }
    };

    return Camera;
}());
