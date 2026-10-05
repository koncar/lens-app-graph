import { asArray, asNumber, asString, field, isRecord, type Json, type KubeObject } from "./types";

/**
 * - ok: running as intended
 * - warn: degraded or in progress (pending, not all replicas ready, terminating)
 * - error: broken (crash looping, failed, a reference that does not resolve)
 * - idle: intentionally doing nothing (scaled to zero, completed, suspended)
 * - neutral: has no health of its own (ConfigMap, Secret, RBAC)
 * - unknown: cannot be told (the kind is not listable)
 */
export type Health = "ok" | "warn" | "error" | "idle" | "neutral" | "unknown";

export interface HealthReport {
  readonly health: Health;
  /** A few words for the user: "2/3 ready", "CrashLoopBackOff", "Bound". */
  readonly summary?: string;
}

export const HEALTH_SEVERITY: Readonly<Record<Health, number>> = {
  error: 5,
  warn: 4,
  unknown: 3,
  ok: 2,
  idle: 1,
  neutral: 0,
};

export const worstHealth = (healths: Iterable<Health>): Health => {
  let worst: Health = "neutral";

  for (const health of healths) {
    if (HEALTH_SEVERITY[health] > HEALTH_SEVERITY[worst]) {
      worst = health;
    }
  }

  return worst;
};

const conditions = (object: Json) => asArray(field(object, "status", "conditions"));

const condition = (object: Json, type: string) =>
  conditions(object).find((entry) => isRecord(entry) && entry.type === type) as Record<string, Json> | undefined;

const ERROR_WAITING_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "ErrImageNeverPull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "PreCreateHookError",
  "PostStartHookError",
]);

const podHealth = (pod: KubeObject): HealthReport => {
  const phase = asString(field(pod, "status", "phase"));
  const statuses = [
    ...asArray(field(pod, "status", "initContainerStatuses")),
    ...asArray(field(pod, "status", "containerStatuses")),
  ];
  const containers = asArray(field(pod, "status", "containerStatuses"));
  const restarts = containers.reduce<number>((sum, status) => sum + (asNumber(field(status, "restartCount")) ?? 0), 0);
  const withRestarts = (summary: string) => (restarts > 0 ? `${summary}, ${restarts} restart${restarts === 1 ? "" : "s"}` : summary);

  if (pod.metadata.deletionTimestamp) {
    return { health: "warn", summary: "Terminating" };
  }

  if (phase === "Succeeded") {
    return { health: "idle", summary: "Completed" };
  }

  if (phase === "Failed") {
    return { health: "error", summary: asString(field(pod, "status", "reason")) ?? "Failed" };
  }

  for (const status of statuses) {
    const waiting = asString(field(status, "state", "waiting", "reason"));

    if (waiting && ERROR_WAITING_REASONS.has(waiting)) {
      return { health: "error", summary: withRestarts(waiting) };
    }

    const terminated = field(status, "state", "terminated");
    const exitCode = asNumber(field(terminated, "exitCode"));

    if (exitCode !== undefined && exitCode !== 0 && field(status, "ready") !== true) {
      return { health: "error", summary: withRestarts(asString(field(terminated, "reason")) ?? `Exited ${exitCode}`) };
    }
  }

  if (phase === "Pending") {
    const scheduled = condition(pod, "PodScheduled");

    if (scheduled?.status === "False") {
      return { health: scheduled.reason === "Unschedulable" ? "error" : "warn", summary: asString(scheduled.reason) ?? "Unschedulable" };
    }

    const waiting = statuses.map((status) => asString(field(status, "state", "waiting", "reason"))).find(Boolean);

    return { health: "warn", summary: waiting ?? "Pending" };
  }

  const ready = containers.filter((status) => field(status, "ready") === true).length;

  if (containers.length > 0 && ready < containers.length) {
    return { health: "warn", summary: withRestarts(`${ready}/${containers.length} ready`) };
  }

  return { health: "ok", summary: withRestarts(phase ?? "Running") };
};

const replicasHealth = (desired: number, ready: number, word = "ready"): HealthReport => {
  if (desired === 0) {
    return { health: "idle", summary: "Scaled to zero" };
  }

  const summary = `${ready}/${desired} ${word}`;

  if (ready >= desired) {
    return { health: "ok", summary };
  }

  return { health: ready === 0 ? "error" : "warn", summary };
};

const deploymentHealth = (deployment: KubeObject): HealthReport => {
  const progressing = condition(deployment, "Progressing");

  if (progressing?.reason === "ProgressDeadlineExceeded") {
    return { health: "error", summary: "Progress deadline exceeded" };
  }

  return replicasHealth(
    asNumber(field(deployment, "spec", "replicas")) ?? 1,
    asNumber(field(deployment, "status", "availableReplicas")) ?? 0,
    "available",
  );
};

const jobHealth = (job: KubeObject): HealthReport => {
  if (condition(job, "Failed")?.status === "True") {
    return { health: "error", summary: asString(condition(job, "Failed")?.reason) ?? "Failed" };
  }

  if (condition(job, "Complete")?.status === "True") {
    return { health: "idle", summary: "Complete" };
  }

  if (field(job, "spec", "suspend") === true) {
    return { health: "idle", summary: "Suspended" };
  }

  const active = asNumber(field(job, "status", "active")) ?? 0;

  return { health: "ok", summary: active > 0 ? `${active} running` : "Waiting" };
};

