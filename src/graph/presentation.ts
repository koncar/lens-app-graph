import type { Health } from "./health";
import type { EdgeType, GroupKind } from "./rules";

/**
 * How each kind reads in 3D. Three colour families, as in the lns lab: cyan for how traffic gets
 * in, orange for what runs, ice for the data and config it uses. Green, amber and red only ever
 * mean health.
 */
export type Glyph = "gate" | "hex" | "block" | "slab" | "cube" | "tile" | "disk" | "gem" | "ring" | "orb" | "landmark";

/** Tiers run left to right the way a request does: in through a gate, to a service, to pods, to their data. */
export type Tier = "entry" | "service" | "controller" | "replica" | "pod" | "config" | "identity" | "satellite";

export const TIER_ORDER: readonly Tier[] = ["entry", "service", "controller", "replica", "pod", "config", "identity"];

export interface KindLook {
  readonly glyph: Glyph;
  readonly tier: Tier;
  readonly color: string;
  /** Infrastructure: drawn only when the user asks for it. */
  readonly infra?: boolean;
}

export const PALETTE = {
  cyan: "#7fe3ff",
  teal: "#58d6c9",
  orange: "#e8875f",
  apricot: "#e0a27e",
  ice: "#b9c8e8",
  gold: "#ffc857",
  violet: "#a391f2",
  lavender: "#8d9cc4",
  green: "#5ee89a",
  blue: "#6aa8ff",
  red: "#ff5d6c",
  pink: "#f28dc0",
  grey: "#8b94ad",
  slate: "#5c6580",
} as const;

export const HEALTH_COLORS: Readonly<Record<Health, string>> = {
  ok: PALETTE.green,
  warn: PALETTE.gold,
  error: PALETTE.red,
  idle: PALETTE.grey,
  neutral: PALETTE.ice,
  unknown: PALETTE.slate,
};

/**
 * Token bodies: deep, saturated colours a white icon reads on, as on the Kubernetes icons.
 * Workloads take the Kubernetes blue itself.
 */
export const BODY = {
  kubernetes: "#326ce5",
  replica: "#4d7fe0",
  entry: "#0f86a8",
  service: "#1597b8",
  config: "#566a9c",
  secret: "#b07f22",
  storage: "#6a52c4",
  identity: "#55628f",
  role: "#7f529e",
  scaling: "#24945a",
  budget: "#2a68ad",
  policy: "#b83e4c",
  monitor: "#a8791f",
  gitops: "#c4553a",
  device: "#3d8f8a",
  infra: "#535a70",
} as const;

/** Pods are coloured by health; deeper than HEALTH_COLORS, so their icon reads on them. */
export const POD_BODY: Readonly<Record<Health, string>> = {
  ok: "#1f9a55",
  warn: "#c08414",
  error: "#cf3a47",
  idle: "#59606f",
  neutral: "#566a9c",
  unknown: "#4a5064",
};

