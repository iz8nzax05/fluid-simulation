precision highp float;

varying vec2 v_coordinates;

uniform sampler2D u_renderingTexture;

/**
 * G-buffer view (composite OFF): R,G = normal.xy (camera hues). Pop from depth, not speed.
 *
 * WHY depth not speed for pop:
 * - Speed in B gave outline separation but turned everything blue when moving.
 * - Depth varies per-particle (near vs far) so we get the same pop, no motion-based color change.
 */
void main () {
    vec4 data = texture2D(u_renderingTexture, v_coordinates);
    float speed = data.b;
    float depth = data.a;

    if (depth < -1e4 || speed < 0.0) {
        gl_FragColor = vec4(0.02, 0.02, 0.03, 1.0);
        return;
    }

    float nx = data.x;
    float ny = data.y;

    /* R,G = normal.xy (view-dependent hues). B = constant (no speed → no blue). */
    float r = max(0.0, nx) * 0.95 + 0.05;
    float g = max(0.0, ny) * 0.95 + 0.05;
    float b = 0.18;

    /* Outline pop from depth: closer = brighter. No speed. */
    float depthPop = 1.0 / (1.0 + 0.0025 * max(0.0, depth));
    float mult = 0.78 + 0.22 * depthPop;
    vec3 rgb = vec3(r, g, b) * mult;

    gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
