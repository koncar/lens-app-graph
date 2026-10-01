/**
 * One icon per kind, in the spirit of the Kubernetes community icon set: a white glyph meant to
 * sit on a heptagon. Drawn on a 24×24 grid as SVG path data, so the same definitions render as
 * DOM (side panel, legend) and into the 3D scene's texture atlas (Path2D takes SVG paths).
 */
export interface IconPart {
  readonly d: string;
  /** Filled instead of stroked. */
  readonly fill?: boolean;
}

export type KindIcon = readonly IconPart[];

const s = (d: string): IconPart => ({ d });
const f = (d: string): IconPart => ({ d, fill: true });

const cube = (cx: number, cy: number, r: number): IconPart[] => {
  const h = r * 0.866;

  return [
    s(`M${cx} ${cy - r} L${cx + h} ${cy - r / 2} L${cx + h} ${cy + r / 2} L${cx} ${cy + r} L${cx - h} ${cy + r / 2} L${cx - h} ${cy - r / 2} Z`),
    s(`M${cx - h} ${cy - r / 2} L${cx} ${cy} L${cx + h} ${cy - r / 2} M${cx} ${cy} L${cx} ${cy + r}`),
  ];
};

const POD: KindIcon = cube(12, 12, 8.5);

const DEPLOYMENT: KindIcon = [
  s("M19.5 12 A7.5 7.5 0 1 1 16.8 6.2"),
  s("M17.4 2.6 L17.4 6.6 L13.4 6.6"),
  ...cube(12, 12.4, 3.6),
];

const REPLICA_SET: KindIcon = [...cube(8.5, 9, 4.5), ...cube(15.5, 15, 4.5)];

const STATEFUL_SET: KindIcon = [
  s("M5 6.5 C5 4.4 19 4.4 19 6.5 L19 17.5 C19 19.6 5 19.6 5 17.5 Z"),
  s("M5 6.5 C5 8.6 19 8.6 19 6.5"),
  s("M5 12 C5 14.1 19 14.1 19 12"),
];

const DAEMON_SET: KindIcon = [
  ...cube(12, 8.5, 5),
  f("M3.5 19.5 a1.9 1.9 0 1 0 3.8 0 a1.9 1.9 0 1 0 -3.8 0"),
  f("M10.1 19.5 a1.9 1.9 0 1 0 3.8 0 a1.9 1.9 0 1 0 -3.8 0"),
  f("M16.7 19.5 a1.9 1.9 0 1 0 3.8 0 a1.9 1.9 0 1 0 -3.8 0"),
];

const JOB: KindIcon = [s("M4.5 4.5 H19.5 V19.5 H4.5 Z"), f("M10 8.2 L16.2 12 L10 15.8 Z")];

const CRON_JOB: KindIcon = [s("M3.5 12 a8.5 8.5 0 1 0 17 0 a8.5 8.5 0 1 0 -17 0"), s("M12 7 V12 L15.5 14.5")];

const SERVICE: KindIcon = [
  s("M12 12 L12 5.5 M12 12 L5.8 17.5 M12 12 L18.2 17.5"),
  f("M9.6 12 a2.4 2.4 0 1 0 4.8 0 a2.4 2.4 0 1 0 -4.8 0"),
  f("M10.2 4.5 a1.8 1.8 0 1 0 3.6 0 a1.8 1.8 0 1 0 -3.6 0"),
  f("M3.6 18.3 a1.8 1.8 0 1 0 3.6 0 a1.8 1.8 0 1 0 -3.6 0"),
  f("M16.8 18.3 a1.8 1.8 0 1 0 3.6 0 a1.8 1.8 0 1 0 -3.6 0"),
];

const INGRESS: KindIcon = [s("M3 12 H14.5"), s("M10.5 7.8 L14.7 12 L10.5 16.2"), s("M15.5 4 H20 V20 H15.5")];

const GATEWAY: KindIcon = [s("M4 20 V10 A8 8 0 0 1 20 10 V20"), s("M8.5 20 V11 A3.5 3.5 0 0 1 15.5 11 V20"), s("M2.5 20 H21.5")];

const ROUTE: KindIcon = [s("M12 21 V12.5"), s("M12 12.5 L6 6.5 M12 12.5 L18 6.5"), s("M6 10.3 V6.5 H9.8 M14.2 6.5 H18 V10.3")];