const LOOKS: Readonly<Record<string, KindLook>> = {
  Ingress: { glyph: "gate", tier: "entry", color: BODY.entry },
  Gateway: { glyph: "gate", tier: "entry", color: BODY.entry },
  HTTPRoute: { glyph: "gate", tier: "entry", color: BODY.entry },
  GRPCRoute: { glyph: "gate", tier: "entry", color: BODY.entry },
  TLSRoute: { glyph: "gate", tier: "entry", color: BODY.entry },
  TCPRoute: { glyph: "gate", tier: "entry", color: BODY.entry },
  UDPRoute: { glyph: "gate", tier: "entry", color: BODY.entry },
  VirtualService: { glyph: "gate", tier: "entry", color: BODY.entry },
  ServiceEntry: { glyph: "gate", tier: "entry", color: BODY.entry },

  Service: { glyph: "hex", tier: "service", color: BODY.service },
  EndpointSlice: { glyph: "orb", tier: "service", color: BODY.service, infra: true },

  Deployment: { glyph: "block", tier: "controller", color: BODY.kubernetes },
  StatefulSet: { glyph: "block", tier: "controller", color: BODY.kubernetes },
  DaemonSet: { glyph: "block", tier: "controller", color: BODY.kubernetes },
  CronJob: { glyph: "block", tier: "controller", color: BODY.kubernetes },
  Rollout: { glyph: "block", tier: "controller", color: BODY.kubernetes },
  ReplicationController: { glyph: "block", tier: "controller", color: BODY.kubernetes },
  Application: { glyph: "block", tier: "controller", color: BODY.gitops },
  Kustomization: { glyph: "block", tier: "controller", color: BODY.gitops },
  HelmRelease: { glyph: "block", tier: "controller", color: BODY.gitops },

  ReplicaSet: { glyph: "slab", tier: "replica", color: BODY.replica },
  Job: { glyph: "slab", tier: "replica", color: BODY.replica },

  Pod: { glyph: "cube", tier: "pod", color: POD_BODY.ok },

  ConfigMap: { glyph: "tile", tier: "config", color: BODY.config },
  Secret: { glyph: "tile", tier: "config", color: BODY.secret },
  PersistentVolumeClaim: { glyph: "disk", tier: "config", color: BODY.storage },
  PersistentVolume: { glyph: "disk", tier: "config", color: BODY.storage },
  Certificate: { glyph: "gem", tier: "config", color: BODY.secret },
  ExternalSecret: { glyph: "gem", tier: "config", color: BODY.secret },
  ResourceClaim: { glyph: "disk", tier: "config", color: BODY.device },
  ResourceClaimTemplate: { glyph: "disk", tier: "config", color: BODY.device },
  GitRepository: { glyph: "tile", tier: "config", color: BODY.gitops },
  OCIRepository: { glyph: "tile", tier: "config", color: BODY.gitops },
  HelmRepository: { glyph: "tile", tier: "config", color: BODY.gitops },

  ServiceAccount: { glyph: "gem", tier: "identity", color: BODY.identity },
  RoleBinding: { glyph: "gem", tier: "identity", color: BODY.identity },
  ClusterRoleBinding: { glyph: "gem", tier: "identity", color: BODY.identity },
  Role: { glyph: "gem", tier: "identity", color: BODY.role },
  ClusterRole: { glyph: "gem", tier: "identity", color: BODY.role },
  Issuer: { glyph: "gem", tier: "identity", color: BODY.secret },
  ClusterIssuer: { glyph: "gem", tier: "identity", color: BODY.secret },
  SecretStore: { glyph: "gem", tier: "identity", color: BODY.secret },
  ClusterSecretStore: { glyph: "gem", tier: "identity", color: BODY.secret },

  HorizontalPodAutoscaler: { glyph: "ring", tier: "satellite", color: BODY.scaling },
  VerticalPodAutoscaler: { glyph: "ring", tier: "satellite", color: BODY.scaling },
  ScaledObject: { glyph: "ring", tier: "satellite", color: BODY.scaling },
  PodDisruptionBudget: { glyph: "ring", tier: "satellite", color: BODY.budget },
  NetworkPolicy: { glyph: "ring", tier: "satellite", color: BODY.policy },
  ServiceMonitor: { glyph: "ring", tier: "satellite", color: BODY.monitor },
  PodMonitor: { glyph: "ring", tier: "satellite", color: BODY.monitor },
  DestinationRule: { glyph: "ring", tier: "satellite", color: BODY.service },
  ValidatingWebhookConfiguration: { glyph: "ring", tier: "satellite", color: BODY.policy },
  MutatingWebhookConfiguration: { glyph: "ring", tier: "satellite", color: BODY.policy },
  APIService: { glyph: "ring", tier: "satellite", color: BODY.infra },

  StorageClass: { glyph: "disk", tier: "identity", color: BODY.infra, infra: true },
  Node: { glyph: "orb", tier: "identity", color: BODY.infra, infra: true },
  IngressClass: { glyph: "orb", tier: "identity", color: BODY.infra, infra: true },
  GatewayClass: { glyph: "orb", tier: "identity", color: BODY.infra, infra: true },
  PriorityClass: { glyph: "orb", tier: "identity", color: BODY.infra, infra: true },
  RuntimeClass: { glyph: "orb", tier: "identity", color: BODY.infra, infra: true },
  DeviceClass: { glyph: "orb", tier: "identity", color: BODY.infra, infra: true },
};

