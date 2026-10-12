# Changelog

What changed in each version of this extension, newest first.

## 0.2.0

- Published as `lens-app-graph`. It replaces `@skoncar/lens-app-graph`, which gets no further updates.
- A new icon and banner, and a README with a demo and screenshots of both views.
- Operators' resources stand in the graph as themselves. A custom resource that owns pods or Services is listed too, with its name, health and details, and anchors the app it owns. Examples: a CloudNativePG `Cluster`, a Strimzi `Kafka`.
- Argo CD Applications and Flux Kustomizations and HelmReleases appear as apps of their own, with their sync and health and a line to everything they applied. Flux sources and `valuesFrom` are linked too.
- Admission webhooks and aggregated APIs are linked to the Service that answers them. One whose Service is gone shows as broken, and an APIService that is not available turns red.
- New links:
  - a StatefulSet to all its volume claims, including ones a scale-down left behind;
  - a pod to its headless Service through `subdomain`;
  - an ExternalName Service to the Service it aliases;
  - Gateway API routes attached to a Service (mesh routing), and mirrored traffic;
  - Istio DestinationRules to their Service;
  - pods to the devices they claim (`ResourceClaim`, `ResourceClaimTemplate`, `DeviceClass`);
  - cert-manager's `issuer` annotation, and both issuer annotations on Gateways.
- In the Traffic Graph, mesh traffic to hosts outside the cluster ends at the Istio ServiceEntry that declares them.
- Resources a Flux Kustomization or HelmRelease applied now stay in their own namespace, and filter with it. They used to be grouped into the namespace of the Flux object, usually `flux-system`.

## 0.1.0

- A 3D graph of the apps in a cluster: namespaces, apps and their resources, health and broken references, updating live.
- A Traffic Graph of every path a request takes: internet, ingresses and gateways, routes, Services, the workloads behind them, and the Services they call (inferred from Service DNS names in env, args and ConfigMaps).
- Istio Gateways and the VirtualServices bound to them are ways into the cluster in the Traffic Graph.
- With Istio or Linkerd and Prometheus, the Traffic Graph draws the traffic the mesh measured, coloured by error rate.
- Every resource is a Kubernetes-style token with its kind's icon, in 3D, in labels and in the side panel.
- Apps are recognised from Helm releases, Argo CD, Flux and `app.kubernetes.io/instance`, or from a workload on its own.
- A side panel explains every relationship down to the field it was found in.
- Open them from the navigator (App Graph under each cluster, Traffic Graph inside it), the menu of any resource, the command palette, or the new App Graph section of a resource's details.
- Search, namespace filters, and switches for labels, problems only, and hidden kinds.
- Kinds you cannot list cluster-wide are listed per namespace instead.
