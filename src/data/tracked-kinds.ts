import {
  admissionregistrationV1,
  appsV1,
  autoscalingV1,
  autoscalingV2,
  batchV1,
  clusterRoleBindingKind,
  clusterRoleKind,
  configMapKind,
  coreV1,
  cronJobKind,
  daemonSetKind,
  deploymentKind,
  discoveryV1,
  endpointSliceKind,
  getKubeResourceKind,
  getKubernetesApiVersion,
  horizontalPodAutoscalerKind,
  ingressClassKind,
  ingressKind,
  jobKind,
  type KubeResourceKind,
  mutatingWebhookConfigurationKind,
  type KubernetesApiVersion,
  namespaceKind,
  networkingV1,
  networkPolicyKind,
  nodeKind,
  nodeV1,
  persistentVolumeClaimKind,
  persistentVolumeKind,
  podDisruptionBudgetKind,
  podKind,
  policyV1,
  priorityClassKind,
  rbacAuthorizationV1,
  replicaSetKind,
  replicationControllerKind,
  roleBindingKind,
  roleKind,
  runtimeClassKind,
  schedulingV1,
  secretKind,
  serviceAccountKind,
  serviceKind,
  statefulSetKind,
  storageClassKind,
  storageV1,
  validatingWebhookConfigurationKind,
} from "@k8slens/kubernetes-contracts";
import { type GroupKind, K } from "../graph/rules";

/**
 * Every kind the graph lists and watches, with the API versions to try, preferred first.
 * Built-in kinds are the ones Lens declares; custom resources are declared here, loosely typed,
 * and only watched once the cluster says it serves them.
 */
export interface TrackedKind {
  readonly gk: GroupKind;
  readonly kind: KubeResourceKind;
  readonly versions: readonly KubernetesApiVersion[];
  /** A custom resource: asked about first, and silently left out when not served. */
  readonly custom?: boolean;
  /** Nodes, classes, EndpointSlices: loaded only while the user shows infrastructure. */
  readonly infra?: boolean;
}

/** What a custom resource looks like to the graph: anything, read defensively. */
type Loose = { metadata: { name: string; namespace?: string }; spec?: unknown; status?: unknown };

/** A kind the graph learns of only from the cluster: an operator's resource, followed from an ownerReference. */
export const customKind = (group: string, kindName: string, versions: readonly string[], rest: Partial<TrackedKind> = {}): TrackedKind => ({
  gk: { group, kind: kindName },
  kind: getKubeResourceKind<Record<string, Loose>>(kindName),
  versions: versions.map((version) => getKubernetesApiVersion(`${group}/${version}`)),
  custom: true,
  ...rest,
});

const builtIn = (gk: GroupKind, kind: KubeResourceKind, versions: readonly KubernetesApiVersion[], rest: Partial<TrackedKind> = {}): TrackedKind => ({
  gk,
  kind,
  versions,
  ...rest,
});

const GATEWAY = "gateway.networking.k8s.io";