const CONFIG_MAP: KindIcon = [s("M6 3 H14 L18.5 7.5 V21 H6 Z"), s("M14 3 V7.5 H18.5"), s("M9 12 H15.5 M9 16 H15.5")];

const SECRET: KindIcon = [s("M5.5 11 H18.5 V20.5 H5.5 Z"), s("M8.5 11 V8 A3.5 3.5 0 0 1 15.5 8 V11"), f("M10.6 15.2 a1.4 1.4 0 1 0 2.8 0 a1.4 1.4 0 1 0 -2.8 0")];

const VOLUME_CLAIM: KindIcon = [
  s("M5.5 6 C5.5 4.2 18.5 4.2 18.5 6 V18 C18.5 19.8 5.5 19.8 5.5 18 Z"),
  s("M5.5 6 C5.5 7.8 18.5 7.8 18.5 6"),
  s("M9 13 H15"),
];

const VOLUME: KindIcon = [s("M3.5 7 H20.5 V17 H3.5 Z"), s("M3.5 12.5 H20.5"), f("M15.6 15 a1.1 1.1 0 1 0 2.2 0 a1.1 1.1 0 1 0 -2.2 0")];

const SERVICE_ACCOUNT: KindIcon = [s("M8.5 8 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0"), s("M4.5 20.5 C4.5 15.5 8 13.5 12 13.5 C16 13.5 19.5 15.5 19.5 20.5")];

const ROLE: KindIcon = [s("M12 3 L19 6 V11.5 C19 15.8 16 19.2 12 21 C8 19.2 5 15.8 5 11.5 V6 Z"), s("M8.8 12 L11.2 14.4 L15.6 9.6")];

const BINDING: KindIcon = [
  s("M10.5 13.5 L13.5 10.5"),
  s("M9 10.8 L6.6 13.2 A3 3 0 0 0 10.8 17.4 L13.2 15"),
  s("M15 13.2 L17.4 10.8 A3 3 0 0 0 13.2 6.6 L10.8 9"),
];

const AUTOSCALER: KindIcon = [s("M3 12 H21"), s("M6.8 8.2 L3 12 L6.8 15.8 M17.2 8.2 L21 12 L17.2 15.8"), s("M9.5 9 H14.5 V15 H9.5 Z")];

const VERTICAL_AUTOSCALER: KindIcon = [s("M12 3 V21"), s("M8.2 6.8 L12 3 L15.8 6.8 M8.2 17.2 L12 21 L15.8 17.2"), s("M9 9.5 V14.5 H15 V9.5 Z")];

const DISRUPTION_BUDGET: KindIcon = [s("M3.5 17 A8.5 8.5 0 0 1 20.5 17"), s("M12 17 L16 10.5"), s("M3.5 17 H20.5")];

const NETWORK_POLICY: KindIcon = [s("M3.5 5.5 H20.5 V18.5 H3.5 Z"), s("M3.5 10 H20.5 M3.5 14.2 H20.5 M9 5.5 V10 M15 5.5 V10 M12 10 V14.2 M7 14.2 V18.5 M17 14.2 V18.5")];

const CERTIFICATE: KindIcon = [s("M7 9.5 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0"), s("M9 13.8 L7.5 21 L12 18.8 L16.5 21 L15 13.8")];

const ISSUER: KindIcon = [s("M7 9.5 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0"), s("M9.6 9.6 L11.3 11.3 L14.6 8"), s("M5 20 H19")];

const EXTERNAL_SECRET: KindIcon = [s("M4 10 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0"), s("M12 10 H20.5 M17.5 10 V13.5 M20.5 10 V13"), s("M13 18.5 H20.5 M17.5 15.8 L20.5 18.5 L17.5 21.2")];

const SECRET_STORE: KindIcon = [s("M4 4 H20 V20 H4 Z"), s("M9 12 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0"), s("M12 9 V7 M12 15 V17 M9 12 H7 M15 12 H17")];

const MONITOR: KindIcon = [s("M2.5 12.5 H7 L9.8 6 L14.2 18.5 L17 12.5 H21.5")];

