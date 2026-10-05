import type { Health } from "./health";
import { GLYPH_FOOTPRINT, type Layout, type LayoutDistrict, type LayoutEdge, type LayoutNode } from "./layout";
import { describeFlow, MESH_TITLES, type ObservedFlow } from "./mesh";
import { BODY, lookOf, PALETTE } from "./presentation";
import { type EdgeType, K, ROOT_OWNER_KINDS } from "./rules";
import type { GraphEdge, GraphNode, GraphSnapshot } from "./snapshot";
import { asArray, asString, field, isRecord, objectKey, type ObjectKey, sameGroupKind } from "./types";

/**
 * The traffic view: every way a request moves through the cluster, and nothing else. From the
 * internet through ingresses, gateways and routes to services, from services to the workloads
 * behind them, and from workloads to the services they call (inferred from the Service DNS names
 * in their env, args and config). One lane per namespace; columns run in the order a request
 * travels, so the picture reads left to right.
 */

export const INTERNET_ID: ObjectKey = "app-graph.lens/Internet//internet";

const INTERNET: GraphNode = {
  id: INTERNET_ID,
  gk: { group: "app-graph.lens", kind: "Internet" },
  namespace: "",
  name: "Internet",
  state: "present",
  health: "neutral",
  summary: "Outside the cluster",
  role: "unattached",
  claimedBy: [],
};

export interface TrafficOptions {
  readonly namespaces?: ReadonlySet<string>;
  /** What a service mesh saw, when the cluster runs one: drawn as observed traffic. */
  readonly observed?: readonly ObservedFlow[];
}

/** Traffic a mesh measured on a connection. */
export interface ObservedTraffic {
  readonly requestsPerSecond: number;
  readonly errorsPerSecond: number;
  readonly bytesPerSecond: number;
}

/** Green while calls succeed, amber from 1% failing, red from 5%. */
export const observedColor = (traffic: ObservedTraffic) => {
  const ratio = traffic.requestsPerSecond > 0 ? traffic.errorsPerSecond / traffic.requestsPerSecond : 0;

  return ratio >= 0.05 ? PALETTE.red : ratio >= 0.01 ? PALETTE.gold : PALETTE.green;
};

const COLUMN = 5.2;
const ROW = 2.1;
const LANE_PADDING = 1.6;
const LANE_GAP = 1.2;
/** The internet stands beside the lanes, not in one: this far left of the first column. */
const INTERNET_OFFSET = 11;
/**
 * A lane of more rows than this wraps into strips side by side, about twice as wide as deep, so
 * a namespace of sixty routes reads as a block rather than a column running off the screen.
 */
const WRAP_ROWS = 12;
const WRAP_ASPECT = 2;
const STRIP_GAP = 3.2;

const GATEWAYS = new Set(["Ingress", "Gateway"]);
const ROUTES = new Set(["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute", "VirtualService"]);
const WORKLOADS = new Set(ROOT_OWNER_KINDS.map((kind) => kind.kind));

/** Where a node goes when nothing upstream of it says: the column of its kind. Ways out come last. */
const naturalDepth = (node: GraphNode) =>
  node.id === INTERNET_ID
    ? 0
    : GATEWAYS.has(node.gk.kind)
      ? 1
      : ROUTES.has(node.gk.kind)
        ? 2
        : node.gk.kind === "Service"
          ? 3
          : node.gk.kind === "ServiceEntry"
            ? 5
            : 4;

/** Does a ServiceEntry host (exact, or "*.example.com") cover this host? */
const hostCovers = (pattern: string, host: string) =>
  pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1))) || pattern === "*";

interface TrafficEdge {
  readonly from: ObjectKey;
  readonly to: ObjectKey;
  readonly type: EdgeType;
  readonly color: string;
  /** Why the traffic goes there, for the side panel. */
  readonly reason: string;
  /** Measured by a mesh, rather than read from config. */
  readonly observed?: ObservedTraffic;
}