export const TRACKED_KINDS: readonly TrackedKind[] = [
  builtIn({ group: "", kind: "Namespace" }, namespaceKind, [coreV1]),
  builtIn(K.Pod, podKind, [coreV1]),
  builtIn(K.Service, serviceKind, [coreV1]),
  builtIn(K.ConfigMap, configMapKind, [coreV1]),
  builtIn(K.Secret, secretKind, [coreV1]),
  builtIn(K.ServiceAccount, serviceAccountKind, [coreV1]),
  builtIn(K.PersistentVolumeClaim, persistentVolumeClaimKind, [coreV1]),
  builtIn(K.PersistentVolume, persistentVolumeKind, [coreV1]),
  builtIn(K.ReplicationController, replicationControllerKind, [coreV1]),
  builtIn(K.Deployment, deploymentKind, [appsV1]),
  builtIn(K.ReplicaSet, replicaSetKind, [appsV1]),
  builtIn(K.StatefulSet, statefulSetKind, [appsV1]),
  builtIn(K.DaemonSet, daemonSetKind, [appsV1]),
  builtIn(K.Job, jobKind, [batchV1]),
  builtIn(K.CronJob, cronJobKind, [batchV1]),
  builtIn(K.Ingress, ingressKind, [networkingV1]),
  builtIn(K.NetworkPolicy, networkPolicyKind, [networkingV1]),
  builtIn(K.PodDisruptionBudget, podDisruptionBudgetKind, [policyV1]),
  builtIn(K.HorizontalPodAutoscaler, horizontalPodAutoscalerKind, [autoscalingV2, autoscalingV1]),
  builtIn(K.Role, roleKind, [rbacAuthorizationV1]),
  builtIn(K.RoleBinding, roleBindingKind, [rbacAuthorizationV1]),
  builtIn(K.ClusterRole, clusterRoleKind, [rbacAuthorizationV1]),
  builtIn(K.ClusterRoleBinding, clusterRoleBindingKind, [rbacAuthorizationV1]),
  // Who answers the API server: a webhook or aggregated API whose Service is gone breaks the cluster.
  builtIn(K.ValidatingWebhookConfiguration, validatingWebhookConfigurationKind, [admissionregistrationV1]),
  builtIn(K.MutatingWebhookConfiguration, mutatingWebhookConfigurationKind, [admissionregistrationV1]),

  builtIn(K.Node, nodeKind, [coreV1], { infra: true }),
  builtIn(K.EndpointSlice, endpointSliceKind, [discoveryV1], { infra: true }),
  builtIn(K.IngressClass, ingressClassKind, [networkingV1], { infra: true }),
  builtIn(K.StorageClass, storageClassKind, [storageV1], { infra: true }),
  builtIn(K.PriorityClass, priorityClassKind, [schedulingV1], { infra: true }),
  builtIn(K.RuntimeClass, runtimeClassKind, [nodeV1], { infra: true }),

  customKind(GATEWAY, "Gateway", ["v1", "v1beta1"]),
  customKind(GATEWAY, "HTTPRoute", ["v1", "v1beta1"]),
  customKind(GATEWAY, "GRPCRoute", ["v1", "v1alpha2"]),
  customKind(GATEWAY, "TLSRoute", ["v1alpha2"]),
  customKind(GATEWAY, "TCPRoute", ["v1alpha2"]),
  customKind(GATEWAY, "UDPRoute", ["v1alpha2"]),
  customKind(GATEWAY, "GatewayClass", ["v1", "v1beta1"], { infra: true }),
  customKind("cert-manager.io", "Certificate", ["v1"]),
  customKind("cert-manager.io", "Issuer", ["v1"]),
  customKind("cert-manager.io", "ClusterIssuer", ["v1"]),
  customKind("external-secrets.io", "ExternalSecret", ["v1", "v1beta1"]),
  customKind("external-secrets.io", "SecretStore", ["v1", "v1beta1"]),
  customKind("external-secrets.io", "ClusterSecretStore", ["v1", "v1beta1"]),
  customKind("monitoring.coreos.com", "ServiceMonitor", ["v1"]),
  customKind("monitoring.coreos.com", "PodMonitor", ["v1"]),
  customKind("keda.sh", "ScaledObject", ["v1alpha1"]),
  customKind("argoproj.io", "Rollout", ["v1alpha1"]),
  customKind("networking.istio.io", "VirtualService", ["v1", "v1beta1"]),
  customKind("networking.istio.io", "Gateway", ["v1", "v1beta1"]),
  customKind("autoscaling.k8s.io", "VerticalPodAutoscaler", ["v1"]),
  customKind("networking.istio.io", "DestinationRule", ["v1", "v1beta1"]),
  customKind("networking.istio.io", "ServiceEntry", ["v1", "v1beta1"]),
  customKind("argoproj.io", "Application", ["v1alpha1"]),
  customKind("kustomize.toolkit.fluxcd.io", "Kustomization", ["v1", "v1beta2"]),
  customKind("helm.toolkit.fluxcd.io", "HelmRelease", ["v2", "v2beta2", "v2beta1"]),
  customKind("source.toolkit.fluxcd.io", "GitRepository", ["v1", "v1beta2"]),
  customKind("source.toolkit.fluxcd.io", "OCIRepository", ["v1", "v1beta2"]),
  customKind("source.toolkit.fluxcd.io", "HelmRepository", ["v1", "v1beta2"]),
  customKind("apiregistration.k8s.io", "APIService", ["v1"]),
  customKind("resource.k8s.io", "ResourceClaim", ["v1", "v1beta2", "v1beta1"]),
  customKind("resource.k8s.io", "ResourceClaimTemplate", ["v1", "v1beta2", "v1beta1"]),
  customKind("resource.k8s.io", "DeviceClass", ["v1", "v1beta2", "v1beta1"], { infra: true }),
];

/** The kinds Lens can show a details panel for, by group and kind, with the version to ask in. */
export const trackedKindOf = (gk: GroupKind) =>
  TRACKED_KINDS.find((tracked) => tracked.gk.group === gk.group && tracked.gk.kind === gk.kind);