/** Kinds nothing describes, typically an operator's custom resource owning pods: a workload of its own. */
const UNKNOWN_OWNER: KindLook = { glyph: "block", tier: "controller", color: BODY.infra };
const OTHER: KindLook = { glyph: "orb", tier: "config", color: BODY.infra };

export const lookOf = (gk: GroupKind, isOwner = false): KindLook => LOOKS[gk.kind] ?? (isOwner ? UNKNOWN_OWNER : OTHER);

export const EDGE_COLORS: Readonly<Record<EdgeType, string>> = {
  ownedBy: PALETTE.orange,
  mounts: PALETTE.ice,
  readsEnvFrom: PALETTE.ice,
  pullsWith: PALETTE.gold,
  runsAs: PALETTE.lavender,
  scheduledOn: PALETTE.grey,
  usesClass: PALETTE.grey,
  selects: PALETTE.cyan,
  endpointOf: PALETTE.teal,
  routesTo: PALETTE.cyan,
  attachesTo: PALETTE.teal,
  usesTls: PALETTE.gold,
  governedBy: PALETTE.teal,
  boundTo: PALETTE.violet,
  bindsSubject: PALETTE.lavender,
  grants: PALETTE.pink,
  scales: PALETTE.green,
  issues: PALETTE.gold,
  issuedBy: PALETTE.gold,
  syncsTo: PALETTE.gold,
  readsFrom: PALETTE.gold,
  calls: PALETTE.violet,
  claims: PALETTE.teal,
  manages: PALETTE.orange,
  configures: PALETTE.cyan,
  servedBy: PALETTE.pink,
};

/** Edges traffic travels along, animated with packets from the holder to the target. */
export const FLOW_EDGES: ReadonlySet<EdgeType> = new Set<EdgeType>(["routesTo", "selects", "attachesTo"]);

export const EDGE_VERBS: Readonly<Record<EdgeType, string>> = {
  ownedBy: "owned by",
  mounts: "mounts",
  readsEnvFrom: "reads env from",
  pullsWith: "pulls images with",
  runsAs: "runs as",
  scheduledOn: "scheduled on",
  usesClass: "uses class",
  selects: "selects",
  endpointOf: "endpoint of",
  routesTo: "routes to",
  attachesTo: "attaches to",
  usesTls: "uses TLS from",
  governedBy: "governed by",
  boundTo: "bound to",
  bindsSubject: "binds",
  grants: "grants",
  scales: "scales",
  issues: "issues",
  issuedBy: "issued by",
  syncsTo: "syncs to",
  readsFrom: "reads from",
  calls: "calls",
  claims: "claims",
  manages: "manages",
  configures: "configures",
  servedBy: "served by",
};


/** The same relationships read from the target's side: "ConfigMap x is mounted by pod y". */
export const EDGE_INVERSE_VERBS: Readonly<Record<EdgeType, string>> = {
  ownedBy: "owns",
  mounts: "mounted by",
  readsEnvFrom: "env read by",
  pullsWith: "pull secret of",
  runsAs: "identity of",
  scheduledOn: "runs",
  usesClass: "class of",
  selects: "selected by",
  endpointOf: "has endpoint",
  routesTo: "receives from",
  attachesTo: "has route",
  usesTls: "TLS for",
  governedBy: "governs",
  boundTo: "claimed by",
  bindsSubject: "bound by",
  grants: "granted by",
  scales: "scaled by",
  issues: "issued by",
  issuedBy: "issues",
  syncsTo: "synced by",
  readsFrom: "source of",
  calls: "called by",
  claims: "claimed by",
  manages: "managed by",
  configures: "configured by",
  servedBy: "serves",
};
