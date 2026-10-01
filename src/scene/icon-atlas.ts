import { CanvasTexture, LinearMipmapLinearFilter, ShaderMaterial, SRGBColorSpace, type Texture } from "three";
import { ICON_KINDS, iconOf } from "../graph/kind-icons";

const CELL = 128;
export const ATLAS_COLUMNS = 8;

/** Every kind's icon, white on transparent, in one texture: all icons are one draw call. */
export const createIconAtlas = (): Texture => {
  const canvas = document.createElement("canvas");

  canvas.width = CELL * ATLAS_COLUMNS;
  canvas.height = CELL * ATLAS_COLUMNS;

  const context = canvas.getContext("2d")!;
  const scale = (CELL / 24) * 0.84;

  context.strokeStyle = "#ffffff";
  context.fillStyle = "#ffffff";
  context.lineCap = "round";
  context.lineJoin = "round";

  ICON_KINDS.forEach((kind, index) => {
    const column = index % ATLAS_COLUMNS;
    const row = Math.floor(index / ATLAS_COLUMNS);

    context.save();
    context.translate(column * CELL + (CELL - 24 * scale) / 2, row * CELL + (CELL - 24 * scale) / 2);
    context.scale(scale, scale);
    context.lineWidth = 1.9;

    for (const part of iconOf(kind === "?" ? "" : kind)) {
      const path = new Path2D(part.d);

      if (part.fill) {
        context.fill(path);
      } else {
        context.stroke(path);
      }
    }

    context.restore();
  });

  const texture = new CanvasTexture(canvas);

  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;

  return texture;
};

/** Flat quads on top of the tokens, each showing its own cell of the atlas, tinted per instance. */
export const createIconMaterial = (atlas: Texture) =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uAtlas: { value: atlas }, uColumns: { value: ATLAS_COLUMNS } },
    vertexShader: /* glsl */ `
      attribute float aIcon;
      uniform float uColumns;
      varying vec2 vUv;
      varying vec3 vTint;

      void main() {
        float column = mod(aIcon, uColumns);
        float row = floor(aIcon / uColumns);

        vUv = vec2((column + uv.x) / uColumns, (uColumns - 1.0 - row + uv.y) / uColumns);
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(1.0);
        #endif
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying vec3 vTint;

      void main() {
        vec4 icon = texture2D(uAtlas, vUv);

        if (icon.a < 0.04) {
          discard;
        }

        gl_FragColor = vec4(vTint * icon.rgb, icon.a);
      }
    `,
  });
