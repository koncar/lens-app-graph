import type { PrometheusSeries } from "@k8slens/prometheus-contracts";

/**
 * What a service mesh saw: requests and bytes between workloads and Services, read from the
 * cluster's Prometheus. Istio and Linkerd both count every request at the sidecar, so where
 * either runs, the traffic graph can draw what actually happens instead of what config says.
 */

export type MeshKind = "istio" | "linkerd";

export const MESH_TITLES: Readonly<Record<MeshKind, string>> = { istio: "Istio", linkerd: "Linkerd" };

/** One observed connection, from a workload to a Service. */
export interface ObservedFlow {
  readonly mesh: MeshKind;
  readonly from: { readonly namespace: string; readonly workload: string };
  readonly to: { readonly namespace: string; readonly service: string };
  /** HTTP and gRPC requests per second. */
  readonly requestsPerSecond: number;
  /** Of those, the ones that failed: 5xx, or what Linkerd classifies as a failure. */
  readonly errorsPerSecond: number;
  /** TCP bytes per second, both ways, for what is not HTTP (databases, queues). */
  readonly bytesPerSecond: number;
}

export type MeshTelemetry =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "no-prometheus" }
  | { readonly status: "no-mesh" }
  | { readonly status: "ready"; readonly meshes: readonly MeshKind[]; readonly flows: readonly ObservedFlow[]; readonly at: number }
  | { readonly status: "failed"; readonly reason: string };

/** The window rates are taken over: long enough to be steady, short enough to be now. */
export const MESH_WINDOW = "5m";

const ISTIO_PAIR = "source_workload, source_workload_namespace, destination_service_name, destination_service_namespace";

/**
 * Both proxies of a call report it (reporter="source" and "destination"), so summing would count
 * it twice. The larger of the two is the call; either side alone still counts when only one end
 * has a sidecar.
 */
const istio = (metric: string, matchers = "") =>
  `max by (${ISTIO_PAIR}) (sum by (reporter, ${ISTIO_PAIR}) (rate(${metric}${matchers}[${MESH_WINDOW}]))) > 0`;

const LINKERD_PAIR = "namespace, deployment, statefulset, daemonset, dst_namespace, dst_service, authority";

const linkerd = (selector: string) => `sum by (${LINKERD_PAIR}) (rate(${selector}[${MESH_WINDOW}])) > 0`;

export type MeshMetric = "requests" | "errors" | "bytes";

export interface MeshQuery {
  readonly mesh: MeshKind;
  readonly metric: MeshMetric;
  readonly query: string;
}

export const MESH_QUERIES: readonly MeshQuery[] = [
  { mesh: "istio", metric: "requests", query: istio("istio_requests_total") },
  { mesh: "istio", metric: "errors", query: istio("istio_requests_total", `{response_code=~"5.."}`) },
  { mesh: "istio", metric: "bytes", query: istio(`{__name__=~"istio_tcp_(sent|received)_bytes_total"}`) },
  { mesh: "linkerd", metric: "requests", query: linkerd(`response_total{direction="outbound"}`) },
  { mesh: "linkerd", metric: "errors", query: linkerd(`response_total{direction="outbound", classification="failure"}`) },
  { mesh: "linkerd", metric: "bytes", query: linkerd(`{__name__=~"tcp_(read|write)_bytes_total", direction="outbound", peer="dst"}`) },
];

/** What a mesh calls "nothing we know": a client outside the mesh, a host outside the cluster. */
const UNKNOWN = new Set(["", "unknown", "PassthroughCluster", "BlackHoleCluster", "InboundPassthroughClusterIpv4", "InboundPassthroughClusterIpv6"]);

const endsOf = (mesh: MeshKind, metric: Record<string, string>) => {
  if (mesh === "istio") {
    return {
      from: { namespace: metric.source_workload_namespace ?? "", workload: metric.source_workload ?? "" },
      to: { namespace: metric.destination_service_namespace ?? "", service: metric.destination_service_name ?? "" },
    };
  }

  // Older proxies only name the authority: "web-svc.emojivoto.svc.cluster.local:80".
  const [service, namespace] = (metric.authority ?? "").split(":")[0]!.split(".");

  return {
    from: { namespace: metric.namespace ?? "", workload: metric.deployment || metric.statefulset || metric.daemonset || "" },
    to: { namespace: metric.dst_namespace || namespace || "", service: metric.dst_service || (namespace ? service! : "") },
  };
};

const latest = (series: PrometheusSeries) => {
  const value = Number(series.values.at(-1)?.[1]);

  return Number.isFinite(value) && value > 0 ? value : 0;
};

/** Every answer, folded into one flow per pair of ends. */
export const parseMeshSeries = (answers: ReadonlyArray<{ readonly query: MeshQuery; readonly series: readonly PrometheusSeries[] }>) => {
  const flows = new Map<string, { -readonly [K in keyof ObservedFlow]: ObservedFlow[K] }>();
  const meshes = new Set<MeshKind>();

  for (const { query, series } of answers) {
    for (const entry of series) {
      const { from, to } = endsOf(query.mesh, entry.metric);
      const value = latest(entry);

      if (UNKNOWN.has(from.workload) || UNKNOWN.has(to.service) || !from.namespace || !to.namespace || value === 0) {
        continue;
      }

      // A Service DNS name outside the cluster's domain is a ServiceEntry host, not a Service.
      if (to.service.includes(".")) {
        continue;
      }

      meshes.add(query.mesh);

      const key = `${query.mesh}|${from.namespace}/${from.workload}>${to.namespace}/${to.service}`;
      const flow = flows.get(key) ?? { mesh: query.mesh, from, to, requestsPerSecond: 0, errorsPerSecond: 0, bytesPerSecond: 0 };

      if (query.metric === "requests") {
        flow.requestsPerSecond += value;
      } else if (query.metric === "errors") {
        flow.errorsPerSecond += value;
      } else {
        flow.bytesPerSecond += value;
      }

      flows.set(key, flow);
    }
  }

  return { meshes: [...meshes].sort(), flows: [...flows.values()] as readonly ObservedFlow[] };
};

/** 1,240 · 12.5 · 0.25 · 0.003: as many digits as say something. */
const compact = (value: number) =>
  value >= 100
    ? Math.round(value).toLocaleString("en-US")
    : value >= 10
      ? String(Math.round(value * 10) / 10)
      : value >= 0.1
        ? String(Math.round(value * 100) / 100)
        : value.toPrecision(1);

const bytes = (value: number) =>
  value >= 1024 * 1024 ? `${compact(value / 1024 / 1024)} MB/s` : value >= 1024 ? `${compact(value / 1024)} KB/s` : `${compact(value)} B/s`;

/** "12 req/s · 3% errors", "4.1 KB/s". */
export const describeFlow = (flow: Pick<ObservedFlow, "requestsPerSecond" | "errorsPerSecond" | "bytesPerSecond">) => {
  const parts: string[] = [];

  if (flow.requestsPerSecond > 0) {
    parts.push(`${compact(flow.requestsPerSecond)} req/s`);

    if (flow.errorsPerSecond > 0) {
      const ratio = flow.errorsPerSecond / flow.requestsPerSecond;

      parts.push(`${ratio >= 0.1 ? Math.round(ratio * 100) : (ratio * 100).toPrecision(1)}% errors`);
    }
  }

  if (flow.bytesPerSecond > 0 && flow.requestsPerSecond === 0) {
    parts.push(bytes(flow.bytesPerSecond));
  }

  return parts.join(" · ");
};
