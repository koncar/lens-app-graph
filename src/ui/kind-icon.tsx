import { iconOf } from "../graph/kind-icons";
import { lookOf } from "../graph/presentation";

const parts = (kind: string, color: string) =>
  iconOf(kind).map((part, index) =>
    part.fill ? (
      <path key={index} d={part.d} fill={color} />
    ) : (
      <path key={index} d={part.d} fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    ),
  );

/** A kind's icon alone, in the colour of the text around it. */
export const KindIcon = ({ kind, size = 14 }: { kind: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ flex: "none" }}>
    {parts(kind, "currentColor")}
  </svg>
);

const HEPTAGON = Array.from({ length: 7 }, (_, index) => {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / 7;

  return `${12 + 11.6 * Math.cos(angle)},${12.4 + 11.6 * Math.sin(angle)}`;
}).join(" ");

/** The icon on its heptagon, coloured like the kind's token in 3D. */
export const KindBadge = ({ kind, size = 22, color }: { kind: string; size?: number; color?: string }) => (
  <svg viewBox="-0.5 -0.5 25 25" width={size} height={size} aria-hidden style={{ flex: "none" }}>
    <polygon points={HEPTAGON} fill={color ?? lookOf({ group: "", kind }).color} />
    <g transform="translate(4.4 4.8) scale(0.64)">{parts(kind, "#ffffff")}</g>
  </svg>
);
