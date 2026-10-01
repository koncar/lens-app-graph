/**
 * Acceptance tests for the graph engine: one per row of "Defects in the original" in the
 * app-graph handoff, plus the membership rules. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { K } from "./rules";
import { buildSnapshot } from "./snapshot";
import { GraphStore } from "./store";
import { groupKindOf, type KubeObject, objectKey } from "./types";

let uid = 0;

const obj = (
  apiVersion: string,
  kind: string,
  name: string,
  rest: { namespace?: string | null; labels?: Record<string, string>; annotations?: Record<string, string>; owners?: KubeObject[]; [field: string]: unknown } = {},
): KubeObject => {
  const { namespace = "shop", labels, annotations, owners, ...fields } = rest;

  return {
    apiVersion,
    kind,
    metadata: {
      name,
      uid: `uid-${++uid}`,
      resourceVersion: "1",
      ...(namespace === null ? {} : { namespace }),
      ...(labels ? { labels } : {}),
      ...(annotations ? { annotations } : {}),
      ...(owners
        ? {
            ownerReferences: owners.map((owner) => ({
              apiVersion: owner.apiVersion,
              kind: owner.kind,
              name: owner.metadata.name,
              uid: owner.metadata.uid,
              controller: true,
            })),
          }
        : {}),
    },
    ...fields,
  };
};

const pod = (name: string, spec: Record<string, unknown> = {}, rest: Parameters<typeof obj>[3] = {}) =>
  obj("v1", "Pod", name, { spec: { containers: [{ name: "main" }], ...spec }, ...rest });

const storeWith = (...objects: KubeObject[]) => {
  const store = new GraphStore();
  const byKind = new Map<string, { gk: ReturnType<typeof groupKindOf>; objects: KubeObject[] }>();

  for (const object of objects) {
    const gk = groupKindOf(object);
    const key = `${gk.group}/${gk.kind}`;

    byKind.set(key, { gk, objects: [...(byKind.get(key)?.objects ?? []), object] });
  }

  // Every kind the rules name is "listed", so unresolved references read as missing.
  for (const kind of Object.values(K)) {
    store.setKindState(kind, { phase: "ready" });
  }

  for (const { gk, objects: list } of byKind.values()) {
    store.applyList(gk, list);
  }

  return store;
};

const key = (kind: { group: string; kind: string }, name: string, namespace = "shop") => objectKey(kind, namespace, name);

const edgesFrom = (store: GraphStore, from: string) => [...store.outOf(from)];

describe("pod spec references (defect 1)", () => {
  const spec = {
    volumes: [{ name: "creds", secret: { secretName: "db-creds" } }],
    imagePullSecrets: [{ name: "registry" }],
    containers: [
      {
        name: "main",
        envFrom: [{ configMapRef: { name: "settings" } }, { secretRef: { name: "api-keys" } }],
      },
    ],
    serviceAccountName: "web",
  };

  it("links a pod to its secret volume, envFrom config map and secret, and image pull secret", () => {
    const store = storeWith(pod("web-1", spec));
    const targets = edgesFrom(store, key(K.Pod, "web-1"))
      .filter((edge) => edge.type !== "runsAs")
      .map((edge) => edge.to)
      .sort();

    assert.deepEqual(targets, [key(K.ConfigMap, "settings"), key(K.Secret, "api-keys"), key(K.Secret, "db-creds"), key(K.Secret, "registry")].sort());
  });

  it("shows the same references through the template of a deployment scaled to zero", () => {
    const deployment = obj("apps/v1", "Deployment", "web", { spec: { replicas: 0, template: { spec } } });
    const store = storeWith(deployment);
    const targets = edgesFrom(store, key(K.Deployment, "web")).map((edge) => edge.to);

    assert.ok(targets.includes(key(K.Secret, "db-creds")));
    assert.ok(targets.includes(key(K.ConfigMap, "settings")));
    assert.ok(targets.includes(key(K.Secret, "api-keys")));
    assert.ok(targets.includes(key(K.Secret, "registry")));
  });

  it("carries the rule id and the concrete path on every edge (defect 9)", () => {
    const store = storeWith(pod("web-1", spec));
    const edge = edgesFrom(store, key(K.Pod, "web-1")).find((candidate) => candidate.to === key(K.Secret, "api-keys"))!;

    assert.equal(edge.ruleId, "podspec.envfrom.secret");
    assert.equal(edge.path, "spec.containers[0].envFrom[1].secretRef.name");
  });
});

describe("multi-valued references (defects 2, 3, 8)", () => {
  it("links an EndpointSlice to both of its pods", () => {
    const slice = obj("discovery.k8s.io/v1", "EndpointSlice", "web-abc", {
      labels: { "kubernetes.io/service-name": "web" },
      endpoints: [{ targetRef: { kind: "Pod", name: "web-1" } }, { targetRef: { kind: "Pod", name: "web-2" } }],
    });
    const store = storeWith(slice, pod("web-1"), pod("web-2"));
    const pods = edgesFrom(store, key(K.EndpointSlice, "web-abc"))
      .filter((edge) => edge.ruleId === "endpointslice.pods")
      .map((edge) => edge.to)
      .sort();

    assert.deepEqual(pods, [key(K.Pod, "web-1"), key(K.Pod, "web-2")]);
  });

  it("links a RoleBinding to each ServiceAccount subject, skips users, and resolves a ClusterRole", () => {
    const binding = obj("rbac.authorization.k8s.io/v1", "RoleBinding", "readers", {
      subjects: [
        { kind: "ServiceAccount", name: "a", namespace: "shop" },
        { kind: "ServiceAccount", name: "b" },
        { kind: "User", name: "alice", apiGroup: "rbac.authorization.k8s.io" },
      ],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "view" },
    });
    const store = storeWith(binding, obj("rbac.authorization.k8s.io/v1", "ClusterRole", "view", { namespace: null }));
    const edges = edgesFrom(store, key(K.RoleBinding, "readers"));

    assert.deepEqual(
      edges.filter((edge) => edge.type === "bindsSubject").map((edge) => edge.to).sort(),
      [key(K.ServiceAccount, "a"), key(K.ServiceAccount, "b")],
    );

    const snapshot = buildSnapshot(store);
    const grant = snapshot.edges.find((edge) => edge.type === "grants")!;

    assert.equal(grant.to, key(K.ClusterRole, "view", ""));
    assert.equal(grant.state, "resolved");
  });

  it("gives an object with two ownerReferences two ownedBy edges", () => {
    const a = obj("apps/v1", "Deployment", "a");
    const b = obj("apps/v1", "Deployment", "b");
    const shared = obj("v1", "ConfigMap", "both", { owners: [a, b] });
    const store = storeWith(a, b, shared);

    assert.equal(edgesFrom(store, key(K.ConfigMap, "both")).filter((edge) => edge.type === "ownedBy").length, 2);
  });
});

describe("selectors (defects 4, 5)", () => {
  const pods = [
    pod("web-1", {}, { labels: { app: "web", tier: "front" } }),
    pod("web-2", {}, { labels: { app: "web", tier: "back" } }),
    pod("db", {}, { labels: { app: "postgres" } }),
  ];

  const selected = (holder: KubeObject) => {
    const store = storeWith(holder, ...pods);

    return edgesFrom(store, key(groupKindOf(holder), holder.metadata.name))
      .filter((edge) => edge.bySelector)
      .map((edge) => edge.to.split("/").pop())
      .sort();
  };

  it("treats an empty NetworkPolicy podSelector as every pod in the namespace", () => {
    assert.deepEqual(selected(obj("networking.k8s.io/v1", "NetworkPolicy", "deny", { spec: { podSelector: {} } })), ["db", "web-1", "web-2"]);
  });

  it("evaluates In, NotIn, Exists and DoesNotExist", () => {
    const policy = (expressions: unknown[]) =>
      obj("networking.k8s.io/v1", "NetworkPolicy", "p", { spec: { podSelector: { matchExpressions: expressions } } });

    assert.deepEqual(selected(policy([{ key: "tier", operator: "In", values: ["front"] }])), ["web-1"]);
    assert.deepEqual(selected(policy([{ key: "tier", operator: "NotIn", values: ["front"] }])), ["db", "web-2"]);
    assert.deepEqual(selected(policy([{ key: "tier", operator: "Exists" }])), ["web-1", "web-2"]);
    assert.deepEqual(selected(policy([{ key: "tier", operator: "DoesNotExist" }])), ["db"]);
  });

  it("selects nothing for a Service without a selector", () => {
    assert.deepEqual(selected(obj("v1", "Service", "manual", { spec: {} })), []);
  });

  it("does not match a pod by its name against selector values", () => {
    assert.deepEqual(selected(obj("v1", "Service", "db-svc", { spec: { selector: { component: "db" } } })), []);
  });

  it("follows label changes on either end", () => {
    const service = obj("v1", "Service", "web", { spec: { selector: { app: "web" } } });
    const store = storeWith(service, ...pods);
    const serviceKey = key(K.Service, "web");

    assert.equal(edgesFrom(store, serviceKey).length, 2);

    store.upsert({ ...pods[2]!, metadata: { ...pods[2]!.metadata, resourceVersion: "2", labels: { app: "web" } } });
    assert.equal(edgesFrom(store, serviceKey).length, 3);

    store.upsert({ ...service, metadata: { ...service.metadata, resourceVersion: "2" }, spec: { selector: { app: "postgres" } } });
    assert.equal(edgesFrom(store, serviceKey).length, 0);

    store.remove(key(K.Pod, "web-1"));
    assert.ok(![...store.edges()].some((edge) => edge.to === key(K.Pod, "web-1")));
  });
});

describe("identity and cost (defect 6)", () => {
  const deployment = obj("apps/v1", "Deployment", "web", {
    spec: { replicas: 5, selector: { matchLabels: { app: "web" } }, template: { spec: { containers: [{ name: "main" }], serviceAccountName: "web" } } },
  });
  const replicaSet = obj("apps/v1", "ReplicaSet", "web-7f", { owners: [deployment], labels: { app: "web" } });
  const pods = [1, 2, 3, 4, 5].map((n) =>
    pod(`web-7f-${n}`, { serviceAccountName: "web", volumes: [{ name: "c", configMap: { name: "web-config" } }] }, { owners: [replicaSet], labels: { app: "web" } }),
  );
  const service = obj("v1", "Service", "web", { spec: { selector: { app: "web" } } });
  const configMap = obj("v1", "ConfigMap", "web-config");
  const serviceAccount = obj("v1", "ServiceAccount", "web");

  it("gives exactly one node per object", () => {
    const snapshot = buildSnapshot(storeWith(deployment, replicaSet, ...pods, service, configMap, serviceAccount));

    assert.equal(snapshot.nodes.size, 10);
  });

  it("touches only the changed pod's edges on a status update", () => {
    const store = storeWith(deployment, replicaSet, ...pods, service, configMap, serviceAccount);
    const before = new Map([...store.edges()].map((edge) => [edge.id, edge]));
    const changed = pods[0]!;

    store.upsert({ ...changed, metadata: { ...changed.metadata, resourceVersion: "2" }, status: { phase: "Running" } });

    const after = [...store.edges()];

    assert.equal(after.length, before.size);

    for (const edge of after) {
      const touchesChangedPod = edge.from === key(K.Pod, changed.metadata.name) || edge.to === key(K.Pod, changed.metadata.name);

      if (!touchesChangedPod) {
        assert.equal(before.get(edge.id), edge, `edge ${edge.id} was rebuilt`);
      }
    }
  });

  it("puts the whole workload into one app", () => {
    const snapshot = buildSnapshot(storeWith(deployment, replicaSet, ...pods, service, configMap, serviceAccount));

    assert.deepEqual([...snapshot.apps.keys()], ["shop/web"]);
    assert.equal(snapshot.apps.get("shop/web")!.members.length, 10);
  });
});

describe("kinds (defect 7)", () => {
  it("resolves PVC to PV and StorageClass, and ClusterRoleBinding to ClusterRole", () => {
    const store = storeWith(
      obj("v1", "PersistentVolumeClaim", "data", { spec: { volumeName: "pv-1", storageClassName: "fast" } }),
      obj("v1", "PersistentVolume", "pv-1", { namespace: null }),
      obj("storage.k8s.io/v1", "StorageClass", "fast", { namespace: null }),
      obj("rbac.authorization.k8s.io/v1", "ClusterRoleBinding", "admins", {
        namespace: null,
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "admin" },
        subjects: [],
      }),
      obj("rbac.authorization.k8s.io/v1", "ClusterRole", "admin", { namespace: null }),
    );
    const snapshot = buildSnapshot(store);
    const resolved = snapshot.edges.filter((edge) => edge.state === "resolved").map((edge) => `${edge.type}:${edge.to}`).sort();

    assert.deepEqual(resolved, [
      `boundTo:${key(K.PersistentVolume, "pv-1", "")}`,
      `grants:${key(K.ClusterRole, "admin", "")}`,
      `usesClass:${key(K.StorageClass, "fast", "")}`,
    ]);
  });

  it("never applies core Service rules to a Knative Service", () => {
    const store = storeWith(
      obj("serving.knative.dev/v1", "Service", "web", { spec: { selector: { app: "web" } } }),
      pod("web-1", {}, { labels: { app: "web" } }),
    );

    assert.equal([...store.edges()].filter((edge) => edge.type === "selects").length, 0);
  });
});

describe("membership (defects 10, 11, 13)", () => {
  it("keeps the default ServiceAccount and kube-root-ca.crt as hubs", () => {
    const store = storeWith(
      pod("web-1", { volumes: [{ name: "ca", projected: { sources: [{ configMap: { name: "kube-root-ca.crt" } }] } }] }, { labels: { "app.kubernetes.io/instance": "web" } }),
      obj("v1", "ServiceAccount", "default"),
      obj("v1", "ConfigMap", "kube-root-ca.crt"),
    );
    const snapshot = buildSnapshot(store);

    assert.equal(snapshot.nodes.get(key(K.ServiceAccount, "default"))!.role, "hub");
    assert.equal(snapshot.nodes.get(key(K.ConfigMap, "kube-root-ca.crt"))!.role, "hub");
    assert.deepEqual(snapshot.apps.get("shop/web")!.members, [key(K.Pod, "web-1")]);
  });

  it("shows a reference to a missing Secret as a missing node inside the app", () => {
    const snapshot = buildSnapshot(storeWith(pod("web-1", { volumes: [{ name: "s", secret: { secretName: "gone" } }] }, { labels: { "app.kubernetes.io/instance": "web" } })));
    const missing = snapshot.nodes.get(key(K.Secret, "gone"))!;

    assert.equal(missing.state, "missing");
    assert.equal(missing.appId, "shop/web");
    assert.equal(snapshot.nodes.get(key(K.Pod, "web-1"))!.health, "error");
  });

  it("shows a reference into an unlistable kind as unknown", () => {
    const store = storeWith(pod("web-1", { volumes: [{ name: "s", secret: { secretName: "hidden" } }] }));

    store.setKindState(K.Secret, { phase: "unavailable", reason: "Forbidden" });

    assert.equal(buildSnapshot(store).nodes.get(key(K.Secret, "hidden"))!.state, "unknown");
  });

  it("keeps a reference unknown, not missing, in a namespace its kind could not be listed in", () => {
    const store = storeWith(
      pod("web-1", { volumes: [{ name: "s", secret: { secretName: "creds" } }] }),
      pod("api-1", { volumes: [{ name: "s", secret: { secretName: "creds" } }] }, { namespace: "other" }),
    );

    store.setKindState(K.Secret, { phase: "ready", namespaces: new Set(["other"]) });

    const snapshot = buildSnapshot(store);

    assert.equal(snapshot.nodes.get(key(K.Secret, "creds"))!.state, "unknown");
    assert.equal(snapshot.nodes.get(key(K.Secret, "creds", "other"))!.state, "missing");
  });

  it("groups two Deployments of one Helm release into one app, with their pods", () => {
    const helm = { "meta.helm.sh/release-name": "shop", "meta.helm.sh/release-namespace": "shop" };
    const api = obj("apps/v1", "Deployment", "api", { annotations: helm });
    const ui = obj("apps/v1", "Deployment", "ui", { annotations: helm });
    const apiReplicas = obj("apps/v1", "ReplicaSet", "api-1", { owners: [api] });
    const apiPod = pod("api-1-x", {}, { owners: [apiReplicas] });
    const snapshot = buildSnapshot(storeWith(api, ui, apiReplicas, apiPod));

    assert.deepEqual([...snapshot.apps.keys()], ["shop/shop"]);
    assert.equal(snapshot.apps.get("shop/shop")!.members.length, 4);
    assert.equal(snapshot.apps.get("shop/shop")!.source, "Helm release");
  });

  it("makes a ConfigMap mounted by two apps shared, not a member of either", () => {
    const snapshot = buildSnapshot(
      storeWith(
        pod("a", { volumes: [{ name: "c", configMap: { name: "common" } }] }, { labels: { "app.kubernetes.io/instance": "a" } }),
        pod("b", { volumes: [{ name: "c", configMap: { name: "common" } }] }, { labels: { "app.kubernetes.io/instance": "b" } }),
        obj("v1", "ConfigMap", "common"),
      ),
    );
    const common = snapshot.nodes.get(key(K.ConfigMap, "common"))!;

    assert.equal(common.role, "shared");
    assert.deepEqual(common.claimedBy, ["shop/a", "shop/b"]);
  });

  it("pulls a Service and its Ingress into the app of the pods it selects", () => {
    const snapshot = buildSnapshot(
      storeWith(
        pod("web-1", {}, { labels: { app: "web", "app.kubernetes.io/instance": "web" } }),
        obj("v1", "Service", "web", { spec: { selector: { app: "web" } } }),
        obj("networking.k8s.io/v1", "Ingress", "web", {
          spec: { rules: [{ http: { paths: [{ backend: { service: { name: "web" } } }] } }] },
        }),
      ),
    );

    assert.equal(snapshot.nodes.get(key(K.Service, "web"))!.appId, "shop/web");
    assert.equal(snapshot.nodes.get(key(K.Ingress, "web"))!.appId, "shop/web");
  });

  it("drops secret values at ingestion", () => {
    const store = storeWith(obj("v1", "Secret", "s", { data: { password: "aHVudGVyMg==" }, stringData: { token: "x" } }));
    const stored = store.get(key(K.Secret, "s"))!.object as Record<string, unknown>;

    assert.equal(stored.data, undefined);
    assert.equal(stored.stringData, undefined);
  });
});

describe("layout", () => {
  const helm = { "meta.helm.sh/release-name": "shop", "meta.helm.sh/release-namespace": "shop" };
  const deployment = obj("apps/v1", "Deployment", "web", { annotations: helm, spec: { replicas: 3, template: { spec: { containers: [{ name: "m" }] } } } });
  const replicaSet = obj("apps/v1", "ReplicaSet", "web-1", { owners: [deployment], spec: { replicas: 3 } });
  const pods = [1, 2, 3].map((n) => pod(`web-1-${n}`, { volumes: [{ name: "c", configMap: { name: "cfg" } }] }, { owners: [replicaSet], labels: { app: "web" } }));
  const objects = [
    deployment,
    replicaSet,
    ...pods,
    obj("v1", "Service", "web", { annotations: helm, spec: { selector: { app: "web" } } }),
    obj("v1", "ConfigMap", "cfg", { annotations: helm }),
    obj("v1", "ConfigMap", "loose", { namespace: "other" }),
  ];

  it("places every visible node at a finite position, the same way every time", async () => {
    const { layoutGraph, DEFAULT_LAYOUT_OPTIONS } = await import("./layout");
    const first = layoutGraph(buildSnapshot(storeWith(...objects)), DEFAULT_LAYOUT_OPTIONS);
    const second = layoutGraph(buildSnapshot(storeWith(...objects)), DEFAULT_LAYOUT_OPTIONS);

    assert.ok(first.nodes.size > 0);

    for (const node of first.nodes.values()) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z), node.id);

      const again = second.nodes.get(node.id)!;

      assert.deepEqual([again.x, again.y, again.z], [node.x, node.y, node.z]);
    }

    // The ReplicaSet collapses into its Deployment, and unattached objects stay hidden by default.
    assert.equal(first.nodes.has(key(K.ReplicaSet, "web-1")), false);
    assert.equal(first.nodes.has(key(K.ConfigMap, "loose", "other")), false);
    assert.ok(first.edges.some((edge) => edge.from === key(K.Pod, "web-1-1") && edge.to === key(K.Deployment, "web")));
  });

  it("lays tiers out left to right: service, workload, pods, config", async () => {
    const { layoutGraph, DEFAULT_LAYOUT_OPTIONS } = await import("./layout");
    const layout = layoutGraph(buildSnapshot(storeWith(...objects)), DEFAULT_LAYOUT_OPTIONS);
    const x = (id: string) => layout.nodes.get(id)!.x;

    assert.ok(x(key(K.Service, "web")) < x(key(K.Deployment, "web")));
    assert.ok(x(key(K.Deployment, "web")) < x(key(K.Pod, "web-1-1")));
    assert.ok(x(key(K.Pod, "web-1-1")) < x(key(K.ConfigMap, "cfg")));
  });
});

describe("layout stability", () => {
  const app = (namespace: string, name: string, pods: number) => {
    const deployment = obj("apps/v1", "Deployment", name, { namespace, labels: { "app.kubernetes.io/instance": name }, spec: { replicas: pods } });
    const replicaSet = obj("apps/v1", "ReplicaSet", `${name}-1`, { namespace, owners: [deployment], labels: { "app.kubernetes.io/instance": name } });

    return [
      deployment,
      replicaSet,
      ...Array.from({ length: pods }, (_, i) => pod(`${name}-1-${i}`, {}, { namespace, owners: [replicaSet], labels: { "app.kubernetes.io/instance": name } })),
    ];
  };

  it("does not move anything outside an app when a pod is added to it", async () => {
    const { layoutGraph, DEFAULT_LAYOUT_OPTIONS } = await import("./layout");
    const base = [...app("a", "web", 4), ...app("a", "api", 2), ...app("b", "db", 1), ...app("c", "jobs", 1)];
    const before = layoutGraph(buildSnapshot(storeWith(...base)), DEFAULT_LAYOUT_OPTIONS);
    const extra = pod("web-1-4", {}, { namespace: "a", owners: [base[1]!], labels: { "app.kubernetes.io/instance": "web" } });
    const after = layoutGraph(buildSnapshot(storeWith(...base, extra)), DEFAULT_LAYOUT_OPTIONS);
    const moved = [...before.nodes.values()].filter((node) => {
      const now = after.nodes.get(node.id)!;

      return node.appId !== "a/web" && (now.x !== node.x || now.z !== node.z);
    });

    assert.deepEqual(moved.map((node) => node.id), []);
  });
});

describe("inferred traffic (calls)", () => {
  const callsFrom = (store: GraphStore, from: string) =>
    buildSnapshot(store)
      .edges.filter((edge) => edge.type === "calls" && edge.from === from)
      .map((edge) => edge.to)
      .sort();

  it("links a workload to the Services its env names, in any of their DNS forms", () => {
    const deployment = obj("apps/v1", "Deployment", "web", {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "main",
                env: [
                  { name: "API_URL", value: "http://api:8080/v1" },
                  { name: "CACHE", value: "redis.cache.svc.cluster.local:6379" },
                  { name: "DB_HOST", value: "postgres" },
                  { name: "GREETING", value: "postgres" },
                  { name: "EXTERNAL", value: "https://api.stripe.com" },
                ],
              },
            ],
          },
        },
      },
    });
    const store = storeWith(
      deployment,
      obj("v1", "Service", "api", { spec: {} }),
      obj("v1", "Service", "redis", { namespace: "cache", spec: {} }),
      obj("v1", "Service", "postgres", { spec: {} }),
    );

    assert.deepEqual(callsFrom(store, key(K.Deployment, "web")), [key(K.Service, "redis", "cache"), key(K.Service, "api"), key(K.Service, "postgres")].sort());
  });

  it("finds Services named in a ConfigMap, and never shows unknown hosts as missing", () => {
    const configMap = obj("v1", "ConfigMap", "settings", { data: { "app.yaml": "upstream: http://orders:9000\nmetrics: http://not-a-service:9090" } });
    const store = storeWith(configMap, obj("v1", "Service", "orders", { spec: {} }));
    const snapshot = buildSnapshot(store);

    assert.deepEqual(callsFrom(store, key(K.ConfigMap, "settings")), [key(K.Service, "orders")]);
    assert.equal(snapshot.nodes.has(key(K.Service, "not-a-service")), false);
    assert.equal((store.get(key(K.ConfigMap, "settings"))!.object as Record<string, unknown>).data, undefined);
  });
});

describe("traffic", () => {
  it("follows a request from the internet to the services a workload calls", async () => {
    const { layoutTraffic, INTERNET_ID } = await import("./traffic");
    const web = obj("apps/v1", "Deployment", "web", {
      spec: { template: { spec: { containers: [{ name: "main", env: [{ name: "ORDERS_URL", value: "http://orders:8080" }] }] } } },
    });
    const webPod = pod("web-1", { containers: [{ name: "main" }] }, { owners: [web], labels: { app: "web" } });
    const orders = obj("apps/v1", "Deployment", "orders");
    const ordersPod = pod("orders-1", {}, { owners: [orders], labels: { app: "orders" } });
    const store = storeWith(
      obj("networking.k8s.io/v1", "Ingress", "web", { spec: { rules: [{ http: { paths: [{ backend: { service: { name: "web" } } }] } }] } }),
      obj("v1", "Service", "web", { spec: { selector: { app: "web" } } }),
      obj("v1", "Service", "orders", { spec: { selector: { app: "orders" } } }),
      web,
      webPod,
      orders,
      ordersPod,
    );
    const layout = layoutTraffic(buildSnapshot(store), {});
    const hops = layout.edges.map((edge) => `${edge.from.split("/").pop()}>${edge.to.split("/").pop()}`).sort();

    assert.deepEqual(hops, ["internet>web", "orders>orders", "web>orders", "web>web", "web>web"].sort());

    const x = (id: string) => layout.nodes.get(id)!.x;

    assert.ok(x(INTERNET_ID) < x(key(K.Ingress, "web")));
    assert.ok(x(key(K.Ingress, "web")) < x(key(K.Service, "web")));
    assert.ok(x(key(K.Service, "web")) < x(key(K.Deployment, "web")));
    assert.ok(x(key(K.Deployment, "web")) < x(key(K.Service, "orders")));
    assert.ok(x(key(K.Service, "orders")) < x(key(K.Deployment, "orders")));
  });
});

describe("istio", () => {
  const istioShop = () => {
    const gatewayWorkload = obj("apps/v1", "Deployment", "istio-ingressgateway", {
      namespace: "istio-system",
      spec: { template: { metadata: { labels: { istio: "ingressgateway" } }, spec: { containers: [{ name: "istio-proxy" }] } } },
    });
    const web = obj("apps/v1", "Deployment", "web");
    const orders = obj("apps/v1", "Deployment", "orders");

    return storeWith(
      gatewayWorkload,
      obj("networking.istio.io/v1", "Gateway", "public", { spec: { selector: { istio: "ingressgateway" }, servers: [] } }),
      obj("networking.istio.io/v1", "VirtualService", "web", {
        spec: { gateways: ["shop/public"], hosts: ["shop.example.com"], http: [{ route: [{ destination: { host: "web" } }] }] },
      }),
      // Sidecar-only routing: a rule between services, not a way in.
      obj("networking.istio.io/v1", "VirtualService", "orders-canary", {
        spec: { hosts: ["orders"], http: [{ route: [{ destination: { host: "orders" } }] }] },
      }),
      obj("v1", "Service", "web", { spec: { selector: { app: "web" } } }),
      obj("v1", "Service", "orders", { spec: { selector: { app: "orders" } } }),
      web,
      pod("web-1", {}, { owners: [web], labels: { app: "web" } }),
      orders,
      pod("orders-1", {}, { owners: [orders], labels: { app: "orders" } }),
    );
  };

  const hopsOf = (edges: ReadonlyArray<{ from: string; to: string }>) =>
    edges.map((edge) => `${edge.from.split("/").slice(1, 2)}:${edge.from.split("/").pop()}>${edge.to.split("/").pop()}`).sort();

  it("enters through an Istio Gateway and the VirtualServices bound to it", async () => {
    const { buildTraffic } = await import("./traffic");
    const hops = hopsOf(buildTraffic(buildSnapshot(istioShop())));

    assert.deepEqual(hops, ["Internet:internet>public", "Gateway:public>web", "VirtualService:web>web", "Service:web>web", "Service:orders>orders"].sort());
  });

  it("reads mesh requests from either reporter, and drops what is outside the cluster", async () => {
    const { MESH_QUERIES, parseMeshSeries } = await import("./mesh");
    const query = (mesh: string, metric: string) => MESH_QUERIES.find((entry) => entry.mesh === mesh && entry.metric === metric)!;
    const istio = (from: string, to: string, value: string, toNamespace = "shop") => ({
      metric: { source_workload: from, source_workload_namespace: "shop", destination_service_name: to, destination_service_namespace: toNamespace },
      values: [[1, "0"], [2, value]] as Array<[number, string]>,
    });
    const { meshes, flows } = parseMeshSeries([
      { query: query("istio", "requests"), series: [istio("web", "orders", "12.5"), istio("unknown", "orders", "3"), istio("web", "api.stripe.com", "1", "shop")] },
      { query: query("istio", "errors"), series: [istio("web", "orders", "0.5")] },
      {
        query: query("linkerd", "requests"),
        series: [{ metric: { namespace: "shop", deployment: "web", authority: "search.catalog.svc.cluster.local:80" }, values: [[2, "4"]] as Array<[number, string]> }],
      },
    ]);

    assert.deepEqual(meshes, ["istio", "linkerd"]);
    assert.deepEqual(
      flows.map((flow) => [flow.mesh, `${flow.from.workload}>${flow.to.namespace}/${flow.to.service}`, flow.requestsPerSecond, flow.errorsPerSecond]),
      [
        ["istio", "web>shop/orders", 12.5, 0.5],
        ["linkerd", "web>catalog/search", 4, 0],
      ],
    );
  });

  it("draws measured calls, and lays an ingress gateway's traffic on its routes", async () => {
    const { buildTraffic, observedColor } = await import("./traffic");
    const { PALETTE } = await import("./presentation");
    const flow = (from: string, fromNamespace: string, to: string, requestsPerSecond: number, errorsPerSecond = 0) => ({
      mesh: "istio" as const,
      from: { namespace: fromNamespace, workload: from },
      to: { namespace: "shop", service: to },
      requestsPerSecond,
      errorsPerSecond,
      bytesPerSecond: 0,
    });
    const edges = buildTraffic(buildSnapshot(istioShop()), [flow("web", "shop", "orders", 20, 2), flow("istio-ingressgateway", "istio-system", "web", 50)]);
    const call = edges.find((edge) => edge.from === key(K.Deployment, "web") && edge.to === key(K.Service, "orders"))!;
    const route = edges.find((edge) => edge.from === key(K.VirtualService, "web") && edge.to === key(K.Service, "web"))!;

    assert.equal(call.type, "calls");
    assert.equal(call.color, PALETTE.red);
    assert.match(call.reason, /Istio saw 20 req\/s · 10% errors/);
    assert.equal(route.observed?.requestsPerSecond, 50);
    assert.equal(route.color, observedColor({ requestsPerSecond: 50, errorsPerSecond: 0, bytesPerSecond: 0 }));
    // The gateway's own workload does not turn up as a caller.
    assert.equal(edges.some((edge) => edge.from.endsWith("/istio-ingressgateway")), false);
  });
});

describe("traffic namespaces", () => {
  it("keeps a shared gateway in view when the namespaces behind it are chosen", async () => {
    const { layoutTraffic, INTERNET_ID } = await import("./traffic");
    const store = storeWith(
      obj("networking.istio.io/v1", "Gateway", "public", { namespace: "istio-system", spec: { selector: { istio: "ingressgateway" } } }),
      obj("networking.istio.io/v1", "VirtualService", "web", {
        spec: { gateways: ["istio-system/public"], http: [{ route: [{ destination: { host: "web" } }] }] },
      }),
      obj("v1", "Service", "web", { spec: {} }),
    );
    const layout = layoutTraffic(buildSnapshot(store), { namespaces: new Set(["shop"]) });

    assert.deepEqual([...layout.nodes.keys()].sort(), [INTERNET_ID, key(K.IstioGateway, "public", "istio-system"), key(K.VirtualService, "web"), key(K.Service, "web")].sort());
  });
});

describe("traffic lanes", () => {
  it("wraps a busy namespace into strips, keeping each chain of hops on one row", async () => {
    const { layoutTraffic } = await import("./traffic");
    const objects = Array.from({ length: 40 }, (_, i) => [
      obj("networking.istio.io/v1", "Gateway", "public", { spec: { selector: { istio: "ingressgateway" } } }),
      obj("networking.istio.io/v1", "VirtualService", `vs-${i}`, { spec: { gateways: ["public"], http: [{ route: [{ destination: { host: `svc-${i}` } }] }] } }),
      obj("v1", "Service", `svc-${i}`, { spec: {} }),
    ]).flat();
    const layout = layoutTraffic(buildSnapshot(storeWith(...objects)), {});
    const at = (id: string) => layout.nodes.get(id)!;
    const lane = layout.districts.get("shop")!;

    assert.ok(lane.width > 2 * lane.depth, `a block, not a strip: ${lane.width.toFixed(1)} × ${lane.depth.toFixed(1)}`);

    for (let i = 0; i < 40; i++) {
      const route = at(key(K.VirtualService, `vs-${i}`));
      const service = at(key(K.Service, `svc-${i}`));

      assert.equal(route.z, service.z);
      assert.ok(route.x < service.x);
    }
  });
});
