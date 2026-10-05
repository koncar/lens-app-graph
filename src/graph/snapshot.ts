import { type Health, healthOf, type HealthReport, HEALTH_SEVERITY, worstHealth } from "./health";
import { APP_IDENTITY, APP_SUPER_GROUP, type GroupKind, HUBS, K, type Membership, ROOT_OWNER_KINDS, type Rule } from "./rules";
import type { GraphStore, KindState } from "./store";
import {
  asString,
  type Edge,
  type EdgeState,
  field,
  groupKindKey,
  type GroupKindKey,
  type KubeObject,
  type ObjectKey,
  parseObjectKey,
  sameGroupKind,
} from "./types";

export type NodeRole = "member" | "shared" | "hub" | "unattached";

export interface GraphNode {
  readonly id: ObjectKey;
  readonly gk: GroupKind;
  readonly namespace: string;
  readonly name: string;
  /** present: the object exists. missing: referenced, and its kind is listed, but it is not there. unknown: its kind cannot be listed. */
  readonly state: "present" | "missing" | "unknown";
  readonly object?: KubeObject;
  readonly health: Health;
  readonly summary?: string;
  readonly role: NodeRole;
  /** The app the node belongs to, for members. */
  readonly appId?: string;
  /** The apps that each claim it, for shared nodes. */
  readonly claimedBy: readonly string[];
  /** Why an unknown node is unknown: "forbidden", "not tracked", ... */
  readonly unknownReason?: string;
}

export interface GraphEdge extends Edge {
  readonly state: Exclude<EdgeState, "pending">;
  readonly hiddenByDefault: boolean;
  readonly membership: Membership;
}

export interface GraphApp {
  /** `${namespace}/${name}` */
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  /** What named the app: "Helm release", "Instance", "Workload", ... */
  readonly source: string;
  readonly partOf?: string;
  readonly members: readonly ObjectKey[];
  readonly health: Health;
  readonly pods: number;
  readonly readyPods: number;
  readonly problems: number;
  readonly missing: number;
}

export interface GraphSnapshot {
  readonly nodes: ReadonlyMap<ObjectKey, GraphNode>;
  readonly edges: readonly GraphEdge[];
  readonly outOf: ReadonlyMap<ObjectKey, readonly GraphEdge[]>;
  readonly into: ReadonlyMap<ObjectKey, readonly GraphEdge[]>;
  readonly apps: ReadonlyMap<string, GraphApp>;
  /** Every namespace seen: listed ones and those that objects live in. */
  readonly namespaces: readonly string[];
  readonly kinds: ReadonlyMap<GroupKindKey, KindState>;
  readonly version: number;
}

interface Identity {
  readonly name: string;
  readonly namespace: string;
  readonly source: string;
}

const appIdOf = ({ namespace, name }: { namespace: string; name: string }) => `${namespace}/${name}`;

const isHub = (gk: GroupKind, name: string) => HUBS.some((hub) => sameGroupKind(hub.kind, gk) && (hub.name === undefined || hub.name === name));

const isRootOwnerKind = (gk: GroupKind) => ROOT_OWNER_KINDS.some((kind) => sameGroupKind(kind, gk));

/** Kinds the rules know what they are; an owner of any other kind is someone's operator resource. */
const KNOWN_KINDS: readonly GroupKind[] = Object.values(K);
const isKnownKind = (gk: GroupKind) => KNOWN_KINDS.some((kind) => sameGroupKind(kind, gk));

/** The first APP_IDENTITY entry that names an app for this object from its own labels and annotations. */
export const explicitIdentityOf = (object: KubeObject, namespace: string): Identity | undefined => {
  const labels = object.metadata.labels ?? {};
  const annotations = object.metadata.annotations ?? {};

  for (const entry of APP_IDENTITY) {
    switch (entry.source) {
      case "annotation":
      case "label": {
        const values = entry.source === "label" ? labels : annotations;
        const [nameKey, namespaceKey] = entry.keys;
        let name = values[nameKey];

        if (!name) {
          continue;
        }

        if (nameKey === "argocd.argoproj.io/tracking-id") {
          name = name.split(":")[0] ?? name;
        }

        const named = namespaceKey ? values[namespaceKey] : undefined;

        return { name, namespace: entry.ownNamespaceFirst ? namespace || named || "" : named || namespace, source: entry.label };
      }

      case "helmReleaseSecret": {
        if (object.kind === "Secret" && labels.owner === "helm" && labels.name && asString(field(object, "type")) === "helm.sh/release.v1") {
          return { name: labels.name, namespace, source: entry.label };
        }
        continue;
      }

      case "rootOwner":
        continue;
    }
  }

  return undefined;
};