const phaseHealth = (object: KubeObject, table: Readonly<Record<string, Health>>): HealthReport => {
  const phase = asString(field(object, "status", "phase"));

  return phase ? { health: table[phase] ?? "warn", summary: phase } : { health: "warn", summary: "No phase yet" };
};

const readyConditionHealth = (object: KubeObject): HealthReport | undefined => {
  const ready = condition(object, "Ready");

  if (!ready) {
    return undefined;
  }

  if (ready.status === "True") {
    return { health: "ok", summary: "Ready" };
  }

  return { health: ready.status === "False" ? "error" : "warn", summary: asString(ready.reason) ?? "Not ready" };
};

/** Argo CD's own verdict: health, and whether the cluster matches git. */
const ARGO_HEALTH: Readonly<Record<string, Health>> = {
  Healthy: "ok",
  Progressing: "warn",
  Suspended: "idle",
  Degraded: "error",
  Missing: "error",
};

const argoCdApplicationHealth = (application: KubeObject): HealthReport => {
  const health = asString(field(application, "status", "health", "status"));
  const sync = asString(field(application, "status", "sync", "status"));
  const verdict: Health = (health ? ARGO_HEALTH[health] : undefined) ?? "unknown";
  const summary = [sync, health].filter(Boolean).join(" · ") || undefined;

  // Healthy but out of sync with git is what Argo CD shows in yellow.
  return { health: verdict === "ok" && sync === "OutOfSync" ? "warn" : verdict, summary };
};

/** Health from the object alone. Relationship-based health (a Service with no pods) is added by the graph. */
export const healthOf = (object: KubeObject): HealthReport => {
  switch (object.kind) {
    case "Pod":
      return podHealth(object);
    case "Deployment":
      return deploymentHealth(object);
    case "StatefulSet":
      return replicasHealth(asNumber(field(object, "spec", "replicas")) ?? 1, asNumber(field(object, "status", "readyReplicas")) ?? 0);
    case "ReplicaSet":
    case "ReplicationController":
      return replicasHealth(asNumber(field(object, "spec", "replicas")) ?? 1, asNumber(field(object, "status", "readyReplicas")) ?? 0);
    case "DaemonSet":
      return replicasHealth(
        asNumber(field(object, "status", "desiredNumberScheduled")) ?? 0,
        asNumber(field(object, "status", "numberReady")) ?? 0,
      );
    case "Job":
      return jobHealth(object);
    case "CronJob":
      return field(object, "spec", "suspend") === true
        ? { health: "idle", summary: "Suspended" }
        : { health: "ok", summary: asString(field(object, "spec", "schedule")) };
    case "PersistentVolumeClaim":
      return phaseHealth(object, { Bound: "ok", Pending: "warn", Lost: "error" });
    case "PersistentVolume":
      return phaseHealth(object, { Bound: "ok", Available: "ok", Released: "warn", Pending: "warn", Failed: "error" });
    case "HorizontalPodAutoscaler": {
      const failing = conditions(object).find(
        (entry) => isRecord(entry) && (entry.type === "AbleToScale" || entry.type === "ScalingActive") && entry.status === "False",
      );
      const current = asNumber(field(object, "status", "currentReplicas"));
      const max = asNumber(field(object, "spec", "maxReplicas"));

      return failing
        ? { health: "warn", summary: asString(field(failing, "reason")) ?? "Not scaling" }
        : { health: "ok", summary: current !== undefined && max !== undefined ? `${current} of max ${max}` : undefined };
    }
    case "Namespace":
      return { health: "neutral", summary: asString(field(object, "status", "phase")) };
    case "Service":
      return { health: "ok", summary: asString(field(object, "spec", "type")) };
    case "Application":
      return argoCdApplicationHealth(object);
    case "Kustomization":
    case "HelmRelease":
    case "GitRepository":
    case "OCIRepository":
    case "HelmRepository":
      return field(object, "spec", "suspend") === true ? { health: "idle", summary: "Suspended" } : (readyConditionHealth(object) ?? { health: "unknown" });
    case "APIService": {
      // An aggregated API that is not available breaks discovery for every client of the cluster.
      const available = condition(object, "Available");

      return !available || available.status === "True"
        ? { health: field(object, "spec", "service") ? "ok" : "neutral", summary: field(object, "spec", "service") ? "Available" : "Local" }
        : { health: "error", summary: asString(available.reason) ?? "Unavailable" };
    }
    case "ResourceClaim":
      return isRecord(field(object, "status", "allocation")) ? { health: "ok", summary: "Allocated" } : { health: "warn", summary: "Pending" };
    case "Node": {
      const ready = condition(object, "Ready");

      return ready?.status === "True" ? { health: "ok", summary: "Ready" } : { health: "error", summary: "Not ready" };
    }
    case "ConfigMap":
    case "Secret":
    case "ServiceAccount":
    case "Role":
    case "ClusterRole":
    case "RoleBinding":
    case "ClusterRoleBinding":
    case "NetworkPolicy":
    case "PodDisruptionBudget":
    case "StorageClass":
    case "PriorityClass":
    case "RuntimeClass":
    case "IngressClass":
    case "EndpointSlice":
    case "ValidatingWebhookConfiguration":
    case "MutatingWebhookConfiguration":
    case "DestinationRule":
    case "ServiceEntry":
    case "ResourceClaimTemplate":
    case "DeviceClass":
      return { health: "neutral" };
    default:
      return readyConditionHealth(object) ?? { health: "ok" };
  }
};
