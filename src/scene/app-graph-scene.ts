import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CylinderGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HalfFloatType,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Points,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  Box3,
  Plane,
  Spherical,
  DoubleSide,
  DynamicDrawUsage,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { Health } from "../graph/health";
import { GLYPH_FOOTPRINT, type Layout, type LayoutEdge, type LayoutNode } from "../graph/layout";
import { type Glyph, HEALTH_COLORS, PALETTE, POD_BODY } from "../graph/presentation";
import type { ObjectKey } from "../graph/types";
import type { CameraMemory, Selection } from "../ui/view-state.injectable";
import { iconIndexOf, iconKeyOf } from "../graph/kind-icons";
import { createGhostGeometry, createGlyphGeometry, GLYPHS } from "./glyphs";
import { createIconAtlas, createIconMaterial } from "./icon-atlas";
import { type LabelItem, LabelLayer } from "./labels";
import {
  createBeaconMaterial,
  createGhostMaterial,
  createGlassMaterial,
  createGroundMaterial,
  createLedMaterial,
  createPacketMaterial,
  createPulseMaterial,
  createShadowMaterial,
  createShadowTexture,
  createSolidMaterial,
  SanitizeShader,
  type TimeUniform,
} from "./materials";

export interface SceneEmphasis {
  readonly selected?: Selection;
  readonly hovered?: Selection;
  readonly matches?: ReadonlySet<ObjectKey>;
  readonly problemsOnly: boolean;
}

export interface SceneOptions {
  readonly labels: boolean;
  readonly traffic: boolean;
}

export interface SceneEvents {
  readonly hover: (target: Selection | undefined) => void;
  readonly select: (target: Selection | undefined) => void;
  /** Double click: fly in, or open the resource's details. */
  readonly open: (target: Selection) => void;
}

/** Height of an app module's floor; resources stand on it. */
const FLOOR = 0.12;
const TRANSITION_MS = 520;
const FLIGHT_MS = 850;
const FOV = 32;
const IDLE_AFTER_MS = 20_000;
const LABEL_LAYOUT_MS = 500;
const MIN_CAMERA_HEIGHT = 5;
const HOVER_LINGER_MS = 220;
const SLEEP_AFTER_MS = 120_000;

const nextPowerOfTwo = (value: number) => 2 ** Math.ceil(Math.log2(Math.max(value, 16)));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const matrix = new Matrix4();
const quaternion = new Quaternion();
const position = new Vector3();
const scale = new Vector3();
const color = new Color();

const hasLed = (node: LayoutNode) =>
  !node.ghost && node.glyph !== "cube" && node.glyph !== "ring" && (node.health === "ok" || node.health === "warn" || node.health === "error" || node.health === "idle");

/**
 * How many packets run along a traffic edge, and how fast. Three at an even pace where nothing
 * was measured; where a mesh measured it, denser and quicker the more requests (or bytes) go by,
 * on a log scale so a busy edge stays readable beside a quiet one.
 */
const packetsFor = (edge: LayoutEdge) => {
  if (!edge.observed) {
    return { count: 3, pace: 1 };
  }

  const { requestsPerSecond, bytesPerSecond } = edge.observed;
  const load = requestsPerSecond > 0 ? Math.log10(1 + requestsPerSecond) : Math.log10(1 + bytesPerSecond / 1024) * 0.75;

  return { count: Math.min(Math.max(Math.round(2 + 2 * load), 2), 10), pace: Math.min(0.8 + 0.3 * load, 2) };
};

/** Everything that decides where things are and which instances exist; nothing about colour. */
const structureOf = (layout: Layout) => {
  const parts: string[] = [];

  for (const node of layout.nodes.values()) {
    parts.push(`${node.id}~${node.glyph}~${node.ghost ? 1 : 0}~${node.x.toFixed(2)}~${node.y.toFixed(2)}~${node.z.toFixed(2)}~${node.heightScale.toFixed(2)}~${hasLed(node) ? 1 : 0}`);
  }

  for (const app of layout.apps.values()) {
    parts.push(`${app.id}~${app.x.toFixed(2)}~${app.z.toFixed(2)}~${app.width.toFixed(2)}~${app.depth.toFixed(2)}~${app.height.toFixed(2)}`);
  }

  for (const district of layout.districts.values()) {
    parts.push(`${district.id}~${district.x.toFixed(2)}~${district.z.toFixed(2)}~${district.width.toFixed(2)}~${district.depth.toFixed(2)}`);
  }

  return parts.join("|");
};

/** A growable InstancedMesh: one draw call however many resources there are. */
class InstancedLayer {
  mesh!: InstancedMesh;
  private capacity = 0;

  constructor(
    private readonly parent: Group,
    private readonly geometry: BufferGeometry,
    readonly material: Material,
    private readonly perInstance: ReadonlyArray<{ readonly name: string; readonly itemSize: number }> = [],
    private readonly renderOrder = 0,
  ) {
    this.allocate(16);
  }

  get count() {
    return this.mesh.count;
  }

  ensure(count: number) {
    if (count > this.capacity) {
      this.allocate(nextPowerOfTwo(count));
    }

    this.mesh.count = count;
  }

  attribute(name: string) {
    return this.geometry.getAttribute(name) as InstancedBufferAttribute;
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;

    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }

    for (const { name } of this.perInstance) {
      this.attribute(name).needsUpdate = true;
    }
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
  }

  private allocate(capacity: number) {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
    }

    for (const { name, itemSize } of this.perInstance) {
      this.geometry.setAttribute(name, new InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize));
    }

    this.capacity = capacity;
    this.mesh = new InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = this.renderOrder;
    this.mesh.count = 0;
    this.parent.add(this.mesh);
  }
}

interface NodeRecord {
  node: LayoutNode;
  readonly layer: InstancedLayer;
  readonly index: number;
  readonly from: { x: number; y: number; z: number; s: number };
  readonly led?: number;
  readonly shadow?: number;
  readonly icon?: number;
}

interface Flight {
  readonly fromPosition: Vector3;
  readonly fromTarget: Vector3;
  readonly toPosition: Vector3;
  readonly toTarget: Vector3;
  readonly start: number;
  readonly duration: number;
}

interface Theme {
  readonly dark: boolean;
  readonly background: Color;
  readonly ground: Color;
  readonly grid: Color;
  readonly plate: Color;
  readonly floor: Color;
}

const readTheme = (host: HTMLElement): Theme => {
  const match = getComputedStyle(host).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [10, 14, 25];
  const [r = 10, g = 14, b = 25] = match;
  const dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;

  return dark
    ? {
        dark,
        background: new Color("#080b14"),
        ground: new Color("#0a0e19"),
        grid: new Color("#1d2940"),
        plate: new Color("#101626"),
        floor: new Color("#182033"),
      }
    : {
        dark,
        background: new Color("#eef1f6"),
        ground: new Color("#e7ebf2"),
        grid: new Color("#c9d1de"),
        plate: new Color("#dde3ec"),
        floor: new Color("#f6f8fb"),
      };
};

const APP_TINT: Readonly<Record<Health, string>> = {
  ok: PALETTE.cyan,
  warn: PALETTE.gold,
  error: PALETTE.red,
  idle: PALETTE.grey,
  neutral: PALETTE.ice,
  unknown: PALETTE.slate,
};

/**
 * The 3D view: a diorama of the cluster, after the lns lab. Namespaces are dark plates, apps
 * glass modules on them, resources glyphs inside, traffic glowing packets along the routes.
 *
 * Built for large clusters: every kind of glyph is one instanced draw call, edges are one fat
 * line batch, packets and pulses are animated in shaders, labels are a small pool of DOM
 * nodes, and nothing is rendered unless something changed, moved, or is animating — which
 * itself winds down once the user has left the view alone for a while.
 */
