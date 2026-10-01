import { type BufferGeometry, CylinderGeometry, ExtrudeGeometry, Shape } from "three";
import { GLYPH_FOOTPRINT } from "../graph/layout";
import type { Glyph } from "../graph/presentation";

const SIDES = 7;
const BEVEL = 0.05;

/** The Kubernetes heptagon, one vertex pointing away from the viewer, in the x–z plane. */
const heptagon = (radius: number) => {
  const shape = new Shape();

  for (let i = 0; i < SIDES; i++) {
    const angle = Math.PI / 2 + (i * 2 * Math.PI) / SIDES;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);

    if (i === 0) {
      shape.moveTo(x, y);
    } else {
      shape.lineTo(x, y);
    }
  }

  shape.closePath();

  return shape;
};

/**
 * Every resource is a token: a bevelled heptagon, sized by what it is, with its kind's icon on
 * top (drawn by the scene). Built to the footprint the layout packs by, centred on the origin.
 */
export const createGlyphGeometry = (glyph: Glyph): BufferGeometry => {
  const { w, h } = GLYPH_FOOTPRINT[glyph];
  const bevel = Math.min(BEVEL, h / 4);
  const geometry = new ExtrudeGeometry(heptagon(w / 2 - bevel), {
    depth: Math.max(h - 2 * bevel, 0.01),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 1,
  });

  // Extruded along z: stand it up, so the face with the icon looks up, and centre it.
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();

  const box = geometry.boundingBox!;

  geometry.translate(0, -(box.max.y + box.min.y) / 2, 0);

  return geometry;
};

/** Missing and unknown resources: the same heptagon as a plain prism, drawn as a wireframe. */
export const createGhostGeometry = (glyph: Glyph): BufferGeometry => {
  const { w, h } = GLYPH_FOOTPRINT[glyph];

  return new CylinderGeometry(w / 2, w / 2, h, SIDES, 1).rotateY(Math.PI);
};

export const GLYPHS: readonly Glyph[] = ["gate", "hex", "block", "slab", "cube", "tile", "disk", "gem", "ring", "orb", "landmark"];
