/**
 * Relationship rules of the app graph.
 *
 * Ported from shipa-controller's `kubeRelationships` table
 * (shipa-controller/internal/discovery/handlers/topology.go:124-328) and corrected
 * for the defects found while analysing it (app-graph-handoff/HANDOFF.md, "Defects in the original").
 *
 * This file is DATA + TYPES only. It has no Lens imports on purpose: `store.ts` evaluates it,
 * and both are unit-tested without Lens (`npm test`).
 *
 * Key differences from the Go original:
 *  - Kinds are identified by group + kind, never kind alone (Knative `Service` != core `Service`).
 *  - Every rule is written from the object that HOLDS the reference ("holder") to the target.
 *    There is no `upstream` flag and no generated reverse table: the engine stores edges in both
 *    directions, so reverse lookups are free.
 *  - Paths yield MANY values: `[*]` iterates an array and every element produces its own edge.
 *    (The original merged all matches into one map and kept only the last.)
 *  - Label selectors use real Kubernetes semantics (matchLabels + matchExpressions; whether an
 *    empty selector means "all" or "none" is stated per rule).
 *  - No "pod name equals some selector value" fallback (the original's searchNameInLabels).
 *  - Pod-spec rules apply to pod TEMPLATES too, so a Deployment scaled to 0 still shows its config.
 *  - Unresolved references are kept (as "missing" nodes) instead of being dropped.
 */

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** Group + kind. The core group is "". */
export interface GroupKind {
  readonly group: string;
  readonly kind: string;
}

export type EdgeType =
  | "ownedBy" //         metadata.ownerReferences
  | "mounts" //          volume (configMap, secret, PVC, projected, CSI secret)
  | "readsEnvFrom" //    env valueFrom / envFrom
  | "pullsWith" //       imagePullSecrets
  | "runsAs" //          serviceAccountName
  | "scheduledOn" //     spec.nodeName
  | "usesClass" //       storageClassName, ingressClassName, gatewayClassName, priorityClassName, runtimeClassName
  | "selects" //         label selector: Service, PDB, NetworkPolicy, ServiceMonitor, PodMonitor
  | "endpointOf" //      EndpointSlice -> Service, EndpointSlice -> Pod
  | "routesTo" //        Ingress/HTTPRoute/GRPCRoute/... -> Service
  | "attachesTo" //      Route parentRefs -> Gateway
  | "usesTls" //         Ingress/Gateway -> TLS Secret
  | "governedBy" //      StatefulSet -> headless Service (spec.serviceName)
  | "boundTo" //         PVC -> PV
  | "bindsSubject" //    RoleBinding/ClusterRoleBinding -> ServiceAccount
  | "grants" //          RoleBinding/ClusterRoleBinding -> Role/ClusterRole
  | "scales" //          HPA/VPA/KEDA ScaledObject -> workload
  | "issues" //          cert-manager Certificate -> Secret
  | "issuedBy" //        Certificate -> Issuer/ClusterIssuer
  | "syncsTo" //         ExternalSecret -> Secret
  | "readsFrom" //       ExternalSecret -> SecretStore
  | "calls"; //          workload or its config names a Service's DNS name (inferred traffic)

/**
 * How app-membership expansion may cross an edge of this rule, starting from a node that is
 * already a member of the app:
 *  - "forward":  holder is a member  => target becomes a member   (Pod mounts ConfigMap)
 *  - "backward": target is a member  => holder becomes a member   (Service selects Pod)
 *  - "both"
 *  - "none":     draw the edge, but never pull the other end into the app (Node, StorageClass)
 * Expansion never continues past a hub node (see HUBS and the shared-node rule in HANDOFF.md).
 */
export type Membership = "forward" | "backward" | "both" | "none";

/**
 * A path into the holder object. Dot-separated; `[*]` iterates an array, and every element
 * yields its own value (no merging). Several alternative paths may be given.
 *   "spec.containers[*].env[*].valueFrom.secretKeyRef.name"
 * The special prefix "$podSpec" expands to wherever the holder keeps its pod spec
 * (see POD_SPEC_LOCATIONS). The engine must report the CONCRETE path of each value
 * (e.g. "spec.template.spec.volumes[2].secret.secretName") as edge metadata.
 */
export type Path = string;