export const buildTraffic = (snapshot: GraphSnapshot, observed: readonly ObservedFlow[] = []) => {
  const { nodes, outOf, into } = snapshot;
  const edges = new Map<string, TrafficEdge>();

  const add = (from: ObjectKey, to: ObjectKey, type: EdgeType, color: string, reason: string) => {
    if (from !== to && !edges.has(`${from}>${to}`)) {
      edges.set(`${from}>${to}`, { from, to, type, color, reason });
    }
  };

  const ownerCache = new Map<ObjectKey, ObjectKey | undefined>();

  /** The workload something belongs to: up the owners to a Deployment, StatefulSet, ... */
  const workloadOf = (id: ObjectKey): ObjectKey | undefined => {
    if (ownerCache.has(id)) {
      return ownerCache.get(id);
    }

    let current = id;

    for (let hops = 0; hops < 8; hops++) {
      const owner = (outOf.get(current) ?? []).find((edge) => edge.type === "ownedBy" && edge.state === "resolved")?.to;

      if (!owner) {
        break;
      }

      current = owner;
    }

    const node = nodes.get(current);
    const workload = node && WORKLOADS.has(node.gk.kind) ? current : undefined;

    ownerCache.set(id, workload);

    return workload;
  };

  for (const node of nodes.values()) {
    if (node.state !== "present") {
      continue;
    }

    if (GATEWAYS.has(node.gk.kind)) {
      const what = node.gk.kind === "Ingress" ? "Ingress" : node.gk.group === "networking.istio.io" ? "Istio ingress gateway" : "Gateway listener";

      add(INTERNET_ID, node.id, "routesTo", PALETTE.cyan, what);
    }

    if (node.gk.kind === "Service" && node.gk.group === "") {
      const type = asString(field(node.object, "spec", "type"));

      if (type === "LoadBalancer" || type === "NodePort") {
        add(INTERNET_ID, node.id, "routesTo", PALETTE.cyan, `Service of type ${type}`);
      }
    }

    if (ROUTES.has(node.gk.kind)) {
      const parents = (outOf.get(node.id) ?? []).filter((edge) => edge.type === "attachesTo" && edge.state === "resolved");

      // A VirtualService without a gateway shapes traffic between sidecars: a rule, not a hop.
      if (parents.length === 0 && node.gk.kind !== "VirtualService") {
        add(INTERNET_ID, node.id, "routesTo", PALETTE.cyan, "Route without a gateway in view");
      }

      for (const parent of parents) {
        add(parent.to, node.id, "attachesTo", PALETTE.cyan, `parentRef ${parent.path}`);
      }
    }
  }

  const meshOnly = (id: ObjectKey) =>
    nodes.get(id)?.gk.kind === "VirtualService" && !(outOf.get(id) ?? []).some((edge) => edge.type === "attachesTo" && edge.state === "resolved");

  const consumersOf = (configMap: ObjectKey) =>
    (into.get(configMap) ?? []).filter((edge) => edge.type === "mounts" || edge.type === "readsEnvFrom").map((edge) => edge.from);

  for (const edge of snapshot.edges) {
    if (edge.state !== "resolved") {
      continue;
    }

    if (edge.type === "routesTo") {
      if (!meshOnly(edge.from)) {
        add(edge.from, edge.to, "routesTo", PALETTE.cyan, edge.path);
      }
    } else if (edge.ruleId === "service.selector") {
      const workload = workloadOf(edge.to) ?? edge.to;

      add(edge.from, workload, "selects", PALETTE.teal, "selects its pods");
    } else if (edge.type === "calls") {
      const holders = nodes.get(edge.from)?.gk.kind === "ConfigMap" ? consumersOf(edge.from) : [edge.from];

      for (const holder of holders) {
        const workload = workloadOf(holder) ?? holder;

        // A workload naming its own Service (its own URL in its env) is not traffic between two things.
        if (!edges.has(`${edge.to}>${workload}`)) {
          add(workload, edge.to, "calls", PALETTE.violet, `${nodes.get(edge.from)?.gk.kind} ${nodes.get(edge.from)?.name} · ${edge.path}`);
        }
      }
    }
  }

  if (observed.length > 0) {
    addObserved(snapshot, edges, observed);
  }

  return [...edges.values()].filter((edge) => edge.from === INTERNET_ID || nodes.has(edge.from)).filter((edge) => nodes.has(edge.to));
};

const WORKLOAD_PREFERENCE = ["Deployment", "StatefulSet", "DaemonSet", "Rollout", "CronJob", "Job", "ReplicaSet", "ReplicationController"];

const labelsMatch = (selector: unknown, labels: unknown) =>
  isRecord(selector) &&
  Object.keys(selector).length > 0 &&
  isRecord(labels) &&
  Object.entries(selector).every(([key, value]) => labels[key] === value);

/**
 * Lays what a mesh measured over what config says. A call config already implied takes the
 * measurement; one it did not is added. Traffic leaving an ingress gateway's own workload is
 * the traffic of the routes into that Service, so it is laid on those instead.
 */
