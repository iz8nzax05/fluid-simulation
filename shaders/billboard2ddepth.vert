precision highp float;

attribute vec2 a_vertexCorner;

attribute vec2 a_textureCoordinates;

uniform mat4 u_projectionViewMatrix;
uniform vec3 u_lightPosition;

uniform sampler2D u_positionsTexture;
uniform sampler2D u_velocitiesTexture;

uniform float u_sphereRadius;

void main () {
    vec3 particlePos = texture2D(u_positionsTexture, a_textureCoordinates).rgb;

    vec3 viewDir = u_lightPosition - particlePos;
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

    vec3 worldOffset = (right * a_vertexCorner.x + up * a_vertexCorner.y) * u_sphereRadius;
    vec3 worldPos = particlePos + worldOffset;

    gl_Position = u_projectionViewMatrix * vec4(worldPos, 1.0);
}
