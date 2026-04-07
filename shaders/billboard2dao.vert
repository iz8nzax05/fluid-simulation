precision highp float;

attribute vec2 a_vertexCorner;

attribute vec2 a_textureCoordinates;

uniform mat4 u_projectionMatrix;
uniform mat4 u_viewMatrix;
uniform vec3 u_cameraPosition;

uniform sampler2D u_positionsTexture;
uniform sampler2D u_velocitiesTexture;

uniform float u_sphereRadius;

varying vec3 v_viewSpaceSpherePosition;
varying float v_sphereRadius;
varying float v_extrudedSphereRadius;

void main () {
    vec3 particlePos = texture2D(u_positionsTexture, a_textureCoordinates).rgb;

    v_viewSpaceSpherePosition = vec3(u_viewMatrix * vec4(particlePos, 1.0));
    v_sphereRadius = u_sphereRadius;
    v_extrudedSphereRadius = v_sphereRadius * 5.0;

    vec3 viewDir = u_cameraPosition - particlePos;
    float len = length(viewDir);
    if (len < 0.0001) viewDir = vec3(0.0, 0.0, -1.0);
    else viewDir /= len;

    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 right = cross(up, viewDir);
    float rl = length(right);
    if (rl < 0.0001) {
        right = vec3(1.0, 0.0, 0.0);
        up = cross(viewDir, right);
    } else {
        right /= rl;
        up = cross(viewDir, right);
    }

    vec3 worldOffset = (right * a_vertexCorner.x + up * a_vertexCorner.y) * v_extrudedSphereRadius;
    vec3 worldPos = particlePos + worldOffset;

    gl_Position = u_projectionMatrix * u_viewMatrix * vec4(worldPos, 1.0);
}
