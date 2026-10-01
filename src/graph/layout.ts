import type { Health } from "./health";
import { EDGE_COLORS, FLOW_EDGES, type Glyph, lookOf, PALETTE, type Tier, TIER_ORDER } from "./presentation";
import type { EdgeType } from "./rules";
import type { GraphApp, GraphEdge, GraphNode, GraphSnapshot } from "./snapshot";
import { asNumber, field, type ObjectKey } from "./types";

/**
 * Where everything sits in 3D. A pure function of the snapshot and the display options, and
 * deterministic, so a pod that restarts does not reshuffle the scene: namespaces are districts,
 * apps are glass modules packed inside them, and inside a module the resources run left to right
 * in tiers the way a request does (gate → service → workload → pods → config → identity).
 *
 * Axes: x runs along the tiers, z across them (rows), y is up.
 */

export interface LayoutOptions {
  /** Namespaces to show; undefined shows all. */
  readonly namespaces?: ReadonlySet<string>;
  readonly showReplicaSets: boolean;
  /** Hubs: the default ServiceAccount, kube-root-ca.crt, ClusterRoles, classes... */
  readonly showShared: boolean;
  /** Objects no app claims. */
  readonly showUnattached: boolean;
  /** Nodes, classes, EndpointSlices and the rules hidden by default. */
  readonly showInfra: boolean;
  /** Old ReplicaSets, finished Jobs of a CronJob, superseded Helm release records. */
  readonly showHistory: boolean;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  showReplicaSets: false,
  showShared: false,
  showUnattached: false,
  showInfra: false,
  showHistory: false,
};

