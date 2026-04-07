precision highp float;

varying vec3 v_viewSpacePosition;
varying vec3 v_viewSpaceNormal;
varying float v_speed;
varying vec2 v_uv;

void main () {
    float d = length(v_uv - 0.5) * 2.0;
    if (d > 1.0) discard;

    gl_FragColor = vec4(v_viewSpaceNormal.x, v_viewSpaceNormal.y, v_speed, v_viewSpacePosition.z);
}
