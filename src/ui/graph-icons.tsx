import { Svg, type SvgProps } from "@k8slens/element-components";

/**
 * The two views' own glyphs, drawn like Lens's (filled, in `currentColor`, a little inside the
 * box) and sized like them: a t-shirt `$size` is fixed as minimum, size and maximum, "l" when
 * nobody says, so a surface that sizes its icons sizes these too.
 */
const GraphGlyph = ({ $size = "l", children, ...props }: SvgProps) => (
  <Svg
    viewBox="-1 -1 26 26"
    fill="currentColor"
    aria-hidden
    $size={typeof $size === "string" && $size !== "full" ? { min: $size, size: $size, max: $size } : $size}
    {...props}
  >
    {children}
  </Svg>
);

const hexagon = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const angle = Math.PI / 6 + (i * Math.PI) / 3;

    return `${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`;
  }).join(" ");

/** Three resource tokens and what connects them. */
export const AppGraphIcon = (props: SvgProps) => (
  <GraphGlyph {...props}>
    <path d="M12 6.5 6 16.5M12 6.5l6 10M6 16.5h12" stroke="currentColor" strokeWidth={1.7} fill="none" />
    <polygon points={hexagon(12, 5.5, 4)} />
    <polygon points={hexagon(5.5, 17.5, 4)} />
    <polygon points={hexagon(18.5, 17.5, 4)} />
  </GraphGlyph>
);

/** A request coming in, and where it goes on to. */
export const TrafficGraphIcon = (props: SvgProps) => (
  <GraphGlyph {...props}>
    <circle cx={4.5} cy={12} r={3} />
    <path d="M7 12c5 0 5-6 10.5-6M7 12c5 0 5 6 10.5 6" stroke="currentColor" strokeWidth={1.8} fill="none" />
    <path d="M17 2.8 22 6l-5 3.2zM17 14.8l5 3.2-5 3.2z" />
  </GraphGlyph>
);
