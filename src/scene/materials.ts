import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  ShaderMaterial,
  type Texture,
  Vector2,
} from "three";

/** Shared by every animated shader; advanced by the render loop, only while it renders. */
export interface TimeUniform {
  value: number;
}

/**
 * The glyph bodies: standard PBR, with part of each instance's colour emitted, so pods glow
 * their health through the bloom while config objects stay matte.
 */
export const createSolidMaterial = (glow: number) => {
  const material = new MeshStandardMaterial({ roughness: 0.42, metalness: 0.18, envMapIntensity: 0.75 });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = { value: glow };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uGlow;")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n#ifdef USE_COLOR\n  totalEmissiveRadiance += vColor.rgb * uGlow;\n#endif",
      );
  };
  material.customProgramCacheKey = () => `app-graph-solid-${glow}`;

  return material;
};

/** Missing and unknown resources: a wireframe of what should be there. */
export const createGhostMaterial = () =>
  new MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });

/** Status lights: small, over-bright, so the bloom turns them into glows. */
export const createLedMaterial = () => new MeshBasicMaterial({ toneMapped: false });

/**
 * App modules as glass boxes: a fresnel rim, faint body, and a crisp frame along every edge,
 * tinted per instance by the app's health. Additive on dark themes, alpha-blended on light ones.
 */
export const createGlassMaterial = (time: TimeUniform, dark: boolean) =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: dark ? AdditiveBlending : NormalBlending,
    uniforms: { uTime: time, uStrength: { value: dark ? 1 : 0.55 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying vec2 vUv;
      varying vec2 vFace;
      varying vec3 vTint;

      void main() {
        mat4 model = modelMatrix * instanceMatrix;
        vec4 world = model * vec4(position, 1.0);
        vec3 scale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));

        vWorld = world.xyz;
        vNormalW = normalize(mat3(model) * normal);
        vUv = uv;
        vFace = abs(normal.x) > 0.5 ? scale.zy : abs(normal.y) > 0.5 ? scale.xz : scale.xy;
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(0.5, 0.9, 1.0);
        #endif
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying vec2 vUv;
      varying vec2 vFace;
      varying vec3 vTint;

      void main() {
        vec3 view = normalize(cameraPosition - vWorld);
        // Clamped: rounding can push |N·V| a hair over 1, and pow() of a negative is NaN on the GPU.
        float facing = clamp(abs(dot(normalize(vNormalW), view)), 0.0, 1.0);
        float fresnel = pow(1.0 - facing, 2.6);
        vec2 toEdge = min(vUv, 1.0 - vUv) * vFace;
        float frame = 1.0 - smoothstep(0.0, 0.05, min(toEdge.x, toEdge.y));
        float body = 0.035 + fresnel * 0.3;
        // From far away hundreds of modules overlap: let them recede to outlines.
        float far = smoothstep(35.0, 150.0, length(cameraPosition - vWorld));
        float strength = uStrength * mix(1.0, 0.3, far);
        vec3 color = vTint * (body + frame * 0.9);

        gl_FragColor = vec4(color * strength, clamp((body + frame * 0.6) * strength, 0.0, 1.0));
      }
    `,
  });

/** The floor: a faint grid that fades out towards the edge of the world. */
export const createGroundMaterial = (base: Color, line: Color, fade: Color) =>
  new ShaderMaterial({
    uniforms: {
      uBase: { value: base },
      uLine: { value: line },
      uFade: { value: fade },
      uCenter: { value: new Vector2() },
      uRadius: { value: 100 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase;
      uniform vec3 uLine;
      uniform vec3 uFade;
      uniform vec2 uCenter;
      uniform float uRadius;
      varying vec3 vWorld;

      float grid(vec2 p, float size) {
        vec2 cell = p / size;
        vec2 g = abs(fract(cell - 0.5) - 0.5) / max(fwidth(cell), vec2(1e-5));
        return 1.0 - min(min(g.x, g.y), 1.0);
      }

      void main() {
        vec2 p = vWorld.xz;
        float lines = grid(p, 2.0) * 0.45 + grid(p, 10.0) * 0.55;
        float distance = length(p - uCenter) / uRadius;
        float fade = 1.0 - smoothstep(0.35, 1.0, distance);
        vec3 color = mix(uBase, uLine, lines * fade);

        gl_FragColor = vec4(mix(uFade, color, fade), 1.0);
      }
    `,
  });