const addObserved = (snapshot: GraphSnapshot, edges: Map<string, TrafficEdge>, observed: readonly ObservedFlow[]) => {
  const { nodes } = snapshot;
  const workloads = new Map<string, ObjectKey>();

  for (const node of nodes.values()) {
    if (node.state !== "present" || !WORKLOADS.has(node.gk.kind)) {
      continue;
    }

    const key = `${node.namespace}/${node.name}`;
    const existing = workloads.get(key);
    const rank = (id: ObjectKey) => WORKLOAD_PREFERENCE.indexOf(nodes.get(id)!.gk.kind) >>> 0;

    if (!existing || rank(node.id) < rank(existing)) {
      workloads.set(key, node.id);
    }
  }

  // The gateways each workload is the proxy of: an Istio Gateway by its selector (in any
  // namespace, as Istio looks), a Gateway API Gateway by the label its controller puts on it.
  const gatewaysOf = new Map<ObjectKey, ObjectKey[]>();
  const gateways = [...nodes.values()].filter((node) => node.state === "present" && node.gk.kind === "Gateway");

  for (const id of new Set(workloads.values())) {
    const workload = nodes.get(id)!;
    const labels = field(workload.object, "spec", "template", "metadata", "labels");
    const served = gateways.filter((gateway) =>
      gateway.gk.group === K.IstioGateway.group
        ? labelsMatch(field(gateway.object, "spec", "selector"), labels)
        : gateway.namespace === workload.namespace && isRecord(labels) && labels["gateway.networking.k8s.io/gateway-name"] === gateway.name,
    );

    if (served.length > 0) {
      gatewaysOf.set(id, served.map((gateway) => gateway.id));
    }
  }

  const measured = new Map<string, ObservedTraffic & { meshes: Set<string> }>();
  const measure = (key: string, flow: ObservedFlow) => {
    const total = measured.get(key) ?? { requestsPerSecond: 0, errorsPerSecond: 0, bytesPerSecond: 0, meshes: new Set<string>() };

    measured.set(key, {
      requestsPerSecond: total.requestsPerSecond + flow.requestsPerSecond,
      errorsPerSecond: total.errorsPerSecond + flow.errorsPerSecond,
      bytesPerSecond: total.bytesPerSecond + flow.bytesPerSecond,
      meshes: total.meshes.add(MESH_TITLES[flow.mesh]),
    });
  };

  // Hosts outside the cluster are measured by the ServiceEntry that declares them.
  const serviceEntries = [...nodes.values()].filter((node) => node.state === "present" && sameGroupKind(node.gk, K.ServiceEntry));
  const serviceEntryFor = (host: string, namespace: string) => {
    const covering = serviceEntries.filter((entry) => asArray(field(entry.object, "spec", "hosts")).some((pattern) => typeof pattern === "string" && hostCovers(pattern, host)));

    return (covering.find((entry) => entry.namespace === namespace) ?? covering[0])?.id;
  };

  for (const flow of observed) {
    const from = workloads.get(`${flow.from.namespace}/${flow.from.workload}`);
    const service = objectKey(K.Service, flow.to.namespace, flow.to.service);
    const to = nodes.has(service) ? service : flow.to.service.includes(".") ? serviceEntryFor(flow.to.service, flow.to.namespace) : undefined;

    if (!from || !to) {
      continue;
    }

    const proxied = gatewaysOf.get(from);

    if (proxied) {
      // Into the Service through the routes that lead there, or from the gateway itself.
      const routes = [...edges.values()].filter((edge) => edge.to === to && edge.from !== INTERNET_ID && (ROUTES.has(nodes.get(edge.from)?.gk.kind ?? "") || GATEWAYS.has(nodes.get(edge.from)?.gk.kind ?? "")));

      for (const key of routes.length > 0 ? routes.map((edge) => `${edge.from}>${edge.to}`) : proxied.map((gateway) => `${gateway}>${to}`)) {
        measure(key, flow);
      }
    } else if (!edges.has(`${to}>${from}`)) {
      measure(`${from}>${to}`, flow);
    }
  }

  for (const [key, { meshes, ...traffic }] of measured) {
    const [from, to] = key.split(">") as [ObjectKey, ObjectKey];
    const existing = edges.get(key);
    const seen = `${[...meshes].join(" and ")} saw ${describeFlow(traffic)}`;

    edges.set(key, {
      from,
      to,
      type: existing?.type ?? (nodes.get(from)?.gk.kind === "Gateway" ? "routesTo" : "calls"),
      color: observedColor(traffic),
      reason: existing && existing.type !== "calls" ? `${existing.reason} · ${seen}` : seen,
      observed: traffic,
    });
  }
};