export type Match =
  /** The value at the path is the NAME of the target. */
  | {
      readonly type: "name";
      readonly paths: readonly Path[];
      readonly target: GroupKind;
      /** Where the target lives. "same" = holder's namespace; "cluster" = cluster-scoped target. */
      readonly namespace: "same" | "cluster";
      /** Name to use when the path is absent, e.g. serviceAccountName defaults to "default". */
      readonly defaultName?: string;
    }
  /**
   * The value at the path is an OBJECT naming the target: some of
   * { apiVersion | apiGroup | group, kind, name, namespace }.
   * Examples: scaleTargetRef, roleRef, subjects[*], targetRef, parentRefs[*], backendRefs[*], issuerRef.
   */
  | {
      readonly type: "objectRef";
      readonly paths: readonly Path[];
      /** Used when the ref object leaves the field out (Gateway API defaults, subjects' namespace, ...). */
      readonly defaults: { readonly group?: string; readonly kind?: string; readonly namespace?: "same" };
      /** Only refs to these kinds produce edges (e.g. subjects of kind User/Group are skipped). */
      readonly allowedTargets?: readonly GroupKind[];
      /** Field holding the target name when it is not "name" (rare). */
      readonly nameField?: string;
    }
  /** Every entry of metadata.ownerReferences (ALL of them, matched by uid when present). */
  | { readonly type: "ownerReferences" }
  /** A label selector on the holder, matched against the labels of targets in the same namespace. */
  | {
      readonly type: "selector";
      readonly path: Path;
      /** "map" = a plain map (Service spec.selector); "labelSelector" = matchLabels + matchExpressions. */
      readonly form: "map" | "labelSelector";
      /** What an empty selector ({}) means. A MISSING selector always matches nothing. */
      readonly empty: "all" | "none";
      readonly target: GroupKind;
    }
  /** A label on the holder whose value is the NAME of the target (same namespace). */
  | { readonly type: "labelValue"; readonly label: string; readonly target: GroupKind }
  /** An annotation on the holder whose value is the NAME of the target. */
  | {
      readonly type: "annotationValue";
      readonly annotation: string;
      readonly target: GroupKind;
      readonly namespace: "same" | "cluster";
    }
  /** Escape hatch for refs that need code (Istio host parsing, ephemeral PVC names). Keep rare. */
  | { readonly type: "custom"; readonly extractorId: string };