export class AppGraphScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.3, 2000);
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly environment: Texture;
  private readonly theme: Theme;
  private readonly time: TimeUniform = { value: 0 };
  private readonly world = new Group();
  private readonly labels: LabelLayer;

  private readonly solids = new Map<Glyph, InstancedLayer>();
  private readonly ghosts = new Map<Glyph, InstancedLayer>();
  private readonly ghostMaterial = createGhostMaterial();
  private readonly leds: InstancedLayer;
  private readonly iconAtlas = createIconAtlas();
  private readonly icons: InstancedLayer;
  private readonly pulses: InstancedLayer;
  private readonly shadows: InstancedLayer;
  private readonly shadowTexture = createShadowTexture();
  private readonly glass: InstancedLayer;
  private readonly beacons: InstancedLayer;
  private readonly floors: InstancedLayer;
  private readonly plates: InstancedLayer;
  private readonly ground: Mesh;
  private readonly outlineMaterial: LineMaterial;
  private readonly outlines: LineSegments2;
  private readonly edgeMaterial: LineMaterial;
  private readonly edges: LineSegments2;
  private readonly dashedMaterial: LineMaterial;
  private readonly dashed: LineSegments2;
  private readonly packetMaterial: ReturnType<typeof createPacketMaterial>;
  private readonly packets: Points;
  private readonly selectionMarker: Mesh;
  private readonly hoverMarker: Mesh;
  private readonly hoverMaterial: LineMaterial;
  private readonly hoverLines: LineSegments2;

  /** What was last built, so an update that changes nothing visible costs nothing. */
  private structureKey = "";
  private colorKey = "";
  private linesKey = "";
  private matchesVersion = 0;
  private lastLabelLayout = 0;
  private readonly safePosition = new Vector3(0, 60, 80);
  private readonly safeTarget = new Vector3();

  private layout: Layout | undefined;
  private records = new Map<ObjectKey, NodeRecord>();
  private emphasis: SceneEmphasis = { problemsOnly: false };
  private options: SceneOptions = { labels: true, traffic: false };
  private factors = new Map<ObjectKey, number>();

  private raf = 0;
  private dirty = true;
  private labelsDirty = true;
  private lastFrame = 0;
  private lastRender = 0;
  private lastInteraction = performance.now();
  private transitionStart = -Infinity;
  private flight: Flight | undefined;
  private visible = true;
  private width = 1;
  private height = 1;
  private pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  private slowFrames = 0;
  private pointer: { x: number; y: number; downX: number; downY: number; downAt: number } | undefined;
  private hoverScheduled = false;
  private hoverClear: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private readonly raycaster = new Raycaster();

  constructor(
    private readonly host: HTMLElement,
    private readonly events: SceneEvents,
  ) {
    this.theme = readTheme(host);
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance", stencil: false });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.theme.dark ? 1.15 : 1.0;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.outline = "none";
    host.appendChild(this.renderer.domElement);

    this.labels = new LabelLayer(host);
    this.labels.setTheme(this.theme.dark);

    // --- scene ---------------------------------------------------------------------------
    this.scene.background = this.theme.background;
    this.scene.fog = new FogExp2(this.theme.background.getHex(), 0.004);

    const pmrem = new PMREMGenerator(this.renderer);

    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = this.theme.dark ? 0.35 : 0.8;

    this.scene.add(new HemisphereLight("#a9c2ff", this.theme.dark ? "#0b0d14" : "#8a93a6", this.theme.dark ? 1.0 : 1.6));

    const sun = new DirectionalLight("#dce7ff", this.theme.dark ? 1.5 : 2.0);

    sun.position.set(-12, 26, 16);
    this.scene.add(sun);

    const rim = new DirectionalLight("#ffb98a", 0.4);

    rim.position.set(20, 8, -14);
    this.scene.add(rim);
    this.scene.add(this.world);

    // --- the floor, plates, modules -------------------------------------------------------
    this.ground = new Mesh(
      new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      createGroundMaterial(this.theme.ground, this.theme.grid, this.theme.background),
    );
    this.ground.position.y = -0.06;
    this.ground.renderOrder = -2;
    this.world.add(this.ground);

    this.plates = new InstancedLayer(
      this.world,
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ roughness: 0.85, metalness: 0.05, color: 0xffffff }),
    );
    this.floors = new InstancedLayer(
      this.world,
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ roughness: 0.6, metalness: 0.1, color: 0xffffff }),
    );
    this.shadows = new InstancedLayer(
      this.world,
      new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      createShadowMaterial(this.shadowTexture, this.theme.dark ? 0.7 : 0.28),
      [],
      1,
    );

    for (const glyph of GLYPHS) {
      const glow = glyph === "cube" ? 0.26 : glyph === "ring" ? 0.4 : glyph === "gate" ? 0.2 : 0.05;

      this.solids.set(glyph, new InstancedLayer(this.world, createGlyphGeometry(glyph), createSolidMaterial(glow)));
      this.ghosts.set(glyph, new InstancedLayer(this.world, createGhostGeometry(glyph), this.ghostMaterial, [], 3));
    }

    this.leds = new InstancedLayer(this.world, new SphereGeometry(0.075, 12, 8), createLedMaterial());
    this.icons = new InstancedLayer(
      this.world,
      new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      createIconMaterial(this.iconAtlas),
      [{ name: "aIcon", itemSize: 1 }],
      3,
    );
    this.pulses = new InstancedLayer(
      this.world,
      new RingGeometry(0.46, 0.54, 48).rotateX(-Math.PI / 2),
      createPulseMaterial(this.time),
      [{ name: "aPhase", itemSize: 1 }],
      2,
    );
    this.glass = new InstancedLayer(this.world, new BoxGeometry(1, 1, 1), createGlassMaterial(this.time, this.theme.dark), [], 5);
    this.beacons = new InstancedLayer(
      this.world,
      new CylinderGeometry(0.03, 0.16, 1, 16, 1, true).translate(0, 0.5, 0),
      createBeaconMaterial(this.time),
      [],
      7,
    );

    // --- lines ----------------------------------------------------------------------------
    this.outlineMaterial = new LineMaterial({ linewidth: 1.2, vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false });
    this.outlines = new LineSegments2(new LineSegmentsGeometry(), this.outlineMaterial);
    this.edgeMaterial = new LineMaterial({ linewidth: 1.7, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
    this.edges = new LineSegments2(new LineSegmentsGeometry(), this.edgeMaterial);
    this.dashedMaterial = new LineMaterial({
      linewidth: 1.7,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      dashed: true,
      dashSize: 0.22,
      gapSize: 0.16,
    });
    this.dashed = new LineSegments2(new LineSegmentsGeometry(), this.dashedMaterial);

    this.hoverMaterial = new LineMaterial({ linewidth: 2.6, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, depthTest: false });
    this.hoverLines = new LineSegments2(new LineSegmentsGeometry(), this.hoverMaterial);

    for (const lines of [this.outlines, this.edges, this.dashed, this.hoverLines]) {
      lines.frustumCulled = false;
      lines.renderOrder = 4;
      this.world.add(lines);
    }

    this.hoverLines.renderOrder = 8;

    // --- packets and markers --------------------------------------------------------------
    this.packetMaterial = createPacketMaterial(this.time);
    this.packets = new Points(new BufferGeometry(), this.packetMaterial);
    this.packets.frustumCulled = false;
    this.packets.renderOrder = 6;
    this.world.add(this.packets);

    const markerMaterial = (hex: string, strength: number) =>
      new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(strength), toneMapped: false, transparent: true, depthWrite: false, side: DoubleSide });

    this.selectionMarker = new Mesh(new RingGeometry(0.62, 0.72, 56).rotateX(-Math.PI / 2), markerMaterial(PALETTE.cyan, 2.6));
    this.hoverMarker = new Mesh(new RingGeometry(0.64, 0.7, 56).rotateX(-Math.PI / 2), markerMaterial(PALETTE.ice, 1.2));
    this.selectionMarker.visible = false;
    this.hoverMarker.visible = false;
    this.world.add(this.selectionMarker, this.hoverMarker);

    // --- camera, controls, post -----------------------------------------------------------
    this.camera.position.set(0, 60, 80);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 600;
    this.controls.addEventListener("change", this.onCameraChange);
    this.controls.addEventListener("start", this.onInteraction);

    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });

    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new ShaderPass(SanitizeShader));
    this.bloom = this.theme.dark ? new UnrealBloomPass(new Vector2(1, 1), 0.55, 0.45, 0.85) : new UnrealBloomPass(new Vector2(1, 1), 0.22, 0.35, 0.96);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // --- events ---------------------------------------------------------------------------
    const canvas = this.renderer.domElement;

    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("wheel", this.onInteraction, { passive: true });
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.intersectionObserver = new IntersectionObserver((entries) => {
      this.visible = entries.some((entry) => entry.isIntersecting);
      this.requestRender();
    });
    this.intersectionObserver.observe(host);
    this.resize();
  }

  // ---------------------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------------------

  setLayout(layout: Layout | undefined) {
    const previous = this.records;
    const first = this.layout === undefined;

    this.layout = layout;

    if (!layout) {
      this.records = new Map();
      this.structureKey = "";

      for (const layer of [...this.solids.values(), ...this.ghosts.values(), this.leds, this.icons, this.pulses, this.shadows, this.glass, this.beacons, this.floors, this.plates]) {
        layer.ensure(0);
      }

      this.refreshLines(true);
      this.requestRender();

      return;
    }

    const structureKey = structureOf(layout);

    // The cluster changes all the time (a pod's status, an autoscaler's count) without anything
    // moving. Then only colours, lights and edges are refreshed: no rebuild, no animation, and
    // nothing re-uploaded that did not change.
    const canvas = this.renderer.domElement;

    if (structureKey === this.structureKey) {
      canvas.dataset.updates = String(Number(canvas.dataset.updates ?? 0) + 1);

      for (const [id, record] of this.records) {
        record.node = layout.nodes.get(id)!;
      }

      this.placePulses();
      this.placeBeacons();
      this.refreshColors();
      this.refreshLines();
      this.labelsDirty = true;
      this.requestRender();

      return;
    }

    this.structureKey = structureKey;
    this.records = new Map();
    canvas.dataset.rebuilds = String(Number(canvas.dataset.rebuilds ?? 0) + 1);

    // Instances, per glyph, in a stable order.
    const byLayer = new Map<InstancedLayer, LayoutNode[]>();

    for (const node of layout.nodes.values()) {
      const layer = (node.ghost ? this.ghosts : this.solids).get(node.glyph)!;
      const nodes = byLayer.get(layer);

      if (nodes) {
        nodes.push(node);
      } else {
        byLayer.set(layer, [node]);
      }
    }

    let grown = false;

    for (const layer of [...this.solids.values(), ...this.ghosts.values()]) {
      const nodes = byLayer.get(layer) ?? [];

      layer.ensure(nodes.length);
      nodes.forEach((node, index) => {
        // What was there stays where it is (its edges with it); only what is new grows in.
        const from = { x: node.x, y: node.y, z: node.z, s: previous.has(node.id) || first ? 1 : 0 };

        grown ||= from.s === 0;
        this.records.set(node.id, { node, layer, index, from });
      });
    }

    let led = 0;
    let shadow = 0;
    let icon = 0;

    for (const record of this.records.values()) {
      if (hasLed(record.node)) {
        (record as { led?: number }).led = led++;
      }

      if (record.node.glyph !== "ring") {
        (record as { shadow?: number }).shadow = shadow++;
      }

      (record as { icon?: number }).icon = icon++;
    }

    this.leds.ensure(led);
    this.shadows.ensure(shadow);
    this.icons.ensure(icon);

    // After ensure: growing the layer replaces its attributes.
    const iconCells = this.icons.attribute("aIcon");

    for (const record of this.records.values()) {
      iconCells.setX(record.icon!, iconIndexOf(iconKeyOf(record.node.node.gk)));
    }

    iconCells.needsUpdate = true;
    this.placePulses();
    this.layoutPlatesAndModules(layout);

    {
      const added = [...this.records.keys()].filter((id) => !previous.has(id));
      const removed = [...previous.keys()].filter((id) => !this.records.has(id));
      const shifted = [...this.records.values()].filter(({ node }) => {
        const before = previous.get(node.id)?.node;

        return before !== undefined && (before.x !== node.x || before.z !== node.z);
      }).length;

      canvas.dataset.lastRebuild = JSON.stringify({ added: added.slice(0, 5), removed: removed.slice(0, 5), addedCount: added.length, removedCount: removed.length, shifted });
    }

    this.transitionStart = grown ? performance.now() : -Infinity;
    this.writeNodes(grown ? 0 : 1);
    this.colorKey = "";
    this.refreshColors();
    this.refreshLines(true);

    const { minX, maxX, minZ, maxZ } = layout.bounds;
    const radius = Math.max(maxX - minX, maxZ - minZ, 20);

    this.ground.scale.set(radius * 4, 1, radius * 4);
    this.ground.position.x = (minX + maxX) / 2;
    this.ground.position.z = (minZ + maxZ) / 2;

    const groundMaterial = this.ground.material as ReturnType<typeof createGroundMaterial>;

    (groundMaterial.uniforms.uCenter!.value as Vector2).set((minX + maxX) / 2, (minZ + maxZ) / 2);
    groundMaterial.uniforms.uRadius!.value = radius * 1.4;
    (this.scene.fog as FogExp2).density = 1.1 / (radius * 2.2);
    this.controls.maxDistance = Math.max(radius * 3, 60);

    this.labelsDirty = true;
    this.requestRender();
  }

  /** Pulses under whatever is broken: the one thing that should catch the eye from afar. */
  private placePulses() {
    const broken = [...this.records.values()].filter((record) => record.node.health === "error");
    const key = broken.map((record) => record.node.id).join("|");

    if (key === (this.pulses as unknown as { key?: string }).key) {
      return;
    }

    (this.pulses as unknown as { key?: string }).key = key;
    this.pulses.ensure(broken.length);

    // After ensure: growing the layer replaces its attributes.
    const phases = this.pulses.attribute("aPhase");

    broken.forEach((record, index) => {
      const { node } = record;
      const footprint = GLYPH_FOOTPRINT[node.glyph];
      const size = Math.max(footprint.w, footprint.d) * 1.25;

      matrix.compose(position.set(node.x, this.baseOf(node) + 0.015, node.z), quaternion.identity(), scale.set(size, 1, size));
      this.pulses.mesh.setMatrixAt(index, matrix);
      this.pulses.mesh.setColorAt(index, color.set(node.ghost ? PALETTE.red : HEALTH_COLORS.error));
      phases.setX(index, (index * 0.618) % 1);
    });
    this.pulses.commit();
  }

  setEmphasis(emphasis: SceneEmphasis) {
    const previous = this.emphasis;

    this.emphasis = emphasis;

    if (emphasis.matches !== previous.matches) {
      this.matchesVersion++;
    }

    if (emphasis.hovered?.type !== previous.hovered?.type || emphasis.hovered?.id !== previous.hovered?.id) {
      this.placeMarkers();
      this.rebuildHoverLines();
    }

    this.refreshColors();
    this.refreshLines();
    this.placeBeacons();
    this.labelsDirty = true;
    this.requestRender();
  }

  /** Selection, search and the problems filter: what colours and edges depend on, besides the data. */
  private emphasisKey() {
    const { selected, problemsOnly } = this.emphasis;

    return `${selected?.type ?? ""}:${selected?.id ?? ""}|${problemsOnly ? 1 : 0}|${this.matchesVersion}`;
  }

  private refreshColors() {
    const layout = this.layout;

    if (!layout) {
      return;
    }

    let key = this.emphasisKey();

    for (const node of layout.nodes.values()) {
      key += `|${node.health}${node.node.state}`;
    }

    for (const app of layout.apps.values()) {
      key += `|${app.app.health}`;
    }

    if (key !== this.colorKey) {
      this.colorKey = key;
      this.recolor();
    }
  }

  private refreshLines(force = false) {
    let key = this.emphasisKey();

    for (const edge of this.layout?.edges ?? []) {
      key += `|${edge.id}${edge.state}`;
    }

    if (force || key !== this.linesKey) {
      this.linesKey = key;
      this.rebuildLines();
    }

    this.rebuildHoverLines();
  }

  setOptions(options: SceneOptions) {
    this.options = options;
    this.packets.visible = options.traffic;
    this.labelsDirty = true;
    this.touch();
    this.requestRender();
  }

  fly(target: Selection | "overview", immediate = false) {
    const goal = this.frame(target);

    if (!goal) {
      return;
    }

    const { center, radius, polar } = goal;
    this.keepCameraSane();

    const offset = new Vector3().subVectors(this.camera.position, this.controls.target);
    const spherical = new Spherical().setFromVector3(offset.lengthSq() > 0 ? offset : new Vector3(0, 1, 1));
    const verticalHalf = (FOV * Math.PI) / 360;
    const horizontalHalf = Math.atan(Math.tan(verticalHalf) * this.camera.aspect);
    const distance = (radius / Math.sin(Math.min(verticalHalf, horizontalHalf))) * 1.05;

    spherical.radius = Math.max(distance, this.controls.minDistance + 0.5);
    spherical.phi = polar;

    const toPosition = new Vector3().setFromSpherical(spherical).add(center);

    this.flight = {
      fromPosition: (Number.isFinite(this.camera.position.lengthSq()) ? this.camera.position : this.safePosition).clone(),
      fromTarget: (Number.isFinite(this.controls.target.lengthSq()) ? this.controls.target : this.safeTarget).clone(),
      toPosition,
      toTarget: center,
      start: performance.now(),
      duration: immediate ? 0 : FLIGHT_MS,
    };
    this.touch();
    this.requestRender();
  }

  cameraMemory(): CameraMemory {
    const { x, y, z } = this.camera.position;
    const target = this.controls.target;

    return { position: [x, y, z], target: [target.x, target.y, target.z] };
  }

  restoreCamera(memory: CameraMemory) {
    this.camera.position.set(...memory.position);
    this.controls.target.set(...memory.target);
    this.controls.update();
    this.requestRender();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hoverClear);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.controls.removeEventListener("change", this.onCameraChange);
    this.controls.removeEventListener("start", this.onInteraction);
    this.controls.dispose();

    const materials = new Set<Material>();

    for (const layer of [...this.solids.values(), ...this.ghosts.values(), this.leds, this.icons, this.pulses, this.shadows, this.glass, this.beacons, this.floors, this.plates]) {
      materials.add(layer.material);
      layer.dispose();
    }

    for (const lines of [this.outlines, this.edges, this.dashed, this.hoverLines]) {
      lines.geometry.dispose();
      materials.add(lines.material as Material);
    }

    for (const mesh of [this.ground, this.selectionMarker, this.hoverMarker]) {
      mesh.geometry.dispose();
      materials.add(mesh.material as Material);
    }

    this.packets.geometry.dispose();
    materials.add(this.packetMaterial);
    materials.forEach((material) => material.dispose());
    this.shadowTexture.dispose();
    this.iconAtlas.dispose();
    this.environment.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.dispose();
  }

  // ---------------------------------------------------------------------------------------
  // Building
  // ---------------------------------------------------------------------------------------

  private baseOf(node: LayoutNode) {
    return node.appId ? FLOOR : 0.02;
  }

  private layoutPlatesAndModules(layout: Layout) {
    const districts = [...layout.districts.values()];

    this.plates.ensure(districts.length);
    districts.forEach((district, index) => {
      matrix.compose(position.set(district.x, -0.03, district.z), quaternion.identity(), scale.set(district.width, 0.06, district.depth));
      this.plates.mesh.setMatrixAt(index, matrix);
      this.plates.mesh.setColorAt(index, this.theme.plate);
    });
    this.plates.commit();

    const apps = [...layout.apps.values()];

    this.floors.ensure(apps.length);
    this.glass.ensure(apps.length);
    apps.forEach((app, index) => {
      matrix.compose(position.set(app.x, FLOOR / 2, app.z), quaternion.identity(), scale.set(app.width, FLOOR, app.depth));
      this.floors.mesh.setMatrixAt(index, matrix);
      this.floors.mesh.setColorAt(index, this.theme.floor);
      matrix.compose(position.set(app.x, FLOOR + app.height / 2, app.z), quaternion.identity(), scale.set(app.width, app.height, app.depth));
      this.glass.mesh.setMatrixAt(index, matrix);
    });
    this.floors.commit();
    this.glass.commit();
    this.placeBeacons();
  }

  /** Beacons over apps with something broken; not over the one being looked at. */
  private placeBeacons() {
    const layout = this.layout;
    const { selected } = this.emphasis;
    const selectedApp = selected?.type === "app" ? selected.id : selected?.type === "node" ? layout?.nodes.get(selected.id)?.appId : undefined;
    const broken = [...(layout?.apps.values() ?? [])].filter((app) => app.app.health === "error" && app.id !== selectedApp);

    this.beacons.ensure(broken.length);
    broken.forEach((app, index) => {
      const height = 6 + Math.max(app.width, app.depth) * 0.8;

      matrix.compose(position.set(app.x, FLOOR + app.height, app.z), quaternion.identity(), scale.set(1, height, 1));
      this.beacons.mesh.setMatrixAt(index, matrix);
      this.beacons.mesh.setColorAt(index, color.set(app.app.missing > 0 ? PALETTE.red : HEALTH_COLORS.error));
    });
    this.beacons.commit();
  }

  /** Writes every resource's matrix, `t` of the way from where it was to where it goes. */
  private writeNodes(t: number) {
    const k = ease(Math.min(Math.max(t, 0), 1));

    for (const record of this.records.values()) {
      const { node, from } = record;
      const x = from.x + (node.x - from.x) * k;
      const y = from.y + (node.y - from.y) * k;
      const z = from.z + (node.z - from.z) * k;
      const s = from.s + (1 - from.s) * k;
      const base = this.baseOf(node);

      matrix.compose(position.set(x, base + y, z), quaternion.identity(), scale.set(s, s * node.heightScale, s));
      record.layer.mesh.setMatrixAt(record.index, matrix);

      const footprint = GLYPH_FOOTPRINT[node.glyph];
      const top = base + y + (footprint.h * node.heightScale * s) / 2;

      // The kind's icon on the top face; the status light on the far vertex, clear of it.
      if (record.icon !== undefined) {
        matrix.compose(position.set(x, top + 0.004, z), quaternion.identity(), scale.set(footprint.w * 0.6 * s, 1, footprint.w * 0.6 * s));
        this.icons.mesh.setMatrixAt(record.icon, matrix);
      }

      if (record.led !== undefined) {
        matrix.compose(position.set(x, top + 0.07, z - footprint.w * 0.4), quaternion.identity(), scale.set(s * 0.8, s * 0.8, s * 0.8));
        this.leds.mesh.setMatrixAt(record.led, matrix);
      }

      if (record.shadow !== undefined) {
        matrix.compose(position.set(x, base + 0.004, z), quaternion.identity(), scale.set(footprint.w * 1.7 * s, 1, footprint.d * 1.7 * s));
        this.shadows.mesh.setMatrixAt(record.shadow, matrix);
      }
    }

    for (const layer of [...this.solids.values(), ...this.ghosts.values(), this.leds, this.shadows, this.icons]) {
      layer.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** How much each resource stands out, from the selection, the search and the problems filter. */
  private computeFactors() {
    const layout = this.layout;
    const factors = new Map<ObjectKey, number>();

    if (!layout) {
      return factors;
    }

    const { selected, matches, problemsOnly } = this.emphasis;
    let focus: Set<ObjectKey> | undefined;

    if (selected?.type === "node" && layout.nodes.has(selected.id)) {
      focus = new Set([selected.id, ...this.neighbours(selected.id)]);
    } else if (selected?.type === "app") {
      focus = new Set();

      for (const node of layout.nodes.values()) {
        if (node.appId === selected.id) {
          focus.add(node.id);
        }
      }

      for (const id of [...focus]) {
        this.neighbours(id).forEach((other) => focus!.add(other));
      }
    } else if (selected?.type === "district") {
      focus = new Set([...layout.nodes.values()].filter((node) => node.districtId === selected.id).map((node) => node.id));
    }

    for (const node of layout.nodes.values()) {
      let factor = 1;

      // Landmarks (the internet) are context for everything: never dimmed.
      if (node.importance >= 20) {
        factors.set(node.id, 1);
        continue;
      }

      if (focus && !focus.has(node.id)) {
        factor = Math.min(factor, 0.2);
      }

      if (matches && !matches.has(node.id)) {
        factor = Math.min(factor, 0.16);
      }

      if (problemsOnly && node.health !== "error" && node.health !== "warn") {
        factor = Math.min(factor, 0.22);
      }

      factors.set(node.id, factor);
    }

    return factors;
  }

  private neighbours(id: ObjectKey): ObjectKey[] {
    return (this.layout?.edgesByNode.get(id) ?? []).map((edge) => (edge.from === id ? edge.to : edge.from));
  }

  private recolor() {
    const layout = this.layout;

    if (!layout) {
      return;
    }

    this.factors = this.computeFactors();

    for (const record of this.records.values()) {
      const { node } = record;
      const factor = this.factors.get(node.id) ?? 1;

      if (node.ghost) {
        color.set(node.node.state === "missing" ? PALETTE.red : PALETTE.slate).multiplyScalar(node.node.state === "missing" ? 1.6 : 1);
      } else if (node.glyph === "cube") {
        color.set(POD_BODY[node.health]);
      } else {
        color.set(node.color);
      }

      color.multiplyScalar(factor);
      record.layer.mesh.setColorAt(record.index, color);

      if (record.led !== undefined) {
        color.set(HEALTH_COLORS[node.health]).multiplyScalar((node.health === "idle" ? 1.2 : 3.2) * factor);
        this.leds.mesh.setColorAt(record.led, color);
      }

      if (record.icon !== undefined) {
        if (node.ghost) {
          color.set(node.node.state === "missing" ? PALETTE.red : PALETTE.grey);
        } else {
          color.setRGB(1, 1, 1);
        }

        this.icons.mesh.setColorAt(record.icon, color.multiplyScalar(Math.max(factor, 0.25)));
      }
    }

    // Modules follow their app's health, and the selection.
    const { selected, matches, problemsOnly } = this.emphasis;
    const selectedApp =
      selected?.type === "app" ? selected.id : selected?.type === "node" ? layout.nodes.get(selected.id)?.appId : undefined;

    [...layout.apps.values()].forEach((app, index) => {
      let factor = 1;

      if (selected && selected.type !== "district" && app.id !== selectedApp) {
        factor = 0.35;
      }

      if (selected?.type === "district" && app.districtId !== selected.id) {
        factor = 0.35;
      }

      if (matches && !app.app.members.some((id) => matches.has(id))) {
        factor = Math.min(factor, 0.3);
      }

      if (problemsOnly && app.app.health !== "error" && app.app.health !== "warn") {
        factor = Math.min(factor, 0.3);
      }

      color.set(APP_TINT[app.app.health]).multiplyScalar(factor * (app.id === selectedApp ? 1.7 : 1));
      this.glass.mesh.setColorAt(index, color);
    });

    for (const layer of [...this.solids.values(), ...this.ghosts.values(), this.leds, this.glass, this.icons]) {
      if (layer.mesh.instanceColor) {
        layer.mesh.instanceColor.needsUpdate = true;
      }
    }

    this.placeMarkers();
    this.placeBeacons();
  }

  private placeMarkers() {
    const place = (marker: Mesh, target: Selection | undefined) => {
      const node = target?.type === "node" ? this.layout?.nodes.get(target.id) : undefined;

      marker.visible = node !== undefined;

      if (node) {
        const footprint = GLYPH_FOOTPRINT[node.glyph];
        const size = Math.max(footprint.w, footprint.d) * 0.95 + 0.25;

        marker.position.set(node.x, this.baseOf(node) + 0.02, node.z);
        marker.scale.set(size, 1, size);
      }
    };

    place(this.selectionMarker, this.emphasis.selected);
    place(this.hoverMarker, this.emphasis.hovered?.id === this.emphasis.selected?.id ? undefined : this.emphasis.hovered);
  }

  /** The pointer's own overlay: every edge of the hovered resource, bright, on top. Cheap to redo per hover. */
  private rebuildHoverLines() {
    const layout = this.layout;
    const hovered = this.emphasis.hovered;
    const positions: number[] = [];
    const colors: number[] = [];

    if (layout && hovered?.type === "node") {
      for (const edge of layout.edgesByNode.get(hovered.id) ?? []) {
        const from = layout.nodes.get(edge.from);
        const to = layout.nodes.get(edge.to);

        if (!from || !to) {
          continue;
        }

        const start = new Vector3(from.x, this.baseOf(from) + from.y, from.z);
        const end = new Vector3(to.x, this.baseOf(to) + to.y, to.z);
        const length = start.distanceTo(end);
        const control = new Vector3().addVectors(start, end).multiplyScalar(0.5);
        const edgeColor = new Color(edge.color).multiplyScalar(2.2);
        const segments = Math.min(Math.max(Math.ceil(length / 0.9), 4), 18);
        let previous = start;

        control.y += Math.min(0.35 + length * 0.14, 7);

        for (let i = 1; i <= segments; i++) {
          const t = i / segments;
          const point = new Vector3(
            (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * end.x,
            (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * end.y,
            (1 - t) * (1 - t) * start.z + 2 * (1 - t) * t * control.z + t * t * end.z,
          );

          positions.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
          colors.push(edgeColor.r, edgeColor.g, edgeColor.b, edgeColor.r, edgeColor.g, edgeColor.b);
          previous = point;
        }
      }
    }

    const geometry = new LineSegmentsGeometry();

    if (positions.length > 0) {
      geometry.setPositions(positions);
      geometry.setColors(colors);
    }

    this.hoverLines.geometry.dispose();
    this.hoverLines.geometry = geometry;
    this.hoverLines.visible = positions.length > 0;
  }

  /** Edges worth drawing now: every edge inside an app, and the rest around what the user looks at. */
  private visibleEdges(): LayoutEdge[] {
    const layout = this.layout;

    if (!layout) {
      return [];
    }

    const { selected } = this.emphasis;
    const around = new Set<ObjectKey>();

    for (const target of [selected]) {
      if (target?.type === "node") {
        around.add(target.id);
      } else if (target?.type === "app") {
        layout.apps.get(target.id)?.app.members.forEach((id) => around.add(id));
      }
    }

    return layout.edges.filter((edge) => edge.local || around.has(edge.from) || around.has(edge.to));
  }

  private rebuildLines() {
    const layout = this.layout;
    const solid: number[] = [];
    const solidColors: number[] = [];
    const dashed: number[] = [];
    const dashedColors: number[] = [];
    const packetData: Array<{ start: Vector3; control: Vector3; end: Vector3; color: Color; length: number; count: number; pace: number }> = [];

    if (layout) {
      const { selected } = this.emphasis;
      const hot = new Set<ObjectKey>();

      if (selected?.type === "node") {
        hot.add(selected.id);
      }

      for (const edge of this.visibleEdges()) {
        const from = layout.nodes.get(edge.from);
        const to = layout.nodes.get(edge.to);

        if (!from || !to) {
          continue;
        }

        const start = new Vector3(from.x, this.baseOf(from) + from.y, from.z);
        const end = new Vector3(to.x, this.baseOf(to) + to.y, to.z);
        const length = start.distanceTo(end);
        const lift = Math.min(0.35 + length * 0.14, 7);
        const control = new Vector3().addVectors(start, end).multiplyScalar(0.5);

        control.y += lift;

        const factor = Math.min(this.factors.get(edge.from) ?? 1, this.factors.get(edge.to) ?? 1);
        const isHot = hot.has(edge.from) || hot.has(edge.to);
        const edgeColor = new Color(edge.color).multiplyScalar(factor * (isHot ? 2.2 : 0.85));
        const target = edge.state === "resolved" ? solid : dashed;
        const colors = edge.state === "resolved" ? solidColors : dashedColors;
        const segments = Math.min(Math.max(Math.ceil(length / 0.9), 4), 18);
        let previous = start;

        for (let i = 1; i <= segments; i++) {
          const t = i / segments;
          const point = new Vector3(
            (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * end.x,
            (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * end.y,
            (1 - t) * (1 - t) * start.z + 2 * (1 - t) * t * control.z + t * t * end.z,
          );

          target.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
          colors.push(edgeColor.r, edgeColor.g, edgeColor.b, edgeColor.r, edgeColor.g, edgeColor.b);
          previous = point;
        }

        if (edge.flow) {
          packetData.push({
            start,
            control,
            end,
            color: new Color(edge.color).multiplyScalar(factor * (isHot ? 1.5 : 1)),
            length,
            ...packetsFor(edge),
          });
        }
      }
    }

    const setLines = (lines: LineSegments2, positions: number[], colors: number[]) => {
      const geometry = new LineSegmentsGeometry();

      if (positions.length > 0) {
        geometry.setPositions(positions);
        geometry.setColors(colors);
      }

      lines.geometry.dispose();
      lines.geometry = geometry;
      lines.visible = positions.length > 0;
    };

    setLines(this.edges, solid, solidColors);
    setLines(this.dashed, dashed, dashedColors);

    if (dashed.length > 0) {
      this.dashed.computeLineDistances();
    }

    // District outlines.
    const outline: number[] = [];
    const outlineColors: number[] = [];

    for (const district of layout?.districts.values() ?? []) {
      const x0 = district.x - district.width / 2;
      const x1 = district.x + district.width / 2;
      const z0 = district.z - district.depth / 2;
      const z1 = district.z + district.depth / 2;
      const y = 0.005;
      const tint = new Color(district.health === "error" ? PALETTE.red : district.health === "warn" ? PALETTE.gold : PALETTE.cyan).multiplyScalar(
        this.theme.dark ? 0.55 : 0.8,
      );

      outline.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);

      for (let i = 0; i < 8; i++) {
        outlineColors.push(tint.r, tint.g, tint.b);
      }
    }

    setLines(this.outlines, outline, outlineColors);

    // Packets: a few per traffic edge, spaced along it, speed in world units per second.
    const count = packetData.reduce((sum, packet) => sum + packet.count, 0);
    const starts = new Float32Array(count * 3);
    const controls = new Float32Array(count * 3);
    const ends = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const speeds = new Float32Array(count);
    const colors = new Float32Array(count * 3);

    let i = 0;

    packetData.forEach((packet, edgeIndex) => {
      for (let j = 0; j < packet.count; j++, i++) {
        packet.start.toArray(starts, i * 3);
        packet.control.toArray(controls, i * 3);
        packet.end.toArray(ends, i * 3);
        phases[i] = j / packet.count + ((edgeIndex * 0.37) % 1) / packet.count;
        speeds[i] = (2.2 * packet.pace) / Math.max(packet.length, 0.5);
        packet.color.toArray(colors, i * 3);
      }
    });

    const geometry = new BufferGeometry();

    geometry.setAttribute("position", new BufferAttribute(starts, 3));
    geometry.setAttribute("aStart", new BufferAttribute(starts, 3));
    geometry.setAttribute("aControl", new BufferAttribute(controls, 3));
    geometry.setAttribute("aEnd", new BufferAttribute(ends, 3));
    geometry.setAttribute("aPhase", new BufferAttribute(phases, 1));
    geometry.setAttribute("aSpeed", new BufferAttribute(speeds, 1));
    geometry.setAttribute("aColor", new BufferAttribute(colors, 3));
    this.packets.geometry.dispose();
    this.packets.geometry = geometry;
  }

  // ---------------------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------------------

  private frame(target: Selection | "overview"): { center: Vector3; radius: number; polar: number } | undefined {
    const layout = this.layout;

    if (!layout) {
      return undefined;
    }

    if (target === "overview") {
      const { minX, maxX, minZ, maxZ } = layout.bounds;

      return {
        center: new Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2),
        radius: Math.max(maxX - minX, maxZ - minZ, 12) * 0.46,
        polar: 0.72,
      };
    }

    if (target.type === "node") {
      const node = layout.nodes.get(target.id);

      return node ? { center: new Vector3(node.x, this.baseOf(node) + node.y, node.z), radius: 4.2, polar: 1.0 } : undefined;
    }

    if (target.type === "app") {
      const app = layout.apps.get(target.id);

      return app ? { center: new Vector3(app.x, app.height * 0.3, app.z), radius: Math.max(app.width, app.depth) * 0.55 + 1.2, polar: 0.86 } : undefined;
    }

    const district = layout.districts.get(target.id);

    return district ? { center: new Vector3(district.x, 0, district.z), radius: Math.max(district.width, district.depth) * 0.52, polar: 0.88 } : undefined;
  }

  // ---------------------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------------------

  /** Nearest resource under the pointer on screen, then a module, then a district. */
  private pick(clientX: number, clientY: number): Selection | undefined {
    const layout = this.layout;

    if (!layout) {
      return undefined;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const focal = this.height / 2 / Math.tan((FOV * Math.PI) / 360);
    const projected = new Vector3();
    let best: { id: ObjectKey; score: number } | undefined;

    for (const node of layout.nodes.values()) {
      projected.set(node.x, this.baseOf(node) + node.y, node.z);

      const distance = projected.distanceTo(this.camera.position);

      projected.project(this.camera);

      if (projected.z < -1 || projected.z > 1) {
        continue;
      }

      const sx = (projected.x * 0.5 + 0.5) * this.width;
      const sy = (-projected.y * 0.5 + 0.5) * this.height;
      const footprint = GLYPH_FOOTPRINT[node.glyph];
      const radius = Math.max(7, (Math.max(footprint.w, footprint.h * node.heightScale, footprint.d) * 0.55 * focal) / distance);
      const offset = Math.hypot(sx - px, sy - py);

      if (offset < radius) {
        const score = offset / radius + distance * 0.001;

        if (!best || score < best.score) {
          best = { id: node.id, score };
        }
      }
    }

    if (best) {
      return { type: "node", id: best.id };
    }

    this.raycaster.setFromCamera(new Vector2((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1), this.camera);

    const box = new Box3();
    const hit = new Vector3();
    let nearestApp: { id: string; distance: number } | undefined;

    for (const app of layout.apps.values()) {
      box.min.set(app.x - app.width / 2, 0, app.z - app.depth / 2);
      box.max.set(app.x + app.width / 2, FLOOR + app.height, app.z + app.depth / 2);

      if (this.raycaster.ray.intersectBox(box, hit)) {
        const distance = hit.distanceTo(this.camera.position);

        if (!nearestApp || distance < nearestApp.distance) {
          nearestApp = { id: app.id, distance };
        }
      }
    }

    if (nearestApp) {
      return { type: "app", id: nearestApp.id };
    }

    if (this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), hit)) {
      for (const district of layout.districts.values()) {
        if (Math.abs(hit.x - district.x) <= district.width / 2 && Math.abs(hit.z - district.z) <= district.depth / 2) {
          return { type: "district", id: district.id };
        }
      }
    }

    return undefined;
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    this.touch();

    const pointer = this.pointer;

    this.pointer = {
      x: event.clientX,
      y: event.clientY,
      downX: pointer?.downX ?? Number.NaN,
      downY: pointer?.downY ?? Number.NaN,
      downAt: pointer?.downAt ?? 0,
    };

    if (event.buttons !== 0 || this.hoverScheduled) {
      return;
    }

    this.hoverScheduled = true;
    requestAnimationFrame(() => {
      this.hoverScheduled = false;

      if (this.disposed || !this.pointer) {
        return;
      }

      const picked = this.pick(this.pointer.x, this.pointer.y);
      const target = picked?.type === "district" ? undefined : picked;

      this.renderer.domElement.style.cursor = target ? "pointer" : "";
      clearTimeout(this.hoverClear);

      // Crossing the gap between two resources must not drop the highlighted edges for a frame:
      // another target takes over at once, empty space only after a moment.
      if (target) {
        this.events.hover(target);
      } else {
        this.hoverClear = setTimeout(() => !this.disposed && this.events.hover(undefined), HOVER_LINGER_MS);
      }
    });
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    // So the keyboard shortcuts reach the viewport after a click into it.
    this.host.focus({ preventScroll: true });
    this.pointer = { x: event.clientX, y: event.clientY, downX: event.clientX, downY: event.clientY, downAt: performance.now() };
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const pointer = this.pointer;

    if (!pointer || event.button !== 0 || Number.isNaN(pointer.downX)) {
      return;
    }

    const moved = Math.hypot(event.clientX - pointer.downX, event.clientY - pointer.downY);

    this.pointer = { ...pointer, downX: Number.NaN, downY: Number.NaN };

    if (moved < 5 && performance.now() - pointer.downAt < 500) {
      this.events.select(this.pick(event.clientX, event.clientY));
    }
  };

  private readonly onPointerLeave = () => {
    clearTimeout(this.hoverClear);
    this.pointer = undefined;
    this.events.hover(undefined);
  };

  private readonly onDoubleClick = (event: MouseEvent) => {
    const target = this.pick(event.clientX, event.clientY);

    if (target) {
      this.events.open(target);
    }
  };

  // ---------------------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------------------

  private updateLabels() {
    const layout = this.layout;

    if (!layout) {
      this.labels.clear();

      return;
    }

    const items: LabelItem[] = [];
    const focal = this.height / 2 / Math.tan((FOV * Math.PI) / 360);
    const { selected, hovered } = this.emphasis;
    const pixelsPerUnit = (x: number, y: number, z: number) => focal / Math.max(this.camera.position.distanceTo(position.set(x, y, z)), 0.001);

    for (const district of layout.districts.values()) {
      const size = district.width * pixelsPerUnit(district.x, 0, district.z);
      const key = `d:${district.id}`;

      // Hysteresis: a label that is up stays until it is clearly too small, so zooming does not
      // make whole groups of labels blink in and out at one threshold.
      if (size < (this.labels.has(key) ? 34 : 50) && layout.districts.size > 1) {
        continue;
      }

      items.push({
        key,
        x: district.lane ? district.x - district.width / 2 + 2.2 : district.x,
        y: 0,
        z: district.lane ? district.z + 0.35 : district.z + district.depth / 2 + 0.4,
        text: district.title ?? (district.namespace || "cluster-scoped"),
        sub:
          district.caption ??
          `${district.apps} app${district.apps === 1 ? "" : "s"} · ${district.resources} resources${district.problems ? ` · ${district.problems} issues` : ""}`,
        variant: "district",
        priority: 1900 + Math.min(size, 99) + (this.labels.has(key) ? 50 : 0),
        dot: district.health === "error" || district.health === "warn" ? HEALTH_COLORS[district.health] : undefined,
      });
    }

    const selectedApp = selected?.type === "app" ? selected.id : selected?.type === "node" ? layout.nodes.get(selected.id)?.appId : undefined;

    for (const app of layout.apps.values()) {
      const size = app.width * pixelsPerUnit(app.x, app.height, app.z);
      const isSelected = app.id === selectedApp || (hovered?.type === "app" && hovered.id === app.id);
      const shown = this.labels.has(`a:${app.id}`);

      if (size < (shown ? 32 : 46) && !isSelected) {
        continue;
      }

      const { pods, readyPods, problems, missing } = app.app;
      const parts = [pods > 0 ? `${readyPods}/${pods} pods` : `${app.app.members.length} resources`];

      if (missing > 0) {
        parts.push(`${missing} missing`);
      } else if (problems > 0) {
        parts.push(`${problems} issue${problems === 1 ? "" : "s"}`);
      }

      items.push({
        key: `a:${app.id}`,
        x: app.x,
        y: FLOOR + app.height + 0.15,
        z: app.z - app.depth / 2,
        text: app.app.name,
        sub: parts.join(" · "),
        variant: "app",
        priority: (isSelected ? 3000 : 500) + Math.min(size, 300) + (shown ? 200 : 0),
        dot: HEALTH_COLORS[app.app.health],
        emphasis: isSelected,
      });
    }

    // Resources: around the selection and the pointer always; the rest when close enough.
    const hot = new Set<ObjectKey>();
    const warm = new Set<ObjectKey>();

    if (selected?.type === "node") {
      hot.add(selected.id);
      this.neighbours(selected.id).forEach((id) => warm.add(id));
    }

    if (hovered?.type === "node") {
      hot.add(hovered.id);

      if (this.options.labels) {
        this.neighbours(hovered.id).forEach((id) => warm.add(id));
      }
    }

    if (selectedApp && this.options.labels) {
      layout.apps.get(selectedApp)?.app.members.forEach((id) => warm.add(id));
    }

    const candidates: Array<{ node: LayoutNode; priority: number }> = [];

    for (const node of layout.nodes.values()) {
      const isHot = hot.has(node.id);
      const isWarm = warm.has(node.id);

      if (!isHot && !this.options.labels) {
        continue;
      }

      const pixels = pixelsPerUnit(node.x, node.y, node.z);
      const shown = this.labels.has(`n:${node.id}`);
      // Landmarks (the internet) are named at any distance.
      const landmark = node.importance >= 20;

      if (!isHot && !isWarm && !landmark && pixels < (shown ? 24 : 34)) {
        continue;
      }

      if (!isHot && isWarm && pixels < (shown ? 10 : 14)) {
        continue;
      }

      candidates.push({ node, priority: (isHot ? 5000 : landmark ? 2600 : isWarm ? 1200 : 0) + node.importance * 25 + Math.min(pixels, 120) + (shown ? 150 : 0) });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    for (const { node, priority } of candidates.slice(0, 260)) {
      const footprint = GLYPH_FOOTPRINT[node.glyph];
      const summary = node.node.summary;

      items.push({
        key: `n:${node.id}`,
        x: node.x,
        y: this.baseOf(node) + node.y + (footprint.h * node.heightScale) / 2 + 0.28,
        z: node.z,
        text: node.node.name,
        kind: iconKeyOf(node.node.gk),
        sub: hot.has(node.id) ? [node.node.state === "present" ? node.node.gk.kind : `${node.node.gk.kind} (${node.node.state})`, summary].filter(Boolean).join(" · ") : undefined,
        variant: "node",
        priority,
        dot: node.ghost || node.health === "error" || node.health === "warn" ? HEALTH_COLORS[node.health] : undefined,
        emphasis: hot.has(node.id),
      });
    }

    this.labels.update(items, this.camera, this.width, this.height);
  }

  // ---------------------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------------------

  private readonly onCameraChange = () => {
    this.labelsDirty = true;
    this.requestRender();
  };

  private readonly onInteraction = () => {
    this.touch();
    this.flight = undefined;
  };

  private readonly onVisibilityChange = () => this.requestRender();

  private touch() {
    this.lastInteraction = performance.now();
    this.requestRender();
  }

  private resize(force = false) {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);

    if (!force && width === this.width && height === this.height) {
      return;
    }

    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(width, height);

    for (const material of [this.edgeMaterial, this.dashedMaterial, this.outlineMaterial, this.hoverMaterial]) {
      material.resolution.set(width, height);
    }

    this.packetMaterial.uniforms.uScale!.value = (height * this.pixelRatio) / 2 / Math.tan((FOV * Math.PI) / 360);
    this.labelsDirty = true;
    this.dirty = true;
    this.requestRender();
  }

  private requestRender() {
    this.dirty = true;

    if (!this.raf && !this.disposed) {
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  /** Animation that runs on its own (packets, pulses, ghosts), paced down as the user goes idle. */
  private ambientInterval(now: number) {
    const hasAmbient =
      (this.options.traffic && (this.packets.geometry.getAttribute("aPhase")?.count ?? 0) > 0) ||
      this.pulses.count > 0 ||
      this.beacons.count > 0 ||
      [...this.ghosts.values()].some((layer) => layer.count > 0);

    if (!hasAmbient) {
      return Infinity;
    }

    const idle = now - this.lastInteraction;

    return idle < IDLE_AFTER_MS ? 1000 / 30 : idle < SLEEP_AFTER_MS ? 1000 / 10 : Infinity;
  }

  private readonly loop = (now: number) => {
    this.raf = 0;

    // A canvas Lens has taken out of the page (the tab closed, the extension reloaded) draws nothing.
    if (this.disposed || document.hidden || !this.visible || this.width <= 1 || !this.renderer.domElement.isConnected) {
      return;
    }

    const delta = Math.min((now - (this.lastFrame || now)) / 1000, 0.1);

    this.lastFrame = now;

    let moving = false;

    if (this.flight) {
      const { fromPosition, fromTarget, toPosition, toTarget, start, duration } = this.flight;
      const t = duration === 0 ? 1 : Math.min((now - start) / duration, 1);
      const k = ease(t);

      this.camera.position.lerpVectors(fromPosition, toPosition, k);
      this.controls.target.lerpVectors(fromTarget, toTarget, k);
      this.labelsDirty = true;
      moving = true;

      if (t >= 1) {
        this.flight = undefined;
      }
    }

    if (this.controls.update(delta)) {
      moving = true;
    }

    this.keepCameraSane();

    const transition = (now - this.transitionStart) / TRANSITION_MS;

    if (transition >= 0 && transition <= 1.05) {
      this.writeNodes(transition);
      moving = true;
    }

    const ambient = this.ambientInterval(now);
    const sinceRender = now - this.lastRender;
    const wanted = moving || this.dirty || (this.labelsDirty && !moving);
    // Every frame while anything moves: a frame skipped mid-motion can present a stale buffer.
    const due = wanted || sinceRender >= ambient;

    if (due) {
      this.time.value += Math.min(sinceRender, 100) / 1000;
      this.ghostMaterial.opacity = 0.55 + 0.35 * Math.sin(this.time.value * 3);
      this.composer.render(delta);
      this.adaptQuality(sinceRender, moving);
      this.lastRender = now;
      this.dirty = false;

      // Choosing which labels fit is DOM work: at most every so often while the camera moves,
      // with the chosen ones following the camera every frame in between.
      if (this.labelsDirty && (!moving || now - this.lastLabelLayout >= LABEL_LAYOUT_MS)) {
        this.updateLabels();
        this.lastLabelLayout = now;
        this.labelsDirty = false;
      } else if (moving) {
        this.labels.reposition(this.camera, this.width, this.height);
      }
    }

    // One frame in flight at most: a camera change during this frame may already have asked for the next.
    if ((wanted || moving || Number.isFinite(ambient)) && !this.raf) {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  /**
   * Zooming to the cursor can drive OrbitControls into a degenerate state (camera on its target),
   * after which every number it produces is NaN and stays NaN: the whole scene vanishes for good.
   * Each frame the camera is checked; a broken one goes back to the last good state, with the
   * controls' pending motion cleared so the NaN cannot come back from their damping.
   */
  private keepCameraSane() {
    const finite = (x: number, y: number, z: number) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
    const { position, quaternion } = this.camera;
    const target = this.controls.target;
    const sane =
      finite(position.x, position.y, position.z) &&
      finite(target.x, target.y, target.z) &&
      Number.isFinite(quaternion.x + quaternion.y + quaternion.z + quaternion.w) &&
      position.distanceToSquared(target) > 1e-4;

    if (sane) {
      this.keepCameraAboveTheFloor();
      this.safePosition.copy(position);
      this.safeTarget.copy(target);

      return;
    }

    const internals = this.controls as unknown as {
      _sphericalDelta?: { set: (radius: number, phi: number, theta: number) => void };
      _panOffset?: Vector3;
      _scale?: number;
    };

    internals._sphericalDelta?.set(0, 0, 0);
    internals._panOffset?.set(0, 0, 0);
    internals._scale = 1;
    this.flight = undefined;
    position.copy(this.safePosition);
    target.copy(this.safeTarget);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();

    const canvas = this.renderer.domElement;

    canvas.dataset.cameraResets = String(Number(canvas.dataset.cameraResets ?? 0) + 1);
  }

  /**
   * Zooming to the cursor keeps the orbit target a fixed distance ahead of the camera, which on a
   * steep zoom puts it under the floor, and the camera after it: the view ends up in a plate or
   * beneath the world and everything seems gone. The target stays on the floor, the camera above
   * it, and both within reach of the cluster.
   */
  private keepCameraAboveTheFloor() {
    const { position } = this.camera;
    const target = this.controls.target;
    let corrected = false;

    if (target.y < 0) {
      const drop = position.y - target.y;

      // Slide the target back along the view ray to where it meets the floor.
      if (drop > 1e-3 && position.y > 0) {
        target.lerpVectors(position, target, position.y / drop);
      }

      target.y = 0;
      corrected = true;
    }

    if (position.y < MIN_CAMERA_HEIGHT) {
      position.y = MIN_CAMERA_HEIGHT;
      corrected = true;
    }

    const bounds = this.layout?.bounds;

    if (bounds) {
      const margin = 20;
      const x = Math.min(Math.max(target.x, bounds.minX - margin), bounds.maxX + margin);
      const z = Math.min(Math.max(target.z, bounds.minZ - margin), bounds.maxZ + margin);

      if (x !== target.x || z !== target.z) {
        position.x += x - target.x;
        position.z += z - target.z;
        target.x = x;
        target.z = z;
        corrected = true;
      }
    }

    if (corrected) {
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
    }
  }

  /** Drops the resolution a step when frames keep arriving slowly while moving, so large clusters stay smooth. */
  private adaptQuality(frameIntervalMs: number, moving: boolean) {
    if (!moving) {
      return;
    }

    this.slowFrames = frameIntervalMs > 40 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);

    if (this.slowFrames > 24 && this.pixelRatio > 1) {
      this.slowFrames = 0;
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize(true);
    }
  }
}