const edgeStateFor = (rule: Rule | undefined, targetExists: boolean, kindState: KindState, targetNamespace: string): EdgeState | "drop" => {
  if (targetExists) {
    return "resolved";
  }

  if (rule?.dropUnresolved) {
    return "drop";
  }

  switch (kindState.phase) {
    case "ready":
      // Listed, but not in the namespace the target would be in: cannot tell it is missing.
      return kindState.namespaces && targetNamespace !== "" && !kindState.namespaces.has(targetNamespace) ? "unknown" : "missing";
    case "loading":
      return "pending";
    case "unavailable":
      return "unknown";
    case "untracked":
      // A reference into a kind the graph does not follow. Owners and object refs name their
      // kind explicitly, so they are worth showing (an operator's custom resource owning pods);
      // a name ref into a switched-off kind (IngressClass, say) is simply not drawn.
      if (!rule || rule.requiresServed) {
        return "drop";
      }

      return rule.match.type === "ownerReferences" || rule.match.type === "objectRef" ? "unknown" : "drop";
  }
};

const unknownReasonOf = (kindState: KindState) =>
  kindState.phase === "unavailable" ? kindState.reason : kindState.phase === "ready" ? "Not listable in its namespace" : "Kind not tracked";

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);

  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
};

export const buildSnapshot = (store: GraphStore): GraphSnapshot => {
  // --- nodes and edges ---------------------------------------------------------------------
  interface MutableNode {
    id: ObjectKey;
    gk: GroupKind;
    namespace: string;
    name: string;
    state: GraphNode["state"];
    object?: KubeObject;
    report: HealthReport;
    unknownReason?: string;
  }

  const nodes = new Map<ObjectKey, MutableNode>();
  const namespaces = new Set<string>();

  for (const stored of store.all()) {
    if (stored.gk.group === "" && stored.gk.kind === "Namespace") {
      namespaces.add(stored.object.metadata.name);
      continue;
    }

    const { name } = stored.object.metadata;

    nodes.set(stored.key, {
      id: stored.key,
      gk: stored.gk,
      namespace: stored.namespace,
      name,
      state: "present",
      object: stored.object,
      report: healthOf(stored.object),
    });

    if (stored.namespace) {
      namespaces.add(stored.namespace);
    }
  }

  const edges: GraphEdge[] = [];
  const outOf = new Map<ObjectKey, GraphEdge[]>();
  const into = new Map<ObjectKey, GraphEdge[]>();

  for (const edge of store.edges()) {
    if (!nodes.has(edge.from)) {
      continue;
    }

    const rule = store.ruleById(edge.ruleId);
    const kindState = store.kindState(edge.toGroupKind);
    const state = edgeStateFor(rule, nodes.has(edge.to), kindState, parseObjectKey(edge.to).namespace);

    if (state === "drop" || state === "pending") {
      continue;
    }

    if (state !== "resolved" && !nodes.has(edge.to)) {
      const { namespace, name } = parseObjectKey(edge.to);

      nodes.set(edge.to, {
        id: edge.to,
        gk: edge.toGroupKind,
        namespace,
        name,
        state,
        report:
          state === "missing"
            ? { health: "error", summary: "Does not exist" }
            : { health: "unknown", summary: unknownReasonOf(kindState) },
        unknownReason: state === "unknown" ? unknownReasonOf(kindState) : undefined,
      });
    }

    const graphEdge: GraphEdge = {
      ...edge,
      state,
      hiddenByDefault: rule?.hiddenByDefault ?? false,
      membership: rule?.membership ?? "none",
    };

    edges.push(graphEdge);
    push(outOf, edge.from, graphEdge);
    push(into, edge.to, graphEdge);
  }

  // --- relationship health -----------------------------------------------------------------
  for (const node of nodes.values()) {
    if (node.state !== "present") {
      continue;
    }

    const outgoing = outOf.get(node.id) ?? [];
    const broken = outgoing.find((edge) => edge.state === "missing" && !edge.hiddenByDefault);

    if (node.gk.kind === "Service" && node.gk.group === "") {
      const hasSelector = Object.keys((field(node.object, "spec", "selector") as Record<string, string> | undefined) ?? {}).length > 0;
      const pods = outgoing.filter((edge) => edge.ruleId === "service.selector").map((edge) => nodes.get(edge.to));

      if (hasSelector && pods.length === 0) {
        node.report = { health: "warn", summary: "Selects no pods" };
      } else if (pods.length > 0 && !pods.some((pod) => pod?.report.health === "ok")) {
        node.report = { health: "error", summary: "No ready pods" };
      } else if (pods.length > 0) {
        const ready = pods.filter((pod) => pod?.report.health === "ok").length;

        node.report = { health: "ok", summary: `${ready}/${pods.length} pods ready` };
      }
    }

    if (broken && HEALTH_SEVERITY[node.report.health] < HEALTH_SEVERITY.error) {
      const { name } = parseObjectKey(broken.to);

      node.report = { health: node.gk.kind === "Pod" ? "error" : "warn", summary: `Missing ${broken.toGroupKind.kind} ${name}` };
    }
  }

  // --- app identity ------------------------------------------------------------------------
  const explicit = new Map<ObjectKey, Identity>();

  for (const node of nodes.values()) {
    if (node.object) {
      const identity = explicitIdentityOf(node.object, node.namespace);

      if (identity) {
        explicit.set(node.id, identity);
      }
    }
  }

  const ownerOf = (id: ObjectKey): ObjectKey | undefined => {
    const owners = (outOf.get(id) ?? []).filter((edge) => edge.ruleId === "owner-references");

    if (owners.length === 0) {
      return undefined;
    }

    const controllerIndex = (nodes.get(id)?.object?.metadata.ownerReferences ?? []).findIndex((ref) => ref.controller);
    const controller = owners.find((edge) => edge.path === `metadata.ownerReferences[${controllerIndex}]`);

    return (controller ?? owners[0])!.to;
  };

  // Walk up the owners: the first ancestor with an explicit identity names the app; failing that,
  // a root that is a workload (or an owner of a kind the graph does not track) does.
  for (const node of nodes.values()) {
    if (explicit.has(node.id) || node.state !== "present") {
      continue;
    }

    const seen = new Set<ObjectKey>([node.id]);
    let current = node.id;
    let inherited: Identity | undefined;

    for (let owner = ownerOf(current); owner && !seen.has(owner); owner = ownerOf(current)) {
      seen.add(owner);
      current = owner;

      const ownerNode = nodes.get(owner);
      const ownerIdentity = ownerNode?.object ? explicitIdentityOf(ownerNode.object, ownerNode.namespace) : undefined;

      if (ownerIdentity) {
        inherited = ownerIdentity;
        break;
      }
    }

    if (!inherited) {
      const root = nodes.get(current);

      // An operator's resource (listed, or only seen as an owner) anchors what it owns.
      const isOperatorResource = root !== undefined && root.id !== node.id && (root.state === "unknown" || !isKnownKind(root.gk));

      if (root && (isRootOwnerKind(root.gk) || isOperatorResource)) {
        inherited = { name: root.name, namespace: node.namespace || root.namespace, source: isOperatorResource ? `${root.gk.kind} owner` : "Workload" };
      }
    }

    if (inherited) {
      explicit.set(node.id, inherited);
    }
  }

  // --- membership propagation --------------------------------------------------------------
  const hubs = new Set<ObjectKey>();

  for (const node of nodes.values()) {
    if (isHub(node.gk, node.name) && !explicit.has(node.id)) {
      hubs.add(node.id);
    }
  }

  const seedsByApp = new Map<string, ObjectKey[]>();
  const identities = new Map<string, Identity>();

  for (const [id, identity] of explicit) {
    const appId = appIdOf(identity);

    push(seedsByApp, appId, id);

    if (!identities.has(appId) || identity.source !== "Workload") {
      identities.set(appId, identity);
    }
  }

  const neighbours = (id: ObjectKey): ObjectKey[] => {
    const result: ObjectKey[] = [];

    for (const edge of outOf.get(id) ?? []) {
      if (edge.membership === "forward" || edge.membership === "both") {
        result.push(edge.to);
      }
    }

    for (const edge of into.get(id) ?? []) {
      if (edge.membership === "backward" || edge.membership === "both") {
        result.push(edge.from);
      }
    }

    return result;
  };

  let shared = new Set<ObjectKey>();
  let claims = new Map<ObjectKey, Set<string>>();

  // Iterate until the shared set is stable: a node claimed by two apps is context for both, and
  // membership must not flow through it into either.
  for (let round = 0; round < 4; round++) {
    claims = new Map();

    for (const [appId, seeds] of seedsByApp) {
      const seedSet = new Set<ObjectKey>(seeds);
      const visited = new Set<ObjectKey>(seeds);
      const queue = [...seeds];

      for (const seed of seeds) {
        let set = claims.get(seed);

        if (!set) {
          set = new Set();
          claims.set(seed, set);
        }

        set.add(appId);
      }

      while (queue.length > 0) {
        const id = queue.pop()!;

        if (shared.has(id) && !seedSet.has(id)) {
          continue;
        }

        for (const next of neighbours(id)) {
          if (visited.has(next) || hubs.has(next) || explicit.has(next)) {
            continue;
          }

          visited.add(next);

          let set = claims.get(next);

          if (!set) {
            set = new Set();
            claims.set(next, set);
          }

          set.add(appId);
          queue.push(next);
        }
      }
    }

    const nextShared = new Set(shared);

    for (const [id, apps] of claims) {
      if (apps.size > 1 && !explicit.has(id)) {
        nextShared.add(id);
      }
    }

    if (nextShared.size === shared.size) {
      break;
    }

    shared = nextShared;
  }

  // --- final nodes and apps ----------------------------------------------------------------
  const finalNodes = new Map<ObjectKey, GraphNode>();
  const membersByApp = new Map<string, ObjectKey[]>();

  for (const node of nodes.values()) {
    const apps = [...(claims.get(node.id) ?? [])].sort();
    let role: NodeRole;
    let appId: string | undefined;

    if (hubs.has(node.id)) {
      role = "hub";
    } else if (apps.length > 1 || (shared.has(node.id) && apps.length > 0)) {
      role = "shared";
    } else if (apps.length === 1) {
      role = "member";
      appId = apps[0];
      push(membersByApp, appId!, node.id);
    } else {
      role = "unattached";
    }

    finalNodes.set(node.id, {
      id: node.id,
      gk: node.gk,
      namespace: node.namespace,
      name: node.name,
      state: node.state,
      object: node.object,
      health: node.report.health,
      summary: node.report.summary,
      role,
      appId,
      claimedBy: role === "shared" || role === "hub" ? apps : [],
      unknownReason: node.unknownReason,
    });
  }

  const apps = new Map<string, GraphApp>();

  for (const [appId, members] of membersByApp) {
    const identity = identities.get(appId)!;
    const memberNodes = members.map((id) => finalNodes.get(id)!);
    const pods = memberNodes.filter((node) => sameGroupKind(node.gk, K.Pod) && node.state === "present");
    const partOf = memberNodes
      .map((node) => node.object?.metadata.labels?.[APP_SUPER_GROUP.key])
      .find((value): value is string => Boolean(value));

    apps.set(appId, {
      id: appId,
      name: identity.name,
      namespace: identity.namespace,
      source: identity.source,
      partOf,
      members: members.sort(),
      health: worstHealth(memberNodes.map((node) => node.health)),
      pods: pods.length,
      readyPods: pods.filter((pod) => pod.health === "ok").length,
      problems: memberNodes.filter((node) => node.health === "error" || node.health === "warn").length,
      missing: memberNodes.filter((node) => node.state === "missing").length,
    });

    if (identity.namespace) {
      namespaces.add(identity.namespace);
    }
  }

  return {
    nodes: finalNodes,
    edges,
    outOf,
    into,
    apps,
    namespaces: [...namespaces].sort(),
    kinds: new Map(store.kinds()),
    version: store.version,
  };
};

export const kindLabel = (gk: GroupKind) => gk.kind;

export const nodeKindKey = (node: GraphNode) => groupKindKey(node.gk);
