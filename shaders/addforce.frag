precision highp float;

varying vec2 v_coordinates;

uniform sampler2D u_velocityTexture;

uniform vec3 u_mouseVelocity;

uniform vec3 u_gridResolution;
uniform vec3 u_gridSize;

uniform vec3 u_mouseRayOrigin;
uniform vec3 u_mouseRayDirection;
uniform vec3 u_mousePosition; // Mouse position in world space (on camera focal plane)

uniform float u_timeStep;
uniform float u_gravity;
uniform float u_mouseStrength;
uniform float u_mouseMode; // 0=repel, 1=vortex, 2=attract

float kernel (vec3 position, float radius) {
    vec3 worldPosition = (position / u_gridResolution) * u_gridSize;

    float distanceToMouseRay = length(cross(u_mouseRayDirection, worldPosition - u_mouseRayOrigin));

    float normalizedDistance = max(0.0, distanceToMouseRay / radius);
    return smoothstep(1.0, 0.9, normalizedDistance);
}

void main () {
    vec3 velocity = texture2D(u_velocityTexture, v_coordinates).rgb;

    vec3 newVelocity = velocity + vec3(0.0, -40.0 * u_gravity * u_timeStep, 0.0);

    vec3 cellIndex = floor(get3DFragCoord(u_gridResolution + 1.0));
    vec3 xPosition = vec3(cellIndex.x, cellIndex.y + 0.5, cellIndex.z + 0.5);
    vec3 yPosition = vec3(cellIndex.x + 0.5, cellIndex.y, cellIndex.z + 0.5);
    vec3 zPosition = vec3(cellIndex.x + 0.5, cellIndex.y + 0.5, cellIndex.z);

    float mouseRadius = 5.0;
    vec3 kernelValues = vec3(kernel(xPosition, mouseRadius), kernel(yPosition, mouseRadius), kernel(zPosition, mouseRadius));
    
    // Calculate world position for this cell (using xPosition as reference for all modes)
    vec3 worldPos = (xPosition / u_gridResolution) * u_gridSize;
    vec3 toParticle = worldPos - u_mouseRayOrigin;
    float distToMouse = length(toParticle);
    float kernelStrength = max(max(kernelValues.x, kernelValues.y), kernelValues.z);
    
    vec3 mouseForce = vec3(0.0);
    
    if (u_mouseMode < 0.5) {
        // Mode 0: Repel (normal push) - uses mouse velocity
        mouseForce = u_mouseVelocity * kernelValues;
    } else if (u_mouseMode < 1.5) {
        // Mode 1: Vortex (spin around mouse) - 4 pushing effects in circular pattern
        if (kernelStrength > 0.01 && distToMouse > 0.1) {
            // Project particle position onto plane perpendicular to mouse ray
            vec3 projected = toParticle - dot(toParticle, u_mouseRayDirection) * u_mouseRayDirection;
            float projLen = length(projected);
            
            if (projLen > 0.1) {
                vec3 projNormalized = normalize(projected);
                
                // Create reference frame on the plane
                vec3 up = vec3(0.0, 1.0, 0.0);
                vec3 right = cross(u_mouseRayDirection, up);
                if (length(right) < 0.1) {
                    right = cross(u_mouseRayDirection, vec3(1.0, 0.0, 0.0));
                }
                right = normalize(right);
                vec3 forward = cross(right, u_mouseRayDirection);
                forward = normalize(forward);
                
                // Calculate angle of particle around mouse (0 to 2π)
                float angle = atan(dot(projNormalized, forward), dot(projNormalized, right));
                if (angle < 0.0) angle += 6.28318; // Normalize to [0, 2π]
                
                // Create 4 push points at 0°, 90°, 180°, 270°
                float pushAngle1 = 0.0;
                float pushAngle2 = 1.5708;  // 90°
                float pushAngle3 = 3.14159; // 180°
                float pushAngle4 = 4.71239; // 270°
                
                // Calculate distance from particle angle to each push point
                float dist1 = min(abs(angle - pushAngle1), 6.28318 - abs(angle - pushAngle1));
                float dist2 = min(abs(angle - pushAngle2), 6.28318 - abs(angle - pushAngle2));
                float dist3 = min(abs(angle - pushAngle3), 6.28318 - abs(angle - pushAngle3));
                float dist4 = min(abs(angle - pushAngle4), 6.28318 - abs(angle - pushAngle4));
                
                // Each push point creates a tangent force (circular direction)
                vec3 tangent = cross(u_mouseRayDirection, projNormalized);
                if (length(tangent) < 0.1) {
                    tangent = cross(projNormalized, up);
                }
                tangent = normalize(tangent);
                
                // Weight each push point by inverse distance (closer = stronger)
                float weight1 = 1.0 / (1.0 + dist1 * 3.0);
                float weight2 = 1.0 / (1.0 + dist2 * 3.0);
                float weight3 = 1.0 / (1.0 + dist3 * 3.0);
                float weight4 = 1.0 / (1.0 + dist4 * 3.0);
                
                float totalWeight = weight1 + weight2 + weight3 + weight4;
                if (totalWeight > 0.01) {
                    // All push points push in the same circular direction (tangent)
                    // Combined strength based on proximity to push points
                    mouseForce = tangent * kernelStrength * totalWeight * 6.0;
                }
            }
        }
    } else {
        // Mode 2: Attract (pull particles toward mouse position in room)
        if (kernelStrength > 0.01) {
            // Calculate direction from particle to mouse position
            vec3 toMouse = u_mousePosition - worldPos;
            float distToMousePos = length(toMouse);
            if (distToMousePos > 0.01) {
                vec3 directionToMouse = normalize(toMouse);
                // Pull particles toward mouse position
                mouseForce = directionToMouse * kernelStrength * 2.0;
            }
        }
    }
    
    newVelocity += mouseForce * u_mouseStrength * smoothstep(0.0, 1.0 / 200.0, u_timeStep);

    gl_FragColor = vec4(newVelocity * 1.0, 0.0);
}
