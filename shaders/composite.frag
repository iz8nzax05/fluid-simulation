precision highp float;

varying vec2 v_coordinates;

uniform sampler2D u_renderingTexture;
uniform sampler2D u_occlusionTexture;

uniform vec2 u_resolution;
uniform float u_fov;

uniform mat4 u_inverseViewMatrix;

uniform sampler2D u_shadowDepthTexture;
uniform vec2 u_shadowResolution;
uniform mat4 u_lightProjectionViewMatrix;

uniform sampler2D u_colorRamp;
uniform float u_colorRampSize;
uniform float u_rampScale;
uniform float u_glow;
uniform float u_backgroundBrightness;
uniform float u_sparkle;
uniform float u_sparkleStrength;
uniform float u_sparkleThreshold;
uniform float u_vignette;
uniform float u_vignetteStrength;
uniform float u_bloom;
uniform float u_bloomStrength;
uniform float u_shadowMapEnabled; // 1.0 if enabled, 0.0 if disabled
uniform float u_occlusionEnabled; // 1.0 if enabled, 0.0 if disabled

float linearstep (float left, float right, float x) {
    return clamp((x - left) / (right - left), 0.0, 1.0);
}

void main () {
    vec4 data = texture2D(u_renderingTexture, v_coordinates);
    float occlusion = u_occlusionEnabled > 0.5 ? texture2D(u_occlusionTexture, v_coordinates).r : 0.0;

    vec3 viewSpaceNormal = vec3(data.x, data.y, sqrt(1.0 - data.x * data.x - data.y * data.y));

    float viewSpaceZ = data.a;
    vec3 viewRay = vec3(
        (v_coordinates.x * 2.0 - 1.0) * tan(u_fov / 2.0) * u_resolution.x / u_resolution.y,
        (v_coordinates.y * 2.0 - 1.0) * tan(u_fov / 2.0),
        -1.0);

    vec3 viewSpacePosition = viewRay * -viewSpaceZ;
    vec3 worldSpacePosition = vec3(u_inverseViewMatrix * vec4(viewSpacePosition, 1.0));

    float speed = data.b;
    float rawT = clamp(speed * u_rampScale, 0.0, 1.0);
    float t = 0.02 + 0.96 * rawT;
    float n = max(2.0, u_colorRampSize);
    float u = t * (1.0 - 1.0 / n) + 0.5 / n;
    vec3 color = texture2D(u_colorRamp, vec2(u, 0.5)).rgb;


    float shadow = 1.0;
    
    if (u_shadowMapEnabled > 0.5) {
        vec4 lightSpacePosition = u_lightProjectionViewMatrix * vec4(worldSpacePosition, 1.0);
        lightSpacePosition /= lightSpacePosition.w;
        lightSpacePosition *= 0.5;
        lightSpacePosition += 0.5;
        vec2 lightSpaceCoordinates = lightSpacePosition.xy;
        
        const int PCF_WIDTH = 2;
        const float PCF_NORMALIZATION = float(PCF_WIDTH * 2 + 1) * float(PCF_WIDTH * 2 + 1);

        for (int xOffset = -PCF_WIDTH; xOffset <= PCF_WIDTH; ++xOffset) {
            for (int yOffset = -PCF_WIDTH; yOffset <= PCF_WIDTH; ++yOffset) {
                float shadowSample = texture2D(u_shadowDepthTexture, lightSpaceCoordinates + 5.0 * vec2(float(xOffset), float(yOffset)) / u_shadowResolution).r;
                if (lightSpacePosition.z > shadowSample + 0.001) shadow -= 1.0 / PCF_NORMALIZATION;
            }
        }
    }


    float ambient = 1.0 - occlusion * 0.7;
    float direct = 1.0 - (1.0 - shadow) * 0.8;

    color *= ambient * direct;

    if (speed >= 0.0 && u_glow > 0.0) {
        vec3 viewDir = normalize(-viewSpacePosition);
        float rim = 1.0 - max(0.0, dot(viewSpaceNormal, viewDir));
        color += u_glow * rim * color;
        color = min(color, vec3(1.0));
    }

    if (speed >= 0.0 && u_sparkle > 0.0) {
        float s = smoothstep(u_sparkleThreshold, u_sparkleThreshold * 2.0, speed) * u_sparkleStrength;
        color += s * vec3(1.0, 1.0, 1.0);
        color = min(color, vec3(1.0));
    }

    vec3 finalColor;
    if (speed >= 0.0) {
        finalColor = color;
    } else {
        finalColor = vec3(u_backgroundBrightness) * (1.0 - length(v_coordinates * 2.0 - 1.0) * 0.1);
    }

    finalColor *= 1.0 - u_vignette * u_vignetteStrength * smoothstep(0.3, 1.0, length(v_coordinates - 0.5) * 2.0);
    
    // Bloom effect: subtle glow on bright areas
    if (u_bloom > 0.0 && speed >= 0.0) {
        // Calculate brightness from final color
        float brightness = max(finalColor.r, max(finalColor.g, finalColor.b));
        // Higher threshold - only bloom very bright areas
        float bloomThreshold = 0.4;
        float bloomRange = 0.3;
        float bloomFactor = smoothstep(bloomThreshold, bloomThreshold + bloomRange, brightness);
        // Extract bright areas
        vec3 bloomExtract = finalColor * bloomFactor;
        // Subtle bloom effect - much lower multiplier
        vec3 bloomColor = bloomExtract * u_bloomStrength * u_bloom * 1.2;
        finalColor += bloomColor;
    }
    
    finalColor = clamp(finalColor, 0.0, 1.0);

    gl_FragColor = vec4(finalColor, 1.0);
}