export interface Footprint {
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/** The nominal size of each glyph; the scene builds its geometry to these. */
export const GLYPH_FOOTPRINT: Readonly<Record<Glyph, Footprint>> = {
  gate: { w: 1.15, h: 0.55, d: 1.15 },
  hex: { w: 1.1, h: 0.5, d: 1.1 },
  block: { w: 1.4, h: 0.75, d: 1.4 },
  slab: { w: 1.0, h: 0.4, d: 1.0 },
  cube: { w: 0.62, h: 0.36, d: 0.62 },
  tile: { w: 0.85, h: 0.22, d: 0.85 },
  disk: { w: 0.85, h: 0.32, d: 0.85 },
  gem: { w: 0.75, h: 0.26, d: 0.75 },
  ring: { w: 0.7, h: 0.16, d: 0.7 },
  orb: { w: 0.7, h: 0.26, d: 0.7 },
  /** The internet in the traffic view: big enough to read from across the cluster. */
  landmark: { w: 3.2, h: 0.9, d: 3.2 },
};

export interface LayoutNode {
  readonly id: ObjectKey;
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly glyph: Glyph;
  /** Vertical stretch of the glyph (a workload grows with its replicas). */
  readonly heightScale: number;
  /** Missing or unknown: drawn as a wireframe. */
  readonly ghost: boolean;
  readonly color: string;
  readonly health: Health;
  readonly appId?: string;
  readonly districtId: string;
  /** Higher gets a label first. */
  readonly importance: number;
}

export interface LayoutApp {
  readonly id: string;
  readonly app: GraphApp;
  readonly districtId: string;
  /** Centre of the floor. */
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

export interface LayoutDistrict {
  readonly id: string;
  readonly namespace: string;
  /** Shown instead of the namespace, for lanes that are not one. */
  readonly title?: string;
  /** Shown instead of the app and resource counts. */
  readonly caption?: string;
  /** A long lane rather than a plate: its name goes at its start, not across its middle. */
  readonly lane?: boolean;
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly apps: number;
  readonly resources: number;
  readonly problems: number;
  readonly health: Health;
}

export interface LayoutEdge {
  readonly id: string;
  readonly from: ObjectKey;
  readonly to: ObjectKey;
  readonly type: EdgeType;
  readonly state: GraphEdge["state"];
  readonly color: string;
  readonly flow: boolean;
  /** Both ends in the same app: drawn always. Others only around what the user looks at. */
  readonly local: boolean;
  readonly source: GraphEdge;
  /** Traffic a service mesh measured on it: packets as dense as the requests. */
  readonly observed?: { readonly requestsPerSecond: number; readonly errorsPerSecond: number; readonly bytesPerSecond: number };
}

export interface Layout {
  readonly nodes: ReadonlyMap<ObjectKey, LayoutNode>;
  readonly apps: ReadonlyMap<string, LayoutApp>;
  readonly districts: ReadonlyMap<string, LayoutDistrict>;
  readonly edges: readonly LayoutEdge[];
  readonly edgesByNode: ReadonlyMap<ObjectKey, readonly LayoutEdge[]>;
  readonly bounds: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
  readonly hidden: { readonly shared: number; readonly unattached: number; readonly history: number; readonly infra: number };
}

// ---------------------------------------------------------------------------------------------

const TIER_GAP = 1.3;
const ROW_GAP = 0.7;
/** Workloads get more room between them, so each reads as its own row with its pods. */
const CONTROLLER_ROW_GAP = 1.9;
const POD_PITCH = 0.84;
const APP_PADDING = 1.0;
const APP_GAP = 1.6;
const DISTRICT_PADDING = 2.2;
const DISTRICT_GAP = 4;
const COMMONS_PITCH = 1.35;
const CLUSTER_DISTRICT = "";
const APP_GRID = 2;
const DISTRICT_GRID = 4;

const snapUp = (value: number, grid: number) => Math.ceil(value / grid - 1e-6) * grid;

const TEMPLATE_EDGES: ReadonlySet<EdgeType> = new Set<EdgeType>(["mounts", "readsEnvFrom", "pullsWith", "runsAs", "usesClass", "calls"]);

const isOwnerKind = (snapshot: GraphSnapshot, id: ObjectKey) =>
  (snapshot.into.get(id) ?? []).some((edge) => edge.type === "ownedBy");

const replicasOf = (node: GraphNode) =>
  asNumber(field(node.object, "spec", "replicas")) ?? asNumber(field(node.object, "status", "desiredNumberScheduled")) ?? 1;

const byName = (a: GraphNode, b: GraphNode) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// --- visibility and display edges -------------------------------------------------------------

interface Display {
  readonly visible: Set<ObjectKey>;
  /** A hidden ReplicaSet stands for its Deployment. */
  readonly standIn: Map<ObjectKey, ObjectKey>;
  readonly edges: LayoutEdge[];
  readonly hidden: { shared: number; unattached: number; history: number; infra: number };
}

const isHistory = (snapshot: GraphSnapshot, node: GraphNode, latestJobOfCronJob: Map<ObjectKey, ObjectKey>): boolean => {
  const { kind } = node.gk;

  if (kind === "ReplicaSet") {
    return replicasOf(node) === 0 && !(snapshot.into.get(node.id) ?? []).some((edge) => edge.type === "ownedBy");
  }

  if (kind === "Job" || kind === "Pod") {
    const owner = (snapshot.outOf.get(node.id) ?? []).find((edge) => edge.type === "ownedBy")?.to;

    if (kind === "Job") {
      const cronJob = owner && snapshot.nodes.get(owner)?.gk.kind === "CronJob" ? owner : undefined;

      return cronJob !== undefined && latestJobOfCronJob.get(cronJob) !== node.id && node.health !== "ok" && node.health !== "warn" && node.health !== "error";
    }

    const job = owner ? snapshot.nodes.get(owner) : undefined;

    return job?.gk.kind === "Job" && isHistory(snapshot, job, latestJobOfCronJob);
  }

  if (kind === "Secret") {
    const labels = node.object?.metadata.labels;

    return labels?.owner === "helm" && labels.status !== undefined && labels.status !== "deployed";
  }

  return false;
};

const display = (snapshot: GraphSnapshot, options: LayoutOptions): Display => {
  const visible = new Set<ObjectKey>();
  const standIn = new Map<ObjectKey, ObjectKey>();
  const hidden = { shared: 0, unattached: 0, history: 0, infra: 0 };
  const latestJobOfCronJob = new Map<ObjectKey, ObjectKey>();

  for (const node of snapshot.nodes.values()) {
    if (node.gk.kind !== "Job") {
      continue;
    }

    const cronJob = (snapshot.outOf.get(node.id) ?? []).find((edge) => edge.type === "ownedBy")?.to;
    const current = cronJob ? latestJobOfCronJob.get(cronJob) : undefined;
    const created = node.object?.metadata.creationTimestamp ?? "";

    if (cronJob && (!current || (snapshot.nodes.get(current)?.object?.metadata.creationTimestamp ?? "") < created)) {
      latestJobOfCronJob.set(cronJob, node.id);
    }
  }

  const namespaceOf = (node: GraphNode) => (node.appId ? snapshot.apps.get(node.appId)!.namespace : node.namespace);

  for (const node of snapshot.nodes.values()) {
    const namespace = namespaceOf(node);

    if (options.namespaces && namespace !== CLUSTER_DISTRICT && !options.namespaces.has(namespace)) {
      continue;
    }

    if (lookOf(node.gk).infra && !options.showInfra) {
      hidden.infra++;
      continue;
    }

    if (node.role === "hub" && !options.showShared) {
      hidden.shared++;
      continue;
    }

    if (node.role === "unattached" && !options.showUnattached) {
      hidden.unattached++;
      continue;
    }

    if (!options.showHistory && isHistory(snapshot, node, latestJobOfCronJob)) {
      hidden.history++;
      continue;
    }

    if (!options.showReplicaSets && node.gk.kind === "ReplicaSet") {
      const owner = (snapshot.outOf.get(node.id) ?? []).find((edge) => edge.type === "ownedBy" && edge.state === "resolved")?.to;

      if (owner && snapshot.nodes.get(owner)?.gk.kind === "Deployment") {
        standIn.set(node.id, owner);
        continue;
      }
    }

    visible.add(node.id);
  }

  // Hubs are context: worth drawing only where something visible points at them.
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();
  const referenced = new Set<ObjectKey>();

  for (const edge of snapshot.edges) {
    if (edge.hiddenByDefault && !options.showInfra) {
      continue;
    }

    // A hidden ReplicaSet's own references duplicate its Deployment's template.
    if (standIn.has(edge.from)) {
      continue;
    }

    const from = edge.from;
    const to = standIn.get(edge.to) ?? edge.to;

    if (from === to || !visible.has(from) || !visible.has(to)) {
      continue;
    }

    const id = to === edge.to ? edge.id : `${edge.type}|${from}|${to}`;

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    referenced.add(to);
    referenced.add(from);

    const fromNode = snapshot.nodes.get(from)!;
    const toNode = snapshot.nodes.get(to)!;

    edges.push({
      id,
      from,
      to,
      type: edge.type,
      state: edge.state,
      color: edge.state === "missing" ? PALETTE.red : edge.state === "unknown" ? PALETTE.slate : edgeColor(edge),
      flow: FLOW_EDGES.has(edge.type) && edge.state === "resolved",
      local: fromNode.appId !== undefined && fromNode.appId === toNode.appId,
      source: edge,
    });
  }

  for (const id of [...visible]) {
    const node = snapshot.nodes.get(id)!;

    if (node.role === "hub" && !referenced.has(id)) {
      visible.delete(id);
    }
  }

  // A pod repeats every reference of its template. Where the workload already shows one, the
  // pod's copy is noise: keep it in the details, leave it out of the picture.
  const ownerOf = new Map<ObjectKey, ObjectKey>();
  const shown = new Set<string>();

  for (const edge of edges) {
    shown.add(`${edge.from}|${edge.type}|${edge.to}`);

    if (edge.type === "ownedBy") {
      ownerOf.set(edge.from, edge.to);
    }
  }

  const repeatsTemplate = (edge: LayoutEdge) => {
    const owner = TEMPLATE_EDGES.has(edge.type) ? ownerOf.get(edge.from) : undefined;

    return owner !== undefined && shown.has(`${owner}|${edge.type}|${edge.to}`);
  };

  return {
    visible,
    standIn,
    edges: edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to) && !repeatsTemplate(edge)),
    hidden,
  };
};