const ROLLOUT: KindIcon = [s("M19.5 12 A7.5 7.5 0 0 1 6.3 16.8"), s("M4.5 12 A7.5 7.5 0 0 1 17.7 7.2"), s("M17.6 3.4 V7.4 H13.6 M6.4 20.6 V16.6 H10.4")];

const ENDPOINT_SLICE: KindIcon = [
  s("M5 12 H19"),
  f("M3 12 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0"),
  f("M10 12 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0"),
  f("M17 12 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0"),
];

const NODE: KindIcon = [s("M4 4.5 H20 V10.5 H4 Z"), s("M4 13.5 H20 V19.5 H4 Z"), f("M15.5 7.5 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0"), f("M15.5 16.5 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0")];

const STORAGE_CLASS: KindIcon = [s("M12 3.5 L20.5 8 L12 12.5 L3.5 8 Z"), s("M3.5 12 L12 16.5 L20.5 12"), s("M3.5 16 L12 20.5 L20.5 16")];

const CLASS: KindIcon = [s("M3.5 12.5 L11.5 4.5 H19.5 V12.5 L11.5 20.5 Z"), f("M14.6 9.4 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0")];

const NAMESPACE: KindIcon = [s("M4 4 H20 V20 H4 Z")];

const INTERNET: KindIcon = [s("M3 12 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0"), s("M3 12 H21"), s("M12 3 C8.5 6.5 8.5 17.5 12 21 C15.5 17.5 15.5 6.5 12 3")];

const UNKNOWN: KindIcon = [s("M9.2 9.2 A2.8 2.8 0 1 1 13 11.8 C12.2 12.2 12 12.8 12 13.8"), f("M10.9 17 a1.1 1.1 0 1 0 2.2 0 a1.1 1.1 0 1 0 -2.2 0")];

const ICONS: Readonly<Record<string, KindIcon>> = {
  Pod: POD,
  Deployment: DEPLOYMENT,
  ReplicaSet: REPLICA_SET,
  ReplicationController: REPLICA_SET,
  StatefulSet: STATEFUL_SET,
  DaemonSet: DAEMON_SET,
  Job: JOB,
  CronJob: CRON_JOB,
  Rollout: ROLLOUT,
  Service: SERVICE,
  Ingress: INGRESS,
  Gateway: GATEWAY,
  HTTPRoute: ROUTE,
  GRPCRoute: ROUTE,
  TLSRoute: ROUTE,
  TCPRoute: ROUTE,
  UDPRoute: ROUTE,
  VirtualService: ROUTE,
  ConfigMap: CONFIG_MAP,
  Secret: SECRET,
  PersistentVolumeClaim: VOLUME_CLAIM,
  PersistentVolume: VOLUME,
  ServiceAccount: SERVICE_ACCOUNT,
  Role: ROLE,
  ClusterRole: ROLE,
  RoleBinding: BINDING,
  ClusterRoleBinding: BINDING,
  HorizontalPodAutoscaler: AUTOSCALER,
  ScaledObject: AUTOSCALER,
  VerticalPodAutoscaler: VERTICAL_AUTOSCALER,
  PodDisruptionBudget: DISRUPTION_BUDGET,
  NetworkPolicy: NETWORK_POLICY,
  Certificate: CERTIFICATE,
  Issuer: ISSUER,
  ClusterIssuer: ISSUER,
  ExternalSecret: EXTERNAL_SECRET,
  SecretStore: SECRET_STORE,
  ClusterSecretStore: SECRET_STORE,
  ServiceMonitor: MONITOR,
  PodMonitor: MONITOR,
  EndpointSlice: ENDPOINT_SLICE,
  Node: NODE,
  StorageClass: STORAGE_CLASS,
  IngressClass: CLASS,
  GatewayClass: CLASS,
  PriorityClass: CLASS,
  RuntimeClass: CLASS,
  Namespace: NAMESPACE,
  Internet: INTERNET,
};

/** Every kind with an icon of its own, in a stable order: the 3D atlas is laid out by it. */
export const ICON_KINDS: readonly string[] = [...Object.keys(ICONS), "?"];

export const iconOf = (kind: string): KindIcon => ICONS[kind] ?? UNKNOWN;

export const iconIndexOf = (kind: string): number => {
  const index = ICON_KINDS.indexOf(kind);

  return index === -1 ? ICON_KINDS.length - 1 : index;
};
