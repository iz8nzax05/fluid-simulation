precision highp float;

attribute vec2 a_vertexCorner;

attribute vec2 a_textureCoordinates;

uniform mat4 u_projectionMatrix;
uniform mat4 u_viewMatrix;
uniform vec3 u_cameraPosition;

uniform sampler2D u_positionsTexture;
uniform sampler2D u_velocitiesTexture;

uniform float u_sphereRadius;

varying vec3 v_viewSpacePosition;
varying vec3 v_viewSpaceNormal;
varying float v_speed;
varying vec2 v_uv;

void main () {
    vec3 particlePos = texture2D(u_positionsTexture, a_textureCoordinates).rgb;
    vec3 velocity = texture2D(u_velocitiesTexture, a_textureCoordinates).rgb;
    v_speed = length(velocity);

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

    vec3 worldOffset = (right * a_vertexCorner.x + up * a_vertexCorner.y) * u_sphereRadius;
    vec3 worldPos = particlePos + worldOffset;

    vec4 viewPos = u_viewMatrix * vec4(worldPos, 1.0);
    v_viewSpacePosition = viewPos.xyz;
    v_viewSpaceNormal = normalize((u_viewMatrix * vec4(viewDir, 0.0)).xyz);
    v_uv = a_vertexCorner * 0.5 + 0.5;

    gl_Position = u_projectionMatrix * viewPos;
}