const edgeColor = (edge: GraphEdge) => {
  if (edge.type === "mounts" || edge.type === "readsEnvFrom") {
    if (edge.toGroupKind.kind === "Secret") {
      return PALETTE.gold;
    }

    if (edge.toGroupKind.kind === "PersistentVolumeClaim") {
      return PALETTE.violet;
    }
  }

  return EDGE_COLORS[edge.type];
};

// --- one app ------------------------------------------------------------------------------------

interface Placed {
  x: number;
  y: number;
  z: number;
  glyph: Glyph;
  heightScale: number;
}

interface ColumnItem {
  readonly id: string;
  readonly desired: number;
  readonly depth: number;
  readonly name: string;
}

/** Stacks items along z near where their neighbours are, never overlapping. */
const placeColumn = (items: ColumnItem[], gap = ROW_GAP): Map<string, number> => {
  const sorted = [...items].sort((a, b) => a.desired - b.desired || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const result = new Map<string, number>();
  let previous: { z: number; depth: number } | undefined;

  for (const item of sorted) {
    const minimum = previous ? previous.z + (previous.depth + item.depth) / 2 + gap : -Infinity;
    const z = Math.max(Number.isFinite(item.desired) ? item.desired : minimum, minimum);
    const placed = Number.isFinite(z) ? z : 0;

    result.set(item.id, placed);
    previous = { z: placed, depth: item.depth };
  }

  return result;
};

interface AppLayout {
  readonly positions: Map<ObjectKey, Placed>;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

const layoutGroup = (snapshot: GraphSnapshot, memberIds: readonly ObjectKey[], edgesByNode: ReadonlyMap<ObjectKey, readonly LayoutEdge[]>): AppLayout => {
  const members = memberIds.map((id) => snapshot.nodes.get(id)!);
  const memberSet = new Set(memberIds);
  const tiers = new Map<Tier, GraphNode[]>();
  const satellites: GraphNode[] = [];

  for (const node of members) {
    const { tier } = lookOf(node.gk, isOwnerKind(snapshot, node.id));

    if (tier === "satellite") {
      satellites.push(node);
    } else {
      tiers.set(tier, [...(tiers.get(tier) ?? []), node]);
    }
  }

  const z = new Map<ObjectKey, number>();
  const glyphs = new Map<ObjectKey, { glyph: Glyph; heightScale: number }>();
  const tierWidths = new Map<Tier, number>();
  const podCells = new Map<ObjectKey, { column: number }>();

  const neighboursOf = (id: ObjectKey) =>
    (edgesByNode.get(id) ?? []).map((edge) => (edge.from === id ? edge.to : edge.from)).filter((other) => memberSet.has(other));

  const desiredOf = (id: ObjectKey) => {
    const placed = neighboursOf(id)
      .map((other) => z.get(other))
      .filter((value): value is number => value !== undefined);

    return placed.length > 0 ? placed.reduce((sum, value) => sum + value, 0) / placed.length : Infinity;
  };

  const ownerOf = (id: ObjectKey) =>
    (edgesByNode.get(id) ?? []).find((edge) => edge.type === "ownedBy" && edge.from === id && memberSet.has(edge.to))?.to;

  // Workloads first: everything else lines up against them.
  const order: Tier[] = ["controller", "replica", "pod", "service", "entry", "config", "identity"];

  for (const tier of order) {
    const nodes = (tiers.get(tier) ?? []).sort(byName);

    if (nodes.length === 0) {
      continue;
    }

    if (tier === "pod") {
      // Pods gather in a small grid per owner, level with it.
      const groups = new Map<string, GraphNode[]>();

      for (const pod of nodes) {
        const owner = ownerOf(pod.id) ?? "";

        groups.set(owner, [...(groups.get(owner) ?? []), pod]);
      }

      let maxColumns = 1;
      const items: ColumnItem[] = [];
      const shapes = new Map<string, { columns: number; rows: number }>();

      for (const [owner, pods] of groups) {
        const columns = Math.min(Math.max(1, Math.ceil(Math.sqrt(pods.length))), 6);
        const rows = Math.ceil(pods.length / columns);

        maxColumns = Math.max(maxColumns, columns);
        shapes.set(owner, { columns, rows });
        items.push({ id: `group:${owner}`, desired: owner ? (z.get(owner) ?? Infinity) : Infinity, depth: rows * POD_PITCH, name: owner });
      }

      const groupZ = placeColumn(items, CONTROLLER_ROW_GAP);

      for (const [owner, pods] of groups) {
        const { columns, rows } = shapes.get(owner)!;
        const centre = groupZ.get(`group:${owner}`)!;

        pods.forEach((pod, index) => {
          const row = Math.floor(index / columns);
          const column = index % columns;

          z.set(pod.id, centre + (row - (rows - 1) / 2) * POD_PITCH);
          podCells.set(pod.id, { column: column - (columns - 1) / 2 });
          glyphs.set(pod.id, { glyph: "cube", heightScale: 1 });
        });
      }

      tierWidths.set(tier, maxColumns * POD_PITCH);
      continue;
    }

    const items = nodes.map((node) => {
      const { glyph } = lookOf(node.gk, isOwnerKind(snapshot, node.id));
      const heightScale = glyph === "block" ? 1 + Math.min(Math.log2(Math.max(replicasOf(node), 1)), 4) * 0.28 : 1;

      glyphs.set(node.id, { glyph, heightScale });

      return {
        id: node.id,
        desired: tier === "controller" ? Infinity : tier === "replica" ? (z.get(ownerOf(node.id) ?? "") ?? Infinity) : desiredOf(node.id),
        depth: GLYPH_FOOTPRINT[glyph].d,
        name: node.name,
      };
    });

    for (const [id, value] of placeColumn(items, tier === "controller" ? CONTROLLER_ROW_GAP : ROW_GAP)) {
      z.set(id, value);
    }

    tierWidths.set(tier, Math.max(...items.map((item) => GLYPH_FOOTPRINT[glyphs.get(item.id)!.glyph].w)));
  }

  // x: the tiers in reading order, skipping empty ones.
  const tierX = new Map<Tier, number>();
  let cursor = 0;

  for (const tier of TIER_ORDER) {
    const width = tierWidths.get(tier);

    if (width === undefined) {
      continue;
    }

    tierX.set(tier, cursor + width / 2);
    cursor += width + TIER_GAP;
  }

  const positions = new Map<ObjectKey, Placed>();

  for (const [tier, nodes] of tiers) {
    for (const node of nodes) {
      const { glyph, heightScale } = glyphs.get(node.id)!;
      const x = tierX.get(tier)! + (podCells.get(node.id)?.column ?? 0) * POD_PITCH;

      positions.set(node.id, { x, y: (GLYPH_FOOTPRINT[glyph].h * heightScale) / 2, z: z.get(node.id)!, glyph, heightScale });
    }
  }

  // Satellites (autoscalers, budgets, policies) float as halos over what they act on.
  const stacks = new Map<ObjectKey, number>();

  for (const node of satellites.sort(byName)) {
    const target = (edgesByNode.get(node.id) ?? []).find((edge) => edge.from === node.id && positions.has(edge.to))?.to;
    const anchor = target ? positions.get(target)! : undefined;
    const level = target ? (stacks.get(target) ?? 0) : 0;

    if (target) {
      stacks.set(target, level + 1);
    }

    if (anchor) {
      const top = GLYPH_FOOTPRINT[anchor.glyph].h * anchor.heightScale;

      positions.set(node.id, { x: anchor.x, y: top + 0.45 + level * 0.3, z: anchor.z, glyph: "ring", heightScale: 1 });
    } else {
      const lastZ = Math.max(0, ...[...positions.values()].map((position) => position.z));

      positions.set(node.id, { x: tierX.get("controller") ?? 0, y: 0.6, z: lastZ + 1.6, glyph: "ring", heightScale: 1 });
    }
  }

  // Normalise to the module's floor: x and z from 0.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let top = 0;

  for (const position of positions.values()) {
    const footprint = GLYPH_FOOTPRINT[position.glyph];

    minX = Math.min(minX, position.x - footprint.w / 2);
    maxX = Math.max(maxX, position.x + footprint.w / 2);
    minZ = Math.min(minZ, position.z - footprint.d / 2);
    maxZ = Math.max(maxZ, position.z + footprint.d / 2);
    top = Math.max(top, position.y + (footprint.h * position.heightScale) / 2);
  }

  if (!Number.isFinite(minX)) {
    return { positions, width: 2 * APP_PADDING, depth: 2 * APP_PADDING, height: 2 };
  }

  for (const position of positions.values()) {
    position.x += APP_PADDING - minX;
    position.z += APP_PADDING - minZ;
  }

  // Sizes snap to a grid, so a pod more or less rarely changes how anything around it packs.
  return {
    positions,
    width: snapUp(maxX - minX + 2 * APP_PADDING, APP_GRID),
    depth: snapUp(maxZ - minZ + 2 * APP_PADDING, APP_GRID),
    height: Math.max(2.2, top + 0.9),
  };
};

// --- packing ------------------------------------------------------------------------------------

interface Box {
  readonly id: string;
  readonly width: number;
  readonly depth: number;
}

/** Rows of boxes, in the order given, wrapping at roughly a square. Returns top-left corners. */
const shelfPack = (boxes: readonly Box[], gap: number, aspect = 2.6, rowGrid = 12) => {
  const area = boxes.reduce((sum, box) => sum + (box.width + gap) * (box.depth + gap), 0);
  const widest = Math.max(0, ...boxes.map((box) => box.width));
  const rowWidth = Math.max(widest, snapUp(Math.sqrt(area * aspect), rowGrid));
  const corners = new Map<string, { x: number; z: number }>();
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  let width = 0;

  for (const box of boxes) {
    if (x > 0 && x + box.width > rowWidth) {
      x = 0;
      z += rowDepth + gap;
      rowDepth = 0;
    }

    corners.set(box.id, { x, z });
    x += box.width + gap;
    rowDepth = Math.max(rowDepth, box.depth);
    width = Math.max(width, x - gap);
  }

  return { corners, width, depth: z + rowDepth };
};

const namespaceOrder = (a: string, b: string) => {
  const system = (namespace: string) => (namespace === CLUSTER_DISTRICT ? 2 : namespace.startsWith("kube-") ? 1 : 0);

  return system(a) - system(b) || (a < b ? -1 : a > b ? 1 : 0);
};

// --- the whole cluster --------------------------------------------------------------------------

export const layoutGraph = (snapshot: GraphSnapshot, options: LayoutOptions): Layout => {
  const { visible, edges, hidden } = display(snapshot, options);
  const edgesByNode = new Map<ObjectKey, LayoutEdge[]>();

  for (const edge of edges) {
    edgesByNode.set(edge.from, [...(edgesByNode.get(edge.from) ?? []), edge]);
    edgesByNode.set(edge.to, [...(edgesByNode.get(edge.to) ?? []), edge]);
  }

  // Group what is visible into districts: apps, and the commons of each namespace.
  const appsByDistrict = new Map<string, GraphApp[]>();
  const commonsByDistrict = new Map<string, GraphNode[]>();
  const visibleMembers = new Map<string, ObjectKey[]>();

  for (const id of visible) {
    const node = snapshot.nodes.get(id)!;

    if (node.appId) {
      visibleMembers.set(node.appId, [...(visibleMembers.get(node.appId) ?? []), id]);
    } else {
      const district = node.namespace;

      commonsByDistrict.set(district, [...(commonsByDistrict.get(district) ?? []), node]);
    }
  }

  for (const appId of visibleMembers.keys()) {
    const app = snapshot.apps.get(appId)!;

    appsByDistrict.set(app.namespace, [...(appsByDistrict.get(app.namespace) ?? []), app]);
  }

  const districtIds = [...new Set([...appsByDistrict.keys(), ...commonsByDistrict.keys()])].sort(namespaceOrder);
  const localApps = new Map<string, AppLayout>();

  for (const appId of visibleMembers.keys()) {
    localApps.set(appId, layoutGroup(snapshot, visibleMembers.get(appId)!.sort(), edgesByNode));
  }

  interface LocalDistrict {
    readonly width: number;
    readonly depth: number;
    readonly appCorners: Map<string, { x: number; z: number }>;
    readonly commons: Map<ObjectKey, Placed>;
  }

  const localDistricts = new Map<string, LocalDistrict>();

  for (const districtId of districtIds) {
    const commons = (commonsByDistrict.get(districtId) ?? []).sort(
      (a, b) =>
        TIER_ORDER.indexOf(lookOf(a.gk).tier) - TIER_ORDER.indexOf(lookOf(b.gk).tier) ||
        (a.gk.kind < b.gk.kind ? -1 : a.gk.kind > b.gk.kind ? 1 : 0) ||
        byName(a, b),
    );
    const apps = (appsByDistrict.get(districtId) ?? []).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const packed = shelfPack(
      apps.map((app) => ({ id: app.id, width: localApps.get(app.id)!.width, depth: localApps.get(app.id)!.depth })),
      APP_GAP,
    );
    const commonsColumns = commons.length === 0 ? 0 : Math.max(1, Math.min(commons.length, Math.floor(Math.max(packed.width, 6) / COMMONS_PITCH)));
    const commonsRows = commonsColumns === 0 ? 0 : Math.ceil(commons.length / commonsColumns);
    const commonsDepth = commonsRows * COMMONS_PITCH;
    const commonsPlaced = new Map<ObjectKey, Placed>();

    // The commons are a row of loose resources along the back of the district.
    commons.forEach((node, index) => {
      const { glyph } = lookOf(node.gk, isOwnerKind(snapshot, node.id));
      const x = (index % commonsColumns) * COMMONS_PITCH + COMMONS_PITCH / 2;
      const z = Math.floor(index / commonsColumns) * COMMONS_PITCH + COMMONS_PITCH / 2;

      commonsPlaced.set(node.id, { x, y: GLYPH_FOOTPRINT[glyph].h / 2, z, glyph, heightScale: 1 });
    });

    const appOffsetZ = commonsDepth > 0 ? commonsDepth + APP_GAP : 0;
    const appCorners = new Map<string, { x: number; z: number }>();

    for (const [id, corner] of packed.corners) {
      appCorners.set(id, { x: corner.x, z: corner.z + appOffsetZ });
    }

    localDistricts.set(districtId, {
      width: snapUp(Math.max(packed.width, commonsColumns * COMMONS_PITCH, 6) + 2 * DISTRICT_PADDING, DISTRICT_GRID),
      depth: snapUp(appOffsetZ + packed.depth + 2 * DISTRICT_PADDING, DISTRICT_GRID),
      appCorners,
      commons: commonsPlaced,
    });
  }

  const world = shelfPack(
    districtIds.map((id) => ({ id, width: localDistricts.get(id)!.width, depth: localDistricts.get(id)!.depth })),
    DISTRICT_GAP,
    1.8,
  );
  // Anchored at the origin rather than centred: growth at one end must not shift the rest.
  const offsetX = 0;
  const offsetZ = 0;

  // --- to world coordinates ------------------------------------------------------------------
  const nodes = new Map<ObjectKey, LayoutNode>();
  const apps = new Map<string, LayoutApp>();
  const districts = new Map<string, LayoutDistrict>();

  const importanceOf = (node: GraphNode, glyph: Glyph) => {
    const base: Partial<Record<Glyph, number>> = { block: 6, gate: 5, hex: 5, slab: 3, disk: 3, tile: 2, gem: 2, ring: 2, orb: 1, cube: 1 };
    const trouble = node.health === "error" ? 4 : node.health === "warn" ? 2 : 0;

    return (base[glyph] ?? 1) + trouble;
  };

  const addNode = (node: GraphNode, placed: Placed, originX: number, originZ: number, districtId: string) => {
    nodes.set(node.id, {
      id: node.id,
      node,
      x: originX + placed.x,
      y: placed.y,
      z: originZ + placed.z,
      glyph: placed.glyph,
      heightScale: placed.heightScale,
      ghost: node.state !== "present",
      color: node.gk.kind === "Pod" ? "" : lookOf(node.gk, isOwnerKind(snapshot, node.id)).color,
      health: node.health,
      appId: node.appId,
      districtId,
      importance: importanceOf(node, placed.glyph),
    });
  };

  for (const districtId of districtIds) {
    const local = localDistricts.get(districtId)!;
    const corner = world.corners.get(districtId)!;
    const originX = offsetX + corner.x;
    const originZ = offsetZ + corner.z;
    let resources = 0;
    let problems = 0;
    const healths: Health[] = [];

    for (const [id, placed] of local.commons) {
      const node = snapshot.nodes.get(id)!;

      addNode(node, placed, originX + DISTRICT_PADDING, originZ + DISTRICT_PADDING, districtId);
      resources++;
    }

    for (const [appId, appCorner] of local.appCorners) {
      const app = snapshot.apps.get(appId)!;
      const appLayout = localApps.get(appId)!;
      const appX = originX + DISTRICT_PADDING + appCorner.x;
      const appZ = originZ + DISTRICT_PADDING + appCorner.z;

      for (const [id, placed] of appLayout.positions) {
        addNode(snapshot.nodes.get(id)!, placed, appX, appZ, districtId);
        resources++;
      }

      apps.set(appId, {
        id: appId,
        app,
        districtId,
        x: appX + appLayout.width / 2,
        z: appZ + appLayout.depth / 2,
        width: appLayout.width,
        depth: appLayout.depth,
        height: appLayout.height,
      });
      problems += app.problems;
      healths.push(app.health);
    }

    districts.set(districtId, {
      id: districtId,
      namespace: districtId,
      x: originX + local.width / 2,
      z: originZ + local.depth / 2,
      width: local.width,
      depth: local.depth,
      apps: local.appCorners.size,
      resources,
      problems,
      health: healths.includes("error") ? "error" : healths.includes("warn") ? "warn" : healths.length > 0 ? "ok" : "neutral",
    });
  }

  return {
    nodes,
    apps,
    districts,
    edges,
    edgesByNode,
    bounds: { minX: offsetX, maxX: offsetX + world.width, minZ: offsetZ, maxZ: offsetZ + world.depth },
    hidden,
  };
};
