import { type PerspectiveCamera, Vector3 } from "three";
import { iconOf } from "../graph/kind-icons";
import styles from "./labels.module.scss";

export interface LabelItem {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly text: string;
  readonly sub?: string;
  readonly variant: "district" | "app" | "node";
  /** Higher wins a spot on a crowded screen. */
  readonly priority: number;
  /** A health dot before the text. */
  readonly dot?: string;
  /** The kind, shown as its icon before the text. */
  readonly kind?: string;
  readonly emphasis?: boolean;
}

interface Placed {
  readonly element: HTMLDivElement;
  signature: string;
  x: number;
  y: number;
  z: number;
}

const MAX_LABELS = 90;
const SVG = "http://www.w3.org/2000/svg";

const iconElement = (kind: string) => {
  const svg = document.createElementNS(SVG, "svg");

  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", styles.icon ?? "");

  for (const part of iconOf(kind)) {
    const path = document.createElementNS(SVG, "path");

    path.setAttribute("d", part.d);
    path.setAttribute("fill", part.fill ? "currentColor" : "none");
    path.setAttribute("stroke", part.fill ? "none" : "currentColor");
    svg.appendChild(path);
  }

  return svg;
};
const scratch = new Vector3();

/**
 * Names over the scene as plain DOM, pooled and keyed so a camera move only rewrites transforms.
 * Placement is greedy by priority: a label that would overlap one already placed is skipped.
 */
export class LabelLayer {
  readonly element: HTMLDivElement;
  private readonly placed = new Map<string, Placed>();

  constructor(parent: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = styles.layer;
    parent.appendChild(this.element);
  }

  setTheme(dark: boolean) {
    const style = this.element.style;

    style.setProperty("--app-graph-label-fg", dark ? "#e6ecf7" : "#1d2433");
    style.setProperty("--app-graph-label-shadow", dark ? "rgba(0,0,0,0.8)" : "rgba(255,255,255,0.9)");
    style.setProperty("--app-graph-label-bg", dark ? "rgba(12,16,28,0.72)" : "rgba(255,255,255,0.82)");
    style.setProperty("--app-graph-label-border", dark ? "rgba(127,227,255,0.18)" : "rgba(30,60,90,0.14)");
    style.setProperty("--app-graph-label-accent", dark ? "rgba(127,227,255,0.8)" : "rgba(0,120,170,0.8)");
    style.setProperty("--app-graph-label-accent-glow", dark ? "rgba(127,227,255,0.35)" : "rgba(0,120,170,0.2)");
  }

  update(items: readonly LabelItem[], camera: PerspectiveCamera, width: number, height: number) {
    const sorted = [...items].sort((a, b) => b.priority - a.priority);
    const boxes: Array<[number, number, number, number]> = [];
    const shown = new Set<string>();

    for (const item of sorted) {
      if (shown.size >= MAX_LABELS) {
        break;
      }

      scratch.set(item.x, item.y, item.z).project(camera);

      if (scratch.z < -1 || scratch.z > 1) {
        continue;
      }

      const x = (scratch.x * 0.5 + 0.5) * width;
      const y = (-scratch.y * 0.5 + 0.5) * height;
      const titleWidth = (item.text.length + (item.kind ? 2.5 : 0)) * (item.variant === "district" ? 9.5 : item.variant === "app" ? 7.4 : 6.6);
      const estimatedWidth = Math.max(titleWidth, (item.sub?.length ?? 0) * 5.4) + (item.dot ? 36 : 22);
      const estimatedHeight = item.sub ? 30 : 20;
      const box: [number, number, number, number] = [x - estimatedWidth / 2, y - estimatedHeight, x + estimatedWidth / 2, y];

      if (box[2] < 0 || box[0] > width || box[3] < 0 || box[1] > height) {
        continue;
      }

      if (boxes.some(([left, top, right, bottom]) => box[0] < right && box[2] > left && box[1] < bottom && box[3] > top)) {
        continue;
      }

      boxes.push(box);
      shown.add(item.key);
      this.show(item, x, y);
    }

    for (const [key, placed] of this.placed) {
      if (!shown.has(key)) {
        placed.element.remove();
        this.placed.delete(key);
      }
    }
  }

  has(key: string) {
    return this.placed.has(key);
  }

  /** Moves the labels already shown to follow the camera, without choosing them again. */
  reposition(camera: PerspectiveCamera, width: number, height: number) {
    for (const placed of this.placed.values()) {
      scratch.set(placed.x, placed.y, placed.z).project(camera);

      const visible = scratch.z >= -1 && scratch.z <= 1;
      const x = (scratch.x * 0.5 + 0.5) * width;
      const y = (-scratch.y * 0.5 + 0.5) * height;

      placed.element.style.transform = visible ? `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)` : "translate3d(-9999px, 0, 0)";
    }
  }

  clear() {
    this.element.replaceChildren();
    this.placed.clear();
  }

  dispose() {
    this.clear();
    this.element.remove();
  }

  private show(item: LabelItem, x: number, y: number) {
    let placed = this.placed.get(item.key);

    if (!placed) {
      const element = document.createElement("div");

      this.element.appendChild(element);
      placed = { element, signature: "", x: item.x, y: item.y, z: item.z };
      this.placed.set(item.key, placed);
    }

    placed.x = item.x;
    placed.y = item.y;
    placed.z = item.z;

    const signature = `${item.variant}|${item.kind ?? ""}|${item.text}|${item.sub ?? ""}|${item.dot ?? ""}|${item.emphasis ? 1 : 0}`;

    if (placed.signature !== signature) {
      placed.signature = signature;
      placed.element.className = [styles.label, styles[item.variant], item.emphasis ? styles.emphasis : ""].filter(Boolean).join(" ");
      placed.element.replaceChildren();

      if (item.dot) {
        const dot = document.createElement("span");

        dot.className = styles.dot;
        dot.style.background = item.dot;
        dot.style.color = item.dot;
        placed.element.appendChild(dot);
      }

      const text = document.createElement("span");

      text.className = styles.text;

      const title = document.createElement("span");

      if (item.kind) {
        title.appendChild(iconElement(item.kind));
      }

      title.appendChild(document.createTextNode(item.text));
      text.appendChild(title);

      if (item.sub) {
        const sub = document.createElement("span");

        sub.className = styles.sub;
        sub.textContent = item.sub;
        text.appendChild(sub);
      }

      placed.element.appendChild(text);
    }

    placed.element.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
  }
}