export interface Rule {
  /** Stable, unique id. Shown in the UI as "why is this linked". */
  readonly id: string;
  /** Kinds that hold the reference. */
  readonly holders: readonly GroupKind[];
  readonly match: Match;
  readonly edge: EdgeType;
  readonly membership: Membership;
  /** Hidden unless the user asks for it (Endpoints/EndpointSlices, Nodes, classes, ...). */
  readonly hiddenByDefault?: boolean;
  /** Rules for CRDs: only active when the cluster serves every kind named in the rule. */
  readonly requiresServed?: boolean;
  /** Inferred references: drawn only when the target exists, never as a missing node. */
  readonly dropUnresolved?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------------

const gk = (group: string, kind: string): GroupKind => ({ group, kind });

export const K = {
  // core
  Pod: gk("", "Pod"),
  Service: gk("", "Service"),
  ConfigMap: gk("", "ConfigMap"),
  Secret: gk("", "Secret"),
  ServiceAccount: gk("", "ServiceAccount"),
  PersistentVolumeClaim: gk("", "PersistentVolumeClaim"),
  PersistentVolume: gk("", "PersistentVolume"),
  Node: gk("", "Node"),
  Endpoints: gk("", "Endpoints"),
  ReplicationController: gk("", "ReplicationController"),
  // apps / batch
  Deployment: gk("apps", "Deployment"),
  ReplicaSet: gk("apps", "ReplicaSet"),
  StatefulSet: gk("apps", "StatefulSet"),
  DaemonSet: gk("apps", "DaemonSet"),
  ControllerRevision: gk("apps", "ControllerRevision"),
  Job: gk("batch", "Job"),
  CronJob: gk("batch", "CronJob"),
  // networking / discovery
  Ingress: gk("networking.k8s.io", "Ingress"),
  IngressClass: gk("networking.k8s.io", "IngressClass"),
  NetworkPolicy: gk("networking.k8s.io", "NetworkPolicy"),
  EndpointSlice: gk("discovery.k8s.io", "EndpointSlice"),
  // gateway api
  Gateway: gk("gateway.networking.k8s.io", "Gateway"),
  GatewayClass: gk("gateway.networking.k8s.io", "GatewayClass"),
  HTTPRoute: gk("gateway.networking.k8s.io", "HTTPRoute"),
  GRPCRoute: gk("gateway.networking.k8s.io", "GRPCRoute"),
  TLSRoute: gk("gateway.networking.k8s.io", "TLSRoute"),
  TCPRoute: gk("gateway.networking.k8s.io", "TCPRoute"),
  UDPRoute: gk("gateway.networking.k8s.io", "UDPRoute"),
  // storage / scheduling / node
  StorageClass: gk("storage.k8s.io", "StorageClass"),
  PriorityClass: gk("scheduling.k8s.io", "PriorityClass"),
  RuntimeClass: gk("node.k8s.io", "RuntimeClass"),
  // policy / autoscaling
  PodDisruptionBudget: gk("policy", "PodDisruptionBudget"),
  HorizontalPodAutoscaler: gk("autoscaling", "HorizontalPodAutoscaler"),
  VerticalPodAutoscaler: gk("autoscaling.k8s.io", "VerticalPodAutoscaler"),
  // rbac
  Role: gk("rbac.authorization.k8s.io", "Role"),
  ClusterRole: gk("rbac.authorization.k8s.io", "ClusterRole"),
  RoleBinding: gk("rbac.authorization.k8s.io", "RoleBinding"),
  ClusterRoleBinding: gk("rbac.authorization.k8s.io", "ClusterRoleBinding"),
  // ecosystem CRDs (all rules using these are requiresServed)
  Certificate: gk("cert-manager.io", "Certificate"),
  Issuer: gk("cert-manager.io", "Issuer"),
  ClusterIssuer: gk("cert-manager.io", "ClusterIssuer"),
  ExternalSecret: gk("external-secrets.io", "ExternalSecret"),
  SecretStore: gk("external-secrets.io", "SecretStore"),
  ClusterSecretStore: gk("external-secrets.io", "ClusterSecretStore"),
  ServiceMonitor: gk("monitoring.coreos.com", "ServiceMonitor"),
  PodMonitor: gk("monitoring.coreos.com", "PodMonitor"),
  ScaledObject: gk("keda.sh", "ScaledObject"),
  Rollout: gk("argoproj.io", "Rollout"),
  VirtualService: gk("networking.istio.io", "VirtualService"),
  IstioGateway: gk("networking.istio.io", "Gateway"),
} as const;

/**
 * API versions to try per kind, preferred first. The engine asks
 * kubeResourceKindIsServedInjectionToken which one the cluster serves and subscribes to that
 * one only. (The original keyed a single cache by bare Kind and picked whatever came last.)
 */
export const VERSIONS: Readonly<Record<string, readonly string[]>> = {
  "autoscaling/HorizontalPodAutoscaler": ["autoscaling/v2", "autoscaling/v1"],
  "gateway.networking.k8s.io/*": ["gateway.networking.k8s.io/v1", "gateway.networking.k8s.io/v1beta1"],
  "gateway.networking.k8s.io/TLSRoute": ["gateway.networking.k8s.io/v1alpha2"],
  "gateway.networking.k8s.io/TCPRoute": ["gateway.networking.k8s.io/v1alpha2"],
  "gateway.networking.k8s.io/UDPRoute": ["gateway.networking.k8s.io/v1alpha2"],
  "cert-manager.io/*": ["cert-manager.io/v1"],
  "external-secrets.io/*": ["external-secrets.io/v1", "external-secrets.io/v1beta1"],
  "monitoring.coreos.com/*": ["monitoring.coreos.com/v1"],
  "keda.sh/*": ["keda.sh/v1alpha1"],
  "argoproj.io/Rollout": ["argoproj.io/v1alpha1"],
  "networking.istio.io/*": ["networking.istio.io/v1", "networking.istio.io/v1beta1"],
  "autoscaling.k8s.io/*": ["autoscaling.k8s.io/v1"],
  // built-ins: use the kinds/versions Lens declares in @k8slens/kubernetes-contracts
};

/** Where each pod-spec holder keeps its pod spec. "$podSpec" in a path expands to these. */
export const POD_SPEC_LOCATIONS: ReadonlyArray<readonly [GroupKind, Path]> = [
  [K.Pod, "spec"],
  [K.Deployment, "spec.template.spec"],
  [K.ReplicaSet, "spec.template.spec"],
  [K.StatefulSet, "spec.template.spec"],
  [K.DaemonSet, "spec.template.spec"],
  [K.Job, "spec.template.spec"],
  [K.ReplicationController, "spec.template.spec"],
  [K.CronJob, "spec.jobTemplate.spec.template.spec"],
  [K.Rollout, "spec.template.spec"],
];

const POD_SPEC_HOLDERS = POD_SPEC_LOCATIONS.map(([kind]) => kind);

/** Containers of every type; each one is iterated. */
const C = ["$podSpec.containers[*]", "$podSpec.initContainers[*]", "$podSpec.ephemeralContainers[*]"];
const inContainers = (suffix: string) => C.map((c) => `${c}.${suffix}`);

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export const RULES: readonly Rule[] = [
  // --- ownership (all ownerReferences, not just the first) -----------------------------------
  // Covers ReplicaSet->Deployment, Pod->ReplicaSet/StatefulSet/DaemonSet/Job, Job->CronJob,
  // ControllerRevision->StatefulSet/DaemonSet, and any CRD controller that sets ownerReferences.
  // (The original also declared DaemonSet/StatefulSet -> ReplicaSet, which never exist.)
  { id: "owner-references", holders: [{ group: "*", kind: "*" }], match: { type: "ownerReferences" }, edge: "ownedBy", membership: "both" },

  // --- pod spec: config and secrets (apply to pods AND templates) ------------------------------
  { id: "podspec.volume.configmap", holders: POD_SPEC_HOLDERS, edge: "mounts", membership: "forward",
    match: { type: "name", paths: ["$podSpec.volumes[*].configMap.name"], target: K.ConfigMap, namespace: "same" } },
  { id: "podspec.volume.secret", holders: POD_SPEC_HOLDERS, edge: "mounts", membership: "forward", // MISSING in original
    match: { type: "name", paths: ["$podSpec.volumes[*].secret.secretName"], target: K.Secret, namespace: "same" } },
  { id: "podspec.volume.projected.configmap", holders: POD_SPEC_HOLDERS, edge: "mounts", membership: "forward",
    match: { type: "name", paths: ["$podSpec.volumes[*].projected.sources[*].configMap.name"], target: K.ConfigMap, namespace: "same" } },
  { id: "podspec.volume.projected.secret", holders: POD_SPEC_HOLDERS, edge: "mounts", membership: "forward",
    match: { type: "name", paths: ["$podSpec.volumes[*].projected.sources[*].secret.name"], target: K.Secret, namespace: "same" } },
  { id: "podspec.volume.csi.secret", holders: POD_SPEC_HOLDERS, edge: "mounts", membership: "forward", // MISSING in original
    match: { type: "name", paths: ["$podSpec.volumes[*].csi.nodePublishSecretRef.name"], target: K.Secret, namespace: "same" } },
  { id: "podspec.volume.pvc", holders: POD_SPEC_HOLDERS, edge: "mounts", membership: "forward",
    match: { type: "name", paths: ["$podSpec.volumes[*].persistentVolumeClaim.claimName"], target: K.PersistentVolumeClaim, namespace: "same" } },
  // Generic ephemeral volumes create a PVC named "<pod>-<volume>": needs code.  MISSING in original
  { id: "pod.volume.ephemeral-pvc", holders: [K.Pod], edge: "mounts", membership: "forward",
    match: { type: "custom", extractorId: "ephemeral-volume-pvc-names" } },
  { id: "podspec.env.configmap", holders: POD_SPEC_HOLDERS, edge: "readsEnvFrom", membership: "forward",
    match: { type: "name", paths: inContainers("env[*].valueFrom.configMapKeyRef.name"), target: K.ConfigMap, namespace: "same" } },
  { id: "podspec.env.secret", holders: POD_SPEC_HOLDERS, edge: "readsEnvFrom", membership: "forward",
    match: { type: "name", paths: inContainers("env[*].valueFrom.secretKeyRef.name"), target: K.Secret, namespace: "same" } },
  { id: "podspec.envfrom.configmap", holders: POD_SPEC_HOLDERS, edge: "readsEnvFrom", membership: "forward", // MISSING in original
    match: { type: "name", paths: inContainers("envFrom[*].configMapRef.name"), target: K.ConfigMap, namespace: "same" } },
  { id: "podspec.envfrom.secret", holders: POD_SPEC_HOLDERS, edge: "readsEnvFrom", membership: "forward", // MISSING in original
    match: { type: "name", paths: inContainers("envFrom[*].secretRef.name"), target: K.Secret, namespace: "same" } },
  { id: "podspec.image-pull-secret", holders: POD_SPEC_HOLDERS, edge: "pullsWith", membership: "forward", // MISSING in original
    match: { type: "name", paths: ["$podSpec.imagePullSecrets[*].name"], target: K.Secret, namespace: "same" } },
  { id: "podspec.service-account", holders: POD_SPEC_HOLDERS, edge: "runsAs", membership: "forward",
    match: { type: "name", paths: ["$podSpec.serviceAccountName"], target: K.ServiceAccount, namespace: "same", defaultName: "default" } },

  // --- pod spec: scheduling context (drawn, never members) ------------------------------------
  { id: "pod.node", holders: [K.Pod], edge: "scheduledOn", membership: "none", hiddenByDefault: true, // MISSING in original
    match: { type: "name", paths: ["spec.nodeName"], target: K.Node, namespace: "cluster" } },
  { id: "podspec.priority-class", holders: POD_SPEC_HOLDERS, edge: "usesClass", membership: "none", hiddenByDefault: true,
    match: { type: "name", paths: ["$podSpec.priorityClassName"], target: K.PriorityClass, namespace: "cluster" } },
  { id: "podspec.runtime-class", holders: POD_SPEC_HOLDERS, edge: "usesClass", membership: "none", hiddenByDefault: true,
    match: { type: "name", paths: ["$podSpec.runtimeClassName"], target: K.RuntimeClass, namespace: "cluster" } },

  // --- workload extras ------------------------------------------------------------------------
  { id: "statefulset.governing-service", holders: [K.StatefulSet], edge: "governedBy", membership: "forward", // MISSING in original
    match: { type: "name", paths: ["spec.serviceName"], target: K.Service, namespace: "same" } },

  // --- selection (proper selector semantics; no name-in-values fallback) ----------------------
  // Service: a missing or empty selector selects nothing (manually managed endpoints).
  { id: "service.selector", holders: [K.Service], edge: "selects", membership: "backward",
    match: { type: "selector", path: "spec.selector", form: "map", empty: "none", target: K.Pod } },
  { id: "pdb.selector", holders: [K.PodDisruptionBudget], edge: "selects", membership: "backward", // MISSING in original
    match: { type: "selector", path: "spec.selector", form: "labelSelector", empty: "all", target: K.Pod } },
  // NetworkPolicy: {} = every pod in the namespace (default-deny). The original never matched it.
  { id: "networkpolicy.pod-selector", holders: [K.NetworkPolicy], edge: "selects", membership: "none",
    match: { type: "selector", path: "spec.podSelector", form: "labelSelector", empty: "all", target: K.Pod } },

  // --- service discovery (hidden by default: noisy) -------------------------------------------
  // EndpointSlice replaces Endpoints (Endpoints API deprecated since k8s 1.33). MISSING in original.
  { id: "endpointslice.service", holders: [K.EndpointSlice], edge: "endpointOf", membership: "none", hiddenByDefault: true,
    match: { type: "labelValue", label: "kubernetes.io/service-name", target: K.Service } },
  { id: "endpointslice.pods", holders: [K.EndpointSlice], edge: "endpointOf", membership: "none", hiddenByDefault: true,
    match: { type: "objectRef", paths: ["endpoints[*].targetRef"], defaults: { group: "", kind: "Pod", namespace: "same" }, allowedTargets: [K.Pod] } },

  // --- ingress --------------------------------------------------------------------------------
  { id: "ingress.backend.service", holders: [K.Ingress], edge: "routesTo", membership: "backward",
    match: { type: "name", target: K.Service, namespace: "same", paths: [
      "spec.rules[*].http.paths[*].backend.service.name",
      "spec.defaultBackend.service.name", // MISSING in original
    ] } },
  { id: "ingress.backend.resource", holders: [K.Ingress], edge: "routesTo", membership: "backward", // MISSING in original
    match: { type: "objectRef", defaults: { namespace: "same" }, paths: [
      "spec.rules[*].http.paths[*].backend.resource",
      "spec.defaultBackend.resource",
    ] } },
  { id: "ingress.tls-secret", holders: [K.Ingress], edge: "usesTls", membership: "forward",
    match: { type: "name", paths: ["spec.tls[*].secretName"], target: K.Secret, namespace: "same" } },
  { id: "ingress.class", holders: [K.Ingress], edge: "usesClass", membership: "none", hiddenByDefault: true, // MISSING in original
    match: { type: "name", paths: ["spec.ingressClassName"], target: K.IngressClass, namespace: "cluster" } },

  // --- gateway api (all MISSING in original) --------------------------------------------------
  { id: "route.parent-gateway", holders: [K.HTTPRoute, K.GRPCRoute, K.TLSRoute, K.TCPRoute, K.UDPRoute], edge: "attachesTo", membership: "none", requiresServed: true,
    match: { type: "objectRef", paths: ["spec.parentRefs[*]"], defaults: { group: "gateway.networking.k8s.io", kind: "Gateway", namespace: "same" }, allowedTargets: [K.Gateway] } },
  { id: "route.backend-service", holders: [K.HTTPRoute, K.GRPCRoute, K.TLSRoute, K.TCPRoute, K.UDPRoute], edge: "routesTo", membership: "backward", requiresServed: true,
    // Cross-namespace backendRefs are only allowed with a ReferenceGrant: draw them, flag them if ungranted.
    match: { type: "objectRef", paths: ["spec.rules[*].backendRefs[*]"], defaults: { group: "", kind: "Service", namespace: "same" } } },
  { id: "gateway.class", holders: [K.Gateway], edge: "usesClass", membership: "none", hiddenByDefault: true, requiresServed: true,
    match: { type: "name", paths: ["spec.gatewayClassName"], target: K.GatewayClass, namespace: "cluster" } },
  { id: "gateway.tls-secret", holders: [K.Gateway], edge: "usesTls", membership: "none", requiresServed: true,
    match: { type: "objectRef", paths: ["spec.listeners[*].tls.certificateRefs[*]"], defaults: { group: "", kind: "Secret", namespace: "same" }, allowedTargets: [K.Secret] } },

  // --- autoscaling / disruption ---------------------------------------------------------------
  // objectRef, so it works for any scalable target, including CRDs (Argo Rollout).
  // (The original also allowed HPA -> DaemonSet, which cannot be scaled.)
  { id: "hpa.scale-target", holders: [K.HorizontalPodAutoscaler], edge: "scales", membership: "backward",
    match: { type: "objectRef", paths: ["spec.scaleTargetRef"], defaults: { namespace: "same" } } },
  { id: "vpa.target", holders: [K.VerticalPodAutoscaler], edge: "scales", membership: "backward", requiresServed: true,
    match: { type: "objectRef", paths: ["spec.targetRef"], defaults: { namespace: "same" } } },
  { id: "keda.scale-target", holders: [K.ScaledObject], edge: "scales", membership: "backward", requiresServed: true,
    match: { type: "objectRef", paths: ["spec.scaleTargetRef"], defaults: { group: "apps", kind: "Deployment", namespace: "same" } } },

  // --- storage --------------------------------------------------------------------------------
  // PV, StorageClass, ClusterRole(Binding) are cluster-scoped. In the original these edges were
  // silently dead in production (buildGvrCache never loaded cluster-scoped kinds).
  { id: "pvc.volume", holders: [K.PersistentVolumeClaim], edge: "boundTo", membership: "forward",
    match: { type: "name", paths: ["spec.volumeName"], target: K.PersistentVolume, namespace: "cluster" } },
  { id: "pvc.storage-class", holders: [K.PersistentVolumeClaim, K.PersistentVolume], edge: "usesClass", membership: "none", hiddenByDefault: true,
    match: { type: "name", paths: ["spec.storageClassName"], target: K.StorageClass, namespace: "cluster" } },

  // --- rbac (each subject separately; RoleBinding may reference a ClusterRole) -----------------
  { id: "binding.subject-serviceaccount", holders: [K.RoleBinding, K.ClusterRoleBinding], edge: "bindsSubject", membership: "backward",
    // subjects of kind User/Group produce no edge. Namespace defaults to the binding's for RoleBindings.
    match: { type: "objectRef", paths: ["subjects[*]"], defaults: { group: "", namespace: "same" }, allowedTargets: [K.ServiceAccount] } },
  { id: "binding.role-ref", holders: [K.RoleBinding, K.ClusterRoleBinding], edge: "grants", membership: "forward",
    // MISSING in original: RoleBinding -> ClusterRole (very common).
    match: { type: "objectRef", paths: ["roleRef"], defaults: { group: "rbac.authorization.k8s.io", namespace: "same" }, allowedTargets: [K.Role, K.ClusterRole] } },
  { id: "serviceaccount.secrets", holders: [K.ServiceAccount], edge: "mounts", membership: "forward",
    // Legacy token secrets (pre-1.24 clusters). Each entry separately.
    match: { type: "name", paths: ["secrets[*].name"], target: K.Secret, namespace: "same" } },
  { id: "serviceaccount.image-pull-secrets", holders: [K.ServiceAccount], edge: "pullsWith", membership: "forward", // MISSING in original
    match: { type: "name", paths: ["imagePullSecrets[*].name"], target: K.Secret, namespace: "same" } },
  { id: "secret.service-account-token", holders: [K.Secret], edge: "ownedBy", membership: "backward", // MISSING in original
    match: { type: "annotationValue", annotation: "kubernetes.io/service-account.name", target: K.ServiceAccount, namespace: "same" } },

  // --- ecosystem CRDs (only when served) ------------------------------------------------------
  { id: "certmanager.certificate.secret", holders: [K.Certificate], edge: "issues", membership: "backward", requiresServed: true,
    match: { type: "name", paths: ["spec.secretName"], target: K.Secret, namespace: "same" } },
  { id: "certmanager.certificate.issuer", holders: [K.Certificate], edge: "issuedBy", membership: "none", requiresServed: true,
    match: { type: "objectRef", paths: ["spec.issuerRef"], defaults: { group: "cert-manager.io", kind: "Issuer", namespace: "same" }, allowedTargets: [K.Issuer, K.ClusterIssuer] } },
  { id: "certmanager.ingress-shim", holders: [K.Ingress], edge: "issuedBy", membership: "none", requiresServed: true,
    match: { type: "annotationValue", annotation: "cert-manager.io/cluster-issuer", target: K.ClusterIssuer, namespace: "cluster" } },
  { id: "externalsecret.target", holders: [K.ExternalSecret], edge: "syncsTo", membership: "backward", requiresServed: true,
    // target.name defaults to the ExternalSecret's own name: the extractor needs that default.
    match: { type: "custom", extractorId: "external-secret-target-name" } },
  { id: "externalsecret.store", holders: [K.ExternalSecret], edge: "readsFrom", membership: "none", requiresServed: true,
    match: { type: "objectRef", paths: ["spec.secretStoreRef"], defaults: { group: "external-secrets.io", kind: "SecretStore", namespace: "same" }, allowedTargets: [K.SecretStore, K.ClusterSecretStore] } },
  { id: "servicemonitor.selector", holders: [K.ServiceMonitor], edge: "selects", membership: "backward", requiresServed: true,
    // NOTE: spec.namespaceSelector can widen this beyond the holder's namespace.
    match: { type: "selector", path: "spec.selector", form: "labelSelector", empty: "all", target: K.Service } },
  { id: "podmonitor.selector", holders: [K.PodMonitor], edge: "selects", membership: "backward", requiresServed: true,
    match: { type: "selector", path: "spec.selector", form: "labelSelector", empty: "all", target: K.Pod } },
  { id: "rollout.workload-ref", holders: [K.Rollout], edge: "ownedBy", membership: "both", requiresServed: true,
    match: { type: "objectRef", paths: ["spec.workloadRef"], defaults: { group: "apps", kind: "Deployment", namespace: "same" } } },
  { id: "istio.virtualservice.gateways", holders: [K.VirtualService], edge: "attachesTo", membership: "none", requiresServed: true,
    // "ns/name", or "name" in the VirtualService's namespace; "mesh" means sidecars, not a gateway.
    match: { type: "custom", extractorId: "istio-virtualservice-gateways" } },
  { id: "istio.virtualservice.destination", holders: [K.VirtualService], edge: "routesTo", membership: "backward", requiresServed: true,
    // hosts may be short names, "svc.ns", or FQDNs "svc.ns.svc.cluster.local": needs code.
    match: { type: "custom", extractorId: "istio-destination-hosts" } },

  // --- inferred traffic: a Service's DNS name in a workload's env, args or config ---------------
  // Only ever resolved edges: a hostname that names no Service is not a broken reference.
  { id: "podspec.calls-service", holders: POD_SPEC_HOLDERS, edge: "calls", membership: "none", dropUnresolved: true,
    match: { type: "custom", extractorId: "service-hosts-in-pod-spec" } },
  { id: "configmap.calls-service", holders: [K.ConfigMap], edge: "calls", membership: "none", dropUnresolved: true,
    match: { type: "custom", extractorId: "service-hosts-in-config" } },
];

// ---------------------------------------------------------------------------------------------
// Hubs: resources that many apps share. Drawn as context, never members, never expanded.
// A node is also a hub when more than one app claims it (the "shared" rule in HANDOFF.md).
// Every pod gets kube-root-ca.crt through a projected volume, and most run as "default":
// without this list every app would absorb them (the original did).
// ---------------------------------------------------------------------------------------------

export const HUBS: ReadonlyArray<{ readonly kind: GroupKind; readonly name?: string }> = [
  { kind: K.ConfigMap, name: "kube-root-ca.crt" },
  { kind: K.ServiceAccount, name: "default" },
  { kind: K.Node },
  { kind: K.StorageClass },
  { kind: K.PriorityClass },
  { kind: K.RuntimeClass },
  { kind: K.IngressClass },
  { kind: K.GatewayClass },
  { kind: K.ClusterRole },
  { kind: K.ClusterIssuer },
  { kind: K.ClusterSecretStore },
];

/**
 * Cluster-scoped kinds: an objectRef to one of these ignores any namespace, and a subscription
 * to one is never narrowed by namespace. (The original listed only namespaced resources, so
 * none of these ever resolved in production.) Extend from API discovery when a CRD is added.
 */
export const CLUSTER_SCOPED: readonly GroupKind[] = [
  gk("", "Namespace"),
  K.Node,
  K.PersistentVolume,
  K.StorageClass,
  K.PriorityClass,
  K.RuntimeClass,
  K.IngressClass,
  K.GatewayClass,
  K.ClusterRole,
  K.ClusterRoleBinding,
  K.ClusterIssuer,
  K.ClusterSecretStore,
];

// ---------------------------------------------------------------------------------------------
// App identity. Evaluated in order; first hit wins. Resources without any of these inherit the
// app of the members they are connected to through membership edges.
// (The original: app == one workload, named after it. Keep that only as the last fallback.)
// ---------------------------------------------------------------------------------------------

export type AppIdentitySource =
  | { readonly source: "annotation" | "label"; readonly keys: readonly [name: string, namespace?: string]; readonly label: string }
  /** Helm's own release records: Secrets of type helm.sh/release.v1 labelled owner=helm, name=<release>. */
  | { readonly source: "helmReleaseSecret"; readonly label: string }
  | { readonly source: "rootOwner"; readonly label: string };

export const APP_IDENTITY: readonly AppIdentitySource[] = [
  { source: "annotation", keys: ["meta.helm.sh/release-name", "meta.helm.sh/release-namespace"], label: "Helm release" },
  { source: "helmReleaseSecret", label: "Helm release" },
  { source: "label", keys: ["app.kubernetes.io/instance"], label: "Instance" }, // Helm and Argo CD default tracking
  { source: "annotation", keys: ["argocd.argoproj.io/tracking-id"], label: "Argo CD application" },
  { source: "label", keys: ["kustomize.toolkit.fluxcd.io/name", "kustomize.toolkit.fluxcd.io/namespace"], label: "Flux Kustomization" },
  { source: "label", keys: ["helm.toolkit.fluxcd.io/name", "helm.toolkit.fluxcd.io/namespace"], label: "Flux HelmRelease" },
  { source: "rootOwner", label: "Workload" }, // top of the ownerReferences chain: Deployment, StatefulSet, DaemonSet, CronJob, bare Pod, ...
];

/**
 * Kinds that anchor an app when nothing else names one: the top of an ownerReferences chain
 * counts as an app only when it is one of these, or a kind the graph does not track (an
 * operator's custom resource). A Service or ConfigMap without owners joins apps through edges.
 */
export const ROOT_OWNER_KINDS: readonly GroupKind[] = [
  K.Deployment,
  K.StatefulSet,
  K.DaemonSet,
  K.CronJob,
  K.Job,
  K.Pod,
  K.ReplicaSet,
  K.ReplicationController,
  K.Rollout,
];

/** Optional super-group shown around several apps. */
export const APP_SUPER_GROUP = { source: "label", key: "app.kubernetes.io/part-of" } as const;