export const layoutTraffic = (snapshot: GraphSnapshot, options: TrafficOptions): Layout => {
  const nodeOf = (id: ObjectKey) => (id === INTERNET_ID ? INTERNET : snapshot.nodes.get(id)!);
  const inNamespaces = (id: ObjectKey) => id === INTERNET_ID || !options.namespaces || options.namespaces.has(nodeOf(id).namespace);
  const all = buildTraffic(snapshot, options.observed);
  // The way in stays when the namespaces it leads to are chosen: a shared ingress gateway in
  // istio-system is where the traffic of every app namespace enters.
  const entries = new Set(all.filter((edge) => GATEWAYS.has(nodeOf(edge.from).gk.kind) && inNamespaces(edge.to)).map((edge) => edge.from));
  const inView = (id: ObjectKey) => inNamespaces(id) || entries.has(id);
  const traffic = all.filter((edge) => inView(edge.from) && inView(edge.to));

  const ids = new Set<ObjectKey>();
  const out = new Map<ObjectKey, ObjectKey[]>();
  const incoming = new Map<ObjectKey, number>();

  for (const edge of traffic) {
    ids.add(edge.from);
    ids.add(edge.to);
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  // Columns: breadth first from the sources, each source starting at the column of its kind.
  const depth = new Map<ObjectKey, number>();
  const spread = (sources: ObjectKey[]) => {
    const queue = sources.filter((id) => !depth.has(id));

    queue.forEach((id) => depth.set(id, naturalDepth(nodeOf(id))));
    queue.sort((a, b) => depth.get(a)! - depth.get(b)!);

    while (queue.length > 0) {
      const id = queue.shift()!;

      for (const next of out.get(id) ?? []) {
        if (!depth.has(next)) {
          // Never left of its kind's column: services line up, and so do the workloads behind them.
          depth.set(next, Math.max(depth.get(id)! + 1, naturalDepth(nodeOf(next))));
          queue.push(next);
        }
      }
    }
  };

  spread([...ids].filter((id) => id === INTERNET_ID || !incoming.has(id)));
  spread([...ids].filter((id) => !depth.has(id)).sort());

  // Lanes: a namespace each, system namespaces last. The internet is in none of them.
  const laneOf = (id: ObjectKey) => nodeOf(id).namespace;
  const laneOrder = (a: string, b: string) => {
    const rank = (lane: string) => (lane === "" ? 3 : lane.startsWith("kube-") ? 2 : 1);

    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  };
  const inLanes = [...ids].filter((id) => id !== INTERNET_ID);
  const lanes = [...new Set(inLanes.map(laneOf))].sort(laneOrder);
  const maxDepth = Math.max(1, ...depth.values());

  // Rows within each lane and column, ordered by where their upstream sits.
  const row = new Map<ObjectKey, number>();
  const predecessors = new Map<ObjectKey, ObjectKey[]>();

  for (const edge of traffic) {
    predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]);
  }

  const laneRows = new Map<string, number>();

  for (let column = 1; column <= maxDepth; column++) {
    for (const lane of lanes) {
      const cell = inLanes.filter((id) => depth.get(id) === column && laneOf(id) === lane);
      const weight = (id: ObjectKey) => {
        const rows = (predecessors.get(id) ?? []).filter((other) => laneOf(other) === lane && row.has(other)).map((other) => row.get(other)!);

        return rows.length > 0 ? rows.reduce((sum, value) => sum + value, 0) / rows.length : Infinity;
      };

      // Each on the row of what sends it traffic where that row is free, so a chain of hops
      // (route, Service, workload) runs straight across.
      let next = 0;

      cell
        .map((id) => ({ id, weight: weight(id), name: nodeOf(id).name }))
        .sort((a, b) => a.weight - b.weight || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .forEach(({ id, weight: wanted }) => {
          const at = Math.max(next, Number.isFinite(wanted) ? Math.round(wanted) : next);

          row.set(id, at);
          next = at + 1;
        });

      laneRows.set(lane, Math.max(laneRows.get(lane) ?? 1, next));
    }
  }

  // Positions.
  const nodes = new Map<ObjectKey, LayoutNode>();
  const districts = new Map<string, LayoutDistrict>();
  // Column 0 was the internet's; the lanes start at the gateways.
  const stripWidth = (maxDepth - 1) * COLUMN + 1.5;
  let width = 0;
  let laneZ = 0;

  const strips = new Map(
    lanes.map((lane) => {
      const rows = laneRows.get(lane) ?? 1;
      const count = rows > WRAP_ROWS ? Math.max(1, Math.round(Math.sqrt((WRAP_ASPECT * rows * ROW) / stripWidth))) : 1;

      return [lane, { count, rows: Math.ceil(rows / count) }] as const;
    }),
  );

  for (const { count } of strips.values()) {
    width = Math.max(width, count * stripWidth + (count - 1) * STRIP_GAP + 2 * LANE_PADDING);
  }

  for (const lane of lanes) {
    const strip = strips.get(lane)!;
    const laneDepth = (strip.rows - 1) * ROW + 2 * LANE_PADDING + 1.4;
    const members = inLanes.filter((id) => laneOf(id) === lane);
    let problems = 0;

    for (const id of members) {
      const node = nodeOf(id);
      const { glyph, color } = lookOf(node.gk, true);

      if (node.health === "error" || node.health === "warn") {
        problems++;
      }

      const at = row.get(id)!;
      const inStrip = Math.floor(at / strip.rows);

      nodes.set(id, {
        id,
        node,
        x: LANE_PADDING + 0.75 + inStrip * (stripWidth + STRIP_GAP) + (depth.get(id)! - 1) * COLUMN,
        y: GLYPH_FOOTPRINT[glyph].h / 2,
        z: laneZ + LANE_PADDING + 0.7 + (at % strip.rows) * ROW,
        glyph,
        heightScale: 1,
        ghost: false,
        color: node.gk.kind === "Pod" ? "" : color,
        health: node.health,
        districtId: lane,
        importance: node.gk.kind === "Service" ? 6 : 5,
      });
    }

    const worst: Health = members.some((id) => nodeOf(id).health === "error") ? "error" : problems > 0 ? "warn" : "ok";

    districts.set(lane, {
      id: lane,
      namespace: lane,
      caption: `${members.length} in the path of traffic`,
      lane: true,
      x: width / 2,
      z: laneZ + laneDepth / 2,
      width,
      depth: laneDepth,
      apps: 0,
      resources: members.length,
      problems,
      health: worst,
    });
    laneZ += laneDepth + LANE_GAP;
  }

  // The internet: a large globe beside the lanes, level with where its traffic enters.
  if (ids.has(INTERNET_ID)) {
    const entries = traffic.filter((edge) => edge.from === INTERNET_ID).map((edge) => nodes.get(edge.to)!.z);
    const z = entries.length > 0 ? entries.reduce((sum, value) => sum + value, 0) / entries.length : (laneZ - LANE_GAP) / 2;

    nodes.set(INTERNET_ID, {
      id: INTERNET_ID,
      node: INTERNET,
      x: -INTERNET_OFFSET,
      y: GLYPH_FOOTPRINT.landmark.h / 2,
      z,
      glyph: "landmark",
      heightScale: 1,
      ghost: false,
      color: BODY.entry,
      health: "neutral",
      districtId: "",
      importance: 20,
    });
  }

  const edges: LayoutEdge[] = traffic.map((edge) => {
    const target = nodeOf(edge.to);
    const source: GraphEdge = {
      id: `traffic|${edge.from}|${edge.to}`,
      ruleId: `traffic.${edge.type}`,
      type: edge.type,
      from: edge.from,
      to: edge.to,
      toGroupKind: target.gk,
      path: edge.reason,
      bySelector: false,
      state: "resolved",
      hiddenByDefault: false,
      membership: "none",
    };

    return {
      id: source.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      state: "resolved",
      color: edge.color,
      flow: true,
      local: true,
      source,
      observed: edge.observed,
    };
  });

  const edgesByNode = new Map<ObjectKey, LayoutEdge[]>();

  for (const edge of edges) {
    edgesByNode.set(edge.from, [...(edgesByNode.get(edge.from) ?? []), edge]);
    edgesByNode.set(edge.to, [...(edgesByNode.get(edge.to) ?? []), edge]);
  }

  return {
    nodes,
    apps: new Map(),
    districts,
    edges,
    edgesByNode,
    bounds: { minX: ids.has(INTERNET_ID) ? -INTERNET_OFFSET - 3 : 0, maxX: width, minZ: 0, maxZ: Math.max(laneZ - LANE_GAP, 1) },
    hidden: { shared: 0, unattached: 0, history: 0, infra: 0 },
  };
};
