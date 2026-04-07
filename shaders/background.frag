precision highp float;

varying vec2 v_position;

uniform float u_backgroundBrightness;

void main () {
    vec3 backgroundColor = vec3(u_backgroundBrightness) * (1.0 - length(v_position) * 0.1);
    gl_FragColor = vec4(backgroundColor, 1.0);
}