/** Expanding rings on the floor under anything broken. Animated entirely on the GPU. */
export const createPulseMaterial = (time: TimeUniform) =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: time },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform float uTime;
      varying float vAlpha;
      varying vec3 vTint;

      void main() {
        float k = fract(uTime * 0.55 + aPhase);
        vec3 p = position * (0.7 + k * 1.5);
        vAlpha = (1.0 - k) * (1.0 - k);
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(1.0, 0.35, 0.4);
        #endif
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec3 vTint;
      void main() {
        gl_FragColor = vec4(vTint * 1.8, vAlpha * 0.85);
      }
    `,
  });

/**
 * Packets: points that travel quadratic curves from holder to target, placed on the GPU from
 * the curve and the time, so traffic costs nothing on the CPU per frame.
 */
export const createPacketMaterial = (time: TimeUniform) =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: time, uSize: { value: 0.32 }, uScale: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute vec3 aStart;
      attribute vec3 aControl;
      attribute vec3 aEnd;
      attribute float aPhase;
      attribute float aSpeed;
      attribute vec3 aColor;
      uniform float uTime;
      uniform float uSize;
      uniform float uScale;
      varying vec3 vColor;
      varying float vFade;

      void main() {
        float t = fract(uTime * aSpeed + aPhase);
        vec3 p = mix(mix(aStart, aControl, t), mix(aControl, aEnd, t), t);
        vec4 view = modelViewMatrix * vec4(p, 1.0);

        gl_Position = projectionMatrix * view;
        gl_PointSize = clamp(uSize * uScale / max(-view.z, 0.05), 2.0, 96.0);
        vColor = aColor;
        vFade = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.9, 1.0, t));
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = 1.0 - smoothstep(0.05, 0.5, d);
        gl_FragColor = vec4(vColor * 2.6, a * vFade);
      }
    `,
  });

/** A column of light over an app with something broken: visible from across the whole cluster. */
export const createBeaconMaterial = (time: TimeUniform) =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uTime: time },
    vertexShader: /* glsl */ `
      varying float vHeight;
      varying vec3 vTint;
      void main() {
        vHeight = uv.y;
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(1.0, 0.36, 0.42);
        #endif
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying float vHeight;
      varying vec3 vTint;
      void main() {
        float fade = pow(clamp(1.0 - vHeight, 0.0, 1.0), 1.6);
        float pulse = 0.75 + 0.25 * sin(uTime * 2.4 - vHeight * 6.0);
        gl_FragColor = vec4(vTint * 1.4 * pulse, fade * 0.32);
      }
    `,
  });

/** A soft round shadow under each resource: grounds the scene for a fraction of a shadow map's cost. */
export const createShadowTexture = (): Texture => {
  const size = 64;
  const canvas = document.createElement("canvas");

  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

  gradient.addColorStop(0, "rgba(0,0,0,0.9)");
  gradient.addColorStop(0.55, "rgba(0,0,0,0.35)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return new CanvasTexture(canvas);
};

export const createShadowMaterial = (texture: Texture, opacity: number) =>
  new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity, color: new Color(0, 0, 0) });

/**
 * Right after the scene is drawn, before bloom: any pixel that is not a finite number becomes
 * black. Bloom blurs across the whole screen, so a single NaN would otherwise blank the frame.
 * Tested on the bits, because the GPU's fast maths may compile isnan() away.
 */
export const SanitizeShader = {
  name: "AppGraphSanitizeShader",
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;

    bool notFinite(float value) {
      return (floatBitsToUint(value) & 0x7f800000u) == 0x7f800000u;
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      if (notFinite(color.r) || notFinite(color.g) || notFinite(color.b) || notFinite(color.a)) {
        color = vec4(0.0, 0.0, 0.0, 1.0);
      }

      gl_FragColor = vec4(clamp(color.rgb, 0.0, 64.0), clamp(color.a, 0.0, 1.0));
    }
  `,
};
